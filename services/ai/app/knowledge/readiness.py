"""Readiness test (feature 13; docs/phase2/06 §5).

Questions come only from items that are verified/corrected AND released to learners (level 0);
the API approves each item first. Every generated question is a draft until a reviewer approves
it. Multiple-choice is graded in code; open answers are graded by the model AGAINST THE RUBRIC,
point by point, and the score is computed in code. A reviewer can override any grade.
"""

from __future__ import annotations

import random
import re
from datetime import datetime
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from app.ai_gateway import Caller, DataBlock, Gateway, QuizGenerateOutput, QuizGradeOutput
from app.knowledge.items import ItemRefused, _settings
from app.platform import Database, ServiceContext, one, write_audit

LOW_GRADING_CONFIDENCE = 0.6
REPORT_STATEMENT = (
    "This report shows how one person answered one set of questions on one occasion. It is not a certificate of competence. "
    "Knowledge the company has not released to learners is not counted here.")

_NORM = re.compile(r"[^a-z0-9]+")


def _norm(text: str) -> str:
    return _NORM.sub(" ", text.lower()).strip()


def leak_check(q: QuizGenerateOutput) -> str | None:
    """The answer-leak guard. Returns a reason when the question must be refused."""
    if q.kind == "mcq":
        if len(q.options) != 4 or q.correct_option is None or not 0 <= q.correct_option <= 3:
            return "malformed"
        normalised = [_norm(o) for o in q.options]
        if len(set(normalised)) != 4 or any(not o for o in normalised):
            return "options_not_distinct"
        if normalised[q.correct_option] in _norm(q.stem):
            return "answer_in_stem"
    elif not q.rubric:
        return "malformed"
    return None


def generate(db: Database, ctx: ServiceContext, gateway: Gateway, caller: Caller, kind: str) -> dict[str, Any]:
    """One draft question per approved item (ctx.approved holds knowledge item ids)."""
    created, refused = [], []
    with db.tenant_tx(ctx.tenant_id) as cur:
        sla = int(_settings(cur, ctx.tenant_id)["review_sla_days"])
        cur.execute(
            """SELECT i.id::text AS id, i.current_version_id::text AS version_id, i.department_id::text AS department_id, i.owner_person_id::text AS owner,
                      v.body, (SELECT kt.topic_id::text FROM knowledge_item_topics kt WHERE kt.tenant_id = i.tenant_id AND kt.item_id = i.id
                                ORDER BY (kt.link_source = 'reviewer') DESC, kt.score DESC NULLS LAST, kt.topic_id LIMIT 1) AS topic_id
                 FROM knowledge_items i JOIN knowledge_versions v ON v.tenant_id = i.tenant_id AND v.id = i.current_version_id
                WHERE i.tenant_id = %s AND i.id = ANY(%s::uuid[]) AND i.status IN ('verified', 'corrected') AND i.sensitivity = 0""",
            (ctx.tenant_id, list(ctx.approved)))
        items = cur.fetchall()
    for item in items:
        outcome = gateway.generate(caller, "quiz_generate", "quiz_generate",
                                   [DataBlock("KIND", kind), DataBlock("ITEM", item["body"])])
        parsed = outcome.parsed
        if not isinstance(parsed, QuizGenerateOutput):
            refused.append({"item_id": item["id"], "reason": outcome.refused or "ai_unavailable"})
            continue
        reason = leak_check(parsed)
        if reason is not None:
            refused.append({"item_id": item["id"], "reason": reason})
            continue
        with db.tenant_tx(ctx.tenant_id) as cur:
            cur.execute(
                """INSERT INTO quiz_items (tenant_id, topic_id, knowledge_item_id, knowledge_version_id, kind, stem, options, correct_option, rubric,
                                           department_id, sensitivity, owner_person_id, prompt_version)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 0, %s, 'quiz_generate@v1') RETURNING id::text AS id""",
                (ctx.tenant_id, item["topic_id"], item["id"], item["version_id"], parsed.kind, parsed.stem,
                 Jsonb(parsed.options) if parsed.kind == "mcq" else None, parsed.correct_option if parsed.kind == "mcq" else None,
                 Jsonb(parsed.rubric) if parsed.kind == "open" else None, item["department_id"], item["owner"]))
            qid = one(cur)["id"]
            cur.execute(
                """INSERT INTO review_tasks (tenant_id, kind, subject_type, subject_id, department_id, sensitivity, owner_person_id, priority, due_at)
                   VALUES (%s, 'quiz_item_approval', 'quiz_item', %s, %s, 0, %s, 10, now() + make_interval(days => %s))""",
                (ctx.tenant_id, qid, item["department_id"], item["owner"], sla))
            write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="quiz:generate", reason_code="QUESTION_DRAFTED",
                        resource_type="quiz_item", resource_id=qid, request_id=ctx.request_id, details={"item_id": item["id"]})
            created.append(qid)
    return {"created": created, "refused": refused}


