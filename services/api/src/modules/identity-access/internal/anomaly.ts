// Anomaly lock (feature 5): simple, explainable rules on how a card is used. When one fires the card is
// locked with the SAME lock a wrong secret code produces (CardService.lock), so an admin unlocks it the same way.
//
// What is counted, and why a card NUMBER alone is not enough to lock somebody's card:
//   rule "denials"        - refusals by the policy decision point for requests made WITH A LIVE SESSION of the
//                           card, for a reason that suggests probing (see COUNTED_REASONS). Without the card's
//                           strong factor and secret code there is no session, so nothing is counted. Failed
//                           sign-ins are not counted here (the SC lockout handles those).
//   rule "second_address" - a SUCCESSFUL sign-in (strong factor + SC) from one network address while another
//                           session of the same card was used from a different address a moment ago. It compares
//                           keyed hashes of addresses; it knows nothing about geography. Off by default.
//
// What is NOT counted, on purpose:
//   - refusals a well-behaved client meets in ordinary use: a card outside its hours, on another network, over
//     its limit, read-only, in its grace period, or a company whose own card has lapsed (the screens keep asking
//     in those states, and the card works again by itself when the state ends - a lock would not);
//   - "not found": old links and deleted records produce it in ordinary use, and it is decided before the
//     policy is asked, so it never reaches recordDecision;
//   - a request that a page of another address made a signed-in visitor's browser send: the HTTP layer refuses
//     it BEFORE the policy is asked (DENY_FETCH_SITE, see http.ts), so it can neither act nor collect refusals
//     against that visitor's card. Everything that does reach the policy is counted by its reason alone. A
//     thief with a stolen session who forges that header is refused outright; one who sends none is counted.
//   - verifying one's own work (DENY_SELF_REVIEW): the screens offer the button to every reviewer and expect
//     this refusal, so an honest reviewer working through their own items would meet it;
//   - slow probing: one refusal fewer than the threshold in every window is never caught. The rule finds bursts.
//
// The last usable Owner card of a company is never locked by a rule: the event is recorded and the other
// people are told, but somebody must remain who can unlock cards.
import { hmacSha256 } from '../../../shared/crypto.ts';
import { problems } from '../../../shared/errors.ts';
import type { RequestContext } from '../../../shared/policy-types.ts';
import { writeAudit, type Notifier, type Tx } from '../../platform/index.ts';
import { lockTenantRoles, otherUsableOwners, type CardService } from './cards.ts';

export interface AnomalySettings {
  /** The master switch: off = no rule is evaluated. */
  enabled: boolean;
  denials_enabled: boolean;
  denials_threshold: number;
  denials_window_minutes: number;
  second_address_enabled: boolean;
  second_address_window_minutes: number;
}
export type AnomalyRule = 'denials' | 'second_address';
export type AnomalySettingsView = AnomalySettings & { updated_at: string | null };

export const ANOMALY_DEFAULTS: AnomalySettings = {
  enabled: true, denials_enabled: true, denials_threshold: 20, denials_window_minutes: 10,
  second_address_enabled: false, second_address_window_minutes: 15,
};
/** Allowed range of each number. "Off" is a switch, never a number, so every stored number is usable. */
export const ANOMALY_LIMITS = {
  denials_threshold: [5, 500], denials_window_minutes: [1, 60], second_address_window_minutes: [1, 120],
} as const satisfies Record<string, readonly [number, number]>;
const SWITCHES = ['enabled', 'denials_enabled', 'second_address_enabled'] as const;

/** The audit reason of a lock, per rule. A rule without an entry does not compile. */
const LOCK_REASON: Record<AnomalyRule, string> = {
  denials: 'CARD_LOCKED_ANOMALY_DENIALS',
  second_address: 'CARD_LOCKED_ANOMALY_SECOND_ADDRESS',
};

/**
 * The refusals that count toward rule "denials": the card asked for something it has no right to.
 * A reason that is not listed here is NOT counted - so a reason added later cannot start locking cards by
 * accident (a unit test lists every reason the policy can give and makes each one be classified).
 */
