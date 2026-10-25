# Runbook — the housekeeping command

**Who runs this:** the LegacyAI platform operator (today: the founder).
**State on 2026-10-04: NOTHING SCHEDULES THIS COMMAND.** It runs only when someone starts it. The plan-only
Terraform schedules two other jobs (the nightly backup and the daily audit anchor) and not this one. Until it is
scheduled, run it once a day by hand, or accept what "What happens if it is not run" says below.

## What it does

One command, six jobs, for every company:

1. **Cards that have expired are written down as expired** (state, usage history, audit row) and renewal notices
   go out. Whether a card works never depends on this: the API treats a card as expired the moment its date passes.
2. **Retirement radar:** the nudges that have become due (less than 24, 12 and 6 months before a recorded leaving
   date) are created, each once. A leaving date that passed more than 30 days ago is removed.
3. **Old rows are removed** from tables that otherwise only grow: sessions that ended more than 30 days ago, used
   or expired enrollment tokens, expired idempotency keys and sign-in transactions, old rate-limit windows, sign-in
   attempts older than 90 days. The audit log and the card usage history are never touched.

4. **Billing:** renewal reminders (30, 14 and 3 days before a company's renewal date, and once during its
   read-only days) are created, each once; for a company that switched automatic renewal on, a renewal is started
   from one day before the date (at most 3 attempts). An invoice nobody answered is closed: an automatic one after
   3 days, one the Owner started after 14. Each company and each step runs by itself; a failure is printed with
   the company's id and the reason (`billing.failures`), and the command ends with a failure code.
   With no payment provider connected, automatic renewal does nothing. See docs/phase4/05-billing.md.
   It also FINISHES payments that are on record but whose next steps did not happen (the service stopped in
   between): `billing.finished` counts them. Each is put into effect if possible, otherwise reported once.

5. **Outgoing webhooks and e-mail (Phase 4, docs/phase4/06):** one delivery run, the same as
   `npm run outbound:deliver` (see `docs/runbooks/outbound-delivery.md`). It does nothing unless
   `WEBHOOK_DELIVERY=https` or an e-mail sender is configured. Old webhook events and deliveries and old queued
   e-mails (30 days) are removed with the other old rows in job 3.

6. **The knowledge service's own housekeeping (added 2026-10-25):** for every customer company, the command asks the
   AI service (`AI_SERVICE_URL`) to do its part: verified items past their date become stale, expired questions to
   experts and test attempts are closed, answers older than the company's retention time are removed, and content
   saved before 2026-10-25 is locked with the company's key (see "Locking older content" below). Until this date
   nothing called that part at all. Each company runs by itself; a failure is printed with the company's id and the
   reason (`knowledge.failures`), and the command ends with a failure code.

A job that fails is reported in the output and does not stop the others; the command then ends with a failure
code.

## How to run it

From `services/api`, with the same configuration the API uses (database address and keys in the environment):

```
npm run housekeeping
```

`npm run cards:sweep-expired` is the old name of the same command and still works.

It prints one line of JSON, for example:

```
{"swept":0,"retirement_nudges":2,"purged":{"sessions":14,"enrollment_tokens":1,"idempotency_keys":30,"global":5}}
```

A job that failed shows as `{"failed":"..."}` in its place.

Running it twice in a row is harmless: every nudge is created once, and there is nothing left to remove the
second time.

## What happens if it is not run

- **Retirement nudges do not appear.** Setting a leaving date creates the nudge for the stage the date is in on
  that day. The later stages (12 months, 6 months) appear only when this command runs. The radar screen itself is
  always right: it works out the stage from the date when it is opened.
- Leaving dates that have passed stay stored until the person is marked as departed (which removes the date at
  once) or this command runs.
- Expired cards are still refused, but their expiry is not written into the usage history and no renewal notice
  goes out.
- The tables named in job 3 keep growing.
- **No renewal reminder is created and automatic renewal is never tried.** A company's term still ends on its
  date, and the Owner can still renew by hand on the billing screen.
- **Knowledge housekeeping does not happen:** items past their date are not marked stale (answers already treat an
  overdue item as stale), old answers are kept past the company's retention time, and content saved before
  2026-10-25 stays readable in the database.

## Locking older content (decision D41, step 5)

Since 2026-10-25, documents, item texts and titles, interview questions and answers, the questions people ask,
questions to experts, readers' comments, the words a stored conflict quotes, and readiness questions and answers are
stored locked with the company's key. What was saved before is still stored
readable. Job 6 locks it, a little at a time: per company and run at most 200 rows of each kind per round, rounds for
at most 8 seconds.

1. Run the command as usual. In the output, under `knowledge`:
   - `sealed_chunks`, `sealed_versions`, `sealed_turns`, `sealed_questions`, `sealed_expert_questions`,
     `sealed_feedback`, `sealed_titles`, `sealed_conflicts`, `sealed_quiz_questions`, `sealed_quiz_answers`: how many
     were locked in this run (all companies together);
   - `readable_` with the same ten names: how many are still readable after this run;
   - `seal_key_unavailable`: how many companies were skipped because their key cannot be used right now (switched
     off, permission taken back, or the key service did not answer). Their content stays as it is; nothing is half
     done. It is tried again on the next run.
2. Run it again until all `readable_` numbers are 0. Running it more often is harmless: a locked row is never
   locked twice, and each run only does a bounded amount of work.
3. A company with its own key that is switched off is never locked with another key: its readable rows stay
   readable until the key works again. Tell the company if `seal_key_unavailable` stays above 0.

Nothing here needs a person to look at content, and the command never prints any of it. Once every company shows 0,
the readable columns can be removed by a later change (step 5 part 2, not built).

## What it does not do

It sends no e-mail (notices are written to the log until an e-mail service is chosen). It changes nothing in the
cloud. It never deletes audit rows.

## To schedule it later

Add a scheduled job next to `daily_anchor` in `infra/terraform/main.tf` (same pattern: a Cloud Run job that runs the
API image with the command `node dist/cli/housekeeping.js`, a scheduler entry, the job's service account, and the
matching entries in the cost guardrail check). This was deliberately not done in the same change as the command:
the Terraform checks cannot be run on the developer's computer, and Terraform is applied by the founder only.
