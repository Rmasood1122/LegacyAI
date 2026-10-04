"""Scenario replay (feature 8; docs/phase4/04-scenario-replay.md).

A scenario is a situation ("what would you do if ...") with ordered steps. Each step is tied to verified, released
knowledge items and has expected points (a rubric). It is written by a reviewer, approved by a SECOND person, and
then offered to learners, who answer each step in free text. Answers are graded like open readiness questions: the
model says which points an answer meets, the score is computed in code (readiness.grade_by_rubric), a reviewer can
override. A learner never receives the expected points before handing in.

The API decides who may do what and passes, in the token, the ids it checked against the caller (`ctx.approved`):
item ids for writing, scenario ids for offering and starting, readable item ids for reading a result.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from app.ai_gateway import Caller, DataBlock, Gateway, QuizGenerateOutput
from app.capture import condition, redact
from app.knowledge.items import ItemRefused, review_settings
from app.knowledge.readiness import (
    LOW_GRADING_CONFIDENCE,
    close_grading_task,
    grade_by_rubric,
    needs_a_person,
    norm,
    open_grading_task,
    settings_full,
)
from app.platform import Database, ServiceContext, one, write_audit

MAX_STEPS = 10
MAX_ITEMS_PER_STEP = 5
MAX_POINTS = 6
MAX_POINT_CHARS = 300
PAGE = 50
MAX_RUNS_PER_DAY = 3      # per learner and scenario: each hand-in costs up to MAX_STEPS grading calls of the company's AI allowance
RELEASED_ITEM = "i.status IN ('verified', 'corrected') AND i.sensitivity = 0"
# A scenario is HIDDEN - nobody gets it from this service - while any of its linked items is withdrawn and the words
# that may quote it are still there (a legal hold, or the erasure step has not run). The database computes it from the
# links (scenario_is_hidden), so a scenario whose first item was erased is hidden again when a second one is withdrawn.
NOT_HIDDEN = "NOT scenario_is_hidden(sc.tenant_id, sc.id)"
# The only state in which a run shows results. Anything else - expired, waiting for a person, in progress, or a state
# this code does not know - shows the learner's own words and the status, nothing more.
GRADED = "graded"
# The states in which a person may still (re)grade a step.
GRADABLE = frozenset({"submitted", "graded"})


@dataclass(frozen=True)
class Step:
    prompt: str
    item_ids: tuple[str, ...]
    rubric: tuple[str, ...]


def leak_reason(title: str, situation: str, steps: Sequence[Step]) -> str | None:
    """The answer-leak guard for everything a learner is shown: no expected point may appear in the title, the
    situation or any step's prompt. Pure. Returns the reason for refusing, or None."""
    shown = norm(" ".join([title, situation, *[s.prompt for s in steps]]))
    for step in steps:
        points = [norm(p) for p in step.rubric]
        if not points or any(not p for p in points):
            return "malformed"
        if len(set(points)) != len(points):
            return "points_not_distinct"
        if any(p in shown for p in points):
            return "answer_in_prompt"
    return None


def clean_steps(raw: Sequence[dict[str, Any]], approved: Sequence[str]) -> list[Step]:
    """Shape checks, and every item must be one the API approved for this caller. Text is redacted like all free text."""
    if not 1 <= len(raw) <= MAX_STEPS:
        raise ItemRefused("bad_steps", 422)
    allowed = set(approved)
    steps: list[Step] = []
    for r in raw:
        items = tuple(dict.fromkeys(str(i).lower() for i in r.get("item_ids", [])))
        if not 1 <= len(items) <= MAX_ITEMS_PER_STEP or any(i not in allowed for i in items):
            raise ItemRefused("unknown_item", 422)
        rubric = tuple(redact(str(p)).text.strip()[:MAX_POINT_CHARS] for p in r.get("rubric", []))
        if not 1 <= len(rubric) <= MAX_POINTS:
            raise ItemRefused("malformed", 422)
        prompt = redact(str(r.get("prompt", ""))).text.strip()[:1000]
        if not prompt:
            raise ItemRefused("malformed", 422)
        steps.append(Step(prompt, items, rubric))
    return steps


def _released(cur: psycopg.Cursor[Any], tenant_id: str, item_ids: Sequence[str]) -> set[str]:
    cur.execute(f"SELECT i.id::text AS id FROM knowledge_items i WHERE i.tenant_id = %s AND i.id = ANY(%s::uuid[]) AND {RELEASED_ITEM}",
                (tenant_id, list(item_ids)))
    return {r["id"] for r in cur.fetchall()}


def _write_steps(cur: psycopg.Cursor[Any], tenant_id: str, scenario_id: str, steps: Sequence[Step]) -> None:
    for pos, step in enumerate(steps, start=1):
        cur.execute("INSERT INTO scenario_steps (tenant_id, scenario_id, position, prompt, rubric) VALUES (%s, %s, %s, %s, %s) RETURNING id::text AS id",
                    (tenant_id, scenario_id, pos, step.prompt, Jsonb(list(step.rubric))))
        step_id = one(cur)["id"]
        for item in step.item_ids:
            cur.execute("INSERT INTO scenario_step_items (tenant_id, step_id, item_id) VALUES (%s, %s, %s)", (tenant_id, step_id, item))


