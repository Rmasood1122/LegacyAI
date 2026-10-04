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

## Step 2 — features 5 (anomaly lock), 11 (retirement radar), 26 (department templates)

> Written 2026-10-04. Evidence: CI run 37193320840 on commit `c7f0bc8`, 10 of 10 jobs green.
> Design: `docs/phase4/02-anomaly-radar-templates.md`. Decision D26.

### In plain language

A card that keeps asking for things it may not have is locked and an admin is told. People managers can record when
a person plans to leave and see who is leaving within two years. An admin can start a department's topic list from
a built-in template. **Nothing is deployed.**

### What was measured

| Claim | Evidence | Limits |
|---|---|---|
| The lock works end to end | Browser test: a card makes refused requests, the card page shows "Locked by an anomaly rule", an admin unlocks it with a new code | Threshold lowered to 5 for the test; one scenario |
| A card number alone locks nothing; failed sign-ins and anonymous requests do not count | Integration tests | — |
| Ordinary use does not trip it | A card outside its working hours makes 50 requests: refused each time, never locked. Every refusal reason in the code is classified as counted or not by a unit test | The "company in read-only grace" case is covered by the classification only |
| The only usable Owner is not locked by a rule | Integration test; the event is recorded as "not locked" | An Owner who enters wrong codes IS still locked, as Phase 1 decided |
| A failure of the counter does not break a refusal | Integration test with a broken counter table: the request still gets 403 and its audit row | — |
| Requests marked as coming from another site are refused before the policy | Integration test (`DENY_FETCH_SITE`) | Relies on the browser's Sec-Fetch-Site header; very old browsers do not send it |
| Leaving dates, radar, nudges | Browser test: the owner records a date and the radar lists the person; integration tests for who may read a date, removal on departure, the sweep | **Nothing schedules the sweep**: nudges appear only when the housekeeping command is run (`docs/runbooks/housekeeping.md`) |
| Templates | Browser test: an admin applies a template and sees its topics and job roles; applying twice adds nothing | Seven templates written by us, **not validated by an industry expert** |
| Totals | 23 of 23 browser tests; 128 web unit tests; 734 API tests (1 skipped; statements 88.78 %, branches 83.32 %); migrations apply, roll back, re-apply; 138 operations | Chromium only |

### What it cannot do

- The lock catches bursts. Someone who stays one below the threshold in every window is never caught.
- "Not found" answers are not counted, so guessing ids does not trip it.
- The second-address rule compares network addresses, not places; it is off by default because people on mobile
  networks change address in normal use. It depends on the proxy setting (`TRUST_PROXY`) matching the real set-up.
- The radar shows job roles and counts of verified items and interviews (only to viewers who may read that
  knowledge). It does not list the specific topics still uncaptured for a person; it links to the gap report.
- No screen shows a person their own leaving date (the API allows it).
- No e-mail (Batch B). Leaving dates and anomaly settings are not in the company data export.

### What reviews and CI found before this was green

- **Three security reads.** Ordinary refusals (working hours, limits, read-only grace) would have locked honest
  users — fixed with an allow-list of counted reasons. A page on a sibling web address could have locked a signed-in
  visitor — fixed; and the first fix could be dodged by a thief forging a header — fixed by refusing such requests
  outright. Radar counts included items above the viewer's clearance — fixed. A departed person's leaving date had
  no end — fixed.
- **Three design reviews:** no critical finding; fifteen warnings fixed. Among them: two different definitions of
  "another usable Owner" (a locked Owner still counted when the last working Owner was suspended or revoked); the
  lock implemented twice; a failure of the counter would have turned "not allowed" into a server error; the settings
  form could save a value it was not showing.
- **CI:** five wrong expectations in the new tests and one ambiguous browser selector; no product fault found by CI
  in this step.

### Open

- Scheduling of the housekeeping command (plan-only Terraform not touched).
- A card outside its working hours cannot read even its own session, so the screens treat it as signed out instead
  of saying "come back later" (Phase 1 behaviour, now more visible).
