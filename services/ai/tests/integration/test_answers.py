"""Cited answers that can say "I don't know" (features 14, 15, 22), end to end with the fake model."""

from __future__ import annotations

from typing import Any

import psycopg
import pytest

from app.ai_gateway import FakeEmbedder, FakeProvider, Gateway, GenerateRequest
from app.knowledge import answers
from app.platform import Database
from tests.conftest import World, needs_db
from tests.integration.helpers import company_document, item_chunk_id, verified_item

pytestmark = [pytest.mark.db, needs_db]

FACT = "Before starting pump P-7, open valve V2 fully and check the gauge reads below 4 bar."
QUESTION = "What do I do before starting pump P-7?"


def ask(db: Database, world: World, gateway: Gateway, embedder: FakeEmbedder, approved: list[str], *, question: str = QUESTION,
        phase: str = "normal", expert: str | None = None) -> answers.AnswerResult:
    ctx = world.ctx("learner", "knowledge.answer", approved=approved, phase=phase)
    return answers.answer(db, ctx, gateway, embedder, world.caller("learner"), question, expert,
                          "grace" if phase == "grace" else None)


def test_a_verified_item_gives_a_cited_answer(db: Database, world: World, gateway: Gateway, embedder: FakeEmbedder,
                                             admin: psycopg.Connection[dict[str, Any]]) -> None:
    item = verified_item(db, world, embedder, FACT)
    chunk = item_chunk_id(admin, item)
    candidates = answers.candidate_ids(db, world.ctx("learner", "knowledge.candidates"), embedder, QUESTION, None)
    assert {"id": chunk, "kind": "item"} in candidates
    r = ask(db, world, gateway, embedder, [chunk])
    assert r.outcome == "answered" and r.confidence in ("high", "medium")
    pub = r.public()
    assert pub["citations"][0]["kind"] == "item" and pub["citations"][0]["id"] == item
    assert pub["contains_unverified_sources"] is False
    assert pub["citations"][0]["snippet"] in FACT
    log = admin.execute("SELECT outcome, claims_valid, fabricated_citation FROM answer_logs WHERE tenant_id = %s", (world.tenant_id,)).fetchone()
    assert log["outcome"] == "answered" and log["claims_valid"] == 1 and log["fabricated_citation"] is False
    assert admin.execute("SELECT usage_count FROM knowledge_items WHERE id = %s", (item,)).fetchone()["usage_count"] == 1


def test_nothing_relevant_means_i_dont_know_without_a_model_call(db: Database, world: World, gateway: Gateway, provider: FakeProvider,
                                                                embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    item = verified_item(db, world, embedder, FACT)
    r = ask(db, world, gateway, embedder, [item_chunk_id(admin, item)], question="Which payroll calendar applies to contractors?")
    assert r.outcome == "dont_know" and r.reason == "no_relevant_sources"
    assert provider.calls == []
    assert r.public()["can_ask_expert"] is True


def test_nothing_approved_means_i_dont_know(db: Database, world: World, gateway: Gateway, provider: FakeProvider, embedder: FakeEmbedder) -> None:
    verified_item(db, world, embedder, FACT)
    r = ask(db, world, gateway, embedder, [])
    assert r.outcome == "dont_know" and provider.calls == []


def test_a_made_up_source_or_quote_is_not_accepted(db: Database, world: World, gateway: Gateway, provider: FakeProvider,
                                                  embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    chunk = item_chunk_id(admin, verified_item(db, world, embedder, FACT))

    def lying(req: GenerateRequest) -> dict[str, object]:
        return {"answerable": True, "answer": "Close valve V2.", "conflict": False, "claims": [
            {"text": "Close V2", "source": "S9", "quote": "close valve V2 before starting"},          # no such source
            {"text": "Call", "source": "S1", "quote": "call the supplier before starting the pump"},   # not in S1
        ]}

    provider.script = lying
    r = ask(db, world, gateway, embedder, [chunk])
    assert r.outcome == "dont_know" and r.reason == "not_grounded" and r.fabricated
    assert r.public()["answer"] is None and r.public()["citations"] == []


def test_conflicting_sources_are_not_answered(db: Database, world: World, gateway: Gateway, provider: FakeProvider,
                                             embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    chunk = item_chunk_id(admin, verified_item(db, world, embedder, FACT))
    provider.script = lambda req: {"answerable": True, "answer": "x", "claims": [], "conflict": True}
    assert ask(db, world, gateway, embedder, [chunk]).reason == "sources_conflict"


def test_unverified_material_is_marked(db: Database, world: World, gateway: Gateway, embedder: FakeEmbedder,
                                      admin: psycopg.Connection[dict[str, Any]]) -> None:
    src = company_document(db, world, embedder, FACT + " This was written down by the night shift.")
    chunks = [str(r["id"]) for r in admin.execute("SELECT id FROM chunks WHERE source_id = %s", (src,)).fetchall()]
    r = ask(db, world, gateway, embedder, chunks)
    assert r.outcome == "answered"
    assert r.confidence == "medium"                       # unverified material is never "high"
    assert r.public()["contains_unverified_sources"] is True
    assert r.public()["citations"][0]["kind"] == "source"


def test_in_the_grace_period_search_results_are_shown_without_ai(db: Database, world: World, gateway: Gateway, provider: FakeProvider,
                                                                embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    chunk = item_chunk_id(admin, verified_item(db, world, embedder, FACT))
    r = ask(db, world, gateway, embedder, [chunk], phase="grace")
    assert r.outcome == "search_only" and r.reason == "grace" and provider.calls == []
    assert r.public()["citations"] and r.public()["answer"] is None


def test_the_kill_switch_stops_ai_and_falls_back_to_search(db: Database, world: World, gateway: Gateway, provider: FakeProvider,
                                                          embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    chunk = item_chunk_id(admin, verified_item(db, world, embedder, FACT))
    admin.execute("UPDATE ai_global SET kill_switch = true, kill_switch_reason = 'test'")
    try:
        r = ask(db, world, gateway, embedder, [chunk])
    finally:
        admin.execute("UPDATE ai_global SET kill_switch = false, kill_switch_reason = NULL")
    assert r.outcome == "search_only" and r.reason == "ai_disabled" and provider.calls == []


def test_the_question_is_redacted_before_it_is_logged_or_sent(db: Database, world: World, gateway: Gateway, provider: FakeProvider,
                                                             embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    chunk = item_chunk_id(admin, verified_item(db, world, embedder, FACT))
    ask(db, world, gateway, embedder, [chunk], question=QUESTION + " My email is sam.ortiz@corp.test")
    assert "sam.ortiz@corp.test" not in provider.received_text()
    logged = admin.execute("SELECT question_redacted FROM answer_logs WHERE tenant_id = %s", (world.tenant_id,)).fetchone()
    assert "sam.ortiz" not in logged["question_redacted"] and "[EMAIL_1]" in logged["question_redacted"]


def test_ask_the_expert_uses_only_that_experts_verified_items(db: Database, world: World, gateway: Gateway, provider: FakeProvider,
                                                             embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    company = item_chunk_id(admin, verified_item(db, world, embedder, FACT))     # owned by nobody
    r = ask(db, world, gateway, embedder, [company], expert=world.people["expert"].id)
    assert r.outcome == "dont_know" and provider.calls == []
