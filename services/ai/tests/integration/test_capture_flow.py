"""Document ingestion and the consent gate, against the real database as the AI login (features 19, 25)."""

from __future__ import annotations

import time
from typing import Any

import psycopg
import pytest

from app.ai_gateway import FakeEmbedder
from app.capture import ingest, retrieve
from app.platform import Database
from tests.conftest import World, give_consent, needs_db, tenant_filter
from tests.integration.helpers import company_document
from tests.pdfs import make_pdf

pytestmark = [pytest.mark.db, needs_db]

MANUAL = ("Pump P-7 start-up. Before starting pump P-7, open valve V2 fully. "
          "Questions go to dana.lee@corp.test or call (212) 555-1234.\n\n"
          "Shut-down. Close valve V2 slowly, then switch the pump off at the panel.")


def test_a_company_document_becomes_searchable_and_is_redacted(db: Database, world: World, embedder: FakeEmbedder,
                                                              admin: psycopg.Connection[dict[str, Any]]) -> None:
    source_id = company_document(db, world, embedder, MANUAL)
    rows = admin.execute("SELECT text, status, embedding IS NOT NULL AS has_vector FROM chunks WHERE source_id = %s", (source_id,)).fetchall()
    assert rows and all(r["status"] == "active" and r["has_vector"] for r in rows)
    joined = " ".join(r["text"] for r in rows)
    assert "dana.lee@corp.test" not in joined and "555-1234" not in joined
    assert "[EMAIL_1]" in joined and "[PHONE_1]" in joined
    findings = admin.execute("SELECT entity_type FROM redaction_findings WHERE source_id = %s", (source_id,)).fetchall()
    assert {f["entity_type"] for f in findings} >= {"EMAIL", "PHONE"}
    with db.tenant_tx(world.tenant_id) as cur:
        found = retrieve(cur, tenant_id=world.tenant_id, spec=tenant_filter(world.tenant_id), question="how do I start pump P-7",
                         embedder=embedder)
    assert found, "the ready document must be found"


def test_the_uploaded_file_itself_is_stored_nowhere(db: Database, world: World, embedder: FakeEmbedder,
                                                   admin: psycopg.Connection[dict[str, Any]]) -> None:
    ctx = world.ctx("owner", "source.create")
    src = ingest.create_source(db, ctx, title="Synthetic PDF", department_id=None, sensitivity=1, contributor_person_id=None,
                               company_document=True, storage_budget_bytes=10**12)
    pdf = make_pdf(["Synthetic page one about the boiler.", "Synthetic page two about the chiller."])
    assert ingest.process_upload(db, ctx, embedder, src["id"], pdf, "application/pdf", 10**12, time.monotonic() + 60)["status"] == "ready"
    byte_cols = admin.execute(
        """SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND data_type = 'bytea'""").fetchall()
    for col in byte_cols:
        hit = admin.execute(f'SELECT count(*) AS n FROM "{col["table_name"]}" WHERE position(%s IN "{col["column_name"]}") > 0',
                            (b"%PDF-",)).fetchone()
        assert hit["n"] == 0, f"{col['table_name']}.{col['column_name']} holds PDF bytes"


def test_nothing_is_stored_when_parsing_fails(db: Database, world: World, embedder: FakeEmbedder,
                                             admin: psycopg.Connection[dict[str, Any]]) -> None:
    ctx = world.ctx("owner", "source.create")
    src = ingest.create_source(db, ctx, title="Broken", department_id=None, sensitivity=1, contributor_person_id=None,
                               company_document=True, storage_budget_bytes=10**12)
    out = ingest.process_upload(db, ctx, embedder, src["id"], b"%PDF-1.7 not really", "application/pdf", 10**12, time.monotonic() + 60)
    assert out["status"] == "failed"
    assert admin.execute("SELECT count(*) AS n FROM chunks WHERE source_id = %s", (src["id"],)).fetchone()["n"] == 0
    assert admin.execute("SELECT status FROM sources WHERE id = %s", (src["id"],)).fetchone()["status"] == "failed"


def test_embedding_resumes_and_pending_chunks_are_never_searched(db: Database, world: World, embedder: FakeEmbedder) -> None:
    ctx = world.ctx("owner", "source.create")
    src = ingest.create_source(db, ctx, title="Long", department_id=None, sensitivity=1, contributor_person_id=None,
                               company_document=True, storage_budget_bytes=10**12)
    text = "\n\n".join(f"Section {i}. The synthetic chiller loop {i} is flushed every quarter by the day shift." for i in range(60))
    out = ingest.process_upload(db, ctx, embedder, src["id"], text.encode(), "text/plain", 10**12, time.monotonic() - 1)  # no time left
    assert out["status"] == "processing"
    with db.tenant_tx(world.tenant_id) as cur:
        assert retrieve(cur, tenant_id=world.tenant_id, spec=tenant_filter(world.tenant_id), question="chiller loop flushed",
                        embedder=embedder) == []
    done = ingest.continue_embedding(db, world.tenant_id, world.people["owner"].card_id, src["id"], embedder, time.monotonic() + 60)
    assert done["status"] == "ready" and done["chunk_count"] > 0


