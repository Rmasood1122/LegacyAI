"""Chunking (docs/phase2/05 §2). Runs AFTER redaction. Deterministic: the same text always gives
the same chunks.

Split on structure (blank lines, headings, list items, page breaks), then pack paragraphs into
chunks of about 200 tokens (~800 characters), never more than 350 tokens (~1,400 characters),
with a one-sentence overlap. A sentence is not cut in the middle, and a placeholder such as
[PERSON_2] is never split.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

TARGET_CHARS = 800
MAX_CHARS = 1400
_SENTENCE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\[\"'(])")
_PARAGRAPH = re.compile(r"\n\s*\n|\n(?=\s*(?:#{1,6}\s|[-*•]\s|\d+[.)]\s))")


@dataclass(frozen=True)
class Chunk:
    ordinal: int
    text: str
    page_from: int
    page_to: int

    @property
    def token_estimate(self) -> int:
        return max(1, len(self.text) // 4)


def _sentences(paragraph: str) -> list[str]:
    parts = [s.strip() for s in _SENTENCE.split(paragraph) if s.strip()]
    out: list[str] = []
    for s in parts:
        while len(s) > MAX_CHARS:
            # a single "sentence" longer than the maximum: cut at the last space before the limit,
            # never inside a [PLACEHOLDER]
            cut = s.rfind(" ", 0, MAX_CHARS)
            open_bracket = s.rfind("[", 0, cut)
            if open_bracket > s.rfind("]", 0, cut):
                cut = open_bracket
            cut = cut if cut > 0 else MAX_CHARS
            out.append(s[:cut].strip())
            s = s[cut:].strip()
        if s:
            out.append(s)
    return out


def chunk_pages(pages: list[tuple[int, str]]) -> list[Chunk]:
    units: list[tuple[int, str]] = []  # (page, sentence)
    for page, text in pages:
        for paragraph in _PARAGRAPH.split(text):
            para = re.sub(r"[ \t]+", " ", paragraph).strip()
            if para:
                units.extend((page, s) for s in _sentences(para))
    chunks: list[Chunk] = []
    current: list[tuple[int, str]] = []

    def flush() -> None:
        if current:
            body = " ".join(s for _, s in current)
            chunks.append(Chunk(ordinal=len(chunks), text=body, page_from=current[0][0], page_to=current[-1][0]))

    for unit in units:
        size = sum(len(s) + 1 for _, s in current)
        if current and (size + len(unit[1]) > MAX_CHARS or size >= TARGET_CHARS):
            flush()
            last = current[-1]
            current = [last] if len(last[1]) + len(unit[1]) + 1 <= MAX_CHARS else []
        current.append(unit)
    flush()
    return chunks
