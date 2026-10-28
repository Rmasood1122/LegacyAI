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
- One rule for the three writes that replace a list (`setItemTopics`, `setRoleTopics`, `setRolePeople`): the list is the wanted set AMONG WHAT THE CALLER CAN SEE (topics it may read that are not retired; people its gap report covers). What it cannot see keeps its place - neither shown, nor removed, nor nameable - and an id in the body that is unknown, unreadable or retired answers 422 in all three (before, `setRoleTopics` answered 404 and removed every row of the role). What a read returns can be written back unchanged; for an item, a link that stays keeps how it was made (`link_source`, score) and only a new link becomes a reviewer link.
- Retired topics are left out of an item's topics, of a job role's topics and of the job-role count alike, and no write touches a link to one.
- A job role's name follows one rule wherever it is accepted (address, query, body): 1-120 characters, no space at either end, no control characters, no slash (`JobRoleName` in the contract). Names stored before the rule are still listed; the name cursor of the job-role list accepts them.
- `knowledge:label` on a knowledge item is refused (`DENY_PDP_ERROR`) unless the route says whether the change releases the item to learners or changes released knowledge, so a new label route cannot slip past the second-person rule by forgetting to say so.
- NOT done: the scope of each permission in the session (the menu still uses "may read company settings" as the stand-in for consent administration).