export const COUNTED_REASONS: ReadonlySet<string> = new Set([
  'DENY_DEFAULT',                   // no role of the card grants the action
  'DENY_SCOPE',                     // the thing is outside the card's department or is not its own
  'DENY_SENSITIVITY',               // the thing is labelled above the card's level
  'DENY_RANK',                      // acting on someone who outranks the card
  'DENY_SELF_ACTION',               // acting on oneself where that is forbidden
  'DENY_LAST_OWNER',                // trying to remove the company's last usable Owner
  'DENY_COMPANY_CARD',              // acting on the company card as if it were a person's
  'DENY_PLATFORM_ONLY',             // an operator-only action asked by a company's card
  'DENY_TENANT_MISMATCH',           // something of another company
  'DENY_UNVERIFIED',                // unverified knowledge asked for by a card that may read verified only
  'DENY_FILTER_NOT_SUPPORTED',      // a whole list asked for by a card that may see only part (D23)
]);
/** Refusals that are never counted, each with the reason. Together with COUNTED_REASONS this covers every reason there is. */
export const UNCOUNTED_REASONS: ReadonlySet<string> = new Set([
  'DENY_CARD_HOURS', 'DENY_CARD_NETWORK', 'DENY_CARD_LIMIT', 'DENY_CARD_READ_ONLY',   // the card's own restrictions: ordinary use runs into them
  'DENY_CARD_RESTRICTION_INVALID',                                                  // a restriction that cannot be read: not the card holder's doing
  'DENY_CARD_EXPIRED', 'DENY_CARD_STATE', 'DENY_CARD_LOCKED', 'DENY_GRACE_READ_ONLY', // the card's phase: it ends by itself or by renewal
  'DENY_TENANT_EXPIRED', 'DENY_TENANT_GRACE_READ_ONLY', 'DENY_TENANT_INACTIVE',       // the company's phase: everybody meets it at once
  'DENY_PLAN_LIMIT',                                                                // the plan's limit: an upgrade matter, not probing
  'DENY_PDP_ERROR', 'DENY_UNKNOWN_ACTION', 'DENY_UNKNOWN_OBLIGATION', 'DENY_LIST_FILTER_UNDECLARED', // faults of ours, not of the card
  'DENY_RESOURCE_NOT_FOUND',                                                        // old links; decided before the policy is asked
  'DENY_UNAUTHENTICATED',                                                           // no session: there is no card to count against
  'DENY_SELF_REVIEW',   // verifying or releasing one's own work: the screens offer the button to every reviewer and expect this refusal
  'DENY_FETCH_SITE',    // a page of another address made the browser ask: refused before the policy, not the card holder's doing
]);

/** Does this refusal count toward the "denials" rule? Pure. */
export function countsTowardAnomaly(reasonCode: string): boolean {
  // The reason alone decides. A request a page of another address made the browser send never gets this far: the
  // HTTP layer refuses it before the policy is asked (DENY_FETCH_SITE), so forging that header cannot hide probing.
  return COUNTED_REASONS.has(reasonCode);
}

/** The decision of rule "denials", from the count in the current window. Pure. */
export function shouldLockForDenials(countInWindow: number, settings: AnomalySettings): boolean {
  return settings.enabled && settings.denials_enabled && countInWindow >= settings.denials_threshold;
}

/** The decision of rule "second_address", from the number of other live sessions on a different address. Pure. */
export function shouldLockForSecondAddress(otherSessionsElsewhere: number, settings: AnomalySettings): boolean {
  return settings.enabled && settings.second_address_enabled && otherSessionsElsewhere > 0;
}

/** Refuses a patch that is not allowed; values outside the ranges are refused, not clamped. Pure. */
export function validateAnomalyPatch(patch: Partial<AnomalySettings>): void {
  for (const key of SWITCHES) {
    if (patch[key] !== undefined && typeof patch[key] !== 'boolean') throw problems.unprocessable(`${key} must be true or false`);
  }
  for (const [key, [low, high]] of Object.entries(ANOMALY_LIMITS)) {
    const value = patch[key as keyof typeof ANOMALY_LIMITS];
    if (value !== undefined && (!Number.isInteger(value) || value < low || value > high)) {
      throw problems.unprocessable(`${key} must be a whole number from ${low} to ${high}`);
    }
  }
}

const KEYS = [...SWITCHES, ...(Object.keys(ANOMALY_LIMITS) as Array<keyof typeof ANOMALY_LIMITS>)] as const;
type SettingsRow = AnomalySettings & { updated_at: Date };
const COLUMNS = `${KEYS.join(', ')}, updated_at`;

export async function getAnomalySettings(tx: Tx, tenantId: string, defaults: AnomalySettings = ANOMALY_DEFAULTS): Promise<AnomalySettingsView> {
  const { rows } = await tx.query<SettingsRow>(`SELECT ${COLUMNS} FROM anomaly_settings WHERE tenant_id = $1`, [tenantId]);
  const row = rows[0];
  if (!row) return { ...defaults, updated_at: null };
  return {
    enabled: row.enabled, denials_enabled: row.denials_enabled, denials_threshold: row.denials_threshold,
    denials_window_minutes: row.denials_window_minutes, second_address_enabled: row.second_address_enabled,
    second_address_window_minutes: row.second_address_window_minutes, updated_at: row.updated_at.toISOString(),
  };
}

