// PUBLIC SURFACE of the billing module (backend Part 4).
//
// What it does (Phase 4, docs/phase4/05-billing.md): one subscription per company, invoices, renewal against a
// payment provider behind a port, reminders and automatic renewal, and the seat limit asked by the policy decision
// point. What it does NOT do: connect a real payment provider, handle taxes, refunds or currency conversion.
// No payment card data ever reaches this service.
//
// The company's term itself is the company card's validity (identity module, decision D19). Billing reaches it only
// through the CompanyTermPort, which app.ts wires - billing never imports the identity module.
import type { RequestContext } from '../../shared/policy-types.ts';
import type { Config, Database, Notifier, RateLimiter, RouteDef, Tx } from '../platform/index.ts';
import { Billing, type CompanyTermPort, type SeatState } from './internal/billing.ts';
import { catalogueProblems } from './internal/catalogue.ts';
import { FakePaymentProvider, NoPaymentProvider, type PaymentProvider } from './internal/provider.ts';
import { billingRoutes, collect, finish } from './internal/routes.ts';

export { amountDue, catalogueProblems, planOf, PLANS, priceFor, sameMoney, type Money, type Plan } from './internal/catalogue.ts';
export {
  dueNow, enforcedLimit, INVOICE_CAUSES, INVOICE_STATUSES, isUnfinished, MAX_AUTO_RENEW_ATTEMPTS, MORE_CARDS_THAN_SEATS, nextStatus, notAppliedReason,
  OPEN_INVOICE_DAYS, openInvoiceBound, paidSeatsCover, reminderStages, renewalSeats, seatFree, seatState, seatsToAdd, termPhase, UNANSWERED_AFTER_DAYS,
  type CompanyTerm, type CompanyTermPort, type InvoiceCause, type InvoiceStatus, type SeatFacts, type SeatState, type TermPhase,
} from './internal/billing.ts';
export {
  EVENT_TOLERANCE_MS, EVENT_VERSION, FakePaymentProvider, NoPaymentProvider, signEvent, verifyEvent,
  type IncomingMessage, type PaymentEvent, type PaymentEventInput, type PaymentProvider, type PaymentRequest,
} from './internal/provider.ts';

export { collect, finish, PROVIDER_TIMEOUT_MS } from './internal/routes.ts';
export type { Billing, InvoiceRow, NotAppliedReason } from './internal/billing.ts';

export interface PlanLimitQuery {
  /** The transaction of the request being decided. */
  tx: Tx;
  tenantId: string;
  planCode: string;
  action: string;
}

export interface PlanLimitAnswer {
  allowed: boolean;
  reason?: string;
}

/** Seats as anyone who issues cards may know them: counts of cards, never money. */
export interface SeatSummary { limit: number | null; used: number; state: SeatState }

export interface BillingPort {
  /** Asked by the policy decision point before any action is allowed. */
  checkLimit(query: PlanLimitQuery): Promise<PlanLimitAnswer>;
  /** For the usage page. Optional so that stand-ins in tests of other modules stay small. */
  seats?(tx: Tx, tenantId: string): Promise<SeatSummary | null>;
}

/** For tests of other modules: no limits at all. */
export class StubBilling implements BillingPort {
  async checkLimit(_query: PlanLimitQuery): Promise<PlanLimitAnswer> {
    return { allowed: true };
  }
}

export interface SweepResult { notices: number; attempts: number; closed: number; finished: number; failures: string[] }

export interface BillingModule {
  routes: RouteDef[];
  /** Plugged into the policy decision point by app.ts. */
  port: BillingPort;
  /** The identity module's view of the company's term; must be set before any billing route is used. */
  useTerm(port: CompanyTermPort): void;
  /**
   * What time does to one company's billing, each step in its own transaction: close invoices nobody answered,
   * create reminders, try the automatic renewal. A step that fails is reported in `failures` (with its reason) and
   * does not stop the others. Run by the housekeeping command.
   */
  sweepCompany(tenantId: string, planCode: string, ctx: RequestContext): Promise<SweepResult>;
}

/** The actions a plan limits. Today: issuing a person card needs a free seat. */
const SEAT_ACTIONS = new Set(['card:issue']);

export function createBilling(deps: {
  config: Config; db: Database; notifier: Notifier; rateLimiter: RateLimiter; provider?: PaymentProvider;
  /** For tests only: how long the provider gets to answer. Default PROVIDER_TIMEOUT_MS. */
  providerTimeoutMs?: number;
}): BillingModule {
  const broken = catalogueProblems();
  if (broken.length > 0) throw new Error(`The plan catalogue is not usable: ${broken.join('; ')}`);
  const provider = deps.provider
    ?? (deps.config.payment.provider === 'fake' ? new FakePaymentProvider(deps.config.payment.eventKey?.reveal() ?? null) : new NoPaymentProvider());
  let term: CompanyTermPort | null = null;
  const billing = new Billing({ notifier: deps.notifier, provider, term: () => term });
  const { db } = deps;

  const sweepCompany = async (tenantId: string, planCode: string, ctx: RequestContext): Promise<SweepResult> => {
    const result: SweepResult = { notices: 0, attempts: 0, closed: 0, finished: 0, failures: [] };
    const step = async (name: string, run: () => Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (err) {
        result.failures.push(`${name}: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    };
    // first: payments on record whose next steps did not happen (the process stopped between two transactions)
    await step('finish recorded payments', async () => {
      const withTx = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => db.withTenantTx(tenantId, fn);
      for (const invoiceId of await withTx((tx) => billing.unfinished(tx, tenantId))) {
        await finish(billing, tenantId, invoiceId, withTx, ctx);
        result.finished += 1;
      }
    });
    await step('close stale invoices', async () => {
      result.closed = await db.withTenantTx(tenantId, (tx) => billing.closeStale(tx, tenantId, ctx));
    });
    await step('reminders', async () => {
      result.notices = await db.withTenantTx(tenantId, (tx) => billing.remind(tx, tenantId, ctx));
    });
    await step('automatic renewal', async () => {
      const invoice = await db.withTenantTx(tenantId, (tx) => billing.autoRenewPrepare(tx, tenantId, planCode, ctx));
      if (invoice === null) return;
      result.attempts = 1;
      // the invoice and the counted attempt are committed; only now is the provider asked
      await collect(billing, invoice, tenantId, (fn) => db.withTenantTx(tenantId, fn), deps.providerTimeoutMs);
    });
    return result;
  };

  return {
    routes: billingRoutes({ db, billing, rateLimiter: deps.rateLimiter, providerTimeoutMs: deps.providerTimeoutMs }),
    port: {
      checkLimit: async (query) => {
        if (!SEAT_ACTIONS.has(query.action)) return { allowed: true };
        return (await billing.seatAvailable(query.tx, query.tenantId)) ? { allowed: true } : { allowed: false, reason: 'no_free_seat' };
      },
      seats: (tx, tenantId) => billing.seats(tx, tenantId),
    },
    useTerm: (port) => {
      term = port;
    },
    sweepCompany,
  };
}
