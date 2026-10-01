// Card lifecycle as an explicit state machine. Anything not listed here is illegal.
// The same table is enforced a second time by a database trigger.
import { problems } from '../../../shared/errors.ts';
import type { CardState } from '../../../shared/policy-types.ts';

export const CARD_STATES: readonly CardState[] = ['issued', 'active', 'suspended', 'revoked', 'expired', 'replaced'];

export const LEGAL_TRANSITIONS: ReadonlyArray<readonly [CardState, CardState]> = [
  ['issued', 'active'],      // first strong factor enrolled (or company card issued)
  ['issued', 'revoked'],     // cancelled before activation
  ['issued', 'expired'],     // never activated in time
  ['active', 'suspended'],
  ['active', 'revoked'],
  ['active', 'expired'],     // clock passed expires_at
  ['active', 'replaced'],
  ['suspended', 'active'],   // reinstate
  ['suspended', 'revoked'],
  ['suspended', 'replaced'],
  ['expired', 'active'],     // renew
  ['expired', 'revoked'],
  ['expired', 'replaced'],
];

export const TERMINAL_STATES: readonly CardState[] = ['revoked', 'replaced'];

export function canTransition(from: CardState, to: CardState): boolean {
  return LEGAL_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

export function assertTransition(from: CardState, to: CardState): void {
  if (!canTransition(from, to)) {
    throw problems.conflict('illegal-transition', `A card that is ${from} cannot become ${to}`);
  }
}

export interface CardTiming {
  state: CardState;
  expires_at: Date;
  grace_until: Date;
}

/**
 * The state that counts right now. Expiry is decided by the CLOCK, not by whether a
 * background job has run: an issued or active card is "expired" the moment expires_at passes.
 * A suspended card stays suspended (the stricter state wins).
 */
export function effectiveState(card: CardTiming, now: Date): CardState {
  if ((card.state === 'active' || card.state === 'issued') && now.getTime() >= card.expires_at.getTime()) return 'expired';
  return card.state;
}

export type AccessPhase = 'normal' | 'grace' | 'lapsed';

/** normal: before expiry. grace: read-only window after expiry. lapsed: after the grace window. */
export function accessPhase(card: Pick<CardTiming, 'expires_at' | 'grace_until'>, now: Date): AccessPhase {
  const t = now.getTime();
  if (Number.isNaN(t) || Number.isNaN(card.expires_at.getTime()) || Number.isNaN(card.grace_until.getTime())) return 'lapsed';
  if (t < card.expires_at.getTime()) return 'normal';
  if (t < card.grace_until.getTime()) return 'grace';
  return 'lapsed';
}

const DAY_MS = 86_400_000;

export function computeDates(
  now: Date, settings: { card_validity_days: number; grace_days: number; renewal_notice_days: number }, validityDays?: number,
): { expires_at: Date; grace_until: Date; renewal_due: Date } {
  const days = validityDays ?? settings.card_validity_days;
  if (!Number.isInteger(days) || days < 1 || days > settings.card_validity_days) {
    throw problems.unprocessable('validity_days must be between 1 and the tenant maximum');
  }
  const expires = new Date(now.getTime() + days * DAY_MS);
  const notice = Math.min(settings.renewal_notice_days, days);
  return {
    expires_at: expires,
    grace_until: new Date(expires.getTime() + settings.grace_days * DAY_MS),
    renewal_due: new Date(expires.getTime() - notice * DAY_MS),
  };
}
