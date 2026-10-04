// Phase 4, Batch B: billing and renewal (features 29, 31, 32, 33, 34, 35). docs/phase4/05-billing.md.
// Synthetic companies only. The payment provider is the stand-in: it takes no money. This test PLAYS the provider
// by sending the signed messages a provider would send. The company's term is moved by setting the company card's
// dates as the superuser (moving the test clock by months would also expire every session and card in the file).
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signEvent, type PaymentEventInput } from '../../src/modules/billing/index.ts';
import { AiStub } from '../helpers/ai-stub.ts';
import { testEnv } from '../helpers/env.ts';
import {
  addMember, Client, createTenant, login, platformOperator, startApp, superuser, type Res, type TestApp, type TestMember, type TestTenant,
} from '../helpers/harness.ts';

const DAY = 86_400_000;
const KEY = Buffer.from(testEnv().PAYMENT_EVENT_KEY as string, 'base64');
const PRICE = 1500;   // the placeholder price of the "pilot" plan, per seat and term

let stub: AiStub;
let t: TestApp;
let su: pg.Client;

beforeAll(async () => {
  stub = await new AiStub().start();
  t = await startApp({}, { AI_SERVICE_URL: stub.url });
  su = await superuser();
});
afterAll(async () => {
  await su.end();
  await t.close();
  await stub.stop();
});

/** Puts the company's term where a test needs it: days from now until the renewal date (negative = already past). */
async function termEndsIn(tenant: TestTenant, days: number, graceDays = 14, noticeDays = 14): Promise<void> {
  const end = t.clock.now().getTime() + days * DAY;
  await su.query('UPDATE cards SET expires_at = $2, grace_until = $3, renewal_due = $4 WHERE id = $1',
    [tenant.companyCard.id, new Date(end), new Date(end + graceDays * DAY), new Date(end - noticeDays * DAY)]);
}
const companyCard = async (tenant: TestTenant): Promise<{ expires_at: Date; renewal_count: number; state: string }> =>
  (await su.query('SELECT expires_at, renewal_count, state FROM cards WHERE id = $1', [tenant.companyCard.id])).rows[0];
const invoiceRow = async (id: string): Promise<{ status: string; applied_at: Date | null; attention_at: Date | null; settlement: string | null; provider_reference: string | null }> =>
  (await su.query('SELECT status, applied_at, attention_at, settlement, provider_reference FROM invoices WHERE id = $1', [id])).rows[0];
const auditCount = async (tenantId: string, reason: string): Promise<number> =>
  (await su.query('SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND reason_code = $2', [tenantId, reason])).rows[0].n;
const usd = (amount: number): { amount_minor: number; currency: string } => ({ amount_minor: amount, currency: 'USD' });

/** A message as the provider would send it, signed with the (fake) key. */
function event(tenant: TestTenant, invoiceId: string, over: Partial<Omit<PaymentEventInput, 'signature'>> = {}, key: Buffer = KEY): PaymentEventInput {
  const fields = {
    version: 'v1', event_id: `evt_${randomUUID()}`, tenant_id: tenant.tenantId, invoice_id: invoiceId, outcome: 'paid', amount_minor: 0, currency: 'USD',
    sent_at: t.clock.now().toISOString(), ...over,
  };
  return { ...fields, signature: signEvent(key, fields) };
}
/** The provider has no session, no cookie and no browser. */
const send = (e: unknown): Promise<Res> => new Client(t).request('POST', '/v1/billing/provider-events', e, { origin: null });
const view = async (tenant: TestTenant): Promise<Record<string, any>> => (await tenant.owner.get('/v1/billing/subscription')).body;

