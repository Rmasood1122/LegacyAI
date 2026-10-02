# 11 — Open decisions (Phase 2)

> Phase 2 design. **Nothing in this document is built yet.** It is a proposal for Gate 1.

## In plain language

Eight decisions that are yours to make. For each: the question in plain words, what I recommend and why, and what it costs if the choice turns out wrong. Replying "approved" at Gate 1 accepts all eight recommendations; or name the numbers you want changed.

After the eight come three lists you should read before saying "approved": what an independent review changed in this design, what Phase 2 changes in the Phase 1 code, and what is still unverified.

---

## 1. Which AI model answers questions? (decided at Gate 2, not now)

**The question.** The design works with any provider. Before the first paid call you must pick one.

**Recommendation.** Do not pick blind. At Gate 2, run the small evaluation on **two** candidates under one limit of about $5 — **Claude Haiku 4.5** ($1 / $5 per million tokens) and **GPT-5.6 Luna** ($0.20 / $1.20) — and choose from the measured results: correct refusals, citation behaviour, answer correctness, cost per question. Both pass our 60-day maturity rule; both providers let you set a hard monthly spending limit; neither trains on API data by default. *I am an Anthropic model, so treat my leaning with suspicion and let the numbers decide.*

**Cost of being wrong.** Low. Switching provider is a configuration change plus a re-run of the evaluation. The lasting cost is only what was spent with the first one.

## 2. Search vectors: computed inside our own service, or bought from a provider?

**The question.** To search by meaning, each piece of text is turned into a list of numbers. That can be done by a small open model running inside our Python service ($0 per use) or by a paid service (about $0.02 per million tokens, better quality claimed).

**Recommendation.** **Inside our own service** (`bge-small-en-v1.5`, 384 numbers). It keeps the $0 rule, adds no vendor and no key, and no text leaves our service for this step. Price: English only, weaker search, and the Python service needs 1 GiB of memory instead of 512 MiB.

**Cost of being wrong.** Medium-low. Every stored vector records which model made it, and a re-embedding job is part of the design, so switching later means re-running that job. If search quality proves too weak in the evaluation, this is the first thing to change.

## 3. May anyone confirm their own statements?

**The question.** Verification is the product's differentiator. If Maria's interview produces an item, can Maria herself mark it "verified"? Can a reviewer who rewrites an item confirm their own rewrite? Can a contributor release their own item to learners?

**Recommendation.** **No to all three, by default** — one company setting (`second_reviewer_required`, on). The person who verifies or releases an item must be neither its contributor nor the author of its current text. With the setting off, self-verification is allowed and marked as such in the item's history.

**Cost of being wrong.** If too strict: in a small pilot company with one expert per topic and few people with reviewer rights, items wait unverified, learners see "I don't know", and the product looks empty. That is a real adoption risk and you may want the setting off for the very first pilot. If too loose: "verified" means "the author says so", which is worth little to a buyer, and one careless or malicious person can fill the base with confirmed errors.

## 4. What may learners see: only confirmed knowledge, or everything with a warning label?

**The question.** A learner asks a question. Should the answer draw only on verified items, or also on unverified documents and interview text, marked as unverified?

**Recommendation.** **Verified only, for learners** (Owners, Admins and Experts see everything they are entitled to, with unverified sources marked). It is a company setting.

**Cost of being wrong.** If too strict: early in a pilot, before much is verified, learners get many "I don't know" answers — together with decision 3 this is the main way the pilot can feel empty. If too loose: a learner acts on an unverified, possibly wrong statement. One setting changes it per company.

## 5. Consent: four points that need you and a lawyer

**The questions.**
(a) Company documents with no personal author are ingested on the uploader's **declaration** ("this is the company's document") instead of an individual's consent. Acceptable?
(b) When an expert withdraws consent, their material is **hidden at once and erased, including items already verified**, unless an Owner has placed a **legal hold**. Acceptable?
(c) A **legal hold** can be placed by a Company Owner, with a written reason, audited, and the expert is told.
(d) Someone who has **left the company** cannot click "withdraw". An Owner can record the withdrawal on their written request. There is nothing in the system that makes the company do so.

