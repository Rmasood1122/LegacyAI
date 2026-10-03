# Phase 3a report — the first screens

> Written 2026-10-03. Every claim is backed by a CI run or labelled ASSUMPTION / NOT PROVEN.
> Proposal: `docs/phase3/00-proposal.md` (approved by the founder). Design notes: `docs/phase3/01-web-application.md`.

## In plain language

LegacyAI now has screens for its core loop. They are a web application in the browser, served by the existing API
service (no new service). They have been run in a real browser against the real API on GitHub's test machines,
with the fake AI. **They are not deployed anywhere**, so nobody can open them on the internet yet.

Screens built (step 3a of the proposal): sign in and first-time set-up, home, ask, documents, knowledge and
verification, review queue, my consent and contributions.

Not built (step 3b): interview, topics and gaps, readiness test, people and cards, company settings and audit log,
operator console.

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

- **Not deployed.** The container image does not yet include the screens (`WEB_DIST_DIR` is not set in it).
- **Passkeys** in a real browser: unit-tested with a stand-in only; the browser tests sign in with authenticator codes.
- **One browser only** (Chromium), desktop size. No Firefox, Safari or phone.
- **Real AI answers on the screens**: the browser tests use the fake AI.
- Lists page with "show more"; only the review queue's paging has a unit test.
- Adding one's own notes (not company documents) and "ask an expert" still need the permission to read the people
  list; they now could use `person_id` instead, which is not done.
- No usability test with real people.

## Cost

$0. No paid AI call was made for this phase. Total real-AI spend of the project stays $0.642 (Phase 2 evaluation).
