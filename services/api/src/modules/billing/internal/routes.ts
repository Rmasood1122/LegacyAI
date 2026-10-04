// Billing endpoints: the Owner's renewal center, the provider's signed messages, and the operator's side.
//
// The paths are /v1/billing/... for the caller's own company. That is a deliberate exception to
// /v1/tenants/current/...: billing is its own area with its own rights, and the provider's endpoint belongs to it
// (docs/phase4/05-billing.md). The operator's side follows the usual /v1/tenants/{tenant_id}/... form.
import { ProblemError, problems } from '../../../shared/errors.ts';
import type { RequestContext, ResourceRef, CardSubject } from '../../../shared/policy-types.ts';
import {
  decodeIdCursor, encodeCursor, getTenant, pageOf, PLATFORM_TENANT_ID, writeAudit, type Database, type RateLimiter, type RouteDef, type Tx,
} from '../../platform/index.ts';
import { isUuid } from '../../../shared/crypto.ts';
import { notAppliedReason, toApiInvoice, type Billing, type EventResult, type InvoiceRow } from './billing.ts';
import type { PaymentEvent } from './provider.ts';

/** The company's own subscription. Only the Company Owner holds the rights (migration 20261004000400). */
const ownBilling = async ({ subject }: { subject: CardSubject }): Promise<ResourceRef> => ({
  type: 'subscription', id: subject.tenant_id, tenant_id: subject.tenant_id,
});
const ownInvoices = async ({ subject }: { subject: CardSubject }): Promise<ResourceRef> => ({
  type: 'invoice', tenant_id: subject.tenant_id, collection: true,
});
/** What the platform operator acts on: a customer company, named by id. */
const targetTenant = async ({ subject, params }: { subject: CardSubject; params: { tenant_id: string } }): Promise<ResourceRef> => ({
  type: 'tenant', id: params.tenant_id, tenant_id: subject.tenant_id,
});

// billing:read is granted for the whole company only (decision D23): a card holding it more narrowly - no role
// does - is refused rather than given the company's invoices.
const INVOICES = { unfiltered: 'A company has one list of invoices; it cannot be narrowed to a department or a person.' };

/** How long the provider gets to answer before the request gives up (the invoice stays open and can be tried again). */
export const PROVIDER_TIMEOUT_MS = 10_000;

const providerFailed = (): ProblemError => new ProblemError(502, 'payment-provider-error', 'The payment provider did not accept the request; the invoice is open and can be tried again');
const providerUnavailable = (): ProblemError => new ProblemError(503, 'payment-provider-unavailable', 'The payment provider did not answer in time; the invoice is open and can be tried again');

/**
 * Asks the provider to collect an invoice that is ALREADY committed, with no database transaction open, and then
 * records the provider's reference in a transaction of its own. A provider that throws or does not answer leaves an
 * open invoice and no charge on record; asking again collects the same invoice.
 */
export async function collect(
  billing: Billing, invoice: InvoiceRow, tenantId: string, withTx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>, timeoutMs = PROVIDER_TIMEOUT_MS,
): Promise<InvoiceRow> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(providerUnavailable()), timeoutMs);
  });
  let reference: string;
  try {
    const started = billing.provider.start({ invoiceId: invoice.id, tenantId, amount: { amountMinor: Number(invoice.amount_minor), currency: invoice.currency } });
    reference = (await Promise.race([started, timeout])).reference;
  } catch (err) {
    throw err instanceof ProblemError ? err : providerFailed();
  } finally {
    clearTimeout(timer);
  }
  return (await withTx((tx) => billing.recordProviderReference(tx, tenantId, invoice.id, reference))) ?? invoice;
}

/**
 * Finishes a payment that is on record: puts the paid invoice into effect in one transaction, or - if that is not
 * possible - writes that down and tells the Owner and the operator in another. Safe to call again at any time
 * (after a crash, for a redelivered message, from the housekeeping sweep): an invoice takes effect once and is
 * reported once.
 */
export async function finish(
  billing: Billing, tenantId: string, invoiceId: string, withTx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>, ctx: RequestContext,
): Promise<'applied' | 'not_applied'> {
  try {
    await withTx((tx) => billing.applyPaid(tx, tenantId, invoiceId, { actorKind: 'system', cardId: null }, ctx));
    return 'applied';
  } catch (err) {
    // The money is on record (paid, not in effect). If even this second step fails, the invoice stays "unfinished"
    // and the next delivery of the message or the next sweep comes back to it.
    await withTx((tx) => billing.recordNotApplied(tx, tenantId, invoiceId, notAppliedReason(err), ctx));
    return 'not_applied';
  }
}

/**
 * What a VERIFIED provider message does, in up to three transactions: (1) the message is stored, an open invoice is
 * marked paid and the audit row "payment received" is written; (2) the paid invoice takes effect; (3) only if (2)
 * failed: that is written down and people are told. The payment is on record after (1) whatever happens next, and a
 * message that arrives again finishes (2) and (3) if they did not happen.
 */