def set_question_status(db: Database, ctx: ServiceContext, question_id: str, status: str) -> None:
    with db.tenant_tx(ctx.tenant_id) as cur:
        try:
            cur.execute(
                """UPDATE quiz_items SET status = %s, approved_by_card_id = CASE WHEN %s = 'approved' THEN %s ELSE approved_by_card_id END,
                          approved_at = CASE WHEN %s = 'approved' THEN now() ELSE approved_at END
                    WHERE tenant_id = %s AND id = %s""", (status, status, ctx.card_id, status, ctx.tenant_id, question_id))
        except psycopg.errors.CheckViolation as exc:
            raise ItemRefused("illegal_transition") from exc
        if cur.rowcount == 0:
            raise ItemRefused("not_found", 404)
        cur.execute("""UPDATE review_tasks SET status = 'resolved', resolved_at = now(), resolved_by_card_id = %s, resolution = %s,
                              assigned_to_card_id = NULL WHERE tenant_id = %s AND subject_type = 'quiz_item' AND subject_id = %s
                          AND status IN ('open', 'assigned')""", (ctx.card_id, status, ctx.tenant_id, question_id))
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action=f"quiz:{status}", reason_code=f"QUESTION_{status.upper()}",
                    resource_type="quiz_item", resource_id=question_id, request_id=ctx.request_id)


