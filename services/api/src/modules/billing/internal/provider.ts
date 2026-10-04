// The payment provider as the billing module sees it, and the check on the provider's messages.
//
// Nothing here knows any real provider: no SDK, no network call, no account. The words used are the product's own
// ("payment", "event", "paid", "declined"). A real provider is added as one more implementation of PaymentProvider:
// it collects money in start() and turns ITS message into a PaymentEvent in parseEvent(). The callers do not change.
// docs/phase4/05-billing.md says what that still needs (the raw bytes of the request, above all).
//
// HOW A MESSAGE IS TRUSTED. The provider tells us "this invoice was paid" by calling the API. That call carries no
// session, so everything rests on its signature:
//   - the signature is an HMAC-SHA256 over ALL the fields that matter (version, event id, company, invoice, outcome,
//     amount, currency, time of sending), with a key only the provider and the API hold;
//   - it is compared in constant time;
//   - the time of sending must be within a few minutes of now (an old message that was recorded cannot be sent again
//     later);
//   - the event id is stored, so the same message arriving twice changes nothing the second time (billing.ts);
//   - without a key in the configuration, and with no provider connected, every message is refused.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Money } from './catalogue.ts';

export interface PaymentRequest {
  invoiceId: string;
  tenantId: string;
  amount: Money;
}

/** What a provider's message looks like when it reaches the API: nothing in it is trusted before parseEvent. */
export interface IncomingMessage {
  /** The body as the API parsed it. */
  body: unknown;
  /** Request headers, lower-case names. A real provider puts its signature here. */
  headers: Readonly<Record<string, string | undefined>>;
  /** The exact bytes that were sent, when the HTTP layer kept them (it does not yet: see 05-billing.md). */
  rawBody: Buffer | null;
}

export interface PaymentProvider {
  readonly name: string;
  /** False = nothing can be collected through the product (an invoice is then settled by the operator). */
  readonly canCollect: boolean;
  /** Asks the provider to collect the amount. The outcome arrives later as a signed event, never in this answer. */
  start(request: PaymentRequest): Promise<{ reference: string }>;
  /** The provider's message as a verified event in the product's own words, or null. Null says nothing about WHY. */
  parseEvent(message: IncomingMessage, now: Date): PaymentEvent | null;
}

export type PaymentOutcome = 'paid' | 'declined';

/** The stand-in provider's message format (also what the contract documents until a real provider is chosen). */
export interface PaymentEventInput {
  version: string;
  event_id: string;
  tenant_id: string;
  invoice_id: string;
  outcome: string;
  amount_minor: number;
  currency: string;
  sent_at: string;
  signature: string;
}

export interface PaymentEvent {
  eventId: string;
  tenantId: string;
  invoiceId: string;
  outcome: PaymentOutcome;
  amount: Money;
  sentAt: Date;
}

/** How far the time of sending may be from the API's clock, either way. */
export const EVENT_TOLERANCE_MS = 5 * 60_000;
export const EVENT_VERSION = 'v1';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The exact text that is signed. Fields are joined by line breaks; none of them can contain one (see verifyEvent). */
function signedText(e: Omit<PaymentEventInput, 'signature'>): string {
  return [e.version, e.event_id, e.tenant_id, e.invoice_id, e.outcome, String(e.amount_minor), e.currency, e.sent_at].join('\n');
}

export function signEvent(key: Buffer, e: Omit<PaymentEventInput, 'signature'>): string {
  return createHmac('sha256', key).update(signedText(e), 'utf8').digest('hex');
}

/** The message as a trusted event, or null. Pure: no clock, no database, no HTTP. */
export function verifyEvent(key: Buffer | null, input: PaymentEventInput, now: Date): PaymentEvent | null {
  if (key === null || key.length < 32) return null;
  if (input === null || typeof input !== 'object') return null;
  if (input.version !== EVENT_VERSION) return null;
  if (typeof input.event_id !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.event_id)) return null;
  if (typeof input.tenant_id !== 'string' || !UUID.test(input.tenant_id)) return null;
  if (typeof input.invoice_id !== 'string' || !UUID.test(input.invoice_id)) return null;
  if (input.outcome !== 'paid' && input.outcome !== 'declined') return null;
  if (!Number.isSafeInteger(input.amount_minor) || input.amount_minor < 0) return null;
  if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)) return null;
  if (typeof input.sent_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(input.sent_at)) return null;
  if (typeof input.signature !== 'string' || !/^[0-9a-f]{64}$/.test(input.signature)) return null;

  const expected = Buffer.from(signEvent(key, input), 'hex');
  const given = Buffer.from(input.signature, 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  const sentAt = new Date(input.sent_at);
  if (Number.isNaN(sentAt.getTime()) || Math.abs(now.getTime() - sentAt.getTime()) > EVENT_TOLERANCE_MS) return null;
  return {
    eventId: input.event_id, tenantId: input.tenant_id, invoiceId: input.invoice_id, outcome: input.outcome,
    amount: { amountMinor: input.amount_minor, currency: input.currency }, sentAt,
  };
}

/** Configuration 'none': nothing can be collected through the product, and no message is ever accepted. */
export class NoPaymentProvider implements PaymentProvider {
  readonly name = 'none';
  readonly canCollect = false;
  async start(): Promise<{ reference: string }> {
    throw new Error('no payment provider is configured');
  }
  parseEvent(): PaymentEvent | null {
    return null;
  }
}

/**
 * The stand-in for tests and demonstrations. It TAKES NO MONEY and calls nobody: it only hands back a reference.
 * The outcome is delivered the way a real provider would deliver it - as a signed event sent to the API - by the
 * test that plays the provider (signEvent with the same key).
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake';
  readonly canCollect = true;
  readonly #key: Buffer | null;
  constructor(key: Buffer | null) {
    this.#key = key;
  }
  async start(request: PaymentRequest): Promise<{ reference: string }> {
    return { reference: `fake-${request.invoiceId}` };
  }
  parseEvent(message: IncomingMessage, now: Date): PaymentEvent | null {
    return verifyEvent(this.#key, message.body as PaymentEventInput, now);
  }
}
