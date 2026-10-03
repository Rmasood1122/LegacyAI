# Phase 3 report — the screens (3a, then 3b below)

> Written 2026-10-03. Every claim is backed by a CI run or labelled ASSUMPTION / NOT PROVEN.
> Proposal: `docs/phase3/00-proposal.md` (approved by the founder). Design notes: `docs/phase3/01-web-application.md`.

## In plain language

LegacyAI now has screens for its core loop. They are a web application in the browser, served by the existing API
service (no new service). They have been run in a real browser against the real API on GitHub's test machines,
with the fake AI. **They are not deployed anywhere**, so nobody can open them on the internet yet.

Screens built (step 3a of the proposal): sign in and first-time set-up, home, ask, documents, knowledge and
verification, review queue, my consent and contributions.

Step 3b (interview, topics and gaps, readiness test, people and cards, company settings and audit log, operator
console) was built afterwards: see "Phase 3b" at the end of this document.

## Evidence

CI run 37125776171 on commit `fe5ef55`: 10 of 10 jobs green.

| Claim | Evidence |
|---|---|
| The screens work with the real API in a real browser | job "Web - browser tests": 9 of 9 passed (Chromium). Flows: sign-in and refusal of wrong details, first-time set-up with an authenticator app, add a document and see what was blanked out, ask (answer with sources, or "I don't know"), give consent, write an item and send it for review, a second card verifies it, withdraw consent, and a card without a permission |
| A card without a permission gets no way in | same job: the menu shows no link, the address shows "not available", and the API itself answers 403 |
| Browser policy | same job: strict content security policy on the page, no inline script, nothing in browser storage, the session cookie is not readable by scripts |
| Accessibility | automated scan (axe-core, WCAG 2.1 A and AA rules) on each screen visited by the tests: no violations. **Automated checks only**; not tested with people who use assistive technology |
| Screenshots | saved by the browser job as the workflow artifact `web-browser-tests` (kept 14 days) |
| Web unit tests | 47 passed |
| Layering is enforced | lint self-test: 19 deliberate violations rejected, 3 clean files accepted |
| Types match the API contract | 119 operations, 82 schemas; generated file matches |
| API still passes | 646 tests passed, 1 skipped; statements 85.66 %, branches 81.14 % |

## What the browser tests found

1. **An expert could not save a knowledge item from the screen** (the API answered "not allowed"). The API lets a
   card write items only for its own person, and the session did not tell the screen who that person is. Fixed by
   adding one field, `person_id`, to the session answer. This is a small change to the API contract; no new operation.
2. **Redaction blanked out an ordinary word.** A document titled "Boiler manual (synthetic)" was stored and shown as
   "[PERSON_1] manual (synthetic)": "Boiler" was taken for a person's name. **Narrowly fixed afterwards** (commit
   `0f2886e`): a name finding made only of equipment words from a built-in list of 38 ("boiler", "valve", "pump" ...)
   is kept as text; a real name beside such a word is still redacted (tested). This is not a general cure: other
   ordinary words can still be blanked out, and the company allow-list remains the remedy for those. Redaction recall
   on the golden set is unchanged (398 of 410) in CI run 37127546475.
3. A new company does not have the "reviewer" role switched on; reviewing is done by the "expert" role there. The
   tests were corrected; the product was not changed.

## Design reviews

Three independent reviews (object-oriented design, clean architecture, interface design), two rounds. No critical
finding in either round. Round 1: six warnings, all fixed. Round 2: four new warnings, of which one is fixed
(a wrong word in an on-screen hint) at once and the other three afterwards (commit `0f2886e`, CI run 37127546475,
10 of 10 jobs green; 49 web unit tests, 9 of 9 browser tests):

- The home screen now says "At least N" when the list of waiting questions was cut short (unit test).
- A failed file upload is retried on the same document instead of creating a second one (unit test). The browser
  tests do not cover this case.
- Lint now refuses sub-folders inside a feature, which the feature-isolation rule relies on (self-test case added;
  20 deliberate violations rejected).

