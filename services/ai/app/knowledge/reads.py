"""Reading knowledge content for the API (which may read labels and status, never the text).
Every query goes through the access filter in the service token, on top of row-level security.
"""

from __future__ import annotations

from typing import Any

from app.capture import condition, topic_condition
from app.knowledge import item_conflicts
from app.knowledge.items import ItemRefused, item_topics
from app.platform import Database, ServiceContext, one, write_audit

PAGE = 50


def _iso(row: dict[str, Any], *keys: str) -> dict[str, Any]:
    for k in keys:
        if row.get(k) is not None:
            row[k] = row[k].isoformat()
    return row


def list_items(db: Database, ctx: ServiceContext, *, status: str | None, owner_me: bool, limit: int, after: str | None) -> dict[str, Any]:
    where, params = condition(ctx.filter, "knowledge_items", ctx.tenant_id)
    extra, extra_params = "", list[Any]()
    if status is not None:
        extra += " AND i.status = %s"
        extra_params.append(status)
    if owner_me:
        extra += " AND i.owner_person_id = %s"
        extra_params.append(ctx.person_id)
    if after is not None:
        extra += " AND i.id > %s"
        extra_params.append(after)
    limit = max(1, min(limit, PAGE))
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute(
            f"""SELECT i.id::text AS id, i.title, i.status, i.origin, i.ai_extracted, i.department_id::text AS department_id, i.sensitivity,
                       i.owner_person_id::text AS owner_person_id, i.usage_count, i.verified_at, i.stale_after, i.updated_at
                  FROM knowledge_items i
                 WHERE i.tenant_id = %s AND i.status <> 'withdrawn' AND {where}{extra}
                 ORDER BY i.id LIMIT %s""",
            [ctx.tenant_id, *params, *extra_params, limit + 1])
        rows = [_iso(dict(r), "verified_at", "stale_after", "updated_at") for r in cur.fetchall()]
    more = len(rows) > limit
    rows = rows[:limit]
    return {"items": rows, "next_cursor": rows[-1]["id"] if more and rows else None}


def get_item(db: Database, ctx: ServiceContext, item_id: str) -> dict[str, Any]:
    where, params = condition(ctx.filter, "knowledge_items", ctx.tenant_id)
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute(
            f"""SELECT i.id::text AS id, i.title, i.status, i.origin, i.ai_extracted, i.department_id::text AS department_id, i.sensitivity,
                       i.owner_person_id::text AS owner_person_id, i.usage_count, i.verified_at, i.stale_after, i.self_verified,
                       i.current_version_id::text AS current_version_id, i.updated_at
                  FROM knowledge_items i WHERE i.tenant_id = %s AND i.id = %s AND i.status <> 'withdrawn' AND {where}""",
            [ctx.tenant_id, item_id, *params])
        item = cur.fetchone()
        if item is None:
            raise ItemRefused("not_found", 404)
        item = _iso(dict(item), "verified_at", "stale_after", "updated_at")
        cur.execute("""SELECT id::text AS id, version_no, body, change_kind, author_person_id::text AS author_person_id, erased_at, created_at
                         FROM knowledge_versions WHERE tenant_id = %s AND item_id = %s ORDER BY version_no""", (ctx.tenant_id, item_id))
        versions = [_iso(dict(v), "erased_at", "created_at") for v in cur.fetchall()]
        swhere, sparams = condition(ctx.filter, "sources", ctx.tenant_id)
        cur.execute(
            f"""SELECT DISTINCT s.id::text AS source_id, s.title, c.page_from, c.page_to
                  FROM citations ci
                  JOIN chunks c ON c.tenant_id = ci.tenant_id AND c.id = ci.chunk_id
                  JOIN sources s ON s.tenant_id = c.tenant_id AND s.id = c.source_id
                 WHERE ci.tenant_id = %s AND ci.subject_type = 'knowledge_version' AND ci.subject_id = %s AND s.status = 'ready' AND {swhere}""",
            [ctx.tenant_id, item["current_version_id"], *sparams])
        provenance = [dict(r) for r in cur.fetchall()]
        # only topics this reader may READ: the token's topic filter (permission topic:read), not the knowledge filter
        twhere, tparams = topic_condition(ctx.topic_filter, ctx.tenant_id)
        topics = item_topics(cur, ctx.tenant_id, item_id, twhere, tparams)
        conflicts = item_conflicts.of_item(cur, ctx.tenant_id, item_id, item["title"], where, params)
    current = next((v for v in versions if v["id"] == item["current_version_id"]), None)
    item["body"] = current["body"] if current else ""
    keep = ("version_no", "change_kind", "author_person_id", "created_at", "erased_at")
    item["versions"] = [{k: v[k] for k in keep} | {"current": v["id"] == item["current_version_id"]} for v in versions]
    item["provenance"] = provenance
    item["topics"] = topics
    item["conflicts"] = conflicts
    del item["current_version_id"]
    return item


