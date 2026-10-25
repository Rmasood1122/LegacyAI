"""Decision D41, step 6 part 4b (first half): topic names and descriptions are written and read only by this service.
Creating, changing and applying a template happen here (the API checked the caller's right); the API gets the names
of the topics it lists from /internal/topics/texts, only for topics the caller may read. Synthetic data only."""

from __future__ import annotations

from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.ai_gateway import FakeEmbedder, FakeProvider
from app.capture import topics
from app.capture.topics import TopicRefused
from app.main import Services, create_app
from app.platform import Database, Logger
from tests.conftest import World, make_settings, make_world, mint, needs_db, tenant_filter

pytestmark = [pytest.mark.db, needs_db]


def stored(admin: psycopg.Connection[dict[str, Any]], topic_id: str) -> dict[str, Any]:
    return admin.execute("""SELECT name, description, status, origin, created_by_card_id::text AS card, embedding IS NOT NULL AS embedded
                              FROM topics WHERE id = %s""", (topic_id,)).fetchone()


def test_a_topic_made_by_a_person_is_active_has_its_vector_and_a_name_is_used_once(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    ctx = world.ctx("owner", "topic.create")
    made = topics.create(db, ctx, embedder, name="Boiler blowdown", description="Daily blowdown of the boiler", department_id=None,
                         sensitivity=1)
    assert made["name"] == "Boiler blowdown" and made["status"] == "active" and made["origin"] == "admin" and made["sensitivity"] == 1
    assert stored(admin, made["id"]) == {"name": "Boiler blowdown", "description": "Daily blowdown of the boiler", "status": "active",
                                         "origin": "admin", "card": world.people["owner"].card_id, "embedded": True}
    with pytest.raises(TopicRefused) as refused:
        topics.create(db, ctx, embedder, name="BOILER BLOWDOWN", description="", department_id=None, sensitivity=0)
    assert (refused.value.code, refused.value.status) == ("duplicate_topic", 409)


def test_changing_a_topic_checks_the_status_move_and_the_name(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    ctx = world.ctx("owner", "topic.update")
    first = topics.create(db, ctx, embedder, name="Feed pump", description="", department_id=None, sensitivity=0)
    second = topics.create(db, ctx, embedder, name="Cooling tower", description="", department_id=None, sensitivity=0)
    before = admin.execute("SELECT embedding::text AS e FROM topics WHERE id = %s", (first["id"],)).fetchone()["e"]
    changed = topics.update(db, ctx, embedder, first["id"], name=None, description="Weekly check of the feed pump", status=None)
    assert changed["name"] == "Feed pump" and changed["description"] == "Weekly check of the feed pump"
    assert admin.execute("SELECT embedding::text AS e FROM topics WHERE id = %s", (first["id"],)).fetchone()["e"] != before   # vector again
    with pytest.raises(TopicRefused) as duplicate:
        topics.update(db, ctx, embedder, first["id"], name="cooling TOWER", description=None, status=None)
    assert duplicate.value.code == "duplicate_topic"
    assert stored(admin, first["id"])["name"] == "Feed pump"                       # nothing changed
    assert topics.update(db, ctx, embedder, second["id"], name=None, description=None, status="retired")["status"] == "retired"
    with pytest.raises(TopicRefused) as back:
        topics.update(db, ctx, embedder, second["id"], name=None, description=None, status="active")
    assert back.value.code == "illegal_transition"
    with pytest.raises(TopicRefused) as missing:
        topics.update(db, ctx, embedder, "00000000-0000-0000-0000-000000000000", name="x", description=None, status=None)
    assert missing.value.status == 404


def test_a_template_adds_what_is_missing_and_uses_only_existing_topics_the_caller_may_read(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    owner = world.ctx("owner", "topic.create")
    visible = topics.create(db, owner, embedder, name="Lubrication", description="Our own wording", department_id=None, sensitivity=0)
    topics.create(db, owner, embedder, name="Isolation", description="", department_id=None, sensitivity=3)
    retired = topics.create(db, owner, embedder, name="Spares", description="", department_id=None, sensitivity=0)
    topics.update(db, owner, embedder, retired["id"], name=None, description=None, status="retired")
    admin.execute("UPDATE topics SET embedding = NULL, embedding_model = NULL WHERE id = %s", (visible["id"],))   # an interrupted earlier run

    entries = [{"key": "lubrication", "name": "lubrication", "description": "template wording"},
               {"key": "isolation", "name": "Isolation", "description": ""},
               {"key": "spares", "name": "Spares", "description": ""},
               {"key": "preventive", "name": "Preventive maintenance", "description": "Planned work"}]
    level_1 = world.ctx("owner", "topic.template", filter=tenant_filter(world.tenant_id, max_sensitivity=1, action="topic:read"))
    result = {r["key"]: r for r in topics.apply_template(db, level_1, embedder, entries)}
    assert result["lubrication"] == {"key": "lubrication", "id": visible["id"], "created": False}
    assert result["isolation"] == {"key": "isolation", "id": None, "created": False}       # exists, but not for this caller
    assert result["spares"] == {"key": "spares", "id": None, "created": False}             # retired: not revived
    assert result["preventive"]["created"] is True
    kept = stored(admin, visible["id"])
    assert (kept["name"], kept["description"], kept["embedded"]) == ("Lubrication", "Our own wording", True)   # unchanged; vector given
    assert stored(admin, result["preventive"]["id"])["embedded"] is True
    again = topics.apply_template(db, level_1, embedder, entries)
    assert [r["created"] for r in again] == [False, False, False, False]


def test_names_are_given_only_for_topics_the_caller_may_read_also_to_a_machines_key(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    owner = world.ctx("owner", "topic.create")
    open_topic = topics.create(db, owner, embedder, name="Start-up", description="Line start-up", department_id=None, sensitivity=0)
    secret = topics.create(db, owner, embedder, name="Board matters", description="", department_id=None, sensitivity=3)
    other = make_world(admin)
    theirs = topics.create(db, other.ctx("owner", "topic.create"), embedder, name="Their topic", description="", department_id=None, sensitivity=0)

    services = Services(make_settings(), db, FakeProvider(), FakeEmbedder(), Logger("error"))
    client = TestClient(create_app(services))

    def texts(ids: list[str], spec: dict[str, Any], actor: dict[str, str] | None = None) -> Any:
        extra = {"actor": actor, "roles": []} if actor else {}
        token = mint("topic.texts", tenant_id=world.tenant_id, card_id=world.people["owner"].card_id,
                     person_id=None if actor else world.people["owner"].id, filter=spec, **extra)
        res = client.post("/internal/topics/texts", json={"ids": ids}, headers={"Authorization": f"Bearer {token}"})
        assert res.status_code == 200, res.text
        return res.json()["topics"]

    ids = [open_topic["id"], secret["id"], theirs["id"]]
    everything = tenant_filter(world.tenant_id, action="topic:read")
    assert texts(ids, everything) == {open_topic["id"]: {"name": "Start-up", "description": "Line start-up"},
                                      secret["id"]: {"name": "Board matters", "description": ""}}
    level_1 = tenant_filter(world.tenant_id, max_sensitivity=1, action="topic:read")
    key = {"kind": "api_key", "id": "00000000-0000-0000-0000-00000000000a"}
    assert texts(ids, level_1, actor=key) == {open_topic["id"]: {"name": "Start-up", "description": "Line start-up"}}
    assert texts(ids, {"v": 1}) == {}                                              # a malformed filter reads nothing


def test_the_database_still_lets_this_service_add_only_proposals_or_a_topic_a_person_made(
        db: Database, world: World) -> None:
    with db.tenant_tx(world.tenant_id) as cur, pytest.raises(psycopg.errors.InsufficientPrivilege):
        cur.execute("INSERT INTO topics (tenant_id, name, origin, status) VALUES (%s, 'Nobody made this', 'admin', 'active')", (world.tenant_id,))
