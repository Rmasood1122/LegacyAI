"""Scenario replay (feature 8): the two rules that need no database.

1. The answer-leak guard: no expected point may appear in what a learner is shown.
2. What a reader gets of a run: nothing but prompts and the learner's own text while it runs; the expected points
   only for reviewers, or for the learner when the company shows answers after grading.
"""

from __future__ import annotations

from typing import Any

from app.knowledge.scenarios import Step, leak_reason, visible_steps

ITEM = "11111111-1111-7111-8111-111111111111"
OTHER_ITEM = "22222222-2222-7222-8222-222222222222"


def step(prompt: str, *rubric: str) -> Step:
    return Step(prompt, (ITEM,), tuple(rubric))


def test_a_scenario_whose_expected_points_are_not_given_away_passes() -> None:
    steps = [step("What do you do first?", "Stop the filler", "Call maintenance"), step("And then?", "Isolate the leaking valve")]
    assert leak_reason("A valve leaks", "During the night shift a filling valve starts to drip.", steps) is None


def test_an_expected_point_in_the_title_the_situation_or_any_prompt_is_refused() -> None:
    point = "Stop the filler"
    assert leak_reason("Stop the filler!", "A valve drips.", [step("What now?", point)]) == "answer_in_prompt"
    assert leak_reason("A valve leaks", "A valve drips; you stop the filler.", [step("What now?", point)]) == "answer_in_prompt"
    assert leak_reason("A valve leaks", "A valve drips.", [step("Do you stop the  FILLER?", point)]) == "answer_in_prompt"     # case and spacing do not hide it
    # a point given away by ANOTHER step's prompt
    assert leak_reason("A valve leaks", "A valve drips.", [step("What now?", point), step("After you stop the filler, what next?", "Call maintenance")]) \
        == "answer_in_prompt"


def test_empty_or_repeated_points_are_refused() -> None:
    assert leak_reason("T", "S", [Step("What now?", (ITEM,), ())]) == "malformed"
    assert leak_reason("T", "S", [step("What now?", "  ...  ")]) == "malformed"
    assert leak_reason("T", "S", [step("What now?", "Stop the filler", "stop the FILLER")]) == "points_not_distinct"


def row(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "answer_id": "a1", "position": 1, "prompt": "What do you do first?", "answer_text": "I stop the filler.",
        "rubric": ["Stop the filler", "Call maintenance"], "final_score": 0.5, "decided_by": "ai", "ai_confidence": 0.9,
        "ai_rubric_result": [{"point": 0, "met": True, "evidence": "stop the filler"}, {"point": 1, "met": False, "evidence": ""}],
        "items": [{"id": ITEM, "title": "Leaking valve"}, {"id": OTHER_ITEM, "title": "Confidential procedure"}],
    }
    base.update(over)
    return base


BARE = [{"answer_id": "a1", "position": 1, "prompt": "What do you do first?", "answer_text": "I stop the filler.", "details_removed": False}]


def see(status: str, *, learner: bool, show: bool, rows: list[dict[str, Any]] | None = None, readable: list[str] | None = None) -> list[dict[str, Any]]:
    return visible_steps(status, is_learner=learner, show_points=show, rows=rows or [row()], readable_items=readable if readable is not None else [ITEM])


def test_while_a_run_is_in_progress_nobody_gets_more_than_the_prompt_and_the_learners_own_text() -> None:
    for learner in (True, False):
        for show in (True, False):
            assert see("in_progress", learner=learner, show=show, readable=[ITEM, OTHER_ITEM]) == BARE


def test_a_state_this_code_does_not_know_counts_as_still_running() -> None:
    for status in ("", "paused", "GRADED", "done"):
        for learner in (True, False):
            assert see(status, learner=learner, show=True) == BARE


def test_a_learner_learns_nothing_from_a_run_that_expired_or_still_waits_for_a_person() -> None:
    # letting a run expire (or handing in and looking before it is graded) must not reveal the expected points,
    # whatever the company's "show answers" setting says
    for status in ("expired", "submitted"):
        for show in (True, False):
            assert see(status, learner=True, show=show) == BARE


def test_a_run_that_is_not_graded_shows_a_reviewer_no_more_than_the_learner() -> None:
    # somebody who must grade a waiting step reads that ONE step through answer_for_grading(); the run itself gives
    # scores and points to nobody before it is graded
    for status in ("expired", "submitted"):
        assert see(status, learner=False, show=True, readable=[ITEM, OTHER_ITEM]) == BARE


