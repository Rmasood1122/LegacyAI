"""AI gateway: the only module that talks to an AI model or an embedder (docs/phase2/04).
Other modules import from here only."""

from app.ai_gateway.embedders import DIMENSIONS, Embedder, FakeEmbedder, make_embedder
from app.ai_gateway.gateway import Gateway, load_prices, strip_links
from app.ai_gateway.outputs import (
    AnswerOutput, Claim, InterviewQuestionOutput, ItemExtractOutput, QuizGenerateOutput, QuizGradeOutput, TopicExtractOutput,
)
from app.ai_gateway.prompts import load_prompts
from app.ai_gateway.providers import FAKE_MODEL, ChatProvider, FakeProvider
from app.ai_gateway.types import Caller, DataBlock, GenerateOutcome, ProviderError, ProviderTimeout

__all__ = [
    "DIMENSIONS", "FAKE_MODEL", "AnswerOutput", "Caller", "ChatProvider", "Claim", "DataBlock", "Embedder", "FakeEmbedder",
    "FakeProvider", "Gateway", "GenerateOutcome", "InterviewQuestionOutput", "ItemExtractOutput", "ProviderError",
    "ProviderTimeout", "QuizGenerateOutput", "QuizGradeOutput", "TopicExtractOutput", "load_prices", "load_prompts",
    "make_embedder", "strip_links",
]