- Slow probing and id guessing are not detected (see above).
- The last small fix round (the fetch-site rule) was checked by CI, not by another security read.

### Cost

$0. Total real-AI spend of the project stays $0.642.

## Step 3 — features 4 (QR format), 27 (activity numbers), 30 (knowledge map)

> Written 2026-10-04. Evidence: CI run 37197218314 on commit `bb4aef5`, 10 of 10 jobs green.
> Design: `docs/phase4/03-analytics-graph-scenarios-qr.md`. Decision D27.

### In plain language

A card can be shown and printed as a QR code that opens the sign-in screen with the card number filled in. Owners
and admins get monthly activity numbers. Anyone who may read knowledge can walk a map of topics, items, documents
and job roles; the Owner can export it. **Nothing is deployed.**

### What was measured

| Claim | Evidence | Limits |
|---|---|---|
| The QR code holds the sign-in address and the card number, nothing else | Unit test reads the code back with an independent decoder; browser test: the link pre-fills the card number | The 3-digit code and the second factor are still needed; a link can pre-fill anybody's card number |
| "Print this card" prints the card only | Unit test of the print section and of the page mark | Not tried on a real phone or printer |
| Activity numbers respect the viewer's rights | Database tests: an Admin with a level-1 ceiling does not see level-3 documents, items or interviews in the counts; a viewer without the right gets a blank, not a company total | Activity, not business outcomes; no money claims |
| Test results per job role are held back for small groups | Database test: fewer than 5 different people → "too few to show", no numbers; fixed window of 12 complete months; only for viewers who may read results company-wide | 5 is a choice. Comparing the table from one month to the next can still hint at one person's result; acceptable only because those viewers may read individual results anyway |
| The map shows only what the viewer may read | Database tests: a hidden node answers exactly like a missing one; a withdrawn item with a leftover conflict appears in neither view; every exported edge joins two readable nodes | Built from existing links only; people are not shown; a group above 50 neighbours is cut short with a flag |
| The map export is limited and recorded | Tests: needs the export right (Owner), 5 an hour per card, audit entry with counts only; browser test: the download fires | Up to 10 are possible across an hour boundary |
| Totals | 26 of 26 browser tests; 152 web unit tests; 736 API tests (1 skipped; statements 88.83 %, branches 83.09 %); both-services walk; leakage 16 groups / 64 queries / 0 leaks; 141 operations | Chromium only |

### What it cannot do

- NFC cards are not built (hardware).
- There is no pass rate, because the product has no pass mark; the mean score is shown.
- The activity numbers are not part of the company data export; they can be saved as a file made in the browser,
  which the audit log cannot tell apart from looking at the screen.
- The map does not discover new relations and has no drawing of the graph, only lists.

### What reviews and CI found before this was green

- **Two security reads:** two activity numbers ignored the viewer's clearance (fixed); any reader, learners
  included, could take the whole readable map in one call (now an export with its own right, limit and audit entry);
  the card number stayed in the address bar for a signed-in visitor (fixed); printing could show roles and history
  (fixed, and fixed again for browsers that return from printing early).
- **Three design reviews:** no critical finding; ten warnings fixed, among them a map query that lacked the
  "not withdrawn" condition every other query had, and a small-group rule that could be worked around by asking for
  two overlapping periods.
- **CI:** six wrong expectations in the new tests (rows seeded in a state the database forbids, identical test
  documents refused as duplicates, an older browser test confused by the new menu entry). No product fault found by
  CI in this step.

### Open

- Feature 8 (scenario replay) was planned for this step and is **not built**; it needs new tables and its own
  security read.
- The map's rule for documents matches the existing reads, which do not check the status of single passages.
- The last small change (printing) was checked by a unit test, not by a review.

### Cost

$0. Total real-AI spend of the project stays $0.642.

## Step 4 — feature 8 (scenario replay)

