"""Decision D41, step 6 part 3b: a scenario's title and situation, each step's question and expected points, and a
learner's answers with their grading are stored sealed; the reviewer's and learner's screens open them; older ones are
sealed by the housekeeping job; the parts of an approved scenario still cannot change. Synthetic data and made-up local
keys only."""

from __future__ import annotations

from typing import Any

import psycopg
import pytest

from app.ai_gateway import FakeEmbedder, Gateway
from app.knowledge import scenarios, upkeep
from app.platform import Database, use_content_keys
from tests.conftest import TEST_CONTENT_KEYS, World, needs_db, tenant_filter
from tests.integration.test_scenarios import POINT_A, POINT_B, approved_scenario

pytestmark = [pytest.mark.db, needs_db]

TITLE = "A dripping filling valve"
SITUATION = "During the night shift on Line 2 a filling valve begins to drip."
ANSWER = "I stop the filler at once and look at the valve."


def plant(db: Database, world: World, embedder: FakeEmbedder, gateway: Gateway) -> dict[str, str]:
    """An approved scenario and a learner's run, answered and handed in (graded by the fake model)."""
    sid, first, second = approved_scenario(db, world, embedder)
    run = scenarios.start_attempt(db, world.ctx("learner", "scenario.start", approved=[sid]), sid)
    learner = world.ctx("learner", "scenario.answer")
    scenarios.save_answer(db, learner, run["id"], 1, ANSWER)
    scenarios.save_answer(db, learner, run["id"], 2, "I phone the maintenance desk.")
    assert scenarios.submit_attempt(db, learner, run["id"], gateway, world.caller("learner"))["status"] == "graded"
    return {"scenario": sid, "run": run["id"], "first": first, "second": second}


def at_rest(admin: psycopg.Connection[dict[str, Any]], tenant: str) -> dict[str, Any]:
    """Read by the superuser, outside the code under test."""
    row = admin.execute(
        """SELECT (SELECT count(*) FROM scenarios WHERE tenant_id = %(t)s AND (title IS NOT NULL OR situation IS NOT NULL))::int AS scenarios,
                  (SELECT count(*) FROM scenario_steps WHERE tenant_id = %(t)s AND (prompt IS NOT NULL OR rubric IS NOT NULL))::int AS steps,
                  (SELECT count(*) FROM scenario_answers WHERE tenant_id = %(t)s
                      AND (answer_text IS NOT NULL OR ai_rubric_result IS NOT NULL))::int AS answers,
                  (SELECT count(*) FROM scenario_answers WHERE tenant_id = %(t)s AND answer_sealed IS NOT NULL
                      AND rubric_result_sealed IS NOT NULL)::int AS sealed_answers""", {"t": tenant}).fetchone()
    sealed = b"".join(bytes(r["v"]) for r in admin.execute(
        """SELECT title_sealed AS v FROM scenarios WHERE tenant_id = %(t)s AND title_sealed IS NOT NULL
           UNION ALL SELECT situation_sealed FROM scenarios WHERE tenant_id = %(t)s AND situation_sealed IS NOT NULL
           UNION ALL SELECT prompt_sealed FROM scenario_steps WHERE tenant_id = %(t)s AND prompt_sealed IS NOT NULL
           UNION ALL SELECT rubric_sealed FROM scenario_steps WHERE tenant_id = %(t)s AND rubric_sealed IS NOT NULL
           UNION ALL SELECT answer_sealed FROM scenario_answers WHERE tenant_id = %(t)s AND answer_sealed IS NOT NULL""", {"t": tenant}))
    return {**dict(row), "words_in_sealed_bytes": any(w in sealed for w in (b"filler", b"valve", b"maintenance", b"Line 2"))}


