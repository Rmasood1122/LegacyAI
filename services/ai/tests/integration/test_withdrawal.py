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
from app.capture import Fields, ingest, turn_key, version_key
from app.main import Services, create_app
from app.platform import Database, Logger
from tests.conftest import World, give_consent, make_settings, mint, needs_db
from tests.integration.helpers import chunk_texts, search

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
    # sealed chunks (decision D41) cannot be searched in SQL: open them and look inside too
    if any(marker in c["text"] for c in chunk_texts(admin, "c.tenant_id = %s AND c.text_sealed IS NOT NULL", (tenant,))):
        hits.append("chunks.text_sealed")
    with admin.cursor() as cur:
        versions = Fields(cur, tenant, "knowledge_versions")
        for v in admin.execute("""SELECT item_id::text AS item_id, version_no, body_sealed, sealed_key FROM knowledge_versions
                                   WHERE tenant_id = %s AND body_sealed IS NOT NULL""", (tenant,)).fetchall():
            if marker in (versions.open(version_key(v["item_id"], v["version_no"]), "body", None, v["body_sealed"], v["sealed_key"]) or ""):
                hits.append("knowledge_versions.body_sealed")
        turns = Fields(cur, tenant, "interview_turns")
        for t in admin.execute("""SELECT interview_id::text AS interview_id, ordinal, question_sealed, answer_sealed, sealed_key FROM interview_turns
                                   WHERE tenant_id = %s AND question_sealed IS NOT NULL""", (tenant,)).fetchall():
            key = turn_key(t["interview_id"], t["ordinal"])
            if any(marker in (turns.open(key, col, None, t[f"{col}_sealed"], t["sealed_key"]) or "") for col in ("question", "answer")):
                hits.append("interview_turns.sealed")
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
    assert search(db, world.tenant_id, embedder, "boiler relief valve") != []      # found before (so "gone" below means something)
    withdraw(admin, world, consent)
    # step 1, same transaction as the withdrawal: hidden
    assert admin.execute("SELECT status FROM sources WHERE id = %s", (source,)).fetchone()["status"] == "withdrawn"
    assert search(db, world.tenant_id, embedder, "boiler relief valve") == []
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
    assert search(db, world.tenant_id, embedder, "boiler relief valve") == []


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
