"""Activity numbers (feature 27) and the knowledge graph (feature 30): what is counted and shown passes the caller's
own filters, and test results of a small group are not shown (docs/phase4/03)."""

from __future__ import annotations

import uuid
from typing import Any

import psycopg
import pytest

from app.ai_gateway import FakeEmbedder
from app.knowledge import analytics, graph
from app.platform import Database
from tests.conftest import World, give_consent, needs_db, tenant_filter
from tests.integration.helpers import company_document, verified_item

pytestmark = [pytest.mark.db, needs_db]

ROLE = "Boiler operator"


def topic(admin: psycopg.Connection[dict[str, Any]], tenant_id: str, name: str, *, sensitivity: int = 0, status: str = "active") -> str:
    tid = str(admin.execute("""INSERT INTO topics (tenant_id, name, description, origin, status, sensitivity)
                               VALUES (%s, %s, %s, 'admin', %s, %s) RETURNING id""", (tenant_id, name, f"about {name}", status, sensitivity)).fetchone()["id"])
    admin.execute("INSERT INTO role_topic_maps (tenant_id, job_role, topic_id, required, importance) VALUES (%s, %s, %s, true, 2)",
                  (tenant_id, ROLE, tid))
    return tid


def link(admin: psycopg.Connection[dict[str, Any]], tenant_id: str, item: str, topic_id: str) -> None:
    admin.execute("INSERT INTO knowledge_item_topics (tenant_id, item_id, topic_id, link_source) VALUES (%s, %s, %s, 'reviewer')",
                  (tenant_id, item, topic_id))


def reader(world: World, action: str, level: int, *, interviews: int | None = 3, results: str | None = "tenant") -> Any:
    """A caller whose rights to read knowledge AND topics end at `level`.
    `interviews`: the level of its interview:read (None = it does not hold the permission).
    `results`: "tenant" or "own" for its quiz:read_results (None = it does not hold the permission)."""
    filters: dict[str, dict[str, Any]] = {}
    if interviews is not None:
        filters["interview:read"] = tenant_filter(world.tenant_id, max_sensitivity=interviews, action="interview:read")
    if results == "tenant":
        filters["quiz:read_results"] = tenant_filter(world.tenant_id, action="quiz:read_results")
    elif results == "own":
        me = world.people["owner"]
        filters["quiz:read_results"] = {"v": 1, "tenant_id": world.tenant_id, "action": "quiz:read_results", "nothing": False, "only_verified": False,
                                        "any_of": [{"scope": "own", "max_sensitivity": 3, "owner_person_id": me.id, "owner_card_id": me.card_id}]}
    return world.ctx("owner", action, filter=tenant_filter(world.tenant_id, max_sensitivity=level),
                     topic_filter=tenant_filter(world.tenant_id, max_sensitivity=level, action="topic:read"), filters=filters)


def ids(nodes: list[dict[str, Any]]) -> set[str]:
    return {n["id"] for n in nodes}


def group(around: dict[str, Any], name: str) -> dict[str, Any]:
    return next(g for g in around["neighbours"] if g["group"] == name)


def neighbour_ids(around: dict[str, Any], name: str) -> set[str]:
    return {n["node"]["id"] for n in group(around, name)["nodes"]}


def graded_attempt(admin: psycopg.Connection[dict[str, Any]], world: World, who: str, role: str, when: str) -> None:
    """A graded test of `who`; `when` is an SQL expression (written here, in the test) for the moment it was handed in and graded."""
    p = world.people[who]
    # the database lets an attempt start only "in progress" and move on step by step (quiz_attempts_guard)
    attempt = admin.execute(
        f"""INSERT INTO quiz_attempts (tenant_id, learner_card_id, learner_person_id, owner_person_id, job_role, started_at, expires_at)
            VALUES (%s, %s, %s, %s, %s, {when} - interval '1 hour', {when} + interval '1 hour') RETURNING id""",
        (world.tenant_id, p.card_id, p.id, p.id, role)).fetchone()["id"]
    admin.execute(f"UPDATE quiz_attempts SET status = 'submitted', submitted_at = {when} WHERE id = %s", (attempt,))
    admin.execute(f"UPDATE quiz_attempts SET status = 'graded', graded_at = {when} WHERE id = %s", (attempt,))


