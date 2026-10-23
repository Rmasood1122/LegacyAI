// Stripe as the payment provider (decision D37, docs/phase4/05-billing.md "Stripe") against a stand-in: a local TLS
// server that answers the way Stripe's documentation says (Checkout Sessions, webhook signatures; read 2026-10-23).
// Nothing here reaches Stripe. The keys are made-up values (allow-listed in .gitleaks.toml as fakes).
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CATALOGUE_IS_PLACEHOLDER, checkoutFields, createBilling, eventOfStripe, formEncode, liveMoneyProblem, STRIPE_API, STRIPE_API_VERSION, STRIPE_EVENT_TYPES, StripePaymentProvider, stripeSignatureValid,
} from '../../src/modules/billing/index.ts';
import { ConfigError, createLogger, loadConfig, Secret, type Database, type Notifier, type RateLimiter } from '../../src/modules/platform/index.ts';
import { testEnv, TEST_ORIGIN } from '../helpers/env.ts';

const TEST_KEY = 'sk_test_FAKEstripeKeyForUnitTests0001';
// Live-mode-shaped fakes are put together at run time: GitHub's push protection refuses a literal one even when fake.
const liveShaped = (prefix: 'sk' | 'rk', n: string): string => [prefix, 'live', `FAKEstripeKeyForUnitTests${n}`].join('_');
const LIVE_KEY = liveShaped('rk', '0002');
const WEBHOOK = 'whsec_FAKEwebhookSecretForUnitTests01';
const now = new Date('2026-10-23T12:00:00Z');
const seconds = (d: Date): number => Math.floor(d.getTime() / 1000);
const sign = (secret: string, t: number, body: string): string => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

const tenantId = randomUUID();
const invoiceId = randomUUID();
const session = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'cs_test_a1b2c3', object: 'checkout.session', mode: 'payment', payment_status: 'paid', client_reference_id: invoiceId,
  amount_total: 37500, currency: 'usd', metadata: { tenant_id: tenantId, invoice_id: invoiceId }, ...over,
});
const stripeEvent = (type: string, obj: Record<string, unknown> = session(), over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'evt_1PqRsTuVwXyZ', object: 'event', type, livemode: false, created: seconds(now), data: { object: obj }, ...over,
});

describe('the Stripe-Signature check', () => {
  const body = JSON.stringify(stripeEvent('checkout.session.completed'));
  const raw = Buffer.from(body);
  const t = seconds(now);

  it('a signature made with the endpoint secret over "<t>.<exact bytes>" is accepted, and says when it was sent', () => {
    expect(stripeSignatureValid(WEBHOOK, `t=${t},v1=${sign(WEBHOOK, t, body)}`, raw, now)).toEqual({ ok: true, sentAt: new Date(t * 1000) });
  });

  it('another secret, one changed byte, or the parsed-and-reprinted JSON instead of the bytes: refused', () => {
    expect(stripeSignatureValid(WEBHOOK, `t=${t},v1=${sign('whsec_FAKEanotherSecret000', t, body)}`, raw, now).ok).toBe(false);
    expect(stripeSignatureValid(WEBHOOK, `t=${t},v1=${sign(WEBHOOK, t, body)}`, Buffer.from(body.replace('37500', '37501')), now).ok).toBe(false);
    const pretty = JSON.stringify(JSON.parse(body), null, 2);
    expect(stripeSignatureValid(WEBHOOK, `t=${t},v1=${sign(WEBHOOK, t, body)}`, Buffer.from(pretty), now).ok).toBe(false);
  });

  it('the time is part of what is signed, and must be within 5 minutes either way', () => {
    expect(stripeSignatureValid(WEBHOOK, `t=${t + 1},v1=${sign(WEBHOOK, t, body)}`, raw, now).ok).toBe(false);
    const old = t - 301;
    expect(stripeSignatureValid(WEBHOOK, `t=${old},v1=${sign(WEBHOOK, old, body)}`, raw, now).ok).toBe(false);
    const future = t + 301;
    expect(stripeSignatureValid(WEBHOOK, `t=${future},v1=${sign(WEBHOOK, future, body)}`, raw, now).ok).toBe(false);
    const edge = t - 299;
    expect(stripeSignatureValid(WEBHOOK, `t=${edge},v1=${sign(WEBHOOK, edge, body)}`, raw, now).ok).toBe(true);
  });

  it('while a secret is rolled there are two v1 signatures: either may match; v0 (test events) is never used', () => {
    const good = sign(WEBHOOK, t, body);
    expect(stripeSignatureValid(WEBHOOK, `t=${t},v1=${'0'.repeat(64)},v1=${good}`, raw, now).ok).toBe(true);
    expect(stripeSignatureValid(WEBHOOK, `t=${t},v0=${good}`, raw, now).ok).toBe(false);
  });

  it('no header, no bytes, or a header that is not Stripe\'s form: refused', () => {
    expect(stripeSignatureValid(WEBHOOK, undefined, raw, now).ok).toBe(false);
    expect(stripeSignatureValid(WEBHOOK, `t=${t},v1=${sign(WEBHOOK, t, body)}`, null, now).ok).toBe(false);
    for (const header of ['', 'garbage', `v1=${sign(WEBHOOK, t, body)}`, `t=abc,v1=${sign(WEBHOOK, t, body)}`, `t=${t},v1=xyz`, `t=${t},v1=${'a'.repeat(5000)}`]) {
      expect(stripeSignatureValid(WEBHOOK, header, raw, now).ok, header.slice(0, 30)).toBe(false);
    }
  });
});

