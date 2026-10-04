"""Activity numbers over time (feature 27, docs/phase4/03).

These are counts of what was DONE in the product (documents added, items captured and verified, interviews
finished, tests taken). They are not business outcomes and say nothing about money saved.

Every number goes through the caller's own right to read that kind of thing; the filters arrive in the token:
  * documents and items            -> `filter`                        (permission knowledge:read)
  * interviews                     -> `filters["interview:read"]`     (an interview has the level of what it captured)
  * tests handed in, test results  -> `filters["quiz:read_results"]`
A caller who does not hold a permission at all gets `null` for its numbers - never the company's total.

Test results per job role have three more rules, so that one person's result cannot be read off:
  * only for a caller who may read the results of the WHOLE company;
  * one fixed window - the last RESULT_WINDOW_MONTHS complete calendar months - whatever `months` was asked for,
    so two requests cannot be subtracted from each other;
  * a job role is shown only with at least MIN_GROUP different people in that window, and the mean is rounded to
    one decimal.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.capture import company_wide, condition, grants_something, named
from app.platform import Database, ServiceContext

MAX_MONTHS = 24
MIN_GROUP = 5                 # fewer different people than this in a group -> no numbers for the group
MAX_JOB_ROLES = 100
RESULT_WINDOW_MONTHS = 12     # complete calendar months before the current one

INTERVIEWS = "interview:read"
RESULTS = "quiz:read_results"

_THIS_MONTH = "date_trunc('month', now() AT TIME ZONE 'UTC')"
# the first instant of the month `%s` months before the current one (UTC)
_SINCE = f"(({_THIS_MONTH} - make_interval(months => %s)) AT TIME ZONE 'UTC')"


def _month_bucket(column: str) -> str:
    """The calendar month (UTC) a timestamp falls in, as a date: the SQL every per-month count groups by."""
    return f"date_trunc('month', {column} AT TIME ZONE 'UTC')::date"


def clamp_months(months: int) -> int:
    return max(1, min(int(months), MAX_MONTHS))


def job_role_row(row: dict[str, Any], minimum: int = MIN_GROUP) -> dict[str, Any]:
    """One job role of the results table. Pure, so the rule is tested without a database.

    state: "too_few_people" (no numbers at all), "no_graded_answers" (people and attempts, no mean), "shown".
    """
    if int(row["people"]) < minimum:
        return {"job_role": row["job_role"], "state": "too_few_people", "people": None, "attempts": None, "mean_score": None}
    mean = row.get("mean_score")
    shown = {"job_role": row["job_role"], "people": int(row["people"]), "attempts": int(row["attempts"])}
    if mean is None:
        return {**shown, "state": "no_graded_answers", "mean_score": None}
    return {**shown, "state": "shown", "mean_score": round(float(mean), 1)}


def job_role_rows(rows: list[dict[str, Any]], minimum: int = MIN_GROUP) -> list[dict[str, Any]]:
    return [job_role_row(r, minimum) for r in rows]


@dataclass(frozen=True)
class _Count:
    """One per-month count: its SQL (which must return `month_start` and the keys), its parameters, and the keys it fills."""

    keys: tuple[str, ...]
    sql: str
    params: tuple[Any, ...]


def _counts(ctx: ServiceContext, back: int, interviews: Any, results: Any) -> list[_Count]:
    item, item_params = condition(ctx.filter, "knowledge_items", ctx.tenant_id)
    source, source_params = condition(ctx.filter, "sources", ctx.tenant_id)
    counts = [
        _Count(("documents_added",),
               f"""SELECT {_month_bucket('s.created_at')} AS month_start, count(*)::int AS documents_added
                     FROM sources s WHERE {source} AND s.kind = 'document' AND s.status <> 'withdrawn' AND s.created_at >= {_SINCE}
                    GROUP BY 1""", (*source_params, back)),
        _Count(("items_captured",),
               f"""SELECT {_month_bucket('i.created_at')} AS month_start, count(*)::int AS items_captured
                     FROM knowledge_items i WHERE {item} AND i.status <> 'withdrawn' AND i.created_at >= {_SINCE}
                    GROUP BY 1""", (*item_params, back)),
        _Count(("items_verified", "median_hours_to_verify"),
               f"""SELECT {_month_bucket('i.verified_at')} AS month_start, count(*)::int AS items_verified,
                          round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (i.verified_at - i.created_at)) / 3600.0))::numeric, 1)::float8
                            AS median_hours_to_verify
                     FROM knowledge_items i
                    WHERE {item} AND i.status IN ('verified', 'corrected', 'stale') AND i.verified_at IS NOT NULL AND i.verified_at >= {_SINCE}
                    GROUP BY 1""", (*item_params, back)),
    ]
    if grants_something(interviews):
        where, params = condition(interviews, "interviews", ctx.tenant_id)
        counts.append(_Count(
            ("interviews_completed",),
            f"""SELECT {_month_bucket('v.completed_at')} AS month_start, count(*)::int AS interviews_completed
                  FROM interviews v WHERE {where} AND v.status = 'completed' AND v.completed_at >= {_SINCE}
                 GROUP BY 1""", (*params, back)))
    if grants_something(results):
        where, params = condition(results, "quiz_attempts", ctx.tenant_id)
        counts.append(_Count(
            ("tests_handed_in",),
            f"""SELECT {_month_bucket('qa.submitted_at')} AS month_start, count(*)::int AS tests_handed_in
                  FROM quiz_attempts qa WHERE {where} AND qa.submitted_at IS NOT NULL AND qa.submitted_at >= {_SINCE}
                 GROUP BY 1""", (*params, back)))
    return counts


def _blank_month(month_start: str, interviews_allowed: bool, results_allowed: bool) -> dict[str, Any]:
    """A month in which nothing happened: zeros - and `null` for what the caller may not read at all."""
    return {"month_start": month_start, "documents_added": 0, "items_captured": 0, "items_verified": 0, "median_hours_to_verify": None,
            "interviews_completed": 0 if interviews_allowed else None, "tests_handed_in": 0 if results_allowed else None}


def _job_role_results(cur: Any, ctx: ServiceContext, results: Any) -> dict[str, Any]:
    cur.execute(f"SELECT ({_THIS_MONTH} - make_interval(months => %s))::date AS window_start, {_THIS_MONTH}::date AS window_end",
                (RESULT_WINDOW_MONTHS,))
    window = cur.fetchone()
    table: dict[str, Any] = {
        "state": "not_allowed", "window_start": window["window_start"].isoformat(), "window_end": window["window_end"].isoformat(),
        "minimum_group": MIN_GROUP, "max_rows": MAX_JOB_ROLES, "truncated": False, "rows": [],
    }
    if not company_wide(results):
        return table      # results of the whole company are not this caller's to read: no table
    where, params = condition(results, "quiz_attempts", ctx.tenant_id)
    cur.execute(
        f"""SELECT qa.job_role, count(DISTINCT qa.learner_person_id)::int AS people, count(DISTINCT qa.id)::int AS attempts,
                   avg(q.final_score)::float8 AS mean_score
              FROM quiz_attempts qa
              LEFT JOIN quiz_answers q ON q.tenant_id = qa.tenant_id AND q.attempt_id = qa.id AND q.final_score IS NOT NULL
             WHERE {where} AND qa.status = 'graded'
               AND qa.graded_at >= ({_THIS_MONTH} - make_interval(months => %s)) AT TIME ZONE 'UTC'
               AND qa.graded_at < {_THIS_MONTH} AT TIME ZONE 'UTC'
             GROUP BY qa.job_role ORDER BY qa.job_role LIMIT %s""", (*params, RESULT_WINDOW_MONTHS, MAX_JOB_ROLES + 1))
    roles = [dict(r) for r in cur.fetchall()]
    return {**table, "state": "shown", "truncated": len(roles) > MAX_JOB_ROLES, "rows": job_role_rows(roles[:MAX_JOB_ROLES])}


def activity(db: Database, ctx: ServiceContext, months: int) -> dict[str, Any]:
    """Counts for each of the last `months` calendar months (UTC), newest first; the first one is the current, unfinished month."""
    back = clamp_months(months) - 1
    interviews = named(ctx.filters, INTERVIEWS)
    results = named(ctx.filters, RESULTS)
    item, item_params = condition(ctx.filter, "knowledge_items", ctx.tenant_id)
    with db.tenant_tx(ctx.tenant_id) as cur:
        # every month of the range is returned, also one in which nothing happened
        cur.execute(f"SELECT generate_series({_THIS_MONTH} - make_interval(months => %s), {_THIS_MONTH}, interval '1 month')::date AS month_start",
                    (back,))
        by_month = {r["month_start"].isoformat(): _blank_month(r["month_start"].isoformat(), grants_something(interviews), grants_something(results))
                    for r in cur.fetchall()}
        for count in _counts(ctx, back, interviews, results):
            cur.execute(count.sql, count.params)
            for r in cur.fetchall():
                entry = by_month.get(r["month_start"].isoformat())
                if entry is not None:
                    for k in count.keys:
                        entry[k] = r[k]
        cur.execute(
            f"""SELECT count(*) FILTER (WHERE i.status IN ('verified', 'corrected'))::int AS verified,
                       count(*) FILTER (WHERE i.status = 'stale')::int AS stale_items,
                       count(*) FILTER (WHERE i.status IN ('candidate', 'in_review'))::int AS not_yet_verified
                  FROM knowledge_items i WHERE {item}""", item_params)
        now_row = cur.fetchone()
        table = _job_role_results(cur, ctx, results)
    return {
        "months": [by_month[m] for m in sorted(by_month, reverse=True)],
        "items_now": {k: int(now_row[k]) if now_row else 0 for k in ("verified", "stale_items", "not_yet_verified")},
        "job_role_results": table,
    }
