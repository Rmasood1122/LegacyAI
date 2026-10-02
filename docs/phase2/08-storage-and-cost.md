# 08 — Storage budget and AI cost model

> Phase 2 design. **Nothing in this document is built yet.** It is a proposal for Gate 1.

> ## 🔴 Not guaranteed to be $0 — read first
>
> 1. **AI calls cost money from the first one.** Until Gate 2 there are none. After Gate 2 the cost is real, small, and capped three ways (our per-company cap, our global cap, the provider's own hard limit). Estimated numbers are below; **they are estimates until measured.**
> 2. **Container image storage will probably exceed the free 0.5 GB** once the Python image contains the PDF, redaction and embedding libraries and their model files. Expected: **cents per month** ($0.10 per GB-month beyond the allowance), only once deployed. Mitigation planned: keep fewer old image versions. This was already flagged for Phase 1; Phase 2 makes it likelier.
> 3. **Secrets:** the free allowance is 6. Phase 2 needs the Python service's own database login and (after Gate 2) an AI key. To stay at 6 the secrets will be **grouped per service** (5 in total). If they were added one by one instead: $0.06 per extra secret per month.
> 4. **The AI service needs 1 GiB of memory instead of 512 MiB.** Still $0 when idle; uses the free monthly allowance twice as fast when busy.
> 5. **The free database must be left behind for the first paying customer.** Expected then: roughly **$15 per month** (Neon's own "typical" figure for its cheapest paid plan; usage-based, no minimum).
> 6. **A private network for the AI service** is *not* proposed because it is not $0 (about $0.20/month or more). See `01`.
>
> Everything else below is expected to be $0 at zero traffic.

## In plain language

Two budgets are tight and both are designed for rather than hoped for:

- **Space.** The free database is small. Search vectors are the usual way to blow it up, so we use small ones, store text only after redaction, throw the uploaded file away, and cap each company.
- **Money for AI.** Every question costs a fraction of a cent. The model below says what a company of 20 people might cost per month under stated assumptions — a few dollars with one candidate model, well under a dollar with another. Real numbers come from the Gate 2 measurement.

---

## Part 1 — Storage budget

### How much room is there

| Source | Figure | Date |
|---|---|---|
| Neon's documentation and pricing page | **1 GB per project** on the Free plan | read 2026-10-03 |
| Phase 1 assumption / third-party pages | 0.5 GB | older |

Neon's own pages now say 1 GB. **The design still budgets for 0.5 GB**, as your constraint says: the other half is headroom, and the limit has changed before. When the database is full, Neon refuses writes (it does not delete data).

### Why vectors are the thing to watch

| Choice | Bytes per chunk for the vector alone | 40,000 chunks |
|---|---|---|
| 1,536 numbers, full precision (a common default) | 6,152 | 246 MB |
| 768 numbers, full precision | 3,080 | 123 MB |
| 384 numbers, full precision | 1,544 | 62 MB |
| **384 numbers, half precision (`halfvec`) — chosen** | **776** | **31 MB** |

(pgvector: `vector` = 4 bytes per number + 8; `halfvec` = 2 bytes per number + 8.)

Small vectors lose some search quality. Published benchmarks for models that support shrinking show a loss of roughly one to two points going from 768 to 256–384; half precision costs a fraction of a point. Our chosen local model is natively 384. **We will measure retrieval quality on the evaluation set rather than rely on those figures.**

**No vector index.** An approximate index roughly doubles the vector storage again and brings filtering problems (`03`). Exact search inside one company is fast at these sizes.

### One chunk, all in (ESTIMATE — measured in CI before Gate 2)

| Part | Bytes |
|---|---|
| Redacted text, ~800 characters | ~800 |
| Vector (`halfvec(384)`) | 776 |
| Row header, ids, labels, model id, timestamps | ~220 |
| Ordinary indexes (4) | ~250 |
| Keyword-search index (kept only if it is actually used) | ~600 |
| **Total** | **≈ 2.7 KB** |

So: **1,000 chunks ≈ 2.7 MB.** A CI test will seed 5,000 synthetic chunks, read the real table and index sizes from PostgreSQL, and replace this estimate.

What 5,000 chunks hold: about one million tokens — on the order of **1,500–2,500 pages** of text.

### The budget (0.5 GB = 500 MB)

| Bucket | Allowance | Basis |
|---|---|---|
| Phase 1 tables (people, cards, sessions, …) | 20 MB | ESTIMATE |
| Audit log | 110 MB | ~0.4 KB per row (Phase 1 estimate) → about 275,000 audited actions. **It can never be deleted**, so this is the bucket that eventually forces the move to a paid database. |
| **Chunks** | **110 MB** | **40,000 chunks system-wide** = 8 companies at the full per-company quota |
| Knowledge items and versions | 30 MB | ~1.5 KB each → 20,000 |
| Interview turns | 25 MB | ~1.2 KB each → 20,000 |
| Answer logs (90-day retention) | 35 MB | ~0.4 KB each |
| AI usage ledger | 30 MB | ~0.25 KB each → 120,000 calls |
| Readiness tests | 20 MB | answers pruned after a year |
| Citations, review tasks, topics, consents | 25 MB | |
| Uploads waiting to be processed (peak, transient) | 25 MB | at most 3 pending × 5 MB per company, deleted on processing |
| Headroom (dead rows, index growth, surprises) | 70 MB | |
| **Total** | **500 MB** | |

### Rules that keep it there

| Rule | Value | Enforced by |
|---|---|---|
| Vector size | 384, half precision | column type |
| `embedding_model` on every row | — | allows re-embedding with another model without guessing which rows are which |
| **Per-company chunk quota** | **5,000** (plan setting) | checked before and during ingestion; the upload is refused with `quota_exceeded` |
| System-wide chunk ceiling | 40,000 | same check |
| Originals | never stored on the pilot plan | database CHECK on the setting |
| Upload size | 5 MB (max 10 MB) | API + database CHECK |
| Pending uploads | 3 per company | queue |
| **Storage gate** | new uploads and new interviews refused when the database is above **80 %** of the configured budget (`STORAGE_BUDGET_BYTES`, default 500 MB) | checked on each upload; reading and answering keep working |
| Pruning | answer logs after 90 days; test answer text after 365 days; rate-limit and login-attempt rows as in Phase 1; expired upload blobs after 24 hours | a `prune` job, run from the existing nightly backup job (no new scheduled job, no extra database wake-ups) |

### Monitoring and alert

- **Query:** `pg_database_size()` plus per-table sizes (`pg_total_relation_size`) for the ten largest tables.
- **Where it is seen:** an operator-only endpoint `GET /v1/platform/storage` (bytes used, budget, percentage, largest tables, chunks per company against quota).
- **Alert:** the nightly backup job — which already runs and already wakes the database once a day — prints the size and raises a notification at 70 % and 80 %. No new scheduled job (Cloud Scheduler's free allowance is 3; we use 2) and no monitor that pings the database every few minutes (that would exhaust the free database's monthly compute hours — Phase 1 red flag 5).
- **Honest limit:** the notification is a log line until email exists. Until then *you* must look.

### When you must move to a paid database

**Trigger: the first paying customer's data.** Not a size threshold — a free plan is described by Neon itself as for "experimentation and prototyping", pauses when its monthly compute allowance runs out, and keeps only 6 hours of restore history.

Secondary triggers, whichever comes first: the storage gate (80 %) is reached; the audit log passes its bucket; the monthly compute allowance runs out once (the database stops until next month — an outage).

What it costs then (Neon "Launch", read 2026-10-03): usage-based, no monthly minimum; $0.106 per compute-hour, $0.35 per GB-month of storage; Neon quotes "typical spend $15/month". Moving is a configuration change (a new connection string), not a rebuild.

---

## Part 2 — AI cost model

**Everything in this part is an ESTIMATE until the Gate 2 run measures it.** No call has been made.

### Assumptions

| # | Assumption |
|---|---|
| A1 | Prices as published on 2026-10-03: Claude Haiku 4.5 $1 / $5 per million input / output tokens; GPT-5.6 Luna $0.20 / $1.20. Both are candidates (`04`). |
| A2 | A chunk is ~220 tokens; a prompt carries up to 6 chunks. |
| A3 | One token ≈ ¾ of an English word. Different models count tokens differently (newer Claude models count ~30 % more for the same text; Haiku 4.5 uses the older counting). |
| A4 | Embeddings are local and cost $0. |
| A5 | A share of questions is answered "I don't know" by code, before any model call, at $0. Assumed 25 %. |
| A6 | No prompt caching and no batch discount assumed (both would lower cost; the cheapest Claude model needs prompts of 4,096+ tokens before caching applies, and ours are shorter). |

### Per unit

| Unit | Input tokens | Output tokens | Haiku 4.5 | GPT-5.6 Luna |
|---|---|---|---|---|
| **One answered question** (instructions 350 + schema 150 + 6 chunks 1,320 + question 40) | 1,860 | 300 | **$0.0034** | **$0.0007** |
| One "I don't know" decided by code | 0 | 0 | $0 | $0 |
| Interview: wording one question | 900 | 80 | $0.0013 | $0.0003 |
| Interview: turning one answer into a candidate item | 700 | 220 | $0.0018 | $0.0004 |
| **One interview turn** (both of the above) | 1,600 | 300 | **$0.0031** | **$0.0007** |
| **One interview session** (20 turns) | 32,000 | 6,000 | **$0.062** | **$0.014** |
| Generating one test question | 800 | 350 | $0.0026 | $0.0006 |
| Grading one open answer | 900 | 200 | $0.0019 | $0.0004 |
| **One readiness test** (10 questions, 4 of them open; multiple-choice grading is free) | 3,600 | 800 | **$0.0076** | **$0.0017** |
| Suggesting topics from one document | 3,000 | 300 | $0.0045 | $0.0010 |

### Per card per month

Usage assumptions (they are guesses; nobody has used the product yet):

| Role | Assumed monthly use | Haiku 4.5 | GPT-5.6 Luna |
|---|---|---|---|
| Successor / learner | 40 questions (30 reach the model) + 2 tests | $0.12 | $0.025 |
| Expert | 2 interview sessions + 10 questions | $0.16 | $0.035 |
| Admin / Owner | 10 questions | $0.03 | $0.007 |

**A company of 20 cards** (3 experts, 12 learners, 5 admins/owners): about **$2.10 per month** with Haiku 4.5, about **$0.45** with GPT-5.6 Luna — plus one-off work when content is first loaded (a bank of 50 test questions ≈ $0.13 / $0.03; topic suggestions for 20 documents ≈ $0.09 / $0.02).

**Blended, per card per month: roughly $0.10 (Haiku 4.5) or $0.02 (Luna).** This is the number the cost-per-card estimate needs. Its error bar is wide: heavy users, long answers, or a move to a mid-tier model ($2 / $10) would multiply it.

### Suggested caps (you decide at Gate 2 — open decision 7)

| Cap | Suggested | What it allows with Haiku 4.5 |
|---|---|---|
| Per company per month (pilot plan) | $5 | ~1,450 answered questions, or ~80 interview sessions |
| Per company per month (free plan) | $1 | ~290 answered questions |
| Global per month (all companies) | $20 | your maximum exposure through our own caps |
| Provider-side hard limit (set in their console) | $25 | the outer wall; slightly above our global cap so ours triggers first |
| Per request | 2,500 input / 600 output tokens (answers) | worst case $0.0055 per call |

### Cost of the Gate 2 evaluation run

About 60 questions, one 15-turn interview, 20 generated test questions, 20 gradings and the injection corpus (~20 calls): **≈ $0.40 per model per run** with Haiku 4.5, ≈ $0.09 with Luna. Three repeats of two models: **under $2**. Proposed hard cap for the whole evaluation, enforced in code: **$5**. The report will state the actual spend from our ledger and ask you to compare it with the provider's invoice.

---

## Part 3 — Cloud running costs (still nothing deployed)

| Item | Change in Phase 2 | Cost at zero traffic |
|---|---|---|
| API service | request timeout 30 s → 60 s; one upload route with a 5–10 MB body | $0 |
| AI service | 512 MiB → 1 GiB; timeout → 120 s; ingress "all + authentication" | $0 |
| Cloud Run free allowance per month | 180,000 vCPU-seconds, 360,000 GiB-seconds, 2 million requests (read 2026-10-03) | — |
| Rough use at 10,000 questions + 200 uploads a month | ~35,000 vCPU-seconds and ~30,000 GiB-seconds (ESTIMATE: 3 s of work per question across both services, 20 s per upload) | inside the allowance |
| Start-up | The AI service loads two model files when it wakes from zero. Start-up time **is billed** and the first request after a quiet period will be slow — seconds, possibly more (**not measured**). | $0, but a latency cost |
| Secrets | regrouped to 5 | $0 |
| Image storage | red flag 2 above | cents |
| Scheduler | unchanged: 2 jobs | $0 |

The Terraform guardrail check and its self-test are extended to these values in Part C; `docs/phase1/06-infra-and-cost.md` gets the red flags above at its top.