describe('the renewal center', () => {
  let tenant: TestTenant;
  let learner: TestMember;
  let thirdPerson: string;
  beforeAll(async () => {
    tenant = await createTenant(t, 'billing');
    learner = await addMember(t, tenant.owner, [{ role_key: 'successor' }]);
  });

  it('a company billing never touched: placeholder plan, no seat limit in the first term, too early to renew; only the Owner sees it', async () => {
    const res = await tenant.owner.get('/v1/billing/subscription');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      plan: { code: 'pilot', price_per_seat: usd(PRICE), placeholder: true }, seats_requested: null, seat_limit: null, seats_unlimited: false,
      seats_used: 2, seat_state: 'not_limited', auto_renew: false, term_days: 90, phase: 'normal', read_only: false, export_only: false,
      next_term: { seats: 2, amount: usd(2 * PRICE) }, due_now: null, open_invoice: null, can_renew_now: false,
      payments_available: true, payments_needing_attention: 0, if_nothing_is_done: 'read_only_then_export_only',
    });
    const card = await companyCard(tenant);
    expect(res.body.expires_at).toBe(card.expires_at.toISOString());             // ONE renewal date: the company card's
    expect((await tenant.owner.get('/v1/billing/invoices')).body).toEqual({ items: [], next_cursor: null });
    const early = await tenant.owner.post('/v1/billing/renewals');
    expect(early.status).toBe(409);
    expect(early.body.type).toContain('renewal-not-open');
    for (const res2 of [
      await learner.client.get('/v1/billing/subscription'), await learner.client.get('/v1/billing/invoices'),
      await learner.client.patch('/v1/billing/subscription', { auto_renew: true }), await learner.client.post('/v1/billing/renewals'),
    ]) expect(res2.status).toBe(403);
    // seats as the usage page shows them: numbers of cards, no money
    expect((await tenant.owner.get('/v1/tenants/current/usage')).body.seats).toEqual({ limit: null, used: 2, state: 'not_limited' });
  });

  it('asking for seats: never below the cards in use, never "no limit"; what is asked is not yet what is enforced', async () => {
    expect((await tenant.owner.patch('/v1/billing/subscription', {})).status).toBe(400);
    expect((await tenant.owner.patch('/v1/billing/subscription', { seats: 0 })).status).toBe(400);
    expect((await tenant.owner.patch('/v1/billing/subscription', { seats: null })).status).toBe(400);   // only the operator removes a limit
    const below = await tenant.owner.patch('/v1/billing/subscription', { seats: 1 });
    expect(below.status).toBe(409);
    expect(below.body.type).toContain('seats-below-use');
    const asked = await tenant.owner.patch('/v1/billing/subscription', { seats: 2 });
    expect(asked.status).toBe(200);
    expect(asked.body).toMatchObject({ seats_requested: 2, seat_limit: null, seat_state: 'not_limited', due_now: null, next_term: { seats: 2, amount: usd(2 * PRICE) } });
    expect(await auditCount(tenant.tenantId, 'SUBSCRIPTION_CHANGED')).toBe(1);
  });

  it('renewing: one invoice; nothing changes until the provider says "paid"; then the term is renewed exactly once and the seats paid become the limit', async () => {
    await termEndsIn(tenant, 5);
    const before = await companyCard(tenant);
    expect(await view(tenant)).toMatchObject({ phase: 'renewal_open', can_renew_now: true, due_now: { kind: 'renewal', seats: 2, amount: usd(2 * PRICE) } });

    const started = await tenant.owner.post('/v1/billing/renewals');
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({
      already_open: false, collected_by: 'provider',
      invoice: { number: 1, kind: 'renewal', status: 'open', seats: 2, amount: usd(2 * PRICE), applied: false, settlement: null },
    });
    const invoice: string = started.body.invoice.id;
    expect((await invoiceRow(invoice)).provider_reference).toBe(`fake-${invoice}`);   // recorded after the provider was asked
    // asking again issues nothing new
    const again = await tenant.owner.post('/v1/billing/renewals');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ already_open: true, invoice: { id: invoice, number: 1 } });
    expect(await view(tenant)).toMatchObject({ open_invoice: { id: invoice }, can_renew_now: false });
    expect((await companyCard(tenant)).renewal_count).toBe(before.renewal_count);   // issuing an invoice renews nothing
    // while an invoice waits, seats cannot move under it
    const locked = await tenant.owner.patch('/v1/billing/subscription', { seats: 4 });
    expect([locked.status, String(locked.body.type).includes('seats-locked')]).toEqual([409, true]);

    // one invoice can be read by itself: by the Owner, by nobody else, and not another company's
    expect((await tenant.owner.get(`/v1/billing/invoices/${invoice}`)).body).toMatchObject({ id: invoice, status: 'open' });
    expect((await learner.client.get(`/v1/billing/invoices/${invoice}`)).status).toBe(403);
    expect((await tenant.owner.get(`/v1/billing/invoices/${randomUUID()}`)).status).toBe(404);

    // messages that must change nothing: unsigned, signed with another key, altered after signing, without a version
    const good = event(tenant, invoice, { amount_minor: 2 * PRICE });
    expect((await send({ ...good, signature: '0'.repeat(64) })).status).toBe(403);
    expect((await send(event(tenant, invoice, { amount_minor: 2 * PRICE }, Buffer.from('ANOTHER-FAKE-key-of-the-same-length-for-test')))).status).toBe(403);
    expect((await send({ ...good, amount_minor: 1 })).status).toBe(403);
    expect((await send({ ...good, signature: undefined })).status).toBe(400);
    expect((await send({ ...good, version: undefined })).status).toBe(400);
    // correctly signed, but for another amount than was due: stored, nothing changes, people are told
    const wrongAmount = await send(event(tenant, invoice, { amount_minor: 1 }));
    expect([wrongAmount.status, wrongAmount.body]).toEqual([200, { status: 'recorded' }]);
    expect((await invoiceRow(invoice)).status).toBe('open');
    expect((await companyCard(tenant)).renewal_count).toBe(before.renewal_count);
    expect(await auditCount(tenant.tenantId, 'PAYMENT_EVENT_AMOUNT_MISMATCH')).toBe(1);
    expect((await su.query(`SELECT count(*)::int AS n FROM payment_events WHERE tenant_id = $1 AND result = 'amount_mismatch'`, [tenant.tenantId])).rows[0].n).toBe(1);

    // the real one
    const paid = await send(good);
    expect([paid.status, paid.body]).toEqual([200, { status: 'applied' }]);
    const after = await companyCard(tenant);
    expect(after.renewal_count).toBe(before.renewal_count + 1);
    expect(after.expires_at.getTime()).toBeGreaterThan(t.clock.now().getTime() + 89 * DAY);      // a whole new term, from today
    expect(await invoiceRow(invoice)).toMatchObject({ status: 'paid', settlement: 'provider' });
    expect((await invoiceRow(invoice)).applied_at).not.toBeNull();

    // the same message again, a second "paid" with a new id, and a late "declined": none of them changes anything
    expect((await send(good)).body).toEqual({ status: 'duplicate' });
    expect((await send(event(tenant, invoice, { amount_minor: 2 * PRICE }))).body).toEqual({ status: 'recorded' });
    expect(await auditCount(tenant.tenantId, 'PAYMENT_REPEATED')).toBe(1);                       // possibly charged twice: a person must look
    expect((await send(event(tenant, invoice, { amount_minor: 2 * PRICE, outcome: 'declined' }))).body).toEqual({ status: 'recorded' });
    expect((await companyCard(tenant)).renewal_count).toBe(before.renewal_count + 1);
    expect((await invoiceRow(invoice)).status).toBe('paid');
    expect(await auditCount(tenant.tenantId, 'INVOICE_PAID_TERM_RENEWED')).toBe(1);

    const list = await tenant.owner.get('/v1/billing/invoices');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id: invoice, status: 'paid', applied: true, settlement: 'provider' });
    // the seats PAID are now the limit; what was asked is used up
    expect(await view(tenant)).toMatchObject({ phase: 'normal', open_invoice: null, seats_requested: null, seat_limit: 2, seat_state: 'reached', due_now: null });
  });

  it('seats used up: no card can be issued, and the answer says why; asking for more does not lift it - paying for them does', async () => {
    const person = await tenant.owner.post('/v1/people', { display_name: 'Synthetic third person', department_id: null });
    expect(person.status).toBe(201);
    thirdPerson = person.body.id;
    const issue = (): Promise<Res> => tenant.owner.post('/v1/cards', { person_id: thirdPerson, roles: [{ role_key: 'successor' }] });
    const refused = await issue();
    expect(refused.status).toBe(409);
    expect(refused.body.type).toContain('seat-limit-reached');
    expect(await auditCount(tenant.tenantId, 'DENY_PLAN_LIMIT')).toBe(1);

    const more = await tenant.owner.patch('/v1/billing/subscription', { seats: 3 });
    expect(more.body).toMatchObject({ seats_requested: 3, seat_limit: 2, seat_state: 'reached', can_renew_now: true, due_now: { kind: 'seats', seats: 1, amount: usd(PRICE) } });
    expect((await issue()).status).toBe(409);                                    // asked for, not paid: still no seat

    const before = await companyCard(tenant);
    const started = await tenant.owner.post('/v1/billing/renewals');
    expect(started.status).toBe(200);
    expect(started.body.invoice).toMatchObject({ number: 2, kind: 'seats', seats: 1, amount: usd(PRICE), status: 'open' });
    expect((await issue()).status).toBe(409);                                    // invoiced, not paid: still no seat
    expect((await send(event(tenant, started.body.invoice.id, { amount_minor: PRICE }))).body).toEqual({ status: 'applied' });
    expect(await view(tenant)).toMatchObject({ seats_requested: null, seat_limit: 3, seats_used: 2, seat_state: 'near', due_now: null });
    expect((await companyCard(tenant)).renewal_count).toBe(before.renewal_count);                // seats do not move the term
    expect(await auditCount(tenant.tenantId, 'INVOICE_PAID_SEATS_ADDED')).toBe(1);

    expect((await issue()).status).toBe(201);
    expect(await view(tenant)).toMatchObject({ seats_used: 3, seat_state: 'reached' });
    expect((await tenant.owner.get('/v1/tenants/current/usage')).body.seats).toEqual({ limit: 3, used: 3, state: 'reached' });
  });

  it('a declined payment renews nothing; money that arrives for it LATER is kept on record and not applied; old or future-dated messages are refused', async () => {
    await termEndsIn(tenant, 3);
    const before = await companyCard(tenant);
    const first = (await tenant.owner.post('/v1/billing/renewals')).body.invoice;
    expect(first).toMatchObject({ number: 3, seats: 3, amount: usd(3 * PRICE) });
    const stale = event(tenant, first.id, { amount_minor: 3 * PRICE, sent_at: new Date(t.clock.now().getTime() - 6 * 60_000).toISOString() });
    const future = event(tenant, first.id, { amount_minor: 3 * PRICE, sent_at: new Date(t.clock.now().getTime() + 6 * 60_000).toISOString() });
    expect((await send(stale)).status).toBe(403);
    expect((await send(future)).status).toBe(403);

    const declined = await send(event(tenant, first.id, { amount_minor: 3 * PRICE, outcome: 'declined' }));
    expect(declined.body).toEqual({ status: 'applied' });
    expect((await invoiceRow(first.id)).status).toBe('failed');
    expect((await companyCard(tenant)).renewal_count).toBe(before.renewal_count);
    expect(await auditCount(tenant.tenantId, 'PAYMENT_DECLINED')).toBe(1);

    // "paid" after "declined": the money is real, the invoice is closed - nothing is dropped, nothing is applied
    const late = await send(event(tenant, first.id, { amount_minor: 3 * PRICE }));
    expect(late.body).toEqual({ status: 'recorded' });
    expect(await invoiceRow(first.id)).toMatchObject({ status: 'paid_late', applied_at: null, settlement: 'provider' });
    expect((await companyCard(tenant)).renewal_count).toBe(before.renewal_count);
    expect(await auditCount(tenant.tenantId, 'PAYMENT_FOR_CLOSED_INVOICE')).toBe(1);
    expect((await view(tenant)).payments_needing_attention).toBe(1);

    const second = await tenant.owner.post('/v1/billing/renewals');
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ already_open: false, invoice: { number: 4, status: 'open' } });
  });

  it('a lapsed company can still see what it owes and pay; everything else stays closed until it has', async () => {
    await termEndsIn(tenant, -20);                                      // the read-only days are over too
    expect((await tenant.owner.get('/v1/cards')).status).toBe(403);
    expect((await learner.client.get('/v1/billing/subscription')).status).toBe(403);
    const seen = await tenant.owner.get('/v1/billing/subscription');
    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({ phase: 'lapsed', read_only: true, export_only: true, open_invoice: { number: 4 }, can_renew_now: false });
    const open = await tenant.owner.post('/v1/billing/renewals');
    expect(open.status).toBe(200);
    expect(open.body).toMatchObject({ already_open: true, invoice: { number: 4 } });
    expect((await send(event(tenant, open.body.invoice.id, { amount_minor: 3 * PRICE }))).body).toEqual({ status: 'applied' });
    expect((await tenant.owner.get('/v1/cards')).status).toBe(200);
    expect(await view(tenant)).toMatchObject({ phase: 'normal', seat_limit: 3 });
  });

  it('a message about one company never touches another, even when correctly signed - and it is still kept', async () => {
    const other = await createTenant(t, 'billing-b');
    await termEndsIn(other, 2);
    const theirs = (await other.owner.post('/v1/billing/renewals')).body.invoice;
    // signed, but naming OUR company with THEIR invoice
    const crossed = await send(event(tenant, theirs.id, { amount_minor: theirs.amount.amount_minor }));
    expect(crossed.body).toEqual({ status: 'recorded' });
    expect((await invoiceRow(theirs.id)).status).toBe('open');
    expect(await auditCount(tenant.tenantId, 'PAYMENT_EVENT_UNKNOWN_INVOICE')).toBe(1);
    expect((await su.query(`SELECT count(*)::int AS n FROM payment_events WHERE tenant_id = $1 AND result = 'unknown_invoice'`, [tenant.tenantId])).rows[0].n).toBe(1);
    // and a company that does not exist: written to the operator's log, nothing else
    const nobody = randomUUID();
    const nowhere = await send(event(tenant, theirs.id, { amount_minor: theirs.amount.amount_minor, tenant_id: nobody }));
    expect(nowhere.body).toEqual({ status: 'recorded' });
    expect((await su.query(`SELECT count(*)::int AS n FROM audit_log WHERE reason_code = 'PAYMENT_EVENT_UNKNOWN_COMPANY' AND resource_id = $1`, [nobody])).rows[0].n).toBe(1);
    expect((await invoiceRow(theirs.id)).status).toBe('open');
  });
});

