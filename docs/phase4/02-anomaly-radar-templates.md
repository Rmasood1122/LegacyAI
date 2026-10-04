# Phase 4, Batch A, step 2 — anomaly lock (5), retirement radar (11), department templates (26)

> Written 2026-10-04. What is described here is in the code. What was measured, and where, is in
> `docs/phase4/REPORT.md` once CI has run; until then the database and browser tests of this step are NOT PROVEN.
> Plan: `docs/phase4/00-plan.md`. Decision: D26 in `docs/decisions.md`. No AI call of any kind is made by these features
> (applying a template asks the AI service for a search vector per new topic, exactly as creating a topic does).

## 1. Anomaly lock (feature 5)

### In plain language

Two simple rules watch how a card is used. When one fires, the card is locked with the **same lock a wrong secret
code produces**: its sessions end, and an administrator unlocks it the same way, which issues a new 3-digit code.
The rules are counts and comparisons a person can read. They can be wrong; that is why a lock can be undone.

### The rules (`services/api/src/modules/identity-access/internal/anomaly.ts`)

| Rule | What is counted | Default | Range |
|---|---|---|---|
| Many refused actions | **Counted** refusals (see "Which refusals count" below) by the policy decision point for requests made **with a live session of the card**, in a fixed window | on; 20 refusals in 10 minutes | 5–500 refusals, 1–60 minutes |
| Sign-in from a second network address | A **successful** sign-in (strong factor + secret code) from one address while another session of the same card was used from a different address in the last N minutes | **off**; 15 minutes | 1–120 minutes |
| Use outside set hours | **Not built as an anomaly rule.** A card can already be given a time-window restriction (Phase 1); a request outside it is refused. Those refusals are deliberately **not** counted by the first rule (ordinary use runs into them) | — | — |

The whole feature can be switched off per company, and each rule has its own switch: "off" is always a switch, never
a special number, so every stored number is a usable value. The settings live in `anomaly_settings` (no row = the defaults)
and are read and changed with the rights for company settings (`tenant_settings:read` / `tenant_settings:update`).

Why the second rule is off by default: it compares network addresses, not places. A phone on mobile data and a
laptop on the office network are two addresses, so the rule would lock people who do nothing wrong. A company that
works from one site can switch it on.

### Why a card NUMBER alone cannot be used to lock somebody's card

- The first rule is called from exactly one place: the HTTP layer's decision about a request that carried a valid
  session of the card (`recordDecision` in `identity-access/index.ts`). A request without a session, with a made-up
  cookie, or with the card number in a header never reaches it: it is answered 401 before any decision exists.
  Failed sign-ins are not counted here at all (they are handled by the secret-code lockout, which needs the strong
  factor first). Re-checks inside handlers (for example of each passage before an answer) are not counted.
- The second rule is called only after a sign-in succeeded, that is after the strong factor and the secret code were
  verified. A wrong code from another address triggers nothing.
- Another card's refusals are counted for that other card only.

Tests: `test/integration/anomaly-radar-templates.test.ts` — "a card NUMBER alone cannot be used to lock somebody's
card", "a wrong secret code from another address does not trigger the rule".

What it does **not** prevent: somebody who has stolen a session of a card can make that card lock itself. That
ends the stolen session too, so it is the safe direction.

### The last usable Owner card

If the card a rule fires on holds the Owner role and no **other** Owner card is active, in date and not locked, the
card is **not locked**. The event is written to the card's history (`anomaly_not_locked`) and the audit log
(`ANOMALY_NOT_LOCKED_LAST_OWNER`), and a notice goes out. The check runs under the same per-company lock as every
change that could leave a company without an Owner. Test: "the last usable Owner card is never locked by a rule".

Limit: Owners do not manage each other (a Phase 1 decision). An Owner card locked by a rule while another Owner
exists is recovered by the platform operator, exactly as after wrong secret codes.

### What is recorded

- The card's usage history: `anomaly_locked` or `anomaly_not_locked`, with the rule and the count. As for every
  usage-history row, the address and device are stored only as keyed hashes.
- The audit log: action `card:lock`, reason `CARD_LOCKED_ANOMALY_DENIALS` or `CARD_LOCKED_ANOMALY_SECOND_ADDRESS`,
  details `rule` and `count`. No address.
- A notice through the existing notifier (today: a log line; e-mail is Batch B).
- `GET /v1/anomalies` lists the recent events (card, rule, count, locked or not) to whoever may read card history;
  the Cards screen shows it to cards that may unlock. A card's `lock_reason` is now part of the card.

