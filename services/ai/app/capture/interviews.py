"""Text interviewer (feature 7; docs/phase2/05 §4).

invite -> accept (needs the expert's own_words consent; creates the interview's source) -> turns.
Each answer is redacted BEFORE it is stored, becomes a searchable (unverified) chunk and - if it
has substance - a candidate item with provenance. The next topic is chosen by the gap ranking
(code); the wording comes from the model, given ONLY the topic and the expert's own earlier
answers. Without AI, fixed templates are used. Limits: turns and a cost ceiling per session.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import psycopg
from pgvector import HalfVector

from app.ai_gateway import Caller, DataBlock, Embedder, Gateway, InterviewQuestionOutput
from app.capture.gaps import gap_report
from app.capture.redaction import redact
from app.platform import Database, ServiceContext, one, write_audit

FOLLOW_UPS_PER_TOPIC = 2
THIN_ANSWER_WORDS = 12
EARLIER_ANSWERS_IN_PROMPT = 4
TEMPLATES = (
    "Tell me how you handle {topic}. What do you do first?",
    "When does {topic} go wrong, and how do you notice it early?",
    "What would you tell a newcomer about {topic} that is not written down anywhere?",
)


class InterviewRefused(Exception):
    def __init__(self, code: str, status: int = 409) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class SavedAnswer:
    """Handed to the knowledge module (through the route layer) to make a candidate item, in the same transaction."""

    interview_id: str
    consent_id: str
    chunk_id: str
    text: str


# (cursor, saved answer) -> (candidate item id or None, AI cost of making it)
OnAnswer = Callable[[Any, SavedAnswer], tuple[str | None, int]]


@dataclass(frozen=True)
class TurnResult:
    interview_id: str
    status: str
    next_question: str | None
    turn_count: int
    candidate_item_id: str | None


def invite(db: Database, ctx: ServiceContext, expert_person_id: str, job_role: str) -> str:
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute("SELECT interview_max_turns FROM knowledge_settings WHERE tenant_id = %s", (ctx.tenant_id,))
        row = cur.fetchone()
        max_turns = int(row["interview_max_turns"]) if row else 30
        cur.execute(
            """INSERT INTO interviews (tenant_id, expert_person_id, job_role, max_turns, invited_by_card_id)
               VALUES (%s, %s, %s, %s, %s) RETURNING id::text AS id""",
            (ctx.tenant_id, expert_person_id, job_role, max_turns, ctx.card_id))
        interview_id = str(one(cur)["id"])
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="capture:interview_invited", reason_code="INTERVIEW_INVITED",
                    resource_type="interview", resource_id=interview_id, request_id=ctx.request_id, details={"interview_id": interview_id})
    return interview_id


def _interview(cur: psycopg.Cursor[Any], tenant_id: str, interview_id: str) -> dict[str, Any]:
    cur.execute("""SELECT id::text AS id, expert_person_id::text AS expert_person_id, source_id::text AS source_id, status, job_role,
                          turn_count, max_turns, cost_micro_usd, consent_id::text AS consent_id
                     FROM interviews WHERE tenant_id = %s AND id = %s FOR UPDATE""", (tenant_id, interview_id))
    row = cur.fetchone()
    if row is None:
        raise InterviewRefused("not_found", 404)
    return dict(row)


def accept(db: Database, ctx: ServiceContext, interview_id: str, gateway: Gateway | None, caller: Caller | None,
           item_spec: Any, topic_spec: Any) -> TurnResult:
    """The expert starts the interview. Needs their valid own_words consent (the database checks it too)."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        iv = _interview(cur, ctx.tenant_id, interview_id)
        if iv["expert_person_id"] != ctx.person_id:
            raise InterviewRefused("not_found", 404)
        if iv["status"] != "invited":
            raise InterviewRefused("illegal_transition")
        cur.execute("""SELECT id::text AS id FROM consents WHERE tenant_id = %s AND person_id = %s AND scope = 'own_words'
                         AND withdrawn_at IS NULL AND superseded_at IS NULL AND (expires_at IS NULL OR expires_at > now())""",
                    (ctx.tenant_id, ctx.person_id))
        consent = cur.fetchone()
        if consent is None:
            raise InterviewRefused("consent_missing", 422)
        cur.execute("SELECT department_id::text AS department_id FROM people WHERE tenant_id = %s AND id = %s", (ctx.tenant_id, ctx.person_id))
        dept = (cur.fetchone() or {}).get("department_id")
        cur.execute(
            """INSERT INTO sources (tenant_id, kind, title, department_id, sensitivity, owner_person_id, consent_id, uploaded_by_card_id, status)
               VALUES (%s, 'interview', %s, %s, 1, %s, %s, %s, 'ready') RETURNING id::text AS id""",
            (ctx.tenant_id, f"Interview: {iv['job_role']}"[:200], dept, ctx.person_id, consent["id"], ctx.card_id))
        source_id = one(cur)["id"]
        cur.execute("UPDATE interviews SET status = 'active', source_id = %s, consent_id = %s WHERE tenant_id = %s AND id = %s",
                    (source_id, consent["id"], ctx.tenant_id, interview_id))
        question, kind, topic_id = _next_question(cur, ctx, iv, gateway, caller, item_spec, topic_spec, follow_up=False, last_topic=None)
        cur.execute("""INSERT INTO interview_turns (tenant_id, interview_id, ordinal, topic_id, question_text, question_kind, prompt_version)
                       VALUES (%s, %s, 1, %s, %s, %s, %s)""",
                    (ctx.tenant_id, interview_id, topic_id, question, kind, "interview_question@v1" if kind != "template" else None))
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="capture:interview_started", reason_code="INTERVIEW_STARTED",
                    resource_type="interview", resource_id=interview_id, request_id=ctx.request_id, details={"interview_id": interview_id})
    return TurnResult(interview_id, "active", question, 0, None)