def test_a_duplicate_is_reported_only_to_someone_who_may_read_the_original(db: Database, world: World, embedder: FakeEmbedder) -> None:
    company_document(db, world, embedder, MANUAL)
    ctx = world.ctx("owner", "source.create")
    again = ingest.create_source(db, ctx, title="Again", department_id=None, sensitivity=1, contributor_person_id=None,
                                 company_document=True, storage_budget_bytes=10**12)
    out = ingest.process_upload(db, ctx, embedder, again["id"], MANUAL.encode(), "text/plain", 10**12, time.monotonic() + 60)
    assert out["status"] == "failed" and out["failure_code"] == "duplicate"
    # someone who may not read sensitivity-1 material is not told it exists: their upload is processed normally
    blind = world.ctx("learner", "source.create", filter=tenant_filter(world.tenant_id, max_sensitivity=0, action="source:read"))
    third = ingest.create_source(db, blind, title="Third", department_id=None, sensitivity=1, contributor_person_id=None,
                                 company_document=True, storage_budget_bytes=10**12)
    out = ingest.process_upload(db, blind, embedder, third["id"], MANUAL.encode(), "text/plain", 10**12, time.monotonic() + 60)
    assert out["status"] == "ready"


def test_a_named_contributor_needs_consent_and_must_confirm(db: Database, world: World, embedder: FakeEmbedder) -> None:
    owner = world.ctx("owner", "source.create")
    expert = world.people["expert"].id
    with pytest.raises(ingest.CaptureRefused) as exc:
        ingest.create_source(db, owner, title="Expert notes", department_id=None, sensitivity=1, contributor_person_id=expert,
                             company_document=False, storage_budget_bytes=10**12)
    assert exc.value.code == "consent_missing"


def test_confirmation_flow(db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    give_consent(admin, world, "expert", "documents")
    owner = world.ctx("owner", "source.create")
    src = ingest.create_source(db, owner, title="Expert notes", department_id=None, sensitivity=1,
                               contributor_person_id=world.people["expert"].id, company_document=False, storage_budget_bytes=10**12)
    assert src["status"] == "awaiting_confirmation"
    with pytest.raises(ingest.CaptureRefused):
        ingest.process_upload(db, owner, embedder, src["id"], MANUAL.encode(), "text/plain", 10**12, time.monotonic() + 60)
    with pytest.raises(ingest.CaptureRefused):   # someone else cannot confirm for the expert
        ingest.confirm_source(db, world.ctx("reviewer", "source.confirm"), src["id"])
    assert ingest.confirm_source(db, world.ctx("expert", "source.confirm"), src["id"])["status"] == "awaiting_content"
    out = ingest.process_upload(db, owner, embedder, src["id"], MANUAL.encode(), "text/plain", 10**12, time.monotonic() + 60)
    assert out["status"] == "ready"


def test_the_database_refuses_processing_once_consent_is_withdrawn(db: Database, world: World, embedder: FakeEmbedder,
                                                                  admin: psycopg.Connection[dict[str, Any]]) -> None:
    consent = give_consent(admin, world, "expert", "documents")
    me = world.ctx("expert", "source.create")
    src = ingest.create_source(db, me, title="My notes", department_id=None, sensitivity=1, contributor_person_id=world.people["expert"].id,
                               company_document=False, storage_budget_bytes=10**12)
    admin.execute("UPDATE consents SET withdrawn_at = now(), withdrawn_by_card_id = %s WHERE id = %s",
                  (world.people["expert"].card_id, consent))
    # the withdrawal hid the waiting source in the same transaction; nothing can be uploaded into it any more
    assert admin.execute("SELECT status FROM sources WHERE id = %s", (src["id"],)).fetchone()["status"] == "withdrawn"
    with pytest.raises(ingest.CaptureRefused) as exc:
        ingest.process_upload(db, me, embedder, src["id"], MANUAL.encode(), "text/plain", 10**12, time.monotonic() + 60)
    assert exc.value.code == "not_awaiting_content"


def test_quota_and_storage_gate(db: Database, world: World, embedder: FakeEmbedder) -> None:
    ctx = world.ctx("owner", "source.create")
    with pytest.raises(ingest.CaptureRefused) as exc:
        ingest.create_source(db, ctx, title="x", department_id=None, sensitivity=1, contributor_person_id=None, company_document=True,
                             storage_budget_bytes=1)   # the database is certainly larger than 80 % of one byte
    assert exc.value.code == "storage_full"
