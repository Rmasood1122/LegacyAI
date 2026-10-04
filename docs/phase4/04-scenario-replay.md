# Phase 4, step 4 — scenario replay (feature 8)

> Written 2026-10-04. **Built, and checked locally only as far as that is possible without a database**: the database,
> both-services and browser tests run on GitHub and had not run when this note was written. Nothing is deployed. No
> paid AI call was made; grading was exercised with the fake AI only. Decision D28.

## In plain language

A reviewer writes a **scenario**: a situation at work ("what would you do if ...") and up to ten **steps**. Each step
asks one question, is tied to verified knowledge, and has **expected points** - what a good answer contains. A
**second person approves** it. A learner then works through it step by step in their own words, hands it in, and
gets a score per step and a pointer to what to read again. A reviewer can change a score.

It reuses the readiness test's machinery: the same permissions, the same grading (the AI says which expected points
an answer meets, the score is computed in code), the same rule that the learner never sees the answers beforehand.

## What exists

| Part | What it does |
|---|---|
| Writing | Title, situation, job role, 1-10 steps; per step a question, 1-5 linked items, 1-6 expected points. Free text is redacted before it is stored. "Suggest points (AI)" proposes points from the linked items for the writer to edit; nothing is stored by it |
| States | draft → approved (by a second person) → retired. Editing an approved scenario makes it a draft again and makes the editor its last editor. A scenario that has been run cannot be edited. Saving and approving carry the version the person read; if somebody changed the scenario since, nothing is saved or approved (409 `changed-meanwhile`) |
| Offering | A learner is offered a scenario only if it is approved and every linked item is verified, released to learners (level 0) and readable by that learner |
| Running | One run per start, with the company's test time limit; at most 3 runs per learner and scenario per day (each hand-in costs up to ten grading calls of the company's AI allowance). Answers are saved as typed (on leaving a field); handing in is once and needs a second click |
| Grading | Per step: no answer = 0; otherwise the readiness grader. With no usable grade (no AI allowed, refused, invalid) or a low-confidence one, a review task of the kind "grading override" is opened, exactly as for a readiness answer, and the run stays "handed in" until a person has decided. A reviewer can override any step, but not in their own run (409 `own-attempt`) |
| Result | **The learner:** own answers always; scores only once the run is GRADED; expected points, which were met, and "read this again" only if, in addition, the company shows answers after grading - the same rule as the readiness test. A run that expired or still waits for a person shows the learner nothing but their own text, so letting a run expire teaches nothing. **A reader of results who is not the learner:** scores, points and items in every finished state. "Met" is what the code counted (the evidence is really in the answer), not what the model claimed |
| Keeping it true | A scenario carries the labels of its items (the highest level; a department only if all share it). If a linked item stops being verified OR is re-labelled, the scenario takes the new labels, goes back to draft, flagged, and runs in progress end. A reader who may no longer read every linked item gets neither the scenario nor a run of it. If a linked item is withdrawn, the scenario is retired and hidden at once; its words are erased by the erasure step (see Erasure) |

Fifteen operations (156 in total), five tables, one trigger on knowledge items. No permission or role grant was
added, and no new database grant on the readiness tables was needed (the AI service's login could already change
`quiz_answers`).

## How the learner is kept from seeing the expected points

Four layers, each tested on its own:

1. **Writing:** a scenario is refused if an expected point appears, word for word (ignoring case and punctuation), in
   the title, the situation or any step's question (`leak_reason`, the same idea as the readiness answer-leak guard).
   The editor shows the same check before sending.
