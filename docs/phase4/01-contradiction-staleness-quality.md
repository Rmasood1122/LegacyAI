# Phase 4, Batch A, step 1 — contradiction and staleness detection (23), answer quality monitor (22)

> Written 2026-10-04. What is described here is in the code; what was measured, and where, is stated at each claim.
> Plan: `docs/phase4/00-plan.md`. Decision: D25 in `docs/decisions.md`. No paid AI call was made for this step.

## In plain language

The real-model evaluation (`docs/phase2/EVALUATION.md`) showed one weakness above all: when two documents gave
different values, the model twice answered from one of them with confidence. Until now only the model could notice a
conflict. This step adds **a check in code that runs after every answer, whatever the model said**: if another
source the reader may see states a different value for something the answer says, the answer is withheld and the
reader is shown both values and where each comes from.

It also adds a way to see how answers are going: what readers say about them, and weekly counts from the answer log.

## 1. The contradiction check (`services/ai/app/knowledge/conflicts.py`)

Pure code: no model, no database. From each source it reads statements of the form "some quantity has this value" —
a number with a unit, an interval ("every 30 minutes"), a rate ("180 bottles per minute"), a count, and plain
must / must-not pairs — and reports a conflict when two **different** sources give different values for what is
recognisably the same quantity.

"The same quantity" is decided by rules a person can read:

- the same kind of measure (pressure with pressure, an interval with an interval);
- the two sentences share enough content words (their own, plus the nearest heading);
- neither sentence carries a qualifier the other contradicts (500 ml bottles vs 330 ml bottles, head 4 vs head 2,
  Line 1 vs Line 2): those are different cases, not a disagreement;
- equal values in different units agree (0.5 h and 30 min), and a value inside a stated range agrees with the range;
- statements of one document are never set against each other.

It prefers missing a conflict to inventing one.

**Measured (run locally and in CI, `tests/knowledge/test_conflicts_golden.py`):**

| Set | Result |
|---|---|
| 32 conflict pairs written with the rule | 32 found |
| 32 look-alike pairs that do not disagree, written with the rule | 0 wrongly flagged |
| The 8 planted conflicts of the evaluation set, cited from either side (including the two a real model answered from one side: sampling interval 30 vs 60 minutes; CO2 alarm 3.0 vs 3.2 bar) | 8 found |
| 33 answerable questions of the evaluation set | 0 refused by the check |
| **Held out:** 10 conflict pairs about other workplaces (a bakery, a warehouse, an IT desk), written after the rule, spread over two sentences, with the second source cited; word lists not changed for them | 10 found |
| **Held out:** 10 look-alike pairs of the same kind | **4 wrongly flagged** |

The first four rows were written by the author of the rule and partly share its vocabulary, so they show that the
rule does what it was written to do. The held-out rows are the better estimate of unfamiliar text, and they show the
weak side: **the rule tells two cases apart only by a label word it knows, a code, or a second differing value.**
"Dough pieces for baguettes weigh 350 g" and "dough pieces for rolls weigh 80 g" are read as a conflict. A wrong
flag costs an answer (a refusal that should not have happened), never a wrong answer. 20 pairs are a small sample.

**What it cannot catch:** contradictions in prose without a number or a plain must / must-not pair; values written as
words ("twice a day"); values spread over several sentences; tables whose header carries the meaning; any language
other than English. It also cannot tell which of two values is right. The API says this in the description of
`conflicts`, and the Ask screen says it where conflicts are shown: **an empty list does not mean the sources agree.**

**Its cost is bounded by construction**, because documents and questions are not trusted input. A security read
of the first version measured 10.9 seconds for one text of 12,000 characters of comma-separated digits, and about 14
seconds for one item compared with fifty others. The bound no longer rests on each pattern being well behaved:

- **Pieces.** One forward scan cuts a text into pieces of at most 600 characters and 32 numbers (a normal sentence is
  one piece). Patterns are applied only to one such piece, never to a growing part of the text, and every repetition
  in every pattern has an upper limit.
- **Limits while reading.** Only the first 12,000 characters, 1,500 numbers and 150 statements of a source are read;
  reading stops there, in the middle of the scan.
- **One work budget.** Every loop spends from one budget of 300,000 steps per check (characters read, pairs looked
  at - also the pairs passed over - and sibling values looked at). When it is used up, the check stops with what it
  has. At most 6,000 pairs are compared and 20 conflicts reported.
- **Each text is read once.** An item is compared with the others in ONE check, not one check per other item.

**What "partial" means.** When any limit was reached the check did not look at everything, so "no conflict found"
means less. For an answer this is `conflict_check_partial: true` and one sentence on the Ask screen. For verified
items (more than 25 others on the same topics, or a limit reached) it is a row in the audit log with the reason
`ITEM_CONFLICT_CHECK_PARTIAL`; there is no mark on the item itself.

