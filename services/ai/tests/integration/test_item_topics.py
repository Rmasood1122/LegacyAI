"""A reviewer links an item to topics (docs/phase2/05: "a reviewer can add or remove a link, and manual links win"),
and the expert-question list is read a page at a time."""

from __future__ import annotations

from typing import Any

import psycopg
import pytest

from app.ai_gateway import FakeEmbedder, Gateway
from app.capture.filters import topic_condition
from app.capture.gaps import gap_report
from app.knowledge import expert, items, readiness, reads
from app.platform import Database
from tests.conftest import World, give_consent, make_world, needs_db, tenant_filter
from tests.integration.helpers import verified_item

pytestmark = [pytest.mark.db, needs_db]

ROLE = "Boiler operator"
BODY = "Lift each synthetic relief valve lever monthly until steam escapes, then release it slowly."


def make_topic(admin: psycopg.Connection[dict[str, Any]], tenant_id: str, name: str, *, status: str = "active", sensitivity: int = 0) -> str:
    """What the API does for an admin: the topic and its place in the job role."""
    tid = str(admin.execute("""INSERT INTO topics (tenant_id, name, description, origin, status, sensitivity)
                               VALUES (%s, %s, %s, 'admin', %s, %s) RETURNING id""", (tenant_id, name, f"about {name}", status, sensitivity)).fetchone()["id"])
    admin.execute("INSERT INTO role_topic_maps (tenant_id, job_role, topic_id, required, importance) VALUES (%s, %s, %s, true, 3)",
                  (tenant_id, ROLE, tid))
    return tid


def may_read_topics(world: World, max_sensitivity: int = 3, only_verified: bool = False) -> dict[str, Any]:
    """The token's topic filter: what the API sends for the permission topic:read."""
    return tenant_filter(world.tenant_id, max_sensitivity=max_sensitivity, only_verified=only_verified, action="topic:read")


def reviewer_ctx(world: World, item: str, **topic_over: Any) -> Any:
    return world.ctx("reviewer", "item.topics", subject=item, topic_filter=may_read_topics(world, **topic_over))


def links(admin: psycopg.Connection[dict[str, Any]], item_id: str) -> list[tuple[str, str]]:
    rows = admin.execute("SELECT topic_id::text AS t, link_source FROM knowledge_item_topics WHERE item_id = %s ORDER BY topic_id", (item_id,)).fetchall()
    return [(r["t"], r["link_source"]) for r in rows]


def test_the_given_list_replaces_every_link_and_is_written_to_the_audit_log(db: Database, world: World, embedder: FakeEmbedder,
                                                                           admin: psycopg.Connection[dict[str, Any]]) -> None:
    item = verified_item(db, world, embedder, BODY)
    valves, pumps = make_topic(admin, world.tenant_id, "Relief valves"), make_topic(admin, world.tenant_id, "Pumps")
    # a link a similarity run made earlier
    admin.execute("INSERT INTO knowledge_item_topics (tenant_id, item_id, topic_id, link_source, score) VALUES (%s, %s, %s, 'similarity', 0.9)",
                  (world.tenant_id, item, pumps))

    out = items.set_topics(db, reviewer_ctx(world, item), item, [valves, valves])
    assert out == [{"topic_id": valves, "name": "Relief valves", "link_source": "reviewer"}]
    assert links(admin, item) == [(valves, "reviewer")]          # the similarity link the reviewer left out is gone
    # the log says which topics the item was taken out of and put into (ids only), under the action of the permission used
    audit = admin.execute("""SELECT reason_code, resource_id, details::jsonb AS d FROM audit_log
                              WHERE tenant_id = %s AND action = 'knowledge:label' AND reason_code LIKE 'ITEM_TOPIC%%' ORDER BY seq""",
                          (world.tenant_id,)).fetchall()
    assert [(a["reason_code"], a["resource_id"], a["d"].get("count"), a["d"].get("topic_id"), a["d"].get("changed")) for a in audit] == [
        ("ITEM_TOPICS_SET", item, 1, None, None), ("ITEM_TOPIC_UNLINKED", item, None, pumps, "removed"), ("ITEM_TOPIC_LINKED", item, None, valves, "added")]
    # saying the same again changes nothing and logs no link change
    items.set_topics(db, reviewer_ctx(world, item), item, [valves])
    again = admin.execute("SELECT count(*) AS n FROM audit_log WHERE tenant_id = %s AND reason_code IN ('ITEM_TOPIC_LINKED', 'ITEM_TOPIC_UNLINKED')",
                          (world.tenant_id,)).fetchone()["n"]
    assert again == 2

    # the item's status is untouched (a topic link is not a change of content) and the gap report now counts it
    assert admin.execute("SELECT status FROM knowledge_items WHERE id = %s", (item,)).fetchone()["status"] == "verified"
    with db.tenant_tx(world.tenant_id) as cur:
        spec = tenant_filter(world.tenant_id)
        report = {g.topic_id: g for g in gap_report(cur, tenant_id=world.tenant_id, job_role=ROLE, item_spec=spec, topic_spec=spec)}
    assert report[valves].verified_items == 1 and report[pumps].label == "uncovered"

    assert items.set_topics(db, reviewer_ctx(world, item), item, []) == []
    assert links(admin, item) == []