export async function receive(db: Database, billing: Billing, event: PaymentEvent, ctx: RequestContext): Promise<EventResult> {
  const known = await db.withTenantTx(event.tenantId, async (tx) => {
    const tenant = await getTenant(tx, event.tenantId);
    return tenant !== null && !tenant.is_platform;
  });
  if (!known) {
    // signed, but for a company that does not exist: nothing of it can be stored there, so the operator's log keeps it
    await db.withTenantTx(PLATFORM_TENANT_ID, (tx) => writeAudit(tx, {
      tenantId: PLATFORM_TENANT_ID, actorKind: 'system', action: 'billing:payment', resourceType: 'tenant', resourceId: event.tenantId, decision: 'event',
      reasonCode: 'PAYMENT_EVENT_UNKNOWN_COMPANY', requestId: ctx.requestId, ip: ctx.ip, details: { target_tenant_id: event.tenantId, payment_outcome: event.outcome },
    }));
    return 'recorded';
  }
  const recorded = await db.withTenantTx(event.tenantId, (tx) => billing.recordEvent(tx, event, ctx));
  if (recorded.apply === null) return recorded.result;
  const outcome = await finish(billing, event.tenantId, recorded.apply, (fn) => db.withTenantTx(event.tenantId, fn), ctx);
  // The provider did its job and gets a normal answer either way; a repeated message stays "duplicate".
  if (recorded.result === 'duplicate') return 'duplicate';
  return outcome === 'applied' ? 'applied' : 'recorded';
}

