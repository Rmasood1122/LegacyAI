"""Offline packs (feature 9, the founder's choices of 2026-10-27): the verified knowledge of one job role, for reading
and searching without a connection in the web app.

What goes in, and nothing else:
- items that are verified or corrected and not past their review date (`stale_after`);
- at sensitivity level 0 or 1 only (PACK_MAX_SENSITIVITY), whatever the caller may read - confidential levels never
  leave the server;
- that the caller may read (ctx.filter, built for knowledge:read; "verified only" applies as everywhere);
- linked to an active topic of the job role that the caller may read (ctx.topic_filter, built for topic:read).

Titles, texts and topic names are opened for this request only (D41) and sent over the connection; the web app keeps
the pack sealed on the device. The expiry and the "as of" date are set by the API, which also writes the audit entry.
"""

from __future__ import annotations

from typing import Any

from app.capture import VERSION_TEXT, Fields, condition, item_title_columns, open_item_title, open_topic, topic_condition, topic_text_columns, version_text
from app.platform import Database, ServiceContext

PACK_MAX_ITEMS = 500
PACK_MAX_SENSITIVITY = 1


def pack(db: Database, ctx: ServiceContext, job_role: str) -> dict[str, Any]:
    """The job role's topics and verified items for this caller. `truncated` is true when more than PACK_MAX_ITEMS items
    qualified (the first ones by id are kept)."""
    where, params = condition(ctx.filter, "knowledge_items", ctx.tenant_id)
    twhere, tparams = topic_condition(ctx.topic_filter, ctx.tenant_id)
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute(f"""SELECT DISTINCT tp.id::text AS id, {topic_text_columns("tp")} FROM role_topic_maps m
                          JOIN topics tp ON tp.tenant_id = m.tenant_id AND tp.id = m.topic_id
                         WHERE m.tenant_id = %s AND m.job_role = %s AND tp.status = 'active' AND {twhere}""",
                    [ctx.tenant_id, job_role, *tparams])
        names = Fields(cur, ctx.tenant_id, "topics")
        topics = sorted(({"topic_id": t["id"], "name": t["name"]} for t in (open_topic(names, dict(r)) for r in cur.fetchall())),
                        key=lambda t: (t["name"], t["topic_id"]))
        if not topics:
            return {"job_role": job_role, "topics": [], "items": [], "truncated": False}
        topic_ids = [t["topic_id"] for t in topics]
        cur.execute(
            f"""SELECT i.id::text AS id, {item_title_columns("i")}, i.status, i.sensitivity, i.verified_at, {VERSION_TEXT}
                  FROM knowledge_items i
                  JOIN knowledge_versions v ON v.tenant_id = i.tenant_id AND v.id = i.current_version_id AND v.erased_at IS NULL
                 WHERE i.tenant_id = %s AND i.status IN ('verified', 'corrected') AND i.sensitivity <= %s
                   AND (i.stale_after IS NULL OR i.stale_after > now())
                   AND EXISTS (SELECT 1 FROM knowledge_item_topics kt
                                WHERE kt.tenant_id = i.tenant_id AND kt.item_id = i.id AND kt.topic_id = ANY(%s::uuid[]))
                   AND {where}
                 ORDER BY i.id LIMIT %s""",
            [ctx.tenant_id, PACK_MAX_SENSITIVITY, topic_ids, *params, PACK_MAX_ITEMS + 1])
        rows = cur.fetchall()
        titles = Fields(cur, ctx.tenant_id, "knowledge_items")
        bodies = Fields(cur, ctx.tenant_id, "knowledge_versions")
        items = []
        for r in rows[:PACK_MAX_ITEMS]:
            opened = open_item_title(titles, dict(r))
            items.append({"id": opened["id"], "title": opened["title"], "body": version_text(bodies, opened), "status": opened["status"],
                          "sensitivity": int(opened["sensitivity"]),
                          "verified_at": opened["verified_at"].isoformat() if opened["verified_at"] else None, "topic_ids": []})
        if items:
            cur.execute("""SELECT item_id::text AS item_id, topic_id::text AS topic_id FROM knowledge_item_topics
                            WHERE tenant_id = %s AND item_id = ANY(%s::uuid[]) AND topic_id = ANY(%s::uuid[]) ORDER BY 1, 2""",
                        (ctx.tenant_id, [i["id"] for i in items], topic_ids))
            links: dict[str, list[str]] = {}
            for link in cur.fetchall():
                links.setdefault(link["item_id"], []).append(link["topic_id"])
            for item in items:
                item["topic_ids"] = links.get(item["id"], [])
    return {"job_role": job_role, "topics": topics, "items": items, "truncated": len(rows) > PACK_MAX_ITEMS}