describe('what a verified Stripe event means here', () => {
  const sentAt = now;

  it('a completed, paid Checkout Session: paid, for the invoice and company it names, in upper-case currency', () => {
    expect(eventOfStripe(stripeEvent('checkout.session.completed'), false, sentAt)).toEqual({
      eventId: 'evt_1PqRsTuVwXyZ', tenantId, invoiceId, outcome: 'paid', amount: { amountMinor: 37500, currency: 'USD' }, sentAt,
    });
  });

  it('a bank payment: "completed" but unpaid changes nothing; its later success is paid, its failure declined', () => {
    expect(eventOfStripe(stripeEvent('checkout.session.completed', session({ payment_status: 'unpaid' })), false, sentAt)).toBe('ignored');
    expect(eventOfStripe(stripeEvent('checkout.session.async_payment_succeeded'), false, sentAt)).toMatchObject({ outcome: 'paid' });
    expect(eventOfStripe(stripeEvent('checkout.session.async_payment_failed', session({ payment_status: 'unpaid' })), false, sentAt)).toMatchObject({ outcome: 'declined' });
  });

  it('the three event types the webhook endpoint should send are exactly the ones acted on', () => {
    for (const type of STRIPE_EVENT_TYPES) expect(eventOfStripe(stripeEvent(type), false, sentAt), type).not.toBe('ignored');
    for (const type of ['checkout.session.expired', 'payment_intent.succeeded', 'charge.refunded', 'invoice.paid']) {
      expect(eventOfStripe(stripeEvent(type), false, sentAt), type).toBe('ignored');
    }
  });

  it('a session this product did not make (no or other ids, another mode) is ignored, not believed', () => {
    for (const s of [
      session({ metadata: null }), session({ metadata: { tenant_id: tenantId } }), session({ client_reference_id: randomUUID() }),
      session({ metadata: { tenant_id: 'not-a-uuid', invoice_id: invoiceId } }), session({ mode: 'subscription' }), session({ object: 'payment_intent' }),
      session({ amount_total: -1 }), session({ amount_total: 1.5 }), session({ currency: 'US' }),
    ]) {
      expect(eventOfStripe(stripeEvent('checkout.session.completed', s), false, sentAt)).toBe('ignored');
    }
    expect(eventOfStripe({ id: 'nope', object: 'event' }, false, sentAt)).toBe('ignored');
    expect(eventOfStripe(null, false, sentAt)).toBe('ignored');
  });

  it('a live key never accepts a test-mode event, and a test key never a live one', () => {
    expect(eventOfStripe(stripeEvent('checkout.session.completed'), true, sentAt)).toBe('ignored');
    expect(eventOfStripe(stripeEvent('checkout.session.completed', session(), { livemode: true }), false, sentAt)).toBe('ignored');
    expect(eventOfStripe(stripeEvent('checkout.session.completed', session(), { livemode: true }), true, sentAt)).toMatchObject({ outcome: 'paid' });
  });
});

describe('the Checkout Session request', () => {
  it('the same invoice always gives the same request (so the idempotency key always matches it)', () => {
    const req = { invoiceId, tenantId, amount: { amountMinor: 37500, currency: 'USD' } };
    expect(formEncode(checkoutFields(req, 'https://app.example.test/billing'))).toBe(formEncode(checkoutFields(req, 'https://app.example.test/billing')));
    const fields = Object.fromEntries(checkoutFields(req, 'https://app.example.test/billing'));
    expect(fields).toMatchObject({
      mode: 'payment', client_reference_id: invoiceId, 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': '37500', 'metadata[tenant_id]': tenantId, 'metadata[invoice_id]': invoiceId,
      success_url: 'https://app.example.test/billing?payment=done', cancel_url: 'https://app.example.test/billing?payment=cancelled',
    });
    // nothing about any person goes to Stripe from here: ids and an amount
    expect(JSON.stringify(fields)).not.toMatch(/@/);
  });

  it('form encoding escapes what Stripe\'s form syntax would misread', () => {
    expect(formEncode([['a[b]', 'x&y=z ü']])).toBe('a%5Bb%5D=x%26y%3Dz%20%C3%BC');
  });

  it('the API version is pinned, and the real address is Stripe\'s', () => {
    expect(STRIPE_API_VERSION).toBe('2026-07-29.dahlia');
    expect(STRIPE_API).toBe('https://api.stripe.com');
  });
});

