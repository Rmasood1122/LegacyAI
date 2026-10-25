"""Decision D41, step 5: rows written readable before step 4b (document pieces, item texts and their search copies,
interview questions and answers) are sealed by the housekeeping job, a bounded batch at a time; afterwards nothing of
them is readable at rest, everything still opens and is still found, and a second run has nothing to do. The database
allows readable -> sealed and nothing else. Synthetic data and made-up local keys only."""

from __future__ import annotations

from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.ai_gateway import FakeEmbedder, FakeProvider, Gateway
from app.capture import Fields, interviews, turn_key, version_key
from app.knowledge import items, upkeep
from app.main import Services, create_app
from app.platform import ContentKeys, Database, KeyUnavailable, Logger, use_content_keys
from tests.conftest import TEST_CONTENT_KEYS, World, give_consent, make_settings, make_world, mint, needs_db, tenant_filter
from tests.integration.helpers import chunk_texts, company_document, search, verified_item

pytestmark = [pytest.mark.db, needs_db]

DOCUMENT = "Old manual zzoldmarkerzz. The synthetic feed pump of the north boiler is primed by hand before a cold start."
ITEM = "Old know-how zzoldmarkerzz: vent the synthetic economiser of the north boiler at the top drain before filling."
ANSWER = "Old answer zzoldmarkerzz: I always open the synthetic bypass of the north boiler slowly, two turns a minute."


def plant_readable(db: Database, world: World, embedder: FakeEmbedder, gateway: Gateway,
                   admin: psycopg.Connection[dict[str, Any]]) -> dict[str, str]:
    """Writes a document, a verified item and an interview turn with an answer as they were before step 4b: readable."""
    use_content_keys(None)
    try:
        source = company_document(db, world, embedder, DOCUMENT)
        item = verified_item(db, world, embedder, ITEM, title="Synthetic economiser")
        give_consent(admin, world, "expert", "own_words")
        interview = interviews.invite(db, world.ctx("owner", "interview.invite"), world.people["expert"].id, "Boiler operator")
        spec = tenant_filter(world.tenant_id)
        interviews.accept(db, world.ctx("expert", "interview.accept"), interview, None, None, spec, spec)
        interviews.answer_turn(db, world.ctx("expert", "interview.turn"), interview, ANSWER, embedder, None, None, spec, spec, lambda cur, saved: (None, 0))
    finally:
        use_content_keys(TEST_CONTENT_KEYS)
    return {"source": source, "item": item, "interview": interview}


def readable_at_rest(admin: psycopg.Connection[dict[str, Any]], tenant: str) -> dict[str, int]:
    """Counted by the superuser, outside the code under test."""
    return dict(admin.execute(
        """SELECT (SELECT count(*) FROM chunks WHERE tenant_id = %(t)s AND (text IS NOT NULL OR embedding IS NOT NULL))::int AS chunks,
                  (SELECT count(*) FROM knowledge_versions WHERE tenant_id = %(t)s AND body IS NOT NULL AND erased_at IS NULL)::int AS versions,
                  (SELECT count(*) FROM interview_turns WHERE tenant_id = %(t)s
                      AND (question_text IS NOT NULL OR answer_text IS NOT NULL) AND erased_at IS NULL)::int AS turns,
                  (SELECT count(*) FROM chunks WHERE tenant_id = %(t)s AND text LIKE '%%zzoldmarkerzz%%')
                + (SELECT count(*) FROM knowledge_versions WHERE tenant_id = %(t)s AND body LIKE '%%zzoldmarkerzz%%')
                + (SELECT count(*) FROM interview_turns WHERE tenant_id = %(t)s AND answer_text LIKE '%%zzoldmarkerzz%%') AS marker""",
        {"t": tenant}).fetchone())