export function billingRoutes(deps: { db: Database; billing: Billing; rateLimiter: RateLimiter; providerTimeoutMs?: number }): RouteDef[] {
  const { db, billing } = deps;

  const planCode = async (tx: Tx, tenantId: string): Promise<string> => {
    const tenant = await getTenant(tx, tenantId);
    if (!tenant || tenant.is_platform) throw problems.notFound();
    return tenant.plan_code;
  };

  return [
    {
      operationId: 'getSubscription',
      kind: 'session',
      policy: { resource: ownBilling },
      handler: async ({ tx, subject, ctx }) => ({ body: await billing.view(tx, subject.tenant_id, await planCode(tx, subject.tenant_id), ctx.now) }),
    },
    {
      operationId: 'updateSubscription',
      kind: 'session',
      policy: { resource: ownBilling },
      handler: async ({ tx, subject, body, ctx }) => {
        const plan = await planCode(tx, subject.tenant_id);
        await billing.update(tx, subject.tenant_id, { seats: body.seats, auto_renew: body.auto_renew }, subject.card_id, ctx);
        return { body: await billing.view(tx, subject.tenant_id, plan, ctx.now) };
      },
    },
    {
      operationId: 'listInvoices',
      kind: 'session',
      listFilter: INVOICES,
      policy: { resource: ownInvoices },
      handler: async ({ tx, subject, query }) => {
        const rows = await billing.invoices(tx, subject.tenant_id, query.limit, decodeIdCursor(query.cursor));
        const page = pageOf(rows, query.limit, (last) => encodeCursor(last.id));
        return { body: { items: page.items.map(toApiInvoice), next_cursor: page.next_cursor } };
      },
    },
    {
      // How a client learns what became of a renewal: it reads the invoice (or the subscription) again.
      operationId: 'getInvoice',
      kind: 'session',
      policy: {
        resource: async ({ tx, subject, params }) => {
          if (!isUuid(params.invoice_id)) return null;
          return (await billing.invoice(tx, subject.tenant_id, params.invoice_id)) === null
            ? null : { type: 'invoice', id: params.invoice_id, tenant_id: subject.tenant_id };
        },
      },
      handler: async ({ tx, subject, params }) => {
        const invoice = await billing.invoice(tx, subject.tenant_id, params.invoice_id);
        if (invoice === null) throw problems.notFound();
        return { body: toApiInvoice(invoice) };
      },
    },
    {
      // Issues the invoice for what is due now and asks the provider to collect it. The invoice is committed BEFORE
      // the provider is called (gateway kind: no transaction is open during the call). The term changes only when
      // the provider's signed message arrives (receivePaymentEvent) - or at once when there is nothing to pay.
      operationId: 'startRenewal',
      kind: 'gateway',
      policy: { resource: ownBilling },
      prepare: async ({ tx, subject, ctx }) => {
        const tenantId = subject.tenant_id;
        const issued = await billing.issueDue(tx, tenantId, await planCode(tx, tenantId), { cardId: subject.card_id, automatic: false }, ctx);
        const answer = (invoice: InvoiceRow) => ({
          status: 200,
          body: { invoice: toApiInvoice(invoice), already_open: issued.reused, collected_by: billing.provider.canCollect ? 'provider' : 'operator' },
        });
        if (!issued.collect) return answer(issued.invoice);
        return { call: async ({ withTx }) => answer(await collect(billing, issued.invoice, tenantId, withTx, deps.providerTimeoutMs)) };
      },
    },
    {
      operationId: 'receivePaymentEvent',
      kind: 'public',
      // No header is needed by the stand-in provider (its signature is a field of the message). A real provider's
      // signature header would be named here; cookies and Authorization can never be.
      headers: [],
      policy: {
        public: true,
        reason: 'The payment provider calls this without a session. Every message is checked against a signature made with a key only the provider and the API hold; without a valid signature nothing is read or changed.',
      },
      handler: async ({ body, headers, ctx }) => {
        const limit = await deps.rateLimiter.hit(`payment-event:${ctx.ip}`, 120, 60, ctx.now);
        if (!limit.allowed) throw problems.tooManyRequests(limit.retryAfterSeconds);
        // With no provider connected parseEvent refuses everything, whatever key is configured.
        const event = billing.provider.parseEvent({ body, headers, rawBody: null }, ctx.now);
        // One answer for every message that is not accepted: a caller learns nothing about why.
        if (event === null) throw problems.forbidden();
        // The company named in the message is trusted only now, after the signature was checked. A second limit per
        // company: the per-address one above depends on the proxy setting (TRUST_PROXY) being right.
        const perCompany = await deps.rateLimiter.hit(`payment-event-company:${event.tenantId}`, 60, 60, ctx.now);
        if (!perCompany.allowed) throw problems.tooManyRequests(perCompany.retryAfterSeconds);
        return { body: { status: await receive(db, billing, event, ctx) } };
      },
    },
    {
      operationId: 'getTenantBilling',
      kind: 'session',
      policy: { resource: targetTenant },
      handler: async ({ tx, params, query, ctx }) => {
        const tenantId: string = params.tenant_id;
        const body = await db.withinTenant(tx, tenantId, async () => {
          const plan = await planCode(tx, tenantId);
          const page = pageOf(await billing.invoices(tx, tenantId, query.limit, decodeIdCursor(query.cursor)), query.limit, (last) => encodeCursor(last.id));
          return { tenant_id: tenantId, subscription: await billing.view(tx, tenantId, plan, ctx.now), invoices: page.items.map(toApiInvoice), next_cursor: page.next_cursor };
        });
        return { body };
      },
    },
    {
      // Only the operator can remove a company's seat limit (or set it by hand).
      operationId: 'setTenantSeatLimit',
      kind: 'session',
      policy: { resource: targetTenant },
      handler: async ({ tx, subject, params, body, ctx }) => {
        const tenantId: string = params.tenant_id;
        const limit: number | null = body.seat_limit;
        const view = await db.withinTenant(tx, tenantId, async () => {
          const plan = await planCode(tx, tenantId);
          await billing.setSeatLimit(tx, tenantId, limit, ctx);
          return billing.view(tx, tenantId, plan, ctx.now);
        });
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'billing:operate', resourceType: 'tenant',
          resourceId: tenantId, decision: 'event', reasonCode: 'SEAT_LIMIT_SET', requestId: ctx.requestId, ip: ctx.ip,
          details: limit === null ? { target_tenant_id: tenantId } : { target_tenant_id: tenantId, seats: limit },
        });
        return { body: view };
      },
    },
    {
      // A payment that reached LegacyAI some other way, or one that is on record and did not take effect. The
      // operator names the invoice and what was paid; a mismatch is refused. The company's own log says "operator";
      // the operator's log names the card.
      operationId: 'recordManualPayment',
      kind: 'session',
      policy: { resource: targetTenant },
      handler: async ({ tx, subject, params, body, ctx }) => {
        const tenantId: string = params.tenant_id;
        const note: string = body.reference;
        // Nothing that looks like a payment card number is ever stored (and the audit log refuses 16 digits anyway).
        if (/\d{12,}/.test(note.replace(/[\s-]/g, ''))) {
          throw problems.unprocessable('The reference must be a case or transfer id', [{ path: 'body/reference', message: 'must not contain a long run of digits' }]);
        }
        const invoice = await db.withinTenant(tx, tenantId, async () => {
          await planCode(tx, tenantId);
          return billing.settleByOperator(tx, tenantId, {
            invoiceId: body.invoice_id, amount: { amountMinor: body.amount.amount_minor, currency: body.amount.currency }, note,
            discardRemainingDays: body.discard_remaining_days === true,
          }, ctx);
        });
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'billing:operate', resourceType: 'tenant',
          resourceId: tenantId, decision: 'event', reasonCode: 'MANUAL_PAYMENT_RECORDED', requestId: ctx.requestId, ip: ctx.ip,
          details: { target_tenant_id: tenantId, invoice_id: invoice.id, amount_minor: body.amount.amount_minor, currency: body.amount.currency },
        });
        return { body: toApiInvoice(invoice) };
      },
    },
  ];
}
