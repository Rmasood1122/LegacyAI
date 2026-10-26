"""Decision D41, step 6 part 4b (second half): a topic's name and description are stored sealed, a name is still used
only once per company in any case (readable and sealed rows alike), every screen of this service opens them, and the
housekeeping job seals the older ones. Synthetic data and made-up local keys only."""

from __future__ import annotations

from typing import Any

import psycopg
import pytest

from app.ai_gateway import FakeEmbedder
from app.capture import topics
from app.capture.gaps import gap_report
from app.capture.topics import TopicRefused
from app.knowledge import graph, items, upkeep
from app.platform import Database, use_content_keys
from tests.conftest import TEST_CONTENT_KEYS, World, needs_db, tenant_filter
from tests.integration.helpers import verified_item

pytestmark = [pytest.mark.db, needs_db]

READ = "topic:read"


def at_rest(admin: psycopg.Connection[dict[str, Any]], topic_id: str) -> dict[str, Any]:
    """Read by the superuser, outside the code under test."""
    row = admin.execute("""SELECT name, description, sealed_key, octet_length(name_hash) AS hash_bytes,
                                  name_sealed || description_sealed AS sealed FROM topics WHERE id = %s""", (topic_id,)).fetchone()
    sealed = bytes(row.pop("sealed") or b"")
    return {**row, "words_in_sealed_bytes": b"north plant" in sealed or b"Cooling" in sealed}


def readable_topic(db: Database, world: World, embedder: FakeEmbedder, name: str, description: str = "") -> str:
    """A topic written as before this step (content keys off: stored readable)."""
    use_content_keys(None)
    try:
        return str(topics.create(db, world.ctx("owner", "topic.create"), embedder, name=name, description=description, department_id=None,
                                 sensitivity=0)["id"])
    finally:
        use_content_keys(TEST_CONTENT_KEYS)