def _prepare(cur: psycopg.Cursor[Any], ctx: ServiceContext, title: str, situation: str, raw_steps: Sequence[dict[str, Any]]) -> tuple[str, str, list[Step]]:
    steps = clean_steps(raw_steps, ctx.approved)
    title = redact(title).text.strip()[:200]
    situation = redact(situation).text.strip()[:2000]
    if not title or not situation:
        raise ItemRefused("malformed", 422)
    reason = leak_reason(title, situation, steps)
    if reason is not None:
        raise ItemRefused(reason, 422)
    wanted = {i for s in steps for i in s.item_ids}
    if _released(cur, ctx.tenant_id, sorted(wanted)) != wanted:
        raise ItemRefused("item_not_released", 422)     # not verified, or not released to learners, any more
    return title, situation, steps


def create(db: Database, ctx: ServiceContext, title: str, situation: str, job_role: str, raw_steps: Sequence[dict[str, Any]]) -> dict[str, Any]:
    with db.tenant_tx(ctx.tenant_id) as cur:
        title, situation, steps = _prepare(cur, ctx, title, situation, raw_steps)
        cur.execute(
            """INSERT INTO scenarios (tenant_id, title, situation, job_role, owner_person_id, author_card_id, created_by_person_id, created_by_card_id)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id::text AS id""",
            (ctx.tenant_id, title, situation, job_role, ctx.person_id, ctx.card_id, ctx.person_id, ctx.card_id))
        scenario_id = one(cur)["id"]
        _write_steps(cur, ctx.tenant_id, scenario_id, steps)
        _take_labels(cur, ctx.tenant_id, scenario_id)
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="quiz:scenario_write", reason_code="SCENARIO_DRAFTED",
                    resource_type="scenario", resource_id=scenario_id, request_id=ctx.request_id, details={"count": len(steps)})
    return {"id": scenario_id, "status": "draft"}


def _take_labels(cur: psycopg.Cursor[Any], tenant_id: str, scenario_id: str) -> None:
    """A scenario carries the labels of its items: the highest level, and a department only if all items share it
    (the database trigger keeps this true when an item is re-labelled later)."""
    cur.execute(
        """UPDATE scenarios sc SET sensitivity = l.level, department_id = l.department
             FROM (SELECT COALESCE(max(i.sensitivity), 0)::smallint AS level,
                          CASE WHEN count(DISTINCT i.department_id) = 1 AND count(*) = count(i.department_id)
                               THEN (array_agg(i.department_id))[1] END AS department
                     FROM scenario_step_items si JOIN scenario_steps st ON st.tenant_id = si.tenant_id AND st.id = si.step_id
                     JOIN knowledge_items i ON i.tenant_id = si.tenant_id AND i.id = si.item_id
                    WHERE si.tenant_id = %s AND st.scenario_id = %s) l
            WHERE sc.tenant_id = %s AND sc.id = %s""", (tenant_id, scenario_id, tenant_id, scenario_id))


def _scenario(cur: psycopg.Cursor[Any], tenant_id: str, scenario_id: str, expected_updated_at: str | None = None) -> dict[str, Any]:
    cur.execute("""SELECT sc.id::text AS id, sc.status, sc.owner_person_id::text AS owner_person_id, sc.author_card_id::text AS author_card_id,
                          sc.created_by_person_id::text AS created_by_person_id, sc.created_by_card_id::text AS created_by_card_id,
                          sc.department_id::text AS department_id, sc.updated_at
                     FROM scenarios sc WHERE sc.tenant_id = %s AND sc.id = %s AND """ + NOT_HIDDEN + " FOR UPDATE", (tenant_id, scenario_id))
    row = cur.fetchone()
    if row is None:
        raise ItemRefused("not_found", 404)
    # the caller says which text it read; if somebody changed the scenario since, nothing is saved or approved
    if expected_updated_at is not None and row["updated_at"].isoformat() != expected_updated_at:
        raise ItemRefused("changed_meanwhile")
    return dict(row)


