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

## Step 5 — billing against a stand-in payment provider (features 29 billing part, 31, 32, 33, 34, 35)

> Written 2026-10-05. Evidence: CI run 37217346142 on commit `b3f5f31`, 10 of 10 jobs green.
> Design: `docs/phase4/05-billing.md`. Decision D29 (with the rules the founder must confirm).

### In plain language

The Owner has a renewal center: the term, the renewal date, seats, invoices, renew now, auto-renew. A paid invoice
renews the company's term exactly once. **There is no real payment provider**: everything was built and tested
against a stand-in that exists only in tests. No money can be taken with this code as it is, and no payment-card
data is stored. **Nothing is deployed.**

### What was measured

| Claim | Evidence | Limits |
|---|---|---|
| The renewal center works in a real browser | Browser tests: the Owner opens it, changes seats, renews with the stand-in succeeding (term extended, new invoice); a declined payment gives a clear message and renews nothing; a card without the right sees no billing screen and the API refuses | Stand-in provider only |
| A payment is applied once | Database tests: duplicate and simultaneous identical messages apply once; a redelivery or the sweep completes unfinished work | Tested with the stand-in's messages |
| A payment is never lost | Database tests: a payment for a cancelled invoice, or one that cannot be applied (term not renewable, more cards than paid seats), is stored, audited and reported to Owner and operator | **There is no refund function**; returning money happens outside the system |
| The Owner cannot shrink the bill | Tests: seats frozen while an invoice is unpaid; an invoice covers at least the cards in use; issuing beyond an unpaid or paid invoice's seats is refused; the count is taken again when a payment is applied | **A new company has no seat limit until its first paid renewal** (founder to confirm) |
| A message cannot be forged without the key | Unit and database tests of the signature, time window, replay and uniform refusal; the endpoint refuses everything when no provider is connected; production refuses the example key | The key handling was not tested against a real provider's format |
| A lapsed company's Owner can still pay; everything else stays closed | Policy unit tests per card and company state; database test | — |
| Totals | 33 of 33 browser tests; 187 web unit tests; 850 API tests (1 skipped; statements 89.78 %, branches 83.68 %); migrations apply, roll back, re-apply; 165 operations | Chromium only |

### What it cannot do

- **Take real money.** A real provider needs: an account, its message format behind the port, and a platform change
  so the public endpoint keeps the raw request bytes a real signature check needs. A real provider must also
  de-duplicate payment requests by invoice id (a timed-out request is retried).
- **Taxes are not handled at all.** No VAT or sales tax logic, no tax fields on invoices. This needs an accountant.
- No refunds, no part-term pricing, no change of plan, no invoice documents, no e-mail.
- Person cards are not aligned to the company's date: at a renewal only the company card is renewed; people's cards
  keep their own expiry and their codes do not change.
- **Nothing schedules housekeeping.** Closing unanswered invoices, reminders, automatic renewal and finishing
  unfinished payments happen only when that command is run.
- The plan catalogue (names, limits, 15.00 USD per seat and term) is a PLACEHOLDER.

### What reviews and CI found before this was green

- **Four security reads.** Production would have accepted the published example key; the Owner could pay for one
  seat and keep all cards (found three times in three forms: by changing seats on an open invoice, by re-issuing cards
  while an invoice was open, and through a timing gap); a late payment was dropped without trace; two invoices could
  be paid for one term; a manual payment had no real confirmation and no amount check; a stored payment could be
  left without audit entry or notice if the service stopped between steps. All fixed.
- **Three design reviews:** no critical finding; fourteen warnings fixed, among them a payment request made inside
  the database transaction (a charge could have existed with no invoice) and a free-plan company shown no way to renew.
- **CI:** four wrong expectations in the new tests; no product fault found by CI in this step.

### Open — for the founder to confirm (D29)

1. Plans, prices, currency and the term length.
2. Whether unused days carry over at renewal (now: no; renewing early needs an explicit yes from the operator).
3. Whether a new company gets a seat limit from day one (now: none until its first paid renewal).
4. Whether added seats cost the full term price (now: yes).
5. How money for a cancelled invoice is returned (now: outside the system).
6. Days before an unanswered invoice is closed (3 automatic, 14 Owner-started), reminder days (30/14/3), three
   automatic attempts.
7. Whether Admins may see billing (now: Owner only).
8. Which payment provider, and when.

### Other open points

- The billing screen's own seat notice shows the paid limit while a renewal invoice waits (the refusal and the usage
  page show the tighter number).
- `/v1/billing/*` is a second way to address "my company" beside `/v1/tenants/current/*`; documented as an exception.
- Subscription rows are protected by code and permissions, not by a database guard.
- The last change (a lock taken in one more case) was checked by unit tests and CI, not by another review.

### Cost

$0. Total real-AI spend of the project stays $0.642.

## Step 6 — feature 28 (open API: API keys, webhooks, one example receiver) and e-mail of notices (features 11, 33)

> Written 2026-10-20. Evidence: part A - CI run 37225661324 on commit `d1e8f86`, 10 of 10 jobs green; parts B and
> C - CI run 39383861491 on commit `4ce834b`, 10 of 10 jobs green. Design: `docs/phase4/06-open-api-webhooks-email.md`.
> Decisions D30 (keys) and D31 (webhooks, e-mail).

### In plain language

Other systems can now work with LegacyAI. **API keys** let a machine read knowledge and ask questions without a
person signing in. **Webhooks** tell another system when knowledge is verified, changes or is withdrawn: a signed
message naming the item and its level, never its text. **E-mail**: every notice the product already raises
(card locked, renewal reminder, retirement nudge, ...) can also go out by e-mail, in fixed wording without codes,
numbers or links. **Nothing is sent by default** (webhooks and e-mail are off until the configuration is changed),
**no real e-mail service is connected**, and **nothing is deployed**.

### What was measured

