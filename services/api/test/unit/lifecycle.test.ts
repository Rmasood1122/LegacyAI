import { describe, expect, it } from 'vitest';
import {
  accessPhase, canTransition, CARD_STATES, computeDates, effectiveState, LEGAL_TRANSITIONS, TERMINAL_STATES,
} from '../../src/modules/identity-access/index.ts';
import { assertTransition } from '../../src/modules/identity-access/internal/lifecycle.ts';
import { ProblemError } from '../../src/shared/errors.ts';
import type { CardState } from '../../src/shared/policy-types.ts';

// The expected table is written out here INDEPENDENTLY of the implementation, so a change
// to either one without the other fails the test.
const LEGAL = new Set([
  'issued>active', 'issued>revoked', 'issued>expired',
  'active>suspended', 'active>revoked', 'active>expired', 'active>replaced',
  'suspended>active', 'suspended>revoked', 'suspended>replaced',
  'expired>active', 'expired>revoked', 'expired>replaced',
]);

describe('card lifecycle state machine', () => {
  const pairs: Array<[CardState, CardState]> = [];
  for (const from of CARD_STATES) for (const to of CARD_STATES) pairs.push([from, to]);

  it('covers all 36 from/to pairs', () => {
    expect(pairs).toHaveLength(36);
    expect(LEGAL_TRANSITIONS).toHaveLength(LEGAL.size);
  });

  it.each(pairs)('%s -> %s', (from, to) => {
    const expected = LEGAL.has(`${from}>${to}`);
    expect(canTransition(from, to)).toBe(expected);
    if (expected) {
      expect(() => assertTransition(from, to)).not.toThrow();
    } else {
      let thrown: unknown;
      try {
        assertTransition(from, to);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ProblemError);
      expect((thrown as ProblemError).status).toBe(409);
      expect((thrown as ProblemError).code).toBe('illegal-transition');
    }
  });

  it('terminal states have no way out', () => {
    expect([...TERMINAL_STATES].sort()).toEqual(['replaced', 'revoked']);
    for (const from of TERMINAL_STATES) for (const to of CARD_STATES) expect(canTransition(from, to)).toBe(false);
  });

  it('rejects unknown states', () => {
    expect(canTransition('active', 'banana' as CardState)).toBe(false);
    expect(canTransition(undefined as unknown as CardState, 'active')).toBe(false);
  });
});

describe('expiry is decided by the clock', () => {
  const t0 = new Date('2026-01-01T00:00:00Z');
  const card = (state: CardState) => ({ state, expires_at: new Date('2026-04-01T00:00:00Z'), grace_until: new Date('2026-04-15T00:00:00Z') });

  it('an active card becomes expired the instant expires_at passes, with no background job', () => {
    expect(effectiveState(card('active'), t0)).toBe('active');
    expect(effectiveState(card('active'), new Date('2026-03-31T23:59:59.999Z'))).toBe('active');
    expect(effectiveState(card('active'), new Date('2026-04-01T00:00:00Z'))).toBe('expired');
  });

  it('suspended, revoked and replaced are not turned into expired (the stricter state wins)', () => {
    const late = new Date('2027-01-01T00:00:00Z');
    expect(effectiveState(card('suspended'), late)).toBe('suspended');
    expect(effectiveState(card('revoked'), late)).toBe('revoked');
    expect(effectiveState(card('replaced'), late)).toBe('replaced');
    expect(effectiveState(card('issued'), late)).toBe('expired');
  });

  it('access phases: normal -> 14-day grace -> lapsed, with exact boundaries', () => {
    const c = card('active');
    expect(accessPhase(c, new Date('2026-03-31T23:59:59.999Z'))).toBe('normal');
    expect(accessPhase(c, new Date('2026-04-01T00:00:00Z'))).toBe('grace');
    expect(accessPhase(c, new Date('2026-04-14T23:59:59.999Z'))).toBe('grace');
    expect(accessPhase(c, new Date('2026-04-15T00:00:00Z'))).toBe('lapsed');
  });

  it('an invalid date is treated as lapsed (fail closed), never as normal', () => {
    const c = card('active');
    expect(accessPhase(c, new Date(Number.NaN))).toBe('lapsed');
    expect(accessPhase({ expires_at: new Date(Number.NaN), grace_until: c.grace_until }, t0)).toBe('lapsed');
    expect(accessPhase({ expires_at: c.expires_at, grace_until: new Date(Number.NaN) }, t0)).toBe('lapsed');
  });
});

describe('card dates', () => {
  const settings = { card_validity_days: 90, grace_days: 14, renewal_notice_days: 14 };
  const now = new Date('2026-01-01T00:00:00Z');

  it('defaults: expires in 90 days, grace 14 days after, renewal due 14 days before', () => {
    const d = computeDates(now, settings);
    expect(d.expires_at.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(d.grace_until.toISOString()).toBe('2026-04-15T00:00:00.000Z');
    expect(d.renewal_due.toISOString()).toBe('2026-03-18T00:00:00.000Z');
  });

  it('a shorter validity is allowed; a longer one than the tenant maximum is not', () => {
    expect(computeDates(now, settings, 7).expires_at.toISOString()).toBe('2026-01-08T00:00:00.000Z');
    expect(computeDates(now, settings, 7).renewal_due.getTime()).toBeLessThanOrEqual(computeDates(now, settings, 7).expires_at.getTime());
    for (const bad of [0, -1, 91, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => computeDates(now, settings, bad)).toThrow();
    }
  });
});
