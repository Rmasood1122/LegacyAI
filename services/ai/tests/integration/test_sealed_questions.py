"""Decision D41, step 6 part 1: the questions people ask, the questions put to an expert and readers' comments on
answers are stored sealed; they open for the screens that show them; those written before are sealed by the
housekeeping job; an expert question's text cannot be changed. Synthetic data and made-up local keys only."""

from __future__ import annotations

from typing import Any

import psycopg
import pytest

from app.ai_gateway import FakeEmbedder, Gateway
from app.knowledge import answers, expert, quality, reads, upkeep
from app.platform import Database, use_content_keys
from tests.conftest import TEST_CONTENT_KEYS, World, give_consent, needs_db, tenant_filter
from tests.integration.helpers import item_chunk_id, verified_item

pytestmark = [pytest.mark.db, needs_db]

KNOWN = "The synthetic CO2 low-pressure alarm of the north plant is set at 3.0 bar."
QUESTION = "At what pressure does the synthetic CO2 alarm of the north plant come?"
COMMENT = "Not what the gauge of the north plant shows."
TO_EXPERT = "Who resets the synthetic CO2 alarm of the north plant after a test?"


def plant(db: Database, world: World, gateway: Gateway, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> dict[str, str]:
    """A question answered, the reader's comment on it (question shared), and a question put to the expert."""
    chunk = item_chunk_id(admin, verified_item(db, world, embedder, KNOWN))
    answer_id = answers.answer(db, world.ctx("learner", "knowledge.answer", approved=[chunk]), gateway, embedder, world.caller("learner"),
                               QUESTION, None, None).public()["answer_id"]
    quality.put_feedback(db, world.ctx("learner", "answer.feedback", subject=answer_id), answer_id, "wrong", COMMENT, True)
    give_consent(admin, world, "expert", "named_expert")
    question_id = expert.create_question(db, world.ctx("learner", "expert_question.create"), expert_person_id=world.people["expert"].id,
                                         question=TO_EXPERT, department_id=None, sensitivity=1)["id"]
    return {"answer": answer_id, "question": question_id}


def at_rest(admin: psycopg.Connection[dict[str, Any]], tenant: str) -> dict[str, Any]:
    """What the database holds, read by the superuser outside the code under test."""
    row = admin.execute(
        """SELECT (SELECT count(*) FROM answer_logs WHERE tenant_id = %(t)s AND question_redacted IS NOT NULL)::int AS questions,
                  (SELECT count(*) FROM expert_questions WHERE tenant_id = %(t)s AND question_redacted IS NOT NULL)::int AS expert_questions,
                  (SELECT count(*) FROM answer_feedback WHERE tenant_id = %(t)s AND comment_redacted IS NOT NULL)::int AS feedback,
                  (SELECT count(*) FROM answer_logs WHERE tenant_id = %(t)s AND question_sealed IS NOT NULL)::int AS sealed_questions,
                  (SELECT count(*) FROM expert_questions WHERE tenant_id = %(t)s AND question_sealed IS NOT NULL)::int AS sealed_expert_questions,
                  (SELECT count(*) FROM answer_feedback WHERE tenant_id = %(t)s AND comment_sealed IS NOT NULL)::int AS sealed_feedback""",
        {"t": tenant}).fetchone()
    sealed = b"".join(bytes(r["v"]) for r in admin.execute(
        """SELECT question_sealed AS v FROM answer_logs WHERE tenant_id = %(t)s AND question_sealed IS NOT NULL
           UNION ALL SELECT question_sealed FROM expert_questions WHERE tenant_id = %(t)s AND question_sealed IS NOT NULL
           UNION ALL SELECT comment_sealed FROM answer_feedback WHERE tenant_id = %(t)s AND comment_sealed IS NOT NULL""", {"t": tenant}))
    return {**dict(row), "words_in_sealed_bytes": b"north plant" in sealed}


def shown(db: Database, world: World, planted: dict[str, str]) -> dict[str, Any]:
    """What the screens get: the reader's own feedback, the quality list, the expert's inbox."""
    mine = quality.get_feedback(db, world.ctx("learner", "answer.feedback_read", subject=planted["answer"]), planted["answer"])
    listed = quality.list_feedback(db, world.ctx("owner", "quality.feedback"), verdict=None, limit=10, before=None)["items"]
    inbox = reads.list_expert_questions(db, world.ctx("expert", "expert_question.list",
                                                      filter=tenant_filter(world.tenant_id, action="expert_question:read")),
                                        box="addressed", limit=10)["items"]
    return {"comment": mine["comment"], "question": mine["question"], "listed": [(r["comment"], r["question"]) for r in listed],
            "inbox": [q["question"] for q in inbox]}


def test_questions_and_comments_are_stored_sealed_and_shown_opened(db: Database, world: World, gateway: Gateway, embedder: FakeEmbedder,
                                                                   admin: psycopg.Connection[dict[str, Any]]) -> None:
    planted = plant(db, world, gateway, embedder, admin)
    stored = at_rest(admin, world.tenant_id)
    assert (stored["questions"], stored["expert_questions"], stored["feedback"]) == (0, 0, 0)
    assert (stored["sealed_questions"], stored["sealed_expert_questions"], stored["sealed_feedback"]) == (1, 1, 1)
    assert stored["words_in_sealed_bytes"] is False
    seen = shown(db, world, planted)
    assert seen["comment"] == COMMENT and seen["question"] == QUESTION
    assert seen["listed"] == [(COMMENT, QUESTION)] and seen["inbox"] == [TO_EXPERT]


def test_questions_and_comments_written_before_are_sealed_by_housekeeping(db: Database, world: World, gateway: Gateway,
                                                                         embedder: FakeEmbedder,
                                                                         admin: psycopg.Connection[dict[str, Any]]) -> None:
    use_content_keys(None)                                   # as before this step
    try:
        planted = plant(db, world, gateway, embedder, admin)
    finally:
        use_content_keys(TEST_CONTENT_KEYS)
    before = at_rest(admin, world.tenant_id)
    assert (before["questions"], before["expert_questions"], before["feedback"]) == (1, 1, 1)
    assert shown(db, world, planted)["inbox"] == [TO_EXPERT]          # readable rows are read as before

    done = upkeep.seal_existing(db, world.tenant_id, batch=1)
    assert (done["sealed_questions"], done["sealed_expert_questions"], done["sealed_feedback"]) == (1, 1, 1)
    assert (done["readable_questions"], done["readable_expert_questions"], done["readable_feedback"]) == (0, 0, 0)
    after = at_rest(admin, world.tenant_id)
    assert (after["questions"], after["expert_questions"], after["feedback"], after["words_in_sealed_bytes"]) == (0, 0, 0, False)
    seen = shown(db, world, planted)
    assert seen["comment"] == COMMENT and seen["question"] == QUESTION and seen["inbox"] == [TO_EXPERT]
    again = upkeep.seal_existing(db, world.tenant_id)
    assert (again["sealed_questions"], again["sealed_expert_questions"], again["sealed_feedback"]) == (0, 0, 0)


def test_the_text_of_a_question_does_not_change_and_a_log_is_sealed_only_through_its_function(
        db: Database, world: World, gateway: Gateway, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    planted = plant(db, world, gateway, embedder, admin)
    fake = b"\x01" * 40
    with pytest.raises(psycopg.errors.CheckViolation), db.tenant_tx(world.tenant_id) as cur:
        cur.execute("UPDATE expert_questions SET question_sealed = %s WHERE id = %s", (fake, planted["question"]))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), db.tenant_tx(world.tenant_id) as cur:
        cur.execute("UPDATE answer_logs SET question_sealed = %s WHERE id = %s", (fake, planted["answer"]))
    with db.tenant_tx(world.tenant_id) as cur:                 # already sealed: the function does nothing
        cur.execute("SELECT seal_answer_log(%s, %s, 'platform:1') AS done", (planted["answer"], fake))
        assert cur.fetchone()["done"] is False
    assert shown(db, world, planted)["question"] == QUESTION
