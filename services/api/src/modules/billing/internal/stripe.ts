// Stripe as the payment provider (decision D37; docs/phase4/05-billing.md, "Stripe"). No Stripe library: two things
// are needed and both are short.
//
// 1. COLLECTING (start). One Checkout Session per invoice, on Stripe's own payment page - so no card number ever
//    reaches this service (https://docs.stripe.com/api/checkout/sessions/create, read 2026-10-23):
//      POST https://api.stripe.com/v1/checkout/sessions          form-encoded, Authorization: Bearer <secret key>
//      Stripe-Version: STRIPE_API_VERSION                          pinned: what Stripe sends back does not move
//      Idempotency-Key: legacyai-invoice-<invoice id>              asking again for the same invoice gives the SAME
//                                                                  session, never a second charge
//      mode=payment, one line of the invoice's amount, client_reference_id and metadata = the invoice and company
//    The answer's `url` is where the Owner pays. The outcome arrives later as a signed event; this answer says nothing
//    about money.
//
// 2. BELIEVING A MESSAGE (parseEvent). Stripe signs the exact bytes it sends
//    (https://docs.stripe.com/webhooks?verify=verify-manually, read 2026-10-23):
//      Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex> while a secret is rolled][,v0=... ignored]
//      v1 = HMAC-SHA256(endpoint secret, "<t>.<raw body>"), compared in constant time; t within 5 minutes of now.
//    Only then is the body read. What this product acts on:
//      checkout.session.completed with payment_status "paid", checkout.session.async_payment_succeeded  -> paid
//      checkout.session.async_payment_failed                                                           -> declined
//    Anything else that is verified (another event type, a session this product did not make, an unpaid session
//    whose bank payment is still on its way) is 'ignored': answered 200 so that Stripe stops sending it, and changes
//    nothing. A live key never accepts a test-mode event, and the reverse.
//
// Automatic renewal is NOT offered with Stripe: the Owner pays on Stripe's page each term (collectsUnattended).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { httpsRequest, type HttpsOptions, type Logger, type Secret } from '../../platform/index.ts';
import { EVENT_TOLERANCE_MS, type IncomingMessage, type PaymentEvent, type PaymentProvider, type PaymentRequest, type StartedPayment } from './provider.ts';

export const STRIPE_API = 'https://api.stripe.com';
/** Pinned. Stripe's newest on 2026-10-23 was 2026-09-30.endive (23 days old); this is the newest one over 60 days. */
export const STRIPE_API_VERSION = '2026-07-29.dahlia';
/** The event types the webhook endpoint in Stripe should send (and the only ones that do anything). */
export const STRIPE_EVENT_TYPES = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed'] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The form encoding Stripe's API takes (`a[b][c]=v`). Pure. */
export function formEncode(fields: ReadonlyArray<readonly [string, string]>): string {
  return fields.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

/** The fields of the Checkout Session for one invoice. Pure: the same invoice always gives the same request. */
export function checkoutFields(request: PaymentRequest, returnUrl: string): Array<[string, string]> {
  const { invoiceId, tenantId, amount } = request;
  return [
    ['mode', 'payment'],
    ['success_url', `${returnUrl}?payment=done`],
    ['cancel_url', `${returnUrl}?payment=cancelled`],
    ['client_reference_id', invoiceId],
    ['line_items[0][quantity]', '1'],
    ['line_items[0][price_data][currency]', amount.currency.toLowerCase()],
    ['line_items[0][price_data][unit_amount]', String(amount.amountMinor)],
    ['line_items[0][price_data][product_data][name]', 'LegacyAI subscription'],
    ['metadata[tenant_id]', tenantId],
    ['metadata[invoice_id]', invoiceId],
    ['payment_intent_data[metadata][tenant_id]', tenantId],
    ['payment_intent_data[metadata][invoice_id]', invoiceId],
  ];
}

/**
 * Whether the Stripe-Signature header signs these bytes with this secret, and was made within the tolerance of now.
 * Pure. Every way of being wrong is the same `false`.
 */
export function stripeSignatureValid(secret: string, header: string | undefined, rawBody: Buffer | null, now: Date): { ok: true; sentAt: Date } | { ok: false } {
  if (header === undefined || rawBody === null || header.length > 2048) return { ok: false };
  let t: string | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const at = part.indexOf('=');
    if (at < 1) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === 't') t = value;
    else if (key === 'v1') v1.push(value);   // every other scheme (v0 = test events' fake one) is ignored: no downgrade
  }
  if (t === null || !/^\d{1,12}$/.test(t) || v1.length === 0 || v1.length > 8) return { ok: false };
  const expected = createHmac('sha256', secret).update(`${t}.`, 'utf8').update(rawBody).digest();
  let match = false;
  for (const candidate of v1) {
    if (!/^[0-9a-f]{64}$/.test(candidate)) continue;
    // no early exit: every candidate is compared
    if (timingSafeEqual(expected, Buffer.from(candidate, 'hex'))) match = true;
  }
  if (!match) return { ok: false };
  const sentAt = new Date(Number(t) * 1000);
  if (Math.abs(now.getTime() - sentAt.getTime()) > EVENT_TOLERANCE_MS) return { ok: false };
  return { ok: true, sentAt };
}