def _own_answers(cur: psycopg.Cursor[Any], tenant_id: str, interview_id: str) -> list[str]:
    cur.execute("""SELECT answer_text FROM interview_turns WHERE tenant_id = %s AND interview_id = %s AND answer_text IS NOT NULL
                     AND erased_at IS NULL ORDER BY ordinal DESC LIMIT %s""", (tenant_id, interview_id, EARLIER_ANSWERS_IN_PROMPT))
    return [r["answer_text"] for r in reversed(cur.fetchall())]


def _next_question(cur: psycopg.Cursor[Any], ctx: ServiceContext, iv: dict[str, Any], gateway: Gateway | None, caller: Caller | None,
                   item_spec: Any, topic_spec: Any, follow_up: bool, last_topic: str | None) -> tuple[str, str, str | None]:
    """Returns (question, kind, topic_id). Ranking is code; wording is the model's (or a template)."""
    topic_id: str | None
    if follow_up and last_topic is not None:
        topic_id = last_topic
    else:
        gaps = gap_report(cur, tenant_id=ctx.tenant_id, job_role=iv["job_role"], item_spec=item_spec, topic_spec=topic_spec)
        cur.execute("SELECT topic_id::text AS t, count(*)::int AS n FROM interview_turns WHERE tenant_id = %s AND interview_id = %s "
                    "AND topic_id IS NOT NULL GROUP BY topic_id", (ctx.tenant_id, iv["id"]))
        asked = {r["t"]: r["n"] for r in cur.fetchall()}
        ranked = sorted(gaps, key=lambda g: asked.get(g.topic_id, 0))  # stable: keeps the gap order among equally asked topics
        topic_id = ranked[0].topic_id if ranked else None
    topic_name, topic_desc = "your work", ""
    if topic_id is not None:
        cur.execute("SELECT name, description FROM topics WHERE tenant_id = %s AND id = %s", (ctx.tenant_id, topic_id))
        t = cur.fetchone()
        if t:
            topic_name, topic_desc = t["name"], t["description"]
    cur.execute("SELECT count(*)::int AS n FROM interview_turns WHERE tenant_id = %s AND interview_id = %s AND topic_id IS NOT DISTINCT FROM %s",
                (ctx.tenant_id, iv["id"], topic_id))
    asked_on_topic = int(one(cur)["n"])
    template = TEMPLATES[asked_on_topic % len(TEMPLATES)].format(topic=topic_name)
    within_ceiling = caller is not None and iv["cost_micro_usd"] < caller.monthly_cap_micro_usd and iv["cost_micro_usd"] < _session_ceiling(cur, ctx.tenant_id)
    if gateway is None or caller is None or not within_ceiling:
        return template, "template", topic_id
    blocks = [DataBlock("TOPIC", f"{topic_name}. {topic_desc}".strip())] + [
        DataBlock(f"EARLIER_ANSWER_{i + 1}", a) for i, a in enumerate(_own_answers(cur, ctx.tenant_id, iv["id"]))]
    outcome = gateway.generate(caller, "interview_question", "interview_question", blocks)
    iv["cost_micro_usd"] += outcome.cost_micro_usd
    cur.execute("UPDATE interviews SET cost_micro_usd = cost_micro_usd + %s WHERE tenant_id = %s AND id = %s",
                (outcome.cost_micro_usd, ctx.tenant_id, iv["id"]))
    if isinstance(outcome.parsed, InterviewQuestionOutput):
        return redact(outcome.parsed.question).text[:1000], "follow_up" if follow_up else "topic", topic_id
    return template, "template", topic_id


