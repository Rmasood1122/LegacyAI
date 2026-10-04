// Billing and renewal: reading and changing them, and the words the screens use. No markup here.
import { useApiList, useApiMutation, useApiQuery } from '../../api/context.tsx';
import type { Invoice, RenewalStarted, Subscription } from '../../api/generated.ts';
import type { Tone } from '../../ui/index.tsx';

const BILLING_CHANGED = ['getSubscription', 'listInvoices'] as const;

export const useSubscription = () => useApiQuery('getSubscription');
export const useInvoices = () => useApiList('listInvoices', { query: { limit: 25 } });
// Two separate requests in flight, two separate errors: seats and the automatic-renewal switch do not share one.
export const useUpdateSeats = () => useApiMutation('updateSubscription', BILLING_CHANGED);
export const useUpdateAutoRenew = () => useApiMutation('updateSubscription', BILLING_CHANGED);
export const useStartRenewal = () => useApiMutation('startRenewal', BILLING_CHANGED);

export const PHASE_TEXT: Readonly<Record<Subscription['phase'], { tone: Tone; title: string; text: string }>> = {
  normal: { tone: 'success', title: 'The subscription is running', text: 'Nothing needs doing now. Renewal opens on the date shown below.' },
  renewal_open: { tone: 'info', title: 'Renewal is open', text: 'You can renew now. A new term starts on the day the payment arrives.' },
  grace: { tone: 'warning', title: 'The term has ended: the company is read-only', text: 'Everyone can still read, nobody can change anything. Renew to switch everything back on.' },
  lapsed: { tone: 'danger', title: 'The term has ended: only export is possible', text: 'Only an Owner can sign in, to export the company’s data or to renew.' },
};

/** What to tell the Owner about seats, or null when there is nothing to say. This is the upgrade prompt (feature 35). */
export function seatPrompt(s: Pick<Subscription, 'seat_state' | 'seat_limit' | 'seats_used'>): { tone: Tone; title: string; text: string } | null {
  if (s.seat_limit === null || s.seat_state === 'not_limited' || s.seat_state === 'ok') return null;
  if (s.seat_state === 'reached') {
    return {
      tone: 'danger', title: `All ${s.seat_limit} seats are in use`,
      text: 'No new card can be issued until more seats are paid for here, or a card that is no longer needed is revoked.',
    };
  }
  const left = s.seat_limit - s.seats_used;
  return {
    tone: 'warning', title: `${left} of ${s.seat_limit} seats left`,
    text: 'Add seats before they run out, so that issuing a card is not refused.',
  };
}

/** The seats field: a whole number from 1 to 100000. (Only the platform operator can remove the limit.) */
export function parseSeats(text: string): { ok: true; seats: number } | { ok: false } {
  const t = text.trim();
  if (!/^[0-9]{1,6}$/.test(t)) return { ok: false };
  const n = Number(t);
  return n >= 1 && n <= 100_000 ? { ok: true, seats: n } : { ok: false };
}

/**
 * What the "pay" part of the screen shows. Exactly one of these, decided by what the API says - the screen has no
 * rule of its own about when something may be paid.
 */
export type RenewPanel =
  | { kind: 'settled'; invoice: Invoice }                                       // nothing was to pay: it took effect at once
  | { kind: 'waiting'; invoice: Invoice; byOperator: boolean }                  // an invoice is waiting for its payment
  | { kind: 'can_pay'; due: NonNullable<Subscription['due_now']>; byOperator: boolean }
  | { kind: 'no_price' }                                                        // the plan has no price: the operator must act
  | { kind: 'nothing_due' };

export function renewPanelState(s: Subscription, started: RenewalStarted | undefined): RenewPanel {
  const byOperator = !s.payments_available;
  if (s.open_invoice !== null) return { kind: 'waiting', invoice: s.open_invoice, byOperator };
  if (started !== undefined && started.invoice.applied) return { kind: 'settled', invoice: started.invoice };
  if (s.plan === null) return { kind: 'no_price' };
  if (s.can_renew_now && s.due_now !== null) return { kind: 'can_pay', due: s.due_now, byOperator };
  return { kind: 'nothing_due' };
}
