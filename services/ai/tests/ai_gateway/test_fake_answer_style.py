"""The one-sided answer script of the evaluation run (eval/one_sided.py): it quotes the sentence that fits the question
best, from ONE source, and never reports a conflict - so a fake-provider run shows what the check in code catches by
itself. It is a script set on the fake provider by the evaluation, not part of the provider: the default (first
sentence of the first source) is what every pipeline test and the service itself rely on."""

from __future__ import annotations

import json

from app.ai_gateway import DataBlock, FakeProvider, GenerateRequest
from app.ai_gateway.outputs import AnswerOutput
from eval.one_sided import answer_from_one_side


def request(question: str, *sources: str) -> GenerateRequest:
    blocks = (DataBlock("QUESTION", question), *(DataBlock(f"S{i + 1}", text) for i, text in enumerate(sources)))
    return GenerateRequest(feature="answer", prompt_id="answer", prompt_version=1, system="x", data_blocks=blocks, output_model=AnswerOutput,
                           max_output_tokens=100)


HANDBOOK = "Maintenance handbook.\nGrease the bearings every 500 operating hours.\nThe CO2 low-pressure alarm is set at 3.0 bar."
FAULTS = "Fault table.\nThe alarm comes when the CO2 pressure falls below 3.2 bar."
QUESTION = "At what pressure does the CO2 low-pressure alarm come?"


def test_by_default_the_first_sentence_of_the_first_source_is_quoted() -> None:
    out = json.loads(FakeProvider().generate(request(QUESTION, HANDBOOK, FAULTS)).raw_json)
    assert out["answer"] == "Maintenance handbook." and out["claims"][0]["source"] == "S1" and out["conflict"] is False


def test_the_evaluation_style_quotes_the_best_fitting_sentence_of_one_source_and_reports_no_conflict() -> None:
    provider = FakeProvider()
    answer_from_one_side(provider)
    out = json.loads(provider.generate(request(QUESTION, HANDBOOK, FAULTS)).raw_json)
    assert out["answer"] == "The CO2 low-pressure alarm is set at 3.0 bar."
    assert out["claims"] == [{"text": out["answer"], "source": "S1", "quote": out["answer"]}]
    assert out["conflict"] is False                      # one-sided: the check in code has to notice the other source
    # nothing in common with the question: it falls back to the default
    other = json.loads(provider.generate(request("Zzz?", HANDBOOK)).raw_json)
    assert other["answer"] == "Maintenance handbook."


def test_the_provider_itself_has_no_evaluation_switch() -> None:
    assert not hasattr(FakeProvider(), "answer_from_best_sentence") and FakeProvider().script is None


def test_other_features_keep_their_rule_based_answers_under_the_script() -> None:
    provider = FakeProvider()
    answer_from_one_side(provider)
    req = GenerateRequest(feature="interview_question", prompt_id="interview_question", prompt_version=1, system="x",
                          data_blocks=(DataBlock("TOPIC", "boiler start-up"),), output_model=AnswerOutput, max_output_tokens=100)
    assert "boiler start-up" in json.loads(provider.generate(req).raw_json)["question"]
