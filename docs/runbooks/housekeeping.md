# Runbook — the housekeeping command

**Who runs this:** the LegacyAI platform operator (today: the founder).
**State on 2026-10-04: NOTHING SCHEDULES THIS COMMAND.** It runs only when someone starts it. The plan-only
Terraform schedules two other jobs (the nightly backup and the daily audit anchor) and not this one. Until it is
scheduled, run it once a day by hand, or accept what "What happens if it is not run" says below.

## What it does

One command, three jobs, for every company:

1. **Cards that have expired are written down as expired** (state, usage history, audit row) and renewal notices
   go out. Whether a card works never depends on this: the API treats a card as expired the moment its date passes.
2. **Retirement radar:** the nudges that have become due (less than 24, 12 and 6 months before a recorded leaving
   date) are created, each once. A leaving date that passed more than 30 days ago is removed.
3. **Old rows are removed** from tables that otherwise only grow: sessions that ended more than 30 days ago, used
   or expired enrollment tokens, expired idempotency keys and sign-in transactions, old rate-limit windows, sign-in
   attempts older than 90 days. The audit log and the card usage history are never touched.

A job that fails is reported in the output and does not stop the other two; the command then ends with a failure
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

## What it does not do

It sends no e-mail (notices are written to the log until an e-mail service is chosen). It changes nothing in the
cloud. It never deletes audit rows.

## To schedule it later

Add a scheduled job next to `daily_anchor` in `infra/terraform/main.tf` (same pattern: a Cloud Run job that runs the
API image with the command `node dist/cli/housekeeping.js`, a scheduler entry, the job's service account, and the
matching entries in the cost guardrail check). This was deliberately not done in the same change as the command:
the Terraform checks cannot be run on the developer's computer, and Terraform is applied by the founder only.
