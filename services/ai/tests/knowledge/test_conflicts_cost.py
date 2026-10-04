"""The contradiction check must stay cheap on hostile text (feature 23, docs/phase4/01).

Documents and questions are not trusted: a text packed with numbers must not make an answer, or the verification of an
item, slow. Each case below is the worst this file's author could construct for one of the limits in `conflicts.py`.
The bound is generous for a slow machine; a regression to super-linear cost overshoots it by orders of magnitude.
"""

from __future__ import annotations

import time

import pytest

from app.knowledge import conflicts
from app.knowledge.conflicts import check

BOUND_SECONDS = 1.0


def dense(seed: int, chars: int = 2000) -> str:
    """One long sentence, every statement about the same thing with a different value."""
    out, n = [], seed
    while sum(len(x) + 1 for x in out) < chars:
        out.append(f"valve pressure {n % 97 + 1}.{n % 7} bar")
        n += 1
    return " ".join(out)[:chars]


def many_sentences(seed: int, chars: int = 2000) -> str:
    out, n = [], seed
    while sum(len(x) + 1 for x in out) < chars:
        out.append(f"Set the valve pressure to {n % 89 + 1} bar.")
        n += 1
    return " ".join(out)[:chars]


def never_the_same_case(seed: int, chars: int = 2000) -> str:
    """Every sentence differs from every sentence of the other text in a second value, so no pair is ever a conflict
    and nothing ends the comparing early: the whole budget of comparisons is used."""
    out, n = [], 0
    while sum(len(x) + 1 for x in out) < chars:
        out.append(f"Set the valve pressure to {n % 83 + 1} bar at {seed + n} °C with {seed * 3 + n} mm gap and {seed * 7 + n} kg load.")
        n += 1
    return " ".join(out)[:chars]


CASES = {
    "six passages where no pair is ever a conflict (uses the whole budget)": lambda: {f"s{i}": never_the_same_case(1000 * (i + 1)) for i in range(6)},
    "two items where no pair is ever a conflict": lambda: {"a": never_the_same_case(1000), "b": never_the_same_case(5000)},
    "six passages, one number-dense sentence each": lambda: {f"s{i}": dense(i * 13) for i in range(6)},
    "six passages, many short sentences each": lambda: {f"s{i}": many_sentences(i * 17) for i in range(6)},
    "two items of 2,000 characters": lambda: {"a": dense(1), "b": dense(50)},
    "letters then numbers (the old quadratic look-back)": lambda: {"a": "x" * 1400 + " " + " ".join(str(i) for i in range(150)),
                                                               "b": "y" * 1400 + " " + " ".join(str(i + 1) for i in range(150))},
    "one source far over the character limit": lambda: {"a": many_sentences(3, 60_000), "b": many_sentences(5, 60_000)},
}


@pytest.mark.parametrize("name", list(CASES))
def test_worst_cases_stay_fast(name: str, capsys: pytest.CaptureFixture[str]) -> None:
    texts = CASES[name]()
    started = time.perf_counter()
    report = check(texts)
    with_answer = check(texts, cited=[(next(iter(texts)), 0, 2000)], answer="1 2 3 4 5 6 7 8 9 10 bar")
    seconds = time.perf_counter() - started
    with capsys.disabled():
        print(f"\nconflict-cost: {name}: {seconds:.3f} s for two checks; conflicts {len(report.conflicts)}/{len(with_answer.conflicts)}; "
              f"truncated {report.truncated}")
    assert seconds < BOUND_SECONDS


def test_reaching_a_limit_is_reported() -> None:
    assert check({"a": many_sentences(3, 60_000), "b": "Set the valve pressure to 3 bar."}).truncated
    assert check({"a": dense(1, 9000), "b": dense(2, 9000)}).truncated                       # more statements than are read
    assert not check({"a": "Set the valve pressure to 4 bar.", "b": "Set the valve pressure to 3 bar."}).truncated
    assert len(check({"a": dense(1), "b": dense(50)}).conflicts) <= conflicts.MAX_CONFLICTS


# --------------------------------------------------------------------------- the bound is proved in steps, not only in seconds
#
# `Report.steps` counts the work a check did (characters read, pairs looked at, sibling values looked at). It involves no
# clock, so the assertions on it are deterministic. The inputs: the three the security review measured as quadratic, and
# the worst this file's author could add. Each is run at 2,000, 6,000 and 12,000 characters.

SIZES = (2_000, 6_000, 12_000)
CHECK_SECONDS = 0.5


