"""Decision D41, section 4 of the plan (re-keying), part 1: a company that CLEARS its own key (or changes to another
one) has its content sealed again with its current key by the housekeeping job - document pieces and their vectors,
knowledge versions and interview turns. Afterwards nothing needs the old key: switched off, everything still opens and
is still found. The database allows this key change only away from a retired own key and only to the current key.
Synthetic data and made-up local keys only; no cloud account."""

from __future__ import annotations

import os
from collections.abc import Iterator
from typing import Any

import psycopg
import pytest

from app.ai_gateway import FakeEmbedder
from app.capture import interviews
from app.knowledge import items, upkeep
from app.platform import ContentKeys, Database, active_content_keys, use_content_keys
from app.platform.sealing import LocalKeyService, wrap_aad
from tests.conftest import TEST_CONTENT_KEYS, TEST_PLATFORM_KEY, World, give_consent, needs_db, tenant_filter
from tests.integration.helpers import chunk_texts, company_document, search, verified_item

pytestmark = [pytest.mark.db, needs_db]

COMPANY_KEY = bytes([33]) * 32          # made-up, in this file only
DOCUMENT = "Rekey manual. The synthetic condensate pump of the north boiler is checked for cavitation noise every shift."
ITEM = "Rekey know-how: the synthetic deaerator of the north boiler is vented for two minutes after every start."
ANSWER = "Rekey answer: I always listen at the synthetic condensate pump before I open the north boiler drain."


@pytest.fixture
def local() -> Iterator[LocalKeyService]:
    """The key service with the company's own made-up key; the test's content keys use it."""
    service = LocalKeyService({"platform": TEST_PLATFORM_KEY, "acme": COMPANY_KEY})
    use_content_keys(ContentKeys(service, "local:platform"))
    try:
        yield service
    finally:
        use_content_keys(TEST_CONTENT_KEYS)


def give_own_key(admin: psycopg.Connection[dict[str, Any]], tenant: str) -> None:
    """What the API's setKey stores when a company brings its key."""
    wrapped = LocalKeyService({"acme": COMPANY_KEY}).wrap("local:acme", os.urandom(32), wrap_aad(tenant, 1))
    with admin.transaction():
        admin.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant,))
        admin.execute("INSERT INTO company_data_keys (tenant_id, version, key_ref, wrapped_key) VALUES (%s, 1, 'local:acme', %s)", (tenant, wrapped))


def clear_own_key(admin: psycopg.Connection[dict[str, Any]], tenant: str) -> None:
    """What the API's setKey(null) does: the live version is retired."""
    with admin.transaction():
        admin.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant,))
        admin.execute("UPDATE company_data_keys SET retired_at = now() WHERE tenant_id = %s AND retired_at IS NULL", (tenant,))


def plant(db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> dict[str, str]:
    """A document, a verified item and an answered interview turn, written while the company's own key is live."""
    source = company_document(db, world, embedder, DOCUMENT)
    item = verified_item(db, world, embedder, ITEM, title="Synthetic deaerator")
    give_consent(admin, world, "expert", "own_words")
    interview = interviews.invite(db, world.ctx("owner", "interview.invite"), world.people["expert"].id, "Boiler operator")
    spec = tenant_filter(world.tenant_id)
    interviews.accept(db, world.ctx("expert", "interview.accept"), interview, None, None, spec, spec)
    interviews.answer_turn(db, world.ctx("expert", "interview.turn"), interview, ANSWER, embedder, None, None, spec, spec,
                           lambda cur, saved: (None, 0))
    return {"source": source, "item": item, "interview": interview}


def keys_at_rest(admin: psycopg.Connection[dict[str, Any]], tenant: str) -> dict[str, set[str]]:
    """Which keys the stored values are sealed with, read by the superuser."""
    def ids(sql: str) -> set[str]:
        return {r["k"] for r in admin.execute(sql, (tenant,)).fetchall()}
    return {"chunks": ids("SELECT DISTINCT sealed_key AS k FROM chunks WHERE tenant_id = %s"),
            "versions": ids("SELECT DISTINCT sealed_key AS k FROM knowledge_versions WHERE tenant_id = %s AND erased_at IS NULL"),
            "turns": ids("SELECT DISTINCT sealed_key AS k FROM interview_turns WHERE tenant_id = %s AND erased_at IS NULL")}


def test_after_the_key_is_cleared_housekeeping_seals_everything_again_and_the_old_key_is_no_longer_needed(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]], local: LocalKeyService) -> None:
    give_own_key(admin, world.tenant_id)
    planted = plant(db, world, embedder, admin)
    assert keys_at_rest(admin, world.tenant_id) == {"chunks": {"company:1"}, "versions": {"company:1"}, "turns": {"company:1"}}

    nothing = upkeep.seal_existing(db, world.tenant_id)            # the key is still live: nothing to re-key
    assert (nothing["rekeyed_chunks"], nothing["old_key_chunks"], nothing["old_key_unavailable"]) == (0, 0, 0)

    clear_own_key(admin, world.tenant_id)
    before = upkeep.seal_existing(db, world.tenant_id, batch=1)
    assert before["rekeyed_chunks"] >= 2 and before["rekeyed_versions"] >= 1 and before["rekeyed_turns"] >= 2
    assert (before["old_key_chunks"], before["old_key_versions"], before["old_key_turns"], before["old_key_unavailable"]) == (0, 0, 0, 0)
    assert keys_at_rest(admin, world.tenant_id) == {"chunks": {"platform:1"}, "versions": {"platform:1"}, "turns": {"platform:1"}}
    again = upkeep.seal_existing(db, world.tenant_id)
    assert (again["rekeyed_chunks"], again["rekeyed_versions"], again["rekeyed_turns"]) == (0, 0, 0)

    local.disable("acme")                                           # the company's old key is gone
    texts = [c["text"] for c in chunk_texts(admin, "c.tenant_id = %s", (world.tenant_id,))]
    assert DOCUMENT in texts and any(ITEM in t for t in texts) and any("condensate pump before I open" in t for t in texts)
    assert search(db, world.tenant_id, embedder, "condensate pump cavitation noise") != []
    with db.tenant_tx(world.tenant_id) as cur:
        assert items._item(cur, world.tenant_id, planted["item"], lock=False)["body"] == ITEM


