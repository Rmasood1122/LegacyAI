"""Consent withdrawal, step 2: erasure of capture data (docs/phase2/05 §1).

Step 1 (hiding) already happened in the database, in the transaction that recorded the
withdrawal (migration 15). This step deletes chunks and redaction findings and blanks titles and
interview text. Items are erased by the knowledge module (knowledge.items.erase_withdrawn_items).
A legal hold suspends erasure; the material stays hidden.
"""

from __future__ import annotations

from typing import Any

import psycopg

from app.platform import Database, write_audit


def items_citing_withdrawn(cur: psycopg.Cursor[Any], tenant_id: str, consent_id: str) -> list[str]:
    """Items that are NOT withdrawn but cite passages of withdrawn sources (mixed provenance)."""
    cur.execute(
        """SELECT DISTINCT i.id::text AS id
             FROM sources s
             JOIN chunks c ON c.tenant_id = s.tenant_id AND c.source_id = s.id
             JOIN citations ci ON ci.tenant_id = c.tenant_id AND ci.chunk_id = c.id AND ci.subject_type = 'knowledge_version'
             JOIN knowledge_versions v ON v.tenant_id = ci.tenant_id AND v.id = ci.subject_id
             JOIN knowledge_items i ON i.tenant_id = v.tenant_id AND i.id = v.item_id
            WHERE s.tenant_id = %s AND s.consent_id = %s AND s.status = 'withdrawn' AND i.status <> 'withdrawn'""",
        (tenant_id, consent_id))
    return [r["id"] for r in cur.fetchall()]


def erase_sources(cur: psycopg.Cursor[Any], tenant_id: str, consent_id: str) -> int:
    cur.execute("SELECT id::text AS id FROM sources WHERE tenant_id = %s AND consent_id = %s AND status = 'withdrawn'", (tenant_id, consent_id))
    source_ids = [r["id"] for r in cur.fetchall()]
    if not source_ids:
        return 0
    cur.execute("DELETE FROM redaction_findings WHERE tenant_id = %s AND source_id = ANY(%s::uuid[])", (tenant_id, source_ids))
    cur.execute("DELETE FROM chunks WHERE tenant_id = %s AND source_id = ANY(%s::uuid[])", (tenant_id, source_ids))   # citations cascade
    cur.execute("UPDATE sources SET title = '' WHERE tenant_id = %s AND id = ANY(%s::uuid[])", (tenant_id, source_ids))
    cur.execute(
        """UPDATE interview_turns t SET question_text = '', answer_text = CASE WHEN t.answer_text IS NULL THEN NULL ELSE '' END, erased_at = now()
             FROM interviews iv
            WHERE iv.tenant_id = t.tenant_id AND iv.id = t.interview_id AND iv.tenant_id = %s AND iv.source_id = ANY(%s::uuid[])
              AND t.erased_at IS NULL""", (tenant_id, source_ids))
    # an active interview is paused first: the legal moves are active -> paused -> abandoned
    cur.execute("UPDATE interviews SET status = 'paused' WHERE tenant_id = %s AND source_id = ANY(%s::uuid[]) AND status = 'active'",
                (tenant_id, source_ids))
    cur.execute("UPDATE interviews SET status = 'abandoned' WHERE tenant_id = %s AND source_id = ANY(%s::uuid[]) "
                "AND status IN ('paused', 'stopped_budget')", (tenant_id, source_ids))
    # topics only ever SUGGESTED from these documents go; accepted topics are the company's list
    cur.execute("DELETE FROM topics WHERE tenant_id = %s AND status = 'proposed' AND extracted_from_source_id = ANY(%s::uuid[])",
                (tenant_id, source_ids))
    return len(source_ids)


def consent_state(cur: psycopg.Cursor[Any], tenant_id: str, consent_id: str) -> dict[str, Any] | None:
    cur.execute("SELECT id::text AS id, person_id::text AS person_id, withdrawal_status, legal_hold FROM consents WHERE tenant_id = %s AND id = %s",
                (tenant_id, consent_id))
    row = cur.fetchone()
    return dict(row) if row else None


def finish(db: Database, tenant_id: str, card_id: str | None, request_id: str | None, consent_id: str, sources: int, items: int) -> None:
    with db.tenant_tx(tenant_id) as cur:
        cur.execute("UPDATE consents SET withdrawal_status = 'completed' WHERE tenant_id = %s AND id = %s AND withdrawal_status = 'hidden'",
                    (tenant_id, consent_id))
        write_audit(cur, tenant_id=tenant_id, card_id=card_id, action="capture:withdrawal_erased", reason_code="WITHDRAWAL_ERASED",
                    resource_type="consent", resource_id=consent_id, request_id=request_id,
                    details={"consent_id": consent_id, "count": sources, "rows": items})