describe('reminders and automatic renewal (the housekeeping sweep)', () => {
  let tenant: TestTenant;
  const sweep = (): Promise<{ notices: number; attempts: number; closed: number; finished: number; failures: string[] }> =>
    t.app.billing.sweepCompany(tenant.tenantId, 'pilot', { requestId: 'test-sweep', ip: '', userAgent: '', now: t.clock.now(), fetchSite: null });
  const notices = async (): Promise<string[]> =>
    (await su.query('SELECT stage FROM billing_notices WHERE tenant_id = $1 ORDER BY stage', [tenant.tenantId])).rows.map((r) => r.stage);
  beforeAll(async () => {
    tenant = await createTenant(t, 'billing-sweep');
  });

  it('reminders are created once each; without auto-renew nothing is attempted', async () => {
    await termEndsIn(tenant, 20);
    expect(await sweep()).toEqual({ notices: 1, attempts: 0, closed: 0, finished: 0, failures: [] });
    expect(await sweep()).toEqual({ notices: 0, attempts: 0, closed: 0, finished: 0, failures: [] });
    expect(await notices()).toEqual(['30_days']);
  });

  it('auto-renew: tried on the renewal date, at most three times; a paid attempt renews and starts the count again', async () => {
    expect((await tenant.owner.patch('/v1/billing/subscription', { auto_renew: true })).body).toMatchObject({
      auto_renew: true, if_nothing_is_done: 'automatic_renewal_is_tried',
    });
    await termEndsIn(tenant, 5);
    expect((await sweep()).attempts).toBe(0);                            // five days before the date: not yet
    await termEndsIn(tenant, 0.5);
    const first = await sweep();
    expect(first).toMatchObject({ attempts: 1, failures: [] });
    const open = (await su.query(`SELECT id, automatic, amount_minor, provider_reference FROM invoices WHERE tenant_id = $1 AND status = 'open'`, [tenant.tenantId])).rows;
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ automatic: true, provider_reference: `fake-${open[0].id}` });
    expect((await sweep()).attempts).toBe(0);                            // an invoice is waiting: no second one

    // declined three times in a row -> one failure notice, and no fourth attempt
    let invoice: string = open[0].id;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect((await send(event(tenant, invoice, { amount_minor: PRICE, outcome: 'declined' }))).body).toEqual({ status: 'applied' });
      const next = await sweep();
      if (attempt < 3) {
        expect(next.attempts, `attempt ${attempt + 1}`).toBe(1);
        invoice = (await su.query(`SELECT id FROM invoices WHERE tenant_id = $1 AND status = 'open'`, [tenant.tenantId])).rows[0].id;
      } else {
        expect(next.attempts).toBe(0);
        expect(await notices()).toContain('auto_renew_failed');
      }
    }
    expect((await sweep()).attempts).toBe(0);

    // the Owner pays by hand: the failed attempts are forgotten for the next term
    const manual = (await tenant.owner.post('/v1/billing/renewals')).body.invoice;
    expect((await send(event(tenant, manual.id, { amount_minor: manual.amount.amount_minor }))).body).toEqual({ status: 'applied' });
    expect((await su.query('SELECT auto_renew_attempts FROM subscriptions WHERE tenant_id = $1', [tenant.tenantId])).rows[0].auto_renew_attempts).toBe(0);
  });

  it('a plan that costs nothing is renewed at once, without the provider', async () => {
    const free = await createTenant(t, 'billing-free');
    await su.query(`UPDATE tenants SET plan_code = 'free' WHERE id = $1`, [free.tenantId]);
    await termEndsIn(free, 1);
    const before = await companyCard(free);
    const res = await free.owner.post('/v1/billing/renewals');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ already_open: false, invoice: { amount: usd(0), status: 'paid', applied: true, settlement: 'no_charge' } });
    expect((await companyCard(free)).renewal_count).toBe(before.renewal_count + 1);
  });
});