def test_unknown_retired_and_other_company_topics_are_refused_and_nothing_changes(db: Database, world: World, embedder: FakeEmbedder,
                                                                                 admin: psycopg.Connection[dict[str, Any]]) -> None:
    item = verified_item(db, world, embedder, BODY)
    valves = make_topic(admin, world.tenant_id, "Relief valves")
    retired = make_topic(admin, world.tenant_id, "Old boilers", status="retired")
    other = make_world(admin, people=("owner",))
    foreign = make_topic(admin, other.tenant_id, "Their topic")
    ctx = reviewer_ctx(world, item)
    items.set_topics(db, ctx, item, [valves])
    for bad in (retired, foreign, "00000000-0000-7000-8000-000000000000"):
        with pytest.raises(items.ItemRefused) as exc:
            items.set_topics(db, ctx, item, [valves, bad])
        assert (exc.value.code, exc.value.status) == ("unknown_topic", 422)
    with pytest.raises(items.ItemRefused) as exc:
        items.set_topics(db, ctx, item, [f"00000000-0000-7000-8000-{n:012d}" for n in range(21)])
    assert exc.value.code == "too_many_topics"
    assert links(admin, item) == [(valves, "reviewer")]

    # an item of another company is "not found", whatever topics are named
    their_item = verified_item(db, make_world(admin), embedder, BODY)
    with pytest.raises(items.ItemRefused) as exc:
        items.set_topics(db, reviewer_ctx(world, their_item), their_item, [valves])
    assert (exc.value.code, exc.value.status) == ("not_found", 404)


def test_reading_an_item_shows_only_the_topics_the_reader_may_see(db: Database, world: World, embedder: FakeEmbedder,
                                                                 admin: psycopg.Connection[dict[str, Any]]) -> None:
    item = verified_item(db, world, embedder, BODY)
    public, internal = make_topic(admin, world.tenant_id, "Relief valves"), make_topic(admin, world.tenant_id, "Shutdown plans", sensitivity=2)
    items.set_topics(db, reviewer_ctx(world, item), item, [public, internal])

    # a reviewer who may not read the restricted topic neither sees nor removes that link
    low_ctx = reviewer_ctx(world, item, max_sensitivity=1)
    assert [t["name"] for t in items.set_topics(db, low_ctx, item, [])] == []
    assert links(admin, item) == [(internal, "reviewer")]
    with pytest.raises(items.ItemRefused) as exc:   # and cannot name it either: for this reviewer it does not exist
        items.set_topics(db, low_ctx, item, [internal])
    assert exc.value.code == "unknown_topic"
    # a token without a usable topic filter can link nothing: none at all, a malformed one, or the filter of another permission
    for unusable in (None, {"v": 1}, tenant_filter(world.tenant_id)):
        with pytest.raises(items.ItemRefused):
            items.set_topics(db, world.ctx("reviewer", "item.topics", subject=item, topic_filter=unusable), item, [public])
        assert items.set_topics(db, world.ctx("reviewer", "item.topics", subject=item, topic_filter=unusable), item, []) == []
    assert links(admin, item) == [(internal, "reviewer")]      # and an empty list from such a token removed nothing
    # a reviewer whose filters carry "verified only" (level 0) can still link the topics it may read
    assert [t["name"] for t in items.set_topics(db, reviewer_ctx(world, item, max_sensitivity=0, only_verified=True), item, [public])] == ["Relief valves"]
    items.set_topics(db, reviewer_ctx(world, item), item, [public, internal])

    full = reads.get_item(db, world.ctx("owner", "item.read", subject=item, topic_filter=may_read_topics(world)), item)
    assert [(t["name"], t["link_source"]) for t in full["topics"]] == [("Relief valves", "reviewer"), ("Shutdown plans", "reviewer")]
    # The right to read KNOWLEDGE up to a level says nothing about topics: this reader may read the item (knowledge filter,
    # level 3) but topics only at level 0 - it must not learn the name of the level-2 topic.
    narrow = reads.get_item(db, world.ctx("learner", "item.read", subject=item, topic_filter=may_read_topics(world, max_sensitivity=0)), item)
    assert [t["name"] for t in narrow["topics"]] == ["Relief valves"]
    # a learner ("verified only" on both filters) sees the topics it may read, not an empty list
    learner = reads.get_item(db, world.ctx("learner", "item.read", subject=item, filter=tenant_filter(world.tenant_id, only_verified=True),
                                           topic_filter=may_read_topics(world, max_sensitivity=0, only_verified=True)), item)
    assert [t["name"] for t in learner["topics"]] == ["Relief valves"]
    # without a topic filter in the token, no topic is shown at all
    assert reads.get_item(db, world.ctx("owner", "item.read", subject=item), item)["topics"] == []


