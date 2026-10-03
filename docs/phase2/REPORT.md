# Phase 2 report — the core value (capture, verified knowledge, cited answers, readiness)

> Written 2026-10-03. Every claim is backed by a CI run or a recorded file, or is labelled ASSUMPTION / NOT PROVEN.
> Design: `docs/phase2/01`–`11`. Evaluation: `docs/phase2/EVALUATION.md`. Real-model call records: `API_Test/`.

## In plain language

Phase 2 added the part of LegacyAI that holds knowledge: documents and expert interviews go in, sensitive details
are blanked out, people verify what was captured, and employees can ask questions and get answers that point to
their sources — or an honest "I don't know". Successors can take a readiness test. All of it respects who is
allowed to see what.

- **It is backend only.** There are no screens. Everything is used through API calls.
- **It is built and tested with a fake AI**, on GitHub's test machines, on every change. Last fully green run with
  results captured: commit `a93493f` (CI run 37114267852, all 8 jobs).
- **A real AI model has been tried once, in a limited way:** Claude Haiku 4.5 on an invented question set, for
  **$0.403** of the owner's $2 limit. The results are encouraging on this small set, found one real bug (fixed) and
  one weak prompt (improved), and include **one wrong confident answer** out of 8 conflict questions. That run did
  not go through the full service — see "Not proven".
- **Nothing is deployed.** No cloud resource was created; Terraform was never applied.

## What was built

| Feature (number in `docs/feature-list-35.md`) | Delivered | Deliberately left out |
|---|---|---|
| 7 Text interviewer | invitations, consent check, adaptive question order from the gap ranking, each answer redacted and turned into a candidate item, turn and cost limits, template fallback without AI | voice |
| 10 Gap detector | rule-based labels per topic of a job role, computed for whoever looks | discovering unlisted topics, contradictions |
| 12 Verification loop | item states, versions, provenance, second-reviewer rule in the policy and in the database, rate limit, mass revert | — |
| 13 Readiness test | generated questions (reviewer approval required), answer-leak guard, code + rubric grading, override, report | PDF rendering, screens |
| 14 Cited answers | two-step answer; every citation re-checked in code; refusal paths | streaming, conversation memory |
| 15 Ask-the-expert | answers from one named expert's verified items; questions routed to the expert | email delivery |
| 17 Permission-aware answers | access filter as data inside a signed token; three locks | — |
| 18 Redaction (basic) | Presidio + own secret patterns before storage, embedding and AI | addresses, other languages |
| 19 Consent | consent records, gate in three layers, withdrawal hides at once and erases, legal hold | **legal review (not code)** |
| 22 Answer quality | one log row per answer | any monitor or dashboard |
| 24 Review queue | prioritised tasks, assignment, bulk actions | escalation, screens |
| 25 Documents | plain text, Markdown, text-layer PDF | OCR, voice, drawings |
| AI cost control | reservation before every call, ledger, per-company and global caps, kill switch | billing customers |

Size of the change: 73 new API operations (119 in total; the Phase 1 internal policy endpoint was removed), 8 new
migrations (9–15 plus the audit writer), a Python service with 44 internal operations, 29 new tables.

## Evidence

| Claim | Evidence |
|---|---|
| All checks pass | CI run 37114267852 on `a93493f`: 8 of 8 jobs green. A later commit `38625e7` (run 37114473076) is also green |
| API tests | 632 passed, 1 skipped (the both-services walk, which runs in its own job); statements 85.47 %, branches 80.96 % — from run 37098426303 on `13a6e55`. Later runs passed; their counts were not re-read (ASSUMPTION: slightly higher) |
| Every Phase 2 operation works through both services | job "Contract - API and AI service together": all 73 operations walked with the real AI service and a fake AI |
| Permission leakage | `leakage: retrieval - 16 attack groups, 64 queries, 0 leaks`; approved-list widening: 16 groups, 0 leaks. The API-side equivalence test still reports 11,040 comparisons, complete |
| Redaction | 410 planted synthetic values: 398 fully covered (0.97); 399 of 403 redactions were true hits (0.99). Weakest: secrets 54/60, names 76/80, places 38/40. **Hard negatives: 6 of 40 wrongly redacted — misses the 10 % the design proposed** |
| Sizes and speed (CI machine) | 50-page text PDF: parse 0.4 s, redact 1.4 s; search over 5,000 passages: median 270 ms |
| Migrations | 15 applied, rolled back, re-applied with two runners; identical schemas |
| Backup and restore | self-test passes with 62 tables, including the three negative controls |
| Terraform | format and validate pass; 15 deliberate guardrail breaks all detected. **Never planned against a real project, never applied** |
| Secrets | gitleaks over files and full history: no leaks |
| Real model | `docs/phase2/EVALUATION.md`, `API_Test/` |

