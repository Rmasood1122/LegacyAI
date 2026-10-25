"""Chunks are stored sealed (decision D41, step 4b part 2): no readable text or vector at rest, a value moved to another
place does not open, chunks written before (readable) are still read, a company's switched-off key stops reads and
writes with a clear refusal, and production refuses to start without a platform content key. Synthetic data and
made-up local keys only."""

from __future__ import annotations

import os
import time
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.ai_gateway import FakeEmbedder, FakeProvider
from app.capture import SEALED_COLUMNS, Opener, ingest, load_approved
from app.main import Services, create_app
from app.platform import ConfigError, ContentKeys, Database, KeyUnavailable, Logger, load_settings, use_content_keys
from app.platform.sealing import LocalKeyService, SealError, wrap_aad
from tests.conftest import TEST_CONTENT_KEYS, TEST_KEY, TEST_PLATFORM_KEY, World, make_settings, make_world, mint, needs_db, tenant_filter
from tests.integration.helpers import chunk_texts, company_document, search, verified_item

pytestmark = [pytest.mark.db, needs_db]

MANUAL = "Cooling tower CT-2. Before the summer start-up, the drift eliminators are washed and the fan belt is tensioned."
COMPANY_KEY = bytes([33]) * 32            # a made-up key "acme", in this file only


def stored(admin: psycopg.Connection[dict[str, Any]], where: str, params: tuple[Any, ...]) -> list[dict[str, Any]]:
    return admin.execute(f"SELECT c.text, c.embedding, c.text_sealed, c.embedding_sealed, c.sealed_key FROM chunks c WHERE {where}",
                         params).fetchall()


def test_documents_and_item_copies_are_stored_sealed_and_still_found(db: Database, world: World, embedder: FakeEmbedder,
                                                                     admin: psycopg.Connection[dict[str, Any]]) -> None:
    source = company_document(db, world, embedder, MANUAL)
    item = verified_item(db, world, embedder, "Wash the drift eliminators of CT-2 before the summer start-up.")
    rows = stored(admin, "c.source_id = %s OR c.knowledge_item_id = %s", (source, item))
    assert len(rows) == 2
    for r in rows:
        assert r["text"] is None and r["embedding"] is None and r["sealed_key"] == "platform:1"
        assert r["text_sealed"] is not None and r["embedding_sealed"] is not None
        assert b"eliminators" not in bytes(r["text_sealed"]) and b"CT-2" not in bytes(r["text_sealed"])
    assert search(db, world.tenant_id, embedder, "drift eliminators summer start-up") != []
    # the answer step opens them too, with the similarity the database used to compute
    found = search(db, world.tenant_id, embedder, "drift eliminators")
    q = embedder.embed(["drift eliminators"], "query")[0]
    with db.tenant_tx(world.tenant_id) as cur:
        loaded = load_approved(cur, tenant_id=world.tenant_id, spec=tenant_filter(world.tenant_id), approved_ids=found, question_vector=q)
    assert {r["id"] for r in loaded} == set(found)
    assert all("eliminators" in r["text"] and -1.0 <= r["similarity"] <= 1.0 for r in loaded)


