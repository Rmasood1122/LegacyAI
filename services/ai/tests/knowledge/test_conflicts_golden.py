"""The contradiction check in code, measured on a fixed set (feature 23, docs/phase4/01).

All text is synthetic. Two lists: pairs of statements that DO disagree and must be found, and "hard negatives" -
pairs that look alike but do not disagree (other machine, other bottle size, equal values in other units, a range
that contains the value) and must be left alone. The counts are printed like the redaction golden test; the
floors below only stop the measured result getting worse. They say nothing about text the set does not contain.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

from app.knowledge.conflicts import PUBLIC_MEASURES, extract, find_conflicts

GOLDEN = Path(__file__).resolve().parents[2] / "eval" / "golden"

CONFLICTS: list[tuple[str, str]] = [
    ("The capper torque is set to 2.2 Nm on all heads.", "Capper torque setting: 1.8 Nm on all heads."),
    ("Take samples every 30 minutes during production.", "In-line sampling: take samples every 60 minutes during production."),
    ("Grease the filler star wheel bearings every 250 operating hours.", "Grease the filler star wheel bearings every 500 operating hours."),
    ("The CO2 low-pressure alarm comes when the CO2 pressure falls below 3.2 bar.", "The CO2 low-pressure alarm is set at 3.0 bar."),
    ("Target time for the whole changeover: 45 minutes.", "From this month, the changeover target is 30 minutes."),
    ("Start the conveyor at 180 bottles per minute.", "To reduce the slow start period, start the conveyor at 240 bottles per minute."),
    ("The first 20 bottles after start-up are rejected.", "After every line start-up, reject the first 50 bottles."),
    ("Change the main gearbox oil every 4000 operating hours.", "Change the main gearbox oil every 2000 operating hours."),
    ("The main air regulator must read 6.0 bar before the line is started.", "Before starting the line the main air regulator must read 5.5 bar."),
    ("The rinser water pressure must be 2.5 bar.", "Rinser water pressure: 3 bar."),
    ("The labeler glue station temperature is set to 160 °C.", "Set the glue station temperature of the labeler to 145 °C."),
    ("Hold filling if the product temperature is above 6 °C.", "Filling is held when the product temperature is above 8 °C."),
    ("Set the guide rails to 72 mm for 500 ml bottles.", "For 500 ml bottles the guide rails are set to 75 mm."),
    ("Raise the filler height by 40 mm.", "The filler height is raised by 35 mm."),
    ("Send the first 3 bottles to the quality lab.", "The first 5 bottles are sent to the quality lab."),
    ("At most 2 valves may be isolated at the same time.", "At most 3 valves may be isolated at the same time."),
    ("Replace the capper springs every 6 months.", "The capper springs are replaced every 12 months."),
    ("The capper head chain is oiled weekly.", "Oil the capper head chain daily."),
    ("Check the vibration of the main drive monthly.", "The vibration of the main drive is checked weekly."),
    ("The OEE target for Line 2 is 78 %.", "Line 2 has an OEE target of 85 %."),
    ("CO2 content target for sparkling water: 5.5 g/L.", "The CO2 content target for sparkling water is 6.0 g/L."),
    ("Retained samples are kept for 6 months in the sample store.", "Keep retained samples in the sample store for 12 months."),
    ("Cap removal torque must be between 1.2 and 2.0 Nm.", "The cap removal torque is 2.6 Nm."),
    ("The fill level for 500 ml bottles is 500 ml ± 5 ml.", "Fill level for 500 ml bottles: 520 ml."),
    ("The boiler relief valve lifts at 6 bar.", "The relief valve of the boiler lifts at 7.5 bar."),
    ("Run the cleaning cycle for 20 minutes.", "The cleaning cycle runs for 1 hour."),
    ("The compressor oil is changed every 2000 operating hours.", "Change the compressor oil every 3000 operating hours."),
    ("Ramp the conveyor up to 420 bottles per minute.", "The conveyor is ramped up to 380 bottles per minute."),
    ("Take 5 caps from the first run and check the torque.", "Check the torque on 10 caps taken from the first run."),
    ("The pallet wrapper applies 12 wraps of film to each pallet.", "Each pallet gets 8 wraps of film from the pallet wrapper."),
    ("Operators must wear hearing protection inside the filler room.",
     "Operators do not need hearing protection inside the filler room; they must not wear it near the filler."),
    ("The spare parts store is checked weekly by the maintenance lead.", "The maintenance lead checks the spare parts store monthly."),
]

HARD_NEGATIVES: list[tuple[str, str]] = [
    # the same value in other words or units
    ("Run the cleaning cycle for 30 minutes.", "The cleaning cycle runs for 0.5 hours."),
    ("The rinser water pressure must be 2.5 bar.", "Rinser water pressure: 2500 mbar."),
    ("Raise the filler height by 40 mm.", "The filler height is raised by 4 cm."),
    ("Replace the capper springs every 6 months.", "The capper springs are replaced every 6 months."),
    ("The main gearbox holds 2 l of oil.", "The main gearbox holds 2000 ml of oil."),
    # a range that contains the value; limits that do not disagree
    ("Cap removal torque must be between 1.2 and 2.0 Nm.", "The cap removal torque measured today was 1.8 Nm."),
    ("The fill level for 500 ml bottles is 500 ml ± 5 ml.", "Fill level for 500 ml bottles: 502 ml."),
    ("At most 2 valves may be isolated at the same time.", "Today 2 valves were isolated at the same time."),
    ("The product temperature must be at most 6 °C.", "The product temperature must be at least 2 °C."),
    # another case: other size, other line, other head, other fault
    ("Set the guide rails to 72 mm for 500 ml bottles.", "Set the guide rails to 64 mm for 330 ml bottles."),
    ("Line 1 starts the conveyor at 180 bottles per minute.", "Line 2 starts the conveyor at 240 bottles per minute."),
    ("Capper head 4 is set to 2.2 Nm.", "Capper head 2 is set to 1.8 Nm."),
    ("Fault F33 comes when the pressure falls below 3.2 bar.", "Fault F12 comes when the pressure falls below 1.5 bar."),
    ("CO2 bank A is refilled at 20 bar.", "CO2 bank B is refilled at 35 bar."),
    ("Recipe 330 uses a filling time of 4 seconds.", "Recipe 500 uses a filling time of 6 seconds."),
    # another thing altogether, although words repeat
    ("The main air regulator next to the filler must read 6.0 bar.", "The CO2 pressure alarm of the filler comes below 3.2 bar."),
    ("The capper head chain is oiled weekly.", "Replace the capper springs every 6 months, or earlier if a head gives low torque readings."),
    ("Take 5 bottles every 30 minutes from the outfeed of the capper.", "After every line start-up, reject the first 50 bottles before sampling begins."),
    ("Start the conveyor at 180 bottles per minute.", "After 10 minutes of stable running, ramp up to 420 bottles per minute."),
    ("The capper torque is set to 2.2 Nm on all heads.", "Cap removal torque must be between 1.2 and 2.0 Nm in quality sampling."),
    ("Check the vibration of the main drive monthly.", "Change the main gearbox oil every 2000 operating hours."),
    ("The glue station temperature is 160 °C.", "The product temperature must stay below 6 °C."),
    ("Retained samples are kept for 6 months.", "Take samples every 60 minutes during production."),
    ("The first 3 bottles go to the quality lab after a changeover.", "Run 10 bottles in jog mode and check the transfer points."),
    ("Every stop longer than 5 minutes must be given a downtime code.", "The downtime code is entered within 15 minutes of the restart."),
    # numbers that are names, dates or codes, not quantities
    ("Maintenance handbook (2019 edition): grease the bearings.", "Quality lab handbook (2025 edition): grease is not used."),
    ("Call maintenance on extension 4410.", "Call the quality lab on extension 4520."),
    ("Load label roll type 500-L into magazine 2.", "Load label roll type 330-L into magazine 1."),
    ("The task is recorded with task code LUB-02.", "The task is recorded with task code LUB-07 for the capper."),
    # the same statement twice
    ("The CO2 low-pressure alarm is set at 3.0 bar.", "The CO2 low-pressure alarm is set at 3.0 bar."),
    ("Operators must wear hearing protection inside the filler room.", "Operators must wear hearing protection inside the filler room at all times."),
    ("Never use a lubricant that is not food grade above the product line.", "Use only food-grade lubricant above the product line."),
]

# Measured 2026-10-04 on this set. The floors only stop it getting worse.
CONFLICTS_FOUND_FLOOR = 30
HARD_NEGATIVES_FLAGGED_CEILING = 1


def flagged(pair: tuple[str, str]) -> bool:
    """As in the answer flow: the first statement is quoted and the answer repeats it."""
    a, b = pair
    return bool(find_conflicts({"a": a, "b": b}, cited=[("a", 0, len(a))], answer=a))


def test_conflict_golden_set(capsys: pytest.CaptureFixture[str]) -> None:
    assert len(CONFLICTS) >= 30 and len(HARD_NEGATIVES) >= 30
    missed = [p for p in CONFLICTS if not flagged(p)]
    wrong = [p for p in HARD_NEGATIVES if flagged(p)]
    with capsys.disabled():
        print(f"\nconflict-golden: conflicts found {len(CONFLICTS) - len(missed)}/{len(CONFLICTS)}; "
              f"hard negatives wrongly flagged {len(wrong)}/{len(HARD_NEGATIVES)}")
        for p in missed:
            print(f"conflict-golden: MISSED {p[0]!r} / {p[1]!r}")
        for p in wrong:
            print(f"conflict-golden: WRONGLY FLAGGED {p[0]!r} / {p[1]!r}")
    assert len(CONFLICTS) - len(missed) >= CONFLICTS_FOUND_FLOOR
    assert len(wrong) <= HARD_NEGATIVES_FLAGGED_CEILING


def docs() -> dict[str, str]:
    return {p.name[:3]: p.read_text(encoding="utf-8") for p in sorted((GOLDEN / "docs").glob("d*")) if not p.name.startswith("d13")}


def test_the_eight_planted_conflicts_of_the_evaluation_set_are_found_from_either_side() -> None:
    """Includes the two a real model answered from one side (C02 sampling interval, C04 CO2 alarm pressure)."""
    texts = docs()
    questions = yaml.safe_load((GOLDEN / "questions.yaml").read_text(encoding="utf-8"))["conflicting"]
    assert len(questions) == 8
    for q in questions:
        a, b = q["docs"]
        for cited_doc, value in zip((a, b), q["values"], strict=True):
            digits = value.split()[-2] if value.startswith("every") else value.split()[0]
            found_at = re.search(r"(?<![\d.])" + re.escape(digits) + r"(?![\d.]\d)", texts[cited_doc])   # 20, not the 20 inside 420
            assert found_at is not None
            at = found_at.start()
            line_start = texts[cited_doc].rfind("\n", 0, at) + 1
            line_end = texts[cited_doc].find("\n", at)
            found = find_conflicts({a: texts[a], b: texts[b]}, cited=[(cited_doc, line_start, line_end)], answer=f"It is {value}.")
            assert found, f"{q['id']}: no conflict found when the answer cites {cited_doc} ({value})"


def test_an_answer_about_something_else_is_not_refused_for_a_conflict_elsewhere() -> None:
    """d01 and d11 disagree on the conveyor START speed. An answer citing the RAMP speed (420) is not about that."""
    texts = docs()
    line = texts["d01"].index("Start the conveyor at 180")
    whole_line = [("d01", line, texts["d01"].index("\n", line))]            # both sentences are on this line and are quoted
    pair = {"d01": texts["d01"], "d11": texts["d11"]}
    assert find_conflicts(pair, cited=whole_line, answer="It is ramped up to 420 bottles per minute after 10 minutes.") == []
    assert find_conflicts(pair, cited=whole_line, answer="The conveyor is started at 180 bottles per minute.")


def test_no_answerable_question_of_the_evaluation_set_is_refused_by_the_check(capsys: pytest.CaptureFixture[str]) -> None:
    """For each answerable question: cite the line that holds its first expected value and compare with ALL documents."""
    texts = docs()
    questions = yaml.safe_load((GOLDEN / "questions.yaml").read_text(encoding="utf-8"))["answerable"]
    refused, checked = [], 0
    for q in questions:
        doc = q["docs"][0]
        needle = q["points"][0]
        at = texts[doc].lower().find(needle.lower())
        if at == -1:
            continue                                # the point is worded differently in the document; nothing to cite here
        checked += 1
        line_end = texts[doc].find("\n", at)
        cited = [(doc, texts[doc].rfind("\n", 0, at) + 1, line_end if line_end != -1 else len(texts[doc]))]   # the whole line is quoted
        said = "; ".join(q["points"])                                                                          # the answer states the expected points
        found = find_conflicts(texts, cited=cited, answer=said)
        if found:
            refused.append((q["id"], found[0].measure, found[0].a.raw, found[0].b.raw))
    with capsys.disabled():
        print(f"conflict-golden: answerable questions wrongly refused {len(refused)}/{checked} "
              "(whole line quoted, expected points stated, compared with all 12 documents)")
        for r in refused:
            print(f"conflict-golden: REFUSED {r}")
    assert checked >= 25
    assert refused == []


def test_units_are_compared_by_value_and_ranges_by_containment() -> None:
    assert find_conflicts({"a": "The cycle runs for 30 minutes.", "b": "The cycle runs for 0.5 hours."}) == []
    assert find_conflicts({"a": "The cycle runs for 30 minutes.", "b": "The cycle runs for 45 minutes."})
    assert find_conflicts({"a": "Removal torque between 1.2 and 2.0 Nm.", "b": "Removal torque 1.5 Nm."}) == []
    assert find_conflicts({"a": "Removal torque between 1.2 and 2.0 Nm.", "b": "Removal torque 2.4 Nm."})


def test_statements_of_one_source_are_never_compared_with_each_other() -> None:
    text = "Start the conveyor at 180 bottles per minute. Later start the conveyor at 240 bottles per minute."
    assert find_conflicts({"a": text}) == []
    assert len({f.comparable for f in extract(text, "a")}) == 1


def test_the_conflict_names_both_values_and_what_they_measure() -> None:
    c = find_conflicts({"old": "The alarm is set at 3.0 bar.", "new": "The alarm is set at 3.2 bar."})[0]
    assert (c.measure, c.a.source, c.a.raw, c.b.source, c.b.raw) == ("pressure", "old", "3.0 bar", "new", "3.2 bar")
    assert c.measure in PUBLIC_MEASURES


def test_a_minus_sign_is_part_of_the_value() -> None:
    assert find_conflicts({"a": "The dough freezer is kept at -18 °C.", "b": "The dough freezer is kept at 18 °C."})
    assert find_conflicts({"a": "The dough freezer is kept at -18 °C.", "b": "The dough freezer is kept at -12 °C."})
    assert find_conflicts({"a": "The dough freezer is kept at -18 °C.", "b": "The dough freezer is kept at -18 °C."}) == []
    # a hyphen inside a code or a range is not a sign
    assert [f.low for f in extract("Use part LUB-02 at 2-3 bar.", "a") if f.kind == "measure"] == [2.0]
    # an answer that writes the value without its sign still relies on that statement
    assert find_conflicts({"a": "The dough freezer is kept at -18 °C.", "b": "The dough freezer is kept at -12 °C."},
                          cited=[("a", 0, 40)], answer="It is kept at minus 18 °C.")


# Held out: written AFTER the rule and its word lists, about other workplaces (a bakery, a warehouse, an IT desk), with
# statements spread over two sentences and with the SECOND source being the one the answer cites. The word lists were
# not changed for them. The counts are what was measured; they are the honest estimate of how the rule does on text it
# was not built around, and the floors only stop it getting worse.
HELD_OUT_CONFLICTS: list[tuple[str, str]] = [
    ("The proofing cabinet is held at 32 °C. Dough rests there before baking.", "Proofing happens in the cabinet. The proofing cabinet is held at 38 °C."),
    ("Backups of the order database run every 4 hours.", "The order database backups run every 12 hours."),
    ("Dough pieces weigh 450 g before proofing.", "Before proofing the dough pieces weigh 520 g."),
    ("The freezer for retained dough is kept at -18 °C.", "Retained dough is kept in the freezer at -12 °C."),
    ("Forklift drivers must sound the horn at the dock crossing.", "Forklift drivers must not sound the horn at the dock crossing."),
    ("Each delivery crate holds 24 loaves.", "A delivery crate holds 30 loaves."),
    ("The oven conveyor runs at 12 trays per hour. This applies to rye bread.", "For rye bread the oven conveyor runs at 18 trays per hour."),
    ("Calibrate the dough scale monthly.", "The dough scale is calibrated weekly."),
    ("Password resets expire after 15 minutes.", "A password reset expires after 60 minutes."),
    ("Stack at most 6 crates on one dolly.", "At most 9 crates are stacked on one dolly."),
]
HELD_OUT_NEGATIVES: list[tuple[str, str]] = [
    ("The proofing cabinet is held at 32 °C.", "The baking oven is held at 220 °C."),
    ("The freezer is kept at -18 °C.", "The freezer is kept at -18 °C at all times."),
    ("Dough pieces for baguettes weigh 350 g.", "Dough pieces for rolls weigh 80 g."),
    ("Backups run every 4 hours.", "Backups are kept for 30 days."),
    ("Ticket 4471 was closed in 2 days.", "Ticket 4520 was closed in 5 days."),
    ("Each delivery crate holds 24 loaves.", "Each delivery van holds 40 crates."),
    ("The mixer runs for 8 minutes at slow speed.", "The mixer runs for 4 minutes at fast speed."),
    ("Rye flour is stored below 20 °C. Wheat flour needs no cooling.", "Yeast is stored below 8 °C in the cold room."),
    ("The morning shift bakes 1200 loaves.", "The night shift bakes 800 loaves."),
    ("Password resets expire after 15 minutes.", "Sessions expire after 15 minutes without activity."),
]
# Measured 2026-10-04: 10 of 10 found; 4 of 10 wrongly flagged. The four are pairs told apart by an ordinary word (baguettes /
# rolls, slow / fast, morning / night) or a ticket number - the rule only tells cases apart by a label word it knows, a code or
# another differing value. On unfamiliar text it therefore refuses more often than the first set suggests.
HELD_OUT_FOUND_FLOOR = 10
HELD_OUT_FLAGGED_CEILING = 4


def flagged_citing_second(pair: tuple[str, str]) -> bool:
    a, b = pair
    return bool(find_conflicts({"a": a, "b": b}, cited=[("b", 0, len(b))], answer=b))


def test_held_out_set(capsys: pytest.CaptureFixture[str]) -> None:
    assert len(HELD_OUT_CONFLICTS) >= 8 and len(HELD_OUT_NEGATIVES) >= 8
    missed = [p for p in HELD_OUT_CONFLICTS if not flagged_citing_second(p)]
    wrong = [p for p in HELD_OUT_NEGATIVES if flagged_citing_second(p)]
    with capsys.disabled():
        print(f"\nconflict-golden: HELD-OUT conflicts found {len(HELD_OUT_CONFLICTS) - len(missed)}/{len(HELD_OUT_CONFLICTS)}; "
              f"HELD-OUT non-conflicts wrongly flagged {len(wrong)}/{len(HELD_OUT_NEGATIVES)} (word lists not tuned to this set)")
        for p in missed:
            print(f"conflict-golden: held-out MISSED {p[0]!r} / {p[1]!r}")
        for p in wrong:
            print(f"conflict-golden: held-out WRONGLY FLAGGED {p[0]!r} / {p[1]!r}")
    assert len(HELD_OUT_CONFLICTS) - len(missed) >= HELD_OUT_FOUND_FLOOR
    assert len(wrong) <= HELD_OUT_FLAGGED_CEILING