| Claim | Evidence | Limits |
|---|---|---|
| A key reads and asks only, never more than its maker, and ends with its maker's sign-in | Database tests (part A): the table walk of every operation with a key carrying everything a key may carry; each change of the maker's card ends its keys; browser test: a cookie-less connection uses the key, it stops when revoked | Run against the test server only; no real outside system used a key |
| An event exists exactly when the change was committed | Database tests: verify, relabel, stale each write the right event; a change that is rolled back writes none; the event holds no title or text | Tested through direct database changes and the walks; the AI service's own paths write through the same trigger |
| What is sent can be checked by a receiver | Unit tests: our signature equals the example published with the Standard Webhooks specification; the example receiver accepts what we send and refuses a changed body, another secret, a moved timestamp and a message older than 5 minutes | — |
| Messages go only to public https addresses | Unit tests: 21 address forms refused or accepted at registration (IP literals in odd notations, internal names, other ports), 30 address checks (private, loopback, link-local, IPv4-mapped, NAT64, 6to4, ...); the real sender against a local TLS server refuses a name resolving to 127.0.0.1 before connecting, follows no redirect, gives up on time (the name lookup included), closes the connection at the status line, refuses an untrusted certificate | Real DNS and the production network were not used |
| Delivery, retries and pausing behave as designed | Database tests with a recording sender: delivered once with the right signature; only what an endpoint subscribed to, within its level, not from before it existed; retried with the same id and body, given up after 8; paused after 15 failures and a day, Owners told, cleared by switching on; a narrower choice cancels waiting messages; a new secret signs the next attempt; nothing sent with delivery off | A stand-in sender; no real receiver |
| The signing secret is shown once and kept encrypted | Database tests: absent from replayed answers, the stored row, the audit log, retry records and the log | — |
| E-mail goes to the right people, holds no data, keeps no addresses | Unit tests: every text checked for digits, links, `@` and placeholders; recipients per notice type. Database tests: a card issued reaches its holder; company notices (API key made, renewal reminder, retirement nudge) reach the Owners; no address in the queue; people without an address or who left are not written to; retries, and no retry of a refused address; nothing queued with e-mail off | The stand-in sender only; **no real e-mail service** |
| Only the Owner manages endpoints | Database tests: an Admin is refused every webhook operation; another company's endpoint is not found; the route walk: a Successor gets nothing from the 8 operations | — |
| Totals | 37 of 37 browser tests; 1131 API tests (1 skipped; statements 91.13 %, branches 85.3 %); migrations apply, roll back, re-apply with both engines; 177 operations | Chromium only |

### What it cannot do

- **Send real e-mail.** Needs the founder's choice of service, a sending domain with SPF, DKIM and DMARC, and one
  new sender class. Until then `MAIL_SENDER` can only be `none` or the test stand-in.
- **Send anything on its own.** Nothing schedules `npm run outbound:deliver`; webhooks and e-mail go out only when
  it (or housekeeping) is run. In production it should run every minute (docs/runbooks/outbound-delivery.md).
- Webhooks report three knowledge events only. Events that happen while an endpoint is off or paused are not sent
  later. Delivery is at least once (a receiver must ignore a repeated `webhook-id`).
- A notice raised in a request that is later rolled back is still e-mailed if what it names exists (as it was always
  still logged). A request open longer than 30 seconds could lose its e-mail.
- The "one example connector" is a documented example receiver, not a connector to a named product.
- Keys cannot add documents; no OAuth, no developer portal; keys are not in the company export.

### What reviews and CI found before this was green

- **Part A** (before the step-5 report): three design reviews and three security reads; a key changed from "a card
  with a mark" to its own kind of caller; wrong secrets no longer suspend a key.
- **Parts B and C: one security read, one correctness read.** Security: a receiver that answered and then sent its
  body very slowly could hold the delivery job for every company (now: the connection is closed at the status line);
  the name lookup was outside the time limit; a lower level did not cancel waiting messages; test messages were
  unlimited; any port was allowed (now 443 only). Correctness: an e-mail could be lost when a delivery run read a
  notice before the request that raised it had committed (now: notices wait 30 seconds); new messages used the
  database's clock and the run the server's; a test expected the wrong messages. All fixed.
- **The tests found one real defect while writing:** node's address block list counted every IPv4 address as
  private (a range for IPv4-mapped IPv6 addresses covered them), so no webhook would ever have been sent. Fixed with
  separate lists.
- **CI:** five pinned lists and counts needed the new operations, tables and functions; one test changed a label in
  a way the database refuses. No product fault found by CI in this step.

### Open — for the founder to confirm (D30, D31)

**Decided 2026-10-20:** the founder accepted the recommended defaults for items 1-5 and 7 (the current behaviour
stands; the delivery job is to run every minute once scheduled). **Item 6 stays open** for the choice of e-mail
service and sending domain; opting out of notices stays "no".

1. Owner only for keys and webhooks, or Admins too?
2. Which outside systems and which events matter first?
3. The limits: keys (366 days, 50 keys, 120 a minute, 30/600 questions an hour); webhooks (10 endpoints, 8 attempts
   over about two days, pause after 15 failures and a day).
4. Whether keys may add documents (now no) and ask questions (now yes, limited per key).
5. That any change to the maker's card ends that person's keys.
6. Which e-mail service and sending domain; whether people may opt out of some notices; the recipient table and the
   wording of each e-mail.
7. How often the delivery job should run once scheduled (suggested: every minute).

### Cost

$0. Total real-AI spend of the project stays $0.642.

## Step 7 — feature 16: SSO and SCIM

Details: `07-sso-scim.md`, decisions D33 and D34.

### In plain language

- **SSO:** a person can use their company's own sign-in (OpenID Connect: Microsoft, Google, Okta, ...) as the strong
  factor. The card number and the 3-digit code are still required.
- **SCIM:** the company's directory can add people, change their names and addresses, and record that they left,
  which revokes their cards. It uses a "directory key" that can do nothing else, and it can never reach an Owner.

### What was measured

- **Locally, no database:**
  - API: 729 unit tests, type check, lint, contract lint;
  - web: 211 screen tests.
