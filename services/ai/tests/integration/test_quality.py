"""Features 23 and 22 with the database and the fake model: the check in code refuses a one-sided answer, verified
items that disagree get a task and lose it when the disagreement ends, readers' feedback, and the weekly counts."""

from __future__ import annotations

from typing import Any

import psycopg
import pytest

from app.ai_gateway import FakeEmbedder, FakeProvider, Gateway
from app.knowledge import answers, item_conflicts, items, quality, reads, upkeep
from app.knowledge.quality import QualityRefused
from app.platform import Database
from tests.conftest import World, give_consent, needs_db, tenant_filter
from tests.integration.helpers import chunk_ids_of_source, company_document, item_chunk_id, verified_item
from tests.integration.test_item_topics import make_topic, reviewer_ctx

pytestmark = [pytest.mark.db, needs_db]

OLD = "The CO2 low-pressure alarm is set at 3.0 bar."
NEW = "The CO2 low-pressure alarm comes when the CO2 pressure falls below 3.2 bar."
QUESTION = "At what pressure does the CO2 low-pressure alarm come?"


def ask(db: Database, world: World, gateway: Gateway, embedder: FakeEmbedder, approved: list[str], question: str = QUESTION,
        who: str = "learner") -> answers.AnswerResult:
    return answers.answer(db, world.ctx(who, "knowledge.answer", approved=approved), gateway, embedder, world.caller(who), question, None, None)


def test_an_answer_from_one_side_is_refused_by_the_check_in_code_although_the_model_saw_no_conflict(
        db: Database, world: World, gateway: Gateway, provider: FakeProvider, embedder: FakeEmbedder,
        admin: psycopg.Connection[dict[str, Any]]) -> None:
    item = item_chunk_id(admin, verified_item(db, world, embedder, OLD, title="Maintenance handbook"))
    doc = chunk_ids_of_source(admin, company_document(db, world, embedder, NEW, title="Fault table"))
    r = ask(db, world, gateway, embedder, [item, *doc])
    assert len(provider.calls) == 1                                  # the fake model answered, quoting one source, conflict: false
    assert (r.outcome, r.reason, r.conflict_found_by) == ("dont_know", "sources_conflict", "value_check")
    assert r.answer is None and r.citations == []
    pub = r.public()
    assert pub["conflict_found_by"] == "value_check" and pub["can_ask_expert"] is True and pub["conflict_check_partial"] is False
    assert len(pub["conflicts"]) == 1 and pub["conflicts"][0]["measure"] == "pressure"
    sides = [pub["conflicts"][0]["a"], pub["conflicts"][0]["b"]]
    assert {x["value"] for x in sides} == {"3.0 bar", "3.2 bar"}
    assert {x["title"] for x in sides} == {"Maintenance handbook", "Fault table"}
    assert {x["kind"] for x in sides} == {"item", "source"} and all(x["id"] for x in sides)   # the same shape as a citation
    log = admin.execute("SELECT outcome, reason, conflict_found_by FROM answer_logs WHERE id = %s", (pub["answer_id"],)).fetchone()
    assert (log["outcome"], log["reason"], log["conflict_found_by"]) == ("dont_know", "sources_conflict", "value_check")


def test_the_same_value_in_another_unit_is_answered_and_a_model_reported_conflict_is_recorded_as_the_models(
        db: Database, world: World, gateway: Gateway, provider: FakeProvider, embedder: FakeEmbedder,
        admin: psycopg.Connection[dict[str, Any]]) -> None:
    item = item_chunk_id(admin, verified_item(db, world, embedder, OLD))
    doc = chunk_ids_of_source(admin, company_document(db, world, embedder, "The CO2 low-pressure alarm is set at 3000 mbar."))
    r = ask(db, world, gateway, embedder, [item, *doc])
    assert r.outcome == "answered" and r.conflict_found_by is None and r.public()["conflicts"] == []
    provider.script = lambda req: {"answerable": True, "answer": "x", "claims": [], "conflict": True}
    r2 = ask(db, world, gateway, embedder, [item, *doc])
    assert (r2.reason, r2.conflict_found_by) == ("sources_conflict", "ai_model")
    rows = admin.execute("SELECT conflict_found_by FROM answer_logs WHERE tenant_id = %s ORDER BY created_at", (world.tenant_id,)).fetchall()
    assert [x["conflict_found_by"] for x in rows] == [None, "ai_model"]


def conflict_rows(admin: psycopg.Connection[dict[str, Any]], tenant_id: str) -> list[dict[str, Any]]:
    return admin.execute("SELECT item_id::text AS a, other_item_id::text AS b, measure, item_value, other_value FROM knowledge_item_conflicts "
                         "WHERE tenant_id = %s", (tenant_id,)).fetchall()