def list_quiz_items(db: Database, ctx: ServiceContext, *, status: str | None, limit: int, after: str | None) -> dict[str, Any]:
    where, params = condition(ctx.filter, "quiz_items", ctx.tenant_id)
    extra, extra_params = "", []
    if status is not None:
        extra += " AND q.status = %s"
        extra_params.append(status)
    if after is not None:
        extra += " AND q.id > %s"
        extra_params.append(after)
    limit = max(1, min(limit, PAGE))
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute(
            f"""SELECT q.id::text AS id, q.topic_id::text AS topic_id, q.knowledge_item_id::text AS knowledge_item_id, q.kind, q.stem, q.options,
                       q.correct_option, q.rubric, q.status, q.sensitivity, q.approved_at, q.created_at
                  FROM quiz_items q WHERE q.tenant_id = %s AND q.erased_at IS NULL AND {where}{extra} ORDER BY q.id LIMIT %s""",
            [ctx.tenant_id, *params, *extra_params, limit + 1])
        rows = [_iso(dict(r), "approved_at", "created_at") for r in cur.fetchall()]
    more = len(rows) > limit
    rows = rows[:limit]
    return {"items": rows, "next_cursor": rows[-1]["id"] if more and rows else None}


def get_attempt(db: Database, ctx: ServiceContext, attempt_id: str) -> dict[str, Any]:
    """The learner sees their questions (in their shown order) and, after grading, their scores. The correct
    options are shown only if the company allows it and the attempt is graded."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute("""SELECT id::text AS id, learner_person_id::text AS learner_person_id, job_role, status, started_at, expires_at,
                              submitted_at, graded_at, bank_size FROM quiz_attempts WHERE tenant_id = %s AND id = %s""", (ctx.tenant_id, attempt_id))
        a = cur.fetchone()
        if a is None:
            raise ItemRefused("not_found", 404)
        a = _iso(dict(a), "started_at", "expires_at", "submitted_at", "graded_at")
        cur.execute("SELECT quiz_show_answers_after_grading AS show FROM knowledge_settings WHERE tenant_id = %s", (ctx.tenant_id,))
        row = cur.fetchone()
        show = bool(row["show"]) if row else False
        cur.execute(
            """SELECT qa.id::text AS answer_id, qa.position, q.kind, q.stem, q.options, q.correct_option, qa.option_order, qa.chosen_option,
                      qa.answer_text, qa.final_score, qa.decided_by
                 FROM quiz_answers qa JOIN quiz_items q ON q.tenant_id = qa.tenant_id AND q.id = qa.quiz_item_id
                WHERE qa.tenant_id = %s AND qa.attempt_id = %s ORDER BY qa.position""", (ctx.tenant_id, attempt_id))
        questions = []
        for r in cur.fetchall():
            order = r["option_order"]
            shown = [r["options"][i] for i in order] if order and r["options"] else None
            q: dict[str, Any] = {"answer_id": r["answer_id"], "position": r["position"], "kind": r["kind"], "stem": r["stem"],
                                 "options": shown, "chosen_option": r["chosen_option"], "answer_text": r["answer_text"],
                                 "final_score": r["final_score"] if a["status"] == "graded" else None, "decided_by": r["decided_by"]}
            if show and a["status"] == "graded" and order and r["correct_option"] is not None:
                q["correct_option"] = order.index(r["correct_option"])
            questions.append(q)
    a["questions"] = questions
    return a


def list_expert_questions(db: Database, ctx: ServiceContext, *, box: str, limit: int, after: str | None = None) -> dict[str, Any]:
    """box: 'asked' (by me) or 'addressed' (to me) or 'all' (filtered: Owners). Newest first; ids are time-ordered
    (uuidv7), so the id of the last row is the cursor for the next page."""
    where, params = condition(ctx.filter, "expert_questions", ctx.tenant_id)
    extra, extra_params = "", list[Any]()
    if box == "asked":
        extra, extra_params = " AND eq.asked_by_card_id = %s", [ctx.card_id]
    elif box == "addressed":
        extra, extra_params = " AND eq.expert_person_id = %s", [ctx.person_id]
    if after is not None:
        extra += " AND eq.id < %s"
        extra_params.append(after)
    limit = max(1, min(limit, PAGE))
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute(
            f"""SELECT eq.id::text AS id, eq.question_redacted AS question, eq.expert_person_id::text AS expert_person_id, eq.status,
                       eq.decline_reason, eq.answer_item_id::text AS answer_item_id, eq.created_at, eq.answered_at, eq.expires_at
                  FROM expert_questions eq WHERE eq.tenant_id = %s AND eq.erased_at IS NULL AND {where}{extra}
                 ORDER BY eq.id DESC LIMIT %s""", [ctx.tenant_id, *params, *extra_params, limit + 1])
        rows = [_iso(dict(r), "created_at", "answered_at", "expires_at") for r in cur.fetchall()]
    more = len(rows) > limit
    rows = rows[:limit]
    return {"items": rows, "next_cursor": rows[-1]["id"] if more and rows else None}


def restrict_contribution(db: Database, ctx: ServiceContext, item_id: str, sensitivity: int) -> dict[str, Any]:
    """A contributor may make their own item LESS visible (a higher sensitivity), never more."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute("SELECT owner_person_id::text AS owner, sensitivity, department_id::text AS d FROM knowledge_items WHERE tenant_id = %s AND id = %s",
                    (ctx.tenant_id, item_id))
        row = cur.fetchone()
        if row is None or row["owner"] is None or row["owner"] != ctx.person_id:
            raise ItemRefused("not_found", 404)
        if sensitivity <= int(row["sensitivity"]):
            raise ItemRefused("can_only_restrict", 422)
        cur.execute("SELECT relabel('item', %s, %s, %s::smallint) AS n", (item_id, row["d"], sensitivity))
        n = int(one(cur)["n"])
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="knowledge:restrict", reason_code="CONTRIBUTION_RESTRICTED",
                    resource_type="knowledge_item", resource_id=item_id, request_id=ctx.request_id,
                    details={"sensitivity_from": int(row["sensitivity"]), "sensitivity_to": sensitivity, "rows": n})
    return {"id": item_id, "sensitivity": sensitivity}


def verification_rate_ok(db: Database, ctx: ServiceContext) -> bool:
    """Poisoning defence (docs/phase2/06): at most N verifications per card per hour and per day (settings)."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute("SELECT verifications_per_hour AS h, verifications_per_day AS d FROM knowledge_settings WHERE tenant_id = %s", (ctx.tenant_id,))
        row = cur.fetchone()
        per_hour, per_day = (int(row["h"]), int(row["d"])) if row else (30, 100)
        cur.execute(
            """SELECT count(*) FILTER (WHERE verified_at > now() - interval '1 hour')::int AS h,
                      count(*) FILTER (WHERE verified_at > now() - interval '1 day')::int AS d
                 FROM knowledge_items WHERE tenant_id = %s AND verified_by_card_id = %s""", (ctx.tenant_id, ctx.card_id))
        used = one(cur)
    return bool(used["h"] < per_hour and used["d"] < per_day)