**D25 — The contradiction check and the quality monitor reuse existing permissions; no permission or grant is added (2026-10-04).**
CONTEXT: features 23 and 22 add five operations (`docs/phase4/01-contradiction-staleness-quality.md`). The check in code that refuses an answer when its sources disagree needs no permission of its own: it runs inside `askKnowledge`.
CONSEQUENCES:
- `PUT`, `GET` and `DELETE /v1/knowledge/answers/{knowledge_answer_id}/feedback` use `knowledge:ask`: whoever may ask may say what they think of the answer they got, read it back and take it back. The AI service accepts this only from the card the answer was given to; for any other answer the reply is "not found".
- `GET /v1/quality/summary` and `GET /v1/quality/feedback` use `knowledge_settings:read`, held by Owner and Admin at company scope only. Both are declared unfiltered (D23), each with its own reason: the summary is counts; **the feedback list is content** - opinions and comments of readers of every department, and the questions readers chose to share. **Whoever is granted `knowledge_settings:read` can read all of it: widening that permission to another role widens this list with it.** A role that should set knowledge rules but not read readers' feedback would need a separate permission, which does not exist yet.
- A reader's question is not shown to anyone by default. Before this feature nobody could read the answer log's question text; that stays so unless the reader sets `share_question` on their feedback. Rejected: showing the redacted question with every feedback (it would have made questions readable by Owner and Admin for the first time, without the reader's say).
- Conflicts between verified items and stale items appear as review tasks, so they use the review queue's existing permissions. The conflict note on an item is part of `getKnowledgeItem`; if the reader may not read the other item it is one entry that says a conflict with a restricted item exists and nothing else. That a conflict exists is shown on purpose (the reader must not rely on the item); it remains a yes/no signal about the restricted item for someone who can get items verified on a shared topic.
- A comment a reader writes is redacted before storage and is deleted with its answer-log row (the company's retention setting).
- ASSUMPTION: a card that received an answer may always give feedback on it, even after losing the right to read one of its sources; the feedback shows the reader nothing new.
- NOT done: a real-model evaluation of the check (needs a paid run the founder has not asked for); a notice to anyone when two DOCUMENTS (not items) disagree - such refusals are only counted on the quality page.

**D26 — Anomaly lock, retirement radar and department templates reuse existing permissions; the anomaly rules, their defaults and who is never locked (2026-10-04).**
CONTEXT: features 5, 11 and 26 add nine operations (`docs/phase4/02-anomaly-radar-templates.md`). No permission or grant is added.
CONSEQUENCES:
- Anomaly settings use `tenant_settings:read` / `tenant_settings:update` (they are company settings). The list of recent anomaly events uses `card_events:read` and is filtered like the card list, so a card with an "own" grant sees only events of its own cards.
- An anomaly lock IS the existing card lock (`lock_reason = 'anomaly'`, allowed since the first identity migration) and is undone with the existing `unlockCard`, which issues a new secret code. Rejected: a second kind of lock with its own unlock (two ways to be locked out, two things to test).
- Rule "many refused actions" counts only route-level refusals of requests that carried a live session of the card, only for reasons on an explicit list (no right, out of scope, above the card's level, rank and self-action guards, a whole list asked for by a card that may see part). A reason not on the list is not counted; verifying one's own work is not counted, because the screens offer that button and expect the refusal. A signed-in request that a page of another address made the browser send (`Sec-Fetch-Site` `cross-site` or `same-site` without an allowed `Origin`) is refused before the policy is asked, so it can neither act nor collect refusals against the card; no header value switches the counting off. Rejected: merely not counting such requests (a thief with a stolen session could forge the header and probe uncounted). Rejected: counting failed sign-ins or audit rows by card number (anyone who knows a card number could then lock that card); counting every refusal (a card outside its hours, over its limit or in its grace period would be locked by ordinary use, and a lock needs an admin where the restriction ends by itself); counting "not found" (old links are ordinary use).
- Rule "sign-in from a second network address" is OFF by default. It compares addresses, not places; two devices on two networks are normal. Rejected: on by default (it would lock people who do nothing wrong); geography from addresses (needs an outside data source, and is wrong often).
- "Use outside set hours" is not an anomaly rule: the Phase 1 time-window restriction already refuses such requests, and those refusals are NOT counted (see above).
- "Off" is a switch per rule plus a master switch; numbers are always usable values. Rejected: 0 = off for one rule and a minimum of 5 for the other.
- Counting a refusal never fails the refusal (savepoint); notices go out after the commit.
- The last usable Owner card (no other Owner card that is active, in date and not locked - ONE definition, also used by suspend, revoke, replace, role removal and offboarding, which before counted a locked Owner as usable) is never locked by a rule; the event is recorded and notified instead. The secret-code lockout is unchanged and DOES lock the last Owner: it is the brute-force protection (Phase 1), recovery is the operator's. An Owner locked while another Owner exists is recovered by the platform operator, as after wrong codes (Owners do not manage each other).
- A leaving date is read with `person:read` (so a person reads their own; Owner, Admin and Auditor read the company's; a Department Manager their department's) and changed with `person:update` (Owner, Admin; not on yourself, not on somebody who outranks you). The audit log never holds the date. This is wider than "people managers and the person" by the Auditor and the Department Manager, both of whom may already read those people.
- The radar reports counts (verified items contributed, interviews completed) and the person's job roles; which topics are uncaptured stays in the gap report, because the API does not read knowledge content (`docs/phase2/02-data-model.md`). The identity module reads no knowledge table for this: the knowledge module answers through a port, narrowed by the asking card's `gap:read`, `knowledge:read` and `interview:read`; without the right the field is null, not zero. Rejected: counting in the identity module by SQL (it bypassed the module boundary and showed an Auditor counts of knowledge it may not read).
- A leaving date is removed when the person is marked as departed and 30 days after it has passed. Rejected: keeping it until the person is deleted (no code deletes a person).
- The command that records expiry, creates nudges and removes old rows is called `housekeeping`; nothing schedules it yet (`docs/runbooks/housekeeping.md`). Rejected for now: adding a scheduled job to Terraform in the same change (its checks cannot be run on the developer's computer).
- Department templates use `topic:manage` for both looking and applying. Applying creates topics company-wide at the lowest sensitivity through the same statements as `createTopic` and `setRoleTopics`; it never changes or revives an existing topic or map entry.
- In the test app the anomaly rules start switched off (many tests collect refusals on purpose); each anomaly test switches them on for its company. Production default: rule one on, rule two off.
- ASSUMPTION: 20 refusals in 10 minutes is rare in honest use. It was chosen, not measured; no real usage data exists.
- NOT done: e-mail for nudges and lock notices (Batch B); a screen that shows a person their own leaving date; scheduling the nudge sweep in Terraform (it runs inside the existing housekeeping job); validation of the templates by an industry expert.

**D27 — QR cards, activity numbers and the knowledge map reuse existing permissions; taking the map out is an export; scenario replay is not built yet (2026-10-04).**
- A card's QR code holds the address of the sign-in screen with the CARD NUMBER in the fragment (`/#card=LGY-…`) and nothing else. The fragment is not sent to the server; it is read once and removed from the address bar - by the sign-in screen, or by the application's frame when the visitor is already signed in. A card number alone signs nobody in. "Print this card" prints the card only.
- Activity numbers (`GET /v1/analytics/activity`) use `knowledge_settings:read`, the permission of the quality numbers (Owner and Admin, company scope). The route is declared unfiltered (D23) because the table has no department or owner to narrow by under that permission. INSIDE the answer every number is narrowed by the right that governs what it counts: documents and items by `knowledge:read`, interviews by `interview:read` (an interview has the level of what it captured), tests by `quiz:read_results`. A number the card has no right to at all is `null`, never a company total.
- The filters for that travel in one new claim of the service token, `filters`, mapping a permission to the filter the policy built for it. The AI service uses a filter only for the permission it was built for. `filter` (knowledge:read) and `topic_filter` (topic:read) stay as they are. Rejected for now: folding those two into `filters` as well - it would touch every existing route and test for no gain today. Widening `knowledge_settings:read` to more roles widens who gets this table; what each of them sees in it still follows their own rights.
- Test results per job role: only for a caller holding `quiz:read_results` at company scope; one fixed window (the 12 complete calendar months before the current one) independent of `months`, so two requests cannot be subtracted; a role is shown only with at least 5 different people (`MIN_GROUP`; ASSUMPTION: a common minimum, chosen not derived); the mean is rounded to one decimal; each row carries a `state` (shown / too_few_people / no_graded_answers). NOT prevented, and accepted for the current holders who may read every single result anyway: comparing the table before and after one more graded test.
- Questions and answers are not counted again here; the screen links to the quality numbers (D25). Card and people counts come from the existing `getTenantUsage`.
- The knowledge map's neighbourhood (`GET /v1/knowledge/graph`) uses `knowledge:read` and is declared delegated (D23): the caller's `knowledge:read` filter (items; documents exactly as an item's provenance is read elsewhere) and its `topic:read` filter go in the token. One definition of "an item the caller may see" is used by every query. An unreadable node answers 404 like a missing one; hidden and absent neighbours are not told apart.
- **Taking the whole map out is an export** (`POST /v1/knowledge/graph/export`): it needs `export:create` (Company Owner), stays narrowed by the caller's filters, writes its own audit entry (`knowledge:graph_export`, counts only), is limited to 5 an hour per card, and is capped (2000 nodes per kind, 10000 links). So learners, experts and admins can browse the map and cannot take it out. Rejected: leaving it a plain read under `knowledge:read` - any reader could then copy everything it may read in one call, with nothing in the audit log to tell looking from taking. Rejected for now: making it a job of `POST /v1/exports` - that export is built by the API from API-owned tables, the map is read by the AI service.
- The activity CSV is made in the browser from the numbers already on the screen and is a deliberate exception: counts only, no export job, and the audit log shows the read, not the save.
- People are NOT nodes. Rejected: contributor nodes and person - job role links - a map would make it easy to list everything one person wrote or who holds which role, which the existing screens show only to people managers.
- Links are only those already recorded (item - topic, item - document it quotes, job role - topic, item - item conflict). Nothing is inferred. Every end of a link is named by kind AND id, because an id is unique within its kind only.
- The export is plain JSON with a named, versioned shape (`legacyai-knowledge-graph/1`). Rejected for now: JSON-LD or GraphML (no consumer asks for them; the shape is simple enough to convert).
- NOT done: scenario replay (feature 8); activity numbers in the company export; a pass mark; paging of a map group beyond 50 neighbours (each group says `truncated`).

**D28 — Scenario replay reuses the readiness permissions; the second-person rule moves into the policy and now also covers readiness questions (2026-10-04).**
- No permission and no role grant was added. Writing, editing, approving, retiring and asking for proposed points use `quiz:manage`; the writers' list and one scenario with its expected points use `quiz:read` (learners do not hold it); seeing what is offered, starting, answering and handing in use `quiz:take`; reading a run and the list of runs use `quiz:read_results` (a Successor's is "own"); overriding a step's score uses `quiz:grade`.
- Five new tables owned by the AI service, not a new kind inside the quiz tables. Rejected: reusing `quiz_items` / `quiz_attempts` - a quiz item belongs to one knowledge item and one topic; bending them would have touched the guards and every readiness test. What the two share (grading by rubric, opening and closing the grading task, the "needs a person" rule) is now one set of functions in `readiness.py` used by both. NOT shared yet: saving an answer, handing in and the override body are still written twice (same shape, different tables).
- The API login may read labels and links only, never a scenario's text, a rubric or an answer. It checks the linked items against THE CALLER and vouches for the result in the service token.
- **Second person: neither the creator of a scenario nor its last editor may approve it.** Decided by the policy decision point (the route names the writers in `not_by`; refusal `DENY_SELF_REVIEW`, 403, audited), checked again by the AI service and a database guard (person and card), all honouring `second_reviewer_required`. First version of this decision had it only in the AI service and the database (a 409 that the audit did not record as a denial); the design review asked for one place.
- **The same rule now applies to approving a readiness test question** (who generated it, who last edited it). Phase 2 had none: the person who generated a question could approve it. Recorded by four new nullable columns on `quiz_items`; older questions name nobody. Enforced in the policy only (no database guard for questions).
- A reviewer cannot override a step of their own run (409 `own-attempt`). Readiness has no such check; not changed here.
- **What a learner sees of a run:** own answers always; scores only when graded; points and "read these" only when graded AND the company shows answers after grading. Expired and waiting runs show nothing more. Same rule as readiness (the first version released points for every state but "in progress").
- **A scenario follows its items:** not verified any more, or re-labelled -> the scenario takes the items' labels, returns to draft, flagged; runs in progress end. A reader who may not read every linked item gets neither the scenario nor a run of it (the API refuses the run with 403).
- **Withdrawal and legal hold:** the trigger only hides (retired, flagged, returned to nobody); the words are blanked by the erasure step, which does not run under a legal hold ("a hold suspends erasure", docs/phase2/05). **This is the opposite of D25 (conflict excerpts are deleted at withdrawal even under a hold). Both are readings, not legal opinions: D25 needs the same founder or legal decision.** D25's behaviour was not changed.
- **Retention:** `quiz_answer_retention_days` is now applied by the housekeeping sweep to scenario answers and to readiness answers (free text and the model's per-point result removed; scores kept). Phase 2 had the setting and no job.
- A step without a usable or confident AI grade opens a `grading_override` task, as readiness does. NOT solved: a reviewer who holds `quiz:grade` but not `quiz:read_results` cannot open the run (same in readiness).
- At most 3 runs per learner and scenario per day (a constant). Saving and approving carry the version read (`updated_at`); a stale one is refused (409 `changed-meanwhile`).
- NOT done: review tasks for a scenario awaiting approval or flagged; deletion of a leaver's runs; branching scenarios; anything but text; a copy-as-new action; any measurement of grading quality with a real model.

- Added in the last round: (1) the API decides for itself what of a run it passes on (scores only for a graded run the AI service marked as released; the readiness mapper got the same rule); (2) the two approving operations must be registered through `approvalRoute()` and the policy refuses an approval that names no writers, so the second-person rule cannot be left out by omission; test questions got a second check in the AI service; (3) "hidden" is computed from the links (`scenario_is_hidden()`), not read from `erased_at`; (4) the retention sweep takes only rows that still hold text, oldest first, and never a step that waits for a person; no new database grant was needed; (5) one more operation, `getScenarioAnswer` (`quiz:grade`): a grader reads the one step it grades, and the override is refused where that read would be - nobody grades blind. The readiness override is unchanged and still blind (known limit).

**D29 — Billing: the company card stays the subscription clock; a payment is believed only from a signed message; the provider is a stand-in (2026-10-04).**
- Rests on Phase 1: the company card is the company's subscription clock (open decision 1, feature map rows 32 and 34), the policy decision point already asks billing (`DENY_PLAN_LIMIT`, row 35), and D19 (only the operator renews the company card "until billing"). Billing is now the second caller of that same renewal. No second clock was added: `subscriptions` holds seats and the auto-renew switch only, never a date.
- The billing module may not import identity (dependency rule). It declares a small port (`CompanyTermPort`: read the term, renew it); identity implements it; `app.ts` connects them.
- **A term is renewed only when the provider's signed message says the invoice was paid, or the operator records a payment.** Never because the Owner clicked, and never from the browser. The invoice's change of state is the exactly-once guard; a trigger refuses every other change.
- Protections of the public endpoint: HMAC-SHA256 over named fields, constant-time compare, strict field patterns, 5-minute window, message id stored once per company, amount and currency must equal the invoice's, paid is final, per-address rate limit, one uniform refusal. The signature travels in the body because public routes do not see headers or raw bytes; a real provider needs that changed (not done).
- Money is whole minor units plus a currency. Nothing that looks like a payment card number is stored: no such field exists, and the operator's free-text reference is refused when it contains 12 or more digits in a row.
- Seats count person cards that are not revoked or replaced. **Revised the same day (review):** the limit that is enforced is the number of seats PAID for in the running term, not what the Owner typed. Fewer seats count from the next renewal; more seats need a paid "seats" invoice first (full price per seat, no proration, no refund). The Owner cannot remove the limit; only the operator can. A company with no subscription row has no limit (existing companies and tests are unchanged). Rejected: a default seat number for existing companies - it would refuse card issuing in companies nobody sold seats to.
- The Owner can renew only from the day renewal opens, because the existing renewal starts the new term at "now". Rejected: extending from the old end date - that changes the Phase 1 card rule and its tests; it is the founder's call.
- **An Owner may read billing and pay while the COMPANY is read-only or lapsed.** Without it a lapsed company could only come back through the operator. Revised (review): the exemption applies only when it is the company's term that ran out. An Owner whose own card expired, or is suspended or locked, gets nothing from it.
- Three permissions: `billing:read`, `billing:manage` (Company Owner, company scope), `billing:operate` (platform only). Admins get none. `listInvoices` is declared unfiltered (D23): invoices have no department or owner.
- Reminders and automatic renewal run in the housekeeping sweep; nothing schedules it yet. Automatic renewal is off by default, tried from one day before the date, at most 3 times.
- The stand-in provider is refused in production. With no provider, paid renewals by the Owner are refused and the operator records payments.
- **Revised the same day (review), further:** (a) one invoice state table (`open -> paid | failed | void`, `failed | void -> paid_late`), the same in code and in the database trigger, with at most one unpaid invoice per company enforced by the database; (b) signed money is never dropped: a payment for a closed invoice, a repeated payment, a wrong amount, an unknown invoice or company is stored, flagged to the Owner and the operator, and applied only by the operator; (c) the provider is called outside any database transaction, after the invoice is stored, with a 10-second limit; (d) with no provider connected the public endpoint refuses everything, and the placeholder event key is refused in production; (e) the operator's manual payment names an invoice and its amount, is refused on a mismatch, settles an invoice once, and needs an explicit yes to throw away days of a running term; (f) a plan-limit refusal on issuing a card answers 409 `seat-limit-reached` instead of a bare 403 - the limit is the policy's last check, so it reveals nothing the caller may not know; (g) the housekeeping run handles each company and each step separately, prints failures and ends with a failure code.
- **Revised after the second security read:** (a) while a renewal invoice waits to be paid, no person card is issued beyond its seats (first term included), and when the payment arrives the cards in use are counted again - more cards than paid seats and the payment is kept, reported (`PAYMENT_NOT_APPLIED_MORE_CARDS_THAN_SEATS`) and not put into effect by itself; "cards in use" is one number everywhere (`CompanyTerm.personCards`). (b) A recorded payment is never left without a trace: the audit row `PAYMENT_RECEIVED` is written with the payment; a paid invoice that neither took effect (`applied_at`) nor was reported (`attention_at`) is finished by a redelivered message or by the housekeeping sweep, once. (c) The stand-in provider starts only with `NODE_ENV=test`. (d) A public route receives only the request headers it declares; cookies, `Authorization` and the CSRF token can never be declared.
- Known and accepted: a real provider must de-duplicate charge intents by invoice id (a timed-out start is retried without a stored reference); an individually expired Owner card is let through to billing when the company is in the same or a worse phase; `subscriptions` rows have no database guard; nothing schedules housekeeping, so invoice expiry, reminders, automatic renewal and the finishing sweep run only when the command is run.
- Rejected (review suggestion): moving the Owner's paths under `/v1/tenants/current/billing`. Kept `/v1/billing/...` as a documented exception.
- NOT done: a real provider (the HTTP layer still does not keep a request's raw bytes, which real providers sign); taxes; refunds; proration; changing plan; e-mail; invoice documents; aligning person cards to the company date.
- **For the founder to confirm:** the plans and prices (placeholders now); the currency; the term length; whether days left should carry over; whether Admins should see billing; the reminder days and the number of attempts; which provider, and when; whether a new company should have a seat limit from its first day (now: none until its first paid renewal); whether added seats should cost the full term price (now: yes, no proration); how money for a closed invoice is returned (now: outside the system, by the operator); after how many days an unanswered invoice is closed (now: 3 automatic, 14 started by the Owner).

**D30 — API keys: a key is its own kind of caller, reads and asks only, never holds more than its maker, and ends with its maker's sign-in (2026-10-05).**
- Details: `docs/phase4/06-open-api-webhooks-email.md`. Feature 28, part A. Webhooks and e-mail are not built yet.
- A key is a separate kind of subject (`kind: 'api_key'`), not a card with a mark: no roles, no session, no person. Code that means "a card" takes a card only, so the compiler refuses a key there. First built as an attribute on the card subject; two design reviews and a security read showed that made "forgot to look at the mark" mean "the maker's full rights", so it was changed.
- What a key may do = the maker's grants at the moment of the request ∩ the permissions written into the key ∩ a fixed short list (`knowledge:read`, `knowledge:ask`, `topic:read`, `gap:read`, `source:read`), and nothing above the key's level. One pure function (`grantsForKey`), used by the decision and by both filter builders.
- **Read and ask only.** `capture:upload` was taken off the list: a document added by a machine would have been recorded as attested by the Owner in person. Allowing uploads needs a rule that a person confirms what a machine added. Conservative default; the founder may change it.
- A key ends with its maker's sign-in: when the maker's 3-digit code is rotated, sign-in factors are reset, the holder removes one of their own sign-in factors, roles change, or the card is replaced, revoked, suspended or locked, the keys that card made are revoked in the same transaction, for good. Done by the one function that ends a card's sessions. Signing out and expiry do not revoke (the card's state gates the key on every request). The Owners are notified when a key is made and when keys are stopped.
- The maker's card restrictions and usage cap do not bind a key; a key has its own network list, 120 requests a minute, and its own number of questions per hour (default 30, at most 600). All keys and people still share the company's hourly AI allowance.
- Refusals by a caller who presented the RIGHT secret are counted against the key and suspend the key (the anomaly rule), never the maker's card. A failed attempt against an existing key is recorded once per key, reason and 15-minute window.
- **Wrong secrets never suspend a key (changed after the security read, 2026-10-05).** The key's id is not secret and a 256-bit secret cannot be guessed, so suspending on wrong secrets would only let an outsider who has seen the id break an integration. At the tenth wrong secret in a window the Owners get one notice per key and window and one audit row (`API_KEY_WRONG_SECRETS`); the key keeps working. No throttle per key id: it could not be told apart from the rightful machine.
- Removing one's own sign-in factor ends only the sessions opened with it, but ALL keys the card made: such a removal is what a holder does when a factor is lost, nothing records which session made a key, and the rule above is kept without an exception. Price: keys must be made again after tidying up a factor. A unit test scans the source for any statement that ends sessions outside the one function.
- Idempotency records name their actor as a card OR a key (two columns, own foreign keys, exactly one set); a key's records are separate from its maker's and from other keys'. The first build put the key's id into the card column, which the foreign key to cards would have refused on a real database - a test with a conditional hid it.
- The AI service checks for itself: a key's token is accepted for six internal operations only (`knowledge.candidates`, `knowledge.answer`, `item.list`, `item.read`, `graph.read`, `gap.report`) and never carries a person. A key that reads a document still being processed starts no work.
- Only the Company Owner makes, lists and revokes keys (`api_key:read`, `api_key:manage`). No operation that manages keys, cards, roles, settings, consent, billing or the audit log takes a key. Ten operations take one (`x-api-key: true`); a unit test pins the list against the short list of permissions.
- Audit: the acting card is the maker's card and every row names the key (`api_key_id`), also for failed requests and in the AI service. No new audit actor kind was added (the existing kinds were kept).
- The key is shown once; SHA-256 only is stored (32 random bytes, so no slow hash). Fields shown once are now declared per operation in the contract (`x-one-time-secrets`) instead of a list in the platform code.
- Answers for developers: 401 with `WWW-Authenticate: Bearer` for any key that does not work (one answer for every cause); 403 `api-key-not-accepted` on an operation that takes no key; 403 `api-key-scope` outside the key's scope; 429 with `Retry-After`. Server-to-server only (no CORS for `Authorization`).
- NOT done: uploads by key; resuming a key; OAuth or per-user tokens; a developer portal; keys in the company export; a real outside system using a key.
- **Confirmed by the founder on 2026-10-20 ("use recommendations"):** the recommended defaults stand - Owner only; keys do not add documents; keys may ask (limited per key); the limits (366 days, 50 keys, 120 a minute, 30/600 questions an hour); any change to the maker's card ends that person's keys.

**D31 — Webhooks from a database-written outbox, signed in the Standard Webhooks format, public https only; e-mail behind a port with no real service (2026-10-06).**
- Details: `docs/phase4/06-open-api-webhooks-email.md`, parts B and C. Feature 28 (parts B, C); features 11 and 33 get e-mail of their notices.
- **Events are written by a database trigger on `knowledge_items`, in the same transaction as the change.** Rejected: emitting events from route handlers - items change in the API, in the AI service, in a consent-withdrawal trigger and in housekeeping, and any path that forgot would silently lose events. The trigger runs as the table owner; neither service has a right on the outbox for it. The Phase 1 design-only tables `outbox_events` and `webhook_endpoints` were replaced (they were empty and unused); the rollback restores them exactly.
- Three events only: an item released, changed, or withdrawn. **Identifiers and labels only** in every message, never a title or text: a receiver that needs the content reads it with an API key, which has its own scope and level. An endpoint has a level; it is told about an item only if the item's label before or after the change is within it.
- Signature: the open Standard Webhooks format (HMAC-SHA256 over id, timestamp and body; `whsec_` secrets). Chosen over a format of our own so receivers can use existing libraries; checked against the specification's published example. The secret is stored encrypted with the credential keyring (it must be read again to sign), shown once, wiped on removal; a new secret replaces the old at once.
- **Server-side request forgery:** https and host names only at registration; at every delivery every resolved address must be public and the connection is pinned to the checked address; port 443 only; no redirects; 5 seconds for everything including the name lookup; the connection is closed when the status line arrives (revised after the security read: a receiver could otherwise trickle a body and hold the delivery job for every company). A narrower level or fewer events cancel waiting messages at once; one waiting test message per endpoint. Implemented with `node:net`'s BlockList - in two separate lists, because a test showed that BlockList counts every IPv4 address as inside the IPv4-mapped IPv6 range.
- Delivery: at least once; 8 attempts over about two days; an endpoint is paused after 15 failures in a row AND a day without success (one bad hour does not pause it); the Owners are told. Events that happen while an endpoint is off or paused are not delivered later (no backlog). Owner only (`webhook:read`, `webhook:manage`); no operation takes an API key. Default `WEBHOOK_DELIVERY=none`: nothing is sent.
- **E-mail:** the existing notifier is wrapped, not replaced - every notice is still logged; with a sender configured it is also queued. The queue keeps people's ids, never addresses; who receives what is decided when the message is sent, through a port the identity module implements (the mail module reads no card or role table). Fixed texts with no data in them. Only `none` (default, nothing queued) and `fake` (tests only) exist; no real e-mail service and no sending domain.
- Known and accepted: a notice from a request that is later rolled back is still queued (as it was always still logged); nothing schedules the delivery job; no real receiver, DNS or production egress was tested.
- **Confirmed by the founder on 2026-10-20 ("use recommendations"):** the recommended defaults stand - the three knowledge events; Owner only; the limits (10 endpoints, 8 attempts over about two days, pause after 15 failures and a day); no backlog for paused endpoints; no opt-out of notices; the recipient table and the wording as written; the delivery job runs every minute once it is scheduled (scheduling it is infrastructure the founder applies; not done here).
- **Still open:** which e-mail service and sending domain (no recommendation was made; e-mail cannot be switched on until this is chosen).

**D32 — Eight pillow advisories accepted by ID until a fixed pillow can be installed (2026-10-21, founder's choice).**
- pillow 12.3.0 (installed only because fastembed needs it) has eight advisories fixed only in pillow 13.0.0, a new major version released 2026-10-16. fastembed refuses pillow 13 in every release, and D2 asks for 60 days.
- The AI service runs fastembed's text embedding only; nothing imports pillow, so the affected image decoders never run.
- Chosen (founder, from three options): ignore exactly these eight IDs in the CI audit, with the reason next to them; any other advisory still fails. Rejected: forcing pillow 13 against fastembed's declared limit and D2; leaving CI red.
- pypdf moved 6.19.0 -> 6.20.1 for its four advisories (same major version; D2 does not apply).
- 2026-10-22 (founder's choice, same reasoning): 16 more pillow advisories, again fixed only in 13.0.0, accepted by ID: CVE-2026-112402, CVE-2026-112900, CVE-2026-112893, CVE-2026-112392, CVE-2026-112891, CVE-2026-112405, CVE-2026-112390, CVE-2026-112401, CVE-2026-112901, CVE-2026-112391, CVE-2026-112894, CVE-2026-112406, CVE-2026-112399, CVE-2026-112892, CVE-2026-112393, CVE-2026-112396. pypdf 6.20.1 -> 6.21.1 for CVE-2026-113786 (same major version).
- 2026-10-23 (same rule as the founder's two earlier choices, applied by Claude; the founder can reverse it): 11 more pillow advisories, again fixed only in 13.0.0, accepted by ID: CVE-2026-96636, CVE-2026-96637, CVE-2026-96638, CVE-2026-96639, CVE-2026-96640, CVE-2026-96641, CVE-2026-96642, CVE-2026-96643, CVE-2026-96644, CVE-2026-96778, GHSA-78g4-xqwv-q3g8. fastembed 0.9.0 still requires pillow<13 (PyPI, read 2026-10-23).
- 2026-10-24 (same rule, applied by Claude; the founder can reverse it): 2 more pillow advisories fixed only in 13.0.0, accepted by ID: CVE-2026-114501, CVE-2026-112398. pypdf 6.21.1 -> 6.21.2 for CVE-2026-115572, CVE-2026-115580, CVE-2026-115585 (a patch release of the same version; D2 does not apply, as before).
- 2026-10-28 (same rule, applied by Claude; the founder can reverse it): PYSEC-2026-4332 (pillow's JPEG decoder), fixed
  only in 13.0.0, accepted by ID. JPEG uploads exist since step 36 but nothing decodes them yet; a real text-recognition
  reader may not be switched on while pillow ignores remain, unless it does not decode with pillow.
- Re-check when fastembed allows pillow 13 and pillow 13 is 60 days old (2026-12-15). Details: docs/DEPENDENCIES.md 9.1.

**D33 — SSO: the company's identity provider is a strong factor, chosen by the company the person names, linked by the provider's subject (2026-10-21).**
- Details: `docs/phase4/07-sso-scim.md`, part A. Feature 16, part A (SCIM follows).
- Phase 1's rule kept: an SSO sign-in counts as the strong factor and never replaces the card or the 3-digit code.
- OpenID Connect only (authorization code + PKCE, confidential client). Rejected for now: SAML (an XML-signature library and its history of signature-wrapping flaws; no customer asked yet).
- **The provider is chosen by the company the person names, never by the card**, so the answer cannot reveal whether a card number exists. Price: the person types the company's short name.
- An identity is the provider's `sub`, linked to a card only during the card's set-up (set-up token + 3-digit code). Never by e-mail address. One identity opens at most one live card.
- The provider's tokens are checked with `jose` (already a dependency): published keys, asymmetric algorithms only, issuer, audience/azp, expiry, age, nonce. All requests through the guarded https client shared with webhooks (moved to the platform module).
- The API swaps the sign-in step for a new one carrying the vouched-for identity. Every failure is one 401.
- **Each company has its own return address** (`/sso/return/<company id>`). A code that comes back to another company's address than the flow's is refused, and so is a provider `iss` (RFC 9207) other than the flow's. This defends against the "mix-up" of one hostile company's provider with another's.
- **Only the browser that started can finish:** an HttpOnly, SameSite=Strict cookie is set at start and required at finish. This is the one thing kept in the browser between the steps, and the page cannot read it.
- The issuer and all endpoints follow the webhook address rules (https, port 443, host name, not internal). The sign-in page must be on the issuer's host.
- The client secret is stored encrypted (it must be sent again), never shown again. One connection per company; its provider never changes.
- Removing the connection revokes the SSO factors, ends their sessions and (D30) the API keys of those cards.
- The rollback refuses to run when SSO credentials exist (the append-only card history refers to them).
- **Confirmed by the founder (2026-10-22, the recommended defaults):** Owner only; people type the company's short name; removal ends those people's API keys. Still open until a customer asks: which providers first.

**D34 — SCIM: a directory key that carries one permission alone; Owners are outside its reach (2026-10-21).**
- Details: `docs/phase4/07-sso-scim.md`, part B. Feature 16, part B.
- This changes D30, which said a key can only read and ask. The one exception is the **directory key**: an API key carrying `person:scim` and nothing else. The API, the database (`api_keys_directory_key_alone`) and the policy on every request all refuse any mix.
- `person:scim` is **key-only**. The Owner's role holds it so that an Owner can make the key. A signed-in card is refused (`DENY_KEY_ONLY`), and the session does not report it.
- The directory adds people (with no card), changes their names and addresses, and records that they left: their cards are revoked, through the same function an administrator's offboarding uses. It never issues cards, gives roles or touches knowledge.
- It reaches only the people it added. It **never reaches anyone whose card holds the Owner role** (`DENY_DIRECTORY_OWNER`), so a directory mistake or attack cannot lock the company out.
- DELETE records that the person left and takes them out of the directory's reach (404 from then on, RFC 7644 3.6). Nothing is erased.
- Deviations from SCIM, written down in the details: problem-details errors; JSON answers; two filters only; no groups or bulk.
- No new library.
- **Confirmed by the founder (2026-10-22, the recommended defaults):** Owners out of reach; no roles from the directory; removed people keep their history. Still open until a customer asks: the first customer's directory.

**D35 — Bring-your-own-key: envelope encryption of the secrets the API keeps; documents and knowledge not yet (2026-10-21).**
- Details: `docs/phase4/08-bring-your-own-key.md`. Feature 21, the key part; regional hosting stays in Batch C.
- A company's own key (at a key service the company controls) wraps a data key of the company's. The API stores only the wrapped key (`company_data_keys`) and never sees the company's key.
- Covered: authenticator-app seeds, webhook signing secrets, SSO client secrets. One sealer decides per company; the key id stored with a secret says which key opens it, so earlier secrets keep opening.
- **Not covered: documents and knowledge.** Search needs the database to read them. A separate design decision is needed before anyone promises "your data under your key".
- Fail closed: with the key off nothing of it opens, and nothing new is sealed with the platform's key (503 `company-key-unavailable`). Unwrapped keys are cached for at most 5 minutes.
- Set and cleared by the platform operator only (platform permission `tenant:encryption_key`). A key that does not work is refused before use.
- Key services: `none` (default) and `local` (a stand-in, refused in production). A real KMS is one adapter, and a founder decision (it needs a cloud account).
- No new library.
- **Confirmed by the founder (2026-10-22, the recommended defaults):** secrets first (and no "your data under your key" claim until documents and knowledge are covered); the operator sets the key; the 5-minute delay. Still open until a customer asks: which key service.

**D36 — E-mail: Resend, called directly over HTTPS, with the message id as the idempotency key (2026-10-22).**
- The founder chose Resend (2026-10-22). Details: `docs/phase4/06-open-api-webhooks-email.md`, part C, "Resend".
- One more `MailSender` (`MAIL_SENDER=resend`, key in `RESEND_API_KEY` from Secret Manager). The callers did not change.
- **No library:** one `POST https://api.resend.com/emails` through the platform's guarded HTTPS client. Resend's Node package was not added: it would be more code that runs with the key, for one request.
- The message id is the `Idempotency-Key`, so a retry of a message Resend already took is not sent twice (Resend keeps keys 24 hours; our retries end within about 15).
- A set-up problem on our side (key, unverified domain) is retried, not dropped, and logged with Resend's error name only. A message Resend refuses as invalid is not retried.
- Start-up refuses a missing or malformed key, the placeholder key in production, and a `localhost` sender line.
- Tested against a local stand-in for Resend only. **No real e-mail has been sent.** The founder's part: account, sending domain (SPF, DKIM, DMARC), a sending-only key.

**D37 — Payments: Stripe Checkout, called directly; a person pays each term on Stripe's page (2026-10-23).**
- The founder chose Stripe (2026-10-22). Details: `docs/phase4/05-billing.md`, "Stripe".
- **Checkout Sessions** (Stripe's own payment page), one per invoice, with the invoice id as the idempotency key. No card data ever reaches this service. Rejected for now: Stripe Billing subscriptions (0.7% of billing volume on top of card fees, and Stripe would then own the renewal rules that D29 puts here) and saving cards for unattended charges (a second step; needs a Stripe customer per company).
- **No library.** Two short pieces: a form-encoded POST through the platform's guarded HTTPS client, and the signature check. The server now keeps the exact bytes of a JSON body for a route that declares it.
- API version pinned to `2026-07-29.dahlia` (the newest that passes the 60-day rule on 2026-10-23).
- Verified events about anything else are answered 200 `ignored`, so Stripe stops resending; unverified ones keep the same 403.
- Automatic renewal is not offered with Stripe; the screen says so.
- While the catalogue's prices are placeholders, a live Stripe key stops the API at start-up (test-mode keys work).
- Tested against a local stand-in for Stripe only. **No Stripe account, no key, no money.**

**Prices — selected at the founder's request ("search and select best fit", 2026-10-22). In the catalogue since D38.**
- Comparable tools' published prices, read 2026-10-23 (per user per month): Tettra $8 (10-user minimum); Slite $10 / $20; Notion $10 / $20 (Business includes AI; whether these are annual prices was not clear); Confluence $5.78 / $11.16 (monthly billing); Scribe $23-25. Guru, Glean, Bloomfire, Document360 and Trainual publish no prices. One retiree-handover tool (SkillPass) charges $15-39 per handover. Sources and gaps: `docs/phase4/05-billing.md`, "Prices".
- **Selected:** Pilot - free, up to 5 person cards, one term of 60 days. **Team - $150 per seat per year** (about $12.50 a month; between Tettra and the $20 AI workspaces). **Business - $300 per seat per year**, from 25 seats, with SSO, SCIM and the company's own key; above about 250 seats, a quoted price.
- Why not yet in the code: the catalogue prices a seat **per term**, and a term is the company card's validity (90 days by default, up to 366). A yearly price has to be turned into a price for the term's length, and the Business plan needs a new plan code in the database. That is the next billing change, with its own tests; until then the catalogue keeps its placeholders and the screen keeps saying so.
- Stripe's fee on these prices: about 2.9% (domestic card) to 4.4% (international). Large Business invoices ($15,000+) may hit card limits; a bank-transfer option is worth considering (ASSUMPTION, not tested).

**D38 — The catalogue holds the selected prices, per seat and year, charged for the term's length (2026-10-23).**
- Details: `docs/phase4/05-billing.md`, "Prices". The prices are those selected under D37; the founder can change them in `services/api/src/modules/billing/internal/catalogue.ts`.
- A price is per seat and **year**. A company pays for its term (the company card's validity, 90 days by default, at most 366): one seat costs the yearly price times the term's days / 365, rounded to the cent (half up, in whole numbers), then times the seats. Team at USD 150 a year is USD 36.99 a seat for a 90-day term.
- The default plan of a new company (code `pilot`, since Phase 1) is now **Team, USD 150** per seat and year; `free` is the **free pilot**. The screen shows the yearly price and the price for the company's term.
- `placeholder` is now false: the "placeholder prices" notice is gone, and a live Stripe key is accepted.
- **Not done:** the Business plan (USD 300, from 25 seats) - no route can put a company on another plan yet, so it would be unreachable; it comes with that operator action. The pilot's "5 cards, 60 days, once" is a sales rule, not enforced by the code. Invoices issued before this change keep their amounts (an invoice never changes).

**D39 — SSO: the rules of Google, Microsoft Entra ID and Okta; Google only with the company's domain (2026-10-24).**
- The founder asked for "real SSO" for these providers. Details and set-up steps: `docs/phase4/07-sso-scim.md`, "Real providers". Read from each provider's documentation on 2026-10-24.
- **Google lets any Google account sign in.** A Google connection must name the company's Google Workspace domain (`sso_connections.allowed_domain`, migration `20261024000100`), and every ID token must carry that domain in `hd`; a personal account or another company's is refused. The domain is refused for other providers, where it would mean nothing.
- Google accepts no `prompt=login`: the account chooser is asked for instead. A fresh password at Google cannot be demanded; the 3-digit code is still asked here.
- Microsoft: only a tenant-specific issuer (`.../<tenant ID>/v2.0`); `common`, `organizations`, `consumers` and domain names are refused with a message saying what to enter.
- Google's ID tokens may say `accounts.google.com` without `https://`; both are accepted for Google only.
- The client secret goes the way the provider's discovery document says it takes it (Basic, else the form body).
- Rollback is refused while a live connection has a domain (the older code would let any Google account in).
- Tested against the stand-in provider only. Not tested with any real provider.

**D40 — Bring-your-own-key: Google Cloud KMS, called directly, with the service account's token (2026-10-24).**
- The founder asked for "the real key service". Details and set-up: `docs/phase4/08-bring-your-own-key.md`, "Google Cloud KMS".
- `KEY_SERVICE=google-kms`. The company's key stays in the company's own Google Cloud project; it grants this installation's service account Encrypter/Decrypter on that one key, and can disable it or take the role back at any time.
- **No library:** two REST calls (encrypt, decrypt) through the guarded HTTPS client; the access token from the metadata server (no key file). Rejected: the Google Cloud client library (much more code running with the token, for two calls).
- CRC32C integrity checks as Google recommends; every failure is KeyUnavailable (fail closed, as D35).
- Tested against a local stand-in only. **No Google Cloud account, project or key was used.**

**D41 — Documents and knowledge sealed per company; search moves into the AI service's memory (2026-10-24).**
- Details and the steps: `docs/phase4/10-content-under-company-key.md`. Step 2 built on 2026-10-24 (locking and unlocking in the AI service, `services/ai/app/platform/sealing.py`); step 3 built and measured the same day (search in memory, `services/ai/app/capture/memory_search.py`). On 2026-10-25 the founder chose to switch: answers use the in-memory search (step 4a), all companies' indexes together at most 1 GB, a warning above 50,000 chunks per company, and a 2 GB machine for the AI service (was 1 GB). `SEARCH_ENGINE=sql` is the fallback until step 5. Also on 2026-10-25: companies without a key of their own are sealed with a data key wrapped by the platform's content key, a Cloud KMS software key usable only by the AI service (step 4b part 1); a company that brought its own key grants it to the AI service's account too. From step 4b (2026-10-25) chunks, knowledge versions and interview turns are written sealed; older rows stay readable until step 5.
- Every content field is sealed (AES-256-GCM, bound to company, table, column, row and key version) with a content key derived from the company's data key, which is wrapped by the company's own key (BYOK) or the platform's.
- The AI service unlocks keys itself (local stand-in, Cloud KMS with its own service account); the API never passes a key in a request. Keys and unlocked content are kept for at most 5 minutes.
- Search (meaning and words) runs per company in memory: vectors as a matrix, words by BM25; the access filter stays in SQL on the readable labels.
- Not protected: a running compromised AI service, the AI provider during a call, labels and structure.
- **Confirmed by the founder (2026-10-24, the recommended defaults):** every company's content is sealed, not only BYOK companies; the vectors are sealed too; the costs are accepted after measuring them on test companies first (step 3) and showing the numbers before switching over.
- **Step 5 part 1 (2026-10-25):** existing rows are sealed by the housekeeping command (job 6), not by a new scheduled worker: it reuses the one command the operator already runs, and the AI service's per-company housekeeping, which until then nothing called. The database allows readable -> sealed only (a flag for source chunks, `seal_version()` for versions) so the job cannot be used to change content. A company whose own key is off is skipped, never sealed with another key.
- **Step 6 part 4 (2026-10-25, the founder's choice):** document titles and topic names are sealed too, and the API shows them by asking the AI service (rather than giving the API its own way to open them, or leaving them readable). Accepted cost: those screens are a little slower and do not work while the AI service is down.


**D42 — Offline mode (feature 9): an installable web app with 7-day packs of verified level-0/1 knowledge (2026-10-27).**
- The founder's choices of 2026-10-27, each the recommended option: (1) the existing web app made installable and able
  to read a downloaded pack without a connection - no app-store accounts, no separate phone builds; (2) a pack may be
  opened offline for **7 days**; (3) a pack holds only **verified (or corrected), current knowledge at levels 0 and 1**
  that the person may read, linked to the job role's active topics - confidential levels 2 and 3 never leave the server.
- Accepted costs: a revoked card or a switched-off company key is not noticed on a device for up to 7 days (offline, the
  device cannot ask); a phone's browser may clear the stored pack when space runs low, so it must be downloaded again;
  offline is reading and searching only - no questions to the AI, no changes.
- Built in two parts. Part 1 (2026-10-27): the server side - `GET /v1/offline-pack?job_role=` (a card only, never a
  machine's key; every download in the audit log with the count). Part 2 (2026-10-27): the web app - installable
  (a manifest and a service worker that keeps only the application's own files, never anything under `/v1`); the copy
  kept in IndexedDB, encrypted with a key made on the device that the browser will not give out; "as of" on every
  offline view; refused and removed from its expiry on.
- Rules added in part 2, not chosen by the founder separately (they follow from the choices above):
  - a copy belongs to the card that took it: it is removed whenever the API answers that nobody, or another card, is
    signed in (so also when a session simply ran out while connected), and on signing out. It opens only while the API
    cannot be reached, or for the same card.
  - a copy is refused (and kept) while the device's clock is behind its last opening or behind the moment it was made,
    so setting the clock back cannot stop the 7 days. A clock set back before the next opening, but not behind the last
    one, cannot be told from a correct clock: that much time can be gained.
  - switching the company's key off does not remove copies already on devices: they stay readable until their 7 days
    are over (the application asks the API who is signed in, not whether the company's key is on). Taking a new copy
    is refused while the key is off. Stated in `docs/customers/your-own-key.md`.
  - the rule "nothing is kept in browser storage" (Phase 3) now has one exception: this copy, in one file
    (`web/src/offline/storage.ts`), which the lint rules enforce.