def open_tasks(admin: psycopg.Connection[dict[str, Any]], tenant_id: str, kind: str) -> set[str]:
    return {str(r["subject_id"]) for r in admin.execute(
        "SELECT subject_id FROM review_tasks WHERE tenant_id = %s AND kind = %s AND status IN ('open', 'assigned')", (tenant_id, kind)).fetchall()}


def test_verified_items_of_one_topic_that_disagree_get_a_task_each_and_lose_it_when_one_is_reopened(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    topic = make_topic(admin, world.tenant_id, "CO2 supply")
    first = verified_item(db, world, embedder, OLD, title="Handbook 2019")
    items.set_topics(db, reviewer_ctx(world, first), first, [topic])
    assert conflict_rows(admin, world.tenant_id) == []                              # nothing to compare with yet
    # the second item is linked to the topic BEFORE it is verified, so verifying it compares the two
    second = items.write_manual(db, world.ctx("expert", "item.write"), title="Fault table", body=NEW, department_id=None, sensitivity=1,
                                contributor_person_id=None)
    items.set_topics(db, reviewer_ctx(world, second), second, [topic])
    items.submit(db, world.ctx("expert", "item.submit"), second)
    assert items.verify(db, world.ctx("reviewer", "item.verify"), second, embedder) == "verified"

    rows = conflict_rows(admin, world.tenant_id)
    assert len(rows) == 1 and {rows[0]["a"], rows[0]["b"]} == {first, second} and rows[0]["a"] < rows[0]["b"]
    assert rows[0]["measure"] == "pressure" and {rows[0]["item_value"], rows[0]["other_value"]} == {"3.0 bar", "3.2 bar"}
    assert open_tasks(admin, world.tenant_id, "item_conflict") == {first, second}
    # the item's page names the other item and both values
    seen = reads.get_item(db, world.ctx("reviewer", "item.read", subject=first, topic_filter=tenant_filter(world.tenant_id, action="topic:read")), first)
    assert seen["conflicts"] == [{
        "restricted": False, "measure": "pressure",
        "this": {"kind": "item", "id": first, "title": "Handbook 2019", "value": "3.0 bar"},
        "other": {"kind": "item", "id": second, "title": "Fault table", "value": "3.2 bar"},
        "detected_at": seen["conflicts"][0]["detected_at"]}]
    items.reopen(db, world.ctx("reviewer", "item.reopen"), second)
    assert conflict_rows(admin, world.tenant_id) == []
    assert open_tasks(admin, world.tenant_id, "item_conflict") == set()
    done = admin.execute("SELECT resolution FROM review_tasks WHERE tenant_id = %s AND kind = 'item_conflict'", (world.tenant_id,)).fetchall()
    assert {d["resolution"] for d in done} == {"conflict_cleared"}


def test_items_without_a_common_topic_are_not_compared_and_agreeing_items_are_left_alone(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    verified_item(db, world, embedder, OLD)
    verified_item(db, world, embedder, NEW)                                         # no topic links at all
    assert conflict_rows(admin, world.tenant_id) == []
    topic = make_topic(admin, world.tenant_id, "CO2 supply")
    a = verified_item(db, world, embedder, OLD)
    b = verified_item(db, world, embedder, "The CO2 low-pressure alarm is set at 3000 mbar.")
    items.set_topics(db, reviewer_ctx(world, a), a, [topic])
    items.set_topics(db, reviewer_ctx(world, b), b, [topic])                        # linking a verified item compares it
    assert conflict_rows(admin, world.tenant_id) == [] and open_tasks(admin, world.tenant_id, "item_conflict") == set()


def test_a_stale_item_is_no_longer_in_conflict(db: Database, world: World, embedder: FakeEmbedder,
                                               admin: psycopg.Connection[dict[str, Any]]) -> None:
    topic = make_topic(admin, world.tenant_id, "CO2 supply")
    a = verified_item(db, world, embedder, OLD)
    b = verified_item(db, world, embedder, NEW)
    items.set_topics(db, reviewer_ctx(world, a), a, [topic])
    items.set_topics(db, reviewer_ctx(world, b), b, [topic])
    assert len(conflict_rows(admin, world.tenant_id)) == 1
    admin.execute("UPDATE knowledge_items SET stale_after = now() - interval '1 day' WHERE id = %s", (a,))
    assert upkeep.run(db, world.tenant_id)["stale"] == 1
    assert conflict_rows(admin, world.tenant_id) == []
    assert open_tasks(admin, world.tenant_id, "item_conflict") == set()
    assert open_tasks(admin, world.tenant_id, "stale_item") == {a}                  # what was already built: the stale task


def test_a_reader_says_an_answer_was_wrong_only_about_its_own_answer_and_the_weekly_counts_show_it(
        db: Database, world: World, gateway: Gateway, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    chunk = item_chunk_id(admin, verified_item(db, world, embedder, OLD))
    answered = ask(db, world, gateway, embedder, [chunk]).public()
    assert answered["outcome"] == "answered" and answered["answer_id"]
    ask(db, world, gateway, embedder, [], question="Which payroll calendar applies to contractors?")        # refused: nothing relevant
    answer_id = answered["answer_id"]

    # another card cannot comment on it, and learns nothing about whether it exists
    with pytest.raises(QualityRefused) as other:
        quality.put_feedback(db, world.ctx("expert", "answer.feedback", subject=answer_id), answer_id, "wrong", None, False)
    assert (other.value.code, other.value.status) == ("not_found", 404)

    me = world.ctx("learner", "answer.feedback", subject=answer_id)
    quality.put_feedback(db, me, answer_id, "helpful", None, False)
    out = quality.put_feedback(db, me, answer_id, "wrong", "The gauge said otherwise. Ask jane.roe@example.com.", True)
    assert out["verdict"] == "wrong" and out["question_shared"] is True and out["question"] == QUESTION and out["outcome"] == "answered"
    rows = admin.execute("SELECT verdict, comment_redacted FROM answer_feedback WHERE tenant_id = %s", (world.tenant_id,)).fetchall()
    assert len(rows) == 1 and rows[0]["verdict"] == "wrong"                          # the later opinion replaced the earlier one
    assert "jane.roe@example.com" not in rows[0]["comment_redacted"] and "[EMAIL_1]" in rows[0]["comment_redacted"]
    assert open_tasks(admin, world.tenant_id, "answer_feedback") == {answer_id}

    s = quality.summary(db, world.ctx("owner", "quality.summary"), 4)
    assert len(s["weeks"]) == 1 and s["waiting_for_review"]["answers_marked_wrong"] == 1
    week = s["weeks"][0]
    assert (week["questions"], week["answered"], week["dont_know"], week["dont_know_no_relevant_sources"]) == (2, 1, 1, 1)
    assert (week["feedback_wrong"], week["feedback_helpful"], week["conflicts_found_by_value_check"]) == (1, 0, 0)
    assert set(week) == {"week_start", *quality.ANSWER_COUNTERS, *quality.FEEDBACK_COUNTERS}
    listed = quality.list_feedback(db, world.ctx("owner", "quality.feedback"), verdict="wrong", limit=10, before=None)
    assert [f["answer_id"] for f in listed["items"]] == [answer_id] and listed["next_cursor"] is None
    assert listed["items"][0]["question"] == QUESTION and "[EMAIL_1]" in listed["items"][0]["comment"]

    # when the answer log passes its retention, the feedback goes with it and the task about it is closed
    admin.execute("UPDATE answer_logs SET created_at = now() - interval '4000 days' WHERE tenant_id = %s", (world.tenant_id,))
    assert upkeep.run(db, world.tenant_id)["answer_logs_pruned"] == 2
    assert admin.execute("SELECT count(*) AS n FROM answer_feedback WHERE tenant_id = %s", (world.tenant_id,)).fetchone()["n"] == 0
    assert open_tasks(admin, world.tenant_id, "answer_feedback") == set()


def two_items_in_conflict(db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]],
                          second_sensitivity: int = 1) -> tuple[str, str]:
    topic = make_topic(admin, world.tenant_id, "CO2 supply")
    a = verified_item(db, world, embedder, OLD, title="Handbook 2019")
    b = verified_item(db, world, embedder, NEW, title="Fault table", sensitivity=second_sensitivity)
    items.set_topics(db, reviewer_ctx(world, a), a, [topic])
    items.set_topics(db, reviewer_ctx(world, b), b, [topic])
    assert len(conflict_rows(admin, world.tenant_id)) == 1 and open_tasks(admin, world.tenant_id, "item_conflict") == {a, b}
    return a, b


def test_a_conflict_ends_when_a_new_version_is_proposed(db: Database, world: World, embedder: FakeEmbedder,
                                                       admin: psycopg.Connection[dict[str, Any]]) -> None:
    a, _b = two_items_in_conflict(db, world, embedder, admin)
    items.propose_version(db, world.ctx("reviewer", "item.propose_version", subject=a), a, "The CO2 low-pressure alarm is set at 3.2 bar.")
    assert conflict_rows(admin, world.tenant_id) == [] and open_tasks(admin, world.tenant_id, "item_conflict") == set()


def test_a_conflict_ends_when_verifications_are_reverted(db: Database, world: World, embedder: FakeEmbedder,
                                                        admin: psycopg.Connection[dict[str, Any]]) -> None:
    two_items_in_conflict(db, world, embedder, admin)
    card = world.people["reviewer"].card_id
    n = items.revert_verifications(db, world.ctx("owner", "verifications.revert"), card, "2000-01-01T00:00:00Z", "2999-01-01T00:00:00Z")
    assert n >= 1
    assert conflict_rows(admin, world.tenant_id) == [] and open_tasks(admin, world.tenant_id, "item_conflict") == set()


def test_erasing_an_item_removes_the_words_a_conflict_quoted_from_it(db: Database, world: World, embedder: FakeEmbedder,
                                                                    admin: psycopg.Connection[dict[str, Any]]) -> None:
    a, b = two_items_in_conflict(db, world, embedder, admin)
    with db.tenant_tx(world.tenant_id) as cur:
        items.withdraw_items(cur, world.tenant_id, [a], [])            # the path a withdrawn document takes: withdrawn and erased
    assert conflict_rows(admin, world.tenant_id) == []                 # neither side's stored words remain
    assert open_tasks(admin, world.tenant_id, "item_conflict") == set()   # the partner lost its mark and its task
    # the same through the erasure step itself (an item the database already marked withdrawn)
    with db.tenant_tx(world.tenant_id) as cur:
        item_conflicts.sync(cur, world.tenant_id, b)
    assert conflict_rows(admin, world.tenant_id) == []


def contributed_item_in_conflict(db: Database, world: World, embedder: FakeEmbedder,
                                 admin: psycopg.Connection[dict[str, Any]]) -> tuple[str, str, str]:
    """An item the expert wrote in their own words under consent, verified, and in conflict with a company item."""
    consent = give_consent(admin, world, "expert", "own_words")
    topic = make_topic(admin, world.tenant_id, "CO2 supply")
    mine = items.write_manual(db, world.ctx("expert", "item.write"), title="My note", body=OLD, department_id=None, sensitivity=1,
                              contributor_person_id=world.people["expert"].id)
    items.submit(db, world.ctx("expert", "item.submit"), mine)
    assert items.verify(db, world.ctx("reviewer", "item.verify"), mine, embedder) == "verified"
    other = verified_item(db, world, embedder, NEW, title="Fault table", author="owner")
    items.set_topics(db, reviewer_ctx(world, mine), mine, [topic])
    items.set_topics(db, reviewer_ctx(world, other), other, [topic])
    assert len(conflict_rows(admin, world.tenant_id)) == 1 and open_tasks(admin, world.tenant_id, "item_conflict") == {mine, other}
    return consent, mine, other


@pytest.mark.parametrize("legal_hold", [False, True])
def test_withdrawing_consent_removes_the_quoted_words_in_the_same_transaction_also_under_a_legal_hold(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]], legal_hold: bool) -> None:
    consent, mine, _other = contributed_item_in_conflict(db, world, embedder, admin)
    if legal_hold:
        admin.execute("UPDATE consents SET legal_hold = true, legal_hold_by_card_id = %s, legal_hold_at = now(), legal_hold_reason = 'synthetic' "
                      "WHERE id = %s", (world.people["owner"].card_id, consent))
    # the withdrawal is ONE statement; no Python erasure step has run when the checks below are made
    admin.execute("UPDATE consents SET withdrawn_at = now(), withdrawn_by_card_id = %s WHERE id = %s", (world.people["expert"].card_id, consent))
    assert admin.execute("SELECT status FROM knowledge_items WHERE id = %s", (mine,)).fetchone()["status"] == "withdrawn"
    assert conflict_rows(admin, world.tenant_id) == []                       # the words quoted from the withdrawn item are gone
    assert open_tasks(admin, world.tenant_id, "item_conflict") == set()      # and its partner is no longer marked
    state = admin.execute("SELECT withdrawal_status FROM consents WHERE id = %s", (consent,)).fetchone()["withdrawal_status"]
    assert state == ("held" if legal_hold else "hidden")                     # the hold keeps the item itself; that is unchanged