# ---------------------------------------------------------------------------------------------- activity numbers

def test_items_and_documents_are_counted_through_the_callers_own_filter(db: Database, world: World, embedder: FakeEmbedder) -> None:
    verified_item(db, world, embedder, "Synthetic: the relief valve lever is lifted monthly.", sensitivity=1)
    verified_item(db, world, embedder, "Synthetic: the reserve code of the alarm panel is kept in the safe.", sensitivity=3)
    company_document(db, world, embedder, "Synthetic manual text about the boiler.", sensitivity=1)
    company_document(db, world, embedder, "Synthetic confidential sheet about the alarm panel.", title="Synthetic sheet", sensitivity=3)

    everything = analytics.activity(db, reader(world, "analytics.activity", 3), 3)
    limited = analytics.activity(db, reader(world, "analytics.activity", 1), 3)
    assert len(everything["months"]) == 3                       # every month of the range, also the empty ones, newest first
    assert everything["months"][0]["month_start"] > everything["months"][1]["month_start"]
    assert everything["items_now"]["verified"] == 2 and limited["items_now"]["verified"] == 1
    assert everything["months"][0]["items_captured"] == 2 and limited["months"][0]["items_captured"] == 1
    assert everything["months"][0]["items_verified"] == 2 and limited["months"][0]["items_verified"] == 1
    assert everything["months"][0]["documents_added"] == 2 and limited["months"][0]["documents_added"] == 1
    assert everything["months"][0]["median_hours_to_verify"] is not None
    assert everything["months"][1]["items_captured"] == 0 and everything["months"][1]["median_hours_to_verify"] is None
    # a caller with no filter at all gets no item and no document counted (fail closed)
    nothing = analytics.activity(db, world.ctx("owner", "analytics.activity", filter={"v": 1}), 3)
    assert nothing["items_now"] == {"verified": 0, "stale_items": 0, "not_yet_verified": 0}
    assert all(m["items_captured"] == 0 and m["documents_added"] == 0 for m in nothing["months"])


