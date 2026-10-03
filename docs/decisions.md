# Decision log

Choices that would take more than about an hour to reverse. Three lines each. Evidence for versions is in `docs/DEPENDENCIES.md`. 

| # | Date | Status |
|---|---|---|
| D1–D12 | 2026-10-02 | **ACCEPTED** at Gate 1 (founder replied "approved"; all recommendations in `08-open-decisions.md` accepted) |
| D13–D17 | 2026-10-02 | Made during the build; listed in `REPORT.md` under Deviations for the founder to confirm |
| D18 | 2026-10-03 | Founder decision during verification |
| D19–D21 | 2026-10-03 | Phase 1.1: two founder decisions (D19, D20) and how they were built (D21) |
| D22 | 2026-10-03 | Phase 2 Gate 1 approval |

**D1 — Fastify 5, not NestJS.**
CONTEXT: NestJS 12 is 5 weeks old and no official LTS statement was found; rejected NestJS 11 (labelled `legacy` on npm) and NestJS 12.
CONSEQUENCES: module boundaries enforced by our own CI rule; one Fastify 6 upgrade expected in 2027.

**D2 — 60-day maturity rule for major versions.**
CONTEXT: alternative was "always latest". Rejected: a solo founder cannot debug a fresh ecosystem.
CONSEQUENCES: TypeScript 6.0, vitest 4, SimpleWebAuthn 13, Google provider 7; scheduled re-check each phase.

**D3 — No ORM; hand-written parameterised SQL with the `pg` driver.**
CONTEXT: rejected Prisma/Drizzle/TypeORM — row-level security, grants and triggers must be explicit.
CONSEQUENCES: more SQL to write and test; nothing hidden between the code and the database.

**D4 — dbmate for migrations.**
CONTEXT: rejected node-pg-migrate (JS-first), graphile-migrate (no down migrations), Flyway/Atlas (heavier).
CONSEQUENCES: plain SQL up/down files usable by both services; a small binary in CI and Docker.

**D5 — `openapi.yaml` drives runtime validation and generated types.**
CONTEXT: rejected generating the contract from code (the code would be the source of truth, not the file).
CONSEQUENCES: the contract must be written by hand first; drift is impossible rather than merely detected.

**D6 — Damm check digit; Luhn-valid numbers are regenerated.**
CONTEXT: rejected Luhn (misses 09↔90, looks like a payment card) and Verhoeff (same strength, more tables).
CONSEQUENCES: issued card numbers can never change algorithm without re-issuing cards.

**D7 — Strong factor is verified before the SC counts toward lockout; all factors in one request.**
CONTEXT: rejected SC-first (anyone could lock anyone out) and two-step verify (leaks which step failed).
CONSEQUENCES: TOTP-only users can be temporarily throttled by a stranger; passkey users cannot.

**D8 — Global `card_directory` reachable only through `SECURITY DEFINER` functions.**
CONTEXT: login must find the tenant before row-level security can apply; rejected a table readable by the app role.
CONSEQUENCES: two privileged functions to keep narrow and audited.

**D9 — Audit hash chain computed by a database trigger, verified independently in TypeScript.**
CONTEXT: rejected app-computed hashes (forkable under concurrency, forgeable by the app).
CONSEQUENCES: the hash encoding is a frozen format; changing it needs a versioned chain.

**D10 — Sessions: opaque token containing the tenant id, stored only as a SHA-256 hash.**
CONTEXT: rejected JWTs (cannot be revoked instantly) and a global sessions table (no row-level security).
CONSEQUENCES: every request costs one database read; revocation is immediate.

**D11 — Platform operator = a card in a special platform tenant.**
CONTEXT: rejected a static admin API key (bypasses the strong-factor rule). Open decision 2.
CONSEQUENCES: one bootstrap CLI; operators use the normal login path.

**D12 — Repository visibility: private, local only.**
CONTEXT: no remote exists; nothing is pushed by Claude.
CONSEQUENCES: before any future publication — secrets scan, full-history scan, and review of commit messages.