Measured on this computer (`tests/knowledge/test_conflicts_cost.py`), each input at 2,000, 6,000 and 12,000
characters, one check of one text and one check of two texts together: the comma-separated digits 0.07 / 0.14 / 0.13
seconds (before: 10.9 at 12,000); percentages without a sentence break 0.06 / 0.04 / 0.05 (before: 2.6); nine more
inputs written to be as bad as the author could make them (long runs of letters, thousands of tiny sentences, digits
and white space from other scripts, one enormous token, alternating units, repeated "must not", ranges, "every" and
"at most" before each number) between 0.01 and 0.12 seconds. The tests assert, without a clock, that the steps never
pass the budget and that six times the text costs at most eight times the steps; and, with a clock, a generous
1 second. The largest step count seen was 24,000 of 300,000. These inputs were written by the author of the fix;
someone else may find a worse one, which the step budget would still stop.

What the cutting costs: a sentence longer than 600 characters, or with more than 32 numbers, is read in pieces, and a
statement that straddles a cut can be missed or lose its "at most" / "every".

**One planted sentence can force refusals.** Any passage the reader may see, verified or not, that states a
different value for the same thing makes every answer citing the other value a refusal. That is the design: the
check cannot know which side is right. It cannot make an answer appear, only disappear. Nobody is told automatically
when a document causes this: there is no review-task kind for "two documents disagree" (item-to-item conflicts have
one). The quality page counts such refusals per week, which is how a company would notice.

**Where it runs:** in the answer flow (`knowledge/answers.py`), after retrieval, the permission re-check and the
citation check, on the same passages the model saw. The outcome is "I don't know — the sources conflict", the answer
log records **who found it** (`value_check`, the comparison in code, or `ai_model`), and the reply carries up to five
conflicts in the sources' own words, each side with the same kind and id as a citation.

**Not measured:** its effect with a real model. The fake provider can now answer "from one side" so CI shows the
check catching it; whether the two real failures are caught through the full service with a real model needs a paid
evaluation run, which has not been asked for.

## 2. Verified items that disagree (`knowledge/item_conflicts.py`)

