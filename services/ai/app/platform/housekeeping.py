"""Housekeeping inside requests (docs/phase2/01): no scheduler, no worker service. Each call does
a small, bounded amount of work for ONE company and returns. Callers run it at the end of
ordinary requests. Every step is idempotent, so running it twice or concurrently is harmless.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

from app.platform.db import Database

BATCH = 50
# How long answer-log rows are kept when a company has no setting of its own. The one place this number is written.
DEFAULT_ANSWER_LOG_RETENTION_DAYS = 90

# Steps other modules add (wired by `app.knowledge.upkeep`): this module knows nothing about what they do.
AfterStale = Callable[[Any, str, list[str]], None]      # (cursor, company, ids of the items that just became stale)
AfterPrune = Callable[[Any, str], None]                 # (cursor, company), after old answer-log rows were deleted


def run(db: Database, tenant_id: str, *, after_stale: Sequence[AfterStale] = (), after_prune: Sequence[AfterPrune] = ()) -> dict[str, int]:
    done: dict[str, int] = {}
    with db.tenant_tx(tenant_id) as cur:
        # verified items past their date become stale; their search copy is marked; their questions retire
        cur.execute(
            """UPDATE knowledge_items SET status = 'stale'
                WHERE id IN (SELECT id FROM knowledge_items WHERE tenant_id = %s AND status IN ('verified', 'corrected')
                              AND stale_after <= now() LIMIT %s)
            RETURNING id""", (tenant_id, BATCH))
        stale = [r["id"] for r in cur.fetchall()]
        if stale:
            cur.execute("UPDATE chunks SET verification_status = 'stale' WHERE tenant_id = %s AND knowledge_item_id = ANY(%s)", (tenant_id, stale))
            cur.execute("UPDATE quiz_items SET status = 'retired' WHERE tenant_id = %s AND knowledge_item_id = ANY(%s) AND status <> 'retired'",
                        (tenant_id, stale))
            cur.execute(
                """INSERT INTO review_tasks (tenant_id, kind, subject_type, subject_id, department_id, sensitivity, owner_person_id, priority, due_at)
                   SELECT tenant_id, 'stale_item', 'knowledge_item', id, department_id, sensitivity, owner_person_id, usage_count, now() + interval '14 days'
                     FROM knowledge_items WHERE tenant_id = %s AND id = ANY(%s) ON CONFLICT DO NOTHING""", (tenant_id, stale))
            for step in after_stale:
                step(cur, tenant_id, [str(i) for i in stale])
        done["stale"] = len(stale)
        cur.execute("UPDATE expert_questions SET status = 'expired' WHERE id IN (SELECT id FROM expert_questions WHERE tenant_id = %s "
                    "AND status = 'open' AND expires_at <= now() LIMIT %s)", (tenant_id, BATCH))
        done["expert_questions_expired"] = cur.rowcount
        cur.execute("UPDATE quiz_attempts SET status = 'expired' WHERE id IN (SELECT id FROM quiz_attempts WHERE tenant_id = %s "
                    "AND status = 'in_progress' AND expires_at <= now() LIMIT %s)", (tenant_id, BATCH))
        done["attempts_expired"] = cur.rowcount
        settings = _settings(cur, tenant_id)
        cur.execute(
            """DELETE FROM citations WHERE tenant_id = %s AND subject_type = 'answer' AND subject_id IN (
                 SELECT id FROM answer_logs WHERE tenant_id = %s AND created_at < now() - make_interval(days => %s) LIMIT %s)""",
            (tenant_id, tenant_id, settings["answer_log_retention_days"], BATCH))
        cur.execute(
            """DELETE FROM answer_logs WHERE id IN (SELECT id FROM answer_logs WHERE tenant_id = %s
                  AND created_at < now() - make_interval(days => %s) LIMIT %s)""", (tenant_id, settings["answer_log_retention_days"], BATCH))
        done["answer_logs_pruned"] = cur.rowcount
        for prune_step in after_prune:
            prune_step(cur, tenant_id)
        # failed uploads leave nothing behind
        cur.execute("DELETE FROM chunks WHERE tenant_id = %s AND status = 'pending' AND source_id IN "
                    "(SELECT id FROM sources WHERE tenant_id = %s AND status = 'failed')", (tenant_id, tenant_id))
    return done


def _settings(cur: Any, tenant_id: str) -> dict[str, Any]:
    cur.execute("SELECT answer_log_retention_days FROM knowledge_settings WHERE tenant_id = %s", (tenant_id,))
    row = cur.fetchone()
    return dict(row) if row else {"answer_log_retention_days": DEFAULT_ANSWER_LOG_RETENTION_DAYS}