const OUTCOMES: Readonly<Record<string, 'paid' | 'declined' | 'if_paid'>> = {
  'checkout.session.completed': 'if_paid',
  'checkout.session.async_payment_succeeded': 'paid',
  'checkout.session.async_payment_failed': 'declined',
};

/** A VERIFIED Stripe event as this product's event, or 'ignored'. Pure. */
export function eventOfStripe(body: unknown, live: boolean, sentAt: Date): PaymentEvent | 'ignored' {
  if (body === null || typeof body !== 'object') return 'ignored';
  const e = body as { id?: unknown; object?: unknown; type?: unknown; livemode?: unknown; data?: { object?: unknown } };
  if (e.object !== 'event' || typeof e.id !== 'string' || !/^evt_[A-Za-z0-9]{4,96}$/.test(e.id)) return 'ignored';
  if (e.livemode !== live) return 'ignored';
  const kind = typeof e.type === 'string' ? OUTCOMES[e.type] : undefined;
  if (kind === undefined) return 'ignored';
  const s = (e.data?.object ?? null) as null | {
    object?: unknown; mode?: unknown; payment_status?: unknown; client_reference_id?: unknown; amount_total?: unknown; currency?: unknown;
    metadata?: { tenant_id?: unknown; invoice_id?: unknown } | null;
  };
  if (s === null || typeof s !== 'object' || s.object !== 'checkout.session' || s.mode !== 'payment') return 'ignored';
  const tenantId = s.metadata?.tenant_id;
  const invoiceId = s.metadata?.invoice_id;
  // a session this product made names its invoice twice, in the same words
  if (typeof tenantId !== 'string' || !UUID.test(tenantId) || typeof invoiceId !== 'string' || !UUID.test(invoiceId) || s.client_reference_id !== invoiceId) {
    return 'ignored';
  }
  if (!Number.isSafeInteger(s.amount_total) || (s.amount_total as number) < 0) return 'ignored';
  if (typeof s.currency !== 'string' || !/^[a-z]{3}$/.test(s.currency)) return 'ignored';
  let outcome: 'paid' | 'declined';
  if (kind === 'if_paid') {
    // a bank payment that is still on its way completes the session "unpaid"; its outcome is a later event
    if (s.payment_status !== 'paid') return 'ignored';
    outcome = 'paid';
  } else {
    outcome = kind;
  }
  return {
    eventId: e.id, tenantId, invoiceId, outcome, sentAt,
    amount: { amountMinor: s.amount_total as number, currency: s.currency.toUpperCase() },
  };
}

