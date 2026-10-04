"""Contradiction check in code (feature 23, docs/phase4/01).

Pure functions, no database, no model. From short texts it extracts statements of the form
"some quantity has this value" (a number with a unit, an interval such as "every 30 minutes", a rate
such as "180 bottles per minute", a count such as "20 bottles") and reports a conflict when two
DIFFERENT sources give different values for what is recognisably the same quantity.

"The same quantity" is decided by rules a person can read:
  - the same kind of measure (pressure with pressure, an interval with an interval ...);
  - the two sentences share enough content words (their own words plus the nearest heading);
  - neither sentence carries a qualifier the other contradicts (500 ml bottles vs 330 ml bottles,
    head 4 vs head 2, Line 1 vs Line 2): those describe different cases, not a disagreement.

It prefers missing a conflict to inventing one. What it CANNOT catch: contradictions in prose
without a number or a plain must / must-not pair, values written as words ("twice a day"),
values spread over several sentences, tables whose header carries the meaning, and any language
other than English.

Cost is bounded BY CONSTRUCTION (texts come from uploaded documents and from questions, so they are
not trusted), and the bound does not rest on every pattern being perfect:
  - a text is cut into pieces of at most MAX_PIECE_CHARS characters and MAX_NUMBERS_PER_PIECE numbers in
    one forward scan (`_pieces`); the patterns below are only ever applied to one such piece, never to a
    growing prefix of the text, and every quantifier in them has an upper limit;
  - only the first MAX_TEXT_CHARS characters, MAX_NUMBERS_PER_TEXT numbers and MAX_FACTS_PER_TEXT
    statements of a text are read, and reading stops there, in the middle of the scan;
  - every loop spends from ONE work budget of MAX_STEPS steps per check (characters read, pairs looked
    at, sibling values looked at); when it is used up the check stops with what it has.
When any limit is reached the report says `truncated`: the check was partial, so "no conflict found"
then means less. `Report.steps` is the work done, so tests can prove the bound without a clock.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal

# --------------------------------------------------------------------------- limits

MAX_TEXT_CHARS = 12_000         # of one source (its passages joined)
MAX_FACTS_PER_TEXT = 150
MAX_NUMBERS_PER_TEXT = 1_500    # digit groups read in one source; reading stops there
MAX_PIECE_CHARS = 600           # a longer sentence (or a text without sentence breaks) is read in pieces of this size
MAX_NUMBERS_PER_PIECE = 32      # ... and a piece never holds more digit groups than this
MAX_STEPS = 300_000             # the work budget of one check: characters read + pairs looked at + sibling values looked at
MAX_COMPARISONS = 6_000         # pairs of statements looked at in one check
MAX_CONFLICTS = 20              # reported by one check
MAX_SIBLINGS = 12               # other values of the same sentence looked at to tell "another case"
LOOK_BACK = 48                  # characters before a number searched for "at most", "every", a naming word ...

# How alike two must / must-not sentences have to be before they count as contradicting each other.
POLARITY_MIN_SHARED_WORDS = 4
POLARITY_MIN_OVERLAP = 0.6
# Two values closer than this share of the larger one are the same value (rounding, unit conversion).
SAME_VALUE_TOLERANCE = 0.005

# --------------------------------------------------------------------------- words

_STOP = frozenset([
    "a", "an", "and", "are", "as", "at", "be", "been", "before", "but", "by", "can", "do", "does", "for", "from", "had", "has", "have", "how", "i",
    "if", "in", "into", "is", "it", "its", "may", "might", "more", "most", "must", "no", "not", "of", "on", "or", "our", "shall", "should", "so",
    "than", "that", "the", "their", "then", "there", "these", "they", "this", "those", "to", "up", "was", "we", "were", "what", "when", "where",
    "which", "who", "why", "will", "with", "you", "your", "all", "any", "each", "every", "per", "about", "after", "again", "also", "only", "very",
    "same", "such", "other", "both", "during", "until", "while", "over", "under", "above", "below", "between", "within", "without", "out", "off",
    "now", "new", "old", "one", "two", "first", "last", "next",
])
_IRREGULAR = {"taken": "take", "took": "take", "kept": "keep", "held": "hold", "ran": "run", "done": "do", "made": "make", "set": "set"}
_TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9]*")


def stem(word: str) -> str:
    w = _IRREGULAR.get(word.lower(), word.lower())
    if len(w) > 3 and w.endswith("ies"):
        w = w[:-3] + "y"
    elif len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
        w = w[:-1]
    for suffix in ("ing", "ed"):
        if len(w) > len(suffix) + 2 and w.endswith(suffix):
            w = w[: -len(suffix)]
            if len(w) > 2 and w[-1] == w[-2] and w[-1] not in "aeiou":
                w = w[:-1]
            break
    if len(w) > 3 and w.endswith("e"):
        w = w[:-1]
    return w


def content_stems(text: str) -> frozenset[str]:
    return frozenset(stem(t) for t in _TOKEN.findall(text) if t.lower() not in _STOP and len(t) > 1 and t.lower() not in _UNIT_WORDS)


# --------------------------------------------------------------------------- units (data: a new unit is one line here)

# unit -> (dimension, factor to the base unit of that dimension)
_UNITS: dict[str, tuple[str, float]] = {
    "s": ("time", 1), "sec": ("time", 1), "secs": ("time", 1), "second": ("time", 1), "seconds": ("time", 1),
    "min": ("time", 60), "mins": ("time", 60), "minute": ("time", 60), "minutes": ("time", 60),
    "h": ("time", 3600), "hr": ("time", 3600), "hrs": ("time", 3600), "hour": ("time", 3600), "hours": ("time", 3600),
    "day": ("time", 86400), "days": ("time", 86400), "week": ("time", 604800), "weeks": ("time", 604800),
    "month": ("time", 2592000), "months": ("time", 2592000), "year": ("time", 31536000), "years": ("time", 31536000),
    "bar": ("pressure", 1), "mbar": ("pressure", 0.001), "psi": ("pressure", 0.0689476), "kpa": ("pressure", 0.01), "mpa": ("pressure", 10),
    "pa": ("pressure", 0.00001),
    "nm": ("torque", 1),
    "mm": ("length", 0.001), "cm": ("length", 0.01), "m": ("length", 1), "km": ("length", 1000),
    "mg": ("mass", 0.000001), "g": ("mass", 0.001), "kg": ("mass", 1), "tonne": ("mass", 1000), "tonnes": ("mass", 1000),
    "ml": ("volume", 0.001), "cl": ("volume", 0.01), "l": ("volume", 1), "litre": ("volume", 1), "litres": ("volume", 1),
    "liter": ("volume", 1), "liters": ("volume", 1),
    "%": ("percent", 1), "percent": ("percent", 1),
    "rpm": ("rotation", 1), "hz": ("frequency", 1), "kw": ("power", 1000), "w": ("power", 1), "v": ("voltage", 1), "a": ("current", 1),
    "ppm": ("ppm", 1), "g/l": ("concentration", 1), "mg/l": ("concentration", 0.001),
    "°c": ("temperature", 1), "°f": ("temperature_f", 1), "k": ("temperature_k", 1),
}
# Single-letter units are read only in their usual case ("5 A" is a current, "a" is a word).
_CASED_UNITS = frozenset({"A", "V", "W", "K", "L", "l", "m", "g", "h", "s"})
_OPERATING = {"hour": _UNITS["hour"][1], "day": _UNITS["day"][1]}                       # "every 250 operating hours"
_UNIT_WORDS = frozenset(u for u in _UNITS if u.isalpha() and len(u) > 1) | {"operating", "degree", "degrees", "celsius"}
_INTERVAL_WORDS = {"hourly": 3600.0, "daily": 86400.0, "weekly": 604800.0, "monthly": 2592000.0, "yearly": 31536000.0, "annually": 31536000.0}
# words that name a thing by its number ("Line 2", "head 4"): a number after one of these is a label, not a quantity
_LABEL_WORDS = frozenset([
    "line", "head", "valve", "nozzle", "bank", "set", "tank", "program", "programme", "recipe", "page", "room", "cabinet", "sensor", "extension",
    "order", "batch", "pallet", "part", "number", "no", "code", "fault", "version", "type", "pattern", "roll", "magazine", "shelf", "bearing",
    "drive", "list", "step", "item", "section", "table", "figure", "shift", "mode", "cell", "unit", "station", "lane", "zone", "area", "building",
    "floor", "door", "gate", "pump", "motor", "conveyor", "filler", "capper", "rinser", "labeler", "labeller", "machine", "press", "oven",
])
_NOT_COUNTED = frozenset({"edition", "version", "page", "issue", "revision", "times", "am", "pm", "of", "and", "or", "to", "x"})

# What a statement is about, as shown to people and to API clients (the unit dimensions, plus four kinds without a unit).
PUBLIC_MEASURES = ("time", "pressure", "torque", "length", "mass", "volume", "percent", "rotation", "frequency", "power", "voltage", "current",
                   "ppm", "concentration", "temperature", "interval", "rate", "count", "requirement")

# A number: group "whole" may carry a minus sign when it stands directly before the digits and is not part of a
# code or a range ("-18 °C" yes; "LUB-02", "2-3 bar" no: there the character before the sign is a letter or digit).
# Every repetition is limited: at most five thousands-groups, fifteen digits, twelve decimals. (An unlimited
# "(?:,\d{3})+" made a run of comma-separated digits cost quadratic time.)
_NUM = r"(?<![\w.])((?:[-−](?=\d))?(?:\d{1,3}(?:,\d{3}){1,5}|\d{1,15}))(?:\.(\d{1,12}))?"
_UNIT_ALT = "|".join(sorted((re.escape(u) for u in _UNITS if u not in ("°c", "°f")), key=len, reverse=True))
_MEASURE = re.compile(
    _NUM + r"\s{0,3}(?:(?P<degrees>°\s?[CF]|º\s?[CF]|deg(?:rees)?\s?[CF]\b|degrees celsius)|(?P<unit>" + _UNIT_ALT + r")(?![\w/]))",
    re.IGNORECASE)
_RANGE = re.compile(r"(?:between\s{1,3})?" + _NUM + r"\s{0,3}(?:-|–|to|and)\s{0,3}" + _NUM, re.IGNORECASE)
_PLUS_MINUS = re.compile(r"±\s{0,3}" + _NUM)
_PLAIN = re.compile(_NUM)
_RATE_TAIL = re.compile(r"\s{1,3}([A-Za-z]{1,40})\s{1,3}(?:per|/|an?)\s{0,3}(second|sec|minute|min|hour|hr|h|day|shift)\b", re.IGNORECASE)
# The next five are matched against the LOOK_BACK characters before a number, never against the whole text.
_UPPER = re.compile(r"(at most|up to|no more than|not more than|maximum(?: of)?|max\.?|not exceed(?:ing)?|within)\s{0,3}$", re.IGNORECASE)
_LOWER = re.compile(r"(at least|no less than|not less than|minimum(?: of)?|min\.?)\s{0,3}$", re.IGNORECASE)
_EVERY = re.compile(r"\bevery\s{0,3}$", re.IGNORECASE)
_WORD_BEFORE = re.compile(r"([A-Za-z]{1,40})\s{0,3}$")
_CODE_BEFORE = re.compile(r"[-/]\s{0,3}$")
_EVERY_OPERATING = re.compile(r"\bevery\s{1,3}" + _NUM + r"\s{1,3}operating\s{1,3}(hour|day)s?\b", re.IGNORECASE)
_INTERVAL_WORD = re.compile(r"\b(" + "|".join(_INTERVAL_WORDS) + r")\b", re.IGNORECASE)
_NOUN_AFTER = re.compile(r"\s{1,3}([A-Za-z]{2,40})")
_CODE_AFTER = re.compile(r"\s{0,3}-")
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+(.*)$")
_SPLIT = re.compile(r"(?<=[.!?;])\s+")
_NAMED = re.compile(r"\b([A-Za-z]{1,40})\s{1,3}(\d{1,15}|[A-Z])\b(?!\s{0,3}(?:" + _UNIT_ALT + r")\b)")
_CODE = re.compile(r"\b([A-Z]{1,4})-?(\d{1,6})\b")
_NEG = re.compile(r"\b(must not|never|do not|don't|may not|not allowed|is forbidden|are forbidden|not permitted|shall not|cannot|can not)\b",
                  re.IGNORECASE)
_POS = re.compile(r"\b(must|always|shall|is allowed|are allowed|is permitted|are permitted|may)\b", re.IGNORECASE)
_POLARITY_WORDS = frozenset({"must", "never", "alway", "allow", "forbidden", "permit", "shall", "cannot"})

Kind = Literal["measure", "interval", "operating_interval", "rate", "count", "requirement"]
Bound = Literal["point", "range", "upper", "lower"]


@dataclass(frozen=True)
class Place:
    """Where a statement stands, and what its sentence is about (shared by all statements of one sentence)."""
    source: str
    start: int                              # position of the sentence in the source text
    end: int
    sentence: str
    stems: frozenset[str]                   # the sentence's content words plus those of the nearest heading
    own: frozenset[str]                     # the sentence's own content words only
    labels: frozenset[tuple[str, str]]      # ("line", "2"), ("head", "4") ...


@dataclass(frozen=True)
class Fact:
    place: Place
    kind: Kind
    dimension: str      # for a measure: "pressure", "time" ...; for a rate: the time unit it is per ("m", "h" ...); otherwise ""
    subject: str        # for a rate or a count: the counted noun ("bottl"); otherwise ""
    bound: Bound
    low: float          # a requirement: +1.0 (must) or -1.0 (must not)
    high: float
    raw: str            # the words as written, for the explanation

    @property
    def source(self) -> str:
        return self.place.source

    @property
    def comparable(self) -> tuple[str, str, str]:
        """Two statements are compared only when this is equal."""
        return (self.kind, self.dimension, self.subject)

    @property
    def measure(self) -> str:
        """The public name of what the statement is about (one of PUBLIC_MEASURES)."""
        if self.kind == "measure":
            return "temperature" if self.dimension.startswith("temperature") else self.dimension
        return "interval" if self.kind == "operating_interval" else self.kind


@dataclass(frozen=True)
class Conflict:
    a: Fact
    b: Fact

    @property
    def measure(self) -> str:
        return self.a.measure


@dataclass(frozen=True)
class Report:
    conflicts: list[Conflict] = field(default_factory=list)
    truncated: bool = False         # a limit was reached: the check did not look at everything
    steps: int = 0                  # the work done, in the units of MAX_STEPS (deterministic: no clock involved)


class _Budget:
    """The work one check may do. Every loop spends from it; when it is gone the check stops."""

    def __init__(self, steps: int = MAX_STEPS) -> None:
        self.limit = steps
        self.left = steps

    def spend(self, steps: int = 1) -> bool:
        """False when the budget is used up (the caller stops and reports `truncated`)."""
        self.left -= steps
        return self.left >= 0

    @property
    def used(self) -> int:
        return self.limit - max(self.left, 0)


# One forward scan finds what the cutting needs: runs of digits and single white-space characters. Both alternatives
# are of limited length and cannot match the empty string, so the scan is linear in the text.
_SCAN = re.compile(r"\d{1,15}|\s")


def _pieces(start: int, sentence: str) -> Iterable[tuple[int, str, int]]:
    """Cut one sentence into (start, piece, digit groups in it), each at most MAX_PIECE_CHARS characters and
    MAX_NUMBERS_PER_PIECE digit groups. A normal sentence is one piece. A cut is made at white space, a few words
    before the number that would be one too many, so that "at most" / "every" stay with their number where possible;
    a text without white space is cut where the limit falls."""
    begin, numbers = 0, 0
    spaces: list[int] = []                      # the last few white-space positions inside the current piece
    for m in _SCAN.finditer(sentence):
        at = m.start()
        is_number = not sentence[at].isspace()
        too_long = m.end() - begin > MAX_PIECE_CHARS
        if too_long or (is_number and numbers >= MAX_NUMBERS_PER_PIECE):
            back = [x for x in spaces if x > begin]
            cut = (back[0] if is_number and not too_long else back[-1]) if back else min(begin + MAX_PIECE_CHARS, at)
            cut = max(cut, begin + 1)
            while cut - begin > MAX_PIECE_CHARS:                # a long run without white space before this token
                yield start + begin, sentence[begin:begin + MAX_PIECE_CHARS], numbers
                begin, numbers = begin + MAX_PIECE_CHARS, 0
            if cut > begin:
                yield start + begin, sentence[begin:cut], numbers
                begin, numbers, spaces = cut, 0, [x for x in spaces if x >= cut]
        if is_number:
            numbers += 1
        else:
            spaces = [*spaces[-3:], at]
    while len(sentence) - begin > MAX_PIECE_CHARS:              # a tail without any token
        yield start + begin, sentence[begin:begin + MAX_PIECE_CHARS], numbers
        begin, numbers = begin + MAX_PIECE_CHARS, 0
    if begin < len(sentence):
        yield start + begin, sentence[begin:], numbers


def _number(whole: str, fraction: str | None) -> float:
    return float(whole.replace(",", "").replace("−", "-") + ("." + fraction if fraction else ""))


def _sentences(text: str) -> Iterable[tuple[int, int, str, str]]:
    """(start, end, sentence, nearest heading above it). A table row or a list line is one sentence."""
    heading = ""
    pos = 0
    for line in text.split("\n"):
        line_start = pos
        pos += len(line) + 1
        m = _HEADING.match(line)
        if m:
            heading = m.group(1)
            continue
        if not line.strip() or set(line.strip()) <= set("|-: "):
            continue
        offset = 0
        for part in _SPLIT.split(line):
            at = line.index(part, offset) if part else offset
            offset = at + len(part)
            if part.strip():
                yield line_start + at, line_start + at + len(part), part, heading


def _labels(sentence: str) -> frozenset[tuple[str, str]]:
    out = set()
    for m in _NAMED.finditer(sentence):
        if m.group(1).lower() in _LABEL_WORDS:
            out.add((stem(m.group(1)), m.group(2)))
    for m in _CODE.finditer(sentence):      # codes: F33, PV-3, E3
        out.add((m.group(1).lower(), m.group(2)))
    return frozenset(out)


class _Sentence:
    """One sentence being read: collects its facts and remembers which characters are already explained."""

    def __init__(self, source: str, start: int, end: int, sentence: str, heading: str) -> None:
        self.flat = sentence.replace("|", " ")
        own = content_stems(self.flat)
        self.place = Place(source, start, end, sentence.strip(), own | content_stems(heading), own, _labels(self.flat) | _labels(heading))
        self.requirement_place = Place(source, start, end, sentence.strip(), self.place.stems - _POLARITY_WORDS, own - _POLARITY_WORDS,
                                       self.place.labels)
        self.facts: list[Fact] = []
        self._taken: list[tuple[int, int]] = []

    def before(self, at: int) -> str:
        """The few characters before a position: enough for "at most", "every", a naming word; never the whole text."""
        return self.flat[max(0, at - LOOK_BACK):at]

    def free(self, span: tuple[int, int]) -> bool:
        return not any(span[0] < t[1] and t[0] < span[1] for t in self._taken)

    def add(self, kind: Kind, bound: Bound, low: float, high: float, span: tuple[int, int], *, dimension: str = "", subject: str = "",
            raw: str | None = None) -> None:
        self._taken.append(span)
        self.facts.append(Fact(self.place, kind, dimension, subject, bound, low, high, (raw or self.flat[span[0]:span[1]]).strip()))

    def requirement(self, sign: float, raw: str) -> None:
        self.facts.append(Fact(self.requirement_place, "requirement", "", "", "point", sign, sign, raw))


def _unit(m: re.Match[str]) -> tuple[str, float] | None:
    """(dimension, factor to its base unit) of a matched number-with-unit, or None if the letters are not a unit here."""
    degrees = m.group("degrees")
    if degrees:
        return ("temperature", 1.0) if degrees[-1].upper() == "C" or "celsius" in degrees.lower() else ("temperature_f", 1.0)
    unit = m.group("unit")
    if len(unit) == 1 and unit != "%" and unit not in _CASED_UNITS:
        return None
    return _UNITS.get(unit.lower())


def _read_ranges(s: _Sentence) -> None:
    """ "between 1.2 and 2.0 Nm", "2-3 bar" """
    for r in _RANGE.finditer(s.flat):
        unit = _MEASURE.match(s.flat, r.start(3))
        known = _unit(unit) if unit is not None and unit.end() >= r.end() else None
        if unit is None or known is None:
            continue
        dimension, factor = known
        low, high = _number(r.group(1), r.group(2)) * factor, _number(r.group(3), r.group(4)) * factor
        if low <= high and s.free((r.start(), unit.end())):
            s.add("measure", "range", low, high, (r.start(), unit.end()), dimension=dimension)


def _read_measures(s: _Sentence) -> None:
    """A number with a unit: a value, a value with a tolerance (±), an interval ("every ..."), an upper or lower limit."""
    flat = s.flat
    for m in _MEASURE.finditer(flat):
        known = _unit(m)
        if known is None or not s.free(m.span()):
            continue
        dimension, factor = known
        value = _number(m.group(1), m.group(2)) * factor
        before = s.before(m.start())
        tolerance = _PLUS_MINUS.match(flat[m.end():m.end() + LOOK_BACK].lstrip())
        upper, lower = _UPPER.search(before), _LOWER.search(before)
        if tolerance is not None:
            delta = _number(tolerance.group(1), tolerance.group(2)) * factor          # written in the same unit as the value
            sign_at = flat.index("±", m.end())
            unit_after = _MEASURE.search(flat, sign_at, sign_at + LOOK_BACK)
            ends = unit_after.end() if unit_after is not None and unit_after.start() <= sign_at + 2 else sign_at + 1 + len(tolerance.group(0))
            s.add("measure", "range", value - delta, value + delta, (m.start(), ends), dimension=dimension)
        elif dimension == "time" and _EVERY.search(before):
            s.add("interval", "point", value, value, m.span(), raw="every " + flat[m.start():m.end()])
        elif upper is not None:
            s.add("measure", "upper", value, value, m.span(), dimension=dimension, raw=upper.group(0) + flat[m.start():m.end()])
        elif lower is not None:
            s.add("measure", "lower", value, value, m.span(), dimension=dimension, raw=lower.group(0) + flat[m.start():m.end()])
        else:
            s.add("measure", "point", value, value, m.span(), dimension=dimension)


def _read_intervals(s: _Sentence) -> None:
    """ "every 250 operating hours" (running time, never compared with calendar time) and "weekly", "monthly" ... """
    for m in _EVERY_OPERATING.finditer(s.flat):
        if s.free(m.span()):
            seconds = _number(m.group(1), m.group(2)) * _OPERATING[m.group(3).lower()]
            s.add("operating_interval", "point", seconds, seconds, m.span())
    for m in _INTERVAL_WORD.finditer(s.flat):
        seconds = _INTERVAL_WORDS[m.group(1).lower()]
        s.add("interval", "point", seconds, seconds, m.span())


def _read_rates_and_counts(s: _Sentence) -> None:
    """ "180 bottles per minute", "20 bottles", "at most 2 valves". Names ("Line 2"), years and codes are left alone. """
    flat = s.flat
    for m in _PLAIN.finditer(flat):
        if not s.free(m.span()):
            continue
        value = _number(m.group(1), m.group(2))
        before, after = s.before(m.start()), flat[m.end():m.end() + LOOK_BACK]
        named = _WORD_BEFORE.search(before)
        if named is not None and named.group(1).lower() in _LABEL_WORDS:
            continue                                              # "Line 2", "head 4": a name, not a quantity
        rate = _RATE_TAIL.match(flat, m.end())
        if rate is not None:
            s.add("rate", "point", value, value, (m.start(), rate.end()), dimension=rate.group(2)[0].lower(), subject=stem(rate.group(1)))
            continue
        noun = _NOUN_AFTER.match(after)
        if noun is None or noun.group(1).lower() in _STOP or noun.group(1).lower() in _NOT_COUNTED:
            continue
        if (m.group(2) is None and 1900 <= value <= 2100) or _CODE_AFTER.match(after) or _CODE_BEFORE.search(before):
            continue                                              # a year, or part of a code such as 500-L or LUB-02
        bound: Bound = "upper" if _UPPER.search(before) else "lower" if _LOWER.search(before) else "point"
        s.add("count", bound, value, value, (m.start(), m.end() + len(noun.group(0))), subject=stem(noun.group(1)))


def _read_requirement(s: _Sentence) -> None:
    """must / must not about the same thing"""
    negative, positive = _NEG.search(s.flat), _POS.search(s.flat)
    if negative is not None:
        s.requirement(-1.0, negative.group(0))
    elif positive is not None:
        s.requirement(1.0, positive.group(0))


# The order of the readers matters: what one has explained, the next skips. A new kind of statement is a new reader here.
_READERS = (_read_ranges, _read_measures, _read_intervals, _read_rates_and_counts, _read_requirement)


def _read(text: str, source: str, budget: _Budget) -> tuple[list[Fact], bool]:
    truncated = len(text) > MAX_TEXT_CHARS
    facts: list[Fact] = []
    numbers = 0
    for start, _end, sentence, heading in _sentences(text[:MAX_TEXT_CHARS]):
        for piece_start, piece, piece_numbers in _pieces(start, sentence):
            if not piece.strip():
                continue
            numbers += piece_numbers
            if numbers > MAX_NUMBERS_PER_TEXT or not budget.spend(len(piece)):
                return facts, True                              # stop reading here: the rest is not looked at
            s = _Sentence(source, piece_start, piece_start + len(piece), piece, heading)
            for reader in _READERS:
                reader(s)
            facts.extend(s.facts)
            if len(facts) >= MAX_FACTS_PER_TEXT:
                return facts[:MAX_FACTS_PER_TEXT], True
    return facts, truncated


def read(text: str, source: str) -> tuple[list[Fact], bool]:
    """Every statement of a value in the text, and whether a limit cut the reading short."""
    return _read(text, source, _Budget())


def extract(text: str, source: str) -> list[Fact]:
    return read(text, source)[0]


def _far(x: float, y: float) -> bool:
    return abs(x - y) > SAME_VALUE_TOLERANCE * max(abs(x), abs(y), 1e-9)


def _different(a: Fact, b: Fact) -> bool:
    if a.bound == b.bound == "range":
        return (a.high < b.low and _far(a.high, b.low)) or (b.high < a.low and _far(b.high, a.low))
    if a.bound == "range" or b.bound == "range":
        r, p = (a, b) if a.bound == "range" else (b, a)
        if p.bound != "point":
            return False
        return (p.low < r.low and _far(p.low, r.low)) or (p.low > r.high and _far(p.low, r.high))
    if a.bound != b.bound:
        return False                    # "at most 2" and "2" do not disagree; neither do an upper and a lower limit
    return _far(a.low, b.low)


def _same_subject(a: Fact, b: Fact, minimum: int) -> bool:
    """Enough shared content words, at least one of them in the sentences themselves (a heading alone proves
    little), and the shared words must make up at least half of the shorter statement."""
    pa, pb = a.place, b.place
    if a.kind == "count":
        # A count names its own noun ("20 bottles"), so the noun proves nothing: the two sentences themselves
        # (not their headings) must share enough OTHER words.
        shared = pa.own & pb.own
        return len(shared - {a.subject}) >= minimum and 2 * len(shared) >= min(len(pa.own), len(pb.own))
    shared = pa.stems & pb.stems
    return len(shared) >= minimum and len(pa.own & pb.own) >= 1 and 2 * len(shared) >= min(len(pa.stems), len(pb.stems))


def _opposite_requirements(a: Fact, b: Fact) -> bool:
    """One says must, the other must not, in sentences that are otherwise nearly the same."""
    shared = a.place.own & b.place.own
    union = a.place.own | b.place.own
    return a.low != b.low and len(shared) >= POLARITY_MIN_SHARED_WORDS and len(shared) / max(len(union), 1) >= POLARITY_MIN_OVERLAP


def _contradicts(a: Fact, b: Fact, minimum_shared_words: int) -> bool:
    """Do two statements of the same comparable kind disagree about the same thing? (Not yet: are they about another case?)"""
    if a.kind == "requirement":
        return _opposite_requirements(a, b)
    return _different(a, b) and _same_subject(a, b, minimum_shared_words)


Siblings = Mapping[tuple[str, int, int], Sequence[Fact]]


def _other_case(a: Fact, b: Fact, siblings: Siblings, budget: _Budget) -> bool:
    """True when the two sentences are about different cases (another line, another bottle size ...)."""
    names_a, names_b = dict(a.place.labels), dict(b.place.labels)
    if any(k in names_b and names_b[k] != v for k, v in names_a.items()):
        return True
    side_b = [y for y in siblings[_sentence_key(b)] if y is not b]
    side_a = siblings[_sentence_key(a)]
    budget.spend(len(side_a) * max(len(side_b), 1))             # at most MAX_SIBLINGS x MAX_SIBLINGS
    for x in side_a:
        if x is a or x.comparable == a.comparable:
            continue
        same = [y for y in side_b if y.comparable == x.comparable]
        if same and all(_different(x, y) for y in same):
            return True
    return False


def _sentence_key(f: Fact) -> tuple[str, int, int]:
    return (f.place.source, f.place.start, f.place.end)


_NUMBER_TOKEN = re.compile(r"\d{1,3}(?:,\d{3}){1,5}(?:\.\d{1,12})?|\d{1,15}(?:\.\d{1,12})?")


def _magnitudes(text: str) -> list[float]:
    """The numbers in a text without their signs: an answer may write "18" for a source's "-18"."""
    return [float(n.replace(",", "")) for n in _NUMBER_TOKEN.findall(text)]