def edit_question(db: Database, ctx: ServiceContext, question_id: str, stem: str, options: list[str] | None, correct_option: int | None,
                  rubric: list[str] | None) -> None:
    """An edit puts an approved question back to draft (the trigger clears the approval)."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute("SELECT kind, status FROM quiz_items WHERE tenant_id = %s AND id = %s FOR UPDATE", (ctx.tenant_id, question_id))
        row = cur.fetchone()
        if row is None:
            raise ItemRefused("not_found", 404)
        if row["status"] == "retired":
            raise ItemRefused("illegal_transition")
        probe = QuizGenerateOutput(kind=row["kind"], stem=stem, options=options or [], correct_option=correct_option, rubric=rubric or [])
        reason = leak_check(probe)
        if reason is not None:
            raise ItemRefused(reason, 422)
        if row["status"] == "approved":
            cur.execute("UPDATE quiz_items SET status = 'draft' WHERE tenant_id = %s AND id = %s", (ctx.tenant_id, question_id))
        cur.execute("UPDATE quiz_items SET stem = %s, options = %s, correct_option = %s, rubric = %s WHERE tenant_id = %s AND id = %s",
                    (stem, Jsonb(options) if row["kind"] == "mcq" else None, correct_option if row["kind"] == "mcq" else None,
                     Jsonb(rubric) if row["kind"] == "open" else None, ctx.tenant_id, question_id))
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="quiz:edit", reason_code="QUESTION_EDITED",
                    resource_type="quiz_item", resource_id=question_id, request_id=ctx.request_id)


def start_attempt(db: Database, ctx: ServiceContext, job_role: str, seed: int | None = None) -> dict[str, Any]:
    """Freezes the questions (from ctx.approved: quiz item ids the API checked against THIS learner) and their option order."""
    if ctx.person_id is None:
        raise ItemRefused("no_person", 403)
    rng = random.Random(seed)
    with db.tenant_tx(ctx.tenant_id) as cur:
        s = _settings_full(cur, ctx.tenant_id)
        cur.execute(
            """SELECT q.id::text AS id, q.kind, q.stem, q.options,
                      (SELECT max(a.started_at) FROM quiz_answers qa JOIN quiz_attempts a ON a.tenant_id = qa.tenant_id AND a.id = qa.attempt_id
                        WHERE qa.tenant_id = q.tenant_id AND qa.quiz_item_id = q.id AND a.learner_person_id = %s) AS last_seen
                 FROM quiz_items q JOIN role_topic_maps m ON m.tenant_id = q.tenant_id AND m.topic_id = q.topic_id AND m.job_role = %s
                WHERE q.tenant_id = %s AND q.status = 'approved' AND q.id = ANY(%s::uuid[])""",
            (ctx.person_id, job_role, ctx.tenant_id, list(ctx.approved)))
        bank = cur.fetchall()
        if not bank:
            raise ItemRefused("no_questions", 422)
        epoch = datetime.min.replace(tzinfo=None)
        rng.shuffle(bank)
        bank.sort(key=lambda q: (q["last_seen"].replace(tzinfo=None) if q["last_seen"] else epoch))   # least recently seen first
        chosen = bank[: int(s["quiz_questions_per_attempt"])]
        cur.execute(
            """INSERT INTO quiz_attempts (tenant_id, learner_card_id, learner_person_id, owner_person_id, job_role, expires_at, bank_size)
               VALUES (%s, %s, %s, %s, %s, now() + make_interval(mins => %s), %s) RETURNING id::text AS id, expires_at""",
            (ctx.tenant_id, ctx.card_id, ctx.person_id, ctx.person_id, job_role, int(s["quiz_time_limit_minutes"]), len(bank)))
        attempt = one(cur)
        questions = []
        for pos, q in enumerate(chosen, start=1):
            order = rng.sample(range(4), 4) if q["kind"] == "mcq" else None
            cur.execute("INSERT INTO quiz_answers (tenant_id, attempt_id, quiz_item_id, position, option_order) VALUES (%s, %s, %s, %s, %s)",
                        (ctx.tenant_id, attempt["id"], q["id"], pos, order))
            shown = [q["options"][i] for i in order] if order else None
            questions.append({"position": pos, "kind": q["kind"], "stem": q["stem"], "options": shown})   # never the correct option
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="quiz:start", reason_code="ATTEMPT_STARTED",
                    resource_type="quiz_attempt", resource_id=attempt["id"], request_id=ctx.request_id, details={"count": len(chosen)})
    return {"id": attempt["id"], "expires_at": attempt["expires_at"].isoformat(), "questions": questions}


def _settings_full(cur: psycopg.Cursor[Any], tenant_id: str) -> dict[str, Any]:
    cur.execute("SELECT * FROM knowledge_settings WHERE tenant_id = %s", (tenant_id,))
    row = cur.fetchone()
    return dict(row) if row else {"quiz_questions_per_attempt": 10, "quiz_time_limit_minutes": 45, "quiz_min_questions_per_topic": 3,
                                  "quiz_show_answers_after_grading": False, "review_sla_days": 5}


def _own_attempt(cur: psycopg.Cursor[Any], ctx: ServiceContext, attempt_id: str) -> dict[str, Any]:
    cur.execute("""SELECT id::text AS id, status, expires_at, learner_person_id::text AS learner FROM quiz_attempts
                    WHERE tenant_id = %s AND id = %s FOR UPDATE""", (ctx.tenant_id, attempt_id))
    row = cur.fetchone()
    if row is None or row["learner"] != ctx.person_id:
        raise ItemRefused("not_found", 404)
    return dict(row)


def save_answer(db: Database, ctx: ServiceContext, attempt_id: str, position: int, chosen: int | None, text: str | None) -> None:
    from app.capture import redact  # answers are stored redacted, like every other free text

    with db.tenant_tx(ctx.tenant_id) as cur:
        a = _own_attempt(cur, ctx, attempt_id)
        cur.execute("SELECT now() > %s AS late", (a["expires_at"],))
        if a["status"] != "in_progress" or one(cur)["late"]:
            raise ItemRefused("attempt_closed")
        cur.execute("""UPDATE quiz_answers SET chosen_option = %s, answer_text = %s WHERE tenant_id = %s AND attempt_id = %s AND position = %s""",
                    (chosen, redact(text).text[:4000] if text else None, ctx.tenant_id, attempt_id, position))
        if cur.rowcount == 0:
            raise ItemRefused("not_found", 404)


def submit_attempt(db: Database, ctx: ServiceContext, attempt_id: str, gateway: Gateway | None, caller: Caller | None) -> dict[str, Any]:
    """Once only (state check + trigger). MCQ graded in code; open answers by the rubric, or left for a person."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        a = _own_attempt(cur, ctx, attempt_id)
        if a["status"] != "in_progress":
            raise ItemRefused("already_submitted")
        try:
            cur.execute("UPDATE quiz_attempts SET status = 'submitted', submitted_at = now() WHERE tenant_id = %s AND id = %s",
                        (ctx.tenant_id, attempt_id))
        except psycopg.errors.CheckViolation as exc:
            raise ItemRefused("attempt_closed") from exc
        cur.execute(
            """SELECT qa.id::text AS id, qa.option_order, qa.chosen_option, qa.answer_text, q.kind, q.correct_option, q.rubric, q.stem,
                      q.department_id::text AS department_id, q.owner_person_id::text AS owner
                 FROM quiz_answers qa JOIN quiz_items q ON q.tenant_id = qa.tenant_id AND q.id = qa.quiz_item_id
                WHERE qa.tenant_id = %s AND qa.attempt_id = %s ORDER BY qa.position""", (ctx.tenant_id, attempt_id))
        answers = cur.fetchall()
        sla = int(_settings(cur, ctx.tenant_id)["review_sla_days"])
        for ans in answers:
            if ans["kind"] == "mcq":
                shown = ans["chosen_option"]
                correct = shown is not None and ans["option_order"][shown] == ans["correct_option"]
                score = 1.0 if correct else 0.0
                cur.execute("UPDATE quiz_answers SET auto_score = %s, final_score = %s, decided_by = 'auto', graded_at = now() "
                            "WHERE tenant_id = %s AND id = %s", (score, score, ctx.tenant_id, ans["id"]))
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="quiz:submit", reason_code="ATTEMPT_SUBMITTED",
                    resource_type="quiz_attempt", resource_id=attempt_id, request_id=ctx.request_id)
    for ans in [x for x in answers if x["kind"] == "open"]:
        _grade_open(db, ctx, ans, gateway, caller, sla)
    return _maybe_graded(db, ctx.tenant_id, attempt_id)