export interface AnomalySettingsChange { key: keyof AnomalySettings; from: boolean | number; to: boolean | number }

/** Changes the given settings and leaves the others. Returns the new settings and exactly what changed (old and new value). */
export async function updateAnomalySettings(
  tx: Tx, tenantId: string, patch: Partial<AnomalySettings>, actorCardId: string, now: Date, defaults: AnomalySettings = ANOMALY_DEFAULTS,
): Promise<{ settings: AnomalySettingsView; changes: AnomalySettingsChange[] }> {
  validateAnomalyPatch(patch);
  const current = await getAnomalySettings(tx, tenantId, defaults);
  const next: AnomalySettings = { ...current };
  const changes: AnomalySettingsChange[] = [];
  for (const key of KEYS) {
    const value = patch[key];
    if (value === undefined || value === current[key]) continue;
    changes.push({ key, from: current[key], to: value });
    (next as unknown as Record<string, boolean | number>)[key] = value;
  }
  await tx.query(
    `INSERT INTO anomaly_settings (tenant_id, enabled, denials_enabled, denials_threshold, denials_window_minutes,
                                   second_address_enabled, second_address_window_minutes, updated_at, updated_by_card_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (tenant_id) DO UPDATE SET enabled = $2, denials_enabled = $3, denials_threshold = $4, denials_window_minutes = $5,
       second_address_enabled = $6, second_address_window_minutes = $7, updated_at = $8, updated_by_card_id = $9`,
    [tenantId, next.enabled, next.denials_enabled, next.denials_threshold, next.denials_window_minutes,
      next.second_address_enabled, next.second_address_window_minutes, now, actorCardId]);
  return { settings: await getAnomalySettings(tx, tenantId, defaults), changes };
}

export interface AnomalyDeps {
  cards: CardService;
  notifier: Notifier;
  hmacKey: Buffer;
  /** What applies to a company that has not set its own rules. Production: ANOMALY_DEFAULTS (tests start the app with the rules off). */
  defaults?: AnomalySettings;
}

export class AnomalyGuard {
  readonly #d: AnomalyDeps;

  readonly #defaults: AnomalySettings;

  constructor(deps: AnomalyDeps) {
    this.#d = deps;
    this.#defaults = deps.defaults ?? ANOMALY_DEFAULTS;
  }