**D13 — Built-in fallback migration runner.**
CONTEXT: Windows on the founder's machine started refusing to execute the downloaded `dbmate.exe` (EPERM) mid-build. Rejected: disabling or working around the operating system's protection.
CONSEQUENCES: `scripts/db-setup.mjs` applies the same dbmate-format files itself when dbmate cannot run; CI runs both and compares schemas.

**D14 — Three database roles, not four; tenant list by a read-only policy, not a definer function.**
CONTEXT: with row-level security FORCED on every table, a `SECURITY DEFINER` function owned by the table owner is filtered as well, so it could not list tenants.
CONSEQUENCES: `legacyai_owner` merged into `legacyai_migrator`; one extra, SELECT-only policy on `tenants`.

**D15 — `auth_transactions` is a global table.**
CONTEXT: a tenant-scoped login-transaction table would put the tenant id into the token and reveal whether a card number exists.
CONSEQUENCES: one more global table (9); it holds only hashes, challenges and expiry times.

**D16 — CSRF token derived from the session token (HMAC), not stored.**
CONTEXT: only a hash of the session token is stored, so a stored CSRF token could not be handed back on a later request.
CONSEQUENCES: after a session rotation the client must re-read `/v1/auth/session`.

**D17 — Unknown-card and unauthenticated requests are not written to the audit chain.**
CONTEXT: they have no actor and no tenant, and anyone on the internet can generate them without limit; an append-only table on a 0.5 GB free database would be a denial-of-service target.
CONSEQUENCES: failed logins for unknown cards go to `login_attempts` (purgeable) and the application log; every decision made for an authenticated card, and every failed login against a real card, is in the audit chain.

**D18 — Repository pushed to GitHub while public (supersedes D12).**
CONTEXT: the founder's computer cannot run Docker, so the database tests run on GitHub Actions. The repository was public when it was time to push; the founder chose "keep it public and push anyway" and will make it private later. Rejected: waiting, or running the tests nowhere.
CONSEQUENCES: the design, the code and the commit author's email address are public until the repository is made private. A full-history secret scan ran before the push and runs in CI on every push.

**D19 — Company-card renewal is for the platform operator only (founder decision).**
CONTEXT: an Owner could renew their own company card, i.e. extend their own subscription clock. Rejected: leaving it until billing exists.
CONSEQUENCES: `card:renew` is refused for company cards inside a tenant; a new platform-only action renews it; until billing (Phase 4) every renewal is manual work for the operator.

**D20 — Owners cannot renew, unlock, replace or re-enrol another Owner (founder decision).**
CONTEXT: each of those hands the actor a way into the target card. Rejected: keeping Owner-to-Owner management. The founder named renew/replace/enroll; **unlock** was included because it also hands over the target's new SC, and — after an independent review showed two-step routes — so were **role changes on a peer** and **issuing a card to a person who held the actor's rank or higher**. Suspend and revoke between Owners stay allowed (defence against a compromised Owner).
CONSEQUENCES: a locked-out Owner needs the platform operator (`docs/runbooks/owner-recovery.md`); a returning former Owner needs a new person record or the operator; a locked-out operator uses a break-glass command line tool (`platform:recover-operator`).

**D21 — Operator actions on a customer tenant run in the operator's own transaction, switched to the customer tenant for a moment.**
CONTEXT: tenant creation used two transactions, so a failure could leave a half-created tenant. Rejected: a compensating "clean-up" step (can itself fail) and a `SECURITY DEFINER` function (filtered by forced row-level security, see D14).
CONSEQUENCES: `Database.withinTenant` exists, works only in a transaction of the operator tenant, and must stay narrow (three callers); row-level security still checks every statement while switched.

**D22 — Phase 2 design approved at Gate 1 (founder decision, 2026-10-03).**
CONTEXT: the founder replied "approved" to the 11 documents in `docs/phase2/`, accepting all eight recommendations in `11-open-decisions.md` (two-model evaluation at Gate 2; local embeddings; no self-verification; learners see verified knowledge only; consent rules subject to legal review; AI service reachable with identity check; caps $5 / $1 / $20; free-database storage rules).
CONSEQUENCES: Phase 2 is built to that design; no paid AI call before Gate 2.