def shown(db: Database, world: World, planted: dict[str, str]) -> dict[str, Any]:
    """What the reviewer's scenario page and the learner's run get."""
    reviewer = world.ctx("reviewer", "scenario.read", filter=tenant_filter(world.tenant_id, action="quiz:read"),
                         approved=[planted["first"], planted["second"]])
    page = scenarios.get_scenario(db, reviewer, planted["scenario"])
    listed = scenarios.list_scenarios(db, world.ctx("reviewer", "scenario.list", filter=tenant_filter(world.tenant_id, action="quiz:read")),
                                      status=None, limit=50, after=None)["items"]
    run = scenarios.get_attempt(db, world.ctx("learner", "scenario.attempt_read",
                                              filter=tenant_filter(world.tenant_id, action="quiz:read_results")), planted["run"])
    return {"title": page["title"], "situation": page["situation"], "rubrics": [s["rubric"] for s in page["steps"]],
            "listed": [s["title"] for s in listed], "run_title": run["title"], "answers": [s["answer_text"] for s in run["steps"]]}


def check_shown(seen: dict[str, Any]) -> None:
    assert (seen["title"], seen["situation"], seen["listed"], seen["run_title"]) == (TITLE, SITUATION, [TITLE], TITLE)
    assert seen["rubrics"] == [[POINT_A], [POINT_B]] and seen["answers"][0] == ANSWER


def test_scenario_texts_and_answers_are_stored_sealed_and_shown_opened(db: Database, world: World, embedder: FakeEmbedder,
                                                                       gateway: Gateway, admin: psycopg.Connection[dict[str, Any]]) -> None:
    planted = plant(db, world, embedder, gateway)
    stored = at_rest(admin, world.tenant_id)
    assert (stored["scenarios"], stored["steps"], stored["answers"], stored["sealed_answers"]) == (0, 0, 0, 2)
    assert stored["words_in_sealed_bytes"] is False
    check_shown(shown(db, world, planted))


def test_scenario_texts_and_answers_written_before_are_sealed_by_housekeeping(db: Database, world: World, embedder: FakeEmbedder,
                                                                              gateway: Gateway,
                                                                              admin: psycopg.Connection[dict[str, Any]]) -> None:
    use_content_keys(None)                                   # as before this step
    try:
        planted = plant(db, world, embedder, gateway)
    finally:
        use_content_keys(TEST_CONTENT_KEYS)
    before = at_rest(admin, world.tenant_id)
    assert (before["scenarios"], before["steps"], before["answers"]) == (1, 2, 2)
    check_shown(shown(db, world, planted))                   # readable rows are read as before

    done = upkeep.seal_existing(db, world.tenant_id, batch=1)         # the scenario is approved: sealing is not an edit
    assert (done["sealed_scenarios"], done["sealed_scenario_steps"], done["sealed_scenario_answers"]) == (1, 2, 2)
    assert (done["readable_scenarios"], done["readable_scenario_steps"], done["readable_scenario_answers"]) == (0, 0, 0)
    after = at_rest(admin, world.tenant_id)
    assert (after["scenarios"], after["steps"], after["answers"], after["sealed_answers"], after["words_in_sealed_bytes"]) == (0, 0, 0, 2, False)
    check_shown(shown(db, world, planted))
    assert admin.execute("SELECT status FROM scenarios WHERE id = %s", (planted["scenario"],)).fetchone()["status"] == "approved"
    again = upkeep.seal_existing(db, world.tenant_id)
    assert (again["sealed_scenarios"], again["sealed_scenario_steps"], again["sealed_scenario_answers"]) == (0, 0, 0)


def test_the_parts_of_an_approved_scenario_still_cannot_change(db: Database, world: World, embedder: FakeEmbedder,
                                                               admin: psycopg.Connection[dict[str, Any]]) -> None:
    sid, _first, _second = approved_scenario(db, world, embedder)
    fake = b"\x01" * 40
    with pytest.raises(psycopg.errors.CheckViolation), db.tenant_tx(world.tenant_id) as cur:
        cur.execute("UPDATE scenario_steps SET prompt_sealed = %s WHERE scenario_id = %s AND position = 1", (fake, sid))
    with pytest.raises(psycopg.errors.CheckViolation), db.tenant_tx(world.tenant_id) as cur:
        cur.execute("UPDATE scenarios SET title_sealed = %s WHERE id = %s", (fake, sid))
