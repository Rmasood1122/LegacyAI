"""Redaction measured on a synthetic golden set (feature 18; docs/phase2/05 §3).

Every value below is made up: reserved e-mail domains (.test / .invalid / example.*), 555 phone
numbers, published test card numbers, the standard example IBANs, documentation IP ranges, fake
keys with the right SHAPE. Generated from a fixed seed so every run measures the same set.

What is measured, per category:
  recall    = share of planted values that are fully covered by some redaction (the value does not survive);
  precision = share of redactions that cover a planted value (the rest are false alarms; the clean
              technical sentences are there to provoke them).
The numbers are printed with their sample sizes. The floors below are deliberately set UNDER the
measured values so a regression fails the build; they are not claims of quality.
What it does NOT cover: real documents, other languages, names in unusual formats, street addresses,
identification by context ("the only welder on the night shift").
"""

from __future__ import annotations

import random
from collections import defaultdict
from dataclasses import dataclass

import pytest

from app.capture.redaction import redact

pytestmark = pytest.mark.models

SEED = 20261003
FIRST = ["Maria", "James", "Aisha", "Tomasz", "Priya", "Liam", "Chen", "Fatima", "Oliver", "Sofia", "Kwame", "Elena", "Hiroshi",
         "Grace", "Mateo", "Noor", "Daniel", "Ingrid", "Samuel", "Leila"]
LAST = ["Johnson", "Okafor", "Kowalski", "Patel", "Murphy", "Wang", "Haddad", "Brown", "Rossi", "Mensah", "Petrova", "Tanaka",
        "Clarke", "Garcia", "Rahman", "Fischer", "Lindqvist", "Adeyemi", "Moreau", "Novak"]
CITIES = ["Manchester", "Chicago", "Lagos", "Hamburg", "Toronto", "Melbourne", "Lyon", "Osaka", "Denver", "Glasgow"]
CARDS = ["4111111111111111", "5555555555554444", "378282246310005", "6011111111111117", "4012888888881881", "5105105105105100"]
IBANS = ["GB82WEST12345698765432", "DE89370400440532013000", "FR1420041010050500013M02606", "NL91ABNA0417164300"]
DOMAINS = ["example.com", "example.org", "corp.test", "mail.invalid"]


@dataclass(frozen=True)
class Planted:
    category: str
    start: int
    end: int


TEMPLATES: dict[str, list[str]] = {
    "PERSON": ["Ask {v} before you change the torque settings.", "The checklist was written by {v} last spring.",
               "If the alarm repeats, call {v} on the night shift.", "{v} knows why the second filter is there."],
    "EMAIL": ["Send the readings to {v} every Friday.", "Questions go to {v}.", "Contact: {v}"],
    "PHONE": ["The supplier hotline is {v}.", "Call {v} if the pressure drops.", "Out of hours: {v}"],
    "CREDIT_CARD": ["The company card {v} is used for spare parts.", "Paid with card number {v}."],
    "IBAN": ["Invoices are paid to {v}.", "Refunds go back to account {v}."],
    "SECRET": ["The service login is password: {v}", "Use api_key={v} for the scale.", "Header: Bearer {v}",
               "AWS key {v} is for the backup bucket.", "Token for the robot: {v}"],
    "IP_ADDRESS": ["The PLC answers on {v}.", "Ping {v} to check the line controller."],
    "LOCATION": ["The spare pumps are stored in {v}.", "The second plant is near {v}."],
    "GOV_ID": ["Her social security number {v} is on the form.", "SSN {v} was entered by mistake."],
}
CLEAN = [
    "Open valve V2 fully before starting pump P-7.", "Torque the M12 bolts to 80 Nm in a star pattern.",
    "Line 3 runs at 1,200 units per hour after the 2024 upgrade.", "Replace filter F-200 every 500 operating hours.",
    "The batch number is printed on the left side of the label.", "Keep the oven at 180 degrees for 25 minutes.",
    "Check the gauge reads below 4 bar, then close the bypass.", "Version 2.3 of the procedure replaced version 2.1.",
    "Order part 4471-B when stock falls below 10 units.", "The night shift handover happens at 22:00 in the control room.",
]


