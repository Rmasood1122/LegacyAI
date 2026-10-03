"""Ask-the-expert routing (feature 15; docs/phase2/06 §4). The answering part lives in answers.py
(answers restricted to the expert's verified items). Here: questions put to an expert, the
expert's reply - which becomes a candidate item and goes through verification like any other -
and declining.
"""

from __future__ import annotations

from typing import Any

import psycopg

from app.capture import redact
from app.knowledge.items import ItemRefused, _settings, create_item
from app.platform import Database, ServiceContext, one, write_audit

DECLINE_REASONS = ("not_my_area", "not_allowed_to_share", "unclear", "other")


def create_question(db: Database, ctx: ServiceContext, *, expert_person_id: str, question: str, department_id: str | None,
                    sensitivity: int) -> dict[str, Any]:
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute("SELECT consent_is_valid(%s, %s, 'named_expert', now()) AS ok", (ctx.tenant_id, expert_person_id))
        if not one(cur)["ok"]:
            raise ItemRefused("expert_not_available", 422)   # no consent to be named: cannot be selected
        cur.execute("SELECT expert_question_expiry_days, review_sla_days FROM knowledge_settings WHERE tenant_id = %s", (ctx.tenant_id,))
        row = cur.fetchone()
        expiry, sla = (int(row["expert_question_expiry_days"]), int(row["review_sla_days"])) if row else (30, 5)
        cur.execute(
            """INSERT INTO expert_questions (tenant_id, asked_by_card_id, expert_person_id, owner_person_id, question_redacted, department_id,
                                             sensitivity, expires_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, now() + make_interval(days => %s)) RETURNING id::text AS id, status, expires_at""",
            (ctx.tenant_id, ctx.card_id, expert_person_id, expert_person_id, redact(question).text[:1000] or "-", department_id,
             sensitivity, expiry))
        q = one(cur)
        cur.execute(
            """INSERT INTO review_tasks (tenant_id, kind, subject_type, subject_id, department_id, sensitivity, owner_person_id,
                                         visible_to_person_id, priority, due_at)
               VALUES (%s, 'expert_question', 'expert_question', %s, %s, %s, %s, %s, 100, now() + make_interval(days => %s))""",
            (ctx.tenant_id, q["id"], department_id, sensitivity, expert_person_id, expert_person_id, sla))
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="knowledge:expert_question", reason_code="QUESTION_ROUTED",
                    resource_type="expert_question", resource_id=q["id"], request_id=ctx.request_id)
    return q


def _question(cur: psycopg.Cursor[Any], tenant_id: str, question_id: str, expert_person_id: str | None) -> dict[str, Any]:
    cur.execute("""SELECT id::text AS id, status, expert_person_id::text AS expert_person_id, department_id::text AS department_id, sensitivity
                     FROM expert_questions WHERE tenant_id = %s AND id = %s FOR UPDATE""", (tenant_id, question_id))
    row = cur.fetchone()
    if row is None or (expert_person_id is not None and row["expert_person_id"] != expert_person_id):
        raise ItemRefused("not_found", 404)
    return dict(row)


def reply(db: Database, ctx: ServiceContext, question_id: str, answer: str, title: str) -> dict[str, Any]:
    """The expert's own words: a candidate item (origin expert_reply), needing their own_words consent.
    It is verified by someone else, like every item (second-reviewer rule)."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        q = _question(cur, ctx.tenant_id, question_id, ctx.person_id)
        if q["status"] != "open":
            raise ItemRefused("illegal_transition")
        cur.execute("""SELECT id::text AS id FROM consents WHERE tenant_id = %s AND person_id = %s AND scope = 'own_words'
                         AND withdrawn_at IS NULL AND superseded_at IS NULL AND (expires_at IS NULL OR expires_at > now())""",
                    (ctx.tenant_id, ctx.person_id))
        consent = cur.fetchone()
        if consent is None:
            raise ItemRefused("consent_missing", 422)
        item_id = create_item(
            cur, tenant_id=ctx.tenant_id, title=redact(title).text or "Reply", body=redact(answer).text, origin="expert_reply",
            ai_extracted=False, department_id=q["department_id"], sensitivity=int(q["sensitivity"]), owner_person_id=ctx.person_id,
            consent_id=consent["id"], created_by_card_id=ctx.card_id, author_card_id=ctx.card_id, author_person_id=ctx.person_id,
            change_kind="expert_reply", provenance=[], review_sla_days=int(_settings(cur, ctx.tenant_id)["review_sla_days"]))
        cur.execute("UPDATE knowledge_items SET status = 'in_review' WHERE tenant_id = %s AND id = %s", (ctx.tenant_id, item_id))
        cur.execute(
            """INSERT INTO review_tasks (tenant_id, kind, subject_type, subject_id, department_id, sensitivity, owner_person_id, priority, due_at)
               SELECT tenant_id, 'verify_item', 'knowledge_item', id, department_id, sensitivity, owner_person_id, 50, now() + interval '5 days'
                 FROM knowledge_items WHERE tenant_id = %s AND id = %s ON CONFLICT DO NOTHING""", (ctx.tenant_id, item_id))
        cur.execute("UPDATE expert_questions SET status = 'answered', answer_item_id = %s, answered_at = now() WHERE tenant_id = %s AND id = %s",
                    (item_id, ctx.tenant_id, question_id))
        cur.execute("""UPDATE review_tasks SET status = 'resolved', resolved_at = now(), resolved_by_card_id = %s, resolution = 'answered',
                              assigned_to_card_id = NULL WHERE tenant_id = %s AND subject_type = 'expert_question' AND subject_id = %s
                          AND status IN ('open', 'assigned')""", (ctx.card_id, ctx.tenant_id, question_id))
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="knowledge:expert_reply", reason_code="QUESTION_ANSWERED",
                    resource_type="expert_question", resource_id=question_id, request_id=ctx.request_id, details={"item_id": item_id})
    return {"id": question_id, "status": "answered", "answer_item_id": item_id}


def decline(db: Database, ctx: ServiceContext, question_id: str, reason: str) -> dict[str, Any]:
    if reason not in DECLINE_REASONS:
        raise ItemRefused("bad_reason", 400)
    with db.tenant_tx(ctx.tenant_id) as cur:
        q = _question(cur, ctx.tenant_id, question_id, ctx.person_id)
        if q["status"] != "open":
            raise ItemRefused("illegal_transition")
        cur.execute("UPDATE expert_questions SET status = 'declined', decline_reason = %s WHERE tenant_id = %s AND id = %s",
                    (reason, ctx.tenant_id, question_id))
        cur.execute("""UPDATE review_tasks SET status = 'resolved', resolved_at = now(), resolved_by_card_id = %s, resolution = 'declined',
                              assigned_to_card_id = NULL WHERE tenant_id = %s AND subject_type = 'expert_question' AND subject_id = %s
                          AND status IN ('open', 'assigned')""", (ctx.card_id, ctx.tenant_id, question_id))
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="knowledge:expert_decline", reason_code="QUESTION_DECLINED",
                    resource_type="expert_question", resource_id=question_id, request_id=ctx.request_id, details={"reason": reason})
    return {"id": question_id, "status": "declined"}
