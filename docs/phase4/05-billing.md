# Phase 4, Batch B step 1 — billing and renewal (features 29 billing part, 31, 32, 33, 34, 35)

> Written 2026-10-04, revised the same day after four reviews. **Built, and checked locally only as far as that is
> possible without a database**: the database tests and the browser test run on GitHub and had not run when this
> note was written. Nothing is deployed. **No payment provider is connected. No money can be taken. No account was
> opened and no payment service was called.** The prices in the catalogue are placeholders. Decision D29.

## In plain language

A company has **one renewal date**. It is the date on the company card, as Phase 1 decided: when it passes without a
renewal the whole company becomes read-only for the grace days, and after that only an Owner can sign in, to export
or to pay.

The Owner has a **renewal center**. It shows the renewal date, how many cards are in use against the seats paid for,
what the next term will cost, what can be paid right now, and the invoices. Paying issues an invoice and hands it to
the payment provider. **Nothing takes effect until the provider tells the API, in a signed message, that the invoice
was paid** (or the platform operator records the payment). Then it takes effect exactly once.

The payment provider is a **stand-in** that takes no money. A real one is a decision for the founder; what it still
needs is listed below.

## The rules, one sentence each

**Seats**

- A seat is one person card that is not revoked and not replaced.
- The **seat limit** is the number of seats the company PAID for in the running term. Only that number is enforced.
- A new company has no limit in its first term. Its first paid renewal sets the limit to the seats on that invoice.
- The Owner can **ask** for a number of seats; asking alone changes nothing that is enforced.
- Fewer seats than paid take effect at the next renewal, and never fewer than the cards in use that day.
- More seats than paid must be paid first: a "seats" invoice for the added seats, at the full price per seat for the
  term (no proration). The limit rises when that invoice is paid.
- While an invoice is waiting, seats cannot be changed.
- The Owner cannot remove the limit. Only the platform operator can remove it or set it by hand.
- When every seat is in use, issuing a card answers 409 `seat-limit-reached` (it used to be an unexplained 403). The
  refusal is still audited as `DENY_PLAN_LIMIT` and does not count towards the anomaly lock.
- The usage page (`getTenantUsage`) shows `seats` — limit, in use, state — as counts of cards, with no money.
  `plan.max_person_cards` there is an older, unused field (null for every plan); it is not the billing limit.

**Invoices**

- An invoice says what was due — kind, seats, days, amount, currency — and that never changes. The database refuses
  any change to it, and its deletion.
- A company has at most **one** unpaid invoice. The database refuses a second one.
- Asking to pay when an identical invoice is already waiting returns that invoice. If what is due has changed, the
  old invoice is closed and a new one issued, so an old amount is never collected.
- States: `open` → `paid`, `failed` (declined) or `void` (closed unpaid). `failed` and `void` → `paid_late`. `paid`
  and `paid_late` never change again. The same table is in the code (`nextStatus`) and in the database trigger.
- A paid invoice takes effect once: a renewal invoice starts a new term today and sets the seat limit; a seats
  invoice adds its seats. When one invoice takes effect, any other invoice still waiting is closed.
- An invoice nobody answered is closed by the housekeeping run: an automatic one after 3 days, one the Owner started
  after 14.
- An amount of 0 is settled at once ("no charge").

**A payment that is late or cannot be applied**

- Money that arrives for an invoice that was already declined or closed is **kept on record** (`paid_late`) and is
  **not applied**. The Owner and the platform operator are notified; the renewal center shows a warning.
- If an invoice was paid but the term could not be renewed at that moment, the invoice stays `paid` and "not in
  effect"; the Owner and the operator are notified. The provider still gets a normal answer, so it does not keep
  re-sending.
- A second "paid" for an invoice that is already paid is stored and flagged (the customer may have been charged
  twice). A message with another amount or currency than the invoice, or about an invoice or company that does not
  exist, is stored and flagged. Nothing signed is thrown away.
- In every such case the operator decides: apply it (below) or return the money outside this system. **There is no
  refund function.**

**The operator's manual payment**