2. **AI service:** what a learner can request never contains the points. The steps a learner gets when starting come
   from ONE projection (`learner_steps`) whose query does not even select the points; the reviewer's view is a separate
   query (`review_steps`). A run is shown through `visible_steps` and `released()`: scores only when the run is
   **graded**; expected points, which of them were met and "read these" only when it is graded and - for the learner -
   the company shows answers after grading. A run that is in progress, **expired**, still **waiting for a person**,
   or in a state the code does not know shows the learner's own words and the status, nothing more: letting a run
   expire teaches nothing. The answer says in so many words what it released (`scores_released`, `points_released`).
   The full scenario with its points is a separate operation that needs `quiz:read`, which learners do not hold.
3. **API:** its own rule, not a copy (`runSteps`, a pure function): scores are passed on only when the run is graded
   AND the AI service said `scores_released`; points only when it also said `points_released`. Otherwise four named
   fields per step and nothing else, whatever the AI service sent (unit-tested with a hostile answer, and again with
   the stand-in service). The readiness test had the same weakness - its mapper passed on a correct option whenever
   one arrived - and now follows the same rule (`attemptQuestions`).
4. **Screen:** the running view's step type has only those four fields; scores and points are drawn only for what
   the API sent; an unknown state counts as "still running" (tested by handing the screen leaked data). A run that
   waits or expired says so where the score would be.

What this does not cover: a point paraphrased in the question (the guard matches words, not meaning), and a
reviewer who tells a learner the points.

## Who can see what

| | Learner (Successor) | Reviewer (Expert during the pilot) | Admin | Owner |
|---|---|---|---|---|
| Scenarios offered to me, start, answer, hand in | yes | no | no | no |
| My own runs and results | yes | no | company's runs | company's runs |
| Write, edit, approve, retire; the writers' list; a scenario with its expected points | no | yes | yes (pilot grant) | read only |
| Override a step's score | no | yes | yes (pilot grant) | no |

This is the readiness test's table, unchanged. Its known gap applies here too and is NOT closed: a reviewer who may
override a score cannot open another person's run unless they also hold the right to read results (Admin does). The
grading task tells them a step waits, but only an Admin can read the answer and decide.

In a scenario with its points, the title of a linked item is given only for items the reader may read; the others are
named by id and state.

## The second-person rule

**Neither the person (or card) who created a scenario nor the one who last edited it may approve it; anyone else who
may approve can.** "A writes, B makes a small edit, A approves" is refused for A and for B.

- Decided by the API's policy decision point, like the rule for knowledge items, and recorded in the audit log as
  `DENY_SELF_REVIEW` (403). The route names the writers to the policy (`not_by`).
- Checked again by the AI service and by a database guard (person and card), as defence in depth.
- All three honour the company setting `second_reviewer_required` (only the Owner can switch it off).
- **Readiness test questions had no such rule (a Phase 2 gap).** It now applies to them too: who generated a
  question and who last edited it are recorded (four new columns on `quiz_items`), and neither may approve it.
  Questions written before this change name nobody and can be approved by anyone who may approve.
- The rule cannot be left out by omission. The two approving operations (`approveScenario`,
  `approveQuizQuestion`) can only be registered through `approvalRoute()`, whose resource must name the writers
  (a typed `ApprovalRef`; a plain route for them is refused when the routes are built), and the policy refuses a
  resource marked as an approval that names nobody. Behind the policy: for scenarios the AI service and a database
  guard (person and card), for test questions the AI service (`set_question_status`).
- Limit: a THIRD approving operation added later is only covered if it is added to that list.

## Erasure and retention

A consent withdrawal sets the contributor's items to "withdrawn" inside the database. One more trigger on that
change **hides** every scenario tied to the item: it is retired with the flag "item withdrawn", runs in progress end,
and from then on neither service returns the scenario or its runs to anybody. **Nothing is blanked by the trigger.**

The words go in the **erasure step** - the same request that erases the item's own text: the situation, and the
question and expected points of every step tied to the item, are blanked and the link is removed. **Under a legal
hold erasure is suspended (docs/phase2/05), so the words stay, hidden, until the hold is released.**