def update(db: Database, ctx: ServiceContext, scenario_id: str, title: str, situation: str, job_role: str,
           raw_steps: Sequence[dict[str, Any]], expected_updated_at: str | None = None) -> dict[str, Any]:
    """Replaces the text and the steps. The editor becomes the author (so cannot approve it), and an approved scenario
    goes back to draft. A scenario somebody has already run is not edited: its results must stay about the same steps."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        s = _scenario(cur, ctx.tenant_id, scenario_id, expected_updated_at)
        if s["status"] == "retired":
            raise ItemRefused("illegal_transition")
        cur.execute("SELECT 1 FROM scenario_attempts WHERE tenant_id = %s AND scenario_id = %s LIMIT 1", (ctx.tenant_id, scenario_id))
        if cur.fetchone() is not None:
            raise ItemRefused("has_attempts")
        title, situation, steps = _prepare(cur, ctx, title, situation, raw_steps)
        if s["status"] == "approved":
            cur.execute("UPDATE scenarios SET status = 'draft' WHERE tenant_id = %s AND id = %s", (ctx.tenant_id, scenario_id))
        cur.execute(
            """UPDATE scenarios SET title = %s, situation = %s, job_role = %s, owner_person_id = %s, author_card_id = %s, flag_reason = NULL,
                      updated_at = now() WHERE tenant_id = %s AND id = %s""",
            (title, situation, job_role, ctx.person_id, ctx.card_id, ctx.tenant_id, scenario_id))
        cur.execute("DELETE FROM scenario_steps WHERE tenant_id = %s AND scenario_id = %s", (ctx.tenant_id, scenario_id))   # the links go with them
        _write_steps(cur, ctx.tenant_id, scenario_id, steps)
        _take_labels(cur, ctx.tenant_id, scenario_id)
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="quiz:scenario_write", reason_code="SCENARIO_EDITED",
                    resource_type="scenario", resource_id=scenario_id, request_id=ctx.request_id, details={"count": len(steps)})
    return {"id": scenario_id, "status": "draft"}


def wrote_it(s: dict[str, Any], card_id: str, person_id: str | None) -> bool:
    """Did this card or person create the scenario or write its current text? Pure."""
    return card_id in (s["author_card_id"], s["created_by_card_id"]) or (
        person_id is not None and person_id in (s["owner_person_id"], s["created_by_person_id"]))


def set_status(db: Database, ctx: ServiceContext, scenario_id: str, status: str, expected_updated_at: str | None = None) -> dict[str, Any]:
    """approved: by someone who neither created the scenario nor last edited it, and only while every linked item is
    still verified and released. The rule is decided (and its refusal audited) by the API's policy; it is checked
    again here and by a database guard. retired: for good; attempts still running end."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        s = _scenario(cur, ctx.tenant_id, scenario_id, expected_updated_at if status == "approved" else None)
        if status == "approved":
            if wrote_it(s, ctx.card_id, ctx.person_id) and review_settings(cur, ctx.tenant_id)["second_reviewer_required"]:
                raise ItemRefused("second_person_needed")
            cur.execute(
                f"""SELECT count(*)::int AS links, count(*) FILTER (WHERE {RELEASED_ITEM})::int AS ok,
                           (SELECT count(*) FROM scenario_steps st WHERE st.tenant_id = %s AND st.scenario_id = %s)::int AS steps
                      FROM scenario_step_items si JOIN scenario_steps st ON st.tenant_id = si.tenant_id AND st.id = si.step_id
                      JOIN knowledge_items i ON i.tenant_id = si.tenant_id AND i.id = si.item_id
                     WHERE si.tenant_id = %s AND st.scenario_id = %s""",
                (ctx.tenant_id, scenario_id, ctx.tenant_id, scenario_id))
            links = one(cur)
            cur.execute("""SELECT count(*)::int AS bare FROM scenario_steps st WHERE st.tenant_id = %s AND st.scenario_id = %s
                              AND (st.erased_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM scenario_step_items si
                                                                          WHERE si.tenant_id = st.tenant_id AND si.step_id = st.id))""",
                        (ctx.tenant_id, scenario_id))
            if links["steps"] == 0 or links["ok"] != links["links"] or one(cur)["bare"] > 0:
                raise ItemRefused("item_not_released")
        try:
            cur.execute(
                """UPDATE scenarios SET status = %s, approved_by_card_id = CASE WHEN %s = 'approved' THEN %s ELSE approved_by_card_id END,
                          approved_by_person_id = CASE WHEN %s = 'approved' THEN %s::uuid ELSE approved_by_person_id END,
                          approved_at = CASE WHEN %s = 'approved' THEN now() ELSE approved_at END, updated_at = now()
                    WHERE tenant_id = %s AND id = %s""",
                (status, status, ctx.card_id, status, ctx.person_id, status, ctx.tenant_id, scenario_id))
        except psycopg.errors.CheckViolation as exc:
            raise ItemRefused("illegal_transition") from exc
        if status == "retired":
            cur.execute("UPDATE scenario_attempts SET status = 'expired' WHERE tenant_id = %s AND scenario_id = %s AND status = 'in_progress'",
                        (ctx.tenant_id, scenario_id))
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action=f"quiz:scenario_{status}", reason_code=f"SCENARIO_{status.upper()}",
                    resource_type="scenario", resource_id=scenario_id, request_id=ctx.request_id)
    return {"id": scenario_id, "status": status}


def _iso(row: dict[str, Any], *keys: str) -> dict[str, Any]:
    for k in keys:
        if row.get(k) is not None:
            row[k] = row[k].isoformat()
    return row


