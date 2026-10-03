# Phase 3 proposal — the screens

> **A proposal for approval. Nothing in this document is built.** There was no written brief for Phase 3; this is
> what I suggest, following the same pattern as Phases 1 and 2: design first, stop for your approval ("Gate 1"),
> then build with tests. Change anything you like.

## In plain language

Today LegacyAI has no screens: the 119 operations of the API can only be used by other programs. Phase 3 gives
people a web application in the browser for the things the backend already does: sign in with a card, add and
verify knowledge, ask questions, run interviews, take readiness tests, and manage the company.

It adds **no new backend features**. Every screen calls operations that already exist and are already tested, so
the permission rules stay where they are — in the API. A screen can hide a button; it can never grant access.

## What exists and what is missing (state on 2026-10-03)

| | State |
|---|---|
| Backend, Phase 1: company and card setup, sign-in with card + secret code + second factor, card lifecycle, roles and permissions, card restrictions, audit log | built, tested |
| Backend, Phase 2: interviewer, gap detector, verification, readiness test, cited answers, ask-the-expert, permission-aware answers, redaction, consent, answer logging, review queue, documents | built, tested with a fake AI; a limited real-model run done (`docs/phase2/EVALUATION.md`) |
| **Screens (any)** | **none** |
| Real-model run through the full service | not done (needs the key as a GitHub secret) |
| Deployment to the cloud | not done (Terraform is plan-only, never applied) |
| Billing, single sign-on, QR/NFC cards, voice, scanned documents, knowledge graph, and the other features of the 35 not listed above | not built |

## Proposed screens, in two steps

**Step 3a — the core loop (build first):**

1. **Sign in and first-time set-up**: card number, 3-digit code, passkey or authenticator app; enrolment with the one-time token.
2. **Home**: what this card may do, what is waiting for it (tasks, questions, interviews), read-only notice during the grace period.
3. **Ask**: a question box; the answer with its sources and "verified / not verified" marks; a clear "I don't know" with the option to ask an expert.
4. **Documents**: add a document (describe it, send the file, see progress and what was redacted), list, withdraw.
5. **Knowledge**: list and read items, write one, send to review; for reviewers: verify, correct, reject, reopen.
6. **Review queue**: tasks by priority, assign, dismiss, bulk actions.
7. **My consent and contributions**: give and withdraw consent, see and restrict what I contributed.

**Step 3b — the rest:**

8. **Interview** (expert): accept, answer questions, pause and resume.
9. **Topics and gaps** (admin): topic list, job-role maps, the gap report.
10. **Readiness test** (learner): take a test; (reviewer) question bank and approval; the report.
11. **People and cards** (admin): people, issue / suspend / renew / replace cards, roles, restrictions.
12. **Company settings, AI budget, audit log and export** (owner).
13. **Operator console** (you): create a company, renew a company card, recover an owner, AI cap and stop switch.

## How it would be built

- **One web application**, written in TypeScript with React, built into plain files (HTML, JavaScript, CSS).
- **Served by the existing API service**, from the same address. Reasons: the sign-in cookie only works when the
  screens and the API share one site; it needs **no new service and no new cloud resource** (the limit of five
  backend services is untouched); cost stays $0. The API's rule "no route without a policy" gets one explicit,
  tested exception for static files.
- **Types generated from `openapi.yaml`**, so a screen cannot call an operation or use a field that does not exist;
  CI fails if they drift.
- **No secret in the browser.** The session stays in the existing protected cookie; nothing is kept in browser storage.
- **Accessibility from the start**: keyboard use, visible focus, labels, sufficient contrast — checked by an
  automated test on every screen and stated honestly as "automated checks only" (no test with real users of
  assistive technology).
- **Tests:** unit tests for components; end-to-end tests in a real browser against the real API with the fake AI,
  in CI, for each flow in the list above; a test that a role without permission is shown no path to a forbidden
  screen **and** is refused by the API if it tries anyway.
- **Plain, consistent design**: one small design system (colours, type, spacing, form controls) written in the
  repository, light and dark. No brand work is included.

### Tools I would use (checked on 2026-10-03 against the 60-day rule)

| Purpose | Package | Newest version at least 60 days old | Latest (date) | Licence |
|---|---|---|---|---|
| Screens | react, react-dom | 19.0.8 (2026-07-21) | 19.3.0 (2026-09-09) | MIT |
| Build tool | vite | 8.2.0 (2026-07-30) | 8.3.2 (2026-10-01) | MIT |
| React support for the build tool | @vitejs/plugin-react | 6.0.5 (2026-07-30) | 6.1.1 (2026-08-28) | MIT |
| Page navigation | react-router | 7.18.2 (2026-07-28) | 8.4.0 (2026-09-15) | MIT |
| Loading data from the API | @tanstack/react-query | 5.101.4 (2026-07-21) | 5.104.1 (2026-10-02) | MIT |
| Passkeys in the browser | @simplewebauthn/browser | 13.3.0 (2026-03-10) — same major line as the server's 13.3.3 | 14.0.0 (2026-09-02) | MIT |
| Types from the API contract | openapi-typescript | 7.13.0 (2026-02-11) | same | MIT |
| Language | typescript | 6.0.3, as the API uses | 7.0.2 (2026-07-08) | Apache-2.0 |
| Unit tests | vitest, @testing-library/react | 4.1.10 (2026-07-06) / 16.3.2 (2026-01-19) | 5.0.3 / 16.3.3 | MIT |
| Browser tests | @playwright/test | 1.62.1 (2026-07-30) | 1.63.0 (2026-09-04) | Apache-2.0 |

Source for every row: `https://registry.npmjs.org/<package>` read on 2026-10-03. Exact pins are re-checked and
recorded in `docs/DEPENDENCIES.md` when the build starts. ASSUMPTION: these versions work together; that is proven
only when CI builds them.

## What Phase 3 would NOT include

Mobile apps; offline use; real-time updates; languages other than English; a marketing site; brand design;
billing screens; any new backend feature; deployment (still plan-only, still your decision).

## Decisions I need from you (Gate 1 for Phase 3)

| # | Decision | My recommendation | If wrong |
|---|---|---|---|
| 1 | Build 3a first, then 3b — or everything at once? | 3a first: you can try the core loop sooner | 3b arrives later; nothing is thrown away |
| 2 | Serve the screens from the API service? | Yes: $0, no new service, cookie rules already fit | Moving to separate hosting later is a configuration change plus a domain |
| 3 | Look and feel | Plain and neutral now; brand later | Restyling later touches the design system, not the screens' logic |
| 4 | Where do I work? | A fresh folder on the C: drive, cloned from GitHub. **`E:\\LegacyAI` is damaged and should not be used until the drive is checked** | — |
| 5 | Finish the Phase 2 real-model run first? | Yes if you can add the key as a GitHub secret (about $0.55); otherwise carry on and leave it open | The screens do not depend on it; answer quality through the full service stays unmeasured |

## Risks to know before approving

- **I cannot show you the screens on your computer the way a developer would**, because the database does not run
  there. Proof will be browser tests in CI plus screenshots saved by those tests. You would first click through the
  real thing only after a deployment, which is not part of this phase.
- **A browser application is a new attack surface** (cross-site scripting above all). The design keeps secrets out
  of the browser and sets a strict content security policy, and tests check both; that reduces the risk, it does
  not remove it.
- The frontend tool chain adds many third-party packages. Each is pinned, audited in CI and recorded.