- This is the opposite of what decision D25 does for conflict excerpts (deleted at withdrawal, also under a hold).
  Both are readings of the Phase 2 design, not legal opinions; **D25 needs the same founder or legal decision.**
- Kept after erasure: the title (ASSUMPTION: it does not quote the item), steps tied only to other items, and the
  learners' own answers - which may quote the withdrawn knowledge. That last point is not solved.

**Hidden is not erased.** Whether a scenario is hidden is computed from its links (`scenario_is_hidden()`): it is
hidden while ANY linked item is withdrawn and still linked. Erasure removes the link, so the case "one item was
erased long ago, a second one is withdrawn under a hold" hides the scenario again. `erased_at` only says that words
were blanked. A retired scenario still follows the level and department of its items.

**Retention.** After `quiz_answer_retention_days`, counted from the day a run was GRADED (or expired unfinished),
the housekeeping sweep removes what learners wrote and what the model said about it, from scenario runs AND from
readiness tests; the run, its scores and who decided them are kept, and the step says "removed after the retention
period" instead of showing an empty answer. A step that still waits for a person is never emptied. Each pass takes
the oldest rows that still hold text, so it always makes progress.
The setting existed since Phase 2 but nothing applied it (a Phase 2 gap, now closed). Like every housekeeping step
it runs only when the housekeeping command is run; nothing schedules that yet (docs/runbooks/housekeeping.md).
There is still no deletion of a learner's runs when the learner leaves.

## Grading by a person (nobody grades blind)

A step the model could not grade, or graded with low confidence, opens a review task. The grader opens the step from
that task (`GET /v1/scenario-answers/{id}`, right `quiz:grade`): the question, the learner's words, the expected
points and what the model made of it. Reading and scoring follow ONE rule, applied by the AI service: the run is
handed in, it is not the grader's own, and the step either waits for a person or belongs to a run the grader may read
anyway (`quiz:read_results`). The scenario's level and department are checked by the policy (403). So a Reviewer or
an Expert can act on a waiting step without the right to read everybody's results, and cannot change the score of a
step they could not read (404).

- A run already handed in whose items the LEARNER may no longer read can still be graded by a person who may read
  them; the learner sees the status only.
- The readiness test is NOT changed in this respect: its override still needs only `quiz:grade` and an answer id
  (no read, no check of what the grader may read), and only a card holding both `quiz:grade` and
  `quiz:read_results` - today the Admin, through the pilot grant - can open a readiness attempt to see what it is
  grading. Known limit, written down, not fixed here.

## What it cannot do

- Text only. No branching ("if you answered A, go to step 4"), no pictures, no timing per step.
- **How well the AI grades scenario answers is unmeasured.** Only the fake AI was used. A real measurement needs a
  paid evaluation run, which the founder has not approved.
- The leak guard is literal; the redaction of the writer's text can blank an ordinary word (see Phase 3 report).
- No review task announces a scenario that waits for approval or was flagged; the writers' list shows it.
- A reviewer without the right to read results cannot open the run a grading task points to (see above).
- One learner can still use up the company's hourly AI allowance within the daily cap of runs.
- Offers examine at most 200 approved scenarios per request and say when that cut the list short.
- A scenario that has been run cannot be changed, only retired and rewritten; there is no "copy as new".
- An edit cannot be approved by its editor even if the edit was trivial; nor by the scenario's creator, ever.

## Data added

`scenarios`, `scenario_steps`, `scenario_step_items`, `scenario_attempts`, `scenario_answers`
(migration `20261004000300_scenarios.sql`): tenant id and composite keys on every table, forced row-level security,
state guards as triggers (a new scenario is a draft; legal state changes only; the steps of an approved scenario
cannot change; neither creator nor last editor can approve; an attempt is handed in once and within its time). The
API login may read labels and links only. Also: one more subject type for review tasks (`scenario_answer`), and four
columns on `quiz_items` recording who generated and who last edited a question. The rollback removes all of it.