### What it cannot do

- It does not learn what is normal for a person. Fixed thresholds only.
- "Not found" answers are not counted: old links and deleted records produce them in ordinary use, and they are
  decided before the policy is asked. Somebody guessing record ids is therefore not caught by this rule.
- **Slow probing is never caught.** One refusal fewer than the threshold in every window (with the defaults: 19
  every 10 minutes, about 2,700 a day) never locks. The rule finds bursts. The counter is a fixed window, not a
  sliding one: up to twice the threshold minus one refusals can also fit across two windows without a lock.
- A stolen session of the company's ONLY usable Owner card is never ended by a rule (that card is never locked).
- Rule two depends on the service knowing the real client address: `TRUST_PROXY` must equal the real number
  of proxies in front of the API (Terraform sets 1). Too low: everybody appears to share one address and the rule
  never fires. Too high: a client can make up its address.
- Rule two knows nothing about geography or "impossible travel".

## 2. Retirement radar (feature 11)

### In plain language

A person's planned leaving date can be recorded. The radar lists everybody who leaves within 24 months, soonest
first, with how much the system already holds from each person. At 24, 12 and 6 months a nudge is written down once
and the people who look after knowledge capture are told.

### The date is personal data

- Its own table (`person_leaving`), never part of the people list or the person record.
- Read with the person's own access rule (`person:read`): a card that may read only its own person reads only its
  own date; Owner, Admin and Auditor read the company's. Changed with `person:update` (Owner, Admin), which is
  guarded like every change to a person: not on yourself, not on somebody who outranks you.
- The audit log records that the date was set or removed and which nudge stage was reached — never the date.
- It goes with the person: it is removed in the same step that marks the person as departed, by the housekeeping
  command once the date lies more than 30 days in the past, and with the person if the person is deleted.
- A real calendar day, not before today and not more than 50 years ahead. "Today" is the current day in UTC.
  Months are calendar months (the same day N months on, or the last day of that month): one definition, in
  `leaving.ts`, used by the answers, the radar's window and the sweep. Stage 6 = less than 6 months away, 12 = less
  than 12, 24 = less than 24; exactly 6 months away is stage 12.

### The radar (`GET /v1/retirement-radar`)

Per person: name, department, date, months left, stage (6, 12 or 24), the job roles the person holds, the number of
verified items they contributed and of interviews they completed. It is narrowed like the people list and paged like
every list (by leaving date, then person).

The job roles and the two counts are **not read by the identity module**. The knowledge module answers them through
a port wired in `app.ts` (`knowledge-gateway/internal/holdings.ts`), narrowed by the asking card's rights there:
job roles need `gap:read`, the item count covers only items the card may read (`knowledge:read`: department,
sensitivity, own), the interview count needs `interview:read`. A card without the right gets **no number** (null,
shown as a dash) - not zero, which would read as "nothing captured". So an Auditor (no knowledge rights) sees who
leaves and when, and no counts.

**What it does not say:** which topics are still uncaptured for that person. The API can count a person's items and
interviews; which topics those items cover is knowledge content, which the API does not read. The gap report of each
job role shows the uncaptured topics, and the radar screen links to it. This is less than "listing what is
uncaptured for that person" and is stated on the screen.

### Nudges

`retirement_nudges` holds one row per person and stage. A nudge is created when the date is set (for the stage the
date is in now — a date three months ahead gives one nudge, not three; only that person is looked at, not the whole
company) and by the housekeeping command (`npm run housekeeping`, `docs/runbooks/housekeeping.md`) as time passes. Each is created once; running
the job again changes nothing. Changing the date starts its nudges again; removing the date, or the date passing,
removes them. The radar screen never depends on the job: it computes the stage from the date when it is read.