def test_interviews_are_counted_by_the_callers_right_to_read_interviews_and_are_null_without_it(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    consent = give_consent(admin, world, "expert", "own_words")
    owner = world.people["owner"]
    for level in (1, 3, 3):          # one interview about ordinary material, two about level-3 material
        source = company_document(db, world, embedder, f"Synthetic interview material at level {level}.", title=f"Interview {level}", sensitivity=level)
        # the database lets an interview start only as "invited" and move on step by step (interviews_guard)
        interview = admin.execute(
            """INSERT INTO interviews (tenant_id, expert_person_id, source_id, consent_id, job_role, max_turns, invited_by_card_id)
               VALUES (%s, %s, %s, %s, %s, 10, %s) RETURNING id""",
            (world.tenant_id, world.people["expert"].id, source, consent, ROLE, owner.card_id)).fetchone()["id"]
        admin.execute("UPDATE interviews SET status = 'active' WHERE id = %s", (interview,))
        admin.execute("UPDATE interviews SET status = 'completed', completed_at = now() WHERE id = %s", (interview,))

    def this_month(**rights: Any) -> Any:
        return analytics.activity(db, reader(world, "analytics.activity", 3, **rights), 1)["months"][0]["interviews_completed"]

    assert this_month(interviews=3) == 3
    # an Admin whose right to read interviews ends at level 1 is not told that level-3 capture happened, nor how much
    assert this_month(interviews=1) == 1
    # no right to read interviews at all: no number - not a zero and not the company total
    assert this_month(interviews=None) is None
    # a filter filed under the right name but built for another permission is not used
    wrong = world.ctx("owner", "analytics.activity", filters={"interview:read": tenant_filter(world.tenant_id, action="knowledge:read")})
    assert analytics.activity(db, wrong, 1)["months"][0]["interviews_completed"] is None


def test_test_results_need_five_people_one_fixed_window_and_the_right_to_read_the_whole_companys_results(
        db: Database, world: World, admin: psycopg.Connection[dict[str, Any]]) -> None:
    last_month = "(date_trunc('month', now()) - interval '10 days')"
    for who in world.people:                        # four people: below the minimum of five
        graded_attempt(admin, world, who, ROLE, last_month)
    graded_attempt(admin, world, "owner", ROLE, "now()")       # this month: outside the fixed window of complete months

    def table(months: int, **rights: Any) -> dict[str, Any]:
        return dict(analytics.activity(db, reader(world, "analytics.activity", 3, **rights), months)["job_role_results"])

    shown = table(2)
    assert (shown["state"], shown["minimum_group"], shown["truncated"]) == ("shown", 5, False)
    assert shown["rows"] == [{"job_role": ROLE, "state": "too_few_people", "people": None, "attempts": None, "mean_score": None}]
    # the window does not move with `months`: the same table whatever range is asked for, so two requests cannot be subtracted
    assert table(1) == shown == table(24)
    assert shown["window_end"] > shown["window_start"]
    # the count per month is not per person and stays - for a caller who may read results
    months = analytics.activity(db, reader(world, "analytics.activity", 3), 2)["months"]
    assert [m["tests_handed_in"] for m in months] == [1, len(world.people)]
    # results of its own tests only: no table, and the monthly count is only its own
    own = analytics.activity(db, reader(world, "analytics.activity", 3, results="own"), 2)
    assert own["job_role_results"]["state"] == "not_allowed" and own["job_role_results"]["rows"] == []
    assert [m["tests_handed_in"] for m in own["months"]] == [1, 1]
    # no right to read results at all: no table and no count
    none = analytics.activity(db, reader(world, "analytics.activity", 3, results=None), 2)
    assert none["job_role_results"]["state"] == "not_allowed"
    assert [m["tests_handed_in"] for m in none["months"]] == [None, None]


# ---------------------------------------------------------------------------------------------- the map

def test_the_neighbourhood_shows_only_what_the_caller_may_read_and_a_hidden_node_looks_like_a_missing_one(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    open_item = verified_item(db, world, embedder, "Synthetic: the relief valve lever is lifted monthly.", title="Synthetic valve test", sensitivity=1)
    secret_item = verified_item(db, world, embedder, "Synthetic: the reserve code is kept in the safe.", title="Synthetic reserve code", sensitivity=3)
    valves = topic(admin, world.tenant_id, "Relief valves")
    secret_topic = topic(admin, world.tenant_id, "Alarm panel codes", sensitivity=3)
    retired = topic(admin, world.tenant_id, "Old boiler", status="retired")
    for item in (open_item, secret_item):
        link(admin, world.tenant_id, item, valves)
    link(admin, world.tenant_id, open_item, secret_topic)
    link(admin, world.tenant_id, open_item, retired)

    full = graph.neighbourhood(db, reader(world, "graph.read", 3), "topic", valves)
    assert full["node"] == {"kind": "topic", "id": valves, "label": "Relief valves", "status": None}
    assert [g["group"] for g in full["neighbours"]] == ["items", "job_roles"]
    assert neighbour_ids(full, "items") == {open_item, secret_item}
    assert group(full, "items")["edge_kind"] == "item_topic" and group(full, "items")["truncated"] is False
    assert {n["origin"] for n in group(full, "items")["nodes"]} == {"reviewer"}         # how the link was made sits on the link
    assert [n["node"]["id"] for n in group(full, "job_roles")["nodes"]] == [ROLE]

    low = reader(world, "graph.read", 1)
    assert neighbour_ids(graph.neighbourhood(db, low, "topic", valves), "items") == {open_item}
    assert neighbour_ids(graph.neighbourhood(db, low, "item", open_item), "topics") == {valves}          # not the level-3 topic, not the retired one
    for kind, hidden in (("item", secret_item), ("topic", secret_topic), ("topic", retired), ("item", str(uuid.uuid4())), ("item", "not-an-id"),
                         ("source", str(uuid.uuid4())), ("job_role", "No such role")):
        with pytest.raises(graph.GraphRefused) as refused:
            graph.neighbourhood(db, low, kind, hidden)
        assert (refused.value.code, refused.value.status) == ("not_found", 404), (kind, hidden)
    assert neighbour_ids(graph.neighbourhood(db, low, "job_role", ROLE), "topics") == {valves}
    with pytest.raises(graph.GraphRefused):
        graph.neighbourhood(db, low, "person", str(uuid.uuid4()))                                         # people are not nodes


def test_the_export_holds_only_readable_nodes_every_edge_joins_two_of_them_and_it_is_recorded(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    open_item = verified_item(db, world, embedder, "Synthetic: the relief valve lever is lifted monthly.", sensitivity=1)
    secret_item = verified_item(db, world, embedder, "Synthetic: the reserve code is kept in the safe.", sensitivity=3)
    valves = topic(admin, world.tenant_id, "Relief valves")
    link(admin, world.tenant_id, open_item, valves)
    link(admin, world.tenant_id, secret_item, valves)

    low = graph.export(db, reader(world, "graph.export", 1))
    assert low["schema"] == "legacyai-knowledge-graph/1" and low["truncated"] is False
    assert low["limits"] == {"nodes_per_kind": 2000, "edges": 10000}
    assert open_item in ids(low["nodes"]) and secret_item not in ids(low["nodes"])
    refs = {(n["kind"], n["id"]) for n in low["nodes"]}
    assert {"kind": "item_topic", "from": {"kind": "item", "id": open_item}, "to": {"kind": "topic", "id": valves}, "origin": "reviewer"} in low["edges"]
    assert {"kind": "job_role_topic", "from": {"kind": "job_role", "id": ROLE}, "to": {"kind": "topic", "id": valves}, "origin": None} in low["edges"]
    for e in low["edges"]:
        assert secret_item not in (e["from"]["id"], e["to"]["id"])
        assert (e["from"]["kind"], e["from"]["id"]) in refs and (e["to"]["kind"], e["to"]["id"]) in refs

    high = graph.export(db, reader(world, "graph.export", 3))
    assert secret_item in ids(high["nodes"])
    # each export leaves one audit row with counts only
    rows = admin.execute("""SELECT details::jsonb AS details FROM audit_log
                             WHERE tenant_id = %s AND action = 'knowledge:graph_export' ORDER BY seq""", (world.tenant_id,)).fetchall()
    assert [r["details"] for r in rows] == [{"count": len(low["nodes"]), "rows": len(low["edges"])},
                                            {"count": len(high["nodes"]), "rows": len(high["edges"])}]
    # a caller with no usable filter sees none of this
    other = graph.export(db, world.ctx("owner", "graph.export", filter={"v": 1}, topic_filter={"v": 1}))
    assert other["nodes"] == [] and other["edges"] == []


def test_a_conflict_with_a_withdrawn_item_appears_neither_in_the_neighbourhood_nor_in_the_export(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    a = verified_item(db, world, embedder, "Synthetic: the alarm comes at 3.0 bar.", title="Synthetic alarm A", sensitivity=1)
    b = verified_item(db, world, embedder, "Synthetic: the alarm comes at 3.2 bar.", title="Synthetic alarm B", sensitivity=1)
    first, second = sorted((a, b))

    def store_conflict() -> None:
        admin.execute("DELETE FROM knowledge_item_conflicts WHERE tenant_id = %s", (world.tenant_id,))
        admin.execute("""INSERT INTO knowledge_item_conflicts (tenant_id, item_id, other_item_id, measure, item_value, other_value)
                         VALUES (%s, %s, %s, 'pressure', '3.0 bar', '3.2 bar')""", (world.tenant_id, first, second))

    caller = reader(world, "graph.read", 3)
    store_conflict()
    assert neighbour_ids(graph.neighbourhood(db, caller, "item", a), "conflicting_items") == {b}
    assert any(e["kind"] == "item_conflict" for e in graph.export(db, reader(world, "graph.export", 3))["edges"])
    # b is withdrawn; a conflict row is then put back by hand, as if one had been left behind
    admin.execute("UPDATE knowledge_items SET status = 'withdrawn' WHERE tenant_id = %s AND id = %s", (world.tenant_id, b))
    store_conflict()
    assert neighbour_ids(graph.neighbourhood(db, caller, "item", a), "conflicting_items") == set()
    whole = graph.export(db, reader(world, "graph.export", 3))
    assert b not in ids(whole["nodes"]) and not any(e["kind"] == "item_conflict" for e in whole["edges"])
