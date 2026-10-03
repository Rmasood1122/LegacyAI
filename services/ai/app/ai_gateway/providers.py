"""Providers. Until Gate 2 the only chat provider is the deterministic fake.

FakeProvider never touches the network. It produces schema-valid output derived from its
input, records everything it was sent (so tests can check what reached "the model"), and
can be scripted per test to misbehave: invent citations, obey injected instructions, return
broken JSON, time out, or fail.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Protocol

from app.ai_gateway.types import GenerateRequest, ProviderResult, ProviderTimeout

FAKE_MODEL = "fake-1"


class ChatProvider(Protocol):
    name: str
    model: str

    def generate(self, req: GenerateRequest) -> ProviderResult: ...


def _first_sentence(text: str, limit: int = 160) -> str:
    sentence = re.split(r"(?<=[.!?])\s+", text.strip(), maxsplit=1)[0]
    return sentence[:limit].strip()


def _approx_tokens(text: str) -> int:
    return max(1, len(text) // 4)


Script = Callable[[GenerateRequest], "dict[str, object] | str | Exception"]


class FakeProvider:
    name = "fake"
    model = FAKE_MODEL

    def __init__(self) -> None:
        self.calls: list[GenerateRequest] = []
        self.script: Script | None = None

    def received_text(self) -> str:
        """Everything that has been sent to this provider, for leak checks in tests."""
        return "\n".join(req.system + "\n" + "\n".join(b.text for b in req.data_blocks) for req in self.calls)

    def generate(self, req: GenerateRequest) -> ProviderResult:
        self.calls.append(req)
        produced: dict[str, object] | str | Exception
        produced = self.script(req) if self.script is not None else self._default(req)
        if isinstance(produced, Exception):
            raise produced
        raw = produced if isinstance(produced, str) else json.dumps(produced)
        input_tokens = _approx_tokens(req.system) + sum(_approx_tokens(b.text) for b in req.data_blocks)
        return ProviderResult(raw_json=raw, input_tokens=input_tokens, output_tokens=_approx_tokens(raw))

    # Rule-based answers for each prompt, so the pipeline works end to end without a model.
    def _default(self, req: GenerateRequest) -> dict[str, object]:
        blocks = req.data_blocks
        if req.feature == "answer":
            sources = [b for b in blocks if b.label.startswith("S")]
            if not sources:
                return {"answerable": False, "answer": "", "claims": [], "conflict": False}
            first = sources[0]
            quote = _first_sentence(first.text)
            return {"answerable": True, "answer": quote, "claims": [{"text": quote, "source": first.label, "quote": quote}],
                    "conflict": False}
        if req.feature == "interview_question":
            topic = next((b.text for b in blocks if b.label == "TOPIC"), "this topic")
            return {"question": f"Tell me how you handle {topic[:80]}. What goes wrong, and how do you know?"}
        if req.feature == "item_extract":
            answer = next((b.text for b in blocks if b.label == "ANSWER"), "")
            quote = _first_sentence(answer)
            return {"substantive": len(answer.split()) >= 8, "title": " ".join(answer.split()[:8])[:120] or "Untitled",
                    "body": answer[:2000], "quote": quote}
        if req.feature == "topic_extract":
            names = []
            for b in blocks:
                head = _first_sentence(b.text, 60)
                if head and head not in names:
                    names.append(head)
            return {"topics": [{"name": n, "description": ""} for n in names[:5]]}
        if req.feature == "quiz_generate":
            item = next((b.text for b in blocks if b.label == "ITEM"), "")
            fact = _first_sentence(item, 200)
            return {"kind": "mcq", "stem": "Which statement matches the verified procedure?",
                    "options": [fact, "Skip the check and continue.", "Wait for the next shift.", "Call the supplier first."],
                    "correct_option": 0, "rubric": []}
        if req.feature == "quiz_grade":
            answer = next((b.text for b in blocks if b.label == "LEARNER_ANSWER"), "").lower()
            points = [b.text for b in blocks if b.label.startswith("POINT")]
            met = [{"point": i, "met": any(w in answer for w in p.lower().split()[:3]), "evidence": ""} for i, p in enumerate(points)]
            return {"points": met, "confidence": 0.9}
        if req.feature == "eval_judge":
            return {"points": [], "contradiction": False}
        raise ValueError(f"fake provider has no default for {req.feature}")


def timeout() -> ProviderTimeout:
    return ProviderTimeout("timed out", usage_reported=False)
