"""Verified items that contradict each other (feature 23, docs/phase4/01).

When an item becomes verified or corrected it is compared, by the check in code (`conflicts.py`), with the
other verified items that share a topic with it. A conflict is stored once per pair and opens a review task
("item_conflict") on each of the two items. It goes away by itself when it no longer holds: one of the items is
corrected so that the values agree, or leaves the verified state (reopened, rejected, stale, withdrawn, erased).
Ending is done in ONE place for every status change (`items._move`) plus the places where an item's text is erased.

Limits: only items linked to a common topic are compared, at most COMPARED_WITH of them (the most recently
created), and only what the check in code can read - see `conflicts.py`. The whole comparison is ONE check with one
work budget: every text is read once, and the item is compared with each of the others, not they with each other.
When a limit was reached (more items on the topic than COMPARED_WITH, or the check stopped early), "no conflict
found" means less; that is written to the audit log (reason ITEM_CONFLICT_CHECK_PARTIAL) so it can be seen later.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import psycopg

from app.knowledge.conflicts import check
from app.platform import write_audit

COMPARED_WITH = 25
TASK_DAYS = 5

_RESOLVE_CLEARED = """
    UPDATE review_tasks t SET status = 'resolved', resolved_at = now(), resolution = 'conflict_cleared', assigned_to_card_id = NULL,
           first_response_at = COALESCE(first_response_at, now())
     WHERE t.tenant_id = %s AND t.kind = 'item_conflict' AND t.status IN ('open', 'assigned')
       AND NOT EXISTS (SELECT 1 FROM knowledge_item_conflicts c
                        WHERE c.tenant_id = t.tenant_id AND (c.item_id = t.subject_id OR c.other_item_id = t.subject_id))"""


def _open_tasks(cur: psycopg.Cursor[Any], tenant_id: str, item_ids: list[str]) -> None:
    if not item_ids:
        return
    cur.execute(
        """INSERT INTO review_tasks (tenant_id, kind, subject_type, subject_id, department_id, sensitivity, owner_person_id, priority, due_at)
           SELECT i.tenant_id, 'item_conflict', 'knowledge_item', i.id, i.department_id, i.sensitivity, i.owner_person_id, i.usage_count + 1,
                  now() + make_interval(days => %s)
             FROM knowledge_items i WHERE i.tenant_id = %s AND i.id = ANY(%s::uuid[])
           ON CONFLICT DO NOTHING""", (TASK_DAYS, tenant_id, item_ids))


def clear_many(cur: psycopg.Cursor[Any], tenant_id: str, item_ids: Sequence[str]) -> None:
    """These items are no longer verified statements (or their text is gone): they cannot be in conflict with anything.
    The stored words of both sides go, and a partner left without any conflict loses its task."""
    if not item_ids:
        return
    ids = [str(i) for i in item_ids]
    cur.execute("DELETE FROM knowledge_item_conflicts WHERE tenant_id = %s AND (item_id = ANY(%s::uuid[]) OR other_item_id = ANY(%s::uuid[]))",
                (tenant_id, ids, ids))
    cur.execute(_RESOLVE_CLEARED, (tenant_id,))


def clear(cur: psycopg.Cursor[Any], tenant_id: str, item_id: str) -> None:
    clear_many(cur, tenant_id, [item_id])


def sync(cur: psycopg.Cursor[Any], tenant_id: str, item_id: str) -> int:
    """Compare a verified item with the verified items sharing a topic; store what disagrees; keep the tasks in step.
    Returns the number of items it now conflicts with."""
    cur.execute(
        """SELECT v.body FROM knowledge_items i JOIN knowledge_versions v ON v.tenant_id = i.tenant_id AND v.id = i.current_version_id
            WHERE i.tenant_id = %s AND i.id = %s AND i.status IN ('verified', 'corrected')""", (tenant_id, item_id))
    row = cur.fetchone()
    cur.execute("DELETE FROM knowledge_item_conflicts WHERE tenant_id = %s AND (item_id = %s OR other_item_id = %s)", (tenant_id, item_id, item_id))
    found: list[str] = []
    if row is not None and row["body"]:
        cur.execute(
            """SELECT o.id::text AS id, v.body
                 FROM knowledge_items o JOIN knowledge_versions v ON v.tenant_id = o.tenant_id AND v.id = o.current_version_id
                WHERE o.tenant_id = %s AND o.id <> %s AND o.status IN ('verified', 'corrected')
                  AND EXISTS (SELECT 1 FROM knowledge_item_topics a JOIN knowledge_item_topics b
                                ON b.tenant_id = a.tenant_id AND b.topic_id = a.topic_id
                               WHERE a.tenant_id = o.tenant_id AND a.item_id = %s AND b.item_id = o.id)
                ORDER BY o.id DESC LIMIT %s""", (tenant_id, item_id, item_id, COMPARED_WITH + 1))
        others = cur.fetchall()
        more_items = len(others) > COMPARED_WITH
        others = others[:COMPARED_WITH]
        texts = {item_id: row["body"]} | {o["id"]: o["body"] or "" for o in others}
        report = check(texts, focus=item_id)                 # every text read once; one work budget for all of it
        first_with: dict[str, Any] = {}
        for c in report.conflicts:
            other_id = c.b.source if c.a.source == item_id else c.a.source
            first_with.setdefault(other_id, c)
        for other_id, first in first_with.items():
            mine, theirs = (first.a.raw, first.b.raw) if first.a.source == item_id else (first.b.raw, first.a.raw)
            low, high = sorted((item_id, other_id))
            cur.execute(
                """INSERT INTO knowledge_item_conflicts (tenant_id, item_id, other_item_id, measure, item_value, other_value)
                   VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING""",
                (tenant_id, low, high, first.measure, (mine if low == item_id else theirs)[:200], (theirs if low == item_id else mine)[:200]))
            found.append(other_id)
        if more_items or report.truncated:
            write_audit(cur, tenant_id=tenant_id, card_id=None, action="knowledge:conflict_check", reason_code="ITEM_CONFLICT_CHECK_PARTIAL",
                        resource_type="knowledge_item", resource_id=item_id, details={"item_id": item_id, "count": len(others)})
    _open_tasks(cur, tenant_id, [item_id, *found] if found else [])
    cur.execute(_RESOLVE_CLEARED, (tenant_id,))
    return len(found)


RESTRICTED = {"restricted": True, "measure": None, "this": None, "other": None, "detected_at": None}


def of_item(cur: psycopg.Cursor[Any], tenant_id: str, item_id: str, title: str, where: str, params: list[Any]) -> list[dict[str, Any]]:
    """What this item disagrees with, for a reader who may read THIS item.

    The other item, the measure and both values are shown only if the reader may also read the other item (`where`
    is the reader's knowledge filter, written for the alias `i`). Otherwise the reader gets ONE entry saying that a
    conflict with a restricted item exists - the same entry whatever that item says and however many there are, so
    nothing about its content can be read from the answer. (That a conflict exists at all is shown on purpose: the
    reader must know not to rely on this item. See docs/phase4/01 for what that still gives away.)"""
    cur.execute(
        f"""SELECT c.measure, c.detected_at,
                   CASE WHEN c.item_id = %s THEN c.item_value ELSE c.other_value END AS this_value,
                   CASE WHEN c.item_id = %s THEN c.other_value ELSE c.item_value END AS other_value,
                   i.id::text AS other_item_id, i.title AS other_title
              FROM knowledge_item_conflicts c
              LEFT JOIN knowledge_items i ON i.tenant_id = c.tenant_id AND i.id = CASE WHEN c.item_id = %s THEN c.other_item_id ELSE c.item_id END
                   AND i.status <> 'withdrawn' AND {where}
             WHERE c.tenant_id = %s AND (c.item_id = %s OR c.other_item_id = %s)
             ORDER BY c.detected_at, c.item_id, c.other_item_id""",
        [item_id, item_id, item_id, *params, tenant_id, item_id, item_id])
    out: list[dict[str, Any]] = []
    hidden = False
    for r in cur.fetchall():
        if r["other_item_id"] is None:
            hidden = True
            continue
        out.append({"restricted": False, "measure": r["measure"],
                    "this": {"kind": "item", "id": item_id, "title": title, "value": r["this_value"]},
                    "other": {"kind": "item", "id": r["other_item_id"], "title": r["other_title"], "value": r["other_value"]},
                    "detected_at": r["detected_at"].isoformat()})
    if hidden:
        out.append(dict(RESTRICTED))
    return out
