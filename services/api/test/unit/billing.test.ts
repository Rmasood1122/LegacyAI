// The parts of billing that need no database: prices, the term's phases, reminders, and - most of all - the check on
// the payment provider's messages. Everything here uses invented values and a fake key.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  amountDue, catalogueProblems, collect, dueNow, enforcedLimit, EVENT_TOLERANCE_MS, FakePaymentProvider, finish, INVOICE_CAUSES, INVOICE_STATUSES,
  isUnfinished, MORE_CARDS_THAN_SEATS, nextStatus, NoPaymentProvider, notAppliedReason, openInvoiceBound, paidSeatsCover, planOf, PLANS, priceFor,
  reminderStages, renewalSeats, sameMoney, seatFree, seatState, seatsToAdd, signEvent, termPhase, verifyEvent,
  type Billing, type InvoiceRow, type PaymentEventInput, type SeatFacts,
} from '../../src/modules/billing/index.ts';
import { ProblemError, problems } from '../../src/shared/errors.ts';

const KEY = Buffer.from('FAKE-payment-event-key-for-unit-tests-only!!');
const NOW = new Date('2026-10-04T12:00:00.000Z');
const DAY = 86_400_000;

function signed(over: Partial<Omit<PaymentEventInput, 'signature'>> = {}, key: Buffer = KEY): PaymentEventInput {
  const fields = {
    version: 'v1', event_id: `evt_${randomUUID()}`, tenant_id: randomUUID(), invoice_id: randomUUID(), outcome: 'paid', amount_minor: 4500, currency: 'USD',
    sent_at: NOW.toISOString(), ...over,
  };
  return { ...fields, signature: signEvent(key, fields) };
}

describe('the plan catalogue (placeholder values)', () => {
  it('is usable, and every plan in it has a whole-number price in a three-letter currency', () => {
    expect(catalogueProblems()).toEqual([]);
    for (const p of PLANS) expect(Number.isInteger(p.pricePerSeatMinor) && /^[A-Z]{3}$/.test(p.currency), p.code).toBe(true);
    expect(planOf('free')?.pricePerSeatMinor).toBe(0);
    expect(planOf('no-such-plan')).toBeNull();
  });

  it('a broken catalogue is reported, not used', () => {
    expect(catalogueProblems([
      { code: 'pilot', name: 'a', pricePerSeatMinor: 15.5, currency: 'USD' }, { code: 'pilot', name: 'b', pricePerSeatMinor: 1, currency: 'usd' },
    ])).toHaveLength(3);   // a fraction, listed twice, lower-case currency
  });

  it('an amount is price times seats, in whole numbers only', () => {
    const plan = { code: 'pilot', name: 'x', pricePerSeatMinor: 1500, currency: 'USD' };
    expect(amountDue(plan, 3)).toBe(4500);
    expect(amountDue({ ...plan, pricePerSeatMinor: 0 }, 250)).toBe(0);
    for (const seats of [0, -1, 1.5, Number.NaN]) expect(() => amountDue(plan, seats), String(seats)).toThrow();
    expect(() => amountDue({ ...plan, pricePerSeatMinor: 0.1 }, 3)).toThrow();
    expect(() => amountDue({ ...plan, pricePerSeatMinor: Number.MAX_SAFE_INTEGER }, 2)).toThrow();
  });
});

describe('the term and what is due when', () => {
  const term = { renewalDue: new Date(NOW.getTime() - DAY), expiresAt: new Date(NOW.getTime() + 13 * DAY), graceUntil: new Date(NOW.getTime() + 27 * DAY) };
  const at = (days: number): Date => new Date(NOW.getTime() + days * DAY);

  it('normal -> renewal open -> read-only (grace) -> lapsed', () => {
    expect(termPhase(term, at(-2))).toBe('normal');
    expect(termPhase(term, at(-1))).toBe('renewal_open');   // the day the renewal opens counts
    expect(termPhase(term, at(13))).toBe('renewal_open');   // the renewal date itself is still inside the term
    expect(termPhase(term, at(14))).toBe('grace');
    expect(termPhase(term, at(27))).toBe('grace');
    expect(termPhase(term, at(28))).toBe('lapsed');
  });

  it('reminders: 30, 14 and 3 days before the renewal date, one during the read-only days, none after', () => {
    expect(reminderStages(term, at(-30))).toEqual([]);
    expect(reminderStages(term, at(-17))).toEqual(['30_days']);
    expect(reminderStages(term, at(0))).toEqual(['30_days', '14_days']);
    expect(reminderStages(term, at(11))).toEqual(['30_days', '14_days', '3_days']);
    expect(reminderStages(term, at(20))).toEqual(['in_grace']);
    expect(reminderStages(term, at(40))).toEqual([]);
  });

  it('seats: not limited, enough, nearly used up, used up', () => {
    expect(seatState(500, null)).toBe('not_limited');
    expect(seatState(3, 10)).toBe('ok');
    expect(seatState(9, 10)).toBe('near');
    expect(seatState(91, 100)).toBe('near');     // a tenth of the seats is left
    expect(seatState(89, 100)).toBe('ok');
    expect(seatState(10, 10)).toBe('reached');
    expect(seatState(12, 10)).toBe('reached');
  });
});