def _session_ceiling(cur: psycopg.Cursor[Any], tenant_id: str) -> int:
    cur.execute("SELECT interview_max_cost_micro_usd FROM knowledge_settings WHERE tenant_id = %s", (tenant_id,))
    row = cur.fetchone()
    return int(row["interview_max_cost_micro_usd"]) if row else 250_000


def answer_turn(db: Database, ctx: ServiceContext, interview_id: str, answer_text: str, embedder: Embedder,
                gateway: Gateway | None, caller: Caller | None, item_spec: Any, topic_spec: Any, on_answer: OnAnswer) -> TurnResult:
    with db.tenant_tx(ctx.tenant_id) as cur:
        iv = _interview(cur, ctx.tenant_id, interview_id)
        if iv["expert_person_id"] != ctx.person_id:
            raise InterviewRefused("not_found", 404)
        if iv["status"] != "active":
            raise InterviewRefused("not_active")
        # consent is re-checked at every turn (the trigger covers the start)
        cur.execute("SELECT consent_is_valid(%s, %s, 'own_words', now()) AS ok", (ctx.tenant_id, ctx.person_id))
        if not one(cur)["ok"]:
            raise InterviewRefused("consent_missing", 422)
        cur.execute("""SELECT id::text AS id, ordinal, topic_id::text AS topic_id, question_kind FROM interview_turns
                        WHERE tenant_id = %s AND interview_id = %s AND answer_text IS NULL ORDER BY ordinal DESC LIMIT 1 FOR UPDATE""",
                    (ctx.tenant_id, interview_id))
        turn = cur.fetchone()
        if turn is None:
            raise InterviewRefused("no_open_question")
        redacted = redact(answer_text)          # BEFORE anything is stored
        text = redacted.text[:4000] or "-"
        cur.execute("UPDATE interview_turns SET answer_text = %s, answered_at = now() WHERE tenant_id = %s AND id = %s",
                    (text, ctx.tenant_id, turn["id"]))
        cur.execute("SELECT department_id::text AS d, sensitivity FROM sources WHERE tenant_id = %s AND id = %s", (ctx.tenant_id, iv["source_id"]))
        src = one(cur)
        vector = embedder.embed([text], "document")[0]
        cur.execute(
            """INSERT INTO chunks (tenant_id, kind, source_id, ordinal, text, token_estimate, embedding, embedding_model, department_id,
                                   sensitivity, owner_person_id, redaction_count, low_confidence_redactions, status, interview_turn_id)
               VALUES (%s, 'source', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'active', %s) RETURNING id::text AS id""",
            (ctx.tenant_id, iv["source_id"], int(turn["ordinal"]), text[:2000], max(1, len(text) // 4), HalfVector(vector), embedder.model_id,
             src["d"], src["sensitivity"], ctx.person_id, len(redacted.findings), redacted.low_confidence_count > 0, turn["id"]))
        chunk_id = one(cur)["id"]

        item_id, cost = on_answer(cur, SavedAnswer(interview_id, iv["consent_id"], chunk_id, text))
        if cost:
            iv["cost_micro_usd"] += cost
            cur.execute("UPDATE interviews SET cost_micro_usd = cost_micro_usd + %s WHERE tenant_id = %s AND id = %s",
                        (cost, ctx.tenant_id, interview_id))
        cur.execute("UPDATE interviews SET turn_count = turn_count + 1, last_turn_at = now() WHERE tenant_id = %s AND id = %s RETURNING turn_count",
                    (ctx.tenant_id, interview_id))
        turn_count = int(one(cur)["turn_count"])
        if turn_count >= iv["max_turns"]:
            cur.execute("UPDATE interviews SET status = 'completed', completed_at = now() WHERE tenant_id = %s AND id = %s",
                        (ctx.tenant_id, interview_id))
            return TurnResult(interview_id, "completed", None, turn_count, item_id)
        cur.execute("SELECT count(*)::int AS n FROM interview_turns WHERE tenant_id = %s AND interview_id = %s AND topic_id IS NOT DISTINCT FROM %s "
                    "AND question_kind = 'follow_up'", (ctx.tenant_id, interview_id, turn["topic_id"]))
        follow_ups = int(one(cur)["n"])
        thin = len(text.split()) < THIN_ANSWER_WORDS or (not any(ch.isdigit() for ch in text) and len(text.split()) < 2 * THIN_ANSWER_WORDS)
        follow_up = thin and follow_ups < FOLLOW_UPS_PER_TOPIC and turn["topic_id"] is not None
        question, kind, topic_id = _next_question(cur, ctx, iv, gateway, caller, item_spec, topic_spec, follow_up, turn["topic_id"])
        if follow_up and kind == "template":
            kind = "follow_up"
        cur.execute("""INSERT INTO interview_turns (tenant_id, interview_id, ordinal, topic_id, question_text, question_kind, prompt_version)
                       VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                    (ctx.tenant_id, interview_id, int(turn["ordinal"]) + 1, topic_id, question, kind,
                     "interview_question@v1" if kind != "template" else None))
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="capture:interview_turn", reason_code="TURN_ANSWERED",
                    resource_type="interview", resource_id=interview_id, request_id=ctx.request_id,
                    details={"interview_id": interview_id, "count": turn_count, **({"item_id": item_id} if item_id else {})})
    return TurnResult(interview_id, "active", question, turn_count, item_id)


def set_status(db: Database, ctx: ServiceContext, interview_id: str, status: str, by_expert: bool) -> str:
    """pause / resume (the expert), complete (the expert or a manager)."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        iv = _interview(cur, ctx.tenant_id, interview_id)
        if by_expert and iv["expert_person_id"] != ctx.person_id:
            raise InterviewRefused("not_found", 404)
        try:
            cur.execute("UPDATE interviews SET status = %s, completed_at = CASE WHEN %s = 'completed' THEN now() ELSE completed_at END "
                        "WHERE tenant_id = %s AND id = %s", (status, status, ctx.tenant_id, interview_id))
        except psycopg.errors.CheckViolation as exc:
            raise InterviewRefused("illegal_transition") from exc
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action=f"capture:interview_{status}", reason_code="INTERVIEW_STATUS",
                    resource_type="interview", resource_id=interview_id, request_id=ctx.request_id, details={"interview_id": interview_id})
    return status


def read(db: Database, ctx: ServiceContext, interview_id: str) -> dict[str, Any]:
    """The interview with its turns (the API decided who may read it: the expert, or interview:read)."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute("""SELECT id::text AS id, expert_person_id::text AS expert_person_id, job_role, status, turn_count, max_turns,
                              created_at, last_turn_at, completed_at FROM interviews WHERE tenant_id = %s AND id = %s""",
                    (ctx.tenant_id, interview_id))
        iv = cur.fetchone()
        if iv is None:
            raise InterviewRefused("not_found", 404)
        out = dict(iv)
        for k in ("created_at", "last_turn_at", "completed_at"):
            out[k] = out[k].isoformat() if out[k] else None
        cur.execute("""SELECT ordinal, topic_id::text AS topic_id, question_text, question_kind, answer_text, answered_at, erased_at
                         FROM interview_turns WHERE tenant_id = %s AND interview_id = %s ORDER BY ordinal""", (ctx.tenant_id, interview_id))
        out["turns"] = [{"ordinal": t["ordinal"], "topic_id": t["topic_id"], "question": t["question_text"], "kind": t["question_kind"],
                         "answer": t["answer_text"], "answered_at": t["answered_at"].isoformat() if t["answered_at"] else None,
                         "erased": t["erased_at"] is not None} for t in cur.fetchall()]
    return out