Limits: the notice is a log line until e-mail exists (Batch B). **Nothing schedules the housekeeping command yet**
(Terraform is unchanged in this step, because its checks cannot be run on the developer's computer): the later
nudges are created only when someone runs it. The runbook says how, and how to schedule it. The screen is for the people who manage people; a person
can read their own date and radar entry from the API, but no screen shows it to them yet.

## 3. Department templates (feature 26)

### In plain language

Seven ready-made starting points — production line, maintenance, quality laboratory, warehouse and logistics, IT
operations, finance and accounting, human resources — each with six topics and two job roles that say which topics
the role needs. An admin looks at one and adds it; then renames, removes and adds as it fits.

**The templates were written by us. No industry expert has checked them.** They are generic on purpose.

### How applying works

- The library is data in the repository (`knowledge-gateway/internal/templates.ts`), not rows in the database.
- `POST /v1/topic-templates/{key}/apply` (`topic:manage`) creates each topic with the same function `createTopic`
  uses (`insertTopic`), links it with the function `setRoleTopics` uses (`linkRoleTopic`) and asks the AI service
  for its search vector with the same function (`embedTopic`). The library is checked when the service starts: a
  template that refers to a topic it does not have stops the start.
- **It adds what is missing and changes nothing that exists.** A topic whose name exists is kept as it is and used
  for the job-role entries if the caller may read it. A retired topic of that name, or one the caller may not read,
  is counted as "skipped" (the answer does not say which of the two). An existing job-role entry is left alone, also
  when the company changed its importance. Applying the same template twice creates nothing the second time.
- Two steps: topics and links are written and committed first, then each new topic gets its search vector. If the
  second step fails the answer is 502 **and the topics and links exist already**; applying again (with a new
  idempotency key) gives the search vector to topics that lack one and duplicates nothing. The answer lists the ids
  of the topics it created and counts links created and links that were there already.
- The audit log records the template and how many topics were created.

Limits: topics are created company-wide at the lowest sensitivity, so the caller needs the company-wide right to
manage topics. There is no "remove a template". Names are English only.

## Data added (migration `20261004000200_anomaly_radar.sql`)

| Table | Holds | Owner | Row-level security |
|---|---|---|---|
| `anomaly_settings` | the company's rules: a master switch, a switch and numbers per rule | API | forced |
| `card_anomaly_counters` | one counter per card (window start, refusals) | API | forced |
| `person_leaving` | person, leaving date | API | forced |
| `retirement_nudges` | person, stage | API | forced |

Two new kinds of usage-history row (`anomaly_locked`, `anomaly_not_locked`); three audit detail keys (`rule`,
`stage`, `template_key`). The rollback removes usage-history rows of the two new kinds of every company before the
old constraint returns, and drops the four tables. A card locked by a rule stays locked after a rollback (the lock
reason has been allowed since the first identity migration).

## Operations added (9; 138 in total)

| Operation | Permission | List filter |
|---|---|---|
| `GET /v1/tenants/current/anomaly-settings` | `tenant_settings:read` | not a list |
| `PATCH /v1/tenants/current/anomaly-settings` | `tenant_settings:update` | not a list |
| `GET /v1/anomalies` | `card_events:read` | applied (like the card list) |
| `GET /v1/people/{person_id}/leaving-date` | `person:read` | not a list |
| `PUT /v1/people/{person_id}/leaving-date` | `person:update` | not a list |
| `DELETE /v1/people/{person_id}/leaving-date` | `person:update` | not a list |
| `GET /v1/retirement-radar` | `person:read` | applied (like the people list) |
| `GET /v1/topic-templates` | `topic:manage` | not company data |
| `POST /v1/topic-templates/{template_key}/apply` | `topic:manage` | not a list |

No permission or grant was added.

## In the tests, the anomaly rules start switched off

Many existing tests make one card collect refusals on purpose (for example the walk that proves a Successor is
refused 93 operations). The test app is therefore started with the rules off for companies that have not set their
own; every anomaly test switches them on for its company. In production the default is on (rule one) as written
above. This is a property of the test set-up, not of the product.

## Which refusals count (rule "many refused actions")

Decided by one function, `countsTowardAnomaly(reason)`: the reason alone decides. A reason that is not on the counted list is
**not** counted, so a refusal reason added later cannot start locking cards by accident; a unit test reads every
refusal reason out of the source code and fails if one is not classified.

| Counted (the card asked for something it has no right to) | Not counted |
|---|---|
| `DENY_DEFAULT` (no role grants the action), `DENY_SCOPE`, `DENY_SENSITIVITY`, `DENY_RANK`, `DENY_SELF_ACTION`, `DENY_LAST_OWNER`, `DENY_COMPANY_CARD`, `DENY_PLATFORM_ONLY`, `DENY_TENANT_MISMATCH`, `DENY_UNVERIFIED`, `DENY_FILTER_NOT_SUPPORTED` | the card's own restrictions and phase: `DENY_CARD_HOURS`, `DENY_CARD_NETWORK`, `DENY_CARD_LIMIT`, `DENY_CARD_READ_ONLY`, `DENY_CARD_RESTRICTION_INVALID`, `DENY_CARD_EXPIRED`, `DENY_CARD_STATE`, `DENY_CARD_LOCKED`, `DENY_GRACE_READ_ONLY`; the company's phase: `DENY_TENANT_EXPIRED`, `DENY_TENANT_GRACE_READ_ONLY`, `DENY_TENANT_INACTIVE`; `DENY_PLAN_LIMIT`; faults of ours: `DENY_PDP_ERROR`, `DENY_UNKNOWN_ACTION`, `DENY_UNKNOWN_OBLIGATION`, `DENY_LIST_FILTER_UNDECLARED`; `DENY_RESOURCE_NOT_FOUND`; `DENY_UNAUTHENTICATED` |

Why the right-hand side: the screens keep asking while a card is outside its hours, over its limit, read-only or in
its grace period, and the card works again by itself when that ends. A lock would not: it needs an admin and a new
secret code. Before this rule, about twenty refused screen loads after closing time would have locked the card.

Also not counted: `DENY_SELF_REVIEW` (verifying one's own work - the screens offer the button to every reviewer and
expect this refusal, so an honest reviewer working through their own items would meet it) and `DENY_FETCH_SITE`
(next paragraph).

**The browser's word on where a request came from.** Browsers state it in the `Sec-Fetch-Site` header, and page
scripts cannot set or change that header. A signed-in request marked `cross-site` or `same-site` that does not name
an allowed `Origin` is **refused before the policy is asked** (reason `DENY_FETCH_SITE`, recorded in the audit log,
answered with the ordinary "not allowed"). So a page on a sibling address of the same site cannot make a signed-in
visitor's browser act with the card, and cannot make it collect refusals that would lock that visitor's card (GET
needs no CSRF token, which is why this rule exists). A separately hosted front end listed in `ALLOWED_ORIGINS`
names its `Origin` and is served as before. `same-origin`, `none` (a typed address or bookmark) and no header at all
(a script, a tool) go on to the policy as before, and whatever reaches the policy is counted by its reason alone.

Said plainly: **somebody who holds a stolen session and forges that header is refused outright; somebody who leaves
it out is counted.** No header value switches the counting off. For anything but GET, the CSRF check already
demands an allowed `Origin` and runs first, so no existing answer changes there. What this does not cover: a browser
too old to send the header behaves as "no header" (served and counted as before).

## What must not break

- **Counting never costs the refusal.** The counter runs inside a savepoint: if it fails, it alone is undone, the
  failure is logged, the refusal is still written to the audit log and the caller still gets "not allowed".
- **People are told after the fact is committed.** Notices of a lock are queued and sent once the request's
  transaction has committed (`RequestContext.afterCommit`); a failure to send never changes the answer.
- **One lock order.** The company's roles lock is taken before the card's counter row, everywhere. (The sign-in
  path of rule two holds the card's sign-in state before it takes the roles lock; a simultaneous refused request
  of the same card at its threshold could collide with it. The database then ends one of the two; the refusal
  side is inside the savepoint. Rule two is off by default.)
- **One lock.** The secret-code lockout and the anomaly rules call the same function (`CardService.lock`).
- **One definition of "another usable Owner card"** (`otherUsableOwners`: a person's card that is active, in date
  and not locked), used by the anomaly rule and by suspend, revoke, replace, role removal and offboarding. Before,
  those five counted a locked Owner card as usable.
- **The secret-code lockout still locks the last Owner** (Phase 1, unchanged, on purpose): it is the protection
  against trying every secret code, and an exception for the last Owner would give that protection up for exactly
  the most powerful card. Recovery is the operator's (`docs/runbooks/owner-recovery.md`). The anomaly rules are
  different: they are guesses about behaviour, so they never lock the last usable Owner.

## What is recorded when settings change, and when a card is unlocked

- One audit row per changed setting, with the old and the new value (`changed`, `state_from`, `state_to`), so that
  "the lock was switched off" can be told apart from any other edit.
- The audit row of an unlock says why the card was locked (`reason`: `anomaly` or `sc_attempts`).
- An anomaly event shown by `GET /v1/anomalies` says what happened to the card **at that moment**
  (`locked` / `not_locked_last_owner`), carries the masked card number, and shows a stored rule this version does
  not know as `unknown` - never as a rule it is not.