def _grade_open(db: Database, ctx: ServiceContext, ans: dict[str, Any], gateway: Gateway | None, caller: Caller | None, sla: int) -> None:
    rubric: list[str] = list(ans["rubric"] or [])
    text = ans["answer_text"] or ""
    result = None
    if text.strip() and gateway is not None and caller is not None:
        blocks = [DataBlock("QUESTION", ans["stem"]), *[DataBlock(f"POINT_{i}", p) for i, p in enumerate(rubric)],
                  DataBlock("LEARNER_ANSWER", text)]
        outcome = gateway.generate(caller, "quiz_grade", "quiz_grade", blocks)
        if isinstance(outcome.parsed, QuizGradeOutput):
            result = outcome.parsed
    with db.tenant_tx(ctx.tenant_id) as cur:
        if not text.strip():
            cur.execute("UPDATE quiz_answers SET final_score = 0, decided_by = 'auto', auto_score = 0, graded_at = now() WHERE tenant_id = %s AND id = %s",
                        (ctx.tenant_id, ans["id"]))
            return
        task = result is None
        if result is not None:
            # code computes the score; a point counts only if the cited evidence is really in the answer
            met = {p.point for p in result.points if p.met and 0 <= p.point < len(rubric) and p.evidence and _norm(p.evidence) in _norm(text)}
            score = len(met) / len(rubric) if rubric else 0.0
            cur.execute(
                """UPDATE quiz_answers SET ai_score = %s, ai_rubric_result = %s, ai_confidence = %s, final_score = %s, decided_by = 'ai', graded_at = now()
                    WHERE tenant_id = %s AND id = %s""",
                (score, Jsonb([p.model_dump() for p in result.points]), result.confidence, score, ctx.tenant_id, ans["id"]))
            task = result.confidence < LOW_GRADING_CONFIDENCE
        if task:
            cur.execute(
                """INSERT INTO review_tasks (tenant_id, kind, subject_type, subject_id, department_id, sensitivity, owner_person_id, priority, due_at)
                   VALUES (%s, 'grading_override', 'quiz_answer', %s, %s, 0, %s, 30, now() + make_interval(days => %s)) ON CONFLICT DO NOTHING""",
                (ctx.tenant_id, ans["id"], ans["department_id"], ans["owner"], sla))


