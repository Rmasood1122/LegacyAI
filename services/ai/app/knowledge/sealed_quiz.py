"""Decision D41, step 6 part 3a, for rows written before it: readiness questions and learners' answers that are still
readable are sealed by the housekeeping job (`upkeep.seal_existing`), exactly as new ones are written
(readiness.generate / edit_question / save_answer / grading). Erased questions and emptied answers hold nothing and are
left alone.

Each function seals at most `limit` rows of ONE company, locked while they are sealed so a request writing the same
row is never overtaken, and returns how many it sealed; without content keys it seals nothing.
"""

from __future__ import annotations

import json
from typing import Any

import psycopg

from app.capture import Fields
from app.knowledge.readiness import seal_quiz_content
from app.platform import one


def seal_questions(cur: psycopg.Cursor[Any], tenant_id: str, limit: int) -> int:
    if Fields(cur, tenant_id, "quiz_items").keys is None:
        return 0
    cur.execute("""SELECT id::text AS id, stem, options, rubric FROM quiz_items
                    WHERE tenant_id = %s AND content_sealed IS NULL AND erased_at IS NULL
                    ORDER BY id LIMIT %s FOR UPDATE SKIP LOCKED""", (tenant_id, limit))
    rows = cur.fetchall()
    for r in rows:
        words = seal_quiz_content(cur, tenant_id, r["id"], r["stem"], r["options"], r["rubric"])
        cur.execute("""UPDATE quiz_items SET stem = NULL, options = NULL, rubric = NULL, content_sealed = %s, sealed_key = %s
                        WHERE tenant_id = %s AND id = %s AND content_sealed IS NULL""", (words["content_sealed"], words["sealed_key"], tenant_id, r["id"]))
    return len(rows)


def seal_answers(cur: psycopg.Cursor[Any], tenant_id: str, limit: int) -> int:
    fields = Fields(cur, tenant_id, "quiz_answers")
    if fields.keys is None:
        return 0
    cur.execute("""SELECT id::text AS id, answer_text, ai_rubric_result, sealed_key FROM quiz_answers
                    WHERE tenant_id = %s AND (answer_text IS NOT NULL OR ai_rubric_result IS NOT NULL)
                    ORDER BY id LIMIT %s FOR UPDATE SKIP LOCKED""", (tenant_id, limit))
    rows = cur.fetchall()
    for r in rows:
        key, key_id = f"quiz_answer:{r['id']}", r["sealed_key"]
        answer = rubric = None
        if r["answer_text"] is not None:
            _, answer, key_id = fields.seal(key, "answer", r["answer_text"], key_id=key_id)
        if r["ai_rubric_result"] is not None:
            _, rubric, key_id = fields.seal(key, "rubric_result", json.dumps(r["ai_rubric_result"]), key_id=key_id)
        cur.execute("""UPDATE quiz_answers SET answer_text = NULL, answer_sealed = COALESCE(%s, answer_sealed), ai_rubric_result = NULL,
                              rubric_result_sealed = COALESCE(%s, rubric_result_sealed), sealed_key = %s
                        WHERE tenant_id = %s AND id = %s""", (answer, rubric, key_id, tenant_id, r["id"]))
    return len(rows)


def still_readable(cur: psycopg.Cursor[Any], tenant_id: str) -> dict[str, int]:
    cur.execute(
        """SELECT (SELECT count(*) FROM quiz_items WHERE tenant_id = %(t)s AND content_sealed IS NULL AND erased_at IS NULL)::int AS quiz_questions,
                  (SELECT count(*) FROM quiz_answers WHERE tenant_id = %(t)s
                      AND (answer_text IS NOT NULL OR ai_rubric_result IS NOT NULL))::int AS quiz_answers""", {"t": tenant_id})
    row = one(cur)
    return {"quiz_questions": int(row["quiz_questions"]), "quiz_answers": int(row["quiz_answers"])}