No design-review warning is open. The suggestions the reviews listed were not all taken (see the review notes in
`docs/phase3/01-web-application.md`).

## Deviations from the proposal

| Proposal said | What was done | Why |
|---|---|---|
| Types from `openapi-typescript` | a small generator of our own (`web/scripts/generate-api.mjs`) | that package requires TypeScript 5; the project uses 6.0.3 |
| No backend change except serving files | `person_id` added to the session answer | finding 1 above |
| — | "no-store" on API answers is now forced for everything except the static files | so the page's files can be cached |

## Done, but NOT proven

- **Not deployed.** At the end of 3a the container image did not include the screens; it does now (see the 3b part below).
- **Passkeys** in a real browser: unit-tested with a stand-in only; the browser tests sign in with authenticator codes.
- **One browser only** (Chromium), desktop size. No Firefox, Safari or phone.
- **Real AI answers on the screens**: the browser tests use the fake AI.
- Lists page with "show more"; only the review queue's paging has a unit test.
- Adding one's own notes (not company documents) and "ask an expert" still need the permission to read the people
  list; they now could use `person_id` instead, which is not done.
- No usability test with real people.

## Cost

$0. No paid AI call was made for this phase. Total real-AI spend of the project stays $0.642 (Phase 2 evaluation).

---

# Phase 3b — the remaining screens

> Added 2026-10-03. Evidence: CI run 37132958848 on commit `e39b614`, 10 of 10 jobs green.

## In plain language

The remaining six groups of screens are built: interviews, topics and gaps, readiness test and question bank, people
and cards, company administration (settings, AI budget, audit log, export, consents), and the operator console.
**Still not deployed.** While testing them, a real privacy fault of Phase 2 was found and fixed, and the rule behind
it is now enforced for every list in the API.

## Evidence

| Claim | Evidence |
|---|---|
| The new screens work with the real API in a real browser | browser tests: 16 of 16 passed (Chromium, fake AI). New flows: an expert accepts an interview and answers a turn; an admin sets topics and reads the gap report; reviewers generate and approve questions, a learner takes the test and opens the report; an admin issues a card and suspends it; the owner opens settings and the audit log; a learner is offered no management screen and the API refuses each one directly |
| Web unit tests | 90 passed |
| Lint keeps the layers apart | 22 deliberate violations rejected, 3 clean files accepted |
| API | 656 tests passed, 1 skipped; statements 85.98 %, branches 81.43 % |
| The operator console | **unit tests only; no browser test** |

## A privacy fault found by the browser tests (Phase 2 code)

**What was wrong:** a card of an Expert or Successor could list the consent records of every person in its company
(who agreed to what, and when). Those roles hold the right to read consents only for their own records; the policy
allowed the list on condition that the result is filtered, and the list did not filter. Read from the code and then
confirmed by a test; nothing is deployed and all data is invented, so no real record was exposed.

**Fix 1:** the consent list applies the filter. Test: a learner sees its own consent, not a colleague's, also when
asking for the colleague by id; the owner sees both.

**Fix 2, the rule behind it (decision D23):** every route that reads a whole list must declare how the condition is
met — filtered in the API (7 routes), filter passed to the AI service (5), or "one company-wide answer" (9). A request
whose policy decision demands a filter is refused, and the refusal is written to the audit log, unless the route
filters or passes the filter on. A list route that declares nothing is refused. One more list had the same fault in
a latent form: the redaction allow-list returned the company list to a department-scope card (the Department Manager
role, which a new company does not have switched on). That card is now refused.

**Review before pushing:** an independent read of the change found no way around the check and no wrong filter.
Its four low-severity notes, all open:

- The gap report is narrowed by the right to read knowledge, not by the right to read gaps. No single role differs
  between the two today; a card holding two particular roles together could see a company-wide gap report.
- "Filtered" and "passed on" are declarations. The tests pin the declarations and prove the refusal; they do not
  prove that each handler's query really uses the filter (the consent list has its own test; the others were read).
