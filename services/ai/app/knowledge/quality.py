"""Answer quality monitor (feature 22, docs/phase4/01).

Two things, neither of which calls a model:
  - what readers say about an answer they received (helpful / unhelpful / wrong, with an optional short comment
    that is redacted before it is stored); "wrong" opens a review task;
  - weekly counts from the answer log: how many questions, how they ended, how often the citation check removed
    something, how often the sources conflicted and who found it (the check of values in code, or the AI model),
    how many answers contained a source nobody has verified.

What it cannot tell: whether an answer was TRUE. It reports what was logged and what readers said.
Everything here is kept only as long as the answer log itself (the company's retention setting).

Who can read a reader's QUESTION: nobody, unless the reader ticks "share my question" with the feedback. The
(redacted) question is then shown with that feedback to the people who look after quality. Without the tick the
feedback shows the opinion, the comment and how the answer ended - not what was asked.
"""

from __future__ import annotations

from typing import Any

from app.capture import redact
from app.platform import Database, ServiceContext, housekeeping, one, write_audit

VERDICTS = ("helpful", "unhelpful", "wrong")
COMMENT_MAX = 500
MAX_WEEKS = 26
FEEDBACK_TASK_DAYS = 5

# One list of the weekly counters taken from the answer log: the SQL, the empty week and the API all follow it.
ANSWER_COUNTERS: dict[str, str] = {
    "questions": "count(*)",
    "answered": "count(*) FILTER (WHERE l.outcome = 'answered')",
    "search_only": "count(*) FILTER (WHERE l.outcome = 'search_only')",
    "dont_know": "count(*) FILTER (WHERE l.outcome = 'dont_know')",
    "dont_know_no_relevant_sources": "count(*) FILTER (WHERE l.outcome = 'dont_know' AND l.reason = 'no_relevant_sources')",
    "dont_know_not_grounded": "count(*) FILTER (WHERE l.outcome = 'dont_know' AND l.reason = 'not_grounded')",
    "dont_know_low_confidence": "count(*) FILTER (WHERE l.outcome = 'dont_know' AND l.reason = 'low_confidence')",
    "dont_know_sources_conflict": "count(*) FILTER (WHERE l.outcome = 'dont_know' AND l.reason = 'sources_conflict')",
    "conflicts_found_by_value_check": "count(*) FILTER (WHERE l.conflict_found_by = 'value_check')",
    "conflicts_found_by_ai_model": "count(*) FILTER (WHERE l.conflict_found_by = 'ai_model')",
    "citations_removed": "COALESCE(sum(l.claims_rejected), 0)",
    "answers_naming_an_unknown_source": "count(*) FILTER (WHERE l.fabricated_citation)",
    "answers_containing_unverified_sources": "count(*) FILTER (WHERE l.contains_unverified_sources)",
}
FEEDBACK_COUNTERS = tuple(f"feedback_{v}" for v in VERDICTS)

_FEEDBACK_COLUMNS = """f.id::text AS id, f.answer_log_id::text AS answer_id, f.verdict, f.comment_redacted AS comment, f.question_shared,
                       f.created_at, CASE WHEN f.question_shared THEN l.question_redacted END AS question, l.outcome, l.reason, l.confidence,
                       l.contains_unverified_sources"""


class QualityRefused(Exception):
    def __init__(self, code: str, status: int = 409) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