def test_when_the_old_key_no_longer_works_nothing_is_lost_and_readable_rows_are_still_sealed(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]], local: LocalKeyService) -> None:
    give_own_key(admin, world.tenant_id)
    plant(db, world, embedder, admin)
    clear_own_key(admin, world.tenant_id)
    use_content_keys(None)
    try:
        company_document(db, world, embedder, "Readable manual. The synthetic feed valve of the north boiler is greased monthly.")
    finally:
        use_content_keys(ContentKeys(local, "local:platform"))
    local.disable("acme")                                           # switched off before housekeeping ran
    done = upkeep.seal_existing(db, world.tenant_id)
    assert done["old_key_unavailable"] == 1 and done["rekeyed_chunks"] == 0 and done["old_key_chunks"] >= 2
    assert done["sealed_chunks"] >= 1 and done["readable_chunks"] == 0 and done["seal_key_unavailable"] == 0
    assert keys_at_rest(admin, world.tenant_id)["versions"] == {"company:1"}      # untouched, waiting for the key
    local.enable("acme")                                            # the key works again: the next run finishes
    later = upkeep.seal_existing(db, world.tenant_id)
    assert (later["old_key_chunks"], later["old_key_versions"], later["old_key_turns"], later["old_key_unavailable"]) == (0, 0, 0, 0)


def test_the_database_allows_the_key_change_only_away_from_a_retired_own_key_and_only_to_the_current_key(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]], local: LocalKeyService) -> None:
    give_own_key(admin, world.tenant_id)
    planted = plant(db, world, embedder, admin)
    chunk = admin.execute("SELECT id, text_sealed FROM chunks WHERE source_id = %s LIMIT 1", (planted["source"],)).fetchone()
    version = admin.execute("SELECT id, body_sealed FROM knowledge_versions WHERE item_id = %s", (planted["item"],)).fetchone()
    with db.tenant_tx(world.tenant_id) as cur:
        cur.execute("SELECT content_rekey_allowed(%s, 'company:1', 'platform:1') AS ok", (world.tenant_id,))
        assert cur.fetchone()["ok"] is False                        # the own key is still live
    with pytest.raises(psycopg.errors.CheckViolation), db.tenant_tx(world.tenant_id) as cur:
        cur.execute("SELECT set_config('app.reseal', 'on', true)")
        cur.execute("UPDATE chunks SET sealed_key = 'platform:1' WHERE id = %s", (chunk["id"],))
    clear_own_key(admin, world.tenant_id)
    keys = active_content_keys()
    assert keys is not None
    with db.tenant_tx(world.tenant_id) as cur:                      # the platform key now exists and is the current one
        keys.for_writing(cur, world.tenant_id)
    with pytest.raises(psycopg.errors.CheckViolation), db.tenant_tx(world.tenant_id) as cur:
        cur.execute("UPDATE chunks SET sealed_key = 'platform:1' WHERE id = %s", (chunk["id"],))      # not without the job's flag
    with pytest.raises(psycopg.errors.CheckViolation), db.tenant_tx(world.tenant_id) as cur:
        cur.execute("SELECT set_config('app.reseal', 'on', true)")
        cur.execute("UPDATE chunks SET sealed_key = 'platform:2' WHERE id = %s", (chunk["id"],))      # not to another key
    with pytest.raises(psycopg.errors.InsufficientPrivilege), db.tenant_tx(world.tenant_id) as cur:
        cur.execute("SELECT reseal_version(%s, 'company:1', %s, 'company:1')", (version["id"], bytes(version["body_sealed"])))
