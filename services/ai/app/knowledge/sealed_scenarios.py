"""Decision D41, step 6 part 3b, for rows written before it: scenario titles and situations, step questions and
expected points, and learners' answers with their grading that are still readable are sealed by the housekeeping job
(`upkeep.seal_existing`), exactly as new ones are written (scenario_words). What erasure emptied stays empty: an erased
situation or step holds nothing to seal.

Each function seals at most `limit` rows of ONE company, locked while they are sealed so a request writing the same
row is never overtaken, and returns how many it sealed; without content keys it seals nothing.
"""

from __future__ import annotations

import json
from typing import Any

import psycopg

from app.capture import Fields
from app.knowledge.scenario_words import seal_step
from app.platform import one


def seal_scenarios(cur: psycopg.Cursor[Any], tenant_id: str, limit: int) -> int:
    fields = Fields(cur, tenant_id, "scenarios")
    if fields.keys is None:
        return 0
    cur.execute("""SELECT id::text AS id, title, situation FROM scenarios WHERE tenant_id = %s AND title_sealed IS NULL
                    ORDER BY id LIMIT %s FOR UPDATE SKIP LOCKED""", (tenant_id, limit))
    rows = cur.fetchall()
    for r in rows:
        key = f"scenario:{r['id']}"
        _, title, key_id = fields.seal(key, "title", r["title"])
        situation = None
        if r["situation"]:                                     # an erased situation ('') holds nothing
            _, situation, _ = fields.seal(key, "situation", r["situation"], key_id=key_id)
        cur.execute("""UPDATE scenarios SET title = NULL, title_sealed = %s, sealed_key = %s,
                              situation = CASE WHEN %s::bytea IS NULL THEN situation END, situation_sealed = %s
                        WHERE tenant_id = %s AND id = %s AND title_sealed IS NULL""", (title, key_id, situation, situation, tenant_id, r["id"]))
    return len(rows)


def seal_steps(cur: psycopg.Cursor[Any], tenant_id: str, limit: int) -> int:
    if Fields(cur, tenant_id, "scenario_steps").keys is None:
        return 0
    cur.execute("""SELECT id::text AS id, prompt, rubric FROM scenario_steps WHERE tenant_id = %s AND sealed_key IS NULL AND erased_at IS NULL
                    ORDER BY id LIMIT %s FOR UPDATE SKIP LOCKED""", (tenant_id, limit))
    rows = cur.fetchall()
    for r in rows:
        words = seal_step(cur, tenant_id, r["id"], r["prompt"], list(r["rubric"] or []))
        cur.execute("""UPDATE scenario_steps SET prompt = NULL, rubric = NULL, prompt_sealed = %s, rubric_sealed = %s, sealed_key = %s
                        WHERE tenant_id = %s AND id = %s AND sealed_key IS NULL""",
                    (words["prompt_sealed"], words["rubric_sealed"], words["sealed_key"], tenant_id, r["id"]))
    return len(rows)


def seal_answers(cur: psycopg.Cursor[Any], tenant_id: str, limit: int) -> int:
    fields = Fields(cur, tenant_id, "scenario_answers")
    if fields.keys is None:
        return 0
    cur.execute("""SELECT id::text AS id, answer_text, ai_rubric_result, sealed_key FROM scenario_answers
                    WHERE tenant_id = %s AND (answer_text IS NOT NULL OR ai_rubric_result IS NOT NULL)
                    ORDER BY id LIMIT %s FOR UPDATE SKIP LOCKED""", (tenant_id, limit))
    rows = cur.fetchall()
    for r in rows:
        key, key_id = f"scenario_answer:{r['id']}", r["sealed_key"]
        answer = rubric = None
        if r["answer_text"] is not None:
            _, answer, key_id = fields.seal(key, "answer", r["answer_text"], key_id=key_id)
        if r["ai_rubric_result"] is not None:
            _, rubric, key_id = fields.seal(key, "rubric_result", json.dumps(r["ai_rubric_result"]), key_id=key_id)
        cur.execute("""UPDATE scenario_answers SET answer_text = NULL, answer_sealed = COALESCE(%s, answer_sealed), ai_rubric_result = NULL,
                              rubric_result_sealed = COALESCE(%s, rubric_result_sealed), sealed_key = %s
                        WHERE tenant_id = %s AND id = %s""", (answer, rubric, key_id, tenant_id, r["id"]))
    return len(rows)


def still_readable(cur: psycopg.Cursor[Any], tenant_id: str) -> dict[str, int]:
    cur.execute(
        """SELECT (SELECT count(*) FROM scenarios WHERE tenant_id = %(t)s AND title_sealed IS NULL)::int AS scenarios,
                  (SELECT count(*) FROM scenario_steps WHERE tenant_id = %(t)s AND sealed_key IS NULL AND erased_at IS NULL)::int AS scenario_steps,
                  (SELECT count(*) FROM scenario_answers WHERE tenant_id = %(t)s
                      AND (answer_text IS NOT NULL OR ai_rubric_result IS NOT NULL))::int AS scenario_answers""", {"t": tenant_id})
    row = one(cur)
    return {k: int(row[k]) for k in ("scenarios", "scenario_steps", "scenario_answers")}
