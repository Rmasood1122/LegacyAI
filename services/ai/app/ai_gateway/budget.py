"""Money. Every AI call reserves its worst case BEFORE it is made, in one conditional UPDATE per
level (company, then global), so two simultaneous calls cannot both squeeze under a cap. After
the call the reservation is settled with the actual cost. Amounts are whole micro-dollars.

What can still go over (docs/phase2/04): if the provider reports more input than our deliberately
high estimate, the actual amount is charged and an alarm is logged. A timeout is charged in full.
A reservation left behind by a dead request is charged in full on the company's next call.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import psycopg

STALE_AFTER = timedelta(minutes=5)
CALL_STATUSES = ("settled", "failed_charged", "failed_free", "expired_charged", "reserved")


def period_of(now: datetime) -> str:
    return now.astimezone(UTC).strftime("%Y-%m")


def cost_micro(tokens: int, price_micro_per_mtok: int) -> int:
    return math.ceil(tokens * price_micro_per_mtok / 1_000_000)


@dataclass(frozen=True)
class Prices:
    input_micro_per_mtok: int
    output_micro_per_mtok: int


def _roll_global_period(cur: psycopg.Cursor[Any], period: str) -> None:
    cur.execute(
        "UPDATE ai_global SET period = %s, spent_micro_usd = 0, reserved_micro_usd = 0, updated_at = now() WHERE period <> %s",
        (period, period))


def kill_switch_on(cur: psycopg.Cursor[Any]) -> bool:
    cur.execute("SELECT kill_switch FROM ai_global")
    row = cur.fetchone()
    return bool(row is None or row["kill_switch"])  # no row = fail closed


def expire_stale(cur: psycopg.Cursor[Any], tenant_id: str, now: datetime) -> int:
    """Charge, in full, reservations of this company that no request settled within 5 minutes."""
    cur.execute(
        """UPDATE ai_usage_ledger SET status = 'expired_charged', cost_micro_usd = reserved_micro_usd, settled_at = %s
            WHERE tenant_id = %s AND status = 'reserved' AND created_at < %s
            RETURNING reserved_micro_usd, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS period""",
        (now, tenant_id, now - STALE_AFTER))
    rows = cur.fetchall()
    for r in rows:
        amount = int(r["reserved_micro_usd"])
        cur.execute(
            """UPDATE ai_budget_periods SET reserved_micro_usd = greatest(reserved_micro_usd - %s, 0), spent_micro_usd = spent_micro_usd + %s
                WHERE tenant_id = %s AND period = %s""", (amount, amount, tenant_id, r["period"]))
        cur.execute(
            """UPDATE ai_global SET reserved_micro_usd = greatest(reserved_micro_usd - %s, 0), spent_micro_usd = spent_micro_usd + %s
                WHERE period = %s""", (amount, amount, r["period"]))
    return len(rows)


def calls_last_hour(cur: psycopg.Cursor[Any], tenant_id: str, now: datetime) -> int:
    cur.execute(
        "SELECT count(*)::int AS n FROM ai_usage_ledger WHERE tenant_id = %s AND created_at > %s AND status = ANY(%s)",
        (tenant_id, now - timedelta(hours=1), list(CALL_STATUSES)))
    row = cur.fetchone()
    return int(row["n"]) if row else 0


def reserve(cur: psycopg.Cursor[Any], tenant_id: str, amount: int, tenant_cap: int, now: datetime) -> str | None:
    """Reserve `amount` in the company's month and in the global month. Returns None on success,
    or 'budget' / 'global' naming the cap that had no room (nothing stays reserved then)."""
    period = period_of(now)
    cur.execute("INSERT INTO ai_budget_periods (tenant_id, period) VALUES (%s, %s) ON CONFLICT DO NOTHING", (tenant_id, period))
    cur.execute(
        """UPDATE ai_budget_periods SET reserved_micro_usd = reserved_micro_usd + %s, calls = calls + 1
            WHERE tenant_id = %s AND period = %s AND spent_micro_usd + reserved_micro_usd + %s <= %s RETURNING 1""",
        (amount, tenant_id, period, amount, tenant_cap))
    if cur.fetchone() is None:
        return "budget"
    _roll_global_period(cur, period)
    cur.execute(
        """UPDATE ai_global SET reserved_micro_usd = reserved_micro_usd + %s, updated_at = now()
            WHERE period = %s AND spent_micro_usd + reserved_micro_usd + %s <= monthly_cap_micro_usd RETURNING 1""",
        (amount, period, amount))
    if cur.fetchone() is None:
        cur.execute(
            """UPDATE ai_budget_periods SET reserved_micro_usd = reserved_micro_usd - %s, calls = calls - 1
                WHERE tenant_id = %s AND period = %s""", (amount, tenant_id, period))
        return "global"
    return None


def settle(cur: psycopg.Cursor[Any], tenant_id: str, reserved: int, charged: int, reserved_at: datetime) -> None:
    period = period_of(reserved_at)
    cur.execute(
        """UPDATE ai_budget_periods SET reserved_micro_usd = greatest(reserved_micro_usd - %s, 0), spent_micro_usd = spent_micro_usd + %s
            WHERE tenant_id = %s AND period = %s""", (reserved, charged, tenant_id, period))
    cur.execute(
        """UPDATE ai_global SET reserved_micro_usd = greatest(reserved_micro_usd - %s, 0), spent_micro_usd = spent_micro_usd + %s,
                                updated_at = now() WHERE period = %s""", (reserved, charged, period))