def _public(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    out["created_at"] = out["created_at"].isoformat()
    return out


def _own_answer(cur: Any, ctx: ServiceContext, answer_id: str) -> None:
    """Another card's answer, an unknown id and an answer already past retention all look the same: not found."""
    cur.execute("SELECT 1 FROM answer_logs WHERE tenant_id = %s AND id = %s AND card_id = %s", (ctx.tenant_id, answer_id, ctx.card_id))
    if cur.fetchone() is None:
        raise QualityRefused("not_found", 404)


def _read_own(cur: Any, ctx: ServiceContext, answer_id: str, *, lock: bool = False) -> dict[str, Any] | None:
    cur.execute(
        f"""SELECT {_FEEDBACK_COLUMNS} FROM answer_feedback f JOIN answer_logs l ON l.tenant_id = f.tenant_id AND l.id = f.answer_log_id
             WHERE f.tenant_id = %s AND f.answer_log_id = %s AND f.card_id = %s{" FOR UPDATE OF f" if lock else ""}""",
        (ctx.tenant_id, answer_id, ctx.card_id))
    row = cur.fetchone()
    return dict(row) if row else None


def _close_task(cur: Any, tenant_id: str, answer_id: str, resolution: str) -> None:
    cur.execute(
        """UPDATE review_tasks SET status = 'resolved', resolved_at = now(), resolution = %s, assigned_to_card_id = NULL,
                  first_response_at = COALESCE(first_response_at, now())
            WHERE tenant_id = %s AND kind = 'answer_feedback' AND subject_id = %s AND status IN ('open', 'assigned')""",
        (resolution, tenant_id, answer_id))


def put_feedback(db: Database, ctx: ServiceContext, answer_id: str, verdict: str, comment: str | None, share_question: bool) -> dict[str, Any]:
    """A card says what it thinks of an answer IT received. Saying it again REPLACES the earlier opinion as a whole:
    a comment that is left out is removed, and "share my question" is whatever this call says."""
    if verdict not in VERDICTS:
        raise QualityRefused("unknown_verdict", 422)
    cleaned = redact(comment.strip()).text[:COMMENT_MAX] if comment and comment.strip() else None
    with db.tenant_tx(ctx.tenant_id) as cur:
        _own_answer(cur, ctx, answer_id)
        before = _read_own(cur, ctx, answer_id, lock=True)
        cur.execute(
            """INSERT INTO answer_feedback (tenant_id, answer_log_id, card_id, verdict, comment_redacted, question_shared)
               VALUES (%s, %s, %s, %s, %s, %s)
               ON CONFLICT (tenant_id, answer_log_id, card_id)
               DO UPDATE SET verdict = EXCLUDED.verdict, comment_redacted = EXCLUDED.comment_redacted, question_shared = EXCLUDED.question_shared,
                             created_at = now()""", (ctx.tenant_id, answer_id, ctx.card_id, verdict, cleaned, bool(share_question)))
        was_wrong = before is not None and before["verdict"] == "wrong"
        if verdict == "wrong" and not was_wrong:
            # Only a CHANGE to "wrong" opens a task: saying "wrong" again does not reopen one a reviewer dismissed.
            cur.execute(
                """INSERT INTO review_tasks (tenant_id, kind, subject_type, subject_id, sensitivity, priority, due_at)
                   VALUES (%s, 'answer_feedback', 'answer', %s, 0, 5, now() + make_interval(days => %s)) ON CONFLICT DO NOTHING""",
                (ctx.tenant_id, answer_id, FEEDBACK_TASK_DAYS))
        elif was_wrong and verdict != "wrong":
            _close_task(cur, ctx.tenant_id, answer_id, "feedback_changed")
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="knowledge:feedback", reason_code=f"FEEDBACK_{verdict.upper()}",
                    resource_type="answer", resource_id=answer_id, request_id=ctx.request_id,
                    details={"verdict": verdict, "question_shared": bool(share_question)})
        return _public(one_of(_read_own(cur, ctx, answer_id)))


def one_of(row: dict[str, Any] | None) -> dict[str, Any]:
    if row is None:        # pragma: no cover - the row was written in the same transaction
        raise QualityRefused("not_found", 404)
    return row


def get_feedback(db: Database, ctx: ServiceContext, answer_id: str) -> dict[str, Any]:
    """The card's own opinion on its own answer; "not found" if it gave none (or the answer is not its own)."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        _own_answer(cur, ctx, answer_id)
        row = _read_own(cur, ctx, answer_id)
    if row is None:
        raise QualityRefused("not_found", 404)
    return _public(row)


def withdraw_feedback(db: Database, ctx: ServiceContext, answer_id: str) -> None:
    """The reader takes the opinion back: it is deleted, and the task a "wrong" had opened is closed."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        _own_answer(cur, ctx, answer_id)
        cur.execute("DELETE FROM answer_feedback WHERE tenant_id = %s AND answer_log_id = %s AND card_id = %s RETURNING verdict",
                    (ctx.tenant_id, answer_id, ctx.card_id))
        gone = cur.fetchone()
        if gone is None:
            raise QualityRefused("not_found", 404)
        if gone["verdict"] == "wrong":
            _close_task(cur, ctx.tenant_id, answer_id, "feedback_withdrawn")
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="knowledge:feedback", reason_code="FEEDBACK_WITHDRAWN",
                    resource_type="answer", resource_id=answer_id, request_id=ctx.request_id, details={"verdict": gone["verdict"]})


