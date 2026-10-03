"""Rules applied in code after the model answers: where a quote is found, and the answer-leak guard."""

from __future__ import annotations

import pytest

from app.ai_gateway import QuizGenerateOutput
from app.knowledge.answers import _find
from app.knowledge.readiness import leak_check

SOURCE = "Before starting pump P-7, open valve V2 fully.\nThen check the  pressure gauge reads below 4 bar."


@pytest.mark.parametrize("quote, found", [
    ("open valve V2 fully", True),
    ("OPEN VALVE v2 FULLY", True),                       # letter case
    ("check the pressure gauge reads", True),            # whitespace differs from the source
    ("close valve V2 fully", False),                     # changed word
    ("open valve V3 fully", False),
    ("pump", False),                                     # too short to count as a quote
    ("open valve V2 fully; then check the pressure gauge", False),       # punctuation changed
    ("open valve V2 fully. Then check the pressure gauge", True),        # same words; the source has a line break
])
def test_a_quote_counts_only_if_it_is_really_in_the_source(quote: str, found: bool) -> None:
    assert (_find(quote, SOURCE) is not None) is found


def test_a_found_quote_points_at_the_source_text() -> None:
    at = _find("check the pressure gauge", SOURCE)
    assert at is not None
    assert SOURCE[at[0]:at[1]].replace("  ", " ") == "check the pressure gauge"


def mcq(stem: str, options: list[str], correct: int | None = 0) -> QuizGenerateOutput:
    return QuizGenerateOutput(kind="mcq", stem=stem, options=options, correct_option=correct, rubric=[])


@pytest.mark.parametrize("q, reason", [
    (mcq("What do you do before starting P-7?", ["Open valve V2 fully", "Close V2", "Call the supplier", "Wait"]), None),
    (mcq("Do you open valve V2 fully before starting P-7?", ["Open valve V2 fully", "Close V2", "Call", "Wait"]), "answer_in_stem"),
    (mcq("What first?", ["Open V2", "open v2!", "Call", "Wait"]), "options_not_distinct"),
    (mcq("What first?", ["Open V2", "Close V2", "Call"]), "malformed"),
    (mcq("What first?", ["Open V2", "Close V2", "Call", "Wait"], None), "malformed"),
    (QuizGenerateOutput(kind="open", stem="Explain the start-up.", options=[], correct_option=None, rubric=[]), "malformed"),
    (QuizGenerateOutput(kind="open", stem="Explain the start-up.", options=[], correct_option=None, rubric=["Opens V2"]), None),
])
def test_the_answer_leak_guard(q: QuizGenerateOutput, reason: str | None) -> None:
    assert leak_check(q) == reason
