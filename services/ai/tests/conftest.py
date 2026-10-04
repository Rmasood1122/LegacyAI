"""Shared test fixtures. All data is synthetic. No test ever talks to a real AI provider:
the settings below use ENVIRONMENT=test, which refuses any provider but the fake one.

Database tests (marker `db`) run against the CI PostgreSQL: they seed through the superuser
connection (row-level security does not apply to it) and exercise the code through the
restricted `legacyai_ai` login, exactly like the running service. They are skipped when the
connection strings are not set (for example on a laptop without the database).
"""

from __future__ import annotations

import os
import secrets
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
import psycopg
import pytest
from psycopg.rows import dict_row

from app.ai_gateway import Caller, FakeEmbedder, FakeProvider, Gateway, load_prices, load_prompts
from app.platform import Database, Logger, ServiceContext, Settings, load_settings

TEST_KEY = "test-only-service-token-key-0123456789abcdef"   # synthetic; matches nothing real
AI_URL = os.environ.get("DATABASE_URL_AI")
SUPER_URL = os.environ.get("DATABASE_URL_SUPERUSER")


def make_settings(**extra: str) -> Settings:
    env = {"ENVIRONMENT": "test", "DATABASE_URL": AI_URL or "postgres://unused@127.0.0.1:1/none", "SERVICE_TOKEN_KEY": TEST_KEY,
           "EMBEDDER": "fake", **extra}
    return load_settings(env)


def mint(action: str, *, tenant_id: str, card_id: str, person_id: str | None, roles: list[str] | None = None,
         filter: dict[str, Any] | None = None, approved: list[str] | None = None, limits: dict[str, int] | None = None,
         subject: str | None = None, phase: str = "normal", lifetime: int = 60, key: str = TEST_KEY, **override: Any) -> str:
    now = int(time.time())
    claims: dict[str, Any] = {
        "iss": "legacyai-api", "aud": "legacyai-ai", "iat": now, "exp": now + lifetime, "jti": str(uuid.uuid4()),
        "action": action, "tenant_id": tenant_id, "card_id": card_id, "person_id": person_id, "roles": roles or ["learner"],
        "card_phase": phase, "filter": filter, "approved": approved or [], "limits": limits or {}, "request_id": "test-request",
    }
    if subject is not None:
        claims["subject"] = subject
    claims.update(override)
    return jwt.encode(claims, key, algorithm="HS256")


def tenant_filter(tenant_id: str, max_sensitivity: int = 3, only_verified: bool = False, action: str = "knowledge:read") -> dict[str, Any]:
    return {"v": 1, "tenant_id": tenant_id, "action": action, "nothing": False, "only_verified": only_verified,
            "any_of": [{"scope": "tenant", "max_sensitivity": max_sensitivity}]}


AI_LIMITS = {"max_input_tokens": 4000, "max_output_tokens": 600, "calls_per_hour": 300, "monthly_cap_micro_usd": 5_000_000}


# ------------------------------------------------------------------------------------------ database
needs_db = pytest.mark.skipif(not (AI_URL and SUPER_URL), reason="DATABASE_URL_AI and DATABASE_URL_SUPERUSER are not set")


@pytest.fixture(scope="session")
def db() -> Iterator[Database]:
    if not AI_URL:
        pytest.skip("no database")
    database = Database(AI_URL, pool_max=4)
    database.assert_safe_role()
    yield database
    database.close()


@pytest.fixture(scope="session")
def admin() -> Iterator[psycopg.Connection[dict[str, Any]]]:
    if not SUPER_URL:
        pytest.skip("no database")
    conn = psycopg.connect(SUPER_URL, autocommit=True, row_factory=dict_row)
    yield conn
    conn.close()


@dataclass
class Person:
    id: str
    card_id: str
    name: str


