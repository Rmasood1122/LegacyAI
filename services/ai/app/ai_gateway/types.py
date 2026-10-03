"""What callers hand to the gateway and what they get back. Callers never see a provider."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel

Feature = Literal["answer", "interview_question", "item_extract", "topic_extract", "quiz_generate", "quiz_grade", "eval_judge"]


@dataclass(frozen=True)
class DataBlock:
    """Untrusted text (a document passage, an interview answer, a question). Always data, never instructions."""

    label: str
    text: str


@dataclass(frozen=True)
class Caller:
    tenant_id: str
    card_id: str | None
    request_id: str
    max_input_tokens: int
    max_output_tokens: int
    calls_per_hour: int
    monthly_cap_micro_usd: int


@dataclass(frozen=True)
class GenerateRequest:
    feature: Feature
    prompt_id: str
    prompt_version: int
    system: str
    data_blocks: tuple[DataBlock, ...]
    output_model: type[BaseModel]
    max_output_tokens: int


@dataclass(frozen=True)
class ProviderResult:
    raw_json: str
    input_tokens: int
    output_tokens: int
    usage_reported: bool = True


class ProviderError(Exception):
    """The provider failed. `charged` says whether the provider says it billed (usage known)."""

    def __init__(self, message: str, *, input_tokens: int = 0, output_tokens: int = 0, usage_reported: bool = False,
                 retryable: bool = True, before_processing: bool = False) -> None:
        super().__init__(message)
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.usage_reported = usage_reported
        self.retryable = retryable
        self.before_processing = before_processing


class ProviderTimeout(ProviderError):
    pass


RefusalReason = Literal["kill_switch", "budget", "global", "limits", "rate", "unavailable"]


@dataclass
class GenerateOutcome:
    """Either `parsed` is set, or `refused` / `failed` explains why not. Never both."""

    parsed: BaseModel | None = None
    refused: RefusalReason | None = None
    failed: bool = False
    cost_micro_usd: int = 0
    ledger_ids: list[str] = field(default_factory=list)
    model: str = ""
