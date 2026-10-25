"""Decision D41, step 6 part 3a: readiness questions (stem, options, expected points) and learners' answers (with what
the grading model said about them) are stored sealed; the reviewer's question list and the learner's attempt open
them; older ones are sealed by the housekeeping job; retention empties a sealed answer; an approved question still
cannot be changed. Synthetic data and made-up local keys only."""

from __future__ import annotations

from typing import Any

import psycopg
import pytest

from app.ai_gateway import FakeEmbedder, Gateway
from app.knowledge import readiness, reads, scenario_erasure, upkeep
from app.platform import Database, use_content_keys
from tests.conftest import TEST_CONTENT_KEYS, World, needs_db, tenant_filter
from tests.integration.helpers import verified_item
from tests.integration.test_interview_and_readiness import ROLE, topic

pytestmark = [pytest.mark.db, needs_db]

STEM = "A new colleague asks you how this is done. What do you tell them?"
ANSWER = "I lift the lever of the north plant relief valve every month until steam escapes."


def plant(db: Database, world: World, embedder: FakeEmbedder, gateway: Gateway, admin: psycopg.Connection[dict[str, Any]]) -> dict[str, str]:
    """An approved open question, a learner's run with a written answer, handed in and graded by the (fake) model."""
    tid = topic(db, world, embedder, admin, "Relief valves", "relief valve testing")
    item = verified_item(db, world, embedder, "Lift each relief valve lever of the north plant monthly until steam escapes.", sensitivity=0)
    admin.execute("INSERT INTO knowledge_item_topics (tenant_id, item_id, topic_id, link_source) VALUES (%s, %s, %s, 'reviewer')",
                  (world.tenant_id, item, tid))
    qid = readiness.generate(db, world.ctx("owner", "quiz.generate", approved=[item]), gateway, world.caller("owner"), "open")["created"][0]
    readiness.set_question_status(db, world.ctx("reviewer", "quiz.status"), qid, "approved")
    attempt = readiness.start_attempt(db, world.ctx("learner", "quiz.start", approved=[qid]), ROLE)
    learner = world.ctx("learner", "quiz.answer")
    readiness.save_answer(db, learner, attempt["id"], 1, None, ANSWER)
    readiness.submit_attempt(db, learner, attempt["id"], gateway, world.caller("learner"))
    return {"question": qid, "attempt": attempt["id"]}


def at_rest(admin: psycopg.Connection[dict[str, Any]], tenant: str) -> dict[str, Any]:
    """Read by the superuser, outside the code under test."""
    row = admin.execute(
        """SELECT (SELECT count(*) FROM quiz_items WHERE tenant_id = %(t)s AND (stem IS NOT NULL OR rubric IS NOT NULL))::int AS questions,
                  (SELECT count(*) FROM quiz_answers WHERE tenant_id = %(t)s
                      AND (answer_text IS NOT NULL OR ai_rubric_result IS NOT NULL))::int AS answers,
                  (SELECT count(*) FROM quiz_items WHERE tenant_id = %(t)s AND content_sealed IS NOT NULL)::int AS sealed_questions,
                  (SELECT count(*) FROM quiz_answers WHERE tenant_id = %(t)s AND answer_sealed IS NOT NULL
                      AND rubric_result_sealed IS NOT NULL)::int AS sealed_answers""", {"t": tenant}).fetchone()
    sealed = b"".join(bytes(r["v"]) for r in admin.execute(
        """SELECT content_sealed AS v FROM quiz_items WHERE tenant_id = %(t)s AND content_sealed IS NOT NULL
           UNION ALL SELECT answer_sealed FROM quiz_answers WHERE tenant_id = %(t)s AND answer_sealed IS NOT NULL
           UNION ALL SELECT rubric_result_sealed FROM quiz_answers WHERE tenant_id = %(t)s AND rubric_result_sealed IS NOT NULL""",
        {"t": tenant}))
    return {**dict(row), "words_in_sealed_bytes": b"colleague" in sealed or b"north plant" in sealed}