**Recommendation.** Yes to all four as the pilot default — **and have an employment/data-protection lawyer review the consent wording, the withdrawal process, the hold and the departed-employee route before any real employee's words are captured.** Code can record and enforce a "yes"; it cannot make it legally valid.

**Cost of being wrong.** High, and not technical: a regulator, a works council or a single employee complaint. This is the one decision where "we'll fix it later" is not available. The pilot's synthetic data avoids the problem; the first real customer does not.

## 6. The private AI service: reachable address with an identity check, or a private network?

**The question.** Only the API should be able to call the Python service. Google offers two ways: (A) the service has an internet address but Google rejects every caller except the API's own identity — free; (B) a private network — about $0.20 a month or more, plus slower starts.

**Recommendation.** **(A)**, with our own signed token as a second lock. It is the only $0 option.

**Cost of being wrong.** Low to medium. The address can be probed; rejected requests are documented as not billed, but I could not confirm that they cannot wake the service. If abuse of that address shows up, moving to (B) is a Terraform change and a small monthly charge.

## 7. AI spending caps (numbers confirmed at Gate 2)

**The question.** How much may AI cost per company per month, and in total, before the system refuses?

**Recommendation.** Starting point: **$5 per company per month** on the pilot plan, **$1** on the free plan, **$20 global**, and a **$25 hard limit at the provider**. When a cap is reached the system degrades instead of failing: questions return the matching sources without generated text, interviews fall back to fixed questions, open test answers wait for manual grading. A company in its unpaid grace period gets the same search-only behaviour. Only you (the platform operator) can change a company's cap, because you pay the bill until billing exists.

**Cost of being wrong.** Too low: a company hits the wall mid-month and the product degrades to search-only — annoying, visible, fixable by you in a minute. Too high: your maximum loss through our own caps is the global cap per month, plus at most the estimating error of the last requests; the provider-side limit is the outer wall.

## 8. Storage rules while on the free database

**The question.** The free database is small. What do we refuse in order to stay inside it, and when do we leave it?

**Recommendation.**
- **5,000 text chunks per company** (roughly 1,500–2,500 pages), 50,000 in total.
- **The uploaded file is not kept — at all, not even temporarily in the database.** Only the redacted text. (So a document must be uploaded again to benefit from better redaction later.)
- Uploads up to **5 MB / 50 pages**, text and text-layer PDF only. The page limit may be lowered if a measurement shows 50 pages do not process within one request.
- New uploads are refused when the database is 80 % full.
- **Move to a paid database (about $15/month) before the first paying customer's data goes in** — and expect the undeletable audit log to force that move after roughly a year of busy pilot use even without one.

**Cost of being wrong.** Quota too low: a pilot company cannot load its material — you raise the setting. Not keeping originals: re-processing means re-uploading; a customer may also *expect* the original to be retrievable — say clearly that it is not. Leaving the free plan too late: an outage when the monthly compute allowance runs out, or a full database refusing writes, with a customer watching.

---

## What the independent review changed

Before this design reached you, a separate reviewer (a fresh session that had not seen my reasoning) read all eleven documents against each other and against the Phase 1 code. It reported about seventy findings. The ones that changed the design:

