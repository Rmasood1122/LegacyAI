"""Offline packs (feature 9, the founder's choices of 2026-10-27): what goes into the pack of a job role, and what never
does - unverified or stale knowledge, levels 2 and 3 whatever the caller may read, knowledge the caller may not read,
knowledge outside the role's active topics. Synthetic data only."""

from __future__ import annotations

from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.ai_gateway import FakeEmbedder, FakeProvider
from app.capture import topics
from app.knowledge import items, offline
from app.main import Services, create_app
from app.platform import Database, Logger
from tests.conftest import World, make_settings, mint, needs_db, tenant_filter
from tests.integration.helpers import verified_item

pytestmark = [pytest.mark.db, needs_db]

ROLE = "Boiler operator"
TOPIC_READ = "topic:read"


def setup_role(db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> dict[str, Any]:
    owner = world.ctx("owner", "topic.create")
    valves = topics.create(db, owner, embedder, name="Relief valves", description="", department_id=None, sensitivity=0)["id"]
    water = topics.create(db, owner, embedder, name="Boiler water", description="", department_id=None, sensitivity=0)["id"]
    other = topics.create(db, owner, embedder, name="Forklifts", description="", department_id=None, sensitivity=0)["id"]
    old = topics.create(db, owner, embedder, name="Old practice", description="", department_id=None, sensitivity=0)["id"]
    with admin.transaction():
        for topic in (valves, water, old):
            admin.execute("INSERT INTO role_topic_maps (tenant_id, job_role, topic_id) VALUES (%s, %s, %s)", (world.tenant_id, ROLE, topic))
    topics.update(db, world.ctx("owner", "topic.update"), embedder, old, name=None, description=None, status="retired")
    made = {
        "open": verified_item(db, world, embedder, "Lift each relief valve lever monthly until steam escapes.", title="Relief valve check", sensitivity=0),
        "level1": verified_item(db, world, embedder, "Blow down the boiler for ten seconds each shift.", title="Blowdown", sensitivity=1),
        "level2": verified_item(db, world, embedder, "The relief valve set point of the north boiler is confidential.", title="Set points", sensitivity=2),
        "stale": verified_item(db, world, embedder, "An old way of testing relief valves.", title="Old valve test", sensitivity=0),
        "elsewhere": verified_item(db, world, embedder, "Forklift brakes are tested daily.", title="Forklift brakes", sensitivity=0),
        "retired_topic": verified_item(db, world, embedder, "A practice only under a retired topic.", title="Retired practice", sensitivity=0),
    }
    made["draft"] = items.write_manual(db, world.ctx("expert", "item.write"), title="Unverified tip", body="Not yet checked.", department_id=None,
                                       sensitivity=0, contributor_person_id=None)
    links = {"open": [valves], "level1": [water, valves], "level2": [valves], "stale": [valves], "elsewhere": [other],
             "retired_topic": [old], "draft": [valves]}
    with admin.transaction():
        for key, topic_ids in links.items():
            for topic in topic_ids:
                admin.execute("INSERT INTO knowledge_item_topics (tenant_id, item_id, topic_id, link_source) VALUES (%s, %s, %s, 'reviewer')",
                              (world.tenant_id, made[key], topic))
        admin.execute("UPDATE knowledge_items SET stale_after = now() - interval '1 day' WHERE id = %s", (made["stale"],))
    return {"items": made, "valves": valves, "water": water}


def test_a_pack_holds_only_verified_current_level_0_and_1_knowledge_of_the_role_opened(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    role = setup_role(db, world, embedder, admin)
    made = role["items"]
    everything = world.ctx("owner", "offline.pack", filter=tenant_filter(world.tenant_id), topic_filter=tenant_filter(world.tenant_id, action=TOPIC_READ))
    got = offline.pack(db, everything, ROLE)
    assert [t["name"] for t in got["topics"]] == ["Boiler water", "Relief valves"]          # active topics only, sorted by name
    by_id = {i["id"]: i for i in got["items"]}
    assert set(by_id) == {made["open"], made["level1"]}                                       # level 2, stale, draft, other topics: out
    assert by_id[made["open"]]["title"] == "Relief valve check"
    assert by_id[made["open"]]["body"] == "Lift each relief valve lever monthly until steam escapes."
    assert sorted(by_id[made["level1"]]["topic_ids"]) == sorted([role["water"], role["valves"]])
    assert all(i["status"] in ("verified", "corrected") and i["sensitivity"] <= 1 and i["verified_at"] for i in got["items"])
    assert got["truncated"] is False


def test_the_pack_is_narrowed_by_what_the_caller_may_read_and_capped(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]], monkeypatch: pytest.MonkeyPatch) -> None:
    made = setup_role(db, world, embedder, admin)["items"]
    topic_spec = tenant_filter(world.tenant_id, action=TOPIC_READ)
    level_0 = world.ctx("learner", "offline.pack", filter=tenant_filter(world.tenant_id, max_sensitivity=0, only_verified=True), topic_filter=topic_spec)
    assert [i["id"] for i in offline.pack(db, level_0, ROLE)["items"]] == [made["open"]]
    no_topics = world.ctx("learner", "offline.pack", filter=tenant_filter(world.tenant_id), topic_filter={"v": 1})
    assert offline.pack(db, no_topics, ROLE) == {"job_role": ROLE, "topics": [], "items": [], "truncated": False}
    assert offline.pack(db, world.ctx("owner", "offline.pack", filter=tenant_filter(world.tenant_id), topic_filter=topic_spec), "Nobody")["items"] == []
    monkeypatch.setattr(offline, "PACK_MAX_ITEMS", 1)
    capped = offline.pack(db, world.ctx("owner", "offline.pack", filter=tenant_filter(world.tenant_id), topic_filter=topic_spec), ROLE)
    assert len(capped["items"]) == 1 and capped["truncated"] is True


def test_the_service_answers_a_card_and_refuses_a_machines_key(db: Database, world: World, embedder: FakeEmbedder,
                                                              admin: psycopg.Connection[dict[str, Any]]) -> None:
    setup_role(db, world, embedder, admin)
    client = TestClient(create_app(Services(make_settings(), db, FakeProvider(), FakeEmbedder(), Logger("error"))))
    claims = {"filter": tenant_filter(world.tenant_id), "topic_filter": tenant_filter(world.tenant_id, action=TOPIC_READ)}
    card = mint("offline.pack", tenant_id=world.tenant_id, card_id=world.people["owner"].card_id, person_id=world.people["owner"].id, **claims)
    res = client.post("/internal/offline/pack", json={"job_role": ROLE}, headers={"Authorization": f"Bearer {card}"})
    assert res.status_code == 200, res.text
    assert len(res.json()["items"]) == 2
    key = mint("offline.pack", tenant_id=world.tenant_id, card_id=world.people["owner"].card_id, person_id=None,
               actor={"kind": "api_key", "id": "00000000-0000-0000-0000-00000000000a"}, roles=[], **claims)
    assert client.post("/internal/offline/pack", json={"job_role": ROLE}, headers={"Authorization": f"Bearer {key}"}).status_code == 401
