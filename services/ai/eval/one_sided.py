"""A script for the fake provider, used ONLY by the evaluation run and its tests (never by the service).

It answers like a model that picks the best-fitting sentence from ONE source and never reports a conflict, so a
fake-provider run shows what the check in code (feature 23) catches by itself. It lives here, not in the provider,
so that nothing a request or a configuration value can reach contains evaluation behaviour.
"""

from __future__ import annotations

import re
from typing import Any

from app.ai_gateway import FakeProvider, GenerateRequest

_WORD = re.compile(r"[a-z0-9]{4,}")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


def best_sentence(question: str, sources: list[Any]) -> tuple[Any, str] | None:
    """(source, sentence) sharing most words of four letters or more with the question; None if nothing is shared."""
    wanted = set(_WORD.findall(question.lower()))
    best: tuple[int, Any, str] | None = None
    for source in sources:
        for line in source.text.splitlines():
            for sentence in _SENTENCE_END.split(line.strip()):
                shared = len(wanted & set(_WORD.findall(sentence.lower())))
                if shared > 0 and len(sentence) >= 8 and (best is None or shared > best[0]):
                    best = (shared, source, sentence[:300].strip())
    return (best[1], best[2]) if best else None


def answer_from_one_side(provider: FakeProvider) -> None:
    """Make this fake provider answer questions from the best-fitting sentence of one source; everything else is unchanged."""
    def script(req: GenerateRequest) -> dict[str, object]:
        if req.feature == "answer":
            question = next((b.text for b in req.data_blocks if b.label == "QUESTION"), "")
            found = best_sentence(question, [b for b in req.data_blocks if b.label.startswith("S")])
            if found is not None:
                source, quote = found
                return {"answerable": True, "answer": quote, "claims": [{"text": quote, "source": source.label, "quote": quote}], "conflict": False}
        return provider.rule_based(req)
    provider.script = script