@dataclass
class World:
    """One synthetic company: two departments and the people a scenario needs."""

    tenant_id: str
    dept_a: str
    dept_b: str
    people: dict[str, Person] = field(default_factory=dict)

    def ctx(self, who: str, action: str, *, filter: dict[str, Any] | None = None, approved: list[str] | None = None,
            limits: dict[str, int] | None = None, phase: str = "normal", subject: str | None = None,
            topic_filter: dict[str, Any] | None = None, filters: dict[str, dict[str, Any]] | None = None) -> ServiceContext:
        p = self.people[who]
        return ServiceContext(tenant_id=self.tenant_id, card_id=p.card_id, person_id=p.id, roles=("expert",), card_phase=phase,
                              action=action, request_id="test-request", filter=filter if filter is not None else tenant_filter(self.tenant_id),
                              approved=tuple(approved or []), limits=dict(limits if limits is not None else AI_LIMITS), subject=subject,
                              topic_filter=topic_filter, filters=dict(filters or {}))

    def caller(self, who: str, **over: int) -> Caller:
        lim = {**AI_LIMITS, **over}
        return Caller(tenant_id=self.tenant_id, card_id=self.people[who].card_id, request_id="test-request",
                      max_input_tokens=lim["max_input_tokens"], max_output_tokens=lim["max_output_tokens"],
                      calls_per_hour=lim["calls_per_hour"], monthly_cap_micro_usd=lim["monthly_cap_micro_usd"])


def _card_number() -> str:
    return "9" + "".join(secrets.choice("0123456789") for _ in range(15))


def make_world(admin: psycopg.Connection[dict[str, Any]], people: tuple[str, ...] = ("owner", "expert", "reviewer", "learner")) -> World:
    slug = "t-" + uuid.uuid4().hex[:12]
    with admin.transaction():
        tenant_id = str(admin.execute("INSERT INTO tenants (name, slug) VALUES (%s, %s) RETURNING id", (f"Synthetic {slug}", slug)).fetchone()["id"])
        dept_a = str(admin.execute("INSERT INTO departments (tenant_id, name) VALUES (%s, 'Maintenance') RETURNING id", (tenant_id,)).fetchone()["id"])
        dept_b = str(admin.execute("INSERT INTO departments (tenant_id, name) VALUES (%s, 'Finance') RETURNING id", (tenant_id,)).fetchone()["id"])
        world = World(tenant_id, dept_a, dept_b)
        now = datetime.now(UTC)
        for who in people:
            person_id = str(admin.execute(
                "INSERT INTO people (tenant_id, display_name, department_id) VALUES (%s, %s, %s) RETURNING id",
                (tenant_id, f"Synthetic {who.title()}", dept_a)).fetchone()["id"])
            card_id = str(admin.execute(
                """INSERT INTO cards (tenant_id, kind, person_id, card_number, expires_at, grace_until, renewal_due)
                   VALUES (%s, 'person', %s, %s, %s, %s, %s) RETURNING id""",
                (tenant_id, person_id, _card_number(), now + timedelta(days=365), now + timedelta(days=395),
                 now + timedelta(days=335))).fetchone()["id"])
            world.people[who] = Person(person_id, card_id, who)
    return world


def give_consent(admin: psycopg.Connection[dict[str, Any]], world: World, who: str, scope: str) -> str:
    p = world.people[who]
    row = admin.execute(
        """INSERT INTO consents (tenant_id, person_id, scope, purpose, policy_version, granted_by_card_id)
           VALUES (%s, %s, %s, 'Synthetic test consent', 'test-1', %s) RETURNING id""",
        (world.tenant_id, p.id, scope, p.card_id)).fetchone()
    return str(row["id"])


@pytest.fixture
def world(admin: psycopg.Connection[dict[str, Any]]) -> World:
    return make_world(admin)


@pytest.fixture
def provider() -> FakeProvider:
    return FakeProvider()


@pytest.fixture
def embedder() -> FakeEmbedder:
    return FakeEmbedder()


@pytest.fixture
def gateway(db: Database, provider: FakeProvider) -> Gateway:
    return Gateway(db, provider, load_prompts(), load_prices(), Logger("error"))
