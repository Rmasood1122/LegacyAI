"""Decision D41, step 6 part 1, for rows written before it: questions people asked (answer logs), questions put to an
expert and readers' comments that are still readable are sealed by the housekeeping job (`upkeep.seal_existing`),
exactly as new ones are written (answers._finish, expert.create_question, quality.put_feedback).

Each function seals at most `limit` rows of ONE company and returns how many it sealed; without content keys it seals
nothing. Answer logs go through `seal_answer_log()` (the AI service may not change a log itself); the other two are
locked while they are sealed so a request writing the same row is never overtaken.
"""

from __future__ import annotations

from typing import Any

import psycopg

from app.capture import Fields, answer_key, expert_question_key, feedback_key
from app.platform import one


def seal_answer_logs(cur: psycopg.Cursor[Any], tenant_id: str, limit: int) -> int:
    fields = Fields(cur, tenant_id, "answer_logs")
    if fields.keys is None:
        return 0
    cur.execute("""SELECT id::text AS id, question_redacted FROM answer_logs WHERE tenant_id = %s AND question_sealed IS NULL
                    ORDER BY id LIMIT %s""", (tenant_id, limit))
    sealed = 0
    for r in cur.fetchall():
        _, question, key_id = fields.seal(answer_key(r["id"]), "question", r["question_redacted"])
        cur.execute("SELECT seal_answer_log(%s, %s, %s) AS done", (r["id"], question, key_id))
        sealed += 1 if one(cur)["done"] else 0
    return sealed


def seal_expert_questions(cur: psycopg.Cursor[Any], tenant_id: str, limit: int) -> int:
    fields = Fields(cur, tenant_id, "expert_questions")
    if fields.keys is None:
        return 0
    cur.execute("""SELECT id::text AS id, question_redacted FROM expert_questions
                    WHERE tenant_id = %s AND question_sealed IS NULL AND erased_at IS NULL
                    ORDER BY id LIMIT %s FOR UPDATE SKIP LOCKED""", (tenant_id, limit))
    rows = cur.fetchall()
    for r in rows:
        _, question, key_id = fields.seal(expert_question_key(r["id"]), "question", r["question_redacted"])
        cur.execute("""UPDATE expert_questions SET question_redacted = NULL, question_sealed = %s, sealed_key = %s
                        WHERE tenant_id = %s AND id = %s AND question_sealed IS NULL""", (question, key_id, tenant_id, r["id"]))
    return len(rows)


def seal_feedback(cur: psycopg.Cursor[Any], tenant_id: str, limit: int) -> int:
    fields = Fields(cur, tenant_id, "answer_feedback")
    if fields.keys is None:
        return 0
    cur.execute("""SELECT id, answer_log_id::text AS answer_id, card_id::text AS card_id, comment_redacted FROM answer_feedback
                    WHERE tenant_id = %s AND comment_redacted IS NOT NULL
                    ORDER BY id LIMIT %s FOR UPDATE SKIP LOCKED""", (tenant_id, limit))
    rows = cur.fetchall()
    for r in rows:
        _, comment, key_id = fields.seal(feedback_key(r["answer_id"], r["card_id"]), "comment", r["comment_redacted"])
        cur.execute("""UPDATE answer_feedback SET comment_redacted = NULL, comment_sealed = %s, sealed_key = %s
                        WHERE tenant_id = %s AND id = %s AND comment_redacted IS NOT NULL""", (comment, key_id, tenant_id, r["id"]))
    return len(rows)


def still_readable(cur: psycopg.Cursor[Any], tenant_id: str) -> dict[str, int]:
    cur.execute(
        """SELECT (SELECT count(*) FROM answer_logs WHERE tenant_id = %(t)s AND question_sealed IS NULL)::int AS questions,
                  (SELECT count(*) FROM expert_questions WHERE tenant_id = %(t)s AND question_sealed IS NULL AND erased_at IS NULL)::int
                      AS expert_questions,
                  (SELECT count(*) FROM answer_feedback WHERE tenant_id = %(t)s AND comment_redacted IS NOT NULL)::int AS feedback""",
        {"t": tenant_id})
    row = one(cur)
    return {k: int(row[k]) for k in ("questions", "expert_questions", "feedback")}
