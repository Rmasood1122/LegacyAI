"""Versioned prompts and strict output shapes (docs/phase2/04)."""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from app.ai_gateway import AnswerOutput, QuizGenerateOutput, load_prices, load_prompts, strip_links
from app.ai_gateway.prompts import PromptError

FEATURES = {"answer", "interview_question", "item_extract", "topic_extract", "quiz_generate", "quiz_grade", "eval_judge"}


def test_every_feature_has_a_prompt_that_treats_blocks_as_data() -> None:
    prompts = load_prompts()
    assert {p.feature for p in prompts.values()} == FEATURES
    for p in prompts.values():
        assert "data" in p.text.lower() and "json" in p.text.lower(), p.id


def test_a_prompt_with_a_template_slot_is_refused(tmp_path: Path) -> None:
    (tmp_path / "answer").mkdir()
    (tmp_path / "answer" / "v1.md").write_text(
        "---\nid: answer\nversion: 1\nfeature: answer\nschema: AnswerOutput\n---\nAnswer {question} using sources.\n", encoding="utf-8")
    with pytest.raises(PromptError):
        load_prompts(tmp_path)


def test_a_prompt_whose_file_and_header_disagree_is_refused(tmp_path: Path) -> None:
    (tmp_path / "answer").mkdir()
    (tmp_path / "answer" / "v2.md").write_text(
        "---\nid: answer\nversion: 1\nfeature: answer\nschema: AnswerOutput\n---\nText.\n", encoding="utf-8")
    with pytest.raises(PromptError):
        load_prompts(tmp_path)


def test_outputs_with_extra_fields_are_refused() -> None:
    with pytest.raises(ValidationError):
        AnswerOutput.model_validate({"answerable": True, "answer": "a", "claims": [], "conflict": False, "tool_call": "x"})
    with pytest.raises(ValidationError):
        QuizGenerateOutput.model_validate({"kind": "essay", "stem": "s"})


def test_links_are_removed_from_model_output() -> None:
    cleaned = strip_links({"answer": "See https://example.invalid/x and ![img](http://a.invalid/p.png) or [here](http://b.invalid)"})
    assert "http" not in str(cleaned)


def test_every_model_has_a_price_and_the_fake_one_is_priced_too() -> None:
    """The fake model has a made-up, non-zero price so the budget code is exercised in tests (no money is involved)."""
    prices = load_prices()
    assert prices["fake-1"].input_micro_per_mtok > 0 and prices["fake-1"].output_micro_per_mtok > 0
    assert len(prices) >= 2