- The Department Manager is now refused the redaction allow-list; the settings screen may still show that panel
  and then an error.
- The "declares nothing" refusal covers GET routes only; other undeclared reads are refused only when a filter is due.

## Design reviews

Three reviews, two rounds, then one round of fixes. No critical finding. Round 1: nine warnings, all fixed.
Round 2: five warnings, all fixed in the third round, which was then covered by the security read above and by CI
but **not by another design review**. Fixed among them: confirmation buttons could be confirmed after their inputs
changed (for example a different card number in owner recovery); typed test answers could be lost at hand-in; the
answer key was hidden by a rule that would have failed open on an unknown test state.

## What the API lacked for these screens

State at the end of Phase 3b, and what was closed afterwards (decision D24; five operations added, 124 in total;
no permission or grant changed, no migration).

**Evidence:** CI run 37138193998 on commit `a32227c`: 10 of 10 jobs green; 679 API tests passed (1 skipped;
statements 87.64 %, branches 82.91 %), 17 of 17 browser tests, 101 web unit tests; the both-services walk covers the
five new operations; permission leakage in the AI service: 16 attack groups, 64 queries, 0 leaks.

**How it was checked before each push:** two independent security reads of the uncommitted change. The first found
three medium problems (topic names shown one level too far; an author could set the topics of their own verified
item; a control character that made git treat a policy-bearing file as binary) - all fixed before pushing. The second
found nothing critical, high or medium. Three design reviews then raised ten warnings (no critical); all were fixed,
and that last round was covered by the second security read and by CI, **not by another design review**.

**What CI found on the way:** the list of tests taken was stale right after a hand-in (fixed); a job-role name of
more than about 100 percent-encoded characters could not be addressed at all - the server answered 414 - which would
have hit names of roughly 16 or more characters in a non-Latin script (fixed: the limit now fits 120 characters in
any script).

**Open low-severity notes from the last security read:**
- Two reviewers saving the same item's topics at the same moment could leave a link one of them removed (both
  changes are in the audit log).
- A contributor can still change the department of their own released item, or lower its sensitivity from 3 to 1,
  without a second person; only lowering to 0 needs one. Unchanged behaviour from Phase 2, now written down.
- Job-role names may contain invisible or direction-changing characters, so two roles can look the same on screen.
- No test names a person outside the caller's scope when setting a job role's people (with the standard roles nobody
  holds that permission below company scope).

- **CLOSED — link a knowledge item to topics.** A reviewer does it on the item's screen (on a verified item: a second person,
  not its contributor or the author of its current version - enforced by the API, decision D24)
  (`PUT /v1/knowledge/items/{id}/topics`). The browser test now makes the link through the screen; nothing in the
  tests writes it to the database any more.
- **CLOSED — job roles.** They are listed (`GET /v1/job-roles`) and offered to pick from on the gap screen and when
  starting a test; a role's people are read back, so the people form starts from what is stored. Limit: a job role
  with people but no topics is not in the list (it is still typed by name).
- **CLOSED — tests taken.** `GET /v1/readiness/attempts`: a learner sees its own, Owner and Admin the company's.
- **CLOSED — next page** for expert questions and "my consents".
- **OPEN —** the session lists permissions without their scope, so the menu still uses a stand-in ("may read company
  settings") to decide who is offered consent administration.

## Done, but NOT proven (3b)

- **Not deployed.** The API's container image now includes the screens (CI run 37140328845, commit `9888950`, 10 of 10
  jobs: the image builds, runs as a non-root user (253 MB), its own loader serves the page and a deep link, nothing
  under /v1 is shadowed, and no web sources, source maps or tests are inside). What that does not show: the image
  was never started with a database behind it, and never run on Google Cloud. Terraform stays plan-only.
- One browser (Chromium), desktop size; passkeys in a real browser untested; no test with real people.
- People and cards: only the read-only restriction can be edited; other restrictions are displayed.
- The accessibility result is an automated scan of the screens the tests visit.

## Cost

$0 for Phase 3. Total real-AI spend of the project stays $0.642.