describe('a message from the payment provider is trusted only with a valid signature', () => {
  it('a correctly signed, fresh message is accepted and comes back in the words of the product', () => {
    const input = signed({ outcome: 'declined' });
    expect(verifyEvent(KEY, input, NOW)).toEqual({
      eventId: input.event_id, tenantId: input.tenant_id, invoiceId: input.invoice_id, outcome: 'declined', amount: { amountMinor: 4500, currency: 'USD' }, sentAt: NOW,
    });
  });

  it('changing ANY signed field after signing makes it worthless', () => {
    const input = signed();
    const forged: Array<Partial<PaymentEventInput>> = [
      { outcome: 'declined' }, { amount_minor: 1 }, { currency: 'EUR' }, { invoice_id: randomUUID() }, { tenant_id: randomUUID() },
      { event_id: `evt_${randomUUID()}` }, { sent_at: new Date(NOW.getTime() + 1000).toISOString() }, { version: 'v2' },
    ];
    for (const change of forged) expect(verifyEvent(KEY, { ...input, ...change }, NOW), JSON.stringify(change)).toBeNull();
  });

  it('a message signed with another key, with no key configured, or with a short key is refused', () => {
    expect(verifyEvent(KEY, signed({}, Buffer.from('ANOTHER-FAKE-key-of-the-same-length-for-test')), NOW)).toBeNull();
    expect(verifyEvent(null, signed(), NOW)).toBeNull();
    const short = Buffer.from('too-short');
    expect(verifyEvent(short, signed({}, short), NOW)).toBeNull();
  });

  it('an old message sent again later (a replay) and a message from the future are refused; five minutes either way are allowed', () => {
    const input = signed();
    expect(verifyEvent(KEY, input, new Date(NOW.getTime() + EVENT_TOLERANCE_MS))).not.toBeNull();
    expect(verifyEvent(KEY, input, new Date(NOW.getTime() - EVENT_TOLERANCE_MS))).not.toBeNull();
    expect(verifyEvent(KEY, input, new Date(NOW.getTime() + EVENT_TOLERANCE_MS + 1))).toBeNull();
    expect(verifyEvent(KEY, input, new Date(NOW.getTime() - EVENT_TOLERANCE_MS - 1))).toBeNull();
  });

  it('malformed fields are refused before anything is compared (and never throw)', () => {
    const good = signed();
    const bad: Array<Record<string, unknown>> = [
      { signature: 'zz' }, { signature: good.signature.toUpperCase() }, { signature: '' }, { outcome: 'refunded' }, { amount_minor: -1 },
      { amount_minor: 1.5 }, { amount_minor: '4500' }, { currency: 'usd' }, { tenant_id: 'not-a-uuid' }, { invoice_id: `${good.invoice_id}\nx` },
      { event_id: 'short' }, { event_id: 'has\nnewline_in_it' }, { sent_at: 'yesterday' }, { sent_at: '2026-10-04 12:00:00' }, { sent_at: 12345 },
      { version: 'v2' }, { version: '' }, { version: undefined },
    ];
    for (const change of bad) {
      expect(verifyEvent(KEY, { ...good, ...change } as unknown as PaymentEventInput, NOW), JSON.stringify(change)).toBeNull();
    }
    expect(verifyEvent(KEY, {} as unknown as PaymentEventInput, NOW)).toBeNull();
  });

  it('the signature covers the fields one per line, so a value cannot be moved from one field into the next', () => {
    const a = { version: 'v1', event_id: 'evt_aaaaaaaa', tenant_id: randomUUID(), invoice_id: randomUUID(), outcome: 'paid', amount_minor: 45, currency: 'USD', sent_at: NOW.toISOString() };
    const b = { ...a, amount_minor: 4, currency: '5USD' };   // "45" + "USD" against "4" + "5USD"
    expect(signEvent(KEY, a)).not.toBe(signEvent(KEY, b));
  });
});

