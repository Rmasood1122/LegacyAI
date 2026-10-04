// Subscriptions, invoices and renewal (docs/phase4/05-billing.md).
//
// What the company's term IS lives in the identity module: the company card's dates (decision D19). This file never
// touches cards. It asks the CompanyTermPort (wired in app.ts) for the term and tells it to renew.
//
// RULES THIS FILE KEEPS
//   - Lock order: the company's subscription row first, then an invoice. Every method that changes anything starts
//     with #lock(), so two requests for one company never interleave and never deadlock.
//   - A company has at most ONE payable (open) invoice. Issuing a new one closes the old one (also enforced by a
//     unique index in the database).
//   - An invoice's status moves only as nextStatus() says (the database guard says the same).
//   - Money that arrives is never dropped: every accepted message is stored, and a payment that could not be applied
//     is recorded, audited and brought to the operator's and the Owner's attention.
//   - The provider is never called inside a transaction (routes.ts / sweepCompany): the invoice is committed first.
//   - "Cards in use" means ONE thing everywhere (issuing a card, the seats on an invoice, the check when a payment
//     takes effect): CompanyTerm.personCards - the company's person cards that are neither revoked nor replaced.
//   - What was paid must cover what is used: while a renewal invoice waits to be paid no card may be issued beyond
//     its seats, and a payment takes effect only if the cards in use still fit the seats paid (paidSeatsCover).
//   - A payment on record is never left unfinished without a trace: `applied_at` says it took effect, `attention_at`
//     says people were told it did not. A paid invoice with neither is picked up again (unfinished / routes.ts finish).
import { ProblemError, problems } from '../../../shared/errors.ts';
import type { RequestContext } from '../../../shared/policy-types.ts';
import { PLATFORM_TENANT_ID, writeAudit, type Notifier, type Tx } from '../../platform/index.ts';
import { planOf, priceFor, sameMoney, type Money, type Plan } from './catalogue.ts';
import type { PaymentEvent, PaymentProvider } from './provider.ts';

const DAY_MS = 86_400_000;

export interface CompanyTerm {
  /** The renewal date: the day the company's term ends. */
  expiresAt: Date;
  /** Until then the company is read-only; after it only the Owner's export works (Phase 1 rule). */
  graceUntil: Date;
  /** From this day on the Owner may renew. */
  renewalDue: Date;
  /** How long one term is: the company's card validity period. */
  termDays: number;
  /** Person cards in use (not revoked, not replaced): the seats taken. */
  personCards: number;
}

/** What billing needs from the identity module. Implemented there; nothing here knows what a card is. */
export interface CompanyTermPort {
  term(tx: Tx, tenantId: string): Promise<CompanyTerm | null>;
  /** Starts a new term NOW (the existing company-card renewal, with its secret-code rotation). */
  renew(tx: Tx, tenantId: string, ctx: RequestContext): Promise<CompanyTerm>;
}

export type TermPhase = 'normal' | 'renewal_open' | 'grace' | 'lapsed';

export function termPhase(term: Pick<CompanyTerm, 'expiresAt' | 'graceUntil' | 'renewalDue'>, now: Date): TermPhase {
  if (now.getTime() > term.graceUntil.getTime()) return 'lapsed';
  if (now.getTime() > term.expiresAt.getTime()) return 'grace';
  if (now.getTime() >= term.renewalDue.getTime()) return 'renewal_open';
  return 'normal';
}

export type SeatState = 'not_limited' | 'ok' | 'near' | 'reached';

/** "Near" = at most one seat or 10 % of the seats left, whichever is more. */
export function seatState(used: number, limit: number | null): SeatState {
  if (limit === null) return 'not_limited';
  if (used >= limit) return 'reached';
  return limit - used <= Math.max(1, Math.floor(limit / 10)) ? 'near' : 'ok';
}

export type ReminderStage = '30_days' | '14_days' | '3_days' | 'in_grace';

/** Which reminders are due, from the days left to the renewal date. Pure. */
export function reminderStages(term: Pick<CompanyTerm, 'expiresAt' | 'graceUntil'>, now: Date): ReminderStage[] {
  const left = term.expiresAt.getTime() - now.getTime();
  if (left < 0) return now.getTime() <= term.graceUntil.getTime() ? ['in_grace'] : [];
  const stages: ReminderStage[] = [];
  if (left <= 30 * DAY_MS) stages.push('30_days');
  if (left <= 14 * DAY_MS) stages.push('14_days');
  if (left <= 3 * DAY_MS) stages.push('3_days');
  return stages;
}

// ------------------------------------------------------------------ invoice states