/** Stripe's error type and code (fixed words), never its message. */
function stripeError(body: Buffer): string {
  try {
    const err = (JSON.parse(body.toString('utf8')) as { error?: { type?: unknown; code?: unknown } }).error;
    const words = [err?.type, err?.code].filter((w): w is string => typeof w === 'string' && /^[a-z_]{1,64}$/.test(w));
    return words.join(' ');
  } catch {
    return '';
  }
}

export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  readonly canCollect = true;
  readonly collectsUnattended = false;
  /** A live key takes real money; a test-mode key takes none. */
  readonly live: boolean;
  readonly #secretKey: Secret;
  readonly #webhookSecret: Secret;
  readonly #returnUrl: string;
  readonly #log: Logger;
  readonly #api: string;
  readonly #http: HttpsOptions;

  constructor(deps: {
    secretKey: Secret; webhookSecret: Secret;
    /** Where Stripe's page sends the Owner back: the web application's billing page. */
    returnUrl: string;
    log: Logger;
    /** Tests only: a stand-in for Stripe's API (its address, and the test resolver / authority of HttpsOptions). */
    api?: string; http?: Partial<HttpsOptions>;
  }) {
    this.#secretKey = deps.secretKey;
    this.#webhookSecret = deps.webhookSecret;
    this.live = /^(sk|rk)_live_/.test(deps.secretKey.reveal());
    this.#returnUrl = deps.returnUrl;
    this.#log = deps.log;
    this.#api = deps.api ?? STRIPE_API;
    // below the 10 seconds the billing routes give a provider (PROVIDER_TIMEOUT_MS)
    this.#http = { timeoutMs: 9_000, maxBytes: 256 * 1024, ...deps.http };
  }

  async start(request: PaymentRequest): Promise<StartedPayment> {
    const response = await httpsRequest({
      url: `${this.#api}/v1/checkout/sessions`,
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#secretKey.reveal()}`,
        'content-type': 'application/x-www-form-urlencoded',
        'stripe-version': STRIPE_API_VERSION,
        'idempotency-key': `legacyai-invoice-${request.invoiceId}`,
      },
      body: formEncode(checkoutFields(request, this.#returnUrl)),
    }, this.#http);
    if (!response.ok) {
      this.#log.warn({ invoice_id: request.invoiceId, stripe: `no answer (${response.error})` }, 'billing: Stripe did not answer');
      throw new Error('stripe: no answer');
    }
    if (response.status < 200 || response.status >= 300) {
      // the invoice id and Stripe's error words only: no key, no amount, nobody's details
      this.#log.warn({ invoice_id: request.invoiceId, stripe: `HTTP ${response.status} ${stripeError(response.body)}`.trim() }, 'billing: Stripe refused a payment session');
      throw new Error('stripe: refused');
    }
    let session: { id?: unknown; url?: unknown };
    try {
      session = JSON.parse(response.body.toString('utf8')) as { id?: unknown; url?: unknown };
    } catch {
      throw new Error('stripe: unreadable answer');
    }
    if (typeof session.id !== 'string' || !/^cs_[A-Za-z0-9_]{1,190}$/.test(session.id)) throw new Error('stripe: unreadable answer');
    // the Owner's browser is sent here: only Stripe's own https page is passed on
    if (typeof session.url !== 'string' || !session.url.startsWith('https://checkout.stripe.com/') || session.url.length > 2048) {
      throw new Error('stripe: unexpected payment page');
    }
    return { reference: session.id, paymentUrl: session.url };
  }

  parseEvent(message: IncomingMessage, now: Date): PaymentEvent | 'ignored' | null {
    const signed = stripeSignatureValid(this.#webhookSecret.reveal(), message.headers['stripe-signature'], message.rawBody, now);
    if (!signed.ok) return null;
    return eventOfStripe(message.body, this.live, signed.sentAt);
  }
}