describe('an invoice changes state only along one table', () => {
  it('every state and every cause, listed one by one', () => {
    const table: Record<string, Record<string, string | null>> = {
      open: { payment_confirmed: 'paid', payment_declined: 'failed', superseded: 'void', expired: 'void' },
      failed: { payment_confirmed: 'paid_late', payment_declined: null, superseded: null, expired: null },
      void: { payment_confirmed: 'paid_late', payment_declined: null, superseded: null, expired: null },
      paid: { payment_confirmed: null, payment_declined: null, superseded: null, expired: null },
      paid_late: { payment_confirmed: null, payment_declined: null, superseded: null, expired: null },
    };
    expect(Object.keys(table).sort()).toEqual([...INVOICE_STATUSES].sort());
    for (const status of INVOICE_STATUSES) {
      for (const cause of INVOICE_CAUSES) expect(nextStatus(status, cause), `${status} + ${cause}`).toBe(table[status]![cause]);
    }
  });

  it('nothing ever leads back to "open", and a paid invoice never changes again', () => {
    for (const status of INVOICE_STATUSES) {
      for (const cause of INVOICE_CAUSES) expect(nextStatus(status, cause)).not.toBe('open');
    }
  });
});

describe('seats: what is asked, what is paid, what is enforced', () => {
  const facts = (over: Partial<SeatFacts> = {}): SeatFacts => ({ requested: null, limit: null, unlimited: false, ...over });
  const plan = { code: 'pilot', name: 'x', pricePerSeatMinor: 1500, currency: 'USD' };
  const term = (personCards: number) => ({
    renewalDue: new Date(NOW.getTime() + 10 * DAY), expiresAt: new Date(NOW.getTime() + 24 * DAY), graceUntil: new Date(NOW.getTime() + 38 * DAY),
    termDays: 365, personCards,
  });

  it('the limit that is enforced is what was PAID, never what was only asked for', () => {
    expect(enforcedLimit(facts({ requested: 50, limit: 10 }))).toBe(10);
    expect(enforcedLimit(facts({ requested: 50 }))).toBeNull();          // first term: nothing paid yet, no limit
    expect(enforcedLimit(facts({ limit: 10, unlimited: true }))).toBeNull();
  });

  it('a renewal bills what was asked or paid before, and never fewer seats than cards in use', () => {
    expect(renewalSeats(facts({ limit: 10 }), 4)).toBe(10);
    expect(renewalSeats(facts({ requested: 6, limit: 10 }), 4)).toBe(6);    // fewer seats take effect at renewal
    expect(renewalSeats(facts({ requested: 3, limit: 10 }), 4)).toBe(4);    // ... but not below the cards in use
    expect(renewalSeats(facts(), 0)).toBe(1);
    expect(renewalSeats(facts({ limit: 10, unlimited: true }), 37)).toBe(37);
  });

  it('seats added in the middle of a term are the difference, and only when more was asked than is paid', () => {
    expect(seatsToAdd(facts({ requested: 15, limit: 10 }))).toBe(5);
    expect(seatsToAdd(facts({ requested: 10, limit: 10 }))).toBe(0);
    expect(seatsToAdd(facts({ requested: 6, limit: 10 }))).toBe(0);
    expect(seatsToAdd(facts({ requested: 15 }))).toBe(0);
    expect(seatsToAdd(facts({ requested: 15, limit: 10, unlimited: true }))).toBe(0);
  });

  it('what is due now: nothing before the renewal opens, unless seats were added; the next term from then on', () => {
    expect(dueNow(plan, facts({ limit: 10 }), term(4), NOW)).toBeNull();
    expect(dueNow(plan, facts({ requested: 12, limit: 10 }), term(4), NOW)).toEqual({ kind: 'seats', seats: 2, amount: { amountMinor: 3000, currency: 'USD' } });
    const open = new Date(NOW.getTime() + 10 * DAY);
    expect(dueNow(plan, facts({ requested: 12, limit: 10 }), term(4), open)).toEqual({ kind: 'renewal', seats: 12, amount: { amountMinor: 18000, currency: 'USD' } });
    expect(dueNow(plan, facts({ limit: 10 }), term(11), new Date(NOW.getTime() + 30 * DAY))?.seats).toBe(11);   // read-only days: still renewable
    expect(dueNow(null, facts({ limit: 10 }), term(4), open)).toBeNull();   // no price for the plan: nothing can be invoiced
  });

  it('money is equal only when amount AND currency are equal', () => {
    expect(priceFor(plan, 3)).toEqual({ amountMinor: 4500, currency: 'USD' });
    expect(sameMoney({ amountMinor: 4500, currency: 'USD' }, { amountMinor: 4500, currency: 'USD' })).toBe(true);
    expect(sameMoney({ amountMinor: 4500, currency: 'USD' }, { amountMinor: 4500, currency: 'EUR' })).toBe(false);
    expect(sameMoney({ amountMinor: 4500, currency: 'USD' }, { amountMinor: 4501, currency: 'USD' })).toBe(false);
  });
});

