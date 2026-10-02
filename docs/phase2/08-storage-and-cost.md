# 08 — Storage budget and AI cost model

> Phase 2 design. **Nothing in this document is built yet.** It is a proposal for Gate 1.
> Revised after an independent review of the first draft (see `11`, "What the review changed").

## In plain language

Two budgets are tight and both are designed for rather than hoped for:

- **Space.** The free database is small. Search vectors are the usual way to blow it up, so we use small ones, store text only after redaction, never keep the uploaded file, and cap each company. The thing that eventually forces a move to a paid database is not documents — it is the **audit log**, which by design can never be deleted.
- **Money for AI.** Every question costs a fraction of a cent. The model below says what a company of 20 people might cost per month under stated assumptions — a couple of dollars with one candidate model, well under a dollar with another. Real numbers come from the Gate 2 measurement.

Every number in this document is an **ESTIMATE** unless it says MEASURED. Nothing has been measured yet.

> ## 🔴 Not guaranteed to be $0 — read before approving
>
> 1. **AI calls cost money from the first one.** Until Gate 2 there are none. After Gate 2 the cost is real, small, and limited three ways (our per-company cap, our global cap, the provider's own hard limit).
> 2. **Container image storage will probably exceed the free 0.5 GB** once the Python image contains the PDF, redaction and embedding libraries and their model files. Expected: **cents per month** ($0.10 per GB-month beyond the allowance), only once deployed. Mitigation planned: keep fewer old image versions.
> 3. **Backups will probably exceed the free 5 GB of storage** once the database holds real content: 30 nightly dumps of a database approaching half a gigabyte is more than 5 GB (vectors compress poorly). Expected: **cents per month**. Mitigation planned: keep 14 nightly backups instead of 30 once a dump passes 150 MB. *The storage price beyond the allowance was not re-read for this document — UNVERIFIED.*
> 4. **Secrets:** the free allowance is 6. Phase 2 needs the Python service's own database login and (after Gate 2) an AI key. To stay inside 6 the secrets are regrouped into 5 (`01`). Added one by one instead, each extra would cost $0.06 per month.
> 5. **The AI service needs 1 GiB of memory instead of 512 MiB.** Still $0 when idle; uses the free monthly allowance faster when busy.
> 6. **The free Cloud Run allowance can be used up by slow AI answers** — while the API waits for the model, both services are billed. See Part 3.
> 7. **The free database must be left behind for the first paying customer.** Expected then: roughly **$15 per month** (Neon's own "typical" figure for its cheapest paid plan; usage-based, no minimum).
> 8. **A private network for the AI service** is *not* proposed because it is not $0 (`01`).
>
> Everything else below is expected to be $0 at zero traffic.

---

## Part 1 — Storage budget

### How much room is there

| Source | Figure | Read |
|---|---|---|
| Neon's documentation and pricing page | **1 GB per project** on the Free plan | 2026-10-03 |
| Phase 1 assumption / third-party pages | 0.5 GB | older |

Neon's own pages now say 1 GB. **The design still budgets for 0.5 GB**, as your constraint says: the other half is headroom, and the limit has changed before. When the database is full, Neon refuses writes (it does not delete data).

### Why vectors are the thing to watch

| Choice | Bytes per chunk for the vector alone | 50,000 chunks |
|---|---|---|
| 1,536 numbers, full precision (a common default) | 6,152 | 308 MB |
| 768 numbers, full precision | 3,080 | 154 MB |
| 384 numbers, full precision | 1,544 | 77 MB |
| **384 numbers, half precision (`halfvec`) — chosen** | **776** | **39 MB** |

(pgvector: `vector` = 4 bytes per number + 8; `halfvec` = 2 bytes per number + 8.)

**The trade-off.** Small vectors lose some search quality. Two models that publish their own numbers by size (`docs/DEPENDENCIES.md` §9.6) show a drop of about 0.3 to 1.8 benchmark points between 768 and 256–512 numbers; those figures are for *those* models and are not a measurement of ours. Our chosen local model is natively 384. **Retrieval quality is measured on the evaluation set rather than assumed.**

**No vector index and no keyword index.** An approximate vector index would roughly double the vector storage and brings filtering problems; a keyword index would not be used by the query as written (`03`). Search scans the visible rows of one company. How fast that is at 5,000 chunks is an **ASSUMPTION** until a CI test measures it.

### One chunk, all in

| Part | Bytes |
|---|---|
| Redacted text, ~800 characters | ~800 |
| Vector (`halfvec(384)`) | 776 |
| Row header, ids, labels, model id, timestamps | ~220 |
| Indexes (5 ordinary ones, including the primary key) | ~300 |
| **Total** | **≈ 2.1 KB** |

So: **1,000 chunks ≈ 2.1 MB.** A CI test seeds 5,000 synthetic chunks, reads the real table and index sizes from PostgreSQL, and replaces this estimate.

What 5,000 chunks hold: about one million tokens — on the order of **1,500–2,500 pages** of text.

**The same words are stored more than once.** An interview answer exists as the turn, as an unverified search chunk, as a knowledge item version, and — once verified — as the item's search copy. That is deliberate (each serves a different purpose) and is counted below.

### The budget (0.5 GB = 500 MB)

| Bucket | Allowance | Basis |
|---|---|---|
| Phase 1 tables (people, cards, sessions, …) | 20 MB | |
| **Audit log** | **120 MB** | ~0.4 KB per row (Phase 1 estimate) → about 300,000 rows. **It can never be deleted.** |
| **Chunks** (document passages, interview answers, **and** the search copies of verified items) | **110 MB** | **50,000 chunk rows system-wide** |
| Knowledge items and versions | 30 MB | ~1.5 KB each → 20,000 |
| Interview turns | 25 MB | ~1.2 KB each → 20,000 |
| Answer logs (90-day retention) | 30 MB | ~0.4 KB each |
| AI usage ledger (12-month roll-up) | 25 MB | ~0.25 KB each → 100,000 attempts |
| Readiness tests | 20 MB | answers blanked after a year |
| Citations, review tasks, topics, consents, jobs | 25 MB | |
| Headroom (dead rows, index growth, surprises) | 95 MB | |
| **Total** | **500 MB** | |

**What fills first, honestly:** at the usage scenario of Part 3 (10,000 questions a month across all companies), each question writes at least two audit rows — the API's decision and the Python service's event — so the audit log alone grows by 20,000 rows or more a month and **reaches its 120 MB in roughly a year**, sooner with interviews, uploads and reviews. The audit log, not the documents, is what ends the free database. The 1 GB that Neon now offers would roughly double that time.

### Rules that keep it there

| Rule | Value | Enforced by |
|---|---|---|
| Vector size | 384, half precision | column type |
| `embedding_model` on every row | — | allows re-embedding with another model |
| **Per-company chunk quota** | **5,000** — document passages, interview answers and verified-item copies together | checked before and during processing, from the usage counter; refused with `quota_exceeded` |
| System-wide chunk ceiling | 50,000 | same check, from `tenant_usage_counters` |
| Uploaded files | never stored | there is no table for them |
| Upload size | 5 MB (max 10 MB) | API |
| **Storage gate** | new uploads and new interviews refused when the database is above **80 %** of the configured budget (`STORAGE_BUDGET_BYTES`, default 500 MB) | checked on each upload; reading and answering keep working |
| Pruning — answer logs after 90 days; test answer text after 365 days; finished queue rows after 7 days; ledger rows after 12 months (totals kept) | per company, in the housekeeping slice of that company's own requests (`01`) | the Python login may delete only these |
| Pruning — rate-limit and login-attempt rows | as in Phase 1 | |

### Monitoring and alert

- **Query:** `pg_database_size()` plus per-table sizes (`pg_total_relation_size`) for the ten largest tables.
- **Where it is seen:** an operator-only endpoint `GET /v1/platform/storage` (bytes used, budget, percentage, largest tables, chunk count per company from the counters table — counts only, no content).
- **Alert:** the nightly backup job — which already runs, already wakes the database once a day, and connects **read-only** — runs the size query and writes a warning at 70 % and 80 %. It changes nothing in the database. No new scheduled job (Cloud Scheduler's free allowance is 3; we use 2) and no monitor that pings the database every few minutes (that would exhaust the free database's monthly compute hours — Phase 1 red flag 5).
- **Honest limit:** the warning is a log line until email exists. Until then *you* must look.

### When you must move to a paid database

**Trigger: the first paying customer's data.** Not a size threshold — Neon itself says the free plan "should be avoided for production workloads where uninterrupted availability matters", it pauses when its monthly compute allowance runs out, and it keeps only 6 hours of restore history.

Secondary triggers, whichever comes first: the storage gate (80 %) is reached; the audit log passes its bucket; the monthly compute allowance runs out once (the database stops until next month — an outage).

What it costs then (Neon "Launch", read 2026-10-03): usage-based, no monthly minimum; $0.106 per compute-hour, $0.35 per GB-month of storage; Neon quotes "typical spend $15/month". Moving is a configuration change (a new connection string) plus a dump and restore.

---

## Part 2 — AI cost model

**Everything in this part is an ESTIMATE until the Gate 2 run measures it.** No call has been made.

### Assumptions

| # | Assumption |
|---|---|
| A1 | Prices as published on 2026-10-03: Claude Haiku 4.5 $1 / $5 per million input / output tokens; GPT-5.6 Luna $0.20 / $1.20. Both are candidates (`04`). |
| A2 | A typical chunk is ~220 tokens; a prompt carries up to 6 chunks. (The maximum chunk is 350 tokens; six maximum chunks would be 2,100.) |
| A3 | One token ≈ ¾ of an English word. Different models count tokens differently; Anthropic's pricing page says its newer models produce about 30 % more tokens for the same text, and that Haiku 4.5 uses the older counting. |
| A4 | Embeddings are local and cost $0. |
| A5 | 25 % of **learners'** questions are answered "I don't know" by code, before any model call, at $0. (Other roles' question counts are small and are counted in full.) |
| A6 | No prompt caching and no batch discount (both would lower cost; per Anthropic's documentation its cheapest model needs prompts of at least 4,096 tokens before caching applies, and ours are shorter). |
| A7 | No retries. A retried call costs twice. |

### Per unit

| Unit | Input tokens | Output tokens | Haiku 4.5 | GPT-5.6 Luna |
|---|---|---|---|---|
| **One answered question** (instructions 350 + schema 150 + 6 chunks 1,320 + question 40) | 1,860 | 300 | **$0.0034** | **$0.0007** |
| One "I don't know" decided by code, or a search-only reply | 0 | 0 | $0 | $0 |
| Interview: wording one question | 900 | 80 | $0.0013 | $0.0003 |
| Interview: turning one answer into a candidate item | 700 | 220 | $0.0018 | $0.0004 |
| **One interview turn** (both of the above) | 1,600 | 300 | **$0.0031** | **$0.0007** |
| **One interview session** — 20 turns assumed (the limit is 30; the cost ceiling is $0.25) | 32,000 | 6,000 | **$0.062** | **$0.014** |
| Generating one test question | 800 | 350 | $0.0026 | $0.0006 |
| Grading one open answer | 900 | 200 | $0.0019 | $0.0004 |
| **One readiness test** (10 questions, 4 of them open; multiple-choice grading is free) | 3,600 | 800 | **$0.0076** | **$0.0017** |
| Suggesting topics from one document (a sample of it, within the input limit) | 3,000 | 300 | $0.0045 | $0.0010 |

**The most a single call can cost** at the per-request limits of `04` (4,000 input / 600 output tokens): $0.007 with Haiku 4.5. With one retry allowed the gateway reserves $0.014 before calling.

### Per card per month

Usage assumptions (guesses; nobody has used the product yet):

| Role | Assumed monthly use | Haiku 4.5 | GPT-5.6 Luna |
|---|---|---|---|
| Successor / learner | 40 questions (30 reach the model) + 2 tests | $0.12 | $0.025 |
| Expert | 2 interview sessions + 10 questions | $0.16 | $0.035 |
| Admin / Owner | 10 questions | $0.03 | $0.007 |

**A company of 20 cards** (3 experts, 12 learners, 5 admins/owners): about **$2.10 per month** with Haiku 4.5, about **$0.45** with GPT-5.6 Luna — plus one-off work when content is first loaded (a bank of 50 test questions ≈ $0.13 / $0.03; topic suggestions for 20 documents ≈ $0.09 / $0.02).

**Blended, per card per month: roughly $0.10 (Haiku 4.5) or $0.02 (Luna).** This is the number the cost-per-card estimate needs. Its error bar is wide: heavy users, long answers, retries, or a move to a mid-tier model ($2 / $10) would multiply it.

### Suggested caps (you decide at Gate 2 — open decision 7)

| Cap | Suggested | What it allows with Haiku 4.5 |
|---|---|---|
| Per company per month (pilot plan) | $5 | ~1,450 typical answered questions, or ~80 interview sessions |
| Per company per month (free plan) | $1 | ~290 answered questions |
| Global per month (all companies) | $20 | your maximum exposure through our own caps |
| Provider-side hard limit (set in their console) | $25 | the outer wall; slightly above our global cap so ours triggers first |

Because each call reserves its worst case ($0.014) before it runs, a company effectively stops being served AI answers when it is within about a cent of its cap, not exactly at it.

### Cost of the Gate 2 evaluation run

From `09`: 80 questions (counted as if all reach the model), 40 rubric-checking calls for answer correctness, the injection corpus (~25 calls), one 15-turn interview, 20 generated test questions and 20 gradings: **≈ $0.55 per model per run** with Haiku 4.5, ≈ $0.12 with Luna. Three runs of both models: **about $2**. Proposed limit for the whole evaluation, enforced by the same cap mechanism: **$5**. The report states the spend from our ledger and asks you to compare it with the provider's invoice.

---

## Part 3 — Cloud running costs (still nothing deployed)

| Item | Change in Phase 2 | Cost at zero traffic |
|---|---|---|
| API service | request timeout 30 s → 60 s; one upload route with a 5–10 MB body | $0 |
| AI service | 512 MiB → 1 GiB; timeout → 120 s; ingress "all + authentication" | $0 |
| Secrets | regrouped to 5 | $0 |
| Scheduler | unchanged: 2 jobs | $0 |
| Image storage, backup storage | red flags 2 and 3 | cents, once deployed |

**How far the free Cloud Run allowance goes** (per month, request-based billing, read 2026-10-03: 180,000 vCPU-seconds, 360,000 GiB-seconds, 2 million requests). While the API waits for the Python service, and the Python service waits for the model, **both are being billed**. So one question costs about 2 vCPU-seconds per second of waiting:

| If a question takes, start to finish | vCPU-seconds per question | Questions per month inside the free allowance |
|---|---|---|
| 3 s | ~6 | ~30,000 |
| 6 s | ~12 | ~15,000 |
| 9 s | ~18 | ~10,000 |

Real model calls take seconds, so the lower rows are the realistic ones. Uploads (about 20–40 s of work each) and interviews draw from the same allowance. Beyond it the price is $0.000024 per vCPU-second — 10,000 extra questions at 9 s would be about $4. This is not $0 under load; it is $0 at rest and small in a pilot. Latency is **not measured** yet.

**Start-up.** The AI service loads two model files when it wakes from zero. Start-up time is billed, and the first request after a quiet period will be slow — seconds, possibly more (**not measured**).

The Terraform guardrail check and its self-test are extended to the new values in Part C; `docs/phase1/06-infra-and-cost.md` gets the red flags above at its top.
