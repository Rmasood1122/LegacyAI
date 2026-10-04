# Phase 4 report — completing the 35 features

> Plan: `docs/phase4/00-plan.md`. Every claim is backed by a CI run or labelled ASSUMPTION / NOT PROVEN.
> This report grows step by step; features not listed here are not built.

## Step 1 — features 23 (contradiction and staleness detection) and 22 (answer quality monitor)

> Written 2026-10-04. Evidence: CI run 37188449853 on commit `c4d7432`, 10 of 10 jobs green.
> Design: `docs/phase4/01-contradiction-staleness-quality.md`. Decision D25.

### In plain language

When two sources give different values for the same thing, the product now refuses to answer and shows both
values — decided by a check in code, whatever the AI model says. Verified items that disagree with each other are
marked and sent to a reviewer. Owners and admins get weekly counts of what happened to questions, and readers can
say an answer was helpful, unhelpful or wrong. **Nothing is deployed, and no real AI model was run for this step.**

### What was measured

| Claim | Evidence | Sample and limits |
|---|---|---|
| The check finds planted conflicts | 32 of 32 conflicting pairs found; 0 of 32 look-alike non-conflicts flagged | Written by the rule's author; the rule's word lists contain vocabulary of this set |
| On cases the rule was not written for | 10 of 10 conflicts found; **4 of 10 look-alike non-conflicts wrongly flagged** | Ten and ten cases; not tuned afterwards. The wrongly flagged ones differ only by an ordinary word |
| Through the whole service, with the fake AI answering from one side only | **7 of 8** conflict questions refused, all 7 by the check in code; **2 of 40** answerable questions refused by the check although they had an answer | The fake AI says nothing about a real model; the one miss was not investigated |
| It cannot be made slow by hostile text | Worst case measured 0.22 s for six 12,000-character texts (was up to 23 s before the fix); a test fails above 1 s and above a fixed work budget | Measured on the developer's computer with inputs we invented |
| A real browser shows it | Browser test: two documents state 3.0 bar and 3.2 bar; the answer is "I don't know", both values are shown, "found by comparing the values" | One scenario |
| Screens and API | 20 of 20 browser tests; 117 web unit tests; 682 API tests (1 skipped; statements 87.7 %, branches 82.58 %); both-services walk covers the 5 new operations (129 in total) | Chromium only |
| The migration works with data in the database | A test applies and rolls back the migration's own statements on seeded rows as the migration role; the CI migrations job applies, rolls back and re-applies everything | Seeded test rows, not a production-size database |
| Permission leakage unchanged | 16 attack groups, 64 queries, 0 leaks | as before |

### What the check cannot do

- It reads numbers with units, intervals, counts and plain must / must-not sentences in English. It does **not** catch
  contradictions in ordinary prose, values written as words, values spread over several sentences, tables, or other
  languages. An empty list of conflicts does not mean the sources agree; the screens and the API description say so.
- It errs towards refusing: about 2 in 40 answerable questions on our set, and 4 in 10 on hard look-alikes.
- One document stating a different value forces a refusal for answers that rely on the other value. A document
  cannot do the opposite. Document-against-document conflicts open **no review task** (no fitting task type), so
  nobody is told to resolve them; only conflicts between verified items open a task.
- When a text is longer or denser than the caps, the check looks at the first part only and says "partial".
- **No real AI model was run.** Whether the two failures of the Phase 2 evaluation (C02, C04) are now caught with
  the real model is NOT PROVEN; the detector finds both pairs in a unit test. Proving it needs a paid evaluation
  run (about $0.25), which the founder has not approved.

### What reviews and CI found before this was green

- **Two security reads.** First: the migration's data steps saw no rows under row-level security (would block an
  upgrade on a database with data; fixed), the detector's cost exploded on crafted text (fixed, then found only
  partly fixed by the second read, then fixed by construction), conflict excerpts survived erasure (fixed, with a
  database trigger), hidden items could be probed through the conflict note (fixed), and **the question a person
  asked would have become readable by owner and admin for the first time** (changed: only if the reader ticks
  "Let reviewers see my question"; default off).
- **Three design reviews:** no critical finding; ten warnings fixed (among them: conflicts not cleared when an item
  left the verified state; feedback could not be read back or withdrawn; one fact named three ways in the API).
- **CI:** the audit log refused two new detail fields (added to the allow-list in the database and in code); the
  readiness check expected the previous schema version; four pinned safety lists needed the new entries.

### Open

- The review task for an answer marked wrong can be acted on by owner and admin only (reviewers see a task they
  cannot open).
- A partial comparison between verified items is recorded in the audit log, not shown on the item.
- The stored excerpt of a conflict is deleted at consent withdrawal even under a legal hold (it is a derived copy;
  the held material itself is kept) — a reading of the Phase 2 design, not a legal opinion.
- Weekly counts in a very small company can reveal how much one person asks (not what).
- The last fix round (detector cost, trigger) was checked by a security read, local measurement and CI, not by
  another design review.

### Cost

$0. Total real-AI spend of the project stays $0.642.

## Not built yet (from the plan)

Batch A: 5 (anomaly lock), 11 (retirement radar), 26 (department templates), 27 (outcome analytics), 30 (knowledge
graph), 8 (scenario replay), 4 (QR). Batch B and Batch C: nothing.
