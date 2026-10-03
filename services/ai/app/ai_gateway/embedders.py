"""Embedders turn text into 384 numbers. Local ones cost nothing and write no ledger rows.

- FakeEmbedder: deterministic, hashing words into 384 buckets. Similar texts get similar
  vectors; identical on every machine. Used in CI.
- LocalEmbedder: BAAI/bge-small-en-v1.5 through fastembed, run inside this service. The model
  file is baked into the container image; it is never downloaded at run time in production.
"""

from __future__ import annotations

import hashlib
import math
import re
from typing import Literal, Protocol

DIMENSIONS = 384
Kind = Literal["document", "query"]


class Embedder(Protocol):
    model_id: str
    relevance_threshold: float   # below this cosine similarity a passage does not count as evidence

    def embed(self, texts: list[str], kind: Kind) -> list[list[float]]: ...


_WORD = re.compile(r"[a-z0-9]+")


def _normalise(v: list[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / norm for x in v]


class FakeEmbedder:
    model_id = "fake-hash-384@1"
    relevance_threshold = 0.2

    def embed(self, texts: list[str], kind: Kind) -> list[list[float]]:
        out = []
        for text in texts:
            v = [0.0] * DIMENSIONS
            words = _WORD.findall(text.lower())
            for w in words:
                h = hashlib.sha256(w.encode()).digest()
                v[int.from_bytes(h[:2], "big") % DIMENSIONS] += 1.0 if h[2] % 2 == 0 else -1.0
            if not words:
                v[0] = 1.0
            out.append(_normalise(v))
        return out


class LocalEmbedder:
    QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
    # ASSUMPTION: a starting value for bge-small; tuned on the evaluation set at Gate 2 and reported.
    relevance_threshold = 0.6

    def __init__(self) -> None:
        import fastembed  # imported lazily: heavy, and not needed in most tests

        self._model = fastembed.TextEmbedding(model_name="BAAI/bge-small-en-v1.5")
        self.model_id = f"bge-small-en-v1.5@fastembed-{fastembed.__version__}"

    def embed(self, texts: list[str], kind: Kind) -> list[list[float]]:
        prepared = [self.QUERY_PREFIX + t if kind == "query" else t for t in texts]
        return [[float(x) for x in vec] for vec in self._model.embed(prepared)]


def make_embedder(name: str) -> Embedder:
    if name == "fake":
        return FakeEmbedder()
    if name == "local":
        return LocalEmbedder()
    raise ValueError(f"unknown embedder {name}")
