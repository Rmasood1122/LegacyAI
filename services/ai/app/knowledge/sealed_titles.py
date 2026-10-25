"""Decision D41, step 6 part 2, for rows written before it: knowledge item titles and the words stored conflicts quote
that are still readable are sealed by the housekeeping job (`upkeep.seal_existing`), exactly as new ones are written
(items.create_item, item_conflicts.sync). Erased titles ('') hold nothing and are left alone.

Each function seals at most `limit` rows of ONE company, locked while they are sealed so a request writing the same
row is never overtaken, and returns how many it sealed; without content keys it seals nothing.
"""

from __future__ import annotations

from typing import Any

import psycopg

from app.capture import Fields, conflict_key
from app.platform import one


def seal_item_titles(cur: psycopg.Cursor[Any], tenant_id: str, limit: int) -> int:
    fields = Fields(cur, tenant_id, "knowledge_items")
    if fields.keys is None:
        return 0
    cur.execute("""SELECT id::text AS id, title FROM knowledge_items WHERE tenant_id = %s AND title_sealed IS NULL AND title <> ''
                    ORDER BY id LIMIT %s FOR UPDATE SKIP LOCKED""", (tenant_id, limit))
    rows = cur.fetchall()
    for r in rows:
        _, sealed, key_id = fields.seal(f"item:{r['id']}", "title", r["title"])
        cur.execute("""UPDATE knowledge_items SET title = NULL, title_sealed = %s, sealed_key = %s
                        WHERE tenant_id = %s AND id = %s AND title_sealed IS NULL""", (sealed, key_id, tenant_id, r["id"]))
    return len(rows)


def seal_conflicts(cur: psycopg.Cursor[Any], tenant_id: str, limit: int) -> int:
    fields = Fields(cur, tenant_id, "knowledge_item_conflicts")
    if fields.keys is None:
        return 0
    cur.execute("""SELECT item_id::text AS item_id, other_item_id::text AS other_item_id, item_value, other_value
                     FROM knowledge_item_conflicts WHERE tenant_id = %s AND sealed_key IS NULL
                    ORDER BY item_id, other_item_id LIMIT %s FOR UPDATE SKIP LOCKED""", (tenant_id, limit))
    rows = cur.fetchall()
    for r in rows:
        key = conflict_key(r["item_id"], r["other_item_id"])
        _, low, key_id = fields.seal(key, "item_value", r["item_value"])
        _, high, _ = fields.seal(key, "other_value", r["other_value"], key_id=key_id)
        cur.execute("""UPDATE knowledge_item_conflicts SET item_value = NULL, other_value = NULL, item_value_sealed = %s,
                              other_value_sealed = %s, sealed_key = %s
                        WHERE tenant_id = %s AND item_id = %s AND other_item_id = %s AND sealed_key IS NULL""",
                    (low, high, key_id, tenant_id, r["item_id"], r["other_item_id"]))
    return len(rows)


def still_readable(cur: psycopg.Cursor[Any], tenant_id: str) -> dict[str, int]:
    cur.execute(
        """SELECT (SELECT count(*) FROM knowledge_items WHERE tenant_id = %(t)s AND title_sealed IS NULL AND title <> '')::int AS titles,
                  (SELECT count(*) FROM knowledge_item_conflicts WHERE tenant_id = %(t)s AND sealed_key IS NULL)::int AS conflicts""",
        {"t": tenant_id})
    row = one(cur)
    return {"titles": int(row["titles"]), "conflicts": int(row["conflicts"])}