describe('the platform operator', () => {
  it('sets or removes a company\'s seat limit; the Owner cannot remove it, and cannot change seats while the operator did', async () => {
    const tenant = await createTenant(t, 'billing-seats-op');
    const operator = await platformOperator(t);
    const url = `/v1/tenants/${tenant.tenantId}/billing`;
    expect((await operator.patch(url, { seat_limit: 0 })).status).toBe(400);
    expect((await operator.patch(url, { seat_limit: 1 })).body).toMatchObject({ seat_limit: 1, seats_unlimited: false, seat_state: 'reached' });
    const none = await operator.patch(url, { seat_limit: null });
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ seat_limit: null, seats_unlimited: true, seat_state: 'not_limited' });
    const owner = await tenant.owner.patch('/v1/billing/subscription', { seats: 5 });
    expect([owner.status, String(owner.body.type).includes('seats-set-by-operator')]).toEqual([409, true]);
    expect((await tenant.owner.patch(url, { seat_limit: 9 })).status).toBe(403);
    expect((await operator.patch(`/v1/tenants/${randomUUID()}/billing`, { seat_limit: 3 })).status).toBe(404);
    // the company's log says "operator" (no card of another company in it); the operator's own log names the card
    const own = (await su.query(`SELECT actor_kind, actor_card_id FROM audit_log WHERE tenant_id = $1 AND reason_code = 'SEAT_LIMIT_REMOVED_BY_OPERATOR'`, [tenant.tenantId])).rows;
    expect(own).toEqual([{ actor_kind: 'operator', actor_card_id: null }]);
    expect((await su.query(`SELECT count(*)::int AS n FROM audit_log WHERE reason_code = 'SEAT_LIMIT_SET' AND resource_id = $1 AND actor_card_id IS NOT NULL`, [tenant.tenantId])).rows[0].n).toBe(2);
  });

  it('settles a named invoice for the amount it says, once; a renewal that would throw away days needs an explicit yes; nobody inside a company can', async () => {
    const tenant = await createTenant(t, 'billing-op');
    const operator = await platformOperator(t);
    const url = `/v1/tenants/${tenant.tenantId}/billing/manual-payments`;

    const seen = await operator.get(`/v1/tenants/${tenant.tenantId}/billing`);
    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({ tenant_id: tenant.tenantId, invoices: [], next_cursor: null, subscription: { phase: 'normal', seats_used: 1 } });
    expect((await operator.get(`/v1/tenants/${randomUUID()}/billing`)).status).toBe(404);

    await termEndsIn(tenant, 5);
    const before = await companyCard(tenant);
    const invoice = (await tenant.owner.post('/v1/billing/renewals')).body.invoice;
    const pay = (over: Record<string, unknown> = {}): Promise<Res> => operator.post(url, { invoice_id: invoice.id, amount: usd(PRICE), reference: 'TRANSFER-2026-0001', ...over });

    // nothing that looks like a payment card number is taken
    expect((await pay({ reference: 'card 4111 1111 1111 1111' })).status).toBe(422);
    expect((await pay({ invoice_id: undefined })).status).toBe(400);
    expect((await pay({ invoice_id: randomUUID() })).status).toBe(404);
    for (const wrong of [usd(PRICE + 1), { amount_minor: PRICE, currency: 'EUR' }]) {
      const res = await pay({ amount: wrong });
      expect([res.status, String(res.body.type).includes('amount-mismatch')]).toEqual([409, true]);
    }
    const early = await pay();
    expect([early.status, String(early.body.type).includes('days-would-be-lost')]).toEqual([409, true]);
    expect((await companyCard(tenant)).renewal_count).toBe(before.renewal_count);

    const paid = await pay({ discard_remaining_days: true });
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ id: invoice.id, kind: 'renewal', status: 'paid', applied: true, settlement: 'operator', amount: usd(PRICE) });
    expect((await companyCard(tenant)).renewal_count).toBe(before.renewal_count + 1);
    // the same invoice cannot be settled a second time, whatever key the request carries
    const twice = await pay({ discard_remaining_days: true });
    expect([twice.status, String(twice.body.type).includes('invoice-not-payable')]).toEqual([409, true]);
    expect((await companyCard(tenant)).renewal_count).toBe(before.renewal_count + 1);

    expect((await su.query(`SELECT count(*)::int AS n FROM audit_log WHERE reason_code = 'MANUAL_PAYMENT_RECORDED' AND resource_id = $1`, [tenant.tenantId])).rows[0].n).toBe(1);
    const own = (await su.query(`SELECT actor_kind, actor_card_id FROM audit_log WHERE tenant_id = $1 AND reason_code = 'INVOICE_SETTLED_BY_OPERATOR'`, [tenant.tenantId])).rows;
    expect(own).toEqual([{ actor_kind: 'operator', actor_card_id: null }]);

    // the company's own Owner is not the operator
    expect((await tenant.owner.get(`/v1/tenants/${tenant.tenantId}/billing`)).status).toBe(403);
    expect((await tenant.owner.post(url, { invoice_id: invoice.id, amount: usd(PRICE), reference: 'TRANSFER-2026-0002' })).status).toBe(403);
    expect((await tenant.owner.get('/v1/billing/invoices')).body.items).toHaveLength(1);
    expect((await operator.get(`/v1/tenants/${tenant.tenantId}/billing?limit=1`)).body).toMatchObject({ invoices: [{ id: invoice.id }], next_cursor: null });
  });

  it('applies a payment that arrived late - and the invoice that was waiting meanwhile is closed, so nothing is collected twice', async () => {
    const tenant = await createTenant(t, 'billing-late');
    const operator = await platformOperator(t);
    await termEndsIn(tenant, 1);
    const before = await companyCard(tenant);
    const first = (await tenant.owner.post('/v1/billing/renewals')).body.invoice;
    expect((await send(event(tenant, first.id, { amount_minor: PRICE, outcome: 'declined' }))).body).toEqual({ status: 'applied' });
    const second = (await tenant.owner.post('/v1/billing/renewals')).body.invoice;
    expect((await send(event(tenant, first.id, { amount_minor: PRICE }))).body).toEqual({ status: 'recorded' });
    expect((await invoiceRow(first.id)).status).toBe('paid_late');

    const applied = await operator.post(`/v1/tenants/${tenant.tenantId}/billing/manual-payments`,
      { invoice_id: first.id, amount: usd(PRICE), reference: 'CASE-2026-0007', discard_remaining_days: true });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ id: first.id, status: 'paid_late', applied: true, settlement: 'provider' });
    expect((await companyCard(tenant)).renewal_count).toBe(before.renewal_count + 1);
    expect((await invoiceRow(second.id)).status).toBe('void');
    expect(await view(tenant)).toMatchObject({ payments_needing_attention: 0, open_invoice: null, phase: 'normal' });
    // money for the closed one would again only be recorded
    expect((await send(event(tenant, second.id, { amount_minor: PRICE }))).body).toEqual({ status: 'recorded' });
    expect((await companyCard(tenant)).renewal_count).toBe(before.renewal_count + 1);
  });

  it('an invoice cannot be changed or deleted behind the API\'s back, even by the API\'s own database login', async () => {
    const tenant = await createTenant(t, 'billing-guard');
    await termEndsIn(tenant, 2);
    const invoice = (await tenant.owner.post('/v1/billing/renewals')).body.invoice;
    const asApp = <T>(sql: string, params: unknown[]): Promise<T> => t.app.db.withTenantTx(tenant.tenantId, async (tx) => (await tx.query(sql, params)) as T);
    await expect(asApp('UPDATE invoices SET amount_minor = 1 WHERE id = $1', [invoice.id])).rejects.toThrow(/cannot change/);
    await expect(asApp('UPDATE invoices SET seats = 99 WHERE id = $1', [invoice.id])).rejects.toThrow(/cannot change/);
    await expect(asApp('DELETE FROM invoices WHERE id = $1', [invoice.id])).rejects.toBeTruthy();
    await expect(asApp(`UPDATE invoices SET applied_at = now() WHERE id = $1`, [invoice.id])).rejects.toBeTruthy();   // not paid: cannot take effect
    // a second open invoice for the same company is refused by the database itself
    await expect(asApp(`INSERT INTO invoices (tenant_id, number, kind, plan_code, seats, term_days, amount_minor, currency)
                        VALUES ($1, 99, 'renewal', 'pilot', 1, 90, 1500, 'USD')`, [tenant.tenantId])).rejects.toBeTruthy();
    await expect(asApp(`UPDATE invoices SET status = 'void', closed_at = now() WHERE id = $1`, [invoice.id])).resolves.toBeTruthy();
    await expect(asApp(`UPDATE invoices SET status = 'open' WHERE id = $1`, [invoice.id])).rejects.toThrow(/illegal status change/);
    await expect(asApp(`UPDATE invoices SET status = 'paid', paid_at = now(), settlement = 'provider' WHERE id = $1`, [invoice.id])).rejects.toThrow(/illegal status change/);
  });
});