describe('StripePaymentProvider against a stand-in for Stripe', () => {
  let dir: string;
  let cert: string;
  let server: Server;
  let port: number;
  const received: Array<{ method: string; path: string; headers: Record<string, unknown>; body: string }> = [];
  let answer: (res: ServerResponse) => void = () => undefined;
  const logLines: string[] = [];
  const log = createLogger('info', new Writable({
    write(chunk: Buffer, _enc, done) {
      logLines.push(chunk.toString('utf8'));
      done();
    },
  }));

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'legacyai-stripe-tls-'));
    const key = path.join(dir, 'k.pem');
    const crt = path.join(dir, 'c.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', '/CN=api.stripe.test', '-addext', 'subjectAltName=DNS:api.stripe.test', '-keyout', key, '-out', crt], { stdio: 'ignore' });
    cert = readFileSync(crt, 'utf8');
    server = createServer({ key: readFileSync(key, 'utf8'), cert }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        answer(res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const provider = (over: { key?: string; timeoutMs?: number } = {}): StripePaymentProvider => new StripePaymentProvider({
    secretKey: new Secret(over.key ?? TEST_KEY), webhookSecret: new Secret(WEBHOOK), returnUrl: 'https://app.example.test/billing', log,
    api: `https://api.stripe.test:${port}`,
    http: { resolve: async () => [{ address: '127.0.0.1', family: 4 }], isAllowed: (a) => a === '127.0.0.1', ca: cert, ...(over.timeoutMs === undefined ? {} : { timeoutMs: over.timeoutMs }) },
  });
  const request = { invoiceId, tenantId, amount: { amountMinor: 37500, currency: 'USD' } };
  const ok = (res: ServerResponse): void => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'cs_test_a1b2c3', object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/cs_test_a1b2c3' }));
  };

  it('creates a Checkout Session the way Stripe documents it; the answer is the session and its page', async () => {
    answer = ok;
    expect(await provider().start(request)).toEqual({ reference: 'cs_test_a1b2c3', paymentUrl: 'https://checkout.stripe.com/c/pay/cs_test_a1b2c3' });
    const r = received[received.length - 1] as (typeof received)[number];
    expect(r.method).toBe('POST');
    expect(r.path).toBe('/v1/checkout/sessions');
    expect(r.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(r.headers['stripe-version']).toBe(STRIPE_API_VERSION);
    expect(r.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(r.headers['idempotency-key']).toBe(`legacyai-invoice-${invoiceId}`);
    expect(Object.fromEntries(new URLSearchParams(r.body))).toMatchObject({ mode: 'payment', client_reference_id: invoiceId, 'line_items[0][price_data][unit_amount]': '37500' });
  });

  it('asking again for the same invoice sends the same key and the same body (Stripe answers with the same session)', async () => {
    answer = ok;
    const before = received.length;
    await provider().start(request);
    await provider().start(request);
    const [a, b] = received.slice(before);
    expect(a?.headers['idempotency-key']).toBe(b?.headers['idempotency-key']);
    expect(a?.body).toBe(b?.body);
  });

  it('Stripe refuses: an error (the invoice stays open), logged with Stripe\'s error words only - no key, no message', async () => {
    answer = (res) => res.writeHead(400, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'parameter_invalid_integer', message: 'Invalid integer: person@example.test' } }));
    logLines.length = 0;
    await expect(provider().start(request)).rejects.toThrow();
    const logged = logLines.join('\n');
    expect(logged).toContain('HTTP 400 invalid_request_error parameter_invalid_integer');
    expect(logged).toContain(invoiceId);
    for (const secret of [TEST_KEY, 'FAKEstripe', 'person@example.test', 'Invalid integer']) expect(logged).not.toContain(secret);
  });

  it('an answer whose page is not Stripe\'s own https page is not passed on to the Owner\'s browser', async () => {
    for (const url of ['https://evil.example/pay', 'http://checkout.stripe.com/x', 'javascript:alert(1)', 42]) {
      answer = (res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'cs_test_a1b2c3', url }));
      await expect(provider().start(request), String(url)).rejects.toThrow();
    }
    answer = (res) => res.writeHead(200).end('not json');
    await expect(provider().start(request)).rejects.toThrow();
  });

  it('Stripe too slow: an error, so the billing route answers 503 and the invoice stays open', async () => {
    answer = () => undefined;
    await expect(provider({ timeoutMs: 300 }).start(request)).rejects.toThrow();
  });

  it('parseEvent: the signed bytes from the header, end to end; collectsUnattended is false (no automatic renewal)', () => {
    const p = provider();
    expect(p.collectsUnattended).toBe(false);
    expect(p.canCollect).toBe(true);
    const body = stripeEvent('checkout.session.completed');
    const raw = JSON.stringify(body);
    const t = seconds(now);
    const signed = { body, rawBody: Buffer.from(raw), headers: { 'stripe-signature': `t=${t},v1=${sign(WEBHOOK, t, raw)}` } };
    expect(p.parseEvent(signed, now)).toMatchObject({ outcome: 'paid', invoiceId, tenantId });
    expect(p.parseEvent({ ...signed, headers: {} }, now)).toBeNull();
    expect(p.parseEvent({ ...signed, rawBody: null }, now)).toBeNull();
    // a live key and a test-mode event: verified, but ignored
    expect(provider({ key: LIVE_KEY }).parseEvent(signed, now)).toBe('ignored');
  });
});

