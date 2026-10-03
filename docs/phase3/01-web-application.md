# Phase 3a — the web application (core loop)

> State on 2026-10-03: written and checked locally (type-check, lint, unit tests, build). **The browser tests
> against the real API have not run yet** — they run only on GitHub Actions. Nothing is deployed.

## In plain language

`web/` is a browser application for the things the backend already does. It adds no backend feature. It is built
into plain files, and the API service sends those files from its own address, so there is still one public service
and nothing new to pay for.

The screens of step 3a:

| Screen | What a person can do | API operations used |
|---|---|---|
| Sign in | card number, 3-digit code, then a passkey or an authenticator-app code | `loginBegin`, `loginVerify` |
| Set up a card | first-time set-up with the one-time token; passkey or authenticator app | `enrollmentBegin`, `enrollmentComplete` |
| Home | what this card may do; what is waiting | `listReviewTasks`, `listExpertQuestions` |
| Ask | a question; the answer with sources and "verified / not verified"; a plain "I don't know"; send the question to a colleague | `askKnowledge`, `listPeople`, `createExpertQuestion` |
| Documents | add (describe, send the file, see the result), list, see what was blanked out, confirm, withdraw | `createSource`, `uploadSourceContent`, `listSources`, `getSource`, `confirmSource`, `withdrawSource` |
| Knowledge | list, read, write, send for review; verify, reject, correct, reopen | `listKnowledgeItems`, `getKnowledgeItem`, `createKnowledgeItem`, `submitKnowledgeItem`, `verifyKnowledgeItem`, `rejectKnowledgeItem`, `proposeItemVersion`, `reopenKnowledgeItem` |
| Review queue | tasks by urgency; take, give back, dismiss; several at once | `listReviewTasks`, `assignReviewTask`, `unassignReviewTask`, `dismissReviewTask`, `bulkReviewTasks` |
| My consent | give and withdraw consent; see my contributions and limit who may read them | `listMyConsents`, `giveConsent`, `withdrawConsent`, `listMyContributions`, `restrictContribution` |

## How it is put together

```
services/api/openapi.yaml
        │  web/scripts/generate-api.mjs (CI fails if out of date)
        ▼
web/src/api/generated.ts     types + the table of operations (method, path, permission, idempotent)
web/src/api/client.ts        the ONLY code that talks to the network
web/src/api/context.tsx      hands the client to the screens; helpers: read, read a list page by page, change, refresh
web/src/session/             who is signed in; can(operation) for showing or hiding
web/src/navigation/          routes.ts: every screen's address and the operation it requires (the one place an
                             address is written); ScreenLink: a link that is plain text if the card may not open it
web/src/features/<name>/     one folder per screen group: hooks (data) + screens (markup)
web/src/ui/                  the small design system; no data access
web/src/screens.tsx          routes.ts plus the component of each screen; the menu and routes are built from it
```

Rules that lint enforces (and a self-test proves the rules fire): only `api/client.ts` may call the network; nothing
is kept in browser storage; no inline style and no raw HTML; `ui/` may not reach for data; the layers point one way
(`api` → `session` → `navigation` → `features` → `screens`/`App`); a feature may not import another feature (the rule
does not depend on folder names, so it also covers features added later), nor the application frame, nor the cache
library or the API client itself — features use only the helpers of `api/context.tsx`.

**Lists are honest about being partial.** Every list is read one page at a time. When the API holds more than is
shown, the screen says "Only the first N … are shown. There are more." and offers "Show more"; for the one list the
API cannot continue (my consents) it only says so.

**API answers are never cacheable.** `cache-control: no-store` is forced on every reply, whatever a handler set; the
only exception is a reply the static-file handler itself produced (it marks the reply explicitly). A unit test covers
both directions.

**Permissions.** The menu, the routes, the home page and every link between screens are built from `navigation/routes.ts`: a screen appears only if the session's
permission list contains the permission the contract names for that screen's operation. This only decides what is
*shown*. Every request is checked again by the API, which stays the authority.

**Session and anti-forgery token.** The session is the existing cookie that scripts cannot read. The anti-forgery
(CSRF) token arrives with the session, is kept in memory only, and is sent on every changing request. Operations the
contract marks get an `Idempotency-Key`.

## How the API serves the files (the one exception to "no route without a policy")

`services/api/src/modules/platform/internal/static-site.ts`. It is not a route: it answers only requests that
matched **no** API route. Its limits, each covered by a test in `services/api/test/unit/static-site.test.ts`:

- off unless `WEB_DIST_DIR` is set (then a folder that is not a usable build stops start-up);
- GET and HEAD only; never anything under `/v1` (the API keeps its own "not found" there);
- only files read into memory at start-up are sent — the request path is a key into that list and never touches the
  file system; symbolic links and unknown file types are refused at start-up;
- an address without a file extension gets the application page, so reloading on any screen works;
- sent with a strict browser policy: scripts, styles, images and connections from this address only, no inline
  script or style, no framing. `web/scripts/check-build.mjs` fails the build if the page would not fit that policy.

Not covered: these files are not rate-limited (they are small and held in memory) — a flood of requests for them is
left to the platform in front of the service.

## Configuration

| Variable | Meaning |
|---|---|
| `WEB_DIST_DIR` | Folder with the built application (`web/dist`). Not set = the API serves no files (as before). |
| `ALLOWED_ORIGINS` | **Must contain the address people open the application at** (for example `https://app.example.com`). Browsers send that address as `Origin` on every changing request, and the API refuses changing requests from an origin that is not on the list. |
| `WEBAUTHN_RP_ID` | Must be the host name of that same address, or passkeys will not work. |

## What was tested, and where

| Check | Result | Where it ran |
|---|---|---|
| API: type-check, lint, module boundaries | pass | locally |
| API unit tests incl. 14 for the file serving | 306 passed | locally (`npm run test:unit`) |
| Web: type-check (incl. compile-time checks that a hook cannot be called without the arguments its operation needs), lint, lint self-test (19 deliberate violations rejected, 3 clean files accepted) | pass | locally |
| Web unit tests: API client (11), sign-in and set-up (6), the seven screens' main states (19), the frame and session (10), argument rules (1) | 47 passed | locally (`npm test`) |
| Web build + policy check | pass; 4 files, script 334 kB (101 kB compressed) | locally |
| Generated types match the contract | 119 operations, 82 schemas | locally |
| The API can load the real build | 4 files | locally |
| **Browser tests** (9 tests: policy and storage, wrong sign-in, set-up and sign-in, add a document, ask, consent + write + submit, review queue + verify with a second card, withdraw consent, a card without a permission) with an accessibility scan and a screenshot per screen | **NOT RUN YET** | GitHub Actions job "Web - browser tests" |
| Database tests of the API with the change | **NOT RUN YET** | GitHub Actions |

## Not done, not verified, and assumptions

- **The browser tests have never run.** They were written without being able to start the database here. Expect
  the first CI run to need fixes. Until that job is green, "the screens work against the real API" is unproven.
- ASSUMPTION: Chromium accepts the `__Host-` session cookie from `http://localhost` in CI.
- ASSUMPTION: an API refusal for a missing permission is status 403 (the browser test asserts it).
- The "ask" browser test checks that the screen shows what the API decided. With the fake AI it cannot check that
  an answer is good.
- Passkeys are covered by unit tests with a stand-in device only; no browser test uses a real or virtual passkey.
- The accessibility check is an automated scan (axe-core, WCAG 2.1 A/AA rules). It finds only part of the possible
  problems; nobody has tested with a screen reader or with real users.
- **A person cannot yet add their own notes without help**: the session does not say which person the card belongs
  to, so "whose material is it?" offers a list only to cards that may list people; others can add company documents.
  Fixing that needs a small backend addition (person id in the session), which is outside this step.
- "Ask an expert" needs the right to list people for the same reason.
- Lists load 50 entries at a time (people: 100) with a "Show more" button; there is no search or sorting.
- The container image does not contain the application yet (`services/api/Dockerfile` is unchanged), and Terraform
  is unchanged. Deployment remains a separate, later decision.
- Step 3b (interview, topics and gaps, readiness test, people and cards, settings, operator console) is not started.
- No brand design; English only.

## Step 3b: the remaining screens (written 2026-10-03)

> State when this was written: the code is in place and passes the local checks (types, lint, 79 unit tests, build).
> The browser tests for these screens (`web/e2e/more-screens.spec.ts`) have NOT run yet; they run only in CI.

