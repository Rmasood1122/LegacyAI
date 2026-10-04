"""The rules of the activity numbers (feature 27) and the shape of the knowledge map (feature 30): pure, no database."""

from __future__ import annotations

from app.capture import company_wide, condition, grants_something, named
from app.knowledge import analytics, graph

TENANT = "01a10174-0000-7000-8000-0000000000aa"


def spec(action: str, *grants: dict[str, object], nothing: bool = False) -> dict[str, object]:
    return {"v": 1, "tenant_id": TENANT, "action": action, "nothing": nothing, "only_verified": False, "any_of": list(grants)}


def test_a_job_role_row_says_plainly_why_it_has_no_numbers() -> None:
    rows = [{"job_role": "Boiler operator", "people": 4, "attempts": 9, "mean_score": 0.91},
            {"job_role": "Line operator", "people": 5, "attempts": 6, "mean_score": 0.666},
            {"job_role": "Warehouse operative", "people": 6, "attempts": 6, "mean_score": None}]
    assert analytics.job_role_rows(rows) == [
        {"job_role": "Boiler operator", "state": "too_few_people", "people": None, "attempts": None, "mean_score": None},
        {"job_role": "Line operator", "state": "shown", "people": 5, "attempts": 6, "mean_score": 0.7},      # one decimal, on purpose
        {"job_role": "Warehouse operative", "state": "no_graded_answers", "people": 6, "attempts": 6, "mean_score": None},
    ]
    assert analytics.MIN_GROUP == 5 and analytics.RESULT_WINDOW_MONTHS == 12


def test_the_range_is_bounded() -> None:
    assert [analytics.clamp_months(m) for m in (-3, 0, 1, 24, 25, 10_000)] == [1, 1, 1, 24, 24, 24]


def test_a_filter_is_used_only_for_the_permission_it_was_built_for() -> None:
    interviews = spec("interview:read", {"scope": "tenant", "max_sensitivity": 1})
    filters = {"interview:read": interviews, "quiz:read_results": spec("knowledge:read", {"scope": "tenant", "max_sensitivity": 3})}
    assert named(filters, "interview:read") is interviews
    assert named(filters, "quiz:read_results") is None            # filed under one permission, built for another
    assert named(filters, "topic:read") is None and named(None, "interview:read") is None and named(["x"], "interview:read") is None


def test_no_right_at_all_and_a_narrower_right_are_told_apart() -> None:
    whole = spec("quiz:read_results", {"scope": "tenant", "max_sensitivity": 3})
    own = spec("quiz:read_results", {"scope": "own", "max_sensitivity": 3, "owner_card_id": TENANT})
    none = spec("quiz:read_results", nothing=True)
    assert [grants_something(s) for s in (whole, own, none, None, {})] == [True, True, False, False, False]
    assert [company_wide(s) for s in (whole, own, none, None, {})] == [True, False, False, False, False]


def test_an_interview_is_counted_by_the_level_of_what_it_captured() -> None:
    sql, params = condition(spec("interview:read", {"scope": "tenant", "max_sensitivity": 1}), "interviews", TENANT)
    assert "v.tenant_id = %s" in sql and "sv.sensitivity" in sql and "<= %s" in sql
    assert params == [TENANT, 1]
    assert condition(spec("interview:read", nothing=True), "interviews", TENANT) == ("FALSE", [])


def test_the_map_has_no_person_nodes_and_every_edge_names_the_kind_of_both_ends() -> None:
    assert graph.KINDS == ("topic", "item", "source", "job_role")
    assert graph.SCHEMA == "legacyai-knowledge-graph/1"
    assert set(graph.EDGE_KINDS) == {"item_topic", "item_source", "job_role_topic", "item_conflict"}
    assert all(a in graph.KINDS and b in graph.KINDS for a, b in graph.EDGE_KINDS.values())
    assert graph.edge("job_role_topic", "Boiler operator", "t1") == {
        "kind": "job_role_topic", "from": {"kind": "job_role", "id": "Boiler operator"}, "to": {"kind": "topic", "id": "t1"}, "origin": None}
    assert graph.node("item", "i1", "Synthetic", "verified") == {"kind": "item", "id": "i1", "label": "Synthetic", "status": "verified"}
    assert set(graph._AROUND) == set(graph.KINDS)          # one loader per kind of node