def list_scenarios(db: Database, ctx: ServiceContext, *, status: str | None, limit: int, after: str | None) -> dict[str, Any]:
    """For the people who write and approve them (the caller's quiz:read filter narrows it). No steps here."""
    where, params = condition(ctx.filter, "scenarios", ctx.tenant_id)
    extra, extra_params = "", list[Any]()
    if status is not None:
        extra += " AND sc.status = %s"
        extra_params.append(status)
    if after is not None:
        extra += " AND sc.id > %s"
        extra_params.append(after)
    limit = max(1, min(limit, PAGE))
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute(
            f"""SELECT sc.id::text AS id, sc.title, sc.job_role, sc.status, sc.flag_reason, sc.created_at, sc.updated_at, sc.approved_at,
                       (sc.author_card_id = %s OR sc.created_by_card_id = %s OR %s::uuid IN (sc.owner_person_id, sc.created_by_person_id)) AS written_by_me,
                       (SELECT count(*) FROM scenario_steps st WHERE st.tenant_id = sc.tenant_id AND st.scenario_id = sc.id)::int AS steps
                  FROM scenarios sc WHERE sc.tenant_id = %s AND {NOT_HIDDEN} AND {where}{extra} ORDER BY sc.id LIMIT %s""",
            [ctx.card_id, ctx.card_id, ctx.person_id, ctx.tenant_id, *params, *extra_params, limit + 1])
        rows = [_iso(dict(r), "created_at", "updated_at", "approved_at") for r in cur.fetchall()]
    more = len(rows) > limit
    rows = rows[:limit]
    return {"items": rows, "next_cursor": rows[-1]["id"] if more and rows else None}


def get_scenario(db: Database, ctx: ServiceContext, scenario_id: str) -> dict[str, Any]:
    """The whole scenario with expected points: for reviewers only (the route needs quiz:read; learners do not hold it)."""
    where, params = condition(ctx.filter, "scenarios", ctx.tenant_id)
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute(
            f"""SELECT sc.id::text AS id, sc.title, sc.situation, sc.job_role, sc.status, sc.flag_reason, sc.created_at, sc.updated_at, sc.approved_at,
                       (sc.author_card_id = %s OR sc.created_by_card_id = %s OR %s::uuid IN (sc.owner_person_id, sc.created_by_person_id)) AS written_by_me,
                       EXISTS (SELECT 1 FROM scenario_attempts a WHERE a.tenant_id = sc.tenant_id AND a.scenario_id = sc.id) AS has_attempts
                  FROM scenarios sc WHERE sc.tenant_id = %s AND sc.id = %s AND {NOT_HIDDEN} AND {where}""",
            [ctx.card_id, ctx.card_id, ctx.person_id, ctx.tenant_id, scenario_id, *params])
        row = cur.fetchone()
        if row is None:
            raise ItemRefused("not_found", 404)
        out = _iso(dict(row), "created_at", "updated_at", "approved_at")
        out["steps"] = review_steps(cur, ctx.tenant_id, scenario_id, ctx.approved)
    return out


def review_steps(cur: psycopg.Cursor[Any], tenant_id: str, scenario_id: str, readable_items: Sequence[str]) -> list[dict[str, Any]]:
    """The steps as a REVIEWER sees them: with expected points and linked items. Never used for a learner.
    An item the reader may not read is named by id and status only, without its title."""
    allowed = set(readable_items)
    cur.execute(
        """SELECT st.position, st.prompt, st.rubric, st.erased_at IS NOT NULL AS erased,
                  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', i.id::text, 'title', i.title, 'status', i.status) ORDER BY i.id)
                              FROM scenario_step_items si JOIN knowledge_items i ON i.tenant_id = si.tenant_id AND i.id = si.item_id
                             WHERE si.tenant_id = st.tenant_id AND si.step_id = st.id), '[]'::jsonb) AS items
             FROM scenario_steps st WHERE st.tenant_id = %s AND st.scenario_id = %s ORDER BY st.position""", (tenant_id, scenario_id))
    return [{"position": r["position"], "prompt": r["prompt"], "erased": r["erased"], "rubric": list(r["rubric"] or []),
             "items": [i if i["id"] in allowed else {"id": i["id"], "title": None, "status": i["status"]} for i in (r["items"] or [])]}
            for r in cur.fetchall()]


def learner_steps(cur: psycopg.Cursor[Any], tenant_id: str, scenario_id: str) -> list[dict[str, Any]]:
    """The ONE projection of a scenario's steps for a learner who has not handed in: the place and the question.
    The query does not even select the expected points or the linked items."""
    cur.execute("SELECT st.position, st.prompt FROM scenario_steps st WHERE st.tenant_id = %s AND st.scenario_id = %s ORDER BY st.position",
                (tenant_id, scenario_id))
    return [{"position": r["position"], "prompt": r["prompt"]} for r in cur.fetchall()]


