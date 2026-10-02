# 09 — Evaluation plan

> Phase 2 design. **Nothing in this document is built yet.** It is a proposal for Gate 1.
> Revised after an independent review of the first draft (see `11`, "What the review changed").

## In plain language

Tests answer "does the code do what it was written to do?". Evaluation answers a different question: "how good are the results?" — how often the answer is right, how often the system correctly says "I don't know", how much personal data redaction catches, what a question costs.

Two rules for every number in the evaluation:

1. **It comes with its sample size**, and it is not rounded up. "41 of 46" — not "about 90 %".
2. **It is a measurement on a small, invented data set.** It says how the system behaved on that set on that day with that model. It does **not** predict accuracy on a real company's documents, and the report will say so next to every figure.

The evaluation has two halves:

- **Before Gate 2 — with the fake AI provider, in CI, $0.** This measures everything that does not depend on a real model: permission leakage, the citation checker, redaction, the plumbing of abstention, cost accounting.
- **After Gate 2 — with a real model, once, under a hard cap.** This measures what only a real model can show: answer correctness, real abstention behaviour, real citation behaviour, interview quality, real cost and speed.

## The golden set (synthetic, clearly labelled)

A fictional company, **"Northfield Bottling Plant (FICTIONAL — synthetic evaluation data)"**. Every file carries that label; every name is invented; no real person, company, address or number appears. Stored in `services/ai/eval/golden/`.

| Part | Size | Purpose |
|---|---|---|
| Documents | 12 (9 text, 3 text-layer PDF), ~40 pages in total: line start-up procedure, lubrication schedule, fault table for the filler, safety lock-out steps, changeover checklist, a shift-handover note, a supplier contact sheet, … | the knowledge base |
| Access labels | 3 departments (Production, Maintenance, Quality); sensitivities 0–3; 4 contributors | permission tests on realistic data |
| An expert's interview | 1 scripted expert ("retiring maintenance lead") with written answers to 15 questions; 10 seeded topics for the job role, 8 of which the answers cover | interview and gap-detector quality |
| **Answerable questions** | 40, each with: the expected answer points (a short rubric), the document passages that support it | correctness, citation validity, wrong refusals |
| **Unanswerable questions** | 20: plausible, on-topic, but the documents do not contain the answer | correct "I don't know" |
| **Conflicting-source questions** | 8: two documents disagree (an old and a new torque value, two different intervals) | conflict detection |
| **Permission-restricted questions** | 12: answerable only from content the asking role may not read | must look exactly like unanswerable |
| Second tenant | a small second fictional company with overlapping vocabulary | cross-tenant |
| **PII set** | 60 short passages with **at least 300 labelled entities**: emails, phones, payment cards (valid and invalid checksums), IBANs, government IDs, API keys / tokens / private-key blocks, names, places and addresses — plus 40 hard negatives (part numbers that look like IDs, machines named like people) | redaction recall and precision |
| Injection corpus | 25 cases (`05` §6) | containment, and real-model behaviour |
| Readiness material | 20 verified items → generated questions; 5 scripted learner answer sheets (strong, weak, off-topic, copied-question, injection) | grading agreement |

The expected answers and labels are written **before** any model is run and are not changed afterwards to fit results. If a golden item turns out to be wrong or ambiguous, it is fixed in a separate commit that says so, and both numbers are reported.

## What is measured

### 1. Permission leakage — pass/fail

- **What:** the adversarial suite of `03` (21 attack groups) plus the 12 permission-restricted questions and the cross-tenant set.
- **How:** deterministic. A leak = any chunk, title, snippet, count or wording that the asking subject is not allowed to see appearing in candidates, prompt, answer, citations, logs or errors; or any difference between "restricted" and "non-existent".
- **Pass criterion: 0 leaks. One leak fails the phase.**
- **Reported:** `PERMISSION_LEAKAGE cases=… rows=… comparisons=… leaks=0`.
- **Run:** in CI with the fake provider on every commit; repeated in the Gate 2 run with the real model.
- **What it does not show:** absence of leaks outside the cases we thought of.

### 2. Citation validity — target 100 %

- **What:** of all citations **returned to the user**, the share that (a) point to a chunk that was in the approved set for that request, and (b) whose quoted snippet actually appears in that chunk.
- **How:** deterministic re-check of every returned citation by a script that is independent of the validator in the answer pipeline.
- **Target: 100 %** — by construction, since invalid citations are removed before the answer is returned. Anything below 100 % is a bug.
- **Also reported, separately:** how many citations the **model produced** that the validator had to remove, and how many referenced a source that was never provided ("fabricated"). These are the honest measure of the model's behaviour; the 100 % is the measure of our safety net.

### 3. Abstention

- **Correct refusals:** of the 20 unanswerable + 8 conflicting + 12 restricted questions, how many got "I don't know" (and for conflicts, with the reason "sources conflict").
- **Wrong refusals:** of the 40 answerable questions, how many got "I don't know".
- **Reported as counts** (e.g. "18 of 20"), split by which gate decided: the code's evidence gate (no model call) or the model.
- **Proposed pass criteria for the pilot:** correct refusals ≥ 90 % on unanswerable; wrong refusals ≤ 25 % on answerable. *These thresholds are my proposal, not a standard; with samples this small, one question moves the figure by 2.5–5 points.* A wrong refusal is an annoyance; a wrong confident answer is the failure that matters — so the thresholds lean towards refusing.