def test_expert_questions_come_newest_first_a_page_at_a_time(db: Database, world: World, admin: psycopg.Connection[dict[str, Any]]) -> None:
    give_consent(admin, world, "expert", "named_expert")
    spec = tenant_filter(world.tenant_id, action="expert_question:read")
    made = [expert.create_question(db, world.ctx("learner", "expert_question.create"), expert_person_id=world.people["expert"].id,
                                   question=f"Synthetic question number {n} about the relief valve?", department_id=None, sensitivity=1)["id"]
            for n in range(3)]
    ctx = world.ctx("learner", "expert_question.list", filter=spec)
    first = reads.list_expert_questions(db, ctx, box="asked", limit=2)
    assert [q["id"] for q in first["items"]] == [made[2], made[1]] and first["next_cursor"] == made[1]
    second = reads.list_expert_questions(db, ctx, box="asked", limit=2, after=first["next_cursor"])
    assert [q["id"] for q in second["items"]] == [made[0]] and second["next_cursor"] is None


def test_a_generated_question_takes_the_topic_a_reviewer_chose_over_a_similarity_link(
        db: Database, world: World, embedder: FakeEmbedder, gateway: Gateway, admin: psycopg.Connection[dict[str, Any]]) -> None:
    """docs/phase2/05: "manual links win". The similarity link has a score, the reviewer's has none."""
    item = verified_item(db, world, embedder, BODY, sensitivity=0)
    guessed, chosen, also = (make_topic(admin, world.tenant_id, n) for n in ("Pumps", "Relief valves", "Boilers"))
    items.set_topics(db, reviewer_ctx(world, item), item, [chosen, also])
    # a later similarity run adds its own guess, with a high score
    admin.execute("INSERT INTO knowledge_item_topics (tenant_id, item_id, topic_id, link_source, score) VALUES (%s, %s, %s, 'similarity', 0.99)",
                  (world.tenant_id, item, guessed))
    assert sorted(links(admin, item)) == sorted([(guessed, "similarity"), (chosen, "reviewer"), (also, "reviewer")])
    made = readiness.generate(db, world.ctx("owner", "quiz.generate", approved=[item]), gateway, world.caller("owner"), "mcq")
    assert len(made["created"]) == 1
    topic_id = str(admin.execute("SELECT topic_id FROM quiz_items WHERE id = %s", (made["created"][0],)).fetchone()["topic_id"])
    assert topic_id == min(chosen, also)            # a reviewer's link, and of two reviewer links always the same one


def test_writing_back_what_was_read_changes_nothing_and_a_retired_link_is_never_in_the_way(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    """A link that stays keeps how it was made and its score; a link to a retired topic is not shown, not refused and not removed."""
    item = verified_item(db, world, embedder, BODY)
    valves, pumps = make_topic(admin, world.tenant_id, "Relief valves"), make_topic(admin, world.tenant_id, "Pumps")
    old = make_topic(admin, world.tenant_id, "Old boilers")
    for topic, score in ((valves, 0.9), (old, 0.8)):
        admin.execute("INSERT INTO knowledge_item_topics (tenant_id, item_id, topic_id, link_source, score) VALUES (%s, %s, %s, 'similarity', %s)",
                      (world.tenant_id, item, topic, score))
    admin.execute("UPDATE topics SET status = 'retired' WHERE id = %s", (old,))

    with db.tenant_tx(world.tenant_id) as cur:
        where, params = topic_condition(may_read_topics(world), world.tenant_id)
        read = items.item_topics(cur, world.tenant_id, item, where, params)
    assert [(t["topic_id"], t["link_source"]) for t in read] == [(valves, "similarity")]          # the retired link is left out

    # write back exactly what was read, plus one more
    out = items.set_topics(db, reviewer_ctx(world, item), item, [t["topic_id"] for t in read] + [pumps])
    assert sorted((t["topic_id"], t["link_source"]) for t in out) == sorted([(valves, "similarity"), (pumps, "reviewer")])
    rows = admin.execute("SELECT topic_id::text AS t, link_source, score FROM knowledge_item_topics WHERE item_id = %s", (item,)).fetchall()
    assert {(r["t"], r["link_source"]) for r in rows} == {(valves, "similarity"), (pumps, "reviewer"), (old, "similarity")}
    scores = {r["t"]: r["score"] for r in rows}
    assert scores[valves] == pytest.approx(0.9) and scores[old] == pytest.approx(0.8) and scores[pumps] is None
    linked = admin.execute("SELECT details::jsonb ->> 'topic_id' AS t FROM audit_log WHERE tenant_id = %s AND reason_code = 'ITEM_TOPIC_LINKED'",
                           (world.tenant_id,)).fetchall()
    assert [r["t"] for r in linked] == [pumps]                                                    # only the new link is logged as added

    # an empty list removes the visible links and still leaves the retired one alone
    assert items.set_topics(db, reviewer_ctx(world, item), item, []) == []
    assert links(admin, item) == [(old, "similarity")]