def propose_rubric(db: Database, ctx: ServiceContext, gateway: Gateway, caller: Caller) -> dict[str, Any]:
    """Expected points proposed from the approved items (ctx.approved), for the reviewer to edit. Nothing is stored."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute(
            f"""SELECT v.body FROM knowledge_items i JOIN knowledge_versions v ON v.tenant_id = i.tenant_id AND v.id = i.current_version_id
                 WHERE i.tenant_id = %s AND i.id = ANY(%s::uuid[]) AND {RELEASED_ITEM} ORDER BY i.id LIMIT %s""",
            (ctx.tenant_id, list(ctx.approved), MAX_ITEMS_PER_STEP))
        bodies = [r["body"] for r in cur.fetchall()]
    if not bodies:
        raise ItemRefused("item_not_released", 422)
    points: list[str] = []
    for body in bodies:
        outcome = gateway.generate(caller, "quiz_generate", "quiz_generate", [DataBlock("KIND", "open"), DataBlock("ITEM", body)])
        parsed = outcome.parsed
        if isinstance(parsed, QuizGenerateOutput):
            points.extend(p.strip()[:MAX_POINT_CHARS] for p in parsed.rubric if p.strip())
    seen: dict[str, str] = {}
    for p in points:
        seen.setdefault(norm(p), p)
    if not seen:
        raise ItemRefused("ai_unavailable", 503)
    return {"rubric": list(seen.values())[:MAX_POINTS]}


def list_offered(db: Database, ctx: ServiceContext) -> dict[str, Any]:
    """What a learner may run: approved scenarios the API checked against THIS learner (ctx.approved). Never the points."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute(
            """SELECT sc.id::text AS id, sc.title, sc.situation, sc.job_role,
                      (SELECT count(*) FROM scenario_steps st WHERE st.tenant_id = sc.tenant_id AND st.scenario_id = sc.id)::int AS steps
                 FROM scenarios sc WHERE sc.tenant_id = %s AND sc.status = 'approved' AND sc.id = ANY(%s::uuid[])
                ORDER BY sc.job_role, sc.title""",
            (ctx.tenant_id, list(ctx.approved)))
        return {"items": [dict(r) for r in cur.fetchall()]}


def start_attempt(db: Database, ctx: ServiceContext, scenario_id: str) -> dict[str, Any]:
    if ctx.person_id is None:
        raise ItemRefused("no_person", 403)
    if scenario_id.lower() not in ctx.approved:
        raise ItemRefused("not_found", 404)
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute("SELECT status, title, situation FROM scenarios WHERE tenant_id = %s AND id = %s FOR SHARE", (ctx.tenant_id, scenario_id))
        sc = cur.fetchone()
        if sc is None or sc["status"] != "approved":
            raise ItemRefused("not_found", 404)
        cur.execute("""SELECT count(*)::int AS n FROM scenario_attempts WHERE tenant_id = %s AND scenario_id = %s AND learner_person_id = %s
                          AND started_at > now() - interval '1 day'""", (ctx.tenant_id, scenario_id, ctx.person_id))
        if one(cur)["n"] >= MAX_RUNS_PER_DAY:
            raise ItemRefused("too_many_runs", 429)
        minutes = int(settings_full(cur, ctx.tenant_id)["quiz_time_limit_minutes"])
        cur.execute(
            """INSERT INTO scenario_attempts (tenant_id, scenario_id, learner_card_id, learner_person_id, owner_person_id, expires_at)
               VALUES (%s, %s, %s, %s, %s, now() + make_interval(mins => %s)) RETURNING id::text AS id, expires_at""",
            (ctx.tenant_id, scenario_id, ctx.card_id, ctx.person_id, ctx.person_id, minutes))
        attempt = one(cur)
        cur.execute(
            """INSERT INTO scenario_answers (tenant_id, attempt_id, step_id, position)
               SELECT tenant_id, %s, id, position FROM scenario_steps WHERE tenant_id = %s AND scenario_id = %s""",
            (attempt["id"], ctx.tenant_id, scenario_id))
        steps = learner_steps(cur, ctx.tenant_id, scenario_id)
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="quiz:scenario_start", reason_code="SCENARIO_STARTED",
                    resource_type="scenario_attempt", resource_id=attempt["id"], request_id=ctx.request_id, details={"count": len(steps)})
    return {"id": attempt["id"], "scenario_id": scenario_id, "title": sc["title"], "situation": sc["situation"],
            "expires_at": attempt["expires_at"].isoformat(), "steps": steps}


def _own_attempt(cur: psycopg.Cursor[Any], ctx: ServiceContext, attempt_id: str) -> dict[str, Any]:
    cur.execute("""SELECT id::text AS id, status, expires_at, learner_person_id::text AS learner FROM scenario_attempts
                    WHERE tenant_id = %s AND id = %s FOR UPDATE""", (ctx.tenant_id, attempt_id))
    row = cur.fetchone()
    if row is None or row["learner"] != ctx.person_id:
        raise ItemRefused("not_found", 404)
    return dict(row)


def save_answer(db: Database, ctx: ServiceContext, attempt_id: str, position: int, text: str | None) -> None:
    with db.tenant_tx(ctx.tenant_id) as cur:
        a = _own_attempt(cur, ctx, attempt_id)
        cur.execute("SELECT now() > %s AS late", (a["expires_at"],))
        if a["status"] != "in_progress" or one(cur)["late"]:
            raise ItemRefused("attempt_closed")
        cur.execute("UPDATE scenario_answers SET answer_text = %s WHERE tenant_id = %s AND attempt_id = %s AND position = %s",
                    (redact(text).text[:4000] if text else None, ctx.tenant_id, attempt_id, position))
        if cur.rowcount == 0:
            raise ItemRefused("not_found", 404)


