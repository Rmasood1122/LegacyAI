// Stripe as the payment provider (decision D37) against the real server and database, with a local stand-in for
// Stripe's API. This test PLAYS Stripe: it answers the Checkout Session request and sends the signed events Stripe
// would send - signed over the exact bytes, which the server must hand to the provider unchanged. Synthetic companies
// only; the keys are made-up values (allow-listed in .gitleaks.toml). The pure rules are in test/unit/billing-stripe.
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StripePaymentProvider } from '../../src/modules/billing/index.ts';
import { createLogger, Secret } from '../../src/modules/platform/index.ts';
import { AiStub } from '../helpers/ai-stub.ts';
import { TEST_ORIGIN } from '../helpers/env.ts';
import { Client, createTenant, startApp, superuser, type Res, type TestApp, type TestTenant } from '../helpers/harness.ts';

const DAY = 86_400_000;
const WEBHOOK = 'whsec_FAKEwebhookSecretForIntegration1';

let stub: AiStub;
let t: TestApp;
let su: pg.Client;
let dir: string;
let stripeApi: Server;
const toStripe: Array<{ path: string; headers: Record<string, unknown>; body: string }> = [];
let sessions = 0;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'legacyai-stripe-it-'));
  const key = path.join(dir, 'k.pem');
  const crt = path.join(dir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=api.stripe.test', '-addext', 'subjectAltName=DNS:api.stripe.test', '-keyout', key, '-out', crt], { stdio: 'ignore' });
  const cert = readFileSync(crt, 'utf8');
  // the stand-in keeps one session per idempotency key, as Stripe does
  const byKey = new Map<string, string>();
  stripeApi = createServer({ key: readFileSync(key, 'utf8'), cert }, (req, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      toStripe.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      const idem = String(req.headers['idempotency-key']);
      let id = byKey.get(idem);
      if (id === undefined) {
        sessions += 1;
        id = `cs_test_session${sessions}`;
        byKey.set(idem, id);
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}` }));
    });
  });
  await new Promise<void>((resolve) => stripeApi.listen(0, '127.0.0.1', resolve));
  const port = (stripeApi.address() as AddressInfo).port;
  const provider = new StripePaymentProvider({
    secretKey: new Secret('sk_test_FAKEstripeKeyForIntegration1'), webhookSecret: new Secret(WEBHOOK), returnUrl: `${TEST_ORIGIN}/billing`,
    log: createLogger('silent'), api: `https://api.stripe.test:${port}`,
    http: { resolve: async () => [{ address: '127.0.0.1', family: 4 }], isAllowed: (a) => a === '127.0.0.1', ca: cert },
  });
  stub = await new AiStub().start();
  t = await startApp({ paymentProvider: provider }, { AI_SERVICE_URL: stub.url });
  su = await superuser();
});
afterAll(async () => {
  await su.end();
  await t.close();
  await stub.stop();
  stripeApi.closeAllConnections();
  await new Promise<void>((resolve) => stripeApi.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

async function termEndsIn(tenant: TestTenant, days: number): Promise<void> {
  const end = t.clock.now().getTime() + days * DAY;
  await su.query('UPDATE cards SET expires_at = $2, grace_until = $3, renewal_due = $4, issued_at = LEAST(issued_at, $5) WHERE id = $1',
    [tenant.companyCard.id, new Date(end), new Date(end + 14 * DAY), new Date(end - 14 * DAY), new Date(end - 366 * DAY)]);
}

let eventCounter = 0;
/** A Stripe event about a Checkout Session of this product. */
function stripeEvent(type: string, tenant: TestTenant, invoiceId: string, amount: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  eventCounter += 1;
  return {
    id: `evt_test${eventCounter}x${Date.now()}`, object: 'event', type, livemode: false, created: Math.floor(t.clock.now().getTime() / 1000),
    data: {
      object: {
        id: 'cs_test_session1', object: 'checkout.session', mode: 'payment', payment_status: 'paid', client_reference_id: invoiceId,
        amount_total: amount, currency: 'usd', metadata: { tenant_id: tenant.tenantId, invoice_id: invoiceId },
      },
    },
    ...over,
  };
}
/** Sends these exact bytes, signed the way Stripe signs them (or with what `signature` says). No session, no browser. */
async function deliver(bytes: string, signature?: string): Promise<Res> {
  const ts = Math.floor(t.clock.now().getTime() / 1000);
  const header = signature ?? `t=${ts},v1=${createHmac('sha256', WEBHOOK).update(`${ts}.${bytes}`).digest('hex')}`;
  return new Client(t).request('POST', '/v1/billing/provider-events', bytes, { origin: null, headers: { 'content-type': 'application/json', 'stripe-signature': header } });
}
const invoiceRow = async (id: string): Promise<{ status: string; applied_at: Date | null; provider_reference: string | null }> =>
  (await su.query('SELECT status, applied_at, provider_reference FROM invoices WHERE id = $1', [id])).rows[0];

describe('paying a renewal through Stripe', () => {
  let tenant: TestTenant;
  let invoiceId: string;
  let due: number;   // what the invoice says (seats in use times the plan's price)

  beforeAll(async () => {
    tenant = await createTenant(t, 'stripe');
    await termEndsIn(tenant, 2);
  });

  it('starting the renewal makes one Checkout Session for the invoice and hands the Owner Stripe\'s page; nothing is paid yet', async () => {
    const res = await tenant.owner.post('/v1/billing/renewals');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ already_open: false, collected_by: 'provider', invoice: { status: 'open' } });
    expect(res.body.payment_url).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
    invoiceId = res.body.invoice.id;
    due = res.body.invoice.amount.amount_minor;
    expect(due).toBeGreaterThan(0);
    expect(res.body.invoice.amount.currency).toBe('USD');
    const sent = toStripe[toStripe.length - 1] as (typeof toStripe)[number];
    expect(sent.path).toBe('/v1/checkout/sessions');
    expect(sent.headers['idempotency-key']).toBe(`legacyai-invoice-${invoiceId}`);
    expect(new URLSearchParams(sent.body).get('line_items[0][price_data][unit_amount]')).toBe(String(due));
    expect((await invoiceRow(invoiceId)).provider_reference).toMatch(/^cs_test_/);
  });

  it('the Owner closed the page and asks again: the same invoice, the same session, the same page', async () => {
    const first = toStripe.length;
    const again = await tenant.owner.post('/v1/billing/renewals');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ already_open: true, invoice: { id: invoiceId } });
    const [a] = toStripe.slice(first);
    expect(a?.headers['idempotency-key']).toBe(`legacyai-invoice-${invoiceId}`);
    expect((await su.query('SELECT count(*)::int AS n FROM invoices WHERE tenant_id = $1', [tenant.tenantId])).rows[0].n).toBe(1);
  });

  it('automatic renewal is not offered: Stripe needs the Owner on its page', async () => {
    const res = await tenant.owner.patch('/v1/billing/subscription', { auto_renew: true });
    expect(res.status).toBe(409);
    expect(res.raw).toContain('payments-unavailable');
    expect((await tenant.owner.get('/v1/billing/subscription')).body).toMatchObject({ payments_available: true, if_nothing_is_done: 'read_only_then_export_only' });
  });

  it('a message without a valid signature changes nothing: the same 403 for every reason', async () => {
    const bytes = JSON.stringify(stripeEvent('checkout.session.completed', tenant, invoiceId, due));
    const ts = Math.floor(t.clock.now().getTime() / 1000);
    for (const header of [`t=${ts},v1=${'0'.repeat(64)}`, `t=${ts},v1=${createHmac('sha256', 'whsec_FAKEotherSecret0000').update(`${ts}.${bytes}`).digest('hex')}`]) {
      const res = await deliver(bytes, header);
      expect(res.status).toBe(403);
    }
    // no header at all
    expect((await new Client(t).request('POST', '/v1/billing/provider-events', bytes, { origin: null, headers: { 'content-type': 'application/json' } })).status).toBe(403);
    // signed over other bytes than were sent (the server must check the bytes, not the JSON)
    const otherBytes = JSON.stringify(stripeEvent('checkout.session.completed', tenant, invoiceId, due));
    const signedOther = `t=${ts},v1=${createHmac('sha256', WEBHOOK).update(`${ts}.${otherBytes}`).digest('hex')}`;
    expect((await deliver(bytes, signedOther)).status).toBe(403);
    expect((await invoiceRow(invoiceId)).status).toBe('open');
  });

  it('a verified event about something else is answered 200 "ignored" and changes nothing - also when its bytes are not compact JSON', async () => {
    const pretty = JSON.stringify(stripeEvent('checkout.session.expired', tenant, invoiceId, due), null, 2);
    const res = await deliver(pretty);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ignored' });
    expect((await invoiceRow(invoiceId)).status).toBe('open');
  });

  it('Stripe says the session was paid: the invoice is paid and the term renewed, once; the same event again is a duplicate', async () => {
    const before = (await su.query('SELECT renewal_count FROM cards WHERE id = $1', [tenant.companyCard.id])).rows[0].renewal_count as number;
    const bytes = JSON.stringify(stripeEvent('checkout.session.completed', tenant, invoiceId, due));
    const res = await deliver(bytes);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'applied' });
    const row = await invoiceRow(invoiceId);
    expect(row.status).toBe('paid');
    expect(row.applied_at).not.toBeNull();
    expect((await su.query('SELECT renewal_count FROM cards WHERE id = $1', [tenant.companyCard.id])).rows[0].renewal_count).toBe(before + 1);
    // Stripe retries with a new signature and time: the event id is the same, nothing happens twice
    const again = await deliver(bytes);
    expect(again.body).toEqual({ status: 'duplicate' });
    expect((await su.query('SELECT renewal_count FROM cards WHERE id = $1', [tenant.companyCard.id])).rows[0].renewal_count).toBe(before + 1);
  });

  it('the stand-in provider\'s message format is refused while Stripe is the provider', async () => {
    const res = await new Client(t).request('POST', '/v1/billing/provider-events', {
      version: 'v1', event_id: 'evt_fake_000001', tenant_id: tenant.tenantId, invoice_id: invoiceId, outcome: 'paid', amount_minor: due,
      currency: 'USD', sent_at: t.clock.now().toISOString(), signature: '0'.repeat(64),
    }, { origin: null });
    expect(res.status).toBe(403);
  });
});