| Finding | What it would have meant | What was changed |
|---|---|---|
| Phase 2 routes cannot run inside one database transaction, as Phase 1 routes do | Uploads and questions would not have worked: Python could not see rows the API had not yet committed, and every waiting request would have held a scarce database connection | A second kind of route: decide and commit → call Python → record the outcome (`01`) |
| Only the "ask" path had the approval step before text reaches the model | Interview questions and test generation could have fed the model material the caller may not read | Every prompt with stored content is approved by the API; all others contain only the caller's own text (`03`) |
| An Admin could read confidential documents even with reviewer rights switched off; Experts' reach was described two ways | The permission table contradicted its own promise | One permission table; Admin content access is entirely behind the pilot reviewer switch (`03`) |
| One person could write, verify and release an item alone | "Verified" would have meant little | One second-reviewer rule for every kind of item, for corrections, and for release to learners (`06`) |
| Relabelling a document did not move its derived copies; items started at the default label | A digest of a confidential document could stay readable after the document was restricted | One `relabel()` function for all copies; items start at their source's level (`03`) |
| Citations of verified items named the underlying document | A learner could learn the title of a document they may not see | Items are cited as items; underlying sources shown only if readable (`06`) |
| Withdrawal waited for background work that nothing triggered; a departed expert could not withdraw | Withdrawn material would have kept appearing in answers | Hidden in the same transaction, erased in the same request; an Owner-recorded route for people who have left (`05`) |
| The uploaded file was held unredacted in the database until processed, and could reach backups | Contradicted "redaction before storage" | The file is never stored; it is processed inside the upload request (`05`) |
| The spending cap could be exceeded by a retry, an underestimated input, a timeout, or a stuck reservation | "Hard cap" was overstated | Retry is reserved for; timeouts charged in full; stale reservations expire as charged; wording corrected (`04`) |
| A taken-over Python service could read every company's content, not just one request's | The risk was understated | Stated plainly as unsolved (`07` T58); audit rows from Python are forced to a distinguishable kind |
| Pruning and system-wide counts were assigned to roles that cannot do them | They would not have run | Per-company housekeeping inside requests; a counters table (`01`, `02`) |
| The Phase 1 permission table's key could not hold the proposed rows; the "free" plan did not exist; the internal policy endpoint shared a secret with the token key | Migrations would have failed; an unnecessary public door | Migration 14 widens the key; migration 13 adds the plan; the endpoint is removed (`02`, `01`) |
| Storage: pending uploads, item copies and audit growth were under-counted | The 0.5 GB budget looked more comfortable than it is | Recounted; the audit log is named as what ends the free database (`08`) |
| Several statements read as guarantees ("cannot", "never", "proof") for things that are designed, not built | Overclaiming | Reworded throughout |

Not changed, and why: suspend/revoke between Owners (Phase 1.1 decision); notifications sent inside transactions (Phase 1.1 finding 8, still open — must be fixed before email exists).

## What Phase 2 changes in Phase 1 code

Phase 1 is tested and working; these are the places Phase 2 has to touch it. Each keeps its existing tests and gets new ones.

1. **HTTP layer:** a second route kind for requests that call the Python service (commit, call, finish).
2. **Audit:** both services write through one database function; the allow-list of detail keys moves into the database.
3. **Policy decision point:** a function that returns the access filter as data; new resource attributes (`verification_status`, the item's contributor and current author); two new guards (verified-only for learners; no self-review); an action-level rate limit for verifications.
4. **Permission table:** wider primary key; about forty new permission rows.
5. **The internal policy-check endpoint is removed** (47 → 46 operations before the Phase 2 routes are added). Its secret becomes the service-token signing key.
6. **Configuration and secrets:** three API key secrets become one grouped secret; a new grouped secret for the Python service.
7. **Terraform (plan-only):** the AI service changes from "internal" to "authentication required, one invoker", 1 GiB, longer timeouts; guardrail checks and their self-tests updated.
8. **Consent withdrawal is allowed in the grace period**, next to the Owner's export.
9. **Plan `free`** is added.

## Still unverified (will be measured or re-read, and reported)

- Whether a 50-page PDF processes within one upload request; memory needed by the Python service (planned 1 GiB); search time at 5,000 chunks; bytes per chunk. **All four are measured in CI before Gate 2**; if a measurement fails, the limit it supports is lowered and you are told.
- Whether a request rejected by Google's identity check can start the service.
- Whether Neon lets us create the vector extension and the new login the way the setup script expects.
- OpenAI and Gemini figures (read through a summariser); all prices and model facts are re-read at Gate 2.
- Whether Neon's free plan permits commercial use.

## Also know before saying "approved"

- **The Python service needs many new libraries** (PDF parser, redaction engine with a language model, embedding runtime). Each is pinned, audited in CI and recorded in `docs/DEPENDENCIES.md`, but the supply-chain surface grows substantially. One of them (`psycopg`) is LGPL-licensed; we use it unmodified, which the licence permits.
- **Most of the Python tests need the database and will run only on GitHub**, like the Phase 1 database tests.
- **By default every Admin and Expert can read all internal (level 1) knowledge of their company** during the pilot, because they are the reviewers (`03`).
- **Your checklist is still open:** the repository is public, the commit identity is unchanged, `gh` is not installed. Phase 2 will add the threat model and the injection test corpus to a public repository unless that changes first.