def submit_attempt(db: Database, ctx: ServiceContext, attempt_id: str, gateway: Gateway | None, caller: Caller | None) -> dict[str, Any]:
    """Once only. Each step is graded by its expected points; a step the model could not grade waits for a person."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        a = _own_attempt(cur, ctx, attempt_id)
        if a["status"] != "in_progress":
            raise ItemRefused("already_submitted")
        try:
            cur.execute("UPDATE scenario_attempts SET status = 'submitted', submitted_at = now() WHERE tenant_id = %s AND id = %s",
                        (ctx.tenant_id, attempt_id))
        except psycopg.errors.CheckViolation as exc:
            raise ItemRefused("attempt_closed") from exc
        cur.execute(
            """SELECT sa.id::text AS id, sa.answer_text, st.prompt, st.rubric, sc.department_id::text AS department_id,
                      sc.owner_person_id::text AS owner
                 FROM scenario_answers sa JOIN scenario_steps st ON st.tenant_id = sa.tenant_id AND st.id = sa.step_id
                 JOIN scenarios sc ON sc.tenant_id = st.tenant_id AND sc.id = st.scenario_id
                WHERE sa.tenant_id = %s AND sa.attempt_id = %s ORDER BY sa.position""", (ctx.tenant_id, attempt_id))
        answers = cur.fetchall()
        sla = int(review_settings(cur, ctx.tenant_id)["review_sla_days"])
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="quiz:scenario_submit", reason_code="SCENARIO_SUBMITTED",
                    resource_type="scenario_attempt", resource_id=attempt_id, request_id=ctx.request_id)
    for ans in answers:
        text = ans["answer_text"] or ""
        rubric = [str(p) for p in (ans["rubric"] or [])]
        grade = grade_by_rubric(gateway, caller, ans["prompt"], rubric, text) if rubric else None
        with db.tenant_tx(ctx.tenant_id) as cur:
            if not text.strip():
                cur.execute("UPDATE scenario_answers SET final_score = 0, decided_by = 'auto', graded_at = now() WHERE tenant_id = %s AND id = %s",
                            (ctx.tenant_id, ans["id"]))
            elif grade is not None:
                # as for readiness: the model's grade stands (its confidence is kept and shown); a reviewer can override it
                cur.execute(
                    """UPDATE scenario_answers SET ai_score = %s, ai_rubric_result = %s, ai_confidence = %s, final_score = %s, decided_by = 'ai',
                              graded_at = now() WHERE tenant_id = %s AND id = %s""",
                    (grade.score, Jsonb(grade.points), grade.confidence, grade.score, ctx.tenant_id, ans["id"]))
            # No usable grade (no AI allowed, refused, invalid) or a low-confidence one: a person is asked, through the
            # same kind of task as for a readiness answer, so the run cannot wait unseen.
            if text.strip() and needs_a_person(grade):
                open_grading_task(cur, ctx.tenant_id, "scenario_answer", ans["id"], ans["department_id"], ans["owner"], sla)
    return _maybe_graded(db, ctx.tenant_id, attempt_id)


def _maybe_graded(db: Database, tenant_id: str, attempt_id: str) -> dict[str, Any]:
    with db.tenant_tx(tenant_id) as cur:
        cur.execute("SELECT count(*) FILTER (WHERE final_score IS NULL)::int AS open FROM scenario_answers WHERE tenant_id = %s AND attempt_id = %s",
                    (tenant_id, attempt_id))
        if one(cur)["open"] == 0:
            cur.execute("UPDATE scenario_attempts SET status = 'graded', graded_at = now() WHERE tenant_id = %s AND id = %s AND status = 'submitted'",
                        (tenant_id, attempt_id))
        cur.execute("SELECT status FROM scenario_attempts WHERE tenant_id = %s AND id = %s", (tenant_id, attempt_id))
        return {"id": attempt_id, "status": one(cur)["status"]}


def _gradable(cur: psycopg.Cursor[Any], ctx: ServiceContext, answer_id: str, *, lock: bool) -> dict[str, Any]:
    """The one rule for reading a step in order to grade it AND for grading it (no blind grading): the run is handed
    in, it is not the caller's own, the scenario is not hidden, and the step either WAITS FOR A PERSON or belongs to
    a run the caller may read anyway (ctx.filter: the caller's quiz:read_results). Anything else looks like "no such
    answer". The level and department of the scenario were checked against the caller by the API's policy."""
    where, params = condition(ctx.filter, "scenario_attempts", ctx.tenant_id)
    for_update = " FOR UPDATE OF an" if lock else ""
    cur.execute(
        f"""SELECT an.id::text AS id, an.attempt_id::text AS attempt_id, an.position, an.answer_text, an.final_score, an.decided_by, an.ai_score,
                   an.ai_confidence, an.ai_rubric_result, an.text_removed_at, st.prompt, st.rubric, sc.title, sa.status,
                   sa.learner_person_id::text AS learner, sa.learner_card_id::text AS learner_card,
                   (an.final_score IS NULL AND sa.status = 'submitted') AS awaiting, ({where}) AS readable
              FROM scenario_answers an JOIN scenario_attempts sa ON sa.tenant_id = an.tenant_id AND sa.id = an.attempt_id
              JOIN scenario_steps st ON st.tenant_id = an.tenant_id AND st.id = an.step_id
              JOIN scenarios sc ON sc.tenant_id = sa.tenant_id AND sc.id = sa.scenario_id
             WHERE an.tenant_id = %s AND an.id = %s AND {NOT_HIDDEN}{for_update}""",
        [*params, ctx.tenant_id, answer_id])
    row = cur.fetchone()
    if row is None or row["status"] not in GRADABLE:
        raise ItemRefused("not_found", 404)
    if row["learner_card"] == ctx.card_id or (ctx.person_id is not None and row["learner"] == ctx.person_id):
        raise ItemRefused("own_attempt")
    if not (row["awaiting"] or row["readable"]):
        raise ItemRefused("not_found", 404)
    return dict(row)


def answer_for_grading(db: Database, ctx: ServiceContext, answer_id: str) -> dict[str, Any]:
    """What a person needs to grade ONE step: the question, the learner's words, the expected points and what the
    model made of it. For graders (quiz:grade); never for the learner whose run it is."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        r = _gradable(cur, ctx, answer_id, lock=False)
    removed = r["text_removed_at"] is not None
    known = r["ai_rubric_result"] is not None and not removed
    met = {p.get("point") for p in (r["ai_rubric_result"] or []) if p.get("met")}
    return {
        "id": r["id"], "attempt_id": r["attempt_id"], "scenario_title": r["title"], "position": r["position"], "prompt": r["prompt"],
        "answer_text": r["answer_text"], "awaiting_person": bool(r["awaiting"]), "details_removed": removed,
        "final_score": r["final_score"], "decided_by": r["decided_by"], "ai_score": r["ai_score"], "ai_confidence": r["ai_confidence"],
        "points": [{"text": text, "met": (i in met) if known else None} for i, text in enumerate(r["rubric"] or [])],
    }


def override(db: Database, ctx: ServiceContext, answer_id: str, score: float) -> dict[str, Any]:
    """A reviewer sets the score of one step. Not for one's own attempt, and only for a step the reviewer could have
    read through answer_for_grading() - the same rule, so nobody grades blind."""
    if not 0 <= score <= 1:
        raise ItemRefused("bad_score", 400)
    with db.tenant_tx(ctx.tenant_id) as cur:
        row = _gradable(cur, ctx, answer_id, lock=True)
        cur.execute("""UPDATE scenario_answers SET final_score = %s, decided_by = 'reviewer', overridden_by_card_id = %s, graded_at = now()
                        WHERE tenant_id = %s AND id = %s""", (score, ctx.card_id, ctx.tenant_id, answer_id))
        close_grading_task(cur, ctx.tenant_id, "scenario_answer", answer_id, ctx.card_id)
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="quiz:scenario_override", reason_code="SCENARIO_GRADE_OVERRIDDEN",
                    resource_type="scenario_answer", resource_id=answer_id, request_id=ctx.request_id)
    return _maybe_graded(db, ctx.tenant_id, row["attempt_id"])


def released(status: str, *, is_learner: bool, show_points: bool) -> tuple[bool, bool]:
    """(scores, points): what a reader of a run may see. Pure.

    Scores: only once the run is GRADED. Expected points, which of them were met and "read these": only when graded
    and, for the learner, only if the company shows answers after grading - exactly as for a readiness test.
    A run that expired, still waits for a person, is in progress or is in a state this code does not know shows the
    reader the learner's own words and the status, nothing more: letting a run expire teaches nothing. Somebody who
    has to grade a waiting step reads that one step through answer_for_grading(), not through the run."""
    graded = status == GRADED
    return graded, graded and (not is_learner or show_points)


def visible_steps(status: str, *, is_learner: bool, show_points: bool, rows: Sequence[dict[str, Any]],
                  readable_items: Sequence[str]) -> list[dict[str, Any]]:
    """What one reader gets of a run's steps (see released()). Pure, so the rule is tested without a database.
    "Read these": only items the READER may read. Where the retention sweep removed the learner's words and what the
    model said about them, the step says so (`details_removed`) instead of showing every point as not met."""
    allowed = set(readable_items)
    scores, points = released(status, is_learner=is_learner, show_points=show_points)
    out = []
    for r in rows:
        removed = r.get("text_removed_at") is not None
        step: dict[str, Any] = {"answer_id": r["answer_id"], "position": r["position"], "prompt": r["prompt"], "answer_text": r["answer_text"],
                                "details_removed": removed}
        if scores:
            low = r.get("ai_confidence") is not None and r["ai_confidence"] < LOW_GRADING_CONFIDENCE
            step["final_score"] = r["final_score"]
            step["decided_by"] = r["decided_by"]
            step["graded_with_low_confidence"] = bool(low and r["decided_by"] == "ai")
        if points:
            # "met" is what the CODE counted (the evidence is really in the answer), as stored by grade_by_rubric;
            # unknown (None) when a person decided the score or when the details were removed by retention
            met = {p.get("point") for p in (r["ai_rubric_result"] or []) if p.get("met")}
            known = r["decided_by"] == "ai" and not removed
            step["points"] = [{"text": text, "met": (i in met) if known else None} for i, text in enumerate(r["rubric"] or [])]
            step["read_these"] = [i for i in (r["items"] or []) if i["id"] in allowed]
        out.append(step)
    return out


def get_attempt(db: Database, ctx: ServiceContext, attempt_id: str) -> dict[str, Any]:
    """The learner (own attempt) or someone who may read results. ctx.approved: linked items this reader may read.
    The answer says in so many words what was released (`scores_released`, `points_released`): the API forwards
    scores and points only when these are true AND the run is graded, whatever else this answer may contain."""
    where, params = condition(ctx.filter, "scenario_attempts", ctx.tenant_id)
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute(
            f"""SELECT sa.id::text AS id, sa.scenario_id::text AS scenario_id, sa.learner_person_id::text AS learner_person_id, sa.status, sa.started_at,
                       sa.expires_at, sa.submitted_at, sa.graded_at, sc.title, sc.situation, sc.job_role
                  FROM scenario_attempts sa JOIN scenarios sc ON sc.tenant_id = sa.tenant_id AND sc.id = sa.scenario_id
                 WHERE sa.tenant_id = %s AND sa.id = %s AND {NOT_HIDDEN} AND {where}""",
            [ctx.tenant_id, attempt_id, *params])
        row = cur.fetchone()
        if row is None:
            raise ItemRefused("not_found", 404)
        a = _iso(dict(row), "started_at", "expires_at", "submitted_at", "graded_at")
        show = bool(settings_full(cur, ctx.tenant_id).get("quiz_show_answers_after_grading", False))
        cur.execute(
            """SELECT an.id::text AS answer_id, an.position, st.prompt, st.rubric, an.answer_text, an.final_score, an.decided_by,
                      an.ai_rubric_result, an.ai_confidence, an.text_removed_at,
                      COALESCE((SELECT jsonb_agg(jsonb_build_object('id', i.id::text, 'title', i.title) ORDER BY i.id)
                                  FROM scenario_step_items si JOIN knowledge_items i ON i.tenant_id = si.tenant_id AND i.id = si.item_id
                                 WHERE si.tenant_id = an.tenant_id AND si.step_id = an.step_id AND i.status <> 'withdrawn'), '[]'::jsonb) AS items
                 FROM scenario_answers an JOIN scenario_steps st ON st.tenant_id = an.tenant_id AND st.id = an.step_id
                WHERE an.tenant_id = %s AND an.attempt_id = %s ORDER BY an.position""", (ctx.tenant_id, attempt_id))
        rows = [dict(r) for r in cur.fetchall()]
    is_learner = ctx.person_id is not None and a["learner_person_id"] == ctx.person_id
    a["scores_released"], a["points_released"] = released(a["status"], is_learner=is_learner, show_points=show)
    a["steps"] = visible_steps(a["status"], is_learner=is_learner, show_points=show, rows=rows, readable_items=ctx.approved)
    return a


def list_attempts(db: Database, ctx: ServiceContext, *, limit: int, before: str | None) -> dict[str, Any]:
    """Scenario runs, newest first: a learner's own, or the company's for those who may read results. Labels only."""
    where, params = condition(ctx.filter, "scenario_attempts", ctx.tenant_id)
    extra, extra_params = "", list[Any]()
    if before is not None:
        extra += " AND sa.id < %s"
        extra_params.append(before)
    limit = max(1, min(limit, PAGE))
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute(
            f"""SELECT sa.id::text AS id, sa.scenario_id::text AS scenario_id, sc.title, sc.job_role, sa.learner_person_id::text AS learner_person_id,
                       sa.status, sa.started_at, sa.submitted_at, sa.graded_at
                  FROM scenario_attempts sa JOIN scenarios sc ON sc.tenant_id = sa.tenant_id AND sc.id = sa.scenario_id
                 WHERE sa.tenant_id = %s AND {NOT_HIDDEN} AND {where}{extra} ORDER BY sa.id DESC LIMIT %s""",
            [ctx.tenant_id, *params, *extra_params, limit + 1])
        rows = [_iso(dict(r), "started_at", "submitted_at", "graded_at") for r in cur.fetchall()]
    more = len(rows) > limit
    rows = rows[:limit]
    return {"items": rows, "next_cursor": rows[-1]["id"] if more and rows else None}


def expire_attempts(cur: psycopg.Cursor[Any], tenant_id: str) -> None:
    """Housekeeping step: a scenario run past its time limit is closed, like a readiness test."""
    cur.execute("""UPDATE scenario_attempts SET status = 'expired' WHERE id IN (SELECT id FROM scenario_attempts WHERE tenant_id = %s
                      AND status = 'in_progress' AND expires_at <= now() LIMIT 500)""", (tenant_id,))