def test_without_content_keys_chunks_are_written_readable_and_both_forms_are_read_together(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    use_content_keys(None)                                   # as before this step (and step 5 will seal these later)
    try:
        old = company_document(db, world, embedder, "Old manual. The boiler feed pump is primed by hand.", title="Old")
    finally:
        use_content_keys(TEST_CONTENT_KEYS)
    new = company_document(db, world, embedder, "New manual. The boiler feed pump is vented at the top.", title="New")
    assert stored(admin, "c.source_id = %s", (old,))[0]["text"] is not None
    assert stored(admin, "c.source_id = %s", (new,))[0]["text"] is None
    found = search(db, world.tenant_id, embedder, "boiler feed pump")
    q = embedder.embed(["boiler feed pump"], "query")[0]
    with db.tenant_tx(world.tenant_id) as cur:
        loaded = load_approved(cur, tenant_id=world.tenant_id, spec=tenant_filter(world.tenant_id), approved_ids=found, question_vector=q)
    assert {r["text"].split(".")[0] for r in loaded} == {"Old manual", "New manual"}
    # for a readable chunk, the similarity computed here equals the database's own number
    readable = next(r for r in loaded if r["text"].startswith("Old"))
    with db.tenant_tx(world.tenant_id) as cur:
        cur.execute("SELECT 1 - (embedding <=> %s::halfvec) AS sim FROM chunks WHERE id = %s",
                    ("[" + ",".join(str(x) for x in q) + "]", readable["id"]))
        assert readable["similarity"] == pytest.approx(cur.fetchone()["sim"], abs=1e-3)


def test_a_sealed_value_moved_to_another_chunk_or_company_does_not_open(db: Database, world: World, embedder: FakeEmbedder,
                                                                        admin: psycopg.Connection[dict[str, Any]]) -> None:
    text = "\n\n".join(f"Section {i}. The synthetic chiller loop {i} is flushed every quarter by the day shift." for i in range(40))
    source = company_document(db, world, embedder, text)
    rows = chunk_texts(admin, "c.source_id = %s", (source,))
    assert len(rows) >= 2
    first, second = rows[0], rows[1]
    raw = admin.execute(f"SELECT {SEALED_COLUMNS} FROM chunks c WHERE c.id = %s", (second["id"],)).fetchone()
    moved = {**raw, "text_sealed": admin.execute("SELECT text_sealed FROM chunks WHERE id = %s", (first["id"],)).fetchone()["text_sealed"]}
    with admin.cursor() as cur:
        assert Opener(cur, world.tenant_id).text(raw) == second["text"]
        with pytest.raises(SealError):                      # another chunk's sealed text in this chunk's place
            Opener(cur, world.tenant_id).text(moved)
        other = make_world(admin)
        with pytest.raises(KeyUnavailable):                 # another company has no such key
            Opener(cur, other.tenant_id).text(raw)
    # and the database refuses to change a source chunk's sealed text at all
    with pytest.raises(psycopg.errors.CheckViolation), admin.transaction():
        admin.execute("SELECT set_config('app.tenant_id', %s, true)", (world.tenant_id,))
        admin.execute("UPDATE chunks SET text_sealed = %s WHERE id = %s", (moved["text_sealed"], second["id"]))


def give_own_key(admin: psycopg.Connection[dict[str, Any]], tenant: str) -> None:
    wrapped = LocalKeyService({"acme": COMPANY_KEY}).wrap("local:acme", os.urandom(32), wrap_aad(tenant, 1))
    with admin.transaction():
        admin.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant,))
        admin.execute("INSERT INTO company_data_keys (tenant_id, version, key_ref, wrapped_key) VALUES (%s, 1, 'local:acme', %s)",
                      (tenant, wrapped))