- The operator names the invoice and what was paid. Another amount or currency than the invoice says is refused.
- It works for an invoice that is waiting, or one that is paid and not in effect. Anything else is refused. An
  invoice is settled once, whatever is retried.
- A renewal starts the new term today. If the running term still has days left, the request is refused unless the
  operator explicitly confirms that those days are lost.
- The company's own audit log says "operator" (no card of another company appears in it); the operator's log names
  the card. The reference is free text and is refused if it contains 12 or more digits in a row.

## What was paid must cover what is used (added after the second security read)

"Cards in use" means one thing everywhere: the company's person cards that are neither revoked nor replaced
(`CompanyTerm.personCards`, counted by the identity module). Three places use it, and they are the same number:

1. **When a renewal invoice is issued**, its seats are never fewer than the cards in use that day.
2. **While that invoice waits to be paid**, no person card is issued beyond its seats - also in a company's first
   term, where nothing else limits cards. Without this an Owner could revoke down to one card, start the renewal
   for one seat, issue the cards again and then pay for one seat. The refusal is the same typed 409
   `seat-limit-reached`; the usage page shows the tighter of the paid limit and the waiting invoice's seats.
   A company the operator freed from the seat limit is bound by its waiting renewal invoice all the same.
3. **When the payment arrives**, the cards are counted again, under the company's lock. If more cards are in use
   than the invoice's seats, the payment is kept on record and does NOT take effect by itself: the audit log says
   `PAYMENT_NOT_APPLIED_MORE_CARDS_THAN_SEATS`, the Owner and the operator are told, and the operator can put it
   into effect once the company revoked cards (or is refused with `more-cards-than-seats` until then).

What this does not close: a card issued in the same instant as a company's FIRST invoice, by a request that read
"no invoice, no limit" just before - step 3 is what catches it.

## A payment on record is finished or reported (added after the second security read)

A "paid" message is handled in up to three transactions. The first stores the message, marks the invoice paid and
writes the audit row `PAYMENT_RECEIVED` - so the log says money arrived whatever happens next. The second puts the
invoice into effect (`applied_at`). If that is not possible, the third writes why and tells people
(`attention_at`). A paid invoice with neither mark is **unfinished**: the process stopped in between.

- The same message delivered again answers `duplicate` (a normal 2xx) and **finishes** an unfinished invoice.
- The housekeeping sweep finishes every unfinished invoice of every company (`finished` in its result).
- Both are idempotent: an invoice takes effect once and is reported once (the database refuses a second time).
- A payment for a closed invoice (`paid_late`) is reported in the first transaction and never applied by itself.

**Nothing schedules housekeeping.** Until it is scheduled, closing unanswered invoices (3 / 14 days), reminders,
automatic renewal and this finishing sweep happen only when someone runs the command; a redelivered message is then
the only other thing that finishes an interrupted payment.

## How a provider's message is checked

The endpoint (`POST /v1/billing/provider-events`) is public: a payment provider has no card and no session.

Threat model, in short: anyone on the internet can call it; whoever can make the API believe "paid" gets a term
without paying. So the only thing that is believed is a signature made with a key that only the provider and the API
hold.

1. **No provider connected: everything is refused**, even a correctly signed message. A key that is configured by
   mistake does nothing.
2. **Signature.** HMAC-SHA256 over a version and every field, one per line. Compared in constant time. No key, a key
   shorter than 32 bytes, or a wrong signature: the same 403.
3. **The placeholder key from `.env.example` is refused in production**, like the other placeholder keys.
4. **Strict shape, then age.** Unknown outcomes, fractions, negative amounts, line breaks: refused. A message more
   than 5 minutes old or from the future: refused.
5. **Each message once**, by its id, per company.
6. **Rate limits:** 120 a minute per address, and 60 a minute per company once the signature is verified (the
   per-address limit depends on the proxy setting being right).
7. **One company only.** The work runs inside the named company's row-level security.
8. A badly formed body answers 400 (that reveals nothing about a signature); everything else that is not accepted
   answers the same 403. An accepted message always answers 200 with `applied`, `duplicate` or `recorded`.

## What a real provider still needs (not done)