/** The sweep as it would run `days` from now. (The test clock itself is not moved: that would end every session.) */
const sweepIn = (tenant: TestTenant, days: number): Promise<{ notices: number; attempts: number; closed: number; finished: number; failures: string[] }> =>
  t.app.billing.sweepCompany(tenant.tenantId, 'pilot', {
    requestId: 'test-sweep', ip: '', userAgent: '', now: new Date(t.clock.now().getTime() + days * DAY), fetchSite: null,
  });
/** What the first transaction of a "paid" message leaves behind if the process stops right after it. */
async function paidButStopped(tenant: TestTenant, invoiceId: string, e: PaymentEventInput): Promise<void> {
  await su.query(`UPDATE invoices SET status = 'paid', paid_at = $2, settlement = 'provider' WHERE id = $1`, [invoiceId, t.clock.now()]);
  await su.query(
    `INSERT INTO payment_events (tenant_id, event_id, invoice_id, outcome, amount_minor, currency, result, occurred_at, received_at)
     VALUES ($1, $2, $3, 'paid', $4, 'USD', 'paid', $5, $5)`, [tenant.tenantId, e.event_id, invoiceId, e.amount_minor, t.clock.now()]);
}

describe('what was paid must cover what is used', () => {
  it('"pay for one seat, keep all cards" does not work: while the renewal invoice waits no card is issued beyond its seats - in the first term too', async () => {
    const tenant = await createTenant(t, 'billing-one-seat');
    const second = await addMember(t, tenant.owner, [{ role_key: 'successor' }]);
    expect(await view(tenant)).toMatchObject({ seat_limit: null, seats_used: 2, seat_state: 'not_limited' });   // first term: nothing limits cards

    // the Owner revokes down to one card and starts the renewal for one seat ...
    expect((await tenant.owner.post(`/v1/cards/${second.card.id}/revoke`, { reason: 'synthetic' })).body.state).toBe('revoked');
    await termEndsIn(tenant, 3);
    const started = await tenant.owner.post('/v1/billing/renewals');
    expect(started.body.invoice).toMatchObject({ kind: 'renewal', seats: 1, amount: usd(PRICE), status: 'open' });
    // the usage page says so: the waiting invoice bounds the cards
    expect((await tenant.owner.get('/v1/tenants/current/usage')).body.seats).toEqual({ limit: 1, used: 1, state: 'reached' });

    // ... and tries to issue the card again before paying: refused, with the reason
    const person = await tenant.owner.post('/v1/people', { display_name: 'Synthetic re-issued person', department_id: null });
    const issue = (): Promise<Res> => tenant.owner.post('/v1/cards', { person_id: person.body.id, roles: [{ role_key: 'successor' }] });
    const refused = await issue();
    expect(refused.status).toBe(409);
    expect(refused.body.type).toContain('seat-limit-reached');
    expect(await auditCount(tenant.tenantId, 'DENY_PLAN_LIMIT')).toBe(1);

    // paid: the term is renewed with ONE seat, and one seat stays the limit
    expect((await send(event(tenant, started.body.invoice.id, { amount_minor: PRICE }))).body).toEqual({ status: 'applied' });
    expect(await view(tenant)).toMatchObject({ phase: 'normal', seat_limit: 1, seats_used: 1, seat_state: 'reached' });
    expect((await issue()).status).toBe(409);
  });

  it('the cards are counted again when the payment arrives: more cards than paid seats and the payment is kept but does not take effect', async () => {
    const tenant = await createTenant(t, 'billing-recount');
    const second = await addMember(t, tenant.owner, [{ role_key: 'successor' }]);
    await termEndsIn(tenant, 2);
    const before = await companyCard(tenant);
    // The race the issue-time check cannot see (a card issued at the very moment the invoice was): simulated by an
    // invoice for ONE seat written directly while TWO cards are in use.
    const invoiceId: string = (await su.query(
      `INSERT INTO invoices (tenant_id, number, kind, plan_code, seats, term_days, amount_minor, currency)
       VALUES ($1, 1, 'renewal', 'pilot', 1, 90, $2, 'USD') RETURNING id`, [tenant.tenantId, PRICE])).rows[0].id;

    const paid = event(tenant, invoiceId, { amount_minor: PRICE });
    expect((await send(paid)).body).toEqual({ status: 'recorded' });
    const row = await invoiceRow(invoiceId);
    expect(row).toMatchObject({ status: 'paid', applied_at: null, settlement: 'provider' });
    expect(row.attention_at).not.toBeNull();
    expect((await companyCard(tenant)).renewal_count).toBe(before.renewal_count);                 // nothing was renewed
    expect(await auditCount(tenant.tenantId, 'PAYMENT_RECEIVED')).toBe(1);                        // the money is on record
    expect(await auditCount(tenant.tenantId, 'PAYMENT_NOT_APPLIED_MORE_CARDS_THAN_SEATS')).toBe(1);
    expect((await view(tenant)).payments_needing_attention).toBe(1);
    // the same message again: nothing new, and nobody is told a second time
    expect((await send(paid)).body).toEqual({ status: 'duplicate' });
    expect(await auditCount(tenant.tenantId, 'PAYMENT_NOT_APPLIED_MORE_CARDS_THAN_SEATS')).toBe(1);

    // the operator cannot put it into effect while two cards are in use ...
    const operator = await platformOperator(t);
    const apply = (): Promise<Res> => operator.post(`/v1/tenants/${tenant.tenantId}/billing/manual-payments`,
      { invoice_id: invoiceId, amount: usd(PRICE), reference: 'CASE-2026-0011', discard_remaining_days: true });
    const tooMany = await apply();
    expect([tooMany.status, String(tooMany.body.type).includes('more-cards-than-seats')]).toEqual([409, true]);
    // ... and can once the company is down to what it paid for
    expect((await tenant.owner.post(`/v1/cards/${second.card.id}/revoke`, { reason: 'synthetic' })).body.state).toBe('revoked');
    const applied = await apply();
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ id: invoiceId, status: 'paid', applied: true });
    expect((await companyCard(tenant)).renewal_count).toBe(before.renewal_count + 1);
    expect(await view(tenant)).toMatchObject({ seat_limit: 1, payments_needing_attention: 0 });
  });
});