def test_a_company_that_switches_its_key_off_can_neither_add_nor_read_content_and_the_api_is_told_why(
        db: Database, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    world = make_world(admin)
    give_own_key(admin, world.tenant_id)
    local = LocalKeyService({"platform": TEST_PLATFORM_KEY, "acme": COMPANY_KEY})
    keys = ContentKeys(local, "local:platform")
    use_content_keys(keys)
    try:
        source = company_document(db, world, embedder, MANUAL)
        assert {r["sealed_key"] for r in stored(admin, "c.source_id = %s", (source,))} == {"company:1"}
        assert search(db, world.tenant_id, embedder, "drift eliminators") != []
        local.disable("acme")                               # the company switches its key off
        keys.forget(world.tenant_id)                        # (otherwise within 5 minutes)
        with pytest.raises(KeyUnavailable):
            search(db, world.tenant_id, embedder, "drift eliminators")
        ctx = world.ctx("owner", "source.create")
        src = ingest.create_source(db, ctx, title="Another", department_id=None, sensitivity=1, contributor_person_id=None,
                                   company_document=True, storage_budget_bytes=10**12)
        with pytest.raises(KeyUnavailable):
            ingest.process_upload(db, ctx, embedder, src["id"], b"More notes on the tower.", "text/plain", 10**12, time.monotonic() + 60)
        assert admin.execute("SELECT count(*) AS n FROM content_data_keys WHERE tenant_id = %s", (world.tenant_id,)).fetchone()["n"] == 0
        # through the service: a clear refusal, never the key service's own words
        services = Services(make_settings(), db, FakeProvider(), embedder, Logger("error"))
        token = mint("knowledge.candidates", tenant_id=world.tenant_id, card_id=world.people["reviewer"].card_id,
                     person_id=world.people["reviewer"].id, filter=tenant_filter(world.tenant_id))
        res = TestClient(create_app(services)).post("/internal/knowledge/candidates", json={"question": "drift eliminators"},
                                                    headers={"Authorization": f"Bearer {token}"})
        assert (res.status_code, res.json()) == (503, {"error": "company_key_unavailable"})
    finally:
        use_content_keys(TEST_CONTENT_KEYS)


def test_production_refuses_to_start_without_a_platform_content_key() -> None:
    prod = {"ENVIRONMENT": "production", "DATABASE_URL": "postgres://u@h/db", "SERVICE_TOKEN_KEY": TEST_KEY, "EMBEDDER": "fake"}
    with pytest.raises(ConfigError):
        load_settings(prod)
    with pytest.raises(ConfigError):
        load_settings({**prod, "KEY_SERVICE": "google-kms"})
    assert load_settings({**prod, "KEY_SERVICE": "google-kms",
                          "PLATFORM_CONTENT_KEY": "projects/acme-prod-1234/locations/us/keyRings/r/cryptoKeys/k"}).platform_content_key


# ------------------------------------------------------------------ knowledge versions and interview turns (step 4b part 3)

def test_knowledge_versions_are_stored_sealed_and_read_back_everywhere(db: Database, world: World, embedder: FakeEmbedder,
                                                                       admin: psycopg.Connection[dict[str, Any]]) -> None:
    from app.knowledge import items, reads

    first = "Bleed the hydraulic accumulator HA-1 to zero before opening the press guard."
    item = verified_item(db, world, embedder, first)
    assert items.propose_version(db, world.ctx("reviewer", "item.propose"), item, first + " Check the gauge reads 0 bar.") == 2
    rows = admin.execute("SELECT version_no, body, body_sealed, sealed_key FROM knowledge_versions WHERE item_id = %s ORDER BY version_no",
                         (item,)).fetchall()
    assert [r["version_no"] for r in rows] == [1, 2]
    for r in rows:
        assert r["body"] is None and r["sealed_key"] == "platform:1" and b"accumulator" not in bytes(r["body_sealed"])
    # read back: the item, its version history, and the copy used for search
    shown = reads.get_item(db, world.ctx("reviewer", "item.read"), item)
    assert shown["body"].endswith("Check the gauge reads 0 bar.")
    assert items.verify(db, world.ctx("owner", "item.verify"), item, embedder) == "corrected"
    assert chunk_texts(admin, "c.knowledge_item_id = %s", (item,))[0]["text"].endswith("reads 0 bar.")


def test_the_database_keeps_sealed_versions_unchangeable_and_erases_both_forms(db: Database, world: World, embedder: FakeEmbedder,
                                                                              admin: psycopg.Connection[dict[str, Any]]) -> None:
    item = verified_item(db, world, embedder, "Lock out the conveyor at isolator IS-4 before clearing a jam.")
    version = admin.execute("SELECT id, body_sealed FROM knowledge_versions WHERE item_id = %s", (item,)).fetchone()
    with pytest.raises(psycopg.errors.InsufficientPrivilege), admin.transaction():     # a version is never changed
        admin.execute("SELECT set_config('app.tenant_id', %s, true)", (world.tenant_id,))
        admin.execute("UPDATE knowledge_versions SET body_sealed = '\\x01' || body_sealed WHERE id = %s", (version["id"],))
    with admin.transaction():                                                          # ... only erased (consent withdrawal)
        admin.execute("SELECT set_config('app.tenant_id', %s, true)", (world.tenant_id,))
        admin.execute("SELECT erase_version(%s)", (version["id"],))
    after = admin.execute("SELECT body, body_sealed, sealed_key, erased_at FROM knowledge_versions WHERE id = %s", (version["id"],)).fetchone()
    assert (after["body"], after["body_sealed"], after["sealed_key"]) == ("", None, None) and after["erased_at"] is not None


def test_an_erased_interview_turn_keeps_nothing_sealed(db: Database, admin: psycopg.Connection[dict[str, Any]], world: World) -> None:
    """The database refuses an erased turn that still holds a sealed question or answer."""
    from app.capture import interviews

    iv = interviews.invite(db, world.ctx("owner", "interview.invite"), world.people["expert"].id, "Synthetic role")
    sealed = bytes(40)
    with pytest.raises(psycopg.errors.CheckViolation), admin.transaction():
        admin.execute("""INSERT INTO interview_turns (tenant_id, interview_id, ordinal, question_sealed, sealed_key, question_kind, erased_at)
                         VALUES (%s, %s, 1, %s, 'platform:1', 'template', now())""", (world.tenant_id, iv, sealed))
    with pytest.raises(psycopg.errors.CheckViolation), admin.transaction():         # never both forms of a question
        admin.execute("""INSERT INTO interview_turns (tenant_id, interview_id, ordinal, question_text, question_sealed, sealed_key, question_kind)
                         VALUES (%s, %s, 1, 'Readable too?', %s, 'platform:1', 'template')""", (world.tenant_id, iv, sealed))