class _Cited:
    """Which statements the answer relies on: their sentence overlaps a quoted span AND the answer states their value."""

    def __init__(self, cited: Sequence[tuple[str, int, int]] | None, answer: str | None) -> None:
        self._spans = cited
        self._answer = answer.lower() if answer is not None else None
        self._said = set(_magnitudes(answer)) if answer is not None else set()

    def __call__(self, f: Fact) -> bool:
        if self._spans is not None and not any(s == f.place.source and start < f.place.end and f.place.start < end for s, start, end in self._spans):
            return False
        if self._answer is None or f.kind == "requirement":
            return True
        wanted = _magnitudes(f.raw)
        if not wanted:
            return f.raw.lower() in self._answer
        return all(n in self._said for n in wanted)


def check(texts: Mapping[str, str], cited: Sequence[tuple[str, int, int]] | None = None, answer: str | None = None,
          minimum_shared_words: int = 2, *, focus: str | None = None) -> Report:
    """Conflicts between different sources.

    `cited`: (source, start, end) spans the answer relies on. When given, only conflicts that involve a sentence
    overlapping one of them count. `answer`: the answer's own words. When given, the cited side's value must be
    stated in it. Together: an answer is refused for a disagreement about what it SAYS, not for any disagreement
    somewhere in the material (a quoted table row may hold other values the answer never mentions).
    When both are None, every pair of sources is compared (used for verified items).
    `focus`: when given, only pairs that include this source are compared (one item against many others); each
    text is still read exactly once.
    """
    truncated = False
    budget = _Budget()
    order = list(texts)
    by_kind: dict[tuple[str, str, str], dict[str, list[tuple[Fact, bool]]]] = {}
    siblings: dict[tuple[str, int, int], list[Fact]] = {}
    is_cited = _Cited(cited, answer)
    for source in order:
        facts, cut = _read(texts[source], source, budget)
        truncated = truncated or cut
        for f in facts:
            by_kind.setdefault(f.comparable, {}).setdefault(source, []).append((f, is_cited(f)))
            if f.kind != "requirement":
                others = siblings.setdefault(_sentence_key(f), [])
                if len(others) < MAX_SIBLINGS:
                    others.append(f)
            else:
                siblings.setdefault(_sentence_key(f), [])

    found: list[Conflict] = []
    compared = 0
    for per_source in by_kind.values():
        sources = [s for s in order if s in per_source]
        for i, sa in enumerate(sources):
            for sb in sources[i + 1:]:
                if focus is not None and focus not in (sa, sb):
                    continue
                hit = _first_conflict(per_source[sa], per_source[sb], siblings, minimum_shared_words, MAX_COMPARISONS - compared, budget)
                compared += hit[1]
                if hit[0] is not None:
                    found.append(hit[0])
                if compared >= MAX_COMPARISONS or len(found) >= MAX_CONFLICTS or budget.left < 0:
                    return Report(_in_text_order(found, order), True, budget.used)
    return Report(_in_text_order(found, order), truncated or budget.left < 0, budget.used)