- **CI, green on `main`** after merging PR #2 (merge commit `04ffaa4`,
  [run 39772914102](https://github.com/Rmasood1122/LegacyAI/actions/runs/39772914102), 2026-10-22). All 10 jobs passed:
  - API: 1,257 tests passed and 1 skipped, against PostgreSQL 18. This includes the SSO, SCIM and company-key
    database tests, the contract walk and the route-policy coverage.
  - Browser: 39 tests passed, including the Owner's company sign-in screen and its accessibility scan.
  - Migrations: applied, rolled back and re-applied, with both engines agreeing.
  - AI service: lint, strict type check and tests passed. The audit found no known vulnerabilities, with 24 pillow
    advisories ignored by ID (D32).
- **What the first CI runs found** (each fixed before the merge):
  - PostgreSQL refused a function-level `SET` of a custom setting, so the SSO company lookup could not be created;
  - the "Removed" message on the company sign-in screen disappeared together with the connection;
  - two test mistakes (a too-short retry key, the wrong field for a card's id);
  - new Python advisories, published overnight.

### What reviews found before the first push

Four read-only reviews. They found:
- an SSO "mix-up" attack (a hostile company's provider receiving another company's sign-in code). Fixed with each
  company's own return address and the provider's `iss`;
- finishing a sign-in in another browser. Fixed with a cookie;
- an SSO company lookup that could never find a company under row security;
- endpoints on other ports;
- SCIM bodies treated as file uploads;
- directory updates refused for attributes that real directories send;
- a race between directory removal and Owner card issuing;
- the readiness check not raised to the newest migration.

All are fixed, with tests.

### What it cannot do

- No real identity provider or directory was used. SAML is not built.
- No groups or roles from the directory.

## Step 8 — feature 21: bring-your-own-key

Details: `08-bring-your-own-key.md`, decision D35.

### In plain language

A company can bring its own encryption key. The secrets LegacyAI keeps for it (authenticator seeds, webhook and SSO
secrets) are then sealed with a key only the company's key service can open. If the company switches its key off,
those stop working, here and for everyone.

**The company's documents and knowledge are NOT covered.** That needs a separate decision.

### What was measured

- 12 unit tests locally.
- The database tests passed in CI on `main` (the same run as step 7).
- Tested only with a local stand-in key service; no real key service was used.

## Step 9 — Batch C, prepared (not complete)

Details: `09-batch-c-prepared.md`.

- NFC tags for cards: prepared, not tested with real tags.
- Voice and scanned documents: the reader interface and its checks are prepared. No speech or OCR model is used, and
  nothing is reachable through the API.
- Passive capture, offline mode and regional hosting: written designs only, with the reasons.

## Step 10 — e-mail through Resend (the founder's choice, 2026-10-22)

Details: `06-open-api-webhooks-email.md`, part C, "Resend"; decision D36; runbook `docs/runbooks/outbound-delivery.md`.

- `MAIL_SENDER=resend` sends each notice as one HTTPS request to Resend, with the message id as the idempotency key
  (a retry is not sent twice). No library added.
- Measured: 16 unit tests locally, against a local stand-in for Resend (see the details for the list).
- **Not done or proven:** no Resend account, key or sending domain exists; no real e-mail has been sent. Whether
  Resend's real answers match its documentation is an ASSUMPTION until the founder's first test e-mail.

## Step 11 — payments through Stripe (the founder's choice, 2026-10-23)

Details: `05-billing.md`, "Stripe" and "Prices"; decision D37.

- `PAYMENT_PROVIDER=stripe`: "Renew now" gives the Owner Stripe's own payment page for the invoice (one per invoice,
  never two). Stripe's signed message (checked over the exact bytes) marks it paid, as before. No library added.
- Prices researched and selected (Team $150, Business $300 per seat per year; a free pilot). **Not yet in the
  catalogue**: the catalogue prices per term, not per year; that change is next.
- Measured locally: 23 new API unit tests (signature, events, the request, a local stand-in for Stripe, the
  configuration, no live key while prices are placeholders) and 3 new screen tests. The database test (`test/integration/billing-stripe.test.ts`) runs on GitHub.
- **Not done or proven:** no Stripe account, key or webhook exists; no money has been taken. Automatic renewal with a
  saved card, refunds, taxes and receipts are not built. Whether Stripe's real events match its documentation is an
  ASSUMPTION until the founder's first test payment.

## Step 12 — the selected prices in the catalogue (2026-10-23)

Details: `05-billing.md`, "Prices"; decision D38.

- Team (the default plan) USD 150 per seat and year; the free pilot. A company pays for its term's length: USD 36.99 a
  seat for the default 90 days. The screen shows both numbers; the "placeholder prices" notice is gone.
- Measured locally: unit tests of the rounding (90, 30, 365, 366 and 1 day; half a cent; refusals) and of the
  catalogue; 1 new screen test. The database tests and the browser test (expected amounts updated) run on GitHub.
- **Not done:** the Business plan (USD 300), enforcing the pilot's limits, taxes. Invoices issued before keep their
  amounts.

## Step 13 — SSO with Microsoft Entra ID, Google and Okta (2026-10-24)

Details: `07-sso-scim.md`, "Real providers"; decision D39.

- The API knows what differs between the three: Google needs the company's Workspace domain (otherwise any Google
  account could sign in) and has no "sign in again" prompt; Microsoft needs a tenant-specific issuer; Okta is
  standard. Step-by-step set-up for each in the document.
- Measured locally: 10 new API unit tests, 1 new screen test. The database test runs on GitHub.
- **Not done or proven:** no real provider was used; no company account exists. SAML is still not supported (D33).

## Step 14 — Google Cloud KMS as the company's key service (2026-10-24)

Details: `08-bring-your-own-key.md`, "Google Cloud KMS"; decision D40.

- `KEY_SERVICE=google-kms`: a company's own key in its own Google Cloud project wraps its data key; the company can
  switch it off at Google at any time. No library added.
- Measured locally: 9 unit tests against a local stand-in for Cloud KMS.
- **Not done or proven:** no Google Cloud account, project, key or service account was used. Documents and knowledge
  are still not covered by the company's key (next item).

## Step 15 — Content under the company's key, part 2: locking and unlocking in the AI service (2026-10-24)

Details: `10-content-under-company-key.md`, step 2; decision D41.

- The AI service can now unlock a company's data key itself (the local stand-in, or Google Cloud KMS with its own
  service account), derive the company's content key, and lock or unlock one field (a text or a vector) so that it
  opens only at its own company, table, column, row and key version. Unlocked keys are kept 5 minutes at most.
- **Nothing uses it yet.** Content is still stored readable; that changes in steps 4 and 5.
- One library added: `cryptography` 50.0.2 (AES-GCM and HKDF; `docs/DEPENDENCIES.md`).
- Measured locally: 12 new tests. One of them opens a key that the API's own code locked, so the two services agree
  on the format. Cloud KMS is tested against a stand-in only.
- **Not done or proven:** no Google Cloud account, project or key was used. Search, sealing on write and moving old
  content are steps 3 to 5.

## Step 16 — Content under the company's key, part 3: search in memory, compared and measured (2026-10-24)

Details: `10-content-under-company-key.md`, "Step 3: what was measured"; decision D41.

- The AI service can now search one company in memory: meaning (vectors) and words (BM25 with the Snowball stemmer),
  merged as today. The access filter stays in SQL; nothing outside it is ranked or returned.
- **Not switched on.** Answers still use today's SQL search, until the founder decides on the numbers.
- Measured: on the fictional Northfield company the two searches give the same top 5 for all 90 questions. On large
  synthetic companies the in-memory search is about 45 to 80 times faster, holds 25 MB per 10,000 chunks, and the first
  question waits 0.3 s / 2.9 s / 15 s at 1,000 / 10,000 / 50,000 chunks. The word ranking order changes on large
  companies.
- Tests: 7 new unit tests; the permission-leakage suite now also attacks the new search (128 searches, 0 leaks).
- Two libraries: `snowballstemmer` 3.1.1 (new) and `numpy` 2.4.6 (already installed, now pinned).
- **Not done or proven:** real documents, several companies at once, the production machine.

## Step 17 — Answers use the in-memory search (2026-10-25)

Details: `10-content-under-company-key.md`, step 4a; decision D41. The founder chose the switch, the 1 GB limit, the
warning above 50,000 chunks and a 2 GB machine.

- Each company's search index is kept in the AI service's memory for at most 5 minutes, and rebuilt as soon as the
  company's text changes: the database counts every change per company (a trigger), whoever made it.
- All companies together: at most 1 GB; the company not asked for the longest is dropped first. A company bigger than
  the whole limit is still searched, just not kept. Above 50,000 chunks a warning is logged (counts only).
- The AI service's machine goes from 1 GB to 2 GB in Terraform. **The founder applies it**; until then, keep
  `SEARCH_MEMORY_MB` low (for example 256) or `SEARCH_ENGINE=sql`.