def test_name_and_description_are_stored_sealed_and_given_back_opened(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    made = topics.create(db, world.ctx("owner", "topic.create"), embedder, name="Cooling tower", description="Drift eliminators of the north plant",
                         department_id=None, sensitivity=0)
    assert at_rest(admin, made["id"]) == {"name": None, "description": None, "sealed_key": "platform:1", "hash_bytes": 32,
                                          "words_in_sealed_bytes": False}
    assert (made["name"], made["description"]) == ("Cooling tower", "Drift eliminators of the north plant")
    spec = tenant_filter(world.tenant_id, action=READ)
    assert topics.texts(db, world.ctx("owner", "topic.texts", filter=spec), [made["id"]]) == {
        made["id"]: {"name": "Cooling tower", "description": "Drift eliminators of the north plant"}}
    renamed = topics.update(db, world.ctx("owner", "topic.update"), embedder, made["id"], name="Cooling towers", description=None, status=None)
    assert (renamed["name"], renamed["description"]) == ("Cooling towers", "Drift eliminators of the north plant")   # the rest is kept
    assert at_rest(admin, made["id"])["name"] is None


def test_a_name_is_used_once_in_any_case_whether_the_other_is_readable_or_sealed(
        db: Database, world: World, embedder: FakeEmbedder) -> None:
    owner = world.ctx("owner", "topic.create")
    readable_topic(db, world, embedder, "Relief valves")
    sealed = topics.create(db, owner, embedder, name="Feed pump", description="", department_id=None, sensitivity=0)
    for taken in ("RELIEF VALVES", "feed PUMP"):
        with pytest.raises(TopicRefused) as refused:
            topics.create(db, owner, embedder, name=taken, description="", department_id=None, sensitivity=0)
        assert refused.value.code == "duplicate_topic"
    other = topics.create(db, owner, embedder, name="Spares", description="", department_id=None, sensitivity=0)
    with pytest.raises(TopicRefused):
        topics.update(db, world.ctx("owner", "topic.update"), embedder, other["id"], name="FEED pump", description=None, status=None)
    # the same name in another case on the SAME topic is a rename, not a clash
    assert topics.update(db, world.ctx("owner", "topic.update"), embedder, sealed["id"], name="Feed Pump", description=None,
                         status=None)["name"] == "Feed Pump"
    # a template finds the existing topic by its name, sealed or readable
    found = topics.apply_template(db, world.ctx("owner", "topic.template", filter=tenant_filter(world.tenant_id, action=READ)), embedder,
                                  [{"key": "pump", "name": "feed pump", "description": ""}, {"key": "valves", "name": "relief valves", "description": ""}])
    assert [(f["id"] is not None, f["created"]) for f in found] == [(True, False), (True, False)]


def test_every_screen_of_this_service_opens_the_names(db: Database, world: World, embedder: FakeEmbedder,
                                                       admin: psycopg.Connection[dict[str, Any]]) -> None:
    owner = world.ctx("owner", "topic.create")
    second = topics.create(db, owner, embedder, name="Valves", description="", department_id=None, sensitivity=0)
    first = topics.create(db, owner, embedder, name="Boiler start-up", description="", department_id=None, sensitivity=0)
    item = verified_item(db, world, embedder, "Before the summer start-up, the boiler is vented at the top drain.", sensitivity=0)
    spec = tenant_filter(world.tenant_id, action=READ)
    linked = items.set_topics(db, world.ctx("owner", "item.topics", topic_filter=spec), item, [second["id"], first["id"]])
    assert [t["name"] for t in linked] == ["Boiler start-up", "Valves"]                      # sorted once opened
    with admin.transaction():
        admin.execute("INSERT INTO role_topic_maps (tenant_id, job_role, topic_id) VALUES (%s, 'Boiler operator', %s), (%s, 'Boiler operator', %s)",
                      (world.tenant_id, first["id"], world.tenant_id, second["id"]))
    with db.tenant_tx(world.tenant_id) as cur:
        gaps = gap_report(cur, tenant_id=world.tenant_id, job_role="Boiler operator", item_spec=tenant_filter(world.tenant_id), topic_spec=spec)
    assert sorted(g.name for g in gaps) == ["Boiler start-up", "Valves"]
    read = world.ctx("owner", "graph.read", filter=tenant_filter(world.tenant_id), topic_filter=spec)
    assert graph.neighbourhood(db, read, "topic", first["id"])["node"]["label"] == "Boiler start-up"
    around_item = graph.neighbourhood(db, read, "item", item)
    assert [n["node"]["label"] for g in around_item["neighbours"] if g["group"] == "topics" for n in g["nodes"]] == ["Boiler start-up", "Valves"]
    around_role = graph.neighbourhood(db, read, "job_role", "Boiler operator")
    assert [n["node"]["label"] for g in around_role["neighbours"] if g["group"] == "topics" for n in g["nodes"]] == ["Boiler start-up", "Valves"]


def test_names_written_before_are_sealed_by_housekeeping_and_stay_unique(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    old = readable_topic(db, world, embedder, "Lubrication", "Our own wording")
    assert at_rest(admin, old)["name"] == "Lubrication"
    done = upkeep.seal_existing(db, world.tenant_id, batch=1)
    assert (done["sealed_topics"], done["readable_topics"]) == (1, 0)
    assert at_rest(admin, old) == {"name": None, "description": None, "sealed_key": "platform:1", "hash_bytes": 32, "words_in_sealed_bytes": False}
    spec = tenant_filter(world.tenant_id, action=READ)
    assert topics.texts(db, world.ctx("owner", "topic.texts", filter=spec), [old]) == {old: {"name": "Lubrication", "description": "Our own wording"}}
    with pytest.raises(TopicRefused):
        topics.create(db, world.ctx("owner", "topic.create"), embedder, name="LUBRICATION", description="", department_id=None, sensitivity=0)
    assert upkeep.seal_existing(db, world.tenant_id)["sealed_topics"] == 0
