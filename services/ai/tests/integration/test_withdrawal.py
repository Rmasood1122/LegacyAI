"""Consent withdrawal (feature 19): hidden in the same transaction, erased in the same request, a
legal hold keeps it hidden but not erased. A marker planted in the contributor's material is
searched for in every text column of the company afterwards."""

from __future__ import annotations

import time
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.ai_gateway import FakeEmbedder, FakeProvider
from app.capture import ingest, retrieve
from app.main import Services, create_app
from app.platform import Database, Logger
from tests.conftest import World, give_consent, make_settings, mint, needs_db, tenant_filter

pytestmark = [pytest.mark.db, needs_db]


def plant(db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> tuple[str, str, str]:
    """The expert gives consent and uploads their own notes, which carry a unique marker."""
    consent = give_consent(admin, world, "expert", "documents")
    # A fixed, lower-case word: a random marker was once redacted away at upload (CI run 37118690201), which made the
    # legal-hold test fail as if the material had been erased. Each test has its own company, so a fixed marker is safe.
    marker = "zzwithdrawmarkerzz"
    me = world.ctx("expert", "source.create")
    src = ingest.create_source(db, me, title=f"Notes {marker}", department_id=None, sensitivity=1,
                               contributor_person_id=world.people["expert"].id, company_document=False, storage_budget_bytes=10**12)
    text = f"Synthetic boiler notes {marker}. The relief valve lifts at 6 bar and is tested monthly."
    assert ingest.process_upload(db, me, embedder, src["id"], text.encode(), "text/plain", 10**12, time.monotonic() + 60)["status"] == "ready"
    assert marker_hits(admin, world.tenant_id, marker) != [], "the marker did not survive redaction at upload"
    return consent, str(src["id"]), marker


def withdraw(admin: psycopg.Connection[dict[str, Any]], world: World, consent: str) -> None:
    admin.execute("UPDATE consents SET withdrawn_at = now(), withdrawn_by_card_id = %s WHERE id = %s",
                  (world.people["expert"].card_id, consent))


def marker_hits(admin: psycopg.Connection[dict[str, Any]], tenant: str, marker: str) -> list[str]:
    cols = admin.execute("""SELECT c.table_name, c.column_name FROM information_schema.columns c
                             JOIN information_schema.columns t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
                                                              AND t.column_name = 'tenant_id'
                            WHERE c.table_schema = 'public' AND c.data_type IN ('text', 'jsonb', 'character varying')""").fetchall()
    hits = []
    for col in cols:
        n = admin.execute(f'SELECT count(*) AS n FROM "{col["table_name"]}" WHERE tenant_id = %s AND "{col["column_name"]}"::text LIKE %s',
                          (tenant, f"%{marker}%")).fetchone()["n"]
        if n:
            hits.append(f"{col['table_name']}.{col['column_name']}")
    return hits


def erase(db: Database, world: World, consent: str) -> dict[str, Any]:
    services = Services(make_settings(), db, FakeProvider(), FakeEmbedder(), Logger("error"))
    token = mint("consent.erase", tenant_id=world.tenant_id, card_id=world.people["expert"].card_id, person_id=world.people["expert"].id,
                 subject=consent)
    res = TestClient(create_app(services)).post(f"/internal/consents/{consent}/erase", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200, res.text
    return dict(res.json())


def test_withdrawn_material_is_gone_from_search_at_once_and_erased_after(db: Database, world: World, embedder: FakeEmbedder,
                                                                       admin: psycopg.Connection[dict[str, Any]]) -> None:
    consent, source, marker = plant(db, world, embedder, admin)
    withdraw(admin, world, consent)
    # step 1, same transaction as the withdrawal: hidden
    assert admin.execute("SELECT status FROM sources WHERE id = %s", (source,)).fetchone()["status"] == "withdrawn"
    with db.tenant_tx(world.tenant_id) as cur:
        assert retrieve(cur, tenant_id=world.tenant_id, spec=tenant_filter(world.tenant_id), question="boiler relief valve",
                        embedder=embedder) == []
    # step 2: erased
    out = erase(db, world, consent)
    assert out["withdrawal_status"] == "completed" and out["sources_erased"] == 1
    assert marker_hits(admin, world.tenant_id, marker) == []
    assert admin.execute("SELECT withdrawal_status FROM consents WHERE id = %s", (consent,)).fetchone()["withdrawal_status"] == "completed"


def test_a_legal_hold_keeps_the_material_hidden_but_not_erased(db: Database, world: World, embedder: FakeEmbedder,
                                                              admin: psycopg.Connection[dict[str, Any]]) -> None:
    consent, source, marker = plant(db, world, embedder, admin)
    admin.execute("UPDATE consents SET legal_hold = true, legal_hold_by_card_id = %s, legal_hold_at = now(), legal_hold_reason = 'synthetic' "
                  "WHERE id = %s", (world.people["owner"].card_id, consent))
    withdraw(admin, world, consent)
    assert erase(db, world, consent)["withdrawal_status"] == "held"
    assert admin.execute("SELECT status FROM sources WHERE id = %s", (source,)).fetchone()["status"] == "withdrawn"
    assert marker_hits(admin, world.tenant_id, marker) != []           # kept, because of the hold
    with db.tenant_tx(world.tenant_id) as cur:
        assert retrieve(cur, tenant_id=world.tenant_id, spec=tenant_filter(world.tenant_id), question="boiler relief valve",
                        embedder=embedder) == []


def test_withdrawing_a_renewed_consent_also_covers_material_given_under_the_earlier_one(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    old_consent, source, marker = plant(db, world, embedder, admin)
    # the person renews their consent: the old one is superseded, the material keeps the old id
    admin.execute("UPDATE consents SET superseded_at = now() WHERE id = %s", (old_consent,))
    new_consent = give_consent(admin, world, "expert", "documents")
    withdraw(admin, world, new_consent)
    assert admin.execute("SELECT status FROM sources WHERE id = %s", (source,)).fetchone()["status"] == "withdrawn"
    assert erase(db, world, new_consent)["sources_erased"] == 1
    assert marker_hits(admin, world.tenant_id, marker) == []