- Measured locally: the whole AI test suite and the evaluation now run on the new search. The evaluation gives the
  same numbers as on the SQL search (refusals, citations 63 of 63 valid, 0 leaks). 6 new tests; with the database
  counter switched off, 2 of them fail as they should.
- **Not done or proven:** content is still stored readable (step 4b); the 2 GB machine is not applied; real companies.

## Step 18 — A content key for every company (2026-10-25)

Details: `10-content-under-company-key.md`, step 4b part 1; decision D41. The founder chose a Cloud KMS key for
companies without a key of their own.

- Each company now has a content key the AI service can use: the company's own key when it brought one, otherwise a
  data key of its own, made on first use and locked by the platform's content key. Only the locked form is stored.
- If a company's own key is switched off, nothing new can be written for it, and it is never locked with the
  platform's key instead.
- Terraform: one Cloud KMS software key, usable only by the AI service (about USD 0.06 a month). **The founder
  applies it.** The cost guardrail allows exactly that one key and refuses a hardware key, a second key or automatic
  rotation (its self-test: 18 deliberate breaks, all detected).
- A company that brings its own key must now grant it to the AI service's account as well (`08-bring-your-own-key.md`).
- Measured locally: 7 database tests, 4 new unit tests, settings tests; the whole AI suite passes (349).
- **Not done or proven:** nothing is locked yet (parts 2 and 3); no Google Cloud account or real key was used.

## Step 19 — Document pieces are stored locked (2026-10-25)

Details: `10-content-under-company-key.md`, step 4b part 2; decision D41.

- From now on, every new document piece, interview answer copy and verified-item copy is stored locked with the
  company's content key: the database holds no readable text and no readable vector for them. Pieces stored before
  stay readable until step 5 locks them; both kinds are searched and used for answers.
- A locked piece only opens in its own place: copied to another piece or company, it does not open; the database also
  refuses to change a document piece's locked text.
- If a company switches its own key off: its content can no longer be searched or added, and the service says so
  ("company_key_unavailable") instead of failing silently.
- The AI service now refuses to start in production without the platform content key. **Deploy this version only
  together with the Terraform change of step 18** (it sets that key).
- Measured locally: the whole AI suite runs with locking on (353 passed; the one failure is a PostgreSQL 16 quirk of
  the test machine, GitHub uses 18). 5 new tests plus checks in 5 existing ones; with locking switched off, 3 of them
  fail as they should. The evaluation gives the same numbers with locking on (refusals, 63 of 63 citations valid,
  0 leaks).
- **Not done or proven:** interview transcripts and knowledge versions are still readable (part 3); old pieces are
  still readable (step 5); the old database search (`SEARCH_ENGINE=sql`) cannot search locked pieces.

## Step 20 — Knowledge versions and interview transcripts are stored locked (2026-10-25)

Details: `10-content-under-company-key.md`, step 4b part 3; decision D41.

- Every new version of a knowledge item, and every new interview question and answer, is stored locked with the
  company's content key. Older ones stay readable until step 5.
- Versions still cannot be changed; erasing one when consent is withdrawn now empties the locked form too.
- Measured locally: the whole AI suite runs with locking on (356 passed on a fresh database; the one failure is the
  PostgreSQL 16 quirk of the test machine). 3 new tests and stronger checks in 2 existing ones (the interview test
  opens the locked question and answer; the withdrawal test now looks inside locked versions and interview turns).
  With locking off, the new checks fail as they should. The evaluation gives the same numbers, including interviews
  and test questions.
- **Not done or proven:** titles, topic names, quiz and scenario texts, feedback, conflict excerpts and questions to
  experts are still readable (step 6); older rows are still readable (step 5).

## Step 21 — Older content is locked by the housekeeping command (2026-10-25)

Details: `10-content-under-company-key.md`, step 5 part 1; `docs/runbooks/housekeeping.md`, "Locking older content";
decision D41.

- The housekeeping command (`npm run housekeeping`) has a sixth job: for every company it asks the AI service to do
  its own housekeeping. That part existed but **nothing called it before**, so in a deployment items were never
  marked stale by a job and old answers were never removed after the company's retention time. Both now happen.
- The same call locks content saved before step 20: document pieces, item texts and interview turns, at most 200 of
  each per round and at most 8 seconds per company and run. Each row is locked exactly like a new one and its
  readable copy is emptied in the same change. The output says how much was locked and how much is still readable.
- The database allows exactly this change (readable -> locked) and nothing else: not locked -> readable, not a second
  locking, and the AI service still cannot change a knowledge version except through the two database functions
  made for it (`erase_version`, now `seal_version`).