| Screen | Address | Shown to a card that may | Folder |
|---|---|---|---|
| Questions between colleagues (inbox and "asked by me") | `/questions` | read expert questions | `features/ask` |
| Interviews, and one interview | `/interviews`, `/interviews/:id` | read interviews | `features/interviews` |
| Readiness test: start, take, report | `/readiness`, `/readiness/attempts/:id`, `/readiness/reports/:id` | take a test / read results | `features/readiness` |
| Test questions (question bank) | `/readiness/questions` | read the bank | `features/readiness` |
| Topics | `/topics` | manage topics | `features/topics` |
| Job roles and gaps | `/gaps` | read the gap report | `features/topics` |
| People, Cards, one card | `/people`, `/cards`, `/cards/:id` | create people / issue cards / read a card | `features/people` |
| Consents (of the company's people) | `/consents` | read consents **and** read the people list | `features/admin` |
| Settings (company, cards and sign-in, knowledge rules, AI budget, redaction allow-list) | `/settings` | read company settings | `features/admin` |
| Audit log (list, chain check, export) | `/audit` | read the audit log | `features/admin` |
| Operator console | `/operator` | list companies (the platform operator only) | `features/operator` |

How they fit the existing design:

- Every screen is one entry in `navigation/routes.ts` and one line in `screens.tsx`. A route can be marked
  `menu: 'manage'`; those appear in a second menu ("Manage") so the everyday menu stays short.
- New pieces of the design system (`ui/`): `ConfirmButton` (a two-step button for anything that cannot be undone or
  costs money), `OneTimeSecrets`, `CheckboxField`, `Facts`.
- **One-time secrets** (a card's 3-digit code, a set-up token) are held in the state of the screen that received
  them and nowhere else: they disappear when the person presses "I have written these down" or leaves the screen.
  The data layer drops the answer of a change as soon as no screen shows it (`gcTime: 0` for mutations in `main.tsx`).
- **A learner is never shown the answer key while a test runs.** The running-test view draws only the question and
  its options, whatever the API sends (unit test with a deliberately "leaky" answer).
- **Buttons follow the state rules of the database**: for example a card that was only issued can be revoked but
  not suspended or replaced, so those buttons are not offered for it.
- Two-step confirmation is used for: finishing an interview, handing in a test, retiring a topic or question,
  marking a person as left, revoking / replacing / renewing / unlocking a card, a new set-up token, taking a role
  away, recording a withdrawal for a person, lifting a legal hold, removing an allow-list word, and every action on
  the operator console (creating a company, the spending limit, renewing the company card, owner recovery, the AI
  stop switch).

What the API does not offer, and what the screens do about it (no contract change was made):

- **No list of job roles.** Job roles are typed by name on the gap, interview and readiness screens.
- **No way to read the people set for a job role.** The "People in this job role" form can only replace the whole
  list and says so.
- **No list of readiness tests taken.** A test or report is opened from the link shown after handing in, or by
  typing its reference.
- **No link from a knowledge item to a topic through the API.** Without it a generated question has no topic and
  cannot appear in a test; the question bank marks such questions. (The browser test server sets the link directly
  in the test database, as the existing both-services test does.)
- **Listing expert questions and my consents has no "next page".** The screens say when the list is cut short.
- Card restrictions other than "read-only" (usage caps, time windows, network lists) are shown but not editable.
- The redaction allow-list sits on the Settings screen, which needs the right to read company settings; an expert
  who may manage the list but not read settings cannot reach it here.
- The operator console has unit tests only: the browser tests have no platform-operator sign-in with an
  authenticator app.

## Changes after the first reviews of step 3b

- **A screen can require more than one operation** (`alsoRequires` in `navigation/routes.ts`). The session lists
  permissions without their scope, and Experts and Successors hold "read consents" for their own records only, so the
  company consent screen also requires the right to read the people list. The API itself now filters the consent list
  to the caller's own records for such cards (it did not before; found by the browser tests).
- **`ConfirmButton`** withdraws its question when the action becomes disabled or busy or its inputs change
  (`resetKey`), and puts Cancel first. Replacing the people of a job role and changing a test score now go through it.
- **Readiness test:** answers or scores are drawn only in the states `submitted`, `graded`, `expired`; any other state
  is treated as still running. A typed answer is saved when its field is left; handing in is blocked while a typed
  answer is unsaved.
- **One-time secrets:** when the API reports a repeated request (`secret_already_shown`), the screen says the secrets
  were shown earlier and cannot be shown again.
- **Lint:** dynamic `import()` and `sendBeacon` are refused. **API:** a dependency rule states that `src` never imports `test`.
- **Type generator:** "one of these properties is required" becomes a union of object types; a settings PATCH body is
  typed against the request type.