When an item becomes verified or corrected, or its topics change, it is compared with the other verified items that
share a topic with it (at most the 25 newest). A conflict is stored once per pair and opens a review task ("Two
verified items disagree") on each. The item's page shows both values and links to the other item.

**If the reader may not read the other item**, the page shows one line - "it disagrees with an item you may not
read" - and nothing else: not the kind of value, not this item's value, not how many such items there are. What this
still gives away, stated plainly: that a restricted item on a shared topic states a different value. Someone who can
get items verified could use that as a yes/no signal about a restricted number. It is shown anyway, because a reader
must know not to rely on the item.

The conflict goes by itself when it no longer holds: one item is corrected so the values agree, or leaves the
verified state. That is done in ONE place - the function every status change goes through - so a new way of leaving
the verified state cannot forget it (a proposed new version and a reverted verification did, in the first version of
this step). Where an item's text is erased (consent withdrawal, a withdrawn document) the stored words of both sides
are deleted and the partner item loses its mark and its task.

Limits: items with no topic in common are not compared; of more than 25 items on shared topics only the 25 newest are, and that the comparison was partial is written to the audit log.

Conflicts also end inside the database: a trigger on the items table (`knowledge_items_end_conflicts`, in this feature's migration) deletes an item's stored conflicts, with the words they quoted, and closes the partner's task in the same statement that moves the item out of the verified state. That covers the one path Python does not see: consent withdrawal, where migration 15 sets items to "withdrawn" in the transaction that records the withdrawal. It also applies under a legal hold. The hold suspends the erasure of the held material itself (phase 2, document 05); the conflict row is a copy of a few of its words in another table, and hidden material must not stay quoted there. The Python clearing in `items._move` is kept as well, so either alone is enough.

## 3. Staleness

Already built in Phase 2 and found working: the daily sweep marks verified items older than the company's
"stale after" setting as stale and opens a task; re-verifying clears it. Added here: a stale item's conflicts end
with it, and the new screen lists the open "verified long ago" tasks beside the conflicts.

## 4. Answer quality monitor (`knowledge/quality.py`)

- **Readers' feedback.** Under every answer a reader can say helpful, unhelpful or wrong, with an optional comment
  of up to 500 characters that is redacted before it is stored. One opinion per card and answer; only the card that
  received the answer may give it. It can be replaced (the whole opinion: a comment left out is removed), read back
  and taken back. A change to "wrong" opens a review task; a change away from "wrong", or taking it back, closes it;
  saying "wrong" again does not reopen a task a reviewer dismissed.
- **The question stays private unless the reader shares it.** Before this feature nobody could read what a person
  had asked. That is unchanged by default: the people who look after quality (Owner, Admin) see the opinion, the
  comment and how the answer ended. Only if the reader ticks "Let reviewers see my question" is the redacted question
  shown with that opinion. In a small company an opinion can often be traced to a person even without the question.
- **Who can act on a "wrong" task:** the task appears in the review queue for every reviewer, but what the reader
  said can be read only by roles with the quality page (Owner, Admin). For other reviewers the task says that a
  reader marked an answer wrong and nothing more.
- **Weekly counts** from the answer log: questions, answered, "I don't know" by reason, conflicts found by the value
  check and by the AI model, citations removed by the check, answers naming a source they were not given, answers
  containing sources nobody verified, and the feedback counts. A week in which nothing happened is left out; the
  current week is partial; weeks older than the retention setting are gone.
- **Retention.** Feedback is deleted with its answer-log row (the company's retention setting); tasks about answers
  that no longer exist are closed by the sweep.

**What it cannot tell:** whether an answer was true. It reports what was logged and what readers said.

## 5. Data added (migration `20261004000100_quality.sql`, with rollback)

- `answer_logs`: `conflict_found_by`, `contains_unverified_sources`.
- **Rows of every company are changed by this migration, in both directions** (existing "sources conflict" refusals
  get their finder; tasks of the two new kinds are removed on the way down). The role that runs migrations cannot
  bypass row-level security and the policy is forced on the table owner too, so a plain UPDATE or DELETE would match
  nothing - the first version of this migration would have failed on any database that held such rows, in either
  direction. No earlier migration had to change rows of every company, so there was no pattern to follow; this one
  lifts the forcing for the table's owner for the one statement and restores it in the same transaction.
  Tested by `services/ai/tests/integration/test_quality_migration.py`, which runs the migration's own SQL, down then
  up, as the migration role on a database that holds such rows (the migrations check in CI uses an empty database
  and cannot show this). ASSUMPTION: in a deployment the migration role owns the tables, as it does when it creates
  them.
- `answer_feedback` and `knowledge_item_conflicts`: per-company rows, forced row-level security, owned by the AI
  service's database login; the API's login has no access to them.
- Two new kinds of review task: `item_conflict`, `answer_feedback`.

## 6. Operations added (129 in total)

| Operation | Permission | Notes |
|---|---|---|
| `PUT /v1/knowledge/answers/{knowledge_answer_id}/feedback` (putAnswerFeedback) | `knowledge:ask` | give or replace the opinion; only for an answer the card itself received, anything else is "not found" |
| `GET` on the same address (getAnswerFeedback) | `knowledge:ask` | the card's own opinion |
| `DELETE` on the same address (withdrawAnswerFeedback) | `knowledge:ask` | take it back |
| `GET /v1/quality/summary` (getQualitySummary) | `knowledge_settings:read` | company-wide counts; declared unfiltered, so a narrower grant would be refused (D23) |
| `GET /v1/quality/feedback` (listAnswerFeedback) | `knowledge_settings:read` | readers' opinions and comments of every department, and shared questions; declared unfiltered with its own reason; paged |

`askKnowledge` now also returns `answer_id`, `conflict_found_by`, `conflicts` and `conflict_check_partial`;
`getKnowledgeItem` returns `conflicts`. No permission and no grant was added (D25).

## 7. Screens

- Ask: the two conflicting values, each linked to its source where the card may open it, who found the conflict, what
  the comparison cannot find; the feedback control with the unticked "Let reviewers see my question" box and "Take it
  back". The screen does not call getAnswerFeedback: an answer is not kept on the page after a reload.
- Knowledge item: a notice when the item disagrees with another verified item.
- "Conflicts and old items" (reviewers): the open tasks of the two kinds, and what the comparison cannot find.
- "Answer quality" (owner, admin): the weekly table, shares always shown with the numbers they come from, and what
  readers said.

## 8. Evaluation with the fake provider

`services/ai/eval/run.py` reports conflicts "refused by the check in code" separately from "refused by the model",
and counts answerable questions the check refused. For that run the fake provider quotes the best-fitting sentence
from one source and never reports a conflict. That behaviour is a script in `eval/one_sided.py`, set on the fake
provider by the evaluation; the provider class the service uses has no such switch. **A fake provider says nothing
about a real model.**

## Not proven

- Everything that needs the database or a browser was not run on the developer's computer; it runs in CI.
- No real-model run: the effect of the check on the measured weakness is shown only with the fake provider.
- False alarms on real documents (which would turn answerable questions into refusals) are unmeasured; the held-out
  set suggests they will be common where two cases differ only by an ordinary word (4 of 10).
- The migration test runs only in CI; whether the migration role owns the tables in a real deployment is an assumption.
- The API has no test of its own for the "restricted" conflict entry of an item; it is covered in the AI service and
  on the screen.
- Redaction of feedback comments is the same redaction as elsewhere, with the same known limits.
