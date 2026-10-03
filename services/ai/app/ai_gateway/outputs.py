"""The only shapes a model's answer may take. Anything else is a failed attempt."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Claim(_Strict):
    text: str = Field(max_length=2000)
    source: str = Field(max_length=10)
    quote: str = Field(max_length=600)


class AnswerOutput(_Strict):
    answerable: bool
    answer: str = Field(max_length=4000)
    claims: list[Claim] = Field(max_length=20)
    conflict: bool


class InterviewQuestionOutput(_Strict):
    question: str = Field(min_length=1, max_length=1000)


class ItemExtractOutput(_Strict):
    substantive: bool
    title: str = Field(max_length=200)
    body: str = Field(max_length=2000)
    quote: str = Field(max_length=600)


class TopicSuggestion(_Strict):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(max_length=500)


class TopicExtractOutput(_Strict):
    topics: list[TopicSuggestion] = Field(max_length=20)


class QuizGenerateOutput(_Strict):
    kind: str = Field(pattern="^(mcq|open)$")
    stem: str = Field(min_length=1, max_length=2000)
    options: list[str] = Field(default_factory=list, max_length=4)
    correct_option: int | None = None
    rubric: list[str] = Field(default_factory=list, max_length=6)


class PointResult(_Strict):
    point: int = Field(ge=0, le=20)
    met: bool
    evidence: str = Field(max_length=600)


class QuizGradeOutput(_Strict):
    points: list[PointResult] = Field(max_length=20)
    confidence: float = Field(ge=0, le=1)


class EvalJudgeOutput(_Strict):
    points: list[PointResult] = Field(max_length=20)
    contradiction: bool


OUTPUT_MODELS: dict[str, type[BaseModel]] = {
    "AnswerOutput": AnswerOutput,
    "InterviewQuestionOutput": InterviewQuestionOutput,
    "ItemExtractOutput": ItemExtractOutput,
    "TopicExtractOutput": TopicExtractOutput,
    "QuizGenerateOutput": QuizGenerateOutput,
    "QuizGradeOutput": QuizGradeOutput,
    "EvalJudgeOutput": EvalJudgeOutput,
}