**D23 — A route that reads a whole collection must declare how the list is narrowed; otherwise a narrower grant is refused (2026-10-03).**
CONTEXT: the policy allows listing to any holder of a read permission and, when the holder's grant is narrower than the company (own records, one department), attaches a `filter` obligation. Nothing checked that a route honoured it; `GET /v1/consents` did not, so an Expert or Successor could list every person's consent records (found by the Phase 3b browser tests, fixed in `397e817`). Rejected: relying on review to spot the next one.
CONSEQUENCES: each such route declares `listFilter`: `applied` (its own query uses `authorizer.filter`), `delegated` (the filter travels in the service token and the AI service applies it) or `unfiltered` with a written reason. The HTTP layer refuses, and records the refusal, when the policy asks for a filter and the route does not provide one, and when a `GET` list route declares nothing. A company-wide list therefore REFUSES a card with a narrower grant instead of showing it everything: today that is the redaction allow-list for a Department Manager (role not enabled by default). `delegated` rests on the AI service applying the filter it is sent, which its own leakage tests cover; the API cannot check it. The declarations are pinned by a test.

**D24 — Five operations added so the screens need nothing but the API; which existing permission each uses (2026-10-03).**
CONTEXT: Phase 3b showed that the readiness test could not be used through the screens: an item could be linked to a topic only by vector similarity or directly in the database, job roles could not be listed or read back, and there was no list of tests taken. No permission and no grant was added or changed; no migration was needed (the tables and their tenant-bound foreign keys existed).
CONSEQUENCES:
- `PUT /v1/knowledge/items/{id}/topics` (`setItemTopics`) uses `knowledge:label` on THAT item: the design gives the manual link to a reviewer ("a reviewer can add or remove a link, and manual links win", `docs/phase2/05` §"Linking items to topics") and `knowledge:label` is the reviewer's right over an item's labels. Rejected: `topic:manage` (Owner and Admin only; they are not the reviewers) and letting the author do it (an author would decide their own coverage). The list replaces the item's links to the topics the caller may read; a link to a topic the caller cannot read is neither shown nor removed; a topic the caller cannot read is answered like one that does not exist (422). The item's status does not change: a topic link is a label, not content, and the design asks for re-review only when the text changes. ENFORCED in the policy decision point (`changes_released_knowledge`, the same guard as verifying): on an item that is verified, corrected or stale, neither its contributor nor the author of its current version may change its topics (refused `DENY_SELF_REVIEW`, written to the audit log), unless the company has switched the second-reviewer rule off; while the item is a candidate or in review its author may sort it into topics, as with other labels. ASSUMPTION (not enforced): one second person is enough - a reviewer who is neither contributor nor author can change the topics of a released item alone, with no further approval. The topics shown on an item and the topics that may be linked are narrowed by the caller's `topic:read` filter, sent in the service token as its own claim (`topic_filter`); the right to read knowledge is not used for topics, and the "verified only" rule does not apply to topics. The audit log records each link added or removed (item id and topic id, action `knowledge:label`).
- `GET /v1/job-roles` and `GET /v1/job-roles/{role}/topics` use `topic:read` ("read topics and role topic maps") and are filtered like the topic list: a job role exists for a caller only through topics that caller may read. A job role with people but no topics is therefore not listed; it is typed by name.
- `GET /v1/job-roles/{role}/people` uses `gap:read`: who holds a job role and who follows is part of the gap picture, and the same roles hold both. It is filtered by the person's department for a department-wide grant. Rejected: `topic:manage` (a write permission used for a read) and `topic:read` (every Expert and Successor would see who is lined up to replace whom).
- `GET /v1/readiness/attempts` uses `quiz:read_results`, filtered: a Successor's grant is "own", so it sees its own tests; Owner and Admin see the company's. It returns labels and times only.
- `GET /v1/expert-questions` and `GET /v1/me/consents` accept `limit` and `cursor` like the other lists.
- NOT done: the scope of each permission in the session (the menu still uses "may read company settings" as the stand-in for consent administration).