def shown(db: Database, world: World, planted: dict[str, str]) -> dict[str, Any]:
    """What the reviewer's list and the learner's attempt get."""
    listed = reads.list_quiz_items(db, world.ctx("reviewer", "quiz.list", filter=tenant_filter(world.tenant_id)), status=None, limit=10,
                                   after=None)["items"]
    attempt = reads.get_attempt(db, world.ctx("learner", "quiz.read"), planted["attempt"])
    return {"stem": [q["stem"] for q in listed], "rubric": [q["rubric"] for q in listed],
            "attempt_stem": [q["stem"] for q in attempt["questions"]], "answer": [q["answer_text"] for q in attempt["questions"]]}


def check_shown(seen: dict[str, Any]) -> None:
    assert seen["stem"] == [STEM]                            # the fake model's question
    assert seen["rubric"][0] and all(isinstance(p, str) and p for p in seen["rubric"][0])
    assert seen["attempt_stem"] == seen["stem"] and seen["answer"] == [ANSWER]


def test_questions_and_answers_are_stored_sealed_and_shown_opened(db: Database, world: World, embedder: FakeEmbedder, gateway: Gateway,
                                                                  admin: psycopg.Connection[dict[str, Any]]) -> None:
    planted = plant(db, world, embedder, gateway, admin)
    stored = at_rest(admin, world.tenant_id)
    assert (stored["questions"], stored["answers"], stored["sealed_questions"], stored["sealed_answers"]) == (0, 0, 1, 1)
    assert stored["words_in_sealed_bytes"] is False
    assert admin.execute("SELECT decided_by FROM quiz_answers WHERE attempt_id = %s", (planted["attempt"],)).fetchone()["decided_by"] == "ai"
    check_shown(shown(db, world, planted))


def test_questions_and_answers_written_before_are_sealed_by_housekeeping(db: Database, world: World, embedder: FakeEmbedder,
                                                                        gateway: Gateway, admin: psycopg.Connection[dict[str, Any]]) -> None:
    use_content_keys(None)                                   # as before this step
    try:
        planted = plant(db, world, embedder, gateway, admin)
    finally:
        use_content_keys(TEST_CONTENT_KEYS)
    before = at_rest(admin, world.tenant_id)
    assert (before["questions"], before["answers"], before["sealed_questions"]) == (1, 1, 0)
    check_shown(shown(db, world, planted))                   # readable rows are read as before

    done = upkeep.seal_existing(db, world.tenant_id, batch=1)
    assert (done["sealed_quiz_questions"], done["sealed_quiz_answers"], done["readable_quiz_questions"], done["readable_quiz_answers"]) == (1, 1, 0, 0)
    after = at_rest(admin, world.tenant_id)
    assert (after["questions"], after["answers"], after["sealed_questions"], after["sealed_answers"], after["words_in_sealed_bytes"]) == (
        0, 0, 1, 1, False)
    check_shown(shown(db, world, planted))
    again = upkeep.seal_existing(db, world.tenant_id)
    assert (again["sealed_quiz_questions"], again["sealed_quiz_answers"]) == (0, 0)


def test_retention_empties_a_sealed_answer_and_an_approved_question_still_cannot_change(
        db: Database, world: World, embedder: FakeEmbedder, gateway: Gateway, admin: psycopg.Connection[dict[str, Any]]) -> None:
    planted = plant(db, world, embedder, gateway, admin)
    with pytest.raises(psycopg.errors.CheckViolation), db.tenant_tx(world.tenant_id) as cur:
        cur.execute("UPDATE quiz_items SET content_sealed = %s WHERE id = %s", (b"\x01" * 40, planted["question"]))

    admin.execute("UPDATE quiz_attempts SET graded_at = now() - interval '400 days' WHERE id = %s", (planted["attempt"],))
    with db.tenant_tx(world.tenant_id) as cur:
        scenario_erasure.prune_answers(cur, world.tenant_id)
    row = admin.execute("""SELECT answer_text, answer_sealed, ai_rubric_result, rubric_result_sealed, sealed_key, text_removed_at, final_score
                             FROM quiz_answers WHERE attempt_id = %s""", (planted["attempt"],)).fetchone()
    assert (row["answer_text"], row["answer_sealed"], row["ai_rubric_result"], row["rubric_result_sealed"], row["sealed_key"]) == (None,) * 5
    assert row["text_removed_at"] is not None and row["final_score"] is not None          # the score is kept
    assert shown(db, world, planted)["answer"] == [None]