def test_released_says_in_so_many_words_what_a_reader_may_see() -> None:
    from app.knowledge.scenarios import released

    assert released("graded", is_learner=True, show_points=False) == (True, False)
    assert released("graded", is_learner=True, show_points=True) == (True, True)
    assert released("graded", is_learner=False, show_points=False) == (True, True)
    for status in ("in_progress", "submitted", "expired", "", "GRADED", "done"):
        for learner in (True, False):
            assert released(status, is_learner=learner, show_points=True) == (False, False)


def test_where_retention_removed_the_details_the_step_says_so_and_no_point_is_shown_as_not_met() -> None:
    from datetime import UTC, datetime

    gone = row(answer_text=None, ai_rubric_result=None, text_removed_at=datetime(2026, 1, 1, tzinfo=UTC))
    [s] = see("graded", learner=True, show=True, rows=[gone])
    assert s["details_removed"] is True and s["answer_text"] is None and s["final_score"] == 0.5
    assert s["points"] == [{"text": "Stop the filler", "met": None}, {"text": "Call maintenance", "met": None}]     # unknown, not "not met"


def test_once_graded_the_learner_gets_scores_and_the_points_only_if_the_company_shows_them() -> None:
    [s] = see("graded", learner=True, show=False)
    assert s["final_score"] == 0.5 and s["decided_by"] == "ai" and s["graded_with_low_confidence"] is False
    assert "points" not in s and "read_these" not in s and "rubric" not in s and "ai_rubric_result" not in s
    [shown] = see("graded", learner=True, show=True)
    assert shown["points"] == [{"text": "Stop the filler", "met": True}, {"text": "Call maintenance", "met": False}]
    assert shown["read_these"] == [{"id": ITEM, "title": "Leaking valve"}]        # the item this reader may not read is not named


def test_a_reviewer_gets_the_points_of_a_graded_run_and_a_persons_decision_does_not_pretend_the_model_met_them() -> None:
    [s] = see("graded", learner=False, show=False, rows=[row(decided_by="reviewer", final_score=1.0)], readable=[])
    assert s["points"] == [{"text": "Stop the filler", "met": None}, {"text": "Call maintenance", "met": None}]
    assert s["read_these"] == []
    [unsure] = see("graded", learner=False, show=False, rows=[row(ai_confidence=0.3)])
    assert unsure["graded_with_low_confidence"] is True


def test_an_erased_step_shows_no_points() -> None:
    [s] = see("graded", learner=False, show=False, rows=[row(prompt="", rubric=[], items=[])])
    assert s["points"] == [] and s["prompt"] == "" and s["read_these"] == []


def test_neither_the_creator_nor_the_last_editor_wrote_it_is_true_for_a_third_person() -> None:
    from app.knowledge.scenarios import wrote_it

    s = {"author_card_id": "card-b", "owner_person_id": "person-b", "created_by_card_id": "card-a", "created_by_person_id": "person-a"}
    assert wrote_it(s, "card-a", "person-a") and wrote_it(s, "card-b", "person-b")      # A created it, B edited it last: neither approves
    assert wrote_it(s, "card-a2", "person-a")                                            # a second card of the same person does not help
    assert not wrote_it(s, "card-c", "person-c") and not wrote_it(s, "card-c", None)


def test_whoever_generated_or_last_edited_a_test_question_wrote_it() -> None:
    from app.knowledge.readiness import wrote_question

    q = {"written_by_card_id": "card-a", "written_by_person_id": "person-a", "edited_by_card_id": "card-b", "edited_by_person_id": "person-b"}
    assert wrote_question(q, "card-a", "person-a") and wrote_question(q, "card-b", "person-b")
    assert wrote_question(q, "card-a2", "person-a")                       # a second card of the same person does not help
    assert not wrote_question(q, "card-c", "person-c") and not wrote_question(q, "card-c", None)
    # a question written before the rule existed names nobody: nobody is refused for it
    old = {"written_by_card_id": None, "written_by_person_id": None, "edited_by_card_id": None, "edited_by_person_id": None}
    assert not wrote_question(old, "card-a", "person-a") and not wrote_question(old, "card-a", None)