describe('no real money at an invented price', () => {
  const stripeWith = (key: string): StripePaymentProvider =>
    new StripePaymentProvider({ secretKey: new Secret(key), webhookSecret: new Secret(WEBHOOK), returnUrl: 'https://app.example.test/billing', log: createLogger('silent') });
  const build = (key: string) => () => createBilling({
    config: loadConfig(testEnv()), db: {} as Database, notifier: {} as Notifier, rateLimiter: {} as RateLimiter, log: createLogger('silent'), provider: stripeWith(key),
  });

  it('with a placeholder catalogue a live Stripe key is refused; a test-mode key (no money) is not', () => {
    expect(liveMoneyProblem(stripeWith(LIVE_KEY), true)).toMatch(/prices are still placeholders/);
    expect(liveMoneyProblem(stripeWith(liveShaped('sk', '0003')), true)).toMatch(/prices are still placeholders/);
    expect(liveMoneyProblem(stripeWith(TEST_KEY), true)).toBeNull();
    expect(liveMoneyProblem(stripeWith(LIVE_KEY), false)).toBeNull();
  });

  it('the catalogue holds the selected prices (D38), so the service starts with a live key as well as a test one', () => {
    expect(CATALOGUE_IS_PLACEHOLDER).toBe(false);
    expect(build(LIVE_KEY)).not.toThrow();
    expect(build(TEST_KEY)).not.toThrow();
  });
});

describe('configuration', () => {
  const stripe = (over: Record<string, string | undefined> = {}) =>
    testEnv({ PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: TEST_KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK, ...over });

  it('PAYMENT_PROVIDER=stripe with both keys; the return page defaults to the web application\'s billing page; keys stay secret', () => {
    const c = loadConfig(stripe());
    expect(c.payment.provider).toBe('stripe');
    expect(c.payment.stripe?.secretKey.reveal()).toBe(TEST_KEY);
    expect(c.payment.stripe?.returnUrl).toBe(`${TEST_ORIGIN}/billing`);
    expect(JSON.stringify(c.payment)).not.toContain('FAKE');
    expect(loadConfig(stripe({ STRIPE_SECRET_KEY: LIVE_KEY })).payment.stripe).not.toBeNull();
  });

  it('a missing or malformed key or secret, or a return page outside the web application: refused at start-up', () => {
    expect(() => loadConfig(stripe({ STRIPE_SECRET_KEY: undefined }))).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => loadConfig(stripe({ STRIPE_SECRET_KEY: 'pk_test_FAKEpublishableKey0001' }))).toThrow(/STRIPE_SECRET_KEY/);   // the publishable key
    expect(() => loadConfig(stripe({ STRIPE_WEBHOOK_SECRET: undefined }))).toThrow(/STRIPE_WEBHOOK_SECRET/);
    expect(() => loadConfig(stripe({ STRIPE_WEBHOOK_SECRET: 'not-a-secret' }))).toThrow(ConfigError);
    expect(() => loadConfig(stripe({ STRIPE_RETURN_URL: 'https://evil.example/billing' }))).toThrow(/STRIPE_RETURN_URL/);
    expect(() => loadConfig(stripe({ STRIPE_RETURN_URL: `${TEST_ORIGIN}/billing?x=1` }))).toThrow(/STRIPE_RETURN_URL/);
    expect(loadConfig(stripe({ STRIPE_RETURN_URL: `${TEST_ORIGIN}/settings/billing` })).payment.stripe?.returnUrl).toBe(`${TEST_ORIGIN}/settings/billing`);
  });

  it('the placeholder keys never run in production', () => {
    let error: unknown;
    try {
      loadConfig(stripe({ NODE_ENV: 'production' }));
    } catch (err) {
      error = err;
    }
    expect(String((error as Error).message)).toMatch(/placeholder Stripe key/);
  });
});
