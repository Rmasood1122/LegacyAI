# Runbook — sending webhooks and e-mail (`npm run outbound:deliver`)

**Who runs this:** the LegacyAI platform operator (today: the founder).
**State on 2026-10-06: both are OFF by default, and NOTHING SCHEDULES THIS COMMAND.** No webhook and no e-mail
leaves the server until the configuration below is changed AND this command runs. Since 2026-10-22 the code can
send through Resend (D36), but no Resend account or key is set up, so no e-mail has ever been sent.

Design: `docs/phase4/06-open-api-webhooks-email.md`, decision D31.

## What it does

One delivery run for every company, then it exits:

- **Webhooks:** knowledge events that the database wrote to the outbox become one message per endpoint that wants
  them; messages that are due are sent, signed; failures are tried again later (1 min, 5 min, 30 min, 2 h, 6 h,
  12 h, 24 h, then given up); an endpoint that keeps failing for more than a day is paused and the company's Owners
  are told.
- **E-mail:** notices raised since the last run (card locked, renewal reminder, retirement nudge, ...) are turned
  into one message per person they are for, and sent. Failures are tried again (5 min, 30 min, 2 h, 12 h).

Each company and each channel runs by itself. A failure is printed with the company's id and the reason, counted
in `failed`, and the command ends with a failure code; it does not stop the others.

## How to run it

From `services/api`, with the same configuration the API uses:

```
npm run outbound:deliver
```

It prints one line of JSON, for example
`{"webhooks_delivered":3,"webhooks_failed":0,"webhooks_paused":0,"events_published":2,"mails_sent":0,...,"failures":[]}`.
The housekeeping command runs the same delivery once as one of its jobs.

## Switching webhooks on

1. Set `WEBHOOK_DELIVERY=https` in the API's configuration (Secret Manager / environment). Default: `none`.
2. Make sure the server may open outgoing https connections to the internet (the Cloud Run service's egress).
   Webhooks are only ever sent to public addresses; the server refuses private, loopback, link-local and other
   special addresses itself, also when a public name resolves to one.
3. Schedule `npm run outbound:deliver` to run every minute (a Cloud Run job with Cloud Scheduler is the obvious
   choice; it is not in the plan-only Terraform yet - the founder decides). Without a schedule, messages are sent
   only when someone runs the command.

## Switching e-mail on

Through Resend (decision D36; details in `docs/phase4/06-open-api-webhooks-email.md`, part C, "Resend"):

1. In the founder's Resend account: add the sending domain (for example `mail.<your domain>`), add the SPF and DKIM
   records Resend shows at the domain's DNS, add a DMARC record, and wait until Resend says "verified".
2. Create a Resend API key with **sending access** only, for that domain.
3. Store it in Secret Manager as `RESEND_API_KEY` (never in a file). Set `MAIL_SENDER=resend` and
   `MAIL_FROM=LegacyAI <no-reply@mail.<your domain>>`. The API refuses to start if the key is missing or malformed,
   or if `MAIL_FROM` is on `localhost`.
4. Run this command once and check that the e-mail arrives (send yourself a notice from a test company first).

If e-mails stay queued: look in the log for `mail: Resend did not take a message`. It names the message and
Resend's error (for example `HTTP 403 validation_error`: the domain is not verified, or the key is wrong). Those
messages are tried again (5 min, 30 min, 2 h, 12 h), so fixing the set-up within about 15 hours loses nothing.

`fake` (sends nothing) is accepted only in automated tests.

## What happens if it is not run

- Webhooks: nothing is sent. Events wait in the outbox and are removed after 30 days by housekeeping.
- E-mail (with a sender configured): queued notices wait; they are still written to the log as before.

## Checking

- The Owner's "Webhooks" screen shows each endpoint's state, its last delivery and its last messages.
- Paused endpoints: audit reason `WEBHOOK_PAUSED`. Switching the endpoint on again (Owner) clears the pause.
- Nothing a receiver answers is stored, except the HTTP status code.