### 4. Answer correctness

- **What:** for answerable questions that were answered: does the answer contain the expected points and nothing that contradicts the documents?
- **How:** a rubric per question (2–4 required points, written in advance). Each answer is scored *correct* (all required points, no contradiction), *partly correct*, or *wrong*. Scoring is done by a script that asks a model to check each rubric point (one extra call per answered question, at most 40, charged to the same capped budget and counted in `08`) **and** by listing every answer with its rubric in the report so that **you (or anyone) can check them by hand** — 40 rows. Where the two disagree, the human reading wins. *A model judging a model is weak evidence; the hand-checkable table is the real one.*
- **Reported:** counts of correct / partly / wrong out of the number answered, with the full table.
- **No pass threshold is proposed.** 40 invented questions on 12 invented documents cannot support one. **This number does not predict real-world accuracy** and will be labelled that way.

### 5. Redaction

- **What:** on the PII set, per category and overall: entities, found, missed, false alarms → **recall** and **precision**.
- **How:** deterministic comparison with the labels; a finding counts if it overlaps the labelled span and has a compatible type.
- **Proposed floors (CI fails below them):** recall — payment cards, IBAN, emails, private-key blocks and known key formats ≥ 95 %; phone numbers ≥ 85 %; government IDs of the listed countries and US bank numbers ≥ 80 %; **names and places: floor 60 %** — we expect this to be the weak category and will not hide it behind an average. Precision — overall ≥ 80 %, and at most 10 % of the 40 hard negatives redacted. *These floors are my proposal; they are set where a pattern-and-checksum detector should comfortably be, and low where a small language model is the detector.*
- **Stated with the result:** sample size; synthetic data over-estimates real performance; English only; **redaction is never 100 %**.
- **Run:** in CI on every commit (no AI involved).

### 6. Interview quality (simple)

- **What:** after N = 15 turns with the scripted expert, how many of the 8 coverable seeded topics have at least one candidate item linked to them; how many of the 2 uncoverable topics are correctly still reported as gaps; how many follow-up questions were asked; how many candidate items had a valid supporting quote.
- **Reported:** "topics covered 6 of 8 after 15 turns", etc.
- **Pass criterion (fake-provider run):** the question order follows the gap ranking exactly and every candidate item's quote is in the answer — both are code. **No pass threshold for the real-model run**: the number is reported.
- **What it does not show:** whether a real expert finds the questions sensible. That needs a person; noted as not done.

### 7. Cost

- **Measured from the ledger** (and compared with the provider's usage page by you): tokens in and out, and dollars, **per interview session, per question (answered and refused), per readiness test (generation, grading)**; total for the run.
- **Derived:** cost per card per month under the usage assumptions of `08` — recomputed with measured token counts in place of the estimates, with the assumptions repeated beside it.
- **Cap, enforced by the same mechanism as every company's cap:** the evaluation runs as its own "tenant" with a monthly cap equal to the evaluation budget (proposed $5), under a global cap of the same amount, with the provider-side limit set just above. When the cap is hit, the run **stops**, reports what it completed, and says it was cut short.
- **Pass criterion:** the run finishes or stops under the cap, and the ledger total matches the period total exactly. The cost figures themselves are reported, not judged.

### 8. Latency

- **What:** p50 and p95 of ask-a-question end to end (API → retrieve → policy re-check → generate → validate), and of retrieval alone, over the answerable set.
- **Where:** on the CI machine. **This is not production**: different CPU, no cold starts, no network distance to the database. Reported with that sentence attached. Useful only for spotting something badly slow. **No pass threshold**, except that the retrieval query at 5,000 chunks must stay under 500 ms on the CI machine — the check behind the "no index" decision in `03`.

### 9. Injection corpus with a real model (Gate 2 only)

- **What:** for each of the ~25 cases: did the model follow the injected instruction (measured by what it returned **before** our validation), and did anything get past our validation (must be nothing).
- **Reported:** "model followed the injection in X of 25; contained by validation in X of X". The first number is information about the model. The second is the pass criterion: every followed injection must have been contained.

## The two runs

| | Fake-provider run | Real-model run |
|---|---|---|
| When | every commit, in CI | once (repeatable), after Gate 2 |
| Cost | $0 | capped at $5; estimate about $2 for three runs of two candidate models (`08`) |
| Measures | 1, 2 (safety net), 3 (plumbing: the code gate and scripted model behaviours), 5, 7 (accounting exactness), 8 | 1 again, 2, 3, 4, 6, 7, 8, 9 |
| Output | lines in the CI summary | `docs/phase2/EVALUATION.md` |

`EVALUATION.md` will contain, for the real run: the model id(s) and date, the prompt versions, the commit, every number above with its sample size, the full correctness table, the measured cost and the cap, what was cut short if anything, and a section "what these numbers do not tell you".

## What the evaluation as a whole does not cover

- Real documents, real experts, real learners. Everything is invented and written by the same author as the system (me) — which makes it easier than reality.
- Languages other than English; scanned documents; tables and drawings.
- Scale: a dozen documents, not thousands.
- Model drift: a provider can change a model's behaviour without notice; one run is a snapshot.
- Whether any of this is something a customer will pay for.
