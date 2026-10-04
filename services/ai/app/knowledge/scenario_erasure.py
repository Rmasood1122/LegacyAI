"""Erasure for scenario replay, and retention of learners' answers (docs/phase4/04-scenario-replay.md).

Kept apart from scenarios.py so that items.py (which erases knowledge) can call it without a circular import.

A scenario quotes knowledge: its situation, a step's question and a step's expected points may repeat the words of the
items the step is tied to. When such an item is ERASED, those words go in the same transaction. The database trigger
only hides the scenario at withdrawal (retired, flagged "item_withdrawn"); it never blanks - under a legal hold
erasure is suspended (docs/phase2/05), and this function is simply not called until the hold is released.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import psycopg

PRUNE_BATCH = 2000      # answers emptied per table and pass


def erase_for_items(cur: psycopg.Cursor[Any], tenant_id: str, item_ids: Sequence[str]) -> int:
    """Blanks what scenarios hold about these (erased) items. Returns the number of scenarios touched.
    The scenario is already retired by the trigger; a scenario that is not (should not happen) is retired first,
    because the parts of an approved scenario cannot change."""
    ids = list(item_ids)
    if not ids:
        return 0
    cur.execute(
        """SELECT DISTINCT st.scenario_id::text AS id FROM scenario_step_items si
             JOIN scenario_steps st ON st.tenant_id = si.tenant_id AND st.id = si.step_id
            WHERE si.tenant_id = %s AND si.item_id = ANY(%s::uuid[])""", (tenant_id, ids))
    affected = [r["id"] for r in cur.fetchall()]
    if not affected:
        return 0
    cur.execute("""UPDATE scenarios SET status = 'retired', flag_reason = 'item_withdrawn', updated_at = now()
                    WHERE tenant_id = %s AND id = ANY(%s::uuid[]) AND status <> 'retired'""", (tenant_id, affected))
    cur.execute("UPDATE scenario_attempts SET status = 'expired' WHERE tenant_id = %s AND scenario_id = ANY(%s::uuid[]) AND status = 'in_progress'",
                (tenant_id, affected))
    cur.execute("""UPDATE scenarios SET situation = '', flag_reason = 'item_withdrawn', erased_at = now(), updated_at = now()
                    WHERE tenant_id = %s AND id = ANY(%s::uuid[])""", (tenant_id, affected))
    cur.execute(
        """UPDATE scenario_steps st SET prompt = '', rubric = '[]'::jsonb, erased_at = now()
            WHERE st.tenant_id = %s AND st.id IN (SELECT si.step_id FROM scenario_step_items si
                                                   WHERE si.tenant_id = %s AND si.item_id = ANY(%s::uuid[]))""", (tenant_id, tenant_id, ids))
    cur.execute("DELETE FROM scenario_step_items WHERE tenant_id = %s AND item_id = ANY(%s::uuid[])", (tenant_id, ids))
    return len(affected)


def prune_answers(cur: psycopg.Cursor[Any], tenant_id: str) -> None:
    """Retention (setting quiz_answer_retention_days): that many days after a run was GRADED (or expired unfinished)
    the words a learner wrote are removed - from scenario runs AND from readiness tests (the setting existed since
    Phase 2, but nothing applied it). The run, its scores and who decided them are kept; the free text and what the
    model said about it are not, and the row is marked (text_removed_at) so that a reader is told so.

    A step that still waits for a person is never emptied: the run is "submitted", not graded, and the clock starts
    when it is graded. Only rows that still hold something are selected, oldest first, so every pass makes progress."""
    cur.execute("SELECT quiz_answer_retention_days FROM knowledge_settings WHERE tenant_id = %s", (tenant_id,))
    row = cur.fetchone()
    days = int(row["quiz_answer_retention_days"]) if row else 365
    for answers, attempts in (("scenario_answers", "scenario_attempts"), ("quiz_answers", "quiz_attempts")):
        # table names are the two fixed pairs above, never input
        cur.execute(
            f"""UPDATE {answers} an SET answer_text = NULL, ai_rubric_result = NULL, text_removed_at = now()
                 WHERE an.tenant_id = %s
                   AND an.id IN (SELECT x.id FROM {answers} x JOIN {attempts} a ON a.tenant_id = x.tenant_id AND a.id = x.attempt_id
                                  WHERE x.tenant_id = %s AND (x.answer_text IS NOT NULL OR x.ai_rubric_result IS NOT NULL)
                                    AND ((a.status = 'graded' AND a.graded_at < now() - make_interval(days => %s))
                                      OR (a.status = 'expired' AND a.expires_at < now() - make_interval(days => %s)))
                                  ORDER BY x.id LIMIT {PRUNE_BATCH})""",
            (tenant_id, tenant_id, days, days))