export const INVOICE_STATUSES = ['open', 'paid', 'failed', 'void', 'paid_late'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const INVOICE_CAUSES = ['payment_confirmed', 'payment_declined', 'superseded', 'expired'] as const;
export type InvoiceCause = (typeof INVOICE_CAUSES)[number];
export type InvoiceKind = 'renewal' | 'seats';

/**
 * THE transition table (the database guard invoices_guard() holds the same one). Null = this cause changes nothing.
 *   open      -> paid (confirmed) | failed (declined) | void (replaced by a newer invoice, or too old)
 *   failed    -> paid_late : money arrived for an invoice whose payment had been declined
 *   void      -> paid_late : money arrived for an invoice that had been closed
 *   paid, paid_late : final
 * "paid_late" is never applied by itself: it needs a refund or the operator.
 */
export function nextStatus(status: InvoiceStatus, cause: InvoiceCause): InvoiceStatus | null {
  switch (status) {
    case 'open':
      return cause === 'payment_confirmed' ? 'paid' : cause === 'payment_declined' ? 'failed' : 'void';
    case 'failed':
    case 'void':
      return cause === 'payment_confirmed' ? 'paid_late' : null;
    case 'paid':
    case 'paid_late':
      return null;
  }
}

// ------------------------------------------------------------------ seats

export interface SeatFacts {
  /** What the Owner asked for the NEXT renewal (or as an addition now); null = nothing asked. */
  requested: number | null;
  /** The seats paid for this term: the limit on person cards. Null = no limit applies yet. */
  limit: number | null;
  /** Set by the platform operator only: no limit, whatever was paid. */
  unlimited: boolean;
}

/** The limit the policy enforces when a card is issued. */
export function enforcedLimit(s: SeatFacts): number | null {
  return s.unlimited ? null : s.limit;
}

/** Seats on a renewal invoice: never fewer than the cards in use that day, never fewer than what was asked or paid before. */
export function renewalSeats(s: SeatFacts, cardsInUse: number): number {
  if (s.unlimited) return Math.max(cardsInUse, 1);
  return Math.max(s.requested ?? s.limit ?? 0, cardsInUse, 1);
}

/** Seats the Owner asked for on top of what this term already covers; they must be paid before they count. */
export function seatsToAdd(s: SeatFacts): number {
  if (s.unlimited || s.limit === null || s.requested === null) return 0;
  return Math.max(0, s.requested - s.limit);
}

/**
 * The most cards the company may have in use while this invoice waits to be paid, or null when the invoice sets no
 * bound of its own. A RENEWAL invoice says how many seats the next term has: issuing beyond that before paying would
 * mean paying for fewer seats than are used ("pay for one, keep all"). This holds in a company's first term too,
 * where nothing else limits cards. A SEATS invoice adds to the running limit, which already applies.
 */
export function openInvoiceBound(open: { kind: InvoiceKind; seats: number } | null): number | null {
  return open !== null && open.kind === 'renewal' ? open.seats : null;
}

/** May one more card be issued? `cardsInUse` is counted before the new card. Pure: THE rule behind seatAvailable(). */
export function seatFree(s: SeatFacts, open: { kind: InvoiceKind; seats: number } | null, cardsInUse: number): boolean {
  const bound = openInvoiceBound(open);
  if (bound !== null && cardsInUse >= bound) return false;
  const limit = enforcedLimit(s);
  return limit === null || cardsInUse < limit;
}

/**
 * Do the seats of a PAID invoice cover the cards in use at the moment it takes effect? Counted again then, because
 * cards may have been issued between the invoice and the payment. If not, the payment stays on record and does not
 * take effect by itself.
 */
export function paidSeatsCover(invoice: { kind: InvoiceKind; seats: number }, s: SeatFacts, cardsInUse: number): boolean {
  if (invoice.kind === 'renewal') return cardsInUse <= invoice.seats;
  return s.unlimited || cardsInUse <= (s.limit ?? 0) + invoice.seats;
}

/** Why a payment that is on record did not take effect - the audit log's reason. */
export type NotAppliedReason = 'PAYMENT_NOT_APPLIED' | 'PAYMENT_NOT_APPLIED_MORE_CARDS_THAN_SEATS';
export const MORE_CARDS_THAN_SEATS = 'more-cards-than-seats';

export interface Due { kind: InvoiceKind; seats: number; amount: Money }

/** What can be invoiced right now, or null. Pure: the single rule behind the screen's button and startRenewal. */
export function dueNow(plan: Plan | null, seats: SeatFacts, term: CompanyTerm, now: Date): Due | null {
  if (plan === null) return null;
  if (termPhase(term, now) !== 'normal') {
    const n = renewalSeats(seats, term.personCards);
    return { kind: 'renewal', seats: n, amount: priceFor(plan, n) };
  }
  const added = seatsToAdd(seats);
  return added > 0 ? { kind: 'seats', seats: added, amount: priceFor(plan, added) } : null;
}

export const MAX_AUTO_RENEW_ATTEMPTS = 3;
/** An automatic invoice with no answer from the provider after this long is closed, so that a new attempt can start. */
export const UNANSWERED_AFTER_DAYS = 3;
/** An invoice the Owner started and nobody paid is closed after this long (its amount may no longer be right). */
export const OPEN_INVOICE_DAYS = 14;

interface SubscriptionRow { seats: number | null; seat_limit: number | null; unlimited: boolean; auto_renew: boolean; auto_renew_attempts: number }
export interface InvoiceRow {
  id: string; number: number; kind: InvoiceKind; status: InvoiceStatus; plan_code: string; seats: number; term_days: number; amount_minor: string;
  currency: string; automatic: boolean; settlement: string | null; provider_reference: string | null; note: string | null; issued_at: Date;
  paid_at: Date | null; closed_at: Date | null; applied_at: Date | null;
  /** When the Owner and the operator were told that this payment did NOT take effect by itself. */
  attention_at: Date | null;
}
const INVOICE_COLUMNS = `id, number, kind, status, plan_code, seats, term_days, amount_minor::text AS amount_minor, currency, automatic,
  settlement, provider_reference, note, issued_at, paid_at, closed_at, applied_at, attention_at`;

const moneyOf = (r: Pick<InvoiceRow, 'amount_minor' | 'currency'>): Money => ({ amountMinor: Number(r.amount_minor), currency: r.currency });
const apiMoney = (m: Money): { amount_minor: number; currency: string } => ({ amount_minor: m.amountMinor, currency: m.currency });
const seatFacts = (r: SubscriptionRow): SeatFacts => ({ requested: r.seats, limit: r.seat_limit, unlimited: r.unlimited });

export interface ApiInvoice {
  id: string; number: number; kind: InvoiceKind; status: InvoiceStatus; plan_code: string; seats: number; term_days: number;
  amount: { amount_minor: number; currency: string }; automatic: boolean; settlement: string | null; issued_at: string;
  paid_at: string | null; closed_at: string | null; applied: boolean;
}

export function toApiInvoice(r: InvoiceRow): ApiInvoice {
  return {
    id: r.id, number: r.number, kind: r.kind, status: r.status, plan_code: r.plan_code, seats: r.seats, term_days: r.term_days,
    amount: apiMoney(moneyOf(r)), automatic: r.automatic, settlement: r.settlement, issued_at: r.issued_at.toISOString(),
    paid_at: r.paid_at?.toISOString() ?? null, closed_at: r.closed_at?.toISOString() ?? null, applied: r.applied_at !== null,
  };
}

export type EventResult = 'applied' | 'duplicate' | 'recorded';

/** Paid, not in effect, and nobody was told yet: the steps after "paid" still have to run. */
export function isUnfinished(invoice: Pick<InvoiceRow, 'status' | 'applied_at' | 'attention_at'>): boolean {
  return invoice.status === 'paid' && invoice.applied_at === null && invoice.attention_at === null;
}

export function notAppliedReason(err: unknown): NotAppliedReason {
  return err instanceof ProblemError && err.code === MORE_CARDS_THAN_SEATS ? 'PAYMENT_NOT_APPLIED_MORE_CARDS_THAN_SEATS' : 'PAYMENT_NOT_APPLIED';
}

export interface BillingDeps {
  notifier: Notifier;
  provider: PaymentProvider;
  term: () => CompanyTermPort | null;
}

export class Billing {
  readonly #deps: BillingDeps;
  constructor(deps: BillingDeps) {
    this.#deps = deps;
  }

  get provider(): PaymentProvider {
    return this.#deps.provider;
  }

  #term(): CompanyTermPort {
    const port = this.#deps.term();
    if (port === null) throw new Error('billing: the company-term port is not wired');
    return port;
  }

  async #read(tx: Tx, tenantId: string): Promise<SubscriptionRow> {
    const { rows } = await tx.query<SubscriptionRow>(
      'SELECT seats, seat_limit, unlimited, auto_renew, auto_renew_attempts FROM subscriptions WHERE tenant_id = $1', [tenantId]);
    // A company billing has not touched yet: nothing asked, no limit, nothing renews by itself.
    return rows[0] ?? { seats: null, seat_limit: null, unlimited: false, auto_renew: false, auto_renew_attempts: 0 };
  }

  /** The subscription row IS the lock that serialises everything billing does for one company. Always taken first. */
  async #lock(tx: Tx, tenantId: string): Promise<SubscriptionRow> {
    await tx.query('INSERT INTO subscriptions (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING', [tenantId]);
    const { rows } = await tx.query<SubscriptionRow>(
      'SELECT seats, seat_limit, unlimited, auto_renew, auto_renew_attempts FROM subscriptions WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
    return rows[0] as SubscriptionRow;
  }

  async #invoice(tx: Tx, tenantId: string, invoiceId: string, forUpdate: boolean): Promise<InvoiceRow | null> {
    const { rows } = forUpdate
      ? await tx.query<InvoiceRow>(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, invoiceId])
      : await tx.query<InvoiceRow>(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE tenant_id = $1 AND id = $2`, [tenantId, invoiceId]);
    return rows[0] ?? null;
  }

  async #openInvoice(tx: Tx, tenantId: string): Promise<InvoiceRow | null> {
    const { rows } = await tx.query<InvoiceRow>(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE tenant_id = $1 AND status = 'open'`, [tenantId]);
    return rows[0] ?? null;
  }

  /** Closes an invoice without payment. Only an open invoice can be closed (the caller holds the lock). */
  async #close(tx: Tx, tenantId: string, invoice: InvoiceRow, cause: 'superseded' | 'expired', ctx: RequestContext): Promise<void> {
    if (nextStatus(invoice.status, cause) !== 'void') return;
    await tx.query(`UPDATE invoices SET status = 'void', closed_at = $3 WHERE tenant_id = $1 AND id = $2 AND status = 'open'`, [tenantId, invoice.id, ctx.now]);
    await writeAudit(tx, {
      tenantId, actorKind: 'system', action: 'billing:manage', resourceType: 'invoice', resourceId: invoice.id, decision: 'event',
      reasonCode: cause === 'superseded' ? 'INVOICE_REPLACED' : 'INVOICE_EXPIRED', requestId: ctx.requestId, ip: ctx.ip, details: { invoice_id: invoice.id },
    });
  }

  /** THE one place an invoice is written. */
  async #issueInvoice(
    tx: Tx, tenantId: string, plan: Plan, due: Due, termDays: number, by: { cardId: string | null; automatic: boolean }, ctx: RequestContext,
  ): Promise<InvoiceRow> {
    const inserted = await tx.query<InvoiceRow>(
      `INSERT INTO invoices (tenant_id, number, kind, plan_code, seats, term_days, amount_minor, currency, automatic, issued_at, created_by_card_id)
       SELECT $1, COALESCE(max(number), 0) + 1, $2, $3, $4, $5, $6, $7, $8, $9, $10 FROM invoices WHERE tenant_id = $1
       RETURNING ${INVOICE_COLUMNS}`,
      [tenantId, due.kind, plan.code, due.seats, termDays, due.amount.amountMinor, due.amount.currency, by.automatic, ctx.now, by.cardId]);
    const invoice = inserted.rows[0] as InvoiceRow;
    await writeAudit(tx, {
      tenantId, actorCardId: by.cardId, actorKind: by.cardId === null ? 'system' : 'card', action: 'billing:manage', resourceType: 'invoice',
      resourceId: invoice.id, decision: 'event', reasonCode: 'INVOICE_ISSUED', requestId: ctx.requestId, ip: ctx.ip,
      details: { invoice_id: invoice.id, amount_minor: due.amount.amountMinor, currency: due.amount.currency, seats: due.seats },
    });
    return invoice;
  }

  /**
   * The plan-limit answer for the policy decision point. Only issuing a card is limited (by the seats PAID for this
   * term). Takes the company's lock, so two cards issued at the same moment cannot both take the last seat.
   * Fails closed: if the term cannot be read, no card is issued.
   */
  async seatAvailable(tx: Tx, tenantId: string): Promise<boolean> {
    const port = this.#deps.term();
    if (port === null) return false;
    // Nothing limits this company and nothing waits: no lock is taken (most card issues). "Waits" means an unpaid
    // invoice OR a payment that was received and is not yet in effect: in that short time the paid seats are about to
    // become the limit, and a card issued without the lock would not be seen by the count taken when the payment is
    // applied (found by a security read: a first-term company could end up with more cards than paid seats).
    if (enforcedLimit(seatFacts(await this.#read(tx, tenantId))) === null && (await this.#openInvoice(tx, tenantId)) === null
      && !(await this.#paymentWaitsToTakeEffect(tx, tenantId))) return true;
    const facts = seatFacts(await this.#lock(tx, tenantId));
    const open = await this.#openInvoice(tx, tenantId);
    const term = await port.term(tx, tenantId);
    return term !== null && seatFree(facts, open, term.personCards);
  }

  /** A payment was recorded and is not in effect yet (applied or parked for a person). */
  async #paymentWaitsToTakeEffect(tx: Tx, tenantId: string): Promise<boolean> {
    const { rows } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM invoices WHERE tenant_id = $1 AND status = 'paid' AND applied_at IS NULL`, [tenantId]);
    return (rows[0]?.n ?? 0) > 0;
  }

  /** Seats as anyone who issues cards may know them: numbers of cards, never money. */
  async seats(tx: Tx, tenantId: string): Promise<{ limit: number | null; used: number; state: SeatState } | null> {
    const term = await this.#term().term(tx, tenantId);
    if (term === null) return null;
    const paid = enforcedLimit(seatFacts(await this.#read(tx, tenantId)));
    // while a renewal invoice waits, its seats bound issuing as well (seatFree): show the tighter of the two
    const bound = openInvoiceBound(await this.#openInvoice(tx, tenantId));
    const limit = bound === null ? paid : paid === null ? bound : Math.min(paid, bound);
    return { limit, used: term.personCards, state: seatState(term.personCards, limit) };
  }

  /** The renewal center: everything the Owner needs to know, computed when it is read. */
  async view(tx: Tx, tenantId: string, planCode: string, now: Date): Promise<Record<string, unknown>> {
    const term = await this.#term().term(tx, tenantId);
    if (term === null) throw problems.notFound();
    const row = await this.#read(tx, tenantId);
    const seats = seatFacts(row);
    const plan = planOf(planCode);
    const phase = termPhase(term, now);
    const open = await this.#openInvoice(tx, tenantId);
    const due = dueNow(plan, seats, term, now);
    const limit = enforcedLimit(seats);
    const next = plan === null ? null : priceFor(plan, renewalSeats(seats, term.personCards));
    const unapplied = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM invoices WHERE tenant_id = $1 AND status IN ('paid', 'paid_late') AND applied_at IS NULL`, [tenantId]);
    return {
      plan: plan === null ? null : { code: plan.code, name: plan.name, price_per_seat: apiMoney({ amountMinor: plan.pricePerSeatMinor, currency: plan.currency }), placeholder: true },
      seats_requested: row.seats,
      seat_limit: limit,
      seats_unlimited: row.unlimited,
      seats_used: term.personCards,
      seat_state: seatState(term.personCards, limit),
      auto_renew: row.auto_renew,
      term_days: term.termDays,
      // the same names and meanings as in the session (getSession): one vocabulary for the company's term
      expires_at: term.expiresAt.toISOString(),
      renewal_due: term.renewalDue.toISOString(),
      grace_until: term.graceUntil.toISOString(),
      read_only: phase === 'grace' || phase === 'lapsed',
      export_only: phase === 'lapsed',
      phase,
      next_term: next === null ? null : { seats: renewalSeats(seats, term.personCards), amount: apiMoney(next) },
      due_now: due === null ? null : { kind: due.kind, seats: due.seats, amount: apiMoney(due.amount) },
      open_invoice: open === null ? null : toApiInvoice(open),
      can_renew_now: open === null && due !== null,
      payments_available: this.#deps.provider.canCollect,
      payments_needing_attention: unapplied.rows[0]?.n ?? 0,
      if_nothing_is_done: row.auto_renew && this.#deps.provider.canCollect ? 'automatic_renewal_is_tried' : 'read_only_then_export_only',
    };
  }

  /** The Owner asks for seats (for the next renewal, or more of them now) and switches automatic renewal. */
  async update(tx: Tx, tenantId: string, patch: { seats?: number; auto_renew?: boolean }, actorCardId: string, ctx: RequestContext): Promise<void> {
    const row = await this.#lock(tx, tenantId);
    const term = await this.#term().term(tx, tenantId);
    if (term === null) throw problems.notFound();
    if (patch.seats !== undefined) {
      if (row.unlimited) throw problems.conflict('seats-set-by-operator', 'The platform operator removed the seat limit for this company; ask the operator to change it');
      // what an open invoice says must stay what is owed: seats cannot move under it
      if ((await this.#openInvoice(tx, tenantId)) !== null) {
        throw problems.conflict('seats-locked', 'An invoice is waiting to be paid; seats can change again once it is paid or closed');
      }
      if (patch.seats < term.personCards) {
        throw problems.conflict('seats-below-use', `${term.personCards} cards are in use; revoke cards first or choose at least that many seats`);
      }
    }
    if (patch.auto_renew === true && !this.#deps.provider.canCollect) {
      throw problems.conflict('payments-unavailable', 'No payment provider is connected, so nothing can renew by itself');
    }
    await tx.query(
      `UPDATE subscriptions SET seats = COALESCE($2, seats), auto_renew = COALESCE($3, auto_renew), updated_at = $4, updated_by_card_id = $5
        WHERE tenant_id = $1`,
      [tenantId, patch.seats ?? null, patch.auto_renew ?? null, ctx.now, actorCardId]);
    const details: Record<string, number | boolean> = {};
    if (patch.seats !== undefined) details.seats = patch.seats;
    if (patch.auto_renew !== undefined) details.auto_renew = patch.auto_renew;
    await writeAudit(tx, {
      tenantId, actorCardId, actorKind: 'card', action: 'billing:manage', resourceType: 'subscription', resourceId: tenantId,
      decision: 'event', reasonCode: 'SUBSCRIPTION_CHANGED', requestId: ctx.requestId, ip: ctx.ip, details,
    });
  }

  /** The platform operator sets the seat limit directly, or removes it (null). Nobody else can remove it. */
  async setSeatLimit(tx: Tx, tenantId: string, limit: number | null, ctx: RequestContext): Promise<void> {
    await this.#lock(tx, tenantId);
    const term = await this.#term().term(tx, tenantId);
    if (term === null) throw problems.notFound();
    if (limit !== null && limit < term.personCards) {
      throw problems.conflict('seats-below-use', `${term.personCards} cards are in use; the limit cannot be lower`);
    }
    await tx.query('UPDATE subscriptions SET seat_limit = $2, unlimited = $3, seats = NULL, updated_at = $4, updated_by_card_id = NULL WHERE tenant_id = $1',
      [tenantId, limit, limit === null, ctx.now]);
    await writeAudit(tx, {
      tenantId, actorKind: 'operator', action: 'billing:operate', resourceType: 'subscription', resourceId: tenantId, decision: 'event',
      reasonCode: limit === null ? 'SEAT_LIMIT_REMOVED_BY_OPERATOR' : 'SEAT_LIMIT_SET_BY_OPERATOR', requestId: ctx.requestId, ip: ctx.ip,
      details: limit === null ? {} : { seats: limit },
    });
  }

  async invoices(tx: Tx, tenantId: string, limit: number, before: string | null): Promise<InvoiceRow[]> {
    const { rows } = await tx.query<InvoiceRow>(
      `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE tenant_id = $1 AND ($2::uuid IS NULL OR id < $2::uuid) ORDER BY id DESC LIMIT $3`,
      [tenantId, before, limit + 1]);
    return rows;
  }

  async invoice(tx: Tx, tenantId: string, invoiceId: string): Promise<InvoiceRow | null> {
    return this.#invoice(tx, tenantId, invoiceId, false);
  }

  /**
   * Step 1 of paying (inside a transaction): the invoice for what is due NOW - the next term, or seats added to the
   * running term. An open invoice for exactly the same thing is returned as it is; an open invoice for anything else
   * is closed and replaced, so an old amount is never collected. Nothing is asked of the provider here.
   * A zero amount is settled and applied at once ("no charge").
   */
  async issueDue(
    tx: Tx, tenantId: string, planCode: string, by: { cardId: string | null; automatic: boolean }, ctx: RequestContext,
  ): Promise<{ invoice: InvoiceRow; reused: boolean; collect: boolean }> {
    const row = await this.#lock(tx, tenantId);
    const term = await this.#term().term(tx, tenantId);
    if (term === null) throw problems.notFound();
    const plan = planOf(planCode);
    if (plan === null) throw problems.conflict('plan-not-in-catalogue', 'This company\'s plan has no price; ask the platform operator');
    const due = dueNow(plan, seatFacts(row), term, ctx.now);
    if (due === null) {
      throw problems.conflict('renewal-not-open', 'Nothing is due yet: the term can be renewed from the day the renewal opens (days left are not carried over)');
    }
    const open = await this.#openInvoice(tx, tenantId);
    if (open !== null) {
      const same = open.kind === due.kind && open.seats === due.seats && open.plan_code === plan.code && open.term_days === term.termDays
        && sameMoney(moneyOf(open), due.amount);
      if (same) return { invoice: open, reused: true, collect: this.#deps.provider.canCollect && open.provider_reference === null };
      await this.#close(tx, tenantId, open, 'superseded', ctx);
    }
    let invoice = await this.#issueInvoice(tx, tenantId, plan, due, term.termDays, by, ctx);
    if (due.amount.amountMinor === 0) {
      await this.#markPaid(tx, tenantId, invoice, 'no_charge', null, ctx);
      invoice = await this.applyPaid(tx, tenantId, invoice.id, { actorKind: 'system', cardId: null }, ctx);
      return { invoice, reused: false, collect: false };
    }
    return { invoice, reused: false, collect: this.#deps.provider.canCollect };
  }

  /** Step 3 of paying (its own transaction, after the provider answered): remember the provider's reference. */
  async recordProviderReference(tx: Tx, tenantId: string, invoiceId: string, reference: string): Promise<InvoiceRow | null> {
    await this.#lock(tx, tenantId);
    const { rows } = await tx.query<InvoiceRow>(
      `UPDATE invoices SET provider_reference = $3 WHERE tenant_id = $1 AND id = $2 AND status = 'open' AND provider_reference IS NULL
       RETURNING ${INVOICE_COLUMNS}`, [tenantId, invoiceId, reference.slice(0, 200)]);
    return rows[0] ?? this.#invoice(tx, tenantId, invoiceId, false);
  }

  async #markPaid(tx: Tx, tenantId: string, invoice: InvoiceRow, settlement: 'provider' | 'operator' | 'no_charge', note: string | null, ctx: RequestContext): Promise<void> {
    if (nextStatus(invoice.status, 'payment_confirmed') !== 'paid') throw new Error('billing: only an open invoice can be paid');
    await tx.query(
      `UPDATE invoices SET status = 'paid', paid_at = $3, settlement = $4, note = COALESCE($5, note) WHERE tenant_id = $1 AND id = $2 AND status = 'open'`,
      [tenantId, invoice.id, ctx.now, settlement, note]);
  }

  /**
   * THE one place a paid invoice takes effect: a renewal invoice renews the company's term (through the identity
   * module's existing renewal) and sets the seat limit to the seats paid; a seats invoice adds its seats. Exactly
   * once: `applied_at` is set here under the company's lock, and the database refuses a second "applied".
   * Throws when the term cannot be renewed - the caller decides what happens to the payment then (applyEvent keeps it).
   */
  async applyPaid(
    tx: Tx, tenantId: string, invoiceId: string, actor: { actorKind: 'system' | 'operator'; cardId: string | null }, ctx: RequestContext,
  ): Promise<InvoiceRow> {
    const row = await this.#lock(tx, tenantId);
    const invoice = await this.#invoice(tx, tenantId, invoiceId, true);
    if (invoice === null) throw problems.notFound();
    if (invoice.status !== 'paid' && invoice.status !== 'paid_late') throw problems.conflict('invoice-not-paid', 'Only a paid invoice can take effect');
    if (invoice.applied_at !== null) return invoice;
    // The cards in use are counted AGAIN, now, under the company's lock: what was paid must cover what is used.
    const before = await this.#term().term(tx, tenantId);
    if (before === null) throw problems.notFound();
    if (!paidSeatsCover(invoice, seatFacts(row), before.personCards)) {
      throw problems.conflict(MORE_CARDS_THAN_SEATS,
        `${before.personCards} cards are in use, more than the seats this invoice paid for; revoke cards or buy seats, then the operator can put the payment into effect`);
    }
    if (invoice.kind === 'renewal') {
      await this.#term().renew(tx, tenantId, ctx);
      await tx.query('UPDATE subscriptions SET seat_limit = CASE WHEN unlimited THEN NULL ELSE $2::int END, seats = NULL, auto_renew_attempts = 0 WHERE tenant_id = $1',
        [tenantId, invoice.seats]);
    } else {
      await tx.query('UPDATE subscriptions SET seat_limit = CASE WHEN unlimited THEN NULL ELSE $2::int END, seats = NULL WHERE tenant_id = $1',
        [tenantId, (row.seat_limit ?? 0) + invoice.seats]);
    }
    // Whatever else was waiting to be paid was computed before this took effect (another term, another seat count):
    // it is closed, so that it cannot be collected on top of this one.
    const other = await this.#openInvoice(tx, tenantId);
    if (other !== null && other.id !== invoiceId) await this.#close(tx, tenantId, other, 'superseded', ctx);
    const applied = await tx.query<InvoiceRow>(
      `UPDATE invoices SET applied_at = $3 WHERE tenant_id = $1 AND id = $2 AND applied_at IS NULL RETURNING ${INVOICE_COLUMNS}`, [tenantId, invoiceId, ctx.now]);
    await writeAudit(tx, {
      tenantId, actorKind: actor.actorKind, action: 'billing:payment', resourceType: 'invoice', resourceId: invoiceId, decision: 'event',
      reasonCode: invoice.kind === 'renewal' ? 'INVOICE_PAID_TERM_RENEWED' : 'INVOICE_PAID_SEATS_ADDED', requestId: ctx.requestId, ip: ctx.ip,
      details: { invoice_id: invoiceId, amount_minor: Number(invoice.amount_minor), currency: invoice.currency, seats: invoice.seats, payment_outcome: 'paid' },
    });
    await this.#deps.notifier.notify({ type: 'subscription_renewed', tenantId });
    return applied.rows[0] ?? invoice;
  }

  /** A payment exists that changed nothing by itself: the company's Owner and the platform operator are told. */
  async #needsAttention(tx: Tx, tenantId: string, invoiceId: string | null, reasonCode: string, outcome: string, ctx: RequestContext): Promise<void> {
    await writeAudit(tx, {
      tenantId, actorKind: 'system', action: 'billing:payment', resourceType: 'invoice', resourceId: invoiceId, decision: 'event',
      reasonCode, requestId: ctx.requestId, ip: ctx.ip, details: invoiceId === null ? { payment_outcome: outcome } : { invoice_id: invoiceId, payment_outcome: outcome },
    });
    await this.#deps.notifier.notify({ type: 'payment_needs_attention', tenantId });
    await this.#deps.notifier.notify({ type: 'payment_needs_attention', tenantId: PLATFORM_TENANT_ID, aboutTenantId: tenantId });
  }

  /**
   * A VERIFIED message from the provider (nothing here can be reached without a valid signature - routes.ts). Every
   * message is stored under its event id; what it does is decided by the transition table.
   * Returns `apply` when the invoice was just marked paid: the caller applies it in a SECOND transaction
   * (applyPaid), so that a payment is on record even if the term cannot be renewed at that moment.
   */
  async recordEvent(tx: Tx, event: PaymentEvent, ctx: RequestContext): Promise<{ result: EventResult; apply: string | null }> {
    await this.#lock(tx, event.tenantId);
    const seen = await tx.query('SELECT 1 FROM payment_events WHERE tenant_id = $1 AND event_id = $2', [event.tenantId, event.eventId]);
    const invoice = await this.#invoice(tx, event.tenantId, event.invoiceId, true);
    if (seen.rows.length > 0) {
      // The same message again changes nothing - but if its payment is on record and was neither put into effect
      // nor reported (the process stopped in between), the caller finishes that now.
      return { result: 'duplicate', apply: invoice !== null && isUnfinished(invoice) ? invoice.id : null };
    }
    const store = (result: string): Promise<unknown> => tx.query(
      `INSERT INTO payment_events (tenant_id, event_id, invoice_id, outcome, amount_minor, currency, result, occurred_at, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [event.tenantId, event.eventId, event.invoiceId, event.outcome, event.amount.amountMinor, event.amount.currency, result, event.sentAt, ctx.now]);

    if (invoice === null) {
      // signed, but about an invoice this company does not have: kept, never dropped
      await store('unknown_invoice');
      await this.#needsAttention(tx, event.tenantId, null, 'PAYMENT_EVENT_UNKNOWN_INVOICE', event.outcome, ctx);
      return { result: 'recorded', apply: null };
    }
    // The message must be about exactly what was due.
    if (!sameMoney(moneyOf(invoice), event.amount)) {
      await store('amount_mismatch');
      await this.#needsAttention(tx, event.tenantId, invoice.id, 'PAYMENT_EVENT_AMOUNT_MISMATCH', event.outcome, ctx);
      return { result: 'recorded', apply: null };
    }
    const to = nextStatus(invoice.status, event.outcome === 'paid' ? 'payment_confirmed' : 'payment_declined');
    if (to === 'paid') {
      await store('paid');
      await this.#markPaid(tx, event.tenantId, invoice, 'provider', null, ctx);
      // The trace is written HERE, with the payment itself: whatever happens to the next steps, the log says money arrived.
      await writeAudit(tx, {
        tenantId: event.tenantId, actorKind: 'system', action: 'billing:payment', resourceType: 'invoice', resourceId: invoice.id, decision: 'event',
        reasonCode: 'PAYMENT_RECEIVED', requestId: ctx.requestId, ip: ctx.ip,
        details: { invoice_id: invoice.id, amount_minor: Number(invoice.amount_minor), currency: invoice.currency, payment_outcome: 'paid' },
      });
      return { result: 'applied', apply: invoice.id };
    }
    if (to === 'paid_late') {
      // money for an invoice that was declined or closed: it is NOT applied; it needs a refund or the operator
      await store('paid_late');
      await tx.query(`UPDATE invoices SET status = 'paid_late', paid_at = $3, settlement = 'provider', attention_at = $3 WHERE tenant_id = $1 AND id = $2`,
        [event.tenantId, invoice.id, ctx.now]);
      await this.#needsAttention(tx, event.tenantId, invoice.id, 'PAYMENT_FOR_CLOSED_INVOICE', 'paid', ctx);
      return { result: 'recorded', apply: null };
    }
    if (to === 'failed') {
      await store('declined');
      await tx.query(`UPDATE invoices SET status = 'failed', closed_at = $3 WHERE tenant_id = $1 AND id = $2 AND status = 'open'`, [event.tenantId, invoice.id, ctx.now]);
      await writeAudit(tx, {
        tenantId: event.tenantId, actorKind: 'system', action: 'billing:payment', resourceType: 'invoice', resourceId: invoice.id, decision: 'event',
        reasonCode: 'PAYMENT_DECLINED', requestId: ctx.requestId, ip: ctx.ip,
        details: { invoice_id: invoice.id, amount_minor: Number(invoice.amount_minor), currency: invoice.currency, payment_outcome: 'declined' },
      });
      await this.#deps.notifier.notify({ type: 'payment_failed', tenantId: event.tenantId });
      return { result: 'applied', apply: null };
    }
    // no change: a second "paid" for a paid invoice (the provider may have charged twice) needs a person;
    // a late "declined" for an invoice that is already final is only kept.
    await store('no_change');
    if (event.outcome === 'paid') await this.#needsAttention(tx, event.tenantId, invoice.id, 'PAYMENT_REPEATED', 'paid', ctx);
    return { result: 'recorded', apply: null };
  }

  /**
   * A paid invoice could not take effect (the term could not be renewed, or more cards are in use than were paid
   * for): written down, the Owner and the operator are told, and the invoice is marked so that this happens once.
   */
  async recordNotApplied(tx: Tx, tenantId: string, invoiceId: string, reason: NotAppliedReason, ctx: RequestContext): Promise<boolean> {
    await this.#lock(tx, tenantId);
    const invoice = await this.#invoice(tx, tenantId, invoiceId, true);
    if (invoice === null || !isUnfinished(invoice)) return false;
    await tx.query('UPDATE invoices SET attention_at = $3 WHERE tenant_id = $1 AND id = $2 AND attention_at IS NULL', [tenantId, invoiceId, ctx.now]);
    await this.#needsAttention(tx, tenantId, invoiceId, reason, 'paid', ctx);
    return true;
  }

  /** Paid invoices of this company that neither took effect nor were reported: work that stopped half-way. */
  async unfinished(tx: Tx, tenantId: string): Promise<string[]> {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM invoices WHERE tenant_id = $1 AND status = 'paid' AND applied_at IS NULL AND attention_at IS NULL ORDER BY id LIMIT 20`, [tenantId]);
    return rows.map((r) => r.id);
  }

  /**
   * The platform operator settles an invoice by hand (the payment reached LegacyAI some other way), or applies a
   * payment that is on record and did not take effect. The operator names the invoice and what was paid: a mismatch
   * is refused. One settlement per invoice, whatever idempotency key is used (the status moves once).
   * A term that still has days left is not renewed early unless the operator says so explicitly.
   */
  async settleByOperator(
    tx: Tx, tenantId: string, p: { invoiceId: string; amount: Money; note: string; discardRemainingDays: boolean }, ctx: RequestContext,
  ): Promise<InvoiceRow> {
    await this.#lock(tx, tenantId);
    const invoice = await this.#invoice(tx, tenantId, p.invoiceId, true);
    if (invoice === null) throw problems.notFound();
    if (!sameMoney(moneyOf(invoice), p.amount)) throw problems.conflict('amount-mismatch', 'The amount or currency is not what this invoice says');
    const payable = invoice.status === 'open' || ((invoice.status === 'paid' || invoice.status === 'paid_late') && invoice.applied_at === null);
    if (!payable) throw problems.conflict('invoice-not-payable', 'This invoice is closed or already took effect');
    if (invoice.kind === 'renewal') {
      const term = await this.#term().term(tx, tenantId);
      if (term === null) throw problems.notFound();
      const daysLeft = Math.floor((term.expiresAt.getTime() - ctx.now.getTime()) / DAY_MS);
      if (daysLeft > 0 && !p.discardRemainingDays) {
        throw problems.conflict('days-would-be-lost', `The running term still has ${daysLeft} days; a renewal starts the new term today. Send discard_remaining_days to do it anyway`);
      }
    }
    if (invoice.status === 'open') await this.#markPaid(tx, tenantId, invoice, 'operator', p.note, ctx);
    else await tx.query('UPDATE invoices SET note = COALESCE(note, $3) WHERE tenant_id = $1 AND id = $2', [tenantId, invoice.id, p.note]);
    await writeAudit(tx, {
      tenantId, actorKind: 'operator', action: 'billing:operate', resourceType: 'invoice', resourceId: invoice.id, decision: 'event',
      reasonCode: invoice.status === 'open' ? 'INVOICE_SETTLED_BY_OPERATOR' : 'PAYMENT_APPLIED_BY_OPERATOR', requestId: ctx.requestId, ip: ctx.ip,
      details: { invoice_id: invoice.id, amount_minor: p.amount.amountMinor, currency: p.amount.currency },
    });
    return this.applyPaid(tx, tenantId, invoice.id, { actorKind: 'operator', cardId: null }, ctx);
  }

  /** Reminders: each once per renewal date and stage. Its own transaction (sweepCompany). */
  async remind(tx: Tx, tenantId: string, ctx: RequestContext): Promise<number> {
    const term = await this.#term().term(tx, tenantId);
    if (term === null) return 0;
    let notices = 0;
    for (const stage of reminderStages(term, ctx.now)) {
      if (await this.#noticeOnce(tx, tenantId, term.expiresAt, stage, ctx.now)) {
        notices += 1;
        await this.#deps.notifier.notify({ type: 'renewal_reminder', tenantId });
      }
    }
    return notices;
  }

  async #noticeOnce(tx: Tx, tenantId: string, termEnd: Date, stage: string, now: Date): Promise<boolean> {
    const made = await tx.query(
      'INSERT INTO billing_notices (tenant_id, term_end, stage, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING stage',
      [tenantId, termEnd, stage, now]);
    return made.rows.length > 0;
  }

  /** Invoices nobody answered are closed: an automatic one after 3 days, one the Owner started after 14. */
  async closeStale(tx: Tx, tenantId: string, ctx: RequestContext): Promise<number> {
    await this.#lock(tx, tenantId);
    const open = await this.#openInvoice(tx, tenantId);
    if (open === null) return 0;
    const maxAgeDays = open.automatic ? UNANSWERED_AFTER_DAYS : OPEN_INVOICE_DAYS;
    if (ctx.now.getTime() - open.issued_at.getTime() < maxAgeDays * DAY_MS) return 0;
    await this.#close(tx, tenantId, open, 'expired', ctx);
    return 1;
  }

  /**
   * The automatic renewal, step 1 (inside a transaction): decides whether an attempt is due and issues its invoice.
   * On the renewal date (from one day before it) and during the read-only days after it; never after the company
   * lapsed. Returns the invoice to collect, or null.
   */
  async autoRenewPrepare(tx: Tx, tenantId: string, planCode: string, ctx: RequestContext): Promise<InvoiceRow | null> {
    const row = await this.#lock(tx, tenantId);
    if (!row.auto_renew || !this.#deps.provider.canCollect || planOf(planCode) === null) return null;
    const term = await this.#term().term(tx, tenantId);
    if (term === null) return null;
    const phase = termPhase(term, ctx.now);
    const due = (phase === 'renewal_open' && ctx.now.getTime() >= term.expiresAt.getTime() - DAY_MS) || phase === 'grace';
    if (!due || (await this.#openInvoice(tx, tenantId)) !== null) return null;
    if (row.auto_renew_attempts >= MAX_AUTO_RENEW_ATTEMPTS) {
      if (await this.#noticeOnce(tx, tenantId, term.expiresAt, 'auto_renew_failed', ctx.now)) await this.#deps.notifier.notify({ type: 'payment_failed', tenantId });
      return null;
    }
    await tx.query('UPDATE subscriptions SET auto_renew_attempts = auto_renew_attempts + 1 WHERE tenant_id = $1', [tenantId]);
    const issued = await this.issueDue(tx, tenantId, planCode, { cardId: null, automatic: true }, ctx);
    return issued.collect ? issued.invoice : null;
  }
}