def close_tasks_of_expired_answers(cur: Any, tenant_id: str) -> None:
    """Housekeeping step: readers' feedback went with its answer (foreign key); a task about an answer that no
    longer exists is closed."""
    cur.execute(
        """UPDATE review_tasks t SET status = 'resolved', resolved_at = now(), resolution = 'answer_expired', assigned_to_card_id = NULL,
                  first_response_at = COALESCE(first_response_at, now())
            WHERE t.tenant_id = %s AND t.kind = 'answer_feedback' AND t.status IN ('open', 'assigned')
              AND NOT EXISTS (SELECT 1 FROM answer_logs l WHERE l.tenant_id = t.tenant_id AND l.id = t.subject_id)""", (tenant_id,))


def empty_week(week_start: str) -> dict[str, Any]:
    return {"week_start": week_start} | dict.fromkeys(ANSWER_COUNTERS, 0) | dict.fromkeys(FEEDBACK_COUNTERS, 0)


def summary(db: Database, ctx: ServiceContext, weeks: int) -> dict[str, Any]:
    """Counts per calendar week (Monday start, UTC), newest first, for at most MAX_WEEKS weeks. A week in which
    nothing was asked and nothing was said is left out. The current week is not over yet, so its counts are partial.
    Rows older than the company's retention setting are gone, so earlier weeks may be missing or incomplete."""
    weeks = max(1, min(int(weeks), MAX_WEEKS))
    since = "(date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => %s)) AT TIME ZONE 'UTC'"
    counters = ", ".join(f"({sql})::int AS {name}" for name, sql in ANSWER_COUNTERS.items())
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute(
            f"""SELECT date_trunc('week', l.created_at AT TIME ZONE 'UTC')::date AS week_start, {counters}
                  FROM answer_logs l WHERE l.tenant_id = %s AND l.created_at >= {since}
                 GROUP BY 1""", (ctx.tenant_id, weeks - 1))
        rows = {r["week_start"].isoformat(): dict(r) | {"week_start": r["week_start"].isoformat()} for r in cur.fetchall()}
        verdicts = ", ".join(f"count(*) FILTER (WHERE f.verdict = '{v}')::int AS feedback_{v}" for v in VERDICTS)
        cur.execute(
            f"""SELECT date_trunc('week', f.created_at AT TIME ZONE 'UTC')::date AS week_start, {verdicts}
                  FROM answer_feedback f WHERE f.tenant_id = %s AND f.created_at >= {since}
                 GROUP BY 1""", (ctx.tenant_id, weeks - 1))
        feedback = {r["week_start"].isoformat(): dict(r) for r in cur.fetchall()}
        cur.execute("SELECT answer_log_retention_days FROM knowledge_settings WHERE tenant_id = %s", (ctx.tenant_id,))
        settings = cur.fetchone()
        cur.execute(
            """SELECT count(*) FILTER (WHERE kind = 'item_conflict')::int AS item_conflicts,
                      count(*) FILTER (WHERE kind = 'stale_item')::int AS stale_items,
                      count(*) FILTER (WHERE kind = 'answer_feedback')::int AS answers_marked_wrong
                 FROM review_tasks WHERE tenant_id = %s AND status IN ('open', 'assigned')""", (ctx.tenant_id,))
        waiting = dict(one(cur))
    out = []
    for week in sorted(set(rows) | set(feedback), reverse=True):
        fb = feedback.get(week, {})
        out.append(empty_week(week) | rows.get(week, {}) | {k: int(fb.get(k, 0)) for k in FEEDBACK_COUNTERS})
    return {"weeks": out, "kept_for_days": int(settings["answer_log_retention_days"]) if settings else housekeeping.DEFAULT_ANSWER_LOG_RETENTION_DAYS,
            "waiting_for_review": waiting}


def list_feedback(db: Database, ctx: ServiceContext, *, verdict: str | None, limit: int, before: str | None) -> dict[str, Any]:
    """What readers said, newest first, for the people who look after quality. The question an answer was for is
    included only where its reader chose to share it."""
    limit = max(1, min(int(limit), 50))
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute(
            f"""SELECT {_FEEDBACK_COLUMNS}
                  FROM answer_feedback f JOIN answer_logs l ON l.tenant_id = f.tenant_id AND l.id = f.answer_log_id
                 WHERE f.tenant_id = %s AND (%s::text IS NULL OR f.verdict = %s) AND (%s::uuid IS NULL OR f.id < %s::uuid)
                 ORDER BY f.id DESC LIMIT %s""", (ctx.tenant_id, verdict, verdict, before, before, limit + 1))
        rows = [dict(r) for r in cur.fetchall()]
    page = [_public(r) for r in rows[:limit]]
    return {"items": page, "next_cursor": page[-1]["id"] if len(rows) > limit and page else None}