describe('a payment on record is finished or reported, whatever happens in between', () => {
  it('the term cannot be renewed when the payment arrives: the payment is kept, people are told once, the provider gets a normal answer, the operator applies it later', async () => {
    const tenant = await createTenant(t, 'billing-not-applied');
    const operator = await platformOperator(t);
    await termEndsIn(tenant, 2);
    const before = await companyCard(tenant);
    const invoice = (await tenant.owner.post('/v1/billing/renewals')).body.invoice;
    // a suspended company card cannot be renewed (the identity module refuses it)
    await su.query(`UPDATE cards SET state = 'suspended' WHERE id = $1`, [tenant.companyCard.id]);

    const paid = event(tenant, invoice.id, { amount_minor: PRICE });
    const res = await send(paid);
    expect([res.status, res.body]).toEqual([200, { status: 'recorded' }]);
    const row = await invoiceRow(invoice.id);
    expect(row).toMatchObject({ status: 'paid', applied_at: null, settlement: 'provider' });
    expect(row.attention_at).not.toBeNull();
    expect(await auditCount(tenant.tenantId, 'PAYMENT_RECEIVED')).toBe(1);
    expect(await auditCount(tenant.tenantId, 'PAYMENT_NOT_APPLIED')).toBe(1);
    expect((await companyCard(tenant)).renewal_count).toBe(before.renewal_count);
    // again and again: still one report
    expect((await send(paid)).body).toEqual({ status: 'duplicate' });
    expect((await sweepIn(tenant, 0)).finished).toBe(0);
    expect(await auditCount(tenant.tenantId, 'PAYMENT_NOT_APPLIED')).toBe(1);

    await su.query(`UPDATE cards SET state = 'active' WHERE id = $1`, [tenant.companyCard.id]);
    const applied = await operator.post(`/v1/tenants/${tenant.tenantId}/billing/manual-payments`,
      { invoice_id: invoice.id, amount: usd(PRICE), reference: 'CASE-2026-0012', discard_remaining_days: true });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ id: invoice.id, status: 'paid', applied: true, settlement: 'provider' });
    expect((await companyCard(tenant)).renewal_count).toBe(before.renewal_count + 1);
    expect(await auditCount(tenant.tenantId, 'PAYMENT_APPLIED_BY_OPERATOR')).toBe(1);
  });

  it('the process stopped after the payment was stored: the same message delivered again finishes the job', async () => {
    const tenant = await createTenant(t, 'billing-redelivered');
    await termEndsIn(tenant, 2);
    const before = await companyCard(tenant);
    const invoice = (await tenant.owner.post('/v1/billing/renewals')).body.invoice;
    const paid = event(tenant, invoice.id, { amount_minor: PRICE });
    await paidButStopped(tenant, invoice.id, paid);
    expect(await invoiceRow(invoice.id)).toMatchObject({ status: 'paid', applied_at: null, attention_at: null });
    expect((await view(tenant)).payments_needing_attention).toBe(1);

    const again = await send(paid);
    expect([again.status, again.body]).toEqual([200, { status: 'duplicate' }]);      // the provider hears "I had that one" ...
    expect((await invoiceRow(invoice.id)).applied_at).not.toBeNull();                // ... and the term is renewed all the same
    expect((await companyCard(tenant)).renewal_count).toBe(before.renewal_count + 1);
    expect(await auditCount(tenant.tenantId, 'INVOICE_PAID_TERM_RENEWED')).toBe(1);
    // a third delivery finds nothing left to do
    expect((await send(paid)).body).toEqual({ status: 'duplicate' });
    expect((await companyCard(tenant)).renewal_count).toBe(before.renewal_count + 1);
  });

  it('... and if the message never comes again, the housekeeping sweep finishes it: applied when possible, reported once when not', async () => {
    const tenant = await createTenant(t, 'billing-swept');
    await termEndsIn(tenant, 2);
    const before = await companyCard(tenant);
    const invoice = (await tenant.owner.post('/v1/billing/renewals')).body.invoice;
    await paidButStopped(tenant, invoice.id, event(tenant, invoice.id, { amount_minor: PRICE }));
    expect(await sweepIn(tenant, 0)).toMatchObject({ finished: 1, failures: [] });
    expect((await invoiceRow(invoice.id)).applied_at).not.toBeNull();
    expect((await companyCard(tenant)).renewal_count).toBe(before.renewal_count + 1);
    expect((await sweepIn(tenant, 0)).finished).toBe(0);

    // the same, when it cannot take effect
    const stuck = await createTenant(t, 'billing-swept-stuck');
    await termEndsIn(stuck, 2);
    const theirs = (await stuck.owner.post('/v1/billing/renewals')).body.invoice;
    await paidButStopped(stuck, theirs.id, event(stuck, theirs.id, { amount_minor: PRICE }));
    await su.query(`UPDATE cards SET state = 'suspended' WHERE id = $1`, [stuck.companyCard.id]);
    expect(await sweepIn(stuck, 0)).toMatchObject({ finished: 1, failures: [] });
    const row = await invoiceRow(theirs.id);
    expect(row.applied_at).toBeNull();
    expect(row.attention_at).not.toBeNull();
    expect(await auditCount(stuck.tenantId, 'PAYMENT_NOT_APPLIED')).toBe(1);
    expect((await sweepIn(stuck, 0)).finished).toBe(0);
    expect(await auditCount(stuck.tenantId, 'PAYMENT_NOT_APPLIED')).toBe(1);
    await su.query(`UPDATE cards SET state = 'active' WHERE id = $1`, [stuck.companyCard.id]);
  });

  it('two deliveries of one message at the same moment take effect once', async () => {
    const tenant = await createTenant(t, 'billing-parallel');
    await termEndsIn(tenant, 2);
    const before = await companyCard(tenant);
    const invoice = (await tenant.owner.post('/v1/billing/renewals')).body.invoice;
    const paid = event(tenant, invoice.id, { amount_minor: PRICE });
    const both = await Promise.all([send(paid), send(paid)]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    // one of them did the work; the other saw it done (or finished it) - never two renewals
    expect(both.map((r) => r.body.status).sort()).toEqual(['applied', 'duplicate']);
    expect((await companyCard(tenant)).renewal_count).toBe(before.renewal_count + 1);
    expect(await auditCount(tenant.tenantId, 'INVOICE_PAID_TERM_RENEWED')).toBe(1);
    expect(await auditCount(tenant.tenantId, 'PAYMENT_RECEIVED')).toBe(1);
    expect((await su.query('SELECT count(*)::int AS n FROM payment_events WHERE tenant_id = $1', [tenant.tenantId])).rows[0].n).toBe(1);
  });
});