  settings(tx: Tx, tenantId: string): Promise<AnomalySettingsView> {
    return getAnomalySettings(tx, tenantId, this.#defaults);
  }

  update(tx: Tx, tenantId: string, patch: Partial<AnomalySettings>, actorCardId: string, now: Date): Promise<{ settings: AnomalySettingsView; changes: AnomalySettingsChange[] }> {
    return updateAnomalySettings(tx, tenantId, patch, actorCardId, now, this.#defaults);
  }

  /**
   * Rule "denials". Called ONLY for a refusal of a request that carried a live session of `cardId`
   * (the HTTP layer's route-level decision) - never for sign-in attempts, never for re-checks inside a handler.
   * A refusal that does not count (see countsTowardAnomaly) costs nothing here. One that counts: one row write.
   */
  async denied(tx: Tx, who: { tenant_id: string; card_id: string }, reasonCode: string, ctx: RequestContext): Promise<boolean> {
    if (!countsTowardAnomaly(reasonCode)) return false;
    const settings = await this.settings(tx, who.tenant_id);
    if (!settings.enabled || !settings.denials_enabled) return false;
    // ONE lock order everywhere: the company's roles lock first, then the card's counter row. Routes that change a
    // person or a card take the roles lock before the policy is asked (and so before a refusal is counted); taking
    // the counter first here and the roles lock only at the threshold would be the opposite order - a deadlock
    // between two refused requests of one card.
    await lockTenantRoles(tx, who.tenant_id);
    const windowStart = new Date(ctx.now.getTime() - settings.denials_window_minutes * 60_000);
    const { rows } = await tx.query<{ denials: number }>(
      `INSERT INTO card_anomaly_counters (tenant_id, card_id, window_start, denials) VALUES ($1, $2, $3, 1)
       ON CONFLICT (tenant_id, card_id) DO UPDATE SET
         denials = CASE WHEN card_anomaly_counters.window_start <= $4 THEN 1 ELSE card_anomaly_counters.denials + 1 END,
         window_start = CASE WHEN card_anomaly_counters.window_start <= $4 THEN $3 ELSE card_anomaly_counters.window_start END
       RETURNING denials`,
      [who.tenant_id, who.card_id, ctx.now, windowStart]);
    const count = rows[0]?.denials ?? 0;
    if (!shouldLockForDenials(count, settings)) return false;
    return this.#lock(tx, who.tenant_id, who.card_id, 'denials', count, ctx);
  }

  /**
   * Rule "second_address". Called after a SUCCESSFUL sign-in created `newSessionId`. True = the card was locked
   * (all its sessions, the new one included, have ended).
   */
  async signedIn(tx: Tx, who: { tenant_id: string; card_id: string }, newSessionId: string, ctx: RequestContext): Promise<boolean> {
    const settings = await this.settings(tx, who.tenant_id);
    if (!settings.enabled || !settings.second_address_enabled) return false;
    const since = new Date(ctx.now.getTime() - settings.second_address_window_minutes * 60_000);
    const { rows } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sessions
        WHERE tenant_id = $1 AND card_id = $2 AND id <> $3 AND revoked_at IS NULL AND idle_expires_at > $4
          AND last_seen_at >= $5 AND ip_hash IS NOT NULL AND ip_hash <> $6`,
      [who.tenant_id, who.card_id, newSessionId, ctx.now, since, hmacSha256(this.#d.hmacKey, `ip:${ctx.ip}`)]);
    const others = rows[0]?.n ?? 0;
    if (!shouldLockForSecondAddress(others, settings)) return false;
    await lockTenantRoles(tx, who.tenant_id);
    return this.#lock(tx, who.tenant_id, who.card_id, 'second_address', others, ctx);
  }

  /** People are told once the fact is committed; where there is no such queue (a job, a test), at once. Never throws. */
  #tell(ctx: RequestContext, type: 'card_locked' | 'card_anomaly', tenantId: string, cardId: string): void {
    const send = (): Promise<void> => this.#d.notifier.notify({ type, tenantId, cardId });
    if (ctx.afterCommit) ctx.afterCommit.push(send);
    else void send().catch(() => undefined);
  }

  /**
   * Locks the card unless it is already locked or is the last usable Owner card. True = locked now.
   * The caller holds the company's roles lock, so "the last usable Owner" is decided one request at a time.
   */
  async #lock(tx: Tx, tenantId: string, cardId: string, rule: AnomalyRule, count: number, ctx: RequestContext): Promise<boolean> {
    const card = { id: cardId, tenant_id: tenantId };
    await tx.query('DELETE FROM card_anomaly_counters WHERE tenant_id = $1 AND card_id = $2', [tenantId, cardId]);

    if (await this.#isLastUsableOwner(tx, tenantId, cardId, ctx.now)) {
      const state = await tx.query<{ locked_at: Date | null }>('SELECT locked_at FROM card_auth_state WHERE tenant_id = $1 AND card_id = $2', [tenantId, cardId]);
      if (state.rows[0]?.locked_at != null) return false;
      await this.#d.cards.event(tx, card, 'anomaly_not_locked', null, ctx, { rule, count });
      await writeAudit(tx, {
        tenantId, actorKind: 'system', action: 'card:lock', resourceType: 'card', resourceId: cardId, decision: 'event',
        reasonCode: 'ANOMALY_NOT_LOCKED_LAST_OWNER', requestId: ctx.requestId, ip: ctx.ip, details: { rule, count },
      });
      this.#tell(ctx, 'card_anomaly', tenantId, cardId);
      return false;
    }

    const locked = await this.#d.cards.lock(tx, card, { reason: 'anomaly', event: 'anomaly_locked', auditReason: LOCK_REASON[rule], details: { rule, count } }, ctx);
    if (locked) this.#tell(ctx, 'card_locked', tenantId, cardId);
    return locked;
  }

  /** Is this an Owner card with no OTHER usable Owner card (the one definition: cards.ts otherUsableOwners)? */
  async #isLastUsableOwner(tx: Tx, tenantId: string, cardId: string, now: Date): Promise<boolean> {
    const own = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM card_roles WHERE tenant_id = $1 AND card_id = $2 AND role_key = 'company_owner'`, [tenantId, cardId]);
    if ((own.rows[0]?.n ?? 0) === 0) return false;
    return (await otherUsableOwners(tx, tenantId, cardId, now)) === 0;
  }
}