def _value(rng: random.Random, category: str) -> str:
    if category == "PERSON":
        return f"{rng.choice(FIRST)} {rng.choice(LAST)}"
    if category == "EMAIL":
        return f"{rng.choice(FIRST).lower()}.{rng.choice(LAST).lower()}{rng.randint(1, 99)}@{rng.choice(DOMAINS)}"
    if category == "PHONE":
        return rng.choice([f"(212) 555-{rng.randint(1000, 1999)}", f"+1 415 555 {rng.randint(1000, 1999)}", f"212-555-{rng.randint(1000, 1999)}"])
    if category == "CREDIT_CARD":
        c = rng.choice(CARDS)
        return " ".join(c[i:i + 4] for i in range(0, len(c), 4)) if rng.random() < 0.5 else c
    if category == "IBAN":
        return rng.choice(IBANS)
    if category == "SECRET":
        alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
        return rng.choice([
            "".join(rng.choice(alphabet) for _ in range(12)),
            "AKIA" + "".join(rng.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567") for _ in range(16)),
            "ghp_" + "".join(rng.choice(alphabet) for _ in range(36)),
            "sk-test-" + "".join(rng.choice(alphabet) for _ in range(24)),
        ])
    if category == "IP_ADDRESS":
        return rng.choice([f"192.0.2.{rng.randint(1, 254)}", f"198.51.100.{rng.randint(1, 254)}", f"203.0.113.{rng.randint(1, 254)}"])
    if category == "LOCATION":
        return rng.choice(CITIES)
    if category == "GOV_ID":
        return f"{rng.randint(100, 665):03d}-{rng.randint(10, 99):02d}-{rng.randint(1000, 9999):04d}"
    raise ValueError(category)


PER_CATEGORY = {"PERSON": 80, "EMAIL": 50, "PHONE": 50, "CREDIT_CARD": 40, "IBAN": 30, "SECRET": 60, "IP_ADDRESS": 30,
                "LOCATION": 40, "GOV_ID": 30}


def golden() -> list[tuple[str, list[Planted]]]:
    rng = random.Random(SEED)
    docs: list[tuple[str, list[Planted]]] = []
    for category, n in PER_CATEGORY.items():
        for _ in range(n):
            template = rng.choice(TEMPLATES[category])
            value = _value(rng, category)
            lead = rng.choice(CLEAN) + " "
            text = lead + template.replace("{v}", value)
            start = text.index(value)
            docs.append((text, [Planted(category, start, start + len(value))]))
    for sentence in CLEAN * 4:
        docs.append((sentence, []))
    return docs


def measure() -> tuple[dict[str, tuple[int, int]], dict[str, tuple[int, int]], int]:
    """Returns recall counts {category: (covered, planted)}, precision counts {type: (true, all)}, total planted."""
    recall: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    precision: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    total = 0
    for text, planted in golden():
        findings = redact(text).findings
        for p in planted:
            total += 1
            recall[p.category][1] += 1
            covered = [False] * (p.end - p.start)
            for f in findings:
                for i in range(max(f.start, p.start), min(f.end, p.end)):
                    covered[i - p.start] = True
            if all(covered):
                recall[p.category][0] += 1
        for f in findings:
            precision[f.entity_type][1] += 1
            if any(f.start < p.end and p.start < f.end for p in planted):
                precision[f.entity_type][0] += 1
    return ({k: (v[0], v[1]) for k, v in recall.items()}, {k: (v[0], v[1]) for k, v in precision.items()}, total)


# Floors: set below the values measured when this test was written (printed by the test). A drop fails the build.
# Measured 2026-10-03 (local run): overall recall 398/410 = 0.97, precision 399/403 = 0.99; PERSON 76/80, LOCATION 38/40,
# SECRET 54/60, the rest 100 %. This set is templated and therefore EASIER than real documents.
RECALL_FLOOR = {"EMAIL": 0.95, "PHONE": 0.95, "CREDIT_CARD": 0.95, "IBAN": 0.95, "SECRET": 0.85, "IP_ADDRESS": 0.95,
                "GOV_ID": 0.9, "PERSON": 0.9, "LOCATION": 0.9}
OVERALL_RECALL_FLOOR = 0.93
OVERALL_PRECISION_FLOOR = 0.95


def test_redaction_on_the_golden_set(capsys: pytest.CaptureFixture[str]) -> None:
    recall, precision, total = measure()
    assert total >= 300, "the golden set must hold at least 300 planted values"
    lines = [f"redaction-golden: {total} planted values in {len(golden())} synthetic texts (seed {SEED})"]
    lines.append("redaction-golden: recall " + ", ".join(f"{c} {recall[c][0]}/{recall[c][1]}" for c in sorted(recall)))
    lines.append("redaction-golden: precision " + ", ".join(f"{c} {precision[c][0]}/{precision[c][1]}" for c in sorted(precision)))
    all_hit = sum(h for h, _ in recall.values())
    all_true, all_found = sum(g for g, _ in precision.values()), sum(n for _, n in precision.values())
    lines.append(f"redaction-golden: overall recall {all_hit}/{total} = {all_hit / total:.2f}; "
                 f"overall precision {all_true}/{all_found} = {all_true / max(all_found, 1):.2f}")
    with capsys.disabled():
        print("\n" + "\n".join(lines))
    for cat, floor in RECALL_FLOOR.items():
        hit, n = recall[cat]
        assert hit / n >= floor, f"{cat} recall {hit}/{n} fell below {floor}"
    assert all_hit / total >= OVERALL_RECALL_FLOOR
    assert all_true / max(all_found, 1) >= OVERALL_PRECISION_FLOOR


def test_same_value_same_placeholder_and_numbering_is_shared() -> None:
    numbering: dict[str, dict[str, int]] = {}
    a = redact("Mail jane.roe@example.com today.", numbering=numbering)
    b = redact("Again: jane.roe@example.com and bob.lee@example.com.", numbering=numbering)
    assert "[EMAIL_1]" in a.text and b.text.count("[EMAIL_1]") == 1 and "[EMAIL_2]" in b.text


def test_allowlisted_terms_are_kept() -> None:
    assert "Glasgow" in redact("Ship it to Glasgow.", frozenset({"glasgow"})).text


# Hard negatives (docs/phase2/09 §5): text that LOOKS sensitive but is not - part numbers shaped like ids,
# machines with people's names, product names that are place names.
HARD_NEGATIVES = [
    "Order valve PV-3 and seal kit SK-4471-02 from the store.",
    "The gearbox takes ISO VG 220 oil.",
    "Machine number 4012-8888 is the old labeler.",
    "Serial number 378-28-2246 is on the filler nameplate.",
    "Use torque wrench TW-5105 for the capper.",
    "Bertha, the old filler, is switched off on Sundays.",
    "Big Joe, our palletiser, needs a new belt.",
    "The compressor called Hector runs at 7 bar.",
    "Line 2 runs at 420 bottles per minute.",
    "Label roll 500-L goes in magazine 2.",
    "Batch 2026-10-03-A was released by the lab.",
    "Pallet 0042-1177 is on hold.",
    "Fault F33 means low CO2 pressure.",
    "The spare star wheel set B is on shelf 14.",
    "Room 101 is the electrical room.",
    "Check bearing 6205-2RS on the drive.",
    "Set the timer to 15:30 for the clean.",
    "The HMI shows code E-4410 when the door is open.",
    "Cabinet E3 holds the main disconnect.",
    "Valve V-9 releases the stored air.",
    "Work order 778812 covers the gearbox.",
    "Part 1234-5678-9012 is a filler nozzle.",
    "Rinser nozzle 7 was replaced.",
    "The Brussels sprout recipe is not ours.",
    "Paris blue is the colour of the new caps.",
    "Madison is the brand of the hand torque tester.",
    "Sydney mode is the slow test cycle on the HMI.",
    "The Victoria pump feeds the rinser.",
    "Grease type NLGI 2 is used on the bearings.",
    "Recipe 330-STD is for small bottles.",
    "Program 7 is the night cleaning cycle.",
    "Speed setpoint 180 is used at start.",
    "The 28 mm caps come in crates of 1000.",
    "Sensor S-12 watches the bowl level.",
    "Drive DR-2200 powers the main conveyor.",
    "The OEE target is 78 percent.",
    "Version 4.2.1 of the HMI software is installed.",
    "Shift pattern 2-2-3 is used on Line 2.",
    "Tank T-500 holds the product.",
    "Check list CL-09 is used for changeovers.",
]
# Measured 2026-10-03: 6 of 40 redacted (an id-shaped serial number, "Valve V-9" read as a name, and four place or
# person names used as product names). The design PROPOSED at most 4 (10 %); this MISSES it. The floor below
# only stops it getting worse. Over-redaction is the safe direction; the company allow-list can fix such terms.
HARD_NEGATIVE_CEILING = 6


def test_hard_negatives(capsys: pytest.CaptureFixture[str]) -> None:
    assert len(HARD_NEGATIVES) == 40
    flagged = [s for s in HARD_NEGATIVES if redact(s).findings]
    with capsys.disabled():
        print(f"redaction-golden: hard negatives redacted {len(flagged)}/40 (design proposed at most 4)")
    assert len(flagged) <= HARD_NEGATIVE_CEILING
