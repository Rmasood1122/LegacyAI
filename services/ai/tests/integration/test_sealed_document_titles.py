"""Decision D41, step 6 part 4a: a document's title is stored sealed; the API gets the titles it shows only from
/internal/sources/titles, which names only documents the caller may read; the knowledge map opens them; older titles
are sealed by the housekeeping job. Synthetic data and made-up local keys only."""

from __future__ import annotations

from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.ai_gateway import FakeEmbedder, FakeProvider
from app.knowledge import graph, upkeep
from app.main import Services, create_app
from app.platform import Database, Logger, use_content_keys
from tests.conftest import TEST_CONTENT_KEYS, World, make_settings, make_world, mint, needs_db, tenant_filter
from tests.integration.helpers import company_document

pytestmark = [pytest.mark.db, needs_db]

TITLE = "Cooling tower handbook of the north plant"
SECRET = "Board minutes of the north plant"
TEXT = "Cooling tower CT-2. Before the summer start-up, the drift eliminators are washed and the fan belt is tensioned."


def titles(db: Database, world: World, ids: list[str], spec: dict[str, Any], actor: dict[str, str] | None = None) -> Any:
    """What the API gets, through the service, with a token for this company and this filter."""
    services = Services(make_settings(), db, FakeProvider(), FakeEmbedder(), Logger("error"))
    extra = {"actor": actor, "roles": []} if actor else {}
    token = mint("source.titles", tenant_id=world.tenant_id, card_id=world.people["owner"].card_id,
                 person_id=None if actor else world.people["owner"].id, filter=spec, **extra)
    res = TestClient(create_app(services)).post("/internal/sources/titles", json={"ids": ids}, headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200, res.text
    return res.json()["titles"]


def test_titles_are_stored_sealed_and_given_only_for_documents_the_caller_may_read(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    open_doc = company_document(db, world, embedder, TEXT, title=TITLE, sensitivity=1)
    secret = company_document(db, world, embedder, "Synthetic board notes. The budget for the cooling tower is approved.",
                              title=SECRET, sensitivity=3)
    stored = admin.execute("SELECT title, title_sealed, sealed_key FROM sources WHERE id = %s", (open_doc,)).fetchone()
    assert stored["title"] is None and stored["sealed_key"] == "platform:1" and b"north plant" not in bytes(stored["title_sealed"])

    everything = tenant_filter(world.tenant_id, action="source:read")
    assert titles(db, world, [open_doc, secret], everything) == {open_doc: TITLE, secret: SECRET}
    level_1 = tenant_filter(world.tenant_id, max_sensitivity=1, action="source:read")
    assert titles(db, world, [open_doc, secret], level_1) == {open_doc: TITLE}          # the other one is not even mentioned
    key = {"kind": "api_key", "id": "00000000-0000-0000-0000-00000000000a"}
    assert titles(db, world, [open_doc], level_1, actor=key) == {open_doc: TITLE}       # a machine's key may read titles too
    other = make_world(admin)
    other_doc = company_document(db, other, embedder, "Synthetic notes of another company about its own pumps.", title="Other company")
    assert titles(db, world, [open_doc, other_doc], everything) == {open_doc: TITLE}  # another company's id names nothing
    assert titles(db, world, [open_doc], {"v": 1}) == {}                               # a malformed filter reads nothing


def test_titles_written_before_are_sealed_by_housekeeping_and_still_shown(db: Database, world: World, embedder: FakeEmbedder,
                                                                         admin: psycopg.Connection[dict[str, Any]]) -> None:
    use_content_keys(None)                                   # as before this step
    try:
        doc = company_document(db, world, embedder, TEXT, title=TITLE)
    finally:
        use_content_keys(TEST_CONTENT_KEYS)
    assert admin.execute("SELECT title FROM sources WHERE id = %s", (doc,)).fetchone()["title"] == TITLE
    spec = tenant_filter(world.tenant_id, action="source:read")
    assert titles(db, world, [doc], spec) == {doc: TITLE}

    done = upkeep.seal_existing(db, world.tenant_id, batch=1)
    assert (done["sealed_document_titles"], done["readable_document_titles"]) == (1, 0)
    stored = admin.execute("SELECT title, title_sealed IS NOT NULL AS sealed FROM sources WHERE id = %s", (doc,)).fetchone()
    assert (stored["title"], stored["sealed"]) == (None, True)
    assert titles(db, world, [doc], spec) == {doc: TITLE}
    around = graph.neighbourhood(db, world.ctx("owner", "graph.read", filter=tenant_filter(world.tenant_id),
                                               topic_filter=tenant_filter(world.tenant_id, action="topic:read")), "source", doc)
    assert around["node"]["label"] == TITLE
    assert upkeep.seal_existing(db, world.tenant_id)["sealed_document_titles"] == 0
