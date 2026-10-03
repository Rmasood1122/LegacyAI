"""AI cost metering (docs/phase2/04 and 08): reservation before every attempt, a ledger row per
attempt, caps, the hourly limit, the kill switch, and provider failures. Fake provider only."""

from __future__ import annotations

from typing import Any

import psycopg
import pytest

from app.ai_gateway import DataBlock, FakeProvider, Gateway, GenerateRequest, ProviderError, load_prices, load_prompts
from app.ai_gateway.providers import timeout
from app.platform import Database, Logger
from tests.conftest import World, needs_db

pytestmark = [pytest.mark.db, needs_db]

BLOCKS = [DataBlock("QUESTION", "What is the start-up order?"), DataBlock("S1", "Open valve V2 fully before starting pump P-7.")]


def ledger(admin: psycopg.Connection[dict[str, Any]], tenant: str) -> list[str]:
    return [r["status"] for r in admin.execute("SELECT status FROM ai_usage_ledger WHERE tenant_id = %s ORDER BY created_at, attempt",
                                               (tenant,)).fetchall()]


def test_a_successful_call_is_reserved_then_settled(db: Database, world: World, gateway: Gateway,
                                                   admin: psycopg.Connection[dict[str, Any]]) -> None:
    out = gateway.generate(world.caller("learner"), "answer", "answer", BLOCKS)
    assert out.parsed is not None and out.cost_micro_usd > 0
    assert ledger(admin, world.tenant_id) == ["settled"]
    period = admin.execute("SELECT spent_micro_usd, reserved_micro_usd, calls FROM ai_budget_periods WHERE tenant_id = %s",
                           (world.tenant_id,)).fetchone()
    assert period["spent_micro_usd"] == out.cost_micro_usd and period["reserved_micro_usd"] == 0


def test_no_call_without_room_in_the_budget(db: Database, world: World, gateway: Gateway, provider: FakeProvider,
                                           admin: psycopg.Connection[dict[str, Any]]) -> None:
    out = gateway.generate(world.caller("learner", monthly_cap_micro_usd=1), "answer", "answer", BLOCKS)
    assert out.refused == "budget" and out.parsed is None and provider.calls == []
    assert ledger(admin, world.tenant_id) == ["refused_budget"]


def test_the_hourly_limit(db: Database, world: World, gateway: Gateway, admin: psycopg.Connection[dict[str, Any]]) -> None:
    caller = world.caller("learner", calls_per_hour=1)
    assert gateway.generate(caller, "answer", "answer", BLOCKS).parsed is not None
    assert gateway.generate(caller, "answer", "answer", BLOCKS).refused == "rate"


def test_too_much_input_is_refused_before_any_call(db: Database, world: World, gateway: Gateway, provider: FakeProvider) -> None:
    big = [DataBlock("S1", "word " * 20_000)]
    assert gateway.generate(world.caller("learner"), "answer", "answer", big).refused == "limits"
    assert provider.calls == []


def test_a_timeout_is_charged_in_full_and_retried_once(db: Database, world: World, gateway: Gateway, provider: FakeProvider,
                                                      admin: psycopg.Connection[dict[str, Any]]) -> None:
    calls = {"n": 0}

    def flaky(req: GenerateRequest) -> Any:
        calls["n"] += 1
        return timeout() if calls["n"] == 1 else provider._default(req)

    provider.script = flaky
    out = gateway.generate(world.caller("learner"), "answer", "answer", BLOCKS)
    assert out.parsed is not None and len(out.ledger_ids) == 2
    assert ledger(admin, world.tenant_id) == ["failed_charged", "settled"]


def test_bad_output_is_never_passed_on(db: Database, world: World, gateway: Gateway, provider: FakeProvider,
                                      admin: psycopg.Connection[dict[str, Any]]) -> None:
    provider.script = lambda req: '{"answerable": true, "answer": "x", "claims": [], "conflict": false, "extra": "smuggled"}'
    out = gateway.generate(world.caller("learner"), "answer", "answer", BLOCKS)
    assert out.failed and out.parsed is None
    assert ledger(admin, world.tenant_id) == ["failed_charged", "failed_charged"]   # at most one retry


def test_a_refusal_before_processing_costs_nothing(db: Database, world: World, gateway: Gateway, provider: FakeProvider,
                                                  admin: psycopg.Connection[dict[str, Any]]) -> None:
    provider.script = lambda req: ProviderError("overloaded", before_processing=True, retryable=False)
    out = gateway.generate(world.caller("learner"), "answer", "answer", BLOCKS)
    assert out.failed and out.cost_micro_usd == 0
    assert ledger(admin, world.tenant_id) == ["failed_free"]


def test_the_environment_kill_switch(db: Database, world: World, provider: FakeProvider) -> None:
    stopped = Gateway(db, provider, load_prompts(), load_prices(), Logger("error"), env_kill_switch=True)
    assert stopped.generate(world.caller("learner"), "answer", "answer", BLOCKS).refused == "kill_switch"
    assert provider.calls == []
