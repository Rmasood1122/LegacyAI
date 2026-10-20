# Runbook — sending webhooks and e-mail (`npm run outbound:deliver`)

**Who runs this:** the LegacyAI platform operator (today: the founder).
**State on 2026-10-06: both are OFF by default, and NOTHING SCHEDULES THIS COMMAND.** No webhook and no e-mail
leaves the server until the configuration below is changed AND this command runs. No real e-mail service is
connected at all yet.

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

Not possible yet: only `none` (default) and `fake` (sends nothing; accepted only in automated tests) exist. A real
e-mail service needs (1) the founder's choice of service, (2) a sending domain with SPF, DKIM and DMARC records,
(3) one new `MailSender` implementation in `services/api/src/modules/mail/`, (4) `MAIL_FROM` set to an address on
that domain. Nothing else changes.

## What happens if it is not run

- Webhooks: nothing is sent. Events wait in the outbox and are removed after 30 days by housekeeping.
- E-mail (once a sender exists): queued notices wait; they are still written to the log as before.

## Checking

- The Owner's "Webhooks" screen shows each endpoint's state, its last delivery and its last messages.
- Paused endpoints: audit reason `WEBHOOK_PAUSED`. Switching the endpoint on again (Owner) clears the pause.
- Nothing a receiver answers is stored, except the HTTP status code.
