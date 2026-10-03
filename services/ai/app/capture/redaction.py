"""Redaction (feature 18, basic). The ONE function every piece of text passes through before it
is stored, embedded or sent to an AI provider (docs/phase2/05 §3).

Detection is done by Microsoft Presidio (a vetted library) with the small English language
model, plus our own pattern recognizers for secrets and keys. Doubtful findings are redacted
too (over-redaction is the safe direction) and flagged low_confidence for the review queue.

Redaction is never 100 %. Names and street addresses are the weak spot; the numbers are
measured on a synthetic set (tests/test_redaction_golden.py).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

LOW_THRESHOLD = 0.35     # anything at or above this is redacted
HIGH_THRESHOLD = 0.6     # below this (but redacted) counts as low-confidence -> review task

# Presidio entity -> our placeholder type
_TYPE = {
    "EMAIL_ADDRESS": "EMAIL", "PHONE_NUMBER": "PHONE", "CREDIT_CARD": "CREDIT_CARD", "IBAN_CODE": "IBAN",
    "US_BANK_NUMBER": "BANK_ACCOUNT", "US_SSN": "GOV_ID", "US_ITIN": "GOV_ID", "US_PASSPORT": "GOV_ID",
    "US_DRIVER_LICENSE": "GOV_ID", "UK_NHS": "GOV_ID", "UK_NINO": "GOV_ID", "IP_ADDRESS": "IP_ADDRESS",
    "PERSON": "PERSON", "LOCATION": "LOCATION", "SECRET": "SECRET", "URL_CREDENTIALS": "SECRET", "POSTCODE": "LOCATION",
}
_DETECTOR = {"PERSON": "ner", "LOCATION": "ner", "CREDIT_CARD": "checksum", "IBAN_CODE": "checksum", "SECRET": "secret_pattern",
             "URL_CREDENTIALS": "secret_pattern"}

# Our own recognizers: secrets and keys (Presidio has none), credentials in URLs, UK postcodes.
_SECRET_PATTERNS: list[tuple[str, str, float]] = [
    ("SECRET", r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)", 0.99),
    ("SECRET", r"\bBearer\s+[A-Za-z0-9._~+/=-]{16,}", 0.95),
    ("SECRET", r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}", 0.95),                 # JWT shape
    ("SECRET", r"\b(?:sk|pk|rk)-(?:live|test|proj|ant)?-?[A-Za-z0-9_-]{16,}", 0.95),                    # common vendor keys
    ("SECRET", r"\bAKIA[0-9A-Z]{16}\b", 0.95),                                                         # AWS access key id
    ("SECRET", r"\bgh[pousr]_[A-Za-z0-9]{30,}\b", 0.95),                                              # GitHub tokens
    ("SECRET", r"\bxox[abpr]-[A-Za-z0-9-]{10,}", 0.95),                                               # Slack tokens
    ("SECRET", r"(?i)\b(?:password|passwd|pwd|secret|api[_ -]?key|access[_ -]?token|token)\s*[:=]\s*\S{4,}", 0.9),
    ("SECRET", r"(?i)(?:key|token|secret)[^\n]{0,20}?\b[A-Za-z0-9+/_-]{32,}\b", 0.7),                   # long string next to a key word
    ("URL_CREDENTIALS", r"\b[a-z][a-z0-9+.-]*://[^\s:/@]+:[^\s/@]+@\S+", 0.95),
    ("POSTCODE", r"\b[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}\b", 0.6),
    # Presidio's own e-mail recognizer only accepts real top-level domains; any e-mail-shaped text is redacted here.
    ("EMAIL_ADDRESS", r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b", 0.9),
]


@dataclass(frozen=True)
class Finding:
    entity_type: str      # our placeholder type, e.g. EMAIL
    detector: str
    confidence: float
    start: int
    end: int
    placeholder: str = ""

    @property
    def low_confidence(self) -> bool:
        return self.confidence < HIGH_THRESHOLD


@dataclass(frozen=True)
class Redacted:
    text: str
    findings: tuple[Finding, ...]

    @property
    def low_confidence_count(self) -> int:
        return sum(1 for f in self.findings if f.low_confidence)


@lru_cache(maxsize=1)
def _analyzer() -> Any:
    """Presidio with the small English model, loaded once."""
    from presidio_analyzer import AnalyzerEngine, Pattern, PatternRecognizer, RecognizerRegistry
    from presidio_analyzer.nlp_engine import NlpEngineProvider

    nlp = NlpEngineProvider(nlp_configuration={
        "nlp_engine_name": "spacy", "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}],
    }).create_engine()
    registry = RecognizerRegistry()
    registry.load_predefined_recognizers(languages=["en"], nlp_engine=nlp)
    for name, regex, score in _SECRET_PATTERNS:
        registry.add_recognizer(PatternRecognizer(supported_entity=name, patterns=[Pattern(name.lower(), regex, score)]))
    return AnalyzerEngine(registry=registry, nlp_engine=nlp, supported_languages=["en"])


_ENTITIES = list(_TYPE.keys())


def _overlaps(a: Finding, b: Finding) -> bool:
    return a.start < b.end and b.start < a.end


# Plant and equipment words the language model sometimes reads as a person's or a place's name ("Boiler manual" was
# stored as "[PERSON_1] manual"). A name finding is dropped only when EVERY word of it is on this list (short codes
# such as "V-9" are ignored), so "Boiler" and "Valve V-9" are kept as text while "Jane Boiler" is still redacted.
# This is a narrow built-in list, not a general cure: other ordinary words can still be redacted, and the company
# allow-list remains the way to fix those. Words that are also common surnames (Miller, Cooper, Turner) are left out.
_EQUIPMENT_WORDS = frozenset([
    "boiler", "valve", "pump", "filler", "capper", "rinser", "labeler", "labeller", "conveyor", "compressor",
    "palletiser", "palletizer", "gearbox", "bearing", "sensor", "drive", "tank", "nozzle", "chiller", "mixer",
    "dryer", "heater", "motor", "gauge", "filter", "hopper", "sealer", "wrapper", "manual", "checklist", "cabinet",
    "regulator", "actuator", "burner", "blower", "exchanger", "separator", "agitator",
])
_WORD = re.compile(r"[A-Za-z]{3,}")


def _only_equipment_words(span: str) -> bool:
    words = _WORD.findall(span)
    return bool(words) and all(w.lower() in _EQUIPMENT_WORDS for w in words)


def detect(text: str, allowlist: frozenset[str] = frozenset()) -> list[Finding]:
    results = _analyzer().analyze(text=text, language="en", entities=_ENTITIES, score_threshold=LOW_THRESHOLD)
    found: list[Finding] = []
    for r in results:
        span = text[r.start:r.end]
        if span.strip().lower() in allowlist:
            continue
        if r.entity_type in ("PERSON", "LOCATION") and _only_equipment_words(span):
            continue
        found.append(Finding(entity_type=_TYPE.get(r.entity_type, "OTHER"), detector=_DETECTOR.get(r.entity_type, "pattern"),
                             confidence=float(r.score), start=r.start, end=r.end))
    # Keep the widest, then most confident, of overlapping findings.
    found.sort(key=lambda f: (-(f.end - f.start), -f.confidence))
    kept: list[Finding] = []
    for f in found:
        if not any(_overlaps(f, k) for k in kept):
            kept.append(f)
    return sorted(kept, key=lambda f: f.start)


def redact(text: str, allowlist: frozenset[str] = frozenset(), numbering: dict[str, dict[str, int]] | None = None) -> Redacted:
    """Replace every finding with a typed, numbered placeholder ([EMAIL_1], [PERSON_2] ...).
    The same value gets the same placeholder throughout one document (pass the same `numbering`)."""
    numbering = {} if numbering is None else numbering
    findings = detect(text, allowlist)
    out: list[str] = []
    placed: list[Finding] = []
    pos = 0
    for f in findings:
        value = text[f.start:f.end]
        per_type = numbering.setdefault(f.entity_type, {})
        key = re.sub(r"\s+", " ", value.strip().lower())
        if key not in per_type:
            per_type[key] = len(per_type) + 1
        placeholder = f"[{f.entity_type}_{per_type[key]}]"
        out.append(text[pos:f.start])
        out.append(placeholder)
        pos = f.end
        placed.append(Finding(f.entity_type, f.detector, f.confidence, f.start, f.end, placeholder))
    out.append(text[pos:])
    return Redacted(text="".join(out), findings=tuple(placed))