def test_old_rows_are_sealed_in_batches_still_open_and_are_still_found(db: Database, world: World, embedder: FakeEmbedder,
                                                                       gateway: Gateway, admin: psycopg.Connection[dict[str, Any]]) -> None:
    planted = plant_readable(db, world, embedder, gateway, admin)
    before = readable_at_rest(admin, world.tenant_id)
    assert before["chunks"] >= 3 and before["versions"] >= 1 and before["turns"] >= 2 and before["marker"] >= 3

    # without content keys (development) the job seals nothing and says what is left
    use_content_keys(None)
    try:
        idle = upkeep.seal_existing(db, world.tenant_id)
    finally:
        use_content_keys(TEST_CONTENT_KEYS)
    assert (idle["sealed_chunks"], idle["sealed_versions"], idle["sealed_turns"]) == (0, 0, 0)
    assert (idle["readable_chunks"], idle["readable_versions"], idle["readable_turns"]) == (before["chunks"], before["versions"], before["turns"])

    # tiny batches: the job goes round until nothing is left (within its time limit)
    done = upkeep.seal_existing(db, world.tenant_id, batch=1)
    assert (done["sealed_chunks"], done["sealed_versions"], done["sealed_turns"]) == (before["chunks"], before["versions"], before["turns"])
    assert (done["readable_chunks"], done["readable_versions"], done["readable_turns"], done["seal_key_unavailable"]) == (0, 0, 0, 0)
    assert readable_at_rest(admin, world.tenant_id) == {"chunks": 0, "versions": 0, "turns": 0, "marker": 0}
    for r in admin.execute("SELECT text_sealed, sealed_key FROM chunks WHERE tenant_id = %s", (world.tenant_id,)).fetchall():
        assert r["sealed_key"] == "platform:1" and b"zzoldmarkerzz" not in bytes(r["text_sealed"])

    # everything still opens to the words that were there, and is still found
    texts = [c["text"] for c in chunk_texts(admin, "c.tenant_id = %s", (world.tenant_id,))]
    assert DOCUMENT in texts and any(ITEM in t for t in texts) and any("open the synthetic bypass" in t for t in texts)
    with db.tenant_tx(world.tenant_id) as cur:
        assert items._item(cur, world.tenant_id, planted["item"], lock=False)["body"] == ITEM
    with admin.cursor() as cur:
        turn = admin.execute("SELECT question_sealed, answer_sealed, sealed_key FROM interview_turns WHERE interview_id = %s AND ordinal = 1",
                             (planted["interview"],)).fetchone()
        answer = Fields(cur, world.tenant_id, "interview_turns").open(turn_key(planted["interview"], 1), "answer", None, turn["answer_sealed"],
                                                                      turn["sealed_key"])
        assert answer is not None and "open the synthetic bypass" in answer
        version = admin.execute("SELECT body_sealed, sealed_key FROM knowledge_versions WHERE item_id = %s AND version_no = 1",
                                (planted["item"],)).fetchone()
        assert Fields(cur, world.tenant_id, "knowledge_versions").open(version_key(planted["item"], 1), "body", None, version["body_sealed"],
                                                                       version["sealed_key"]) == ITEM
    found = search(db, world.tenant_id, embedder, "feed pump primed by hand cold start")
    assert set(found) & {c["id"] for c in chunk_texts(admin, "c.source_id = %s", (planted["source"],))}
    assert search(db, world.tenant_id, embedder, "vent economiser top drain") != []

    # the next housekeeping call (through the service, as the API's housekeeping command calls it) has nothing to do
    services = Services(make_settings(), db, FakeProvider(), embedder, Logger("error"))
    token = mint("housekeeping.run", tenant_id=world.tenant_id, card_id="00000000-0000-0000-0000-000000000000", person_id=None, roles=[])
    res = TestClient(create_app(services)).post("/internal/housekeeping", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200, res.text
    again = res.json()["done"]
    assert {k: again[k] for k in again if k.startswith(("sealed_", "readable_"))} == {
        "sealed_chunks": 0, "sealed_versions": 0, "sealed_turns": 0, "readable_chunks": 0, "readable_versions": 0, "readable_turns": 0}


def test_one_call_is_bounded_and_the_next_one_goes_on(db: Database, world: World, embedder: FakeEmbedder, gateway: Gateway,
                                                      admin: psycopg.Connection[dict[str, Any]]) -> None:
    plant_readable(db, world, embedder, gateway, admin)
    before = readable_at_rest(admin, world.tenant_id)
    first = upkeep.seal_existing(db, world.tenant_id, batch=1, seconds=0)       # no time: exactly one batch
    assert (first["sealed_chunks"], first["sealed_versions"], first["sealed_turns"]) == (1, 1, 1)
    assert first["readable_chunks"] == before["chunks"] - 1 and first["readable_turns"] == before["turns"] - 1
    second = upkeep.seal_existing(db, world.tenant_id, batch=1, seconds=0)
    assert second["sealed_chunks"] == 1 and second["readable_chunks"] == before["chunks"] - 2


def test_a_key_that_cannot_be_used_seals_nothing_and_says_so(db: Database, world: World, embedder: FakeEmbedder, gateway: Gateway,
                                                             admin: psycopg.Connection[dict[str, Any]]) -> None:
    plant_readable(db, world, embedder, gateway, admin)
    before = readable_at_rest(admin, world.tenant_id)

    class SwitchedOff(ContentKeys):
        def for_writing(self, cur: Any, tenant_id: str) -> tuple[str, bytes]:
            raise KeyUnavailable("switched off")

    use_content_keys(SwitchedOff(TEST_CONTENT_KEYS.keys, TEST_CONTENT_KEYS.platform_ref))
    try:
        done = upkeep.seal_existing(db, world.tenant_id)
    finally:
        use_content_keys(TEST_CONTENT_KEYS)
    assert done["seal_key_unavailable"] == 1
    assert (done["sealed_chunks"], done["sealed_versions"], done["sealed_turns"]) == (0, 0, 0)
    assert readable_at_rest(admin, world.tenant_id) == before            # rolled back: nothing half-done


def test_the_database_allows_readable_to_sealed_and_nothing_else(db: Database, world: World, embedder: FakeEmbedder, gateway: Gateway,
                                                                admin: psycopg.Connection[dict[str, Any]]) -> None:
    planted = plant_readable(db, world, embedder, gateway, admin)
    fake = b"\x01" * 40           # stands for a sealed value; the database cannot read it either way
    chunk = admin.execute("SELECT id FROM chunks WHERE source_id = %s LIMIT 1", (planted["source"],)).fetchone()["id"]
    version = str(admin.execute("SELECT id FROM knowledge_versions WHERE item_id = %s", (planted["item"],)).fetchone()["id"])

    # a source chunk's text cannot be replaced by a sealed value without the job's flag
    with pytest.raises(psycopg.errors.CheckViolation), db.tenant_tx(world.tenant_id) as cur:
        cur.execute("UPDATE chunks SET text = NULL, embedding = NULL, text_sealed = %s, sealed_key = 'platform:1' WHERE id = %s", (fake, chunk))
    # the AI service cannot change a version itself
    with pytest.raises(psycopg.errors.InsufficientPrivilege), db.tenant_tx(world.tenant_id) as cur:
        cur.execute("UPDATE knowledge_versions SET body = NULL, body_sealed = %s, sealed_key = 'platform:1' WHERE id = %s", (fake, version))
    # seal_version() seals only a version of the caller's own company
    with db.tenant_tx(make_world(admin).tenant_id) as cur:
        cur.execute("SELECT seal_version(%s, %s, 'platform:1') AS done", (version, fake))
        assert cur.fetchone()["done"] is False

    upkeep.seal_existing(db, world.tenant_id)
    # sealed -> readable is refused, flag or not
    with pytest.raises(psycopg.errors.CheckViolation), db.tenant_tx(world.tenant_id) as cur:
        cur.execute("SELECT set_config('app.reseal', 'on', true)")
        cur.execute("UPDATE chunks SET text = 'readable again', text_sealed = NULL, sealed_key = NULL, embedding_sealed = NULL WHERE id = %s",
                    (chunk,))
    # a sealed chunk cannot be sealed again with something else
    with pytest.raises(psycopg.errors.CheckViolation), db.tenant_tx(world.tenant_id) as cur:
        cur.execute("SELECT set_config('app.reseal', 'on', true)")
        cur.execute("UPDATE chunks SET text_sealed = %s WHERE id = %s", (fake, chunk))
    # a sealed version is not sealed twice, and a version cannot be changed back by the owner either
    with db.tenant_tx(world.tenant_id) as cur:
        cur.execute("SELECT seal_version(%s, %s, 'platform:1') AS done", (version, fake))
        assert cur.fetchone()["done"] is False
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        admin.execute("UPDATE knowledge_versions SET body = 'readable again', body_sealed = NULL, sealed_key = NULL WHERE id = %s", (version,))