def _first_conflict(side_a: Sequence[tuple[Fact, bool]], side_b: Sequence[tuple[Fact, bool]], siblings: Siblings, minimum_shared_words: int,
                    comparisons_left: int, budget: _Budget) -> tuple[Conflict | None, int]:
    """The first disagreement between two sources about one comparable kind (one is enough to report), and how many pairs were looked at."""
    looked = 0
    for a, a_cited in side_a:
        for b, b_cited in side_b:
            if not budget.spend():                              # every pair costs a step, also the ones passed over
                return None, looked
            if not (a_cited or b_cited):
                continue
            looked += 1
            if _contradicts(a, b, minimum_shared_words) and not _other_case(a, b, siblings, budget):
                return Conflict(a, b), looked
            if looked >= comparisons_left:
                return None, looked
    return None, looked


def _in_text_order(found: list[Conflict], order: list[str]) -> list[Conflict]:
    """As before the kinds were grouped: by source pair, then by where the first statement stands."""
    rank = {s: i for i, s in enumerate(order)}
    return sorted(found, key=lambda c: (rank[c.a.source], rank[c.b.source], c.a.place.start, c.b.place.start))


def find_conflicts(texts: Mapping[str, str], cited: Sequence[tuple[str, int, int]] | None = None, answer: str | None = None,
                   minimum_shared_words: int = 2) -> list[Conflict]:
    return check(texts, cited, answer, minimum_shared_words).conflicts