describe('the stand-ins', () => {
  it('the fake provider takes no money and calls nobody: it only hands back a reference', async () => {
    const id = randomUUID();
    const fake = new FakePaymentProvider(KEY);
    expect(fake.canCollect).toBe(true);
    expect(await fake.start({ invoiceId: id, tenantId: randomUUID(), amount: { amountMinor: 4500, currency: 'USD' } })).toEqual({ reference: `fake-${id}` });
  });

  it('the fake provider accepts a message only with its own key - and none at all when it has no key', () => {
    const input = signed();
    const message = { body: input, headers: {}, rawBody: null };
    expect(new FakePaymentProvider(KEY).parseEvent(message, NOW)?.eventId).toBe(input.event_id);
    expect(new FakePaymentProvider(null).parseEvent(message, NOW)).toBeNull();
    expect(new FakePaymentProvider(Buffer.from('ANOTHER-FAKE-key-of-the-same-length-for-test')).parseEvent(message, NOW)).toBeNull();
  });

  it('with no provider configured nothing can be started and NO message is accepted, however well it is signed', async () => {
    const none = new NoPaymentProvider();
    expect(none.canCollect).toBe(false);
    await expect(none.start()).rejects.toThrow(/no payment provider/);
    expect(none.parseEvent()).toBeNull();
  });
});

describe('what was paid must cover what is used', () => {
  const none: SeatFacts = { requested: null, limit: null, unlimited: false };      // a company in its first term
  const five: SeatFacts = { requested: null, limit: 5, unlimited: false };
  const unlimited: SeatFacts = { requested: null, limit: null, unlimited: true };
  const renewal = (seats: number) => ({ kind: 'renewal' as const, seats });
  const added = (seats: number) => ({ kind: 'seats' as const, seats });

  it('only a waiting RENEWAL invoice bounds the cards by itself; a seats invoice adds to the running limit', () => {
    expect(openInvoiceBound(null)).toBeNull();
    expect(openInvoiceBound(renewal(3))).toBe(3);
    expect(openInvoiceBound(added(2))).toBeNull();
  });

  it('issuing a card: "pay for one seat, keep all cards" is refused while the invoice waits - in the first term too', () => {
    // no limit, no invoice: free
    expect(seatFree(none, null, 40)).toBe(true);
    // the Owner revoked down to 1 card and started the renewal for 1 seat: a second card is refused until it is paid
    expect(seatFree(none, renewal(1), 1)).toBe(false);
    expect(seatFree(none, renewal(3), 2)).toBe(true);
    expect(seatFree(none, renewal(3), 3)).toBe(false);
    // the paid limit still applies next to it; the tighter one wins
    expect(seatFree(five, renewal(8), 5)).toBe(false);
    expect(seatFree(five, renewal(3), 3)).toBe(false);
    expect(seatFree(five, null, 4)).toBe(true);
    expect(seatFree(five, added(2), 4)).toBe(true);
    expect(seatFree(five, added(2), 5)).toBe(false);          // added seats count only once they are paid
    // a company the operator freed from the limit is bound by its waiting renewal invoice all the same
    expect(seatFree(unlimited, null, 500)).toBe(true);
    expect(seatFree(unlimited, renewal(2), 2)).toBe(false);
  });

  it('when a payment takes effect the cards are counted again: more cards than paid seats and it does not take effect', () => {
    expect(paidSeatsCover(renewal(3), none, 3)).toBe(true);
    expect(paidSeatsCover(renewal(3), none, 4)).toBe(false);
    expect(paidSeatsCover(renewal(1), five, 5)).toBe(false);
    expect(paidSeatsCover(renewal(1), unlimited, 2)).toBe(false);
    expect(paidSeatsCover(added(2), five, 7)).toBe(true);
    expect(paidSeatsCover(added(2), five, 8)).toBe(false);
    expect(paidSeatsCover(added(2), unlimited, 80)).toBe(true);
  });

  it('the reason written down says which of the two it was', () => {
    expect(notAppliedReason(problems.conflict(MORE_CARDS_THAN_SEATS, 'x'))).toBe('PAYMENT_NOT_APPLIED_MORE_CARDS_THAN_SEATS');
    expect(notAppliedReason(new Error('the company card cannot be renewed'))).toBe('PAYMENT_NOT_APPLIED');
    expect(notAppliedReason(problems.conflict('something-else', 'x'))).toBe('PAYMENT_NOT_APPLIED');
  });
});

