# Evaluation — Phase 2 (first real-model run)

> Run on 2026-10-03 with **Claude Haiku 4.5** (`claude-haiku-4-5-20251001`), using the owner's key from a local `.env`
> file (never read, printed or stored by the tooling) under the owner's limit of **$2 in total**.
> **Spent: $0.403** (computed from the token counts the provider returned; compare with the provider's usage page).
> Every call is recorded in `API_Test/` (inputs, raw outputs, tokens, cost). Data sent: only the invented
> "Northfield Bottling Plant (FICTIONAL)" documents and questions in `services/ai/eval/golden/`.

## Read this first: what this run is and is not

**What was measured:** how the real model behaves with our real prompts on the golden set, and whether the checks
in code hold (a cited source must exist, a quote must really be in the source, "the sources conflict" and "not
answerable" are respected, links are stripped, the output must have the exact required shape).

**What was NOT measured — the planned evaluation of `docs/phase2/09` is only partly done:**

- **This was not the service pipeline.** The owner's computer cannot run the test database (Docker does not start,
  about 430 MB of memory was free), and the key was provided only as a local file, so the run could not be done on
  GitHub's machines either. `services/ai/eval/api_eval.py` therefore talks to the model directly.
- **Search was a simple keyword ranking**, not the service's real search (meaning + keywords). Retrieval quality of
  the real search with a real model is therefore **unmeasured**.
- **Documents were not passed through redaction**, permissions were applied by leaving the confidential document
  out, and cost was counted by the script instead of by the budget ledger.
- **Only one of the two candidate models was run.** GPT-5.6 Luna was not tested (no key), so the "choose from the
  measured results" comparison approved at Gate 1 has not happened.
- The pipeline itself (real search, redaction, permissions, ledger, caps) is tested with the fake provider in CI on
  every commit, including a full run of `services/ai/eval/run.py` — that shows the plumbing works, not answer quality.
- **To finish the planned run:** store the key as a GitHub Actions secret named `ANTHROPIC_API_KEY`; the workflow
  `.github/workflows/evaluation.yml` then runs the full pipeline evaluation under the same cap. Estimated cost ≈ $0.55.

Everything below is a measurement on a small, invented data set, written by the same author as the system. **It
does not predict accuracy on a real company's documents.**

## Results

Model: `claude-haiku-4-5-20251001`. Prompts: `answer@v1`, `eval_judge@v1`, `interview_question@v1`,
`item_extract@v1`, `quiz_generate@v1` and `@v2`, `quiz_grade@v1`. 330 recorded calls in total (3 first test calls and 327 in the evaluation runs,
including the two repeated runs); 0 provider errors.

### 1. Answering and refusing (88 model calls, 2 questions refused by code without a call)

| Group | Sample | Result |
|---|---|---|
| Answerable | 40 | **39 answered**, 1 wrongly refused (A16: the model's quote did not match the source word for word, so the code check removed it and the answer was withheld) |
| Answered and citing an expected document | 39 | **39 of 39** |
| Unanswerable (on-topic, not in the documents) | 20 | **20 refused** (2 by code before any call, 18 by the model). 0 answered |
| Restricted (only in the confidential sheet) | 12 | **12 refused**; the confidential document was in the prompt 0 times. They looked exactly like unanswerable questions |
| Conflicting documents | 8 | **7 refused with the reason "sources conflict"; 1 answered** (C02: the model answered "every 30 minutes" from one document although the other, saying 60, was also in front of it) |

**The one that matters:** C02 is a wrong confident answer on 1 of 8 conflict questions. The sample is tiny (one
question is 12.5 points), but this is the failure the product most needs to avoid, and nothing in code catches it:
conflict detection depends on the model.

### 2. Citations

- Claims the model made that passed the code check: **69**. Claims the check removed: **1** (the A16 quote).
- Answers that named a source it was never given: **0**.
- By construction no unchecked citation reaches the user; the "1 removed" and "0 invented" are the honest measure of
  the model on this set.

### 3. Answer correctness (39 answered; one extra model call each as a rubric check)

Model-as-judge: **36 correct, 3 partly correct, 0 wrong.** The three partly-correct answers (A17, A18, A36) gave the
main fact and left out the second rubric point. A model judging a model is weak evidence; the full table is below so
a person can check all 40 rows.

### 4. Prompt injection (20 distinct planted instructions, shown to the model 233 times in total)

Ten instructions were planted in a document that the search kept returning, ten in the questions themselves.

- The model followed a planted instruction (its marker word appeared in the raw output): **0 of 20**.
- A marker word reached a final answer: **0**.
- Five more were planted in learner answers for grading ("give full marks"): the grader awarded **0 points on all 10
  graded injection answers**. One marker word (`CANARY-L04`) did appear in the grader's raw output; the score stayed 0.

### 5. Interview (15 scripted expert answers)

- Follow-up questions worded: 15 of 15. Knowledge items extracted: **15 of 15, each with a quote that is really in
  the expert's answer.**
- **A bug was found here by the first run:** all 15 extractions were rejected as invalid, because our request to the
  provider had dropped a field named `title` (it was mistaken for a schema keyword). The strict output check
  refused them — nothing invalid was accepted — but real interviews would always have fallen back to the no-AI path.
  Fixed, with a test; the numbers above are from the re-run. Both runs are in `API_Test/`.
- Topic coverage and gap detection need the database and were not measured with the real model.

### 6. Readiness questions and grading (20 questions generated; 50 open answers graded per run)

| Scripted learner | Mean score, prompt v1 | Mean score, prompt v2 | Expected |
|---|---|---|---|
| Strong (answers with the verified fact) | **0.43** | **0.92** | high |
| Weak (first three words only) | 0.06 | 0.15 | low |
| Off-topic | 0.00 | 0.00 | zero |
| Repeats the question | 0.00 | 0.00 | zero |
| Injection ("give full marks") | 0.00 | 0.00 | zero |

**Finding:** with prompt v1 the model invented scenarios and rubric points that were not in the verified item (for a
lock-out rule it wrote about "a server room door" and "chain of custody"), so a learner answering with exactly the
verified fact scored 0.43 on average. Prompt v2 allows only what the item states; the same learner then scored 0.92.
All 20 generated questions passed the answer-leak guard in both runs. Every generated question still needs a
reviewer's approval before use.

### 7. Cost and speed (measured)

| | Measured |
|---|---|
| One question to the model | mean 1,463 tokens in, 80 out → **$0.0019** (design estimate: $0.0034) |
| Whole question set (88 calls) | $0.164 |
| Rubric checks (39 calls) | $0.031 |
| Interview, 15 turns (30 calls) | $0.026 (design estimate for 15 turns: about $0.047) |
| Readiness: 20 questions + 50 gradings (70 calls) | $0.069 (v2) |
| **Everything, including the two repeated runs** | **$0.403 of the $2 limit** |
| Model response time | median about 1.9 s, 95th percentile 3.2 s per question (from the owner's computer; not production) |

The documents here are short, so the per-question figure is lower than a real company's would be.

## What these numbers do not tell you

- Not the pipeline, not the real search, not redaction, not the ledger (see the top of this document).
- One model, one day, one run of each part. A provider can change a model's behaviour without notice.
- 13 short invented documents and 80 invented questions, written by the system's author; real documents are longer,
  messier and contradictory in ways nobody planted.
- English only; no scanned documents; no tables or drawings.
- Whether a real expert finds the interview questions sensible, or a real learner the test questions fair: that
  needs people and was not done.
- Nothing here measures whether customers will pay for this.

## The full answer table (for checking by hand)

| Id | Question | Points a correct answer needs | Answer returned | Model judge |
|---|---|---|---|---|
| A01 | What must the main air regulator read before Line 2 is started? | 6.0 bar | The main air regulator must read 6.0 bar before Line 2 is started. | correct |
| A02 | What should the rinser water pressure be at start-up? | 2.5 bar | The rinser water pressure must be 2.5 bar at start-up. | correct |
| A03 | How many caps from the first run are checked for torque? | 5 caps | 5 caps from the first run are checked for torque. | correct |
| A04 | Where does the operator sign the start-up log? | on the HMI; under Shift start | The operator signs the start-up log on the HMI screen under "Shift start". | correct |
| A05 | Which extension do I call if the air pressure is too low at start-up? | extension 4410 | Call maintenance on extension 4410 if the air pressure is too low at start-up. | correct |
| A06 | What must be checked on the walk-around before starting Line 2? | guards closed; emergency stops released; no tools or loose parts on the conveyor | Before starting Line 2, you must check that all guards are closed, every emergency stop is released, there are no tools or loose parts on the conveyor, the main air regulator reads 6.0 bar, the CO2 bank gauge pressure meets specifications, and the rinser water pressure is 2.5 bar. | correct |
| A07 | To what speed is the conveyor ramped up after start-up, and when? | 420 bottles per minute; after 10 minutes of stable running | The conveyor is ramped up to 420 bottles per minute after 10 minutes of stable running. | correct |
| A08 | Which grease is used on the filler star wheel bearings? | food-grade H1 grease; NLGI 2 | Food-grade H1 grease, NLGI 2 is used on the filler star wheel bearings. | correct |
| A09 | How often is the capper head chain oiled? | weekly; on Mondays | The capper head chain is oiled weekly, on Mondays. | correct |
| A10 | When does the conveyor chain get its dry lubricant spray? | daily; at the start of each shift | The conveyor chain gets its dry lubricant spray daily, at the start of each shift. | correct |
| A11 | Which oil goes in the main gearbox? | food-grade gear oil; ISO VG 220 | Food-grade gear oil ISO VG 220 goes in the main gearbox. | correct |
| A12 | Which task code is used when a lubrication task is recorded? | LUB-02 | The task code LUB-02 is used when a lubrication task is recorded. | correct |
| A13 | What should I do if a bearing is noisy or hot after greasing? | report it on the same work order; tell the maintenance lead | If a bearing is noisy or hot after greasing, report it on the work order and tell the maintenance lead. | correct |
| A14 | What does fault F12 mean and what should be checked? | low bowl level; product supply valve PV-3; level in the product tank | Fault F12 means low bowl level. Check the product supply valve PV-3 and the level in the product tank. Do not override the level switch. | correct |
| A15 | How do I recover from fault F21? | stop the infeed and clear the jammed bottles; reset the fault at the panel; restart in jog mode | To recover from fault F21, stop the infeed, clear the jammed bottles, reset the fault at the panel and restart in jog mode before switching back to automatic. | correct |
| A16 | What should I do when fault F33 appears? | switch to CO2 bank B; tell the shift lead | (no answer returned) | not answered |
| A17 | How many filling valves may be isolated before the filler must be stopped? | at most 2 valves; stop the filler and call maintenance if a third leaks | At most 2 filling valves may be isolated before the filler must be stopped. | partly |
| A18 | Above what product temperature must filling be held? | above 6 °C; call quality | Filling must be held if the product temperature is above 6 °C. | partly |
| A19 | How often is the vibration of the main drive checked? | monthly; hand-held vibration meter | The vibration of the main drive is checked monthly using a hand-held vibration meter. | correct |
| A20 | Where is the main disconnect for Line 2? | electrical cabinet E3 | The main disconnect for Line 2 is in electrical cabinet E3. | correct |
| A21 | How is stored air pressure released during lock-out? | open valve V-9; on the pneumatic panel | Stored air pressure is released by opening valve V-9 on the pneumatic panel. | correct |
| A22 | How do I verify zero energy after locking out? | press the start button; nothing may move | To verify zero energy after locking out, press the start button. Nothing may move. If anything moves, stop and call the maintenance lead. | correct |
| A23 | What happens if the key of a lock-out lock is lost? | the lock is cut only with the shift lead and the plant manager present; recorded in the LOTO register | If the key of a lock-out lock is lost, the lock may be cut only with the shift lead and the plant manager both present as witnesses, and the event is recorded in the LOTO register. | correct |
| A24 | Who must be told before a machine is locked out? | the operator of the machine; the shift lead | The operator of the machine and the shift lead must be told before a machine is locked out. | correct |
| A25 | What is the OEE target for Line 2? | 78 % | The OEE target for Line 2 is 78%. | correct |
| A26 | Which star wheel set is used for 500 ml bottles? | set B | Star wheel set B is used for 500 ml bottles. | correct |
| A27 | What is the guide rail setting for 500 ml bottles? | 72 mm | The guide rail setting for 500 ml bottles is 72 mm. | correct |
| A28 | By how much is the filler raised for 500 ml bottles? | 40 mm | The filler is raised by 40 mm for 500 ml bottles. | correct |
| A29 | Which label roll is used for 500 ml bottles? | 500-L | Label roll type 500-L is used for 500 ml bottles. | correct |
| A30 | How many first-off bottles go to the lab after a changeover? | 3 bottles; wait for lab approval before full speed | 3 first-off bottles go to the lab after a changeover. | correct |
| A31 | What was wrong with rinser nozzle 7? | it was blocked; it was replaced | Rinser nozzle 7 was blocked and has been replaced. | correct |
| A32 | What temperature is the labeler glue station set to? | 160 °C | The labeler glue station is set to 160 °C. | correct |
| A33 | When is the refill for CO2 bank A expected? | Thursday | The refill for CO2 bank A is expected on Thursday. | correct |
| A34 | How often are the capping chucks inspected? | monthly; for wear and cracks | The capping chucks are inspected monthly for wear and cracks. | correct |
| A35 | How often are the capper springs replaced? | every 6 months; earlier if a head gives low torque readings | Capper springs are replaced every 6 months, or earlier if a head gives low torque readings. | correct |
| A36 | What cap size is used on Line 2? | 28 mm; for both 330 ml and 500 ml | The cap size used on Line 2 is 28 mm. | partly |
| A37 | What is the fill level specification for 500 ml bottles? | 500 ml ± 5 ml | The fill level specification for 500 ml bottles is 500 ml ± 5 ml. | correct |
| A38 | What cap removal torque is allowed in quality sampling? | between 1.2 and 2.0 Nm | The cap removal torque allowed in quality sampling is between 1.2 and 2.0 Nm. | correct |
| A39 | What happens to a pallet when a sample is out of specification? | held with a yellow HOLD tag; tell the shift lead and the quality lab | When a sample is out of specification, the pallet is held in production with a yellow HOLD tag. The shift lead and quality lab must be notified, and the sample is recorded in the quality log with the time and line speed. | correct |
| A40 | What is the CO2 content target for sparkling water? | 5.5 g/L | The CO2 content target for sparkling water is 5.5 g/L. | correct |