describe('invoices nobody answered, and a provider that does not answer', () => {
  it('an invoice the Owner started is closed after 14 days, an automatic one after 3; money that arrives for it later is kept and not applied', async () => {
    const tenant = await createTenant(t, 'billing-stale');
    await termEndsIn(tenant, 5);
    const before = await companyCard(tenant);
    const mine = (await tenant.owner.post('/v1/billing/renewals')).body.invoice;
    expect((await sweepIn(tenant, 13)).closed).toBe(0);
    expect((await invoiceRow(mine.id)).status).toBe('open');
    expect((await sweepIn(tenant, 15)).closed).toBe(1);
    expect((await invoiceRow(mine.id)).status).toBe('void');
    expect(await auditCount(tenant.tenantId, 'INVOICE_EXPIRED')).toBe(1);
    // the late money: on record, reported, not applied
    expect((await send(event(tenant, mine.id, { amount_minor: PRICE }))).body).toEqual({ status: 'recorded' });
    const late = await invoiceRow(mine.id);
    expect(late).toMatchObject({ status: 'paid_late', applied_at: null });
    expect(late.attention_at).not.toBeNull();
    expect(await auditCount(tenant.tenantId, 'PAYMENT_FOR_CLOSED_INVOICE')).toBe(1);
    expect((await companyCard(tenant)).renewal_count).toBe(before.renewal_count);
    expect((await sweepIn(tenant, 15)).finished).toBe(0);                    // a late payment is never applied by the sweep

    // an automatic invoice: three days
    const auto = await createTenant(t, 'billing-stale-auto');
    expect((await auto.owner.patch('/v1/billing/subscription', { auto_renew: true })).status).toBe(200);
    await termEndsIn(auto, 0.5);
    expect((await sweepIn(auto, 0)).attempts).toBe(1);
    const open: string = (await su.query(`SELECT id FROM invoices WHERE tenant_id = $1 AND status = 'open' AND automatic`, [auto.tenantId])).rows[0].id;
    expect((await sweepIn(auto, 2)).closed).toBe(0);
    const day4 = await sweepIn(auto, 4);
    expect(day4.closed).toBe(1);
    expect((await invoiceRow(open)).status).toBe('void');
    expect(day4.attempts).toBe(1);                                           // the next attempt starts with a NEW invoice
    expect((await su.query(`SELECT count(*)::int AS n FROM invoices WHERE tenant_id = $1 AND status = 'open'`, [auto.tenantId])).rows[0].n).toBe(1);
  });

  it('the provider does not answer: 503, the invoice stays open with no reference, and asking again uses the same invoice', async () => {
    // The company is made in the usual app; its Owner then signs in to a second app on the same database whose
    // provider never answers and whose time limit is 50 ms instead of 10 seconds.
    const tenant = await createTenant(t, 'billing-timeout');
    await termEndsIn(tenant, 2);
    const hanging = { name: 'hanging', canCollect: true, start: () => new Promise<never>(() => undefined), parseEvent: () => null };
    const slow = await startApp({ paymentProvider: hanging, providerTimeoutMs: 50 }, { AI_SERVICE_URL: stub.url });
    try {
      const owner = await login(slow, tenant.ownerCard, { passkey: tenant.ownerPasskey });
      const first = await owner.post('/v1/billing/renewals');
      expect(first.status).toBe(503);
      expect(first.body.type).toContain('payment-provider-unavailable');
      const rows = (await su.query('SELECT id, status, provider_reference FROM invoices WHERE tenant_id = $1', [tenant.tenantId])).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'open', provider_reference: null });
      // asking again: the same invoice is tried again, no second one is issued
      expect((await owner.post('/v1/billing/renewals')).status).toBe(503);
      expect((await su.query('SELECT count(*)::int AS n FROM invoices WHERE tenant_id = $1', [tenant.tenantId])).rows[0].n).toBe(1);
      // once a provider answers (the usual app), the SAME invoice is collected
      const again = await tenant.owner.post('/v1/billing/renewals');
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ already_open: true, invoice: { id: rows[0].id } });
      expect((await invoiceRow(rows[0].id)).provider_reference).toBe(`fake-${rows[0].id}`);
    } finally {
      await slow.close();
    }
  });
});