def test_a_comparison_that_could_not_look_at_everything_is_recorded(db: Database, world: World, embedder: FakeEmbedder,
                                                                   admin: psycopg.Connection[dict[str, Any]],
                                                                   monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(item_conflicts, "COMPARED_WITH", 1)
    topic = make_topic(admin, world.tenant_id, "CO2 supply")
    made = [verified_item(db, world, embedder, text, title=f"Note {i}") for i, text in enumerate((OLD, NEW, OLD))]
    for item in made:
        items.set_topics(db, reviewer_ctx(world, item), item, [topic])
    partial = admin.execute("SELECT count(*) AS n FROM audit_log WHERE tenant_id = %s AND reason_code = 'ITEM_CONFLICT_CHECK_PARTIAL'",
                            (world.tenant_id,)).fetchone()["n"]
    assert partial >= 1                                                      # the third item had two others on its topic and looked at one


def test_a_conflict_with_an_item_the_reader_may_not_read_shows_nothing_about_that_item(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    a, b = two_items_in_conflict(db, world, embedder, admin, second_sensitivity=3)
    ctx = world.ctx("reviewer", "item.read", subject=a, filter=tenant_filter(world.tenant_id, max_sensitivity=1),
                    topic_filter=tenant_filter(world.tenant_id, action="topic:read"))
    seen = reads.get_item(db, ctx, a)["conflicts"]
    assert seen == [{"restricted": True, "measure": None, "this": None, "other": None, "detected_at": None}]
    assert "3.2" not in str(seen) and "3.0" not in str(seen) and b not in str(seen)


def test_the_question_is_shown_with_feedback_only_when_its_reader_shared_it_and_feedback_can_be_read_and_withdrawn(
        db: Database, world: World, gateway: Gateway, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    chunk = item_chunk_id(admin, verified_item(db, world, embedder, OLD))
    answer_id = ask(db, world, gateway, embedder, [chunk]).public()["answer_id"]
    me = world.ctx("learner", "answer.feedback", subject=answer_id)
    owner = world.ctx("owner", "quality.feedback")

    with pytest.raises(QualityRefused) as none_yet:
        quality.get_feedback(db, me, answer_id)
    assert none_yet.value.status == 404

    kept = quality.put_feedback(db, me, answer_id, "wrong", "Not what the gauge shows.", False)
    assert kept["question"] is None and kept["question_shared"] is False and kept["comment"] == "Not what the gauge shows."
    listed = quality.list_feedback(db, owner, verdict=None, limit=10, before=None)["items"]
    assert len(listed) == 1 and listed[0]["question"] is None and QUESTION not in str(listed)     # not shared: nobody else reads the question
    assert (listed[0]["verdict"], listed[0]["outcome"], listed[0]["reason"]) == ("wrong", "answered", None)
    assert quality.get_feedback(db, me, answer_id)["verdict"] == "wrong"
    assert open_tasks(admin, world.tenant_id, "answer_feedback") == {answer_id}

    # a reviewer dismisses the task; saying "wrong" again does not reopen it
    admin.execute("UPDATE review_tasks SET status = 'dismissed', resolved_at = now(), resolution = 'dismissed' "
                  "WHERE tenant_id = %s AND kind = 'answer_feedback'", (world.tenant_id,))
    quality.put_feedback(db, me, answer_id, "wrong", None, True)
    assert open_tasks(admin, world.tenant_id, "answer_feedback") == set()
    shared = quality.list_feedback(db, owner, verdict=None, limit=10, before=None)["items"][0]
    assert shared["question"] == QUESTION and shared["comment"] is None            # replaced as a whole: the comment left out is gone

    # changing the opinion away from "wrong" closes an open task; changing back opens one again
    quality.put_feedback(db, me, answer_id, "helpful", None, False)
    quality.put_feedback(db, me, answer_id, "wrong", None, False)
    assert open_tasks(admin, world.tenant_id, "answer_feedback") == {answer_id}
    quality.put_feedback(db, me, answer_id, "unhelpful", None, False)
    assert open_tasks(admin, world.tenant_id, "answer_feedback") == set()

    quality.put_feedback(db, me, answer_id, "wrong", None, False)
    quality.withdraw_feedback(db, me, answer_id)
    assert admin.execute("SELECT count(*) AS n FROM answer_feedback WHERE tenant_id = %s", (world.tenant_id,)).fetchone()["n"] == 0
    assert open_tasks(admin, world.tenant_id, "answer_feedback") == set()
    with pytest.raises(QualityRefused):
        quality.withdraw_feedback(db, me, answer_id)                                # nothing left to take back
    with pytest.raises(QualityRefused):
        quality.withdraw_feedback(db, world.ctx("expert", "answer.feedback_withdraw", subject=answer_id), answer_id)   # not their answer