- A company whose key cannot be used is skipped and reported; nothing is half-done.
- Measured locally: 4 new AI tests (old rows locked in batches of 1, still open to the same words and still found
  by the search; one call does one batch when given no time; a key that cannot be used locks nothing and changes
  nothing; the database refuses the other changes) and 3 new API tests (one call per customer company with a token
  for that company only and no card, person or roles; a failing company is reported and does not stop the others;
  the job is part of the command). Without the database change 3 of the 4 AI tests fail; without the API change all
  3 API tests fail. Whole AI suite: 360 passed. API: unit 790 passed; integration as before (the same card and
  sign-in timing tests fail on this machine's database with and without this change; CI is the reference).
- **Not done or proven:** nothing schedules the command yet (as before: it must be run by hand); how long locking
  takes on a real company's data was not measured; the readable columns still exist and `SEARCH_ENGINE=sql` is still
  there (step 5 part 2, after production shows 0 left); re-locking with the platform's key when a company clears its
  own key is not built; titles and the other texts of step 6 are still readable.

## Step 22 — Questions and feedback are stored locked (2026-10-25)

Details: `10-content-under-company-key.md`, step 6 part 1; decision D41.

- The question a person asks, a question sent to an expert, and a reader's comment on an answer are now stored
  locked with the company's content key. The screens that show them (the reader's own feedback, the quality list,
  the expert's inbox) open them for that request only. A question is still shown in the quality list only when its
  reader chose to share it.
- Older ones are locked by the housekeeping command, like documents in step 21.
- The text of a question sent to an expert can no longer be changed at all; the database refuses it.
- Measured locally: 3 new tests (stored locked and shown opened; older rows locked by housekeeping and still shown;
  the database refuses a changed question and a direct change of an answer log). Without the AI code change all 3
  fail. 2 existing tests now open the locked question and comment instead of reading them in plain text. Whole AI
  suite: 364 passed. The evaluation gives the same numbers as before.
- **Not done or proven:** item titles, conflict excerpts, quiz and scenario texts, document titles, topic names and
  descriptions are still readable (step 6 parts 2 to 4).

## Step 23 — Item titles and conflict quotes are stored locked (2026-10-25)

Details: `10-content-under-company-key.md`, step 6 part 2; decision D41.

- The title of every knowledge item, and the two values a stored conflict quotes from two items ("3.0 bar" against
  "3.2 bar"), are now stored locked with the company's content key. Every screen that names an item opens the
  title for that request only: the item page, the item list, the knowledge map, citations in answers, scenarios and
  the other side of a conflict. Older ones are locked by the housekeeping command.
- Erasing an item (consent withdrawal) empties its title in both forms.
- One visible change: the database can no longer sort locked titles, so a knowledge-map group with more than 50 items
  now shows the first 50 by id (sorted by title on the page), not the first 50 by title.
- Measured locally: 3 new tests (stored locked and shown opened on five screens; older rows locked by housekeeping
  and still shown; erasure empties a locked title). Without the change all 3 fail. The conflict test now also checks
  the quoted words are stored locked, and the consent-withdrawal test now looks inside locked titles and quotes for
  the withdrawn words. Whole AI suite: 365 passed; the 2 failures are known to this machine only (an id function
  stand-in that is not time-ordered, and a test that needs a freshly reset database, which passes after a reset).
  The evaluation gives the same numbers as before.
- **Not done or proven:** quiz and scenario texts, document titles, topic names and descriptions are still readable
  (step 6 parts 3 and 4).

## Step 24 — Readiness questions and answers are stored locked (2026-10-25)

Details: `10-content-under-company-key.md`, step 6 part 3a; decision D41.

- The words of a readiness question (the question, its four choices, its expected points) and what a learner wrote,
  with what the grading model said about it, are now stored locked with the company's content key. They are opened
  only for the screen that needs them: the reviewer's question list, starting and handing in a test, grading, and
  the learner's own view. Scores, the correct choice's position and labels stay readable. Older ones are locked by
  the housekeeping command; the retention setting empties the locked answer as it did the readable one.
- Measured locally: 3 new tests (stored locked and shown opened; older rows locked by housekeeping and still shown;
  retention empties a locked answer and keeps the score, and an approved question still cannot be changed). Without
  the code change the first 2 fail; the third also holds on the old code (it guards what must not break). One
  existing test now opens the locked question. Whole AI suite: 370 passed. The evaluation gives the same numbers.
- **Found, not fixed:** when an item is erased, its readiness questions are only retired, not emptied, so an erased
  item's words can stay in a question. Reported for a separate change.
- **Not done or proven:** scenario texts (part 3b); document titles, topic names and descriptions (part 4).

## Step 25 — Scenario texts and answers are stored locked (2026-10-25)

Details: `10-content-under-company-key.md`, step 6 part 3b; decision D41.

- A scenario's title and situation, each step's question and expected points, and what a learner wrote with what the
  grading model said about it are now stored locked with the company's content key. Every scenario screen opens them
  for that request only. The question and the expected points of a step are locked separately, so the learner's view
  of a step still never opens the expected points. Older ones are locked by the housekeeping command (also for an
  approved scenario: locking is the one change its parts allow). Erasure and the retention setting empty both forms.
- Measured locally: 3 new tests (stored locked and shown opened on the reviewer's and the learner's screens; older
  rows locked by housekeeping and still shown, the scenario still approved; the parts of an approved scenario still
  cannot change). Without the code change the first 2 fail; the third also holds on the old code. 2 existing tests now
  open the locked words (including the erasure and retention checks). Whole AI suite: 372 passed; the 1 failure is the
  known one of this machine (an id function stand-in that is not time-ordered). The evaluation gives the same numbers.
- **Not done or proven:** document titles, topic names and descriptions (part 4, which needs the founder's choice).

## Step 26 — Document titles are stored locked; the API asks the AI service for them (2026-10-25)

Details: `10-content-under-company-key.md`, step 6 part 4a; decision D41 (the founder's choice of 2026-10-25).

- A document's title is now stored locked with the company's content key. The API's database login can no longer
  read titles at all; the document list and the document page ask the AI service, which names only the documents the
  caller may read. As chosen: without the AI service, those two requests fail instead of showing titles.
- The AI service's own screens (where an item comes from, citations in answers, the knowledge map) open titles for
  the request only. Erasing a document empties its title in both forms. Older titles are locked by housekeeping.
- A company whose own key is switched off can no longer create a document entry at all (before, it could create
  the entry but not add content).
- Measured locally: 2 new AI tests (stored locked; titles given only for documents the caller may read, also to a
  machine's key, never for another company's or with a malformed filter; older titles locked by housekeeping and
  still shown on the map) and 4 new API tests (list and page show the AI service's title, never the database's; the AI
  service is asked for exactly the documents shown with the caller's source:read filter; without it the requests
  fail; the API login is refused the column). Without the change both AI tests and 3 of the 4 API tests fail (the 4th
  checks the database right itself). Two existing tests changed on purpose: the list of actions a machine's key may
  use gains the read-only `source.titles`, and the "switched-off key" test now also expects creating a document to be
  refused. Whole AI suite: 375 passed. API: unit 790 passed; integration as before (the same card and sign-in timing
  tests fail on this machine's database). The evaluation gives the same numbers.
- **Not done or proven:** topic names and descriptions (part 4b); how much slower the document list is with a real
  AI service was not measured.

## Step 27 — Topic names are written and read only by the AI service (2026-10-25)

Details: `10-content-under-company-key.md`, step 6 part 4b (first half); decision D41 (the founder's choice of
2026-10-25). Nothing is stored locked yet: this step moves the work so the next one can lock topic names.

- Creating, renaming, accepting and retiring a topic, and adding a department template's topics, are now done by the
  AI service. The API still checks who may do it, and still writes the job-role links and the audit entry. A new
  topic gets its search vector in the same step (before, a failure there could leave a topic without one).
- The topic list asks the AI service for the names and descriptions it shows, only for topics the caller may read.
  As chosen: without the AI service the list, creating and changing a topic fail instead of showing wrong names.
- The API's database login can no longer read topic names or descriptions, and can no longer add or change topics.
- Measured locally: 6 new AI tests (a new topic is active, has its vector, and a name is used once in any case;
  changing checks the status move and the name; a template adds what is missing and uses only existing topics the
  caller may read, never a retired one; names only for topics the caller may read, also to a machine's key, not with
  a malformed filter; a card whose grants are all at level 0, whose filter says "verified only", still sees topic
  names, as the API's own topic filter already allowed - found by the browser tests; the database still refuses a
  topic nobody made) and 5 new API tests (create and change go to
  the AI service with the caller named; a duplicate name and an illegal status move still answer 409; the list shows
  the AI service's names for exactly the topics shown, with the caller's topic:read filter; without the AI service the
  three requests fail; the API login is refused the two columns and any write). Without the change 5 of the 6 AI and
  4 of the 5 API tests fail (the fifth of each checks a rule that already held). Changed on purpose: the list of
  actions a machine's key may use gains the read-only `topic.texts`; the template test now checks the one call to
  the AI service instead of one search-vector call per topic; the stand-in AI service writes topics as the AI
  service's own database login. Whole AI suite: 380 passed; the 1 failure is the known one of this machine. API
  integration: 1336 passed; the 7 failures are the known ones of this machine (card and sign-in timing tests, and
  the id function stand-in).
- **Not done or proven:** topic names are not locked yet (second half of part 4b); the AI service's own screens
  still read them as plain text; how much slower the topic list is with a real AI service was not measured.

## Step 28 — Topic names and descriptions are stored locked (2026-10-25)

Details: `10-content-under-company-key.md`, step 6 part 4b (second half); decision D41. With this, every part of
step 6 is built.

- A topic's name and description are now stored locked with the company's content key. Only the AI service can open
  them (since step 27 the API asks it).
- Two topics still cannot have the same name, in any case. For this the AI service keeps a keyed fingerprint of each
  name (it reveals nothing without the key) and checks a new or changed name against it and against the names still
  readable, one request at a time per company.
- The gap report, the readiness report, the knowledge map, an item's topics and the interview's next question open the
  names for the request only. Lists that were sorted by name are sorted after opening.
- Older names are locked by housekeeping (job 6, new counters `sealed_topics` and `readable_topics`).
- Measured locally: 4 new AI tests (stored locked, given back and renamed opened; a name used once in any case whether
  the other is readable or locked, also for a rename and a template; the item's topics, gap report and knowledge map
  show opened names, sorted; older names locked by housekeeping, still shown and still unique). Without the code
  change 2 of the 4 fail (the stored-locked and the housekeeping one); the other 2 also hold on the old code, where
  names were readable - they prove that uniqueness and the screens keep working once names are locked. Changed on purpose: the readiness test now creates its
  topics through the AI service (as the product does since step 27), so the readiness report and the interview run with locked names; the topic tests read
  the stored names by opening them; the housekeeping test expects the two new counters. Whole AI suite: 383 passed;
  the 1 failure is the known one of this machine. API integration: 1335 passed; the 8 failures are the known card and
  sign-in timing tests and the id stand-in of this machine. The evaluation gives the same numbers.
- **Not done or proven:** the fingerprint uses Python's lower case and the old readable index PostgreSQL's - they
  agree for ordinary letters but were not compared for every rare character; once every company's topics are
  locked (housekeeping shows 0) the difference no longer matters. Speed with many topics was not measured.

## Step 29 — Locking again after a company clears its own key, part 1 (2026-10-26)

Details: `10-content-under-company-key.md`, step 5 ("re-keying") and section 4; decision D41.

- When a company clears its own key (or changes to another one), what was locked with the old key is now locked again
  with the company's current key by the housekeeping command, a bounded amount per run. This part covers document
  pieces with their search vectors, item texts (all versions) and interview questions and answers.
- The database allows exactly this change and checks it: the old key must be a retired key of the company, the new
  one must be the key the company locks with now, and nothing else may change. It cannot check the words inside.
- If the old key no longer works, nothing is lost: those rows wait, and the command says so; readable rows are still
  locked with the current key in the meantime.
- Runbook: tell the company to keep the old key working until the command shows 0 left on it.
- Measured locally: 3 new AI tests (after clearing the key everything is locked again, and with the old key switched
  off everything still opens and is still found; with the old key already off nothing is lost, readable rows are
  still locked, and the next run finishes once the key is back; the database refuses the change while the key is
  live, without the job's flag, to a key that is not the current one, and for a version to the same key). Without the
  change all 3 fail. Changed on purpose: the API's list of database functions gains the three new ones. Whole AI suite:
  387 passed; the 1 failure is the known one of this machine. The function-list test was checked locally: its only
  difference is the known id function stand-in of this machine.
- **Not done or proven:** the other locked fields (questions asked, comments, titles, conflicts, readiness and
  scenario texts, document titles, topic names) are not locked again yet - part 2. A company that destroys its old
  key before the command reaches 0 loses what was still on it; this is told to the operator, not prevented.

## Step 30 — Locking again after a company clears its own key, part 2 (2026-10-27)

Details: `10-content-under-company-key.md`, step 5 ("re-keying", part 2); decision D41.

- After a company clears its own key, housekeeping now also locks again, with the company's current key, everything
  step 6 locked: questions asked, questions to experts, readers' comments, item titles, the words stored conflicts
  quote, readiness questions and answers, scenario texts and answers, document titles, and topic names and
  descriptions (with the fingerprint that keeps names unique). With part 1, every kind of locked content is covered.
- The database checks the same rule as in part 1 for the tables it guards; an asked question, which the AI service
  may not change itself, goes through a function that checks the rule.
- Measured locally: 2 new AI tests (all twelve kinds are on the company's own key, then after clearing it they are all
  on the current key, and with the old key switched off every screen shows the same words and a topic name is still
  used only once; the database refuses the change while the own key is live and to a key that is not the current
  one). Without the change both fail. Changed on purpose: the API's list of database functions gains the new one.
  Whole AI suite: 389 passed; the 1 failure is the known one of this machine. The function-list test was checked
  locally: its only difference is the known id function stand-in.
- **Not done or proven:** a company that destroys its old key before the command reaches 0 still loses what was on
  it (told to the operator, not prevented); the time a large company needs was not measured.

## Step 31 — A company's key switched off or destroyed, end to end (2026-10-27)

Details: `10-content-under-company-key.md`, step 7; decision D41.

- When a company's key cannot be used, people now read "The company's own encryption key cannot be used right now"
  on every screen that needs the company's content. Before, the same situation said "AI is not available right now",
  which pointed the owner at the wrong thing.
- New operator runbook `docs/runbooks/company-key.md`: what to do when a key is switched off, switched back on,
  changed or cleared, or destroyed; what backups can and cannot bring back; why the platform's own key must never be
  destroyed. It states Google's 30-day waiting period before a destroyed key version is gone (read from Google's
  documentation on 2026-10-27).
- New customer page `docs/customers/your-own-key.md`: what the key locks, what it does not, and what happens in each
  case.
- The feature-21 note no longer says documents and knowledge are not covered (that changed with D41); the API's
  description of the key operation says the same.
- Measured locally: 2 new API tests (the topic list and creating a topic answer 503 `company-key-unavailable` with
  that sentence when the AI service says the company's key is unavailable, without passing on the AI service's own
  wording; any other 503 of the AI service is still "AI is not available right now"). Without the change the first
  fails; the second is a control and held before.
- **Not done or proven:** a real Google Cloud KMS key was never used; opening restored sealed content from a real
  backup is designed to work while the key works but is not tested end to end. With step 7, D41 is built except
  step 5 part 2 (dropping the readable columns), which waits until production shows nothing readable is left.

## Step 32 — Offline mode, part 1: the offline pack on the server (2026-10-27)

Details: decision D42; `09-batch-c-prepared.md`, feature 9. The founder chose an installable web app, packs that open
offline for 7 days, and only verified knowledge at levels 0 and 1.

- New operation `GET /v1/offline-pack?job_role=`: the verified (or corrected) knowledge of one job role that is not
  past its review date, at level 0 or 1 only, that the person may read, linked to the role's active topics that the
  person may read; at most 500 items (`truncated` says when there were more). Titles, texts and topic names are
  opened for the request only. The pack says when it was made and that it may be opened until 7 days later.
- A person's card only: a machine's key is refused. Every download is written to the audit log with the number of
  items and nothing of the content. With the company's key off there is no pack (503 `company-key-unavailable`).
- Measured locally: 3 new AI tests (only verified, current, level 0-1 knowledge of the role's active topics goes in,
  opened, with its topics; the person's own read rights narrow it further, and a level-0 reader gets only level 0; no
  topic rights means an empty pack; the cap of 500 sets `truncated`; the service refuses a machine's key) and 5 new
  API tests (the dates and contents; the person's own filters are used; the audit entry has the count only; key off
  gives no pack and no audit entry; a machine's key is refused). The contract walk with the real AI service now also
  takes a pack and finds the verified, corrected item in it - run locally against the real AI service: passed.
  Without the change the AI tests cannot run (the module does not exist) and the API server refuses to start (every
  operation of the contract must have a route). Changed on purpose: the route counts and the list of routes whose
  read filter the AI service applies gain the new operation; the web app's generated API list is regenerated.
- **Not done:** the web app itself (part 2): installing it, storing the pack sealed on the device, reading and
  searching offline, "as of" on every page, refusing the pack after 7 days.

## Step 33 — Offline mode, part 2: the installable web app (2026-10-27)

Details: decision D42; `09-batch-c-prepared.md`, feature 9.

- **Installable:** a manifest, icons, and a service worker that keeps the application's own files (the list comes from
  the build) so it opens without a connection. It never answers or keeps anything under `/v1`; the build check fails
  if it would. The browser policy names the service worker (`worker-src 'self'`).
- **The screen "Offline"** (for cards that may read knowledge): choose a job role, take a copy, see what is on this
  device, remove it. Without a connection the application says it cannot reach LegacyAI and shows the copy: a list,
  search (every word must appear, accents and case ignored, titles first), a topic filter, each item. Every one of
  these views says "As of <date>", that the copy is not updated offline, and until when it can be opened.
- **On the device:** the copy is encrypted (AES-GCM) with a key made for it; the browser refuses to give the key's
  bytes to any script. The card, "as of" and expiry are bound to it. Refused and removed from its expiry on; refused
  (kept) while the device's clock is behind its last opening; removed when the API answers that nobody, or another
  card, is signed in, and on signing out. A copy that claims more than 7 days is not kept.
- **Measured locally:**
  - web unit tests: 23 new (9 for the store: locked content, a key that cannot be taken out, a key and start value per
    copy, expiry, the clock set back, tampered card/dates/content, more than 7 days, a copy already expired, the card
    rule; 4 for search; 6 for the screen; 4 for the frame). Whole web suite: 243 passed.
  - browser tests (real Chromium, real API, AI service with the fake provider): 2 new - a copy taken while connected
    is read and searched with the network switched off, with "as of" on the list and the item; what the browser keeps
    holds nothing readable and its key cannot be exported; with the clock set back it is refused and kept; at the
    expiry it is refused and removed; signing out removes it. Accessibility scans of both screens: no problems found
    by the automated rules. Whole browser suite: 41 passed.
  - without the change: the 4 new frame tests fail (the copy is neither shown without the API nor removed); the store,
    search and screen tests cannot run (the modules do not exist).
  - a bug found by the browser test and fixed: the screen asked for 100 job roles; the API allows 50.
- **Not proven / not covered:** Safari on iPhone or iPad, and Firefox (only Chromium is tested); installing from the
  browser's menu (the browser's own step; only the parts it needs are tested); a phone short of space removing the copy.
- **Accepted limits** (said in `09-batch-c-prepared.md` and to customers in `docs/customers/your-own-key.md`): someone
  who may read the copy can copy what is shown; someone in control of the unlocked device can use the browser's key as
  the application does; a clock set back before the next opening (not behind the last one) gains that much time; a
  switched-off company key does not remove copies already on devices (a new copy is refused).

## Step 34 — Ids are no longer masked as card numbers in the logs (2026-10-27)

- The logs mask anything that looks like a card number (16 digits). The first 16 characters of a random id are all
  digits about once in a thousand ids, and such an id was masked too. Found when a billing test that looks for an
  invoice id in the log failed once in CI, by chance. Ids (UUIDs) are now recognised first, as a whole, and
  kept; card numbers, also next to an id, are still masked.
- Measured locally: a new unit test with the id from that failure and two more; it failed before the change
  (`invoice [card-number]-8a3e-… opened`) and passes after. The test that the masking runs in linear time on hostile
  input still passes. API unit tests and the billing tests: 798 passed.
- Not covered: a card number deliberately written in the shape of an id (8-4-4-4-12 characters) is not masked. Card
  numbers are written as LGY-XXXX-XXXX-XXXX-XXXX.

## Step 35 — Offline reading tested in Firefox's and Safari's engines (2026-10-27)

The founder chose to close the "only Chromium" gap of step 33.
- The browser tests now also run the offline file in Firefox and WebKit (Safari's engine, as Playwright builds it for
  Linux), after all the Chromium files. CI installs the two browsers of the same Playwright release; no new library.
- Firefox: the whole offline test passes as it is - taking a copy, the installed application opening with the network
  switched off (its service worker included), search, "as of", clock set back, expiry, sign-out.
- WebKit: it cannot sign in to the test server. Measured: the sign-in answer sets the session cookie, Firefox keeps
  it, WebKit drops it - the cookie is "Secure" and the test server is plain http on localhost. In production the
  address is https. So a new test, run in all three engines, needs no sign-in: it puts a locked copy on the device
  exactly as the application stores it, cuts off `/v1`, and checks that the copy opens with "as of", is searchable,
  holds nothing readable, has a key that cannot be exported, is refused while the clock is behind and is removed at its
  expiry. Passes in all three.
- Not tested in WebKit: signing in, taking a copy, and the service worker with the network switched off (Playwright's
  WebKit refused such pages until a fix in a later release, younger than 60 days: issue 42775, fix 42894). Not tested
  at all: Safari itself on an iPhone, iPad or Mac.
- Measured locally: whole browser suite 46 passed, 2 skipped (the two WebKit tests that need signing in, with the
  reason written in the test).
- Side effect: Firefox and WebKit run only after every Chromium test has passed (the files build on each other), so
  one failing Chromium test means they do not run in that build.
- **Changed the same day (founder's choice):** the Firefox tests that sign in failed now and then in CI (1 build so
  far). Measured locally: Playwright's Firefox sometimes lost the first page load or click of a new window - also in an
  unrelated existing sign-in test (1 in 60), with the service worker blocked, and with a fresh browser each time (1 in
  30); never in Chromium; a retry did not cure it (one test failed on its retry too). Firefox and WebKit now run only
  the test that needs no sign-in, which never failed in more than 100 runs. Signing in, taking a copy and the installed
  application offline are tested in Chromium on every build; in Firefox they passed locally only.

## Step 36 — Voice and scanned documents wired through, against a stand-in reader (2026-10-27)

The founder chose this item (features 7 and 25). Steps 3 to 5 of `09-batch-c-prepared.md` are done; steps 1 and 2 (a
real speech or text-recognition model and its evaluation) wait for Gate 2.
- A document may be a recording (WAV, MP3, OGG, WebM, M4A) or a photo or scan of one page (PNG, JPEG): accepted by the
  screen, the API contract and the database (migration `20261027000200`, with a working rollback), and sent to the AI
  service, which reads it with its media reader (`MEDIA_READER`). The text then goes through redaction, chunking,
  sealing, consent and labels like any document. The file itself is kept nowhere.
- The reader everywhere today is `none`: it refuses, and the screen says "Recordings cannot be turned into text yet: no
  speech-to-text service is switched on" (or the same for pictures). The stand-in `fake` reads text a test put inside
  the file; it is allowed only when `ENVIRONMENT=test`.
- Measured locally:
  - AI: 6 new pipeline tests with the stand-in - a scanned page read, redacted (an e-mail and a phone number blanked),
    stored sealed and found by search; a recording as one page per minute heard; without a reader both refused and
    nothing stored; a declared type that does not match the bytes refused; neither the image nor the recording found
    in any stored bytes; the service uses the reader it is configured with. Plus 1 settings test (the stand-in only in
    tests). Without the dispatch the 6 fail; with it they pass. Whole AI suite: 399 passed (1 failure known on this
    machine only).
  - API: 1 new test (a recording and a picture are passed on with their type); GIF and FLAC still refused. Whole API
    suite: 1346 passed; the 6 failures are the 4 files known to fail on this machine only (timing, local database).
  - Web: 2 new tests (a recording sent with its type and the plain-words refusal; minutes instead of pages), 2 changed
    (a .png is no longer the example of a refused file). Whole web suite: 245 passed.
  - Browser (real API, real AI service with no reader): a recording and a photo are refused with the reason shown.
    Whole browser suite: 47 passed, 2 skipped (WebKit sign-in, step 35).
- Not done: a real reader and its measured accuracy (Gate 2); scanned PDFs (they need their pages turned into images
  first: a further library); the voice interviewer. ("Page" was still the word used where an item quotes a recording; fixed in step 38.)

## Step 37 — The browser tests keep their browsers between runs (2026-10-28)

The founder chose this item. Since step 35 the browser-test job also installs Firefox and WebKit and about 120 MB of
system packages; once (PR 31) a slow package mirror used up the job's 30 minutes before any test ran.
- The job now keeps the test browsers and the downloaded system packages between runs (GitHub's cache action, v6.1.0,
  pinned to its commit and recorded in `docs/DEPENDENCIES.md`; both majors older than 60 days). The key is the web
  lock file, which pins the Playwright version. On a run that finds them, the packages are installed from the kept
  copies; the package lists are still fetched.
- The install step has its own limit of 12 minutes, so a slow mirror fails the job early instead of using all 30.
- Not proven before merging: the effect can only be measured on GitHub. The first run saves the copies; a later run
  should restore them (the PR says what was measured).

## Step 38 — An item quoting a recording says "minute", not "page" (2026-10-28)

The founder chose this item. A recording is read one minute at a time (step 36), and the document's own page already
said "minutes", but an item's "Where it comes from" list still said "page 2" for words heard in the second minute.
- The AI service now says, for each document an item comes from, whether its numbers count pages or minutes (from the
  document's type: any audio type counts minutes). The API passes this on as a new field, `unit` ("page" or
  "minute"), in `openapi.yaml`; the screen writes "page 3", "pages 3–4", "minute 2" or "minutes 5–6".
- Tests: AI 1 new (against the real database, with the test stand-in reader: an item citing a recording and a scan
  gets "minute" and "page"); web 1 new (the three wordings). Both were run first without the fix and failed (the field
  was missing; the screen said "page"). Whole AI suite on a fresh local database: 400 passed, 1 left out (the test
  known to fail on this machine only). Whole web suite: 246 passed. Whole API suite: 1344 passed, 8 failed — the 4
  files known to fail on this machine only, plus the contract walk, which passed alone (46 of 46) with and without
  this change; GitHub's run is the test of record.
- Not covered: answers' citations name a document but give no page or minute, so they had nothing to change.

## Step 39 — Regional hosting: one copy per region (2026-10-28, decision D43)

The founder chose this item, a separate complete copy per region, and EU (Belgium) as the second region.
- Terraform: one setting, `home_region` ("us" → `us-central1`, "eu" → `europe-west1`), replaces `primary_region` and
  the `regions` map (which gave EU compute but not EU data residency). Everything a copy creates sits in that region;
  the secrets are now kept in that one region instead of Google's "automatic" placement (billed the same). The API
  service gets `HOSTING_REGION`. The guardrail check now fails if anything is placed outside the home region, if a
  secret is replicated anywhere, if the default copy is not "us", or if the "us" copy leaves `us-central1`; its
  self-test breaks each of these on purpose (22 breaks, all detected). `terraform fmt` and `terraform validate` pass
  (Terraform 1.16.4, provider 7.46.1, no credentials); `terraform console` gives `us-central1` for "us" and
  `europe-west1` for "eu", and refuses any other value. No `terraform plan` or `apply` was run.
- API: `HOSTING_REGION` (us or eu; required in production, "us" elsewhere). A copy writes its region on every company
  it creates; refuses to start on a database holding a company of another region; and the policy decision point
  refuses every request for one, sign-in included (`DENY_TENANT_OTHER_REGION`, not counted by the anomaly radar). The
  operator's own company is served by every copy.
- Tests: API 4 new integration tests against the test database (a "us" copy creates "us" companies; an "eu" copy
  creates "eu" companies; an "eu" copy refuses a database with "us" companies, and the reverse; a company moved to
  "eu" by hand gets 403 and cannot sign in in the "us" copy, while the operator still can), 2 new policy cases, 1 new
  configuration test, 1 new resource-filter variant. Without the code change, 6 of them fail (the "us" case passes,
  because "us" was already the default). Whole API suite: 1352 passed, 7 failed — the 4 files known to fail on this
  machine only, plus the contract walk, which passed alone (with the region tests: 50 of 50); GitHub's run is the test
  of record.
- Not covered: moving a company from one copy to the other (an export and import between copies, not built); the
  European copy itself (no project, database or key exists; `infra/README.md`, Part F, is the founder's procedure).
  Checked per request: everything a signed-in card or an API key does, and signing in. Not checked per request:
  enrolling a sign-in method with a one-time token, the payment provider's messages, and the background jobs; these
  rely on the start-up check and on new companies getting the copy's region.

## Not built yet (from the plan)

Batch A is complete (features 23, 22, 5, 11, 26, 4, 27, 30, 8 — each within the limits stated above; NFC is prepared in
step 9). Batch B is built against stand-ins:
- billing (step 5);
- 28 and the e-mail of notices (step 6);
- 16, SSO and SCIM (step 7);
- 21, the company's own key (step 8, secrets only).

Batch C is prepared only (step 9). Each needs money, hardware, a model, legal advice or infrastructure, as stated
there.