def fill(unit: str, chars: int) -> str:
    return (unit * (chars // len(unit) + 1))[:chars]


ADVERSARIAL = {
    "comma-grouped digits without a unit (review: 10.9 s at 12,000)": lambda n: fill("111,", n),
    "percentages without a sentence break (review: 2.6 s at 12,000)": lambda n: fill("1%,", n),
    "letters, then numbers": lambda n: "x" * (n * 2 // 3) + " " + fill("7 ", n // 3),
    "thousands of tiny sentences": lambda n: fill("3 bar. ", n),
    "unicode digits and exotic white space": lambda n: fill("٣ bar ٤ kg　", n),
    "one enormous token": lambda n: "9" * n,
    "one enormous word": lambda n: "a" * n,
    "alternating units": lambda n: fill("5 bar 5 kg 5 mm 5 l 5 % ", n),
    "must not, repeated": lambda n: fill("must not must not ", n),
    "ranges and tolerances": lambda n: fill("2-3 bar ± 1 bar between 4 and 5 kg ", n),
    "every / at most before each number": lambda n: fill("every 30 minutes at most 2 valves ", n),
}


@pytest.mark.parametrize("name", list(ADVERSARIAL))
def test_cost_is_bounded_in_steps_and_grows_no_faster_than_the_text(name: str, capsys: pytest.CaptureFixture[str]) -> None:
    make = ADVERSARIAL[name]
    steps, seconds, cut = [], [], []
    for size in SIZES:
        text = make(size)
        started = time.perf_counter()
        one = check({"a": text})                                            # reading alone
        two = check({"a": text, "b": make(size)[::-1][:size] + " " + text})  # reading twice plus comparing
        seconds.append(time.perf_counter() - started)
        steps.append((one.steps, two.steps))
        cut.append((one.truncated, two.truncated))
        assert one.steps <= conflicts.MAX_STEPS and two.steps <= conflicts.MAX_STEPS
        # a limit that was reached is always reported
        numbers = sum(1 for _ in conflicts._SCAN.finditer(text) if not text[_.start()].isspace())
        if numbers > conflicts.MAX_NUMBERS_PER_TEXT or len(conflicts.read(text, "a")[0]) >= conflicts.MAX_FACTS_PER_TEXT:
            assert one.truncated, "a limit was reached without being reported"
    with capsys.disabled():
        print(f"\nconflict-cost: {name}: steps (one text / two texts) " + ", ".join(f"{n:,}: {a:,}/{b:,}" for n, (a, b) in zip(SIZES, steps, strict=True))
              + "; seconds for both checks " + ", ".join(f"{t:.3f}" for t in seconds) + f"; truncated {cut}")
    # near-linear: six times the text may cost at most eight times the work (reading stops early at a limit, so often far less)
    assert steps[-1][0] <= 8 * max(steps[0][0], 1)
    assert steps[-1][1] <= 8 * max(steps[0][1], 1)
    assert max(seconds) < 2 * CHECK_SECONDS                                 # two checks per size


def test_a_piece_is_never_longer_or_fuller_than_its_limits() -> None:
    for make in ADVERSARIAL.values():
        text = make(12_000)
        pieces = list(conflicts._pieces(0, text))
        assert "".join(p for _, p, _ in pieces) == text                      # nothing lost, nothing read twice
        assert all(len(p) <= conflicts.MAX_PIECE_CHARS for _, p, _ in pieces)
        assert all(n <= conflicts.MAX_NUMBERS_PER_PIECE for _, _, n in pieces)
        assert [s for s, _, _ in pieces] == [sum(len(p) for _, p, _ in pieces[:i]) for i in range(len(pieces))]


def test_an_ordinary_sentence_is_one_piece() -> None:
    sentence = "Set the capper torque to 1.8 Nm on all heads and check it every 30 minutes at most 2 valves may be isolated."
    assert [p for _, p, _ in conflicts._pieces(7, sentence)] == [sentence]


def test_the_step_budget_stops_a_check_and_says_so(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(conflicts, "MAX_STEPS", 500)

    class Small(conflicts._Budget):
        def __init__(self, steps: int = 500) -> None:
            super().__init__(steps)
    monkeypatch.setattr(conflicts, "_Budget", Small)
    report = check({"a": many_sentences(1, 4000), "b": many_sentences(2, 4000)})
    assert report.truncated and report.steps <= 500


def test_one_item_against_many_reads_every_text_once_and_compares_only_with_the_one() -> None:
    texts = {"mine": "Set the valve pressure to 4 bar."} | {f"o{i}": f"Set the valve pressure to {i + 5} bar." for i in range(25)}
    report = check(texts, focus="mine")
    assert all("mine" in (c.a.source, c.b.source) for c in report.conflicts) and report.conflicts
    everything = check(texts)
    assert report.steps < everything.steps or everything.truncated         # the other 300 pairs are not compared