describe('a payment on record is finished or reported - never left without a trace', () => {
  const ctx = { requestId: 'unit', ip: '', userAgent: '', now: NOW, fetchSite: null };
  const withTx = <T>(fn: (tx: never) => Promise<T>): Promise<T> => fn(undefined as never);
  const at = new Date('2026-10-04T11:00:00.000Z');

  it('"unfinished" = paid, not in effect, and nobody was told', () => {
    expect(isUnfinished({ status: 'paid', applied_at: null, attention_at: null })).toBe(true);
    expect(isUnfinished({ status: 'paid', applied_at: at, attention_at: null })).toBe(false);
    expect(isUnfinished({ status: 'paid', applied_at: null, attention_at: at })).toBe(false);
    for (const status of ['open', 'failed', 'void', 'paid_late'] as const) expect(isUnfinished({ status, applied_at: null, attention_at: null })).toBe(false);
  });

  it('it takes effect: nothing is reported', async () => {
    const calls: string[] = [];
    const billing = {
      applyPaid: async () => { calls.push('apply'); },
      recordNotApplied: async () => { calls.push('report'); return true; },
    } as unknown as Billing;
    expect(await finish(billing, 't', 'i', withTx, ctx)).toBe('applied');
    expect(calls).toEqual(['apply']);
  });

  it('it cannot take effect: that is written down with its reason, in a transaction of its own', async () => {
    const reasons: string[] = [];
    const billing = {
      applyPaid: async () => { throw problems.conflict(MORE_CARDS_THAN_SEATS, 'more cards than seats'); },
      recordNotApplied: async (_tx: unknown, _t: string, _i: string, reason: string) => { reasons.push(reason); return true; },
    } as unknown as Billing;
    expect(await finish(billing, 't', 'i', withTx, ctx)).toBe('not_applied');
    expect(reasons).toEqual(['PAYMENT_NOT_APPLIED_MORE_CARDS_THAN_SEATS']);
  });

  it('if even the report fails, the caller hears about it and the invoice stays unfinished for the next try', async () => {
    const billing = {
      applyPaid: async () => { throw new Error('the term could not be renewed'); },
      recordNotApplied: async () => { throw new Error('database gone'); },
    } as unknown as Billing;
    await expect(finish(billing, 't', 'i', withTx, ctx)).rejects.toThrow('database gone');
  });
});

describe('asking the provider to collect an invoice that is already stored', () => {
  const invoice = { id: randomUUID(), amount_minor: '4500', currency: 'USD' } as InvoiceRow;
  const withTx = <T>(fn: (tx: never) => Promise<T>): Promise<T> => fn(undefined as never);
  const billingWith = (start: () => Promise<{ reference: string }>, recorded: string[]): Billing => ({
    provider: { canCollect: true, start },
    recordProviderReference: async (_tx: unknown, _t: string, _i: string, reference: string) => { recorded.push(reference); return invoice; },
  } as unknown as Billing);

  it('the provider answers: its reference is remembered', async () => {
    const recorded: string[] = [];
    await collect(billingWith(async () => ({ reference: 'ref-1' }), recorded), invoice, 't', withTx);
    expect(recorded).toEqual(['ref-1']);
  });

  it('the provider does not answer in time: 503, nothing is recorded, the invoice stays as it was', async () => {
    const recorded: string[] = [];
    const never = new Promise<{ reference: string }>(() => undefined);
    const err = await collect(billingWith(() => never, recorded), invoice, 't', withTx, 20).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProblemError);
    expect((err as ProblemError).status).toBe(503);
    expect((err as ProblemError).code).toBe('payment-provider-unavailable');
    expect(recorded).toEqual([]);
  });

  it('the provider refuses or breaks: 502, nothing is recorded', async () => {
    const recorded: string[] = [];
    const err = await collect(billingWith(async () => { throw new Error('boom'); }, recorded), invoice, 't', withTx).catch((e: unknown) => e);
    expect((err as ProblemError).status).toBe(502);
    expect(recorded).toEqual([]);
  });
});