- **Raw bytes.** Real providers sign the exact bytes of the request. Public routes now receive the request's
  headers, and the provider interface has a place for the raw body, but the server does not yet keep the raw bytes
  (`rawBody` is always empty). That is one more change in the HTTP layer.
- One new file implementing the provider interface (`start` a payment, `parseEvent` a message), its configuration,
  and an entry in `docs/DEPENDENCIES.md` after the 60-day check if a library is used.
- A decision about refunds, taxes and receipts.

The call to the provider already happens **outside** any database transaction: the invoice is stored first; a
provider that fails or does not answer in 10 seconds leaves an open invoice, no charge on record, and an answer of
502 or 503. Asking again collects the same invoice.
- **It must de-duplicate charge intents by invoice id.** When `start` does not answer in time, no reference is
  stored and the next attempt calls `start` again for the SAME invoice. The stand-in returns the same reference
  each time; a real provider must be asked with the invoice id as its idempotency key, or one invoice could be
  charged twice.
- A public route receives only the request headers it declares (none today). A real provider's signature header
  must be declared on the `receivePaymentEvent` route; cookies, `Authorization` and the CSRF token can never be
  declared.
- The stand-in provider starts only when `NODE_ENV=test`. Development and production refuse it.

## What was measured

Locally (no database): unit tests of the invoice state table (every state with every cause), the seat rules, what is
due when, the signature check including the version, the placeholder-key refusal, the policy rows for a company or a
card whose term ran out, and the screens against a stand-in API. Counts are in the report of this step.

Written and **not run when this note was written** (they need the database or a browser, GitHub only):
`services/api/test/integration/billing.test.ts` and `web/e2e/step4-billing.spec.ts`. The migration and its rollback
were written and read, not run.

Not covered by any test: closing an unanswered invoice after 3 or 14 days; a provider that times out; two requests
at exactly the same moment; the "term could not be renewed" path.

## What it cannot do

- **Take money.** With no provider the Owner's invoice waits until the operator records the payment. The stand-in
  is refused in production.
- **Taxes, refunds, proration, credit notes, receipts as PDF, e-mail.** None. Notices go to the log, as every notice
  does until an e-mail service is chosen.
- **Changing plan.** A company's plan is the `plan_code` set when it was created.
- **Carry over days.** A new term starts on the day of payment.
- **Aligning people's cards with the company date.** Person cards keep their own validity.
- **Run by itself.** Reminders, automatic renewal and closing old invoices happen only when the housekeeping command
  runs, and nothing schedules it yet (docs/runbooks/housekeeping.md). A step that fails for one company is printed
  with the company's id and the reason, and the command ends with a failure code.

## Deliberate exceptions

- The Owner's paths are `/v1/billing/...`, not `/v1/tenants/current/billing/...`: billing is its own area with its
  own rights, and the provider's endpoint belongs to it. The operator's paths follow the usual
  `/v1/tenants/{tenant_id}/...` form.
- `startRenewal` always answers 200 and says `already_open` in the body (the web client's generator supports one
  success answer per operation).

Nine operations (165 in total), four tables, three permissions.

## Things to know that are not bugs

- An Owner whose own card is individually expired is still let through to billing when the COMPANY is in the same
  or a worse phase (read-only or lapsed): the exemption is about the company's term. A card that is locked,
  suspended, revoked or not activated is refused as everywhere else.
- `subscriptions` rows (seats asked, seat limit, automatic renewal) are protected by code and permissions, not by a
  database guard. Invoices are guarded by the database; subscriptions are not.
- While a renewal invoice waits, the billing screen's own seat notice still shows the PAID limit; the usage page
  and the refusal on issuing a card show the invoice's bound.

## ASSUMPTIONS

- 15.00 USD per seat and term, the plan names, the 30/14/3-day reminders, the 3 attempts, the 3 and 14 days before an
  unanswered invoice is closed, the 10-second provider timeout and the "tenth of the seats" threshold are choices
  made here. All are the founder's to change.
- One term = `card_validity_days` of the company (90 by default, 366 at most).
- No limit in a company's first term: chosen so that existing companies and new pilots are not blocked before they
  ever paid. The founder may prefer a limit from day one.