## Real-model results in brief (Claude Haiku 4.5, invented data, one run)

39 of 40 answerable questions answered, all citing an expected document; a model check judged 36 correct and 3
partly correct. 20 of 20 unanswerable and 12 of 12 restricted questions refused. 7 of 8 conflicting-document
questions refused with the right reason; **1 answered from one side only**. 0 of 20 planted instructions followed.
Interview extraction 15 of 15 after a bug fix. Readiness grading of a strong answer 0.43 with prompt v1, 0.92 with v2.
Cost $0.0019 per question on these short documents.

## Bugs and weaknesses found by testing in this phase

1. **Consent withdrawal did not hide material** when recorded from a session with no company set (the database
   trigger ran under row-level security and saw nothing). Fixed; found by the new tests.
2. **Material given under an earlier, renewed consent stayed visible** after the new consent was withdrawn. Fixed.
3. **Owner-recorded withdrawals also touched superseded consents.** Fixed.
4. **A field named `title` was dropped from the request to the AI provider**, so every interview extraction was
   rejected. Found by the first real call; fixed with a test.
5. **Question-generation prompt v1 invented content** not in the verified item. Prompt v2 restricts it.
6. **One wrong confident answer on conflicting documents** (1 of 8). Not fixed: it depends on the model.

## Deviations from the approved design

| Design said | What was done | Why |
|---|---|---|
| Evaluate two models through the pipeline at Gate 2 | One model, without the database, on the owner's computer | The owner supplied one key as a local file and a $2 limit; the database cannot run on that computer. The pipeline run is prepared (`evaluation.yml`) and needs the key as a GitHub secret |
| Provider SDKs | none; plain HTTPS | both SDKs fail the 60-day rule |
| `presidio-anonymizer` | not installed | replacing findings with placeholders is a few lines of our own code |
| `jose` 6.2.12 | 6.2.8 | newest release older than 60 days |
| Verification rate limit in the policy layer | checked in the AI service at verify time | the API cannot read the items table |
| Contributors correct their own items through `knowledge:contribute` | corrections go through `knowledge:verify` holders | one permission per operation |
| Topics | created and renamed by the API; the AI service only embeds and proposes | the database lets the AI login only propose topics |
| Evaluation set "about 40 pages" | 13 short documents, 16 passages | written to carry the 80 questions; shorter than planned |
| Migration 15 edited after first push | yes, twice (fixes 1 and 2) | nothing was deployed anywhere; CI rebuilds from zero each time |

## Done, but NOT proven

- The **full pipeline with a real model**: real search quality, redaction in the loop, the budget ledger and caps
  under real calls. Only the model's behaviour was measured.
- **GPT-5.6 Luna**: not run. No comparison was made; no model has been chosen.
- **Embedding model** (`bge-small-en-v1.5`): never run in an evaluation; its relevance threshold (0.6) is an
  ASSUMPTION. The image builds with it in CI, nothing more.
- **Memory of the AI service** in the cloud (1 GiB) — ASSUMPTION, never measured there.
- **Neon** (the cloud database): never used. pgvector there is read from documentation only.
- **Cloud Run identity tokens** between the two services: implemented from documentation, never executed.
- **Real documents, real experts, real learners**: nothing. Everything is invented data.
- **Legal review of the consent model**: not done; it is not code.
- Redaction is never 100 %; the measured set is templated and easier than real text.

## Operational notes

- **The owner's working folder `E:\\LegacyAI` was found corrupted on 2026-10-03** (git data emptied, files
  scrambled). No committed work was lost — GitHub had everything; one uncommitted formatting change was lost. Work
  continued from a clean clone. The drive should be checked before it is used again; a fresh `git clone` gives a
  good copy.
- The owner's AI key was placed in a local `.env` file by the owner. It is ignored by git, was never read out or
  printed, and appears in no committed file (scanner and a direct comparison confirm). Advice: once testing is over,
  delete that key at the provider and create a new one stored only as a secret.
- Environment variable changes: `INTERNAL_SERVICE_TOKEN` → `SERVICE_TOKEN_KEY`; new `AI_SERVICE_URL`.
- The repository is still public.

## What I would do next

1. Run the prepared pipeline evaluation (key as a GitHub secret; about $0.55) and, if wanted, the second model.
2. Decide the model and the caps (proposal: $5 per company per month on the pilot plan, $1 free plan, $20 global).
3. Look for a second line of defence against the "one-sided answer on conflicting documents" case, for example a
   code check that refuses when retrieved passages give different numbers for the same quantity.
4. Phase 3 (screens) needs its own brief; nothing of it exists.