def _maybe_graded(db: Database, tenant_id: str, attempt_id: str) -> dict[str, Any]:
    with db.tenant_tx(tenant_id) as cur:
        cur.execute("SELECT count(*) FILTER (WHERE final_score IS NULL)::int AS open FROM quiz_answers WHERE tenant_id = %s AND attempt_id = %s",
                    (tenant_id, attempt_id))
        if one(cur)["open"] == 0:
            cur.execute("UPDATE quiz_attempts SET status = 'graded', graded_at = now() WHERE tenant_id = %s AND id = %s AND status = 'submitted'",
                        (tenant_id, attempt_id))
        cur.execute("SELECT status FROM quiz_attempts WHERE tenant_id = %s AND id = %s", (tenant_id, attempt_id))
        return {"id": attempt_id, "status": one(cur)["status"]}


def override(db: Database, ctx: ServiceContext, answer_id: str, score: float) -> dict[str, Any]:
    if not 0 <= score <= 1:
        raise ItemRefused("bad_score", 400)
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute("""UPDATE quiz_answers qa SET final_score = %s, decided_by = 'reviewer', overridden_by_card_id = %s, graded_at = now()
                         FROM quiz_attempts a WHERE a.tenant_id = qa.tenant_id AND a.id = qa.attempt_id AND a.status IN ('submitted', 'graded')
                          AND qa.tenant_id = %s AND qa.id = %s RETURNING qa.attempt_id::text AS attempt_id""",
                    (score, ctx.card_id, ctx.tenant_id, answer_id))
        row = cur.fetchone()
        if row is None:
            raise ItemRefused("not_found", 404)
        cur.execute("""UPDATE review_tasks SET status = 'resolved', resolved_at = now(), resolved_by_card_id = %s, resolution = 'overridden',
                              assigned_to_card_id = NULL WHERE tenant_id = %s AND subject_type = 'quiz_answer' AND subject_id = %s
                          AND status IN ('open', 'assigned')""", (ctx.card_id, ctx.tenant_id, answer_id))
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="quiz:override", reason_code="GRADE_OVERRIDDEN",
                    resource_type="quiz_answer", resource_id=answer_id, request_id=ctx.request_id)
    return _maybe_graded(db, ctx.tenant_id, row["attempt_id"])


