"""Sealing the rows written before decision D41 step 4b (step 5): document pieces and search copies (chunks) and
interview turns that are still readable are sealed with the company's content key, exactly as new rows are. Knowledge
versions are sealed by the knowledge module (`app.knowledge.items.seal_existing_versions`) with the same helpers.

Each call does a bounded amount of work for ONE company and is idempotent: a row is picked only while it is readable,
locked while it is sealed (FOR UPDATE SKIP LOCKED, so a request writing the same row is never overtaken), and sealed
once. Without content keys (development and tests that switch them off) nothing is sealed.
"""

from __future__ import annotations

from typing import Any

import psycopg

from app.capture.sealed_chunks import Fields, Sealer, row_key, seal_source_title, turn_key
from app.platform import one


def seal_chunks(cur: psycopg.Cursor[Any], tenant_id: str, limit: int) -> int:
    """Seals up to `limit` readable chunks (text and, when it has one, vector). Returns how many were sealed."""
    sealer = Sealer(cur, tenant_id)
    if not sealer.sealing:
        return 0
    cur.execute(
        """SELECT id, kind, source_id::text AS source_id, ordinal, knowledge_item_id::text AS knowledge_item_id, text, embedding
             FROM chunks WHERE tenant_id = %s AND text_sealed IS NULL
            ORDER BY id LIMIT %s FOR UPDATE SKIP LOCKED""", (tenant_id, limit))
    rows = cur.fetchall()
    if not rows:
        return 0
    cur.execute("SELECT set_config('app.reseal', 'on', true)")      # the one change chunks_guard allows for this (migration 20261025000500)
    for r in rows:
        key = row_key(kind=r["kind"], source_id=r["source_id"], ordinal=r["ordinal"], knowledge_item_id=r["knowledge_item_id"])
        body = sealer.text_columns(key, r["text"])
        vector: dict[str, Any] = {"embedding": None, "embedding_sealed": None}
        if r["embedding"] is not None:
            vector = sealer.vector_columns(key, [float(x) for x in r["embedding"].to_list()], body["sealed_key"])
        cur.execute(
            """UPDATE chunks SET text = NULL, text_sealed = %s, sealed_key = %s, embedding = NULL, embedding_sealed = %s
                WHERE tenant_id = %s AND id = %s AND text_sealed IS NULL""",
            (body["text_sealed"], body["sealed_key"], vector["embedding_sealed"], tenant_id, r["id"]))
    cur.execute("SELECT set_config('app.reseal', 'off', true)")
    return len(rows)


def seal_turns(cur: psycopg.Cursor[Any], tenant_id: str, limit: int) -> int:
    """Seals up to `limit` readable interview turns (the question and, when answered, the answer, with one key).
    Erased turns hold nothing and are left alone. Returns how many were sealed."""
    fields = Fields(cur, tenant_id, "interview_turns")
    if fields.keys is None:
        return 0
    cur.execute(
        """SELECT id, interview_id::text AS interview_id, ordinal, question_text, answer_text
             FROM interview_turns WHERE tenant_id = %s AND question_sealed IS NULL AND erased_at IS NULL
            ORDER BY id LIMIT %s FOR UPDATE SKIP LOCKED""", (tenant_id, limit))
    rows = cur.fetchall()
    for r in rows:
        key = turn_key(r["interview_id"], int(r["ordinal"]))
        _, question, key_id = fields.seal(key, "question", r["question_text"])
        answer = None
        if r["answer_text"] is not None:
            _, answer, _ = fields.seal(key, "answer", r["answer_text"], key_id=key_id)
        cur.execute(
            """UPDATE interview_turns SET question_text = NULL, question_sealed = %s, answer_text = NULL, answer_sealed = %s, sealed_key = %s
                WHERE tenant_id = %s AND id = %s AND question_sealed IS NULL AND erased_at IS NULL""",
            (question, answer, key_id, tenant_id, r["id"]))
    return len(rows)


def seal_document_titles(cur: psycopg.Cursor[Any], tenant_id: str, limit: int) -> int:
    """Seals up to `limit` readable document titles (D41 step 6 part 4a). Erased titles ('') hold nothing."""
    if Fields(cur, tenant_id, "sources").keys is None:
        return 0
    cur.execute("""SELECT id::text AS id, title FROM sources WHERE tenant_id = %s AND title_sealed IS NULL AND title <> ''
                    ORDER BY id LIMIT %s FOR UPDATE SKIP LOCKED""", (tenant_id, limit))
    rows = cur.fetchall()
    for r in rows:
        stored = seal_source_title(cur, tenant_id, r["id"], r["title"])
        cur.execute("UPDATE sources SET title = NULL, title_sealed = %s, sealed_key = %s WHERE tenant_id = %s AND id = %s AND title_sealed IS NULL",
                    (stored["title_sealed"], stored["sealed_key"], tenant_id, r["id"]))
    return len(rows)


def still_readable(cur: psycopg.Cursor[Any], tenant_id: str) -> dict[str, int]:
    """How many chunks, interview turns and document titles of the company are still readable (erased ones hold nothing)."""
    cur.execute(
        """SELECT (SELECT count(*) FROM chunks WHERE tenant_id = %(t)s AND text_sealed IS NULL)::int AS chunks,
                  (SELECT count(*) FROM interview_turns WHERE tenant_id = %(t)s AND question_sealed IS NULL AND erased_at IS NULL)::int AS turns,
                  (SELECT count(*) FROM sources WHERE tenant_id = %(t)s AND title_sealed IS NULL AND title <> '')::int AS document_titles""",
        {"t": tenant_id})
    row = one(cur)
    return {"chunks": int(row["chunks"]), "turns": int(row["turns"]), "document_titles": int(row["document_titles"])}