> Written 2026-10-04. Evidence: CI run 37209355728 on commit `46b175f`, 10 of 10 jobs green.
> Design: `docs/phase4/04-scenario-replay.md`. Decision D28.

### In plain language

A reviewer writes a "what would you do if…" scenario as ordered steps tied to verified knowledge, a second person
approves it, and a learner answers it step by step and gets a result. **Nothing is deployed, and grading was tested
with the fake AI only.** This completes Batch A of the plan.

### What was measured

| Claim | Evidence | Limits |
|---|---|---|
| The flow works in a real browser | Browser test: a reviewer writes a scenario with two steps, a second reviewer approves it, the learner runs it and sees the result; the learner's page never shows the expected points before hand-in | The grading screen for reviewers has no browser test |
| The learner does not get the expected points early | AI service tests; API mapper tests with hostile payloads (points sent for an expired run are not forwarded); screen test | A point PARAPHRASED in the question text is not caught, only word-for-word copies |
| Neither the creator nor the last editor may approve | Policy unit tests and integration tests; recorded as `DENY_SELF_REVIEW`; an approve route wired without the rule is refused at start-up | With "second reviewer required" switched off by the Owner the rule does not apply, as for knowledge items |
| A scenario follows its items | Tests: re-labelling an item returns the scenario to draft and closes old runs to learners who may no longer read it; a withdrawn item retires and hides it | — |
| Under a legal hold the text is kept, hidden | Test: hidden at once, blanked only by the erasure step | A reading of the Phase 2 design, not a legal opinion; conflict excerpts (D25) do the opposite |
| Nobody grades blind or grades themselves | Tests: a grader reads exactly the step that waits for a person; own run refused | — |
| Answer text is removed after the retention time, scores kept | Tests of the sweep | **Nothing schedules the sweep** (housekeeping command) |
| Totals | 29 of 29 browser tests; 172 web unit tests; 780 API tests (1 skipped; statements 88.98 %, branches 82.73 %); both-services walk; migrations apply, roll back, re-apply; leakage 16 groups / 64 queries / 0 leaks; 156 operations | Chromium only |

### Faults found in existing (Phase 2) behaviour and closed here

1. Approving a readiness test question had no second-person rule.
2. The answer-retention setting was never applied.
3. A card that may both take tests and grade could override its own readiness grade.
4. The readiness response passed on the correct option whenever the AI service sent it, instead of checking for itself.

### What reviews and CI found in the new work before it was green

- **Three security reads:** expected points readable from an expired run; a scenario unaffected when an item's level
  was raised; no deletion of answers; ungraded runs stranded; hiding undone when a second item was withdrawn under a
  hold; a retention sweep that could stall; grading without being able to read the answer. All fixed.
- **Three design reviews:** no critical finding; thirteen warnings fixed, among them a reviewer able to approve text
  changed after they read it (now refused unless the version matches).
- **CI found two product faults:** the API refused a request without a body although the contract says the body is
  optional; and the AI service accepted any filter as "may read this run" without checking which right it was built
  for (not reachable through the API, but the second line of defence was missing).

### Open

- Reading readiness attempts and scenario lists in the AI service still does not check which right the filter was
  built for (same pattern as the fault above; the API sends the right one).
- In the readiness test a grade can still be overridden without reading the answer, and only an Admin can open an
  attempt.
- No review task is created when a scenario is flagged; it returns to draft silently.
- The Company Owner holds no right to write or approve scenarios or test questions (only Reviewer, and Admin and
  Expert through the pilot grant) — by the Phase 2 permission table, noted because it surprised a test.
- Save, hand-in and override are still written twice (readiness and scenarios).
- Text only; no branching scenarios; grading quality with a real model unmeasured.

### Cost

$0. Total real-AI spend of the project stays $0.642.

## Not built yet (from the plan)

Batch A is complete (features 23, 22, 5, 11, 26, 4, 27, 30, 8 — each within the limits stated above; NFC is not
built). Batch B and Batch C: nothing.