def report(db: Database, ctx: ServiceContext, attempt_id: str) -> dict[str, Any]:
    """The proof report. Counts only level-0 verified knowledge, so it is the same whoever reads it."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        s = _settings_full(cur, ctx.tenant_id)
        cur.execute("""SELECT id::text AS id, learner_person_id::text AS learner, job_role, status, started_at, submitted_at, graded_at, bank_size
                         FROM quiz_attempts WHERE tenant_id = %s AND id = %s""", (ctx.tenant_id, attempt_id))
        a = cur.fetchone()
        if a is None:
            raise ItemRefused("not_found", 404)
        cur.execute(
            """SELECT tp.id::text AS topic_id, tp.name,
                      (SELECT count(*) FROM knowledge_item_topics kt JOIN knowledge_items i ON i.tenant_id = kt.tenant_id AND i.id = kt.item_id
                        WHERE kt.tenant_id = m.tenant_id AND kt.topic_id = m.topic_id
                          AND i.status IN ('verified', 'corrected') AND i.sensitivity = 0)::int AS released,
                      (SELECT count(*) FROM quiz_items q WHERE q.tenant_id = m.tenant_id AND q.topic_id = m.topic_id AND q.status = 'approved')::int AS bank,
                      count(qa.id)::int AS asked, COALESCE(sum(qa.final_score), 0)::float8 AS points,
                      count(qa.id) FILTER (WHERE qa.decided_by = 'ai')::int AS ai_graded,
                      count(qa.id) FILTER (WHERE qa.decided_by = 'reviewer')::int AS person_graded,
                      count(qa.id) FILTER (WHERE qa.final_score IS NULL)::int AS ungraded
                 FROM role_topic_maps m JOIN topics tp ON tp.tenant_id = m.tenant_id AND tp.id = m.topic_id
                 LEFT JOIN quiz_items q2 ON q2.tenant_id = m.tenant_id AND q2.topic_id = m.topic_id
                 LEFT JOIN quiz_answers qa ON qa.tenant_id = q2.tenant_id AND qa.quiz_item_id = q2.id AND qa.attempt_id = %s
                WHERE m.tenant_id = %s AND m.job_role = %s
                GROUP BY tp.id, tp.name, m.tenant_id, m.topic_id ORDER BY tp.name""",
            (attempt_id, ctx.tenant_id, a["job_role"]))
        rows = cur.fetchall()
    minimum = int(s["quiz_min_questions_per_topic"])
    topics, gaps = [], []
    for r in rows:
        scored = r["asked"] - r["ungraded"]
        score = None if r["asked"] < minimum or scored < r["asked"] else round(r["points"] / r["asked"], 3)
        topics.append({"topic_id": r["topic_id"], "name": r["name"], "score": score,
                       "note": None if score is not None else "not enough questions to score" if r["asked"] < minimum else "grading not finished",
                       "questions_asked": r["asked"], "questions_in_bank": r["bank"], "ai_graded": r["ai_graded"], "person_graded": r["person_graded"]})
        if r["released"] == 0:
            gaps.append({"topic_id": r["topic_id"], "name": r["name"], "gap": "no released verified knowledge"})
        elif r["bank"] == 0:
            gaps.append({"topic_id": r["topic_id"], "name": r["name"], "gap": "knowledge but no approved questions"})
        elif r["bank"] < minimum:
            gaps.append({"topic_id": r["topic_id"], "name": r["name"], "gap": "too few questions to score"})
    return {"attempt_id": a["id"], "learner_person_id": a["learner"], "job_role": a["job_role"], "status": a["status"],
            "started_at": a["started_at"].isoformat(), "submitted_at": a["submitted_at"].isoformat() if a["submitted_at"] else None,
            "graded_at": a["graded_at"].isoformat() if a["graded_at"] else None, "bank_size": a["bank_size"],
            "topics": topics, "coverage_gaps": gaps, "statement": REPORT_STATEMENT}
