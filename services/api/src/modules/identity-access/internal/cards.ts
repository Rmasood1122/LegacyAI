// Cards: issue, read, and every lifecycle operation. All state changes go through
// `transition()`, which checks the state machine, writes the usage-history event and the
// audit row, in the caller's transaction.
import { hmacSha256, randomToken, sha256 } from '../../../shared/crypto.ts';
import { problems } from '../../../shared/errors.ts';
import type { CardState, RequestContext, RoleKey, SubjectRole } from '../../../shared/policy-types.ts';
import { writeAudit, type Notifier, type TenantSettings, type Tx } from '../../platform/index.ts';
import { formatCardNumber, generateCardNumber } from './card-number.ts';
import { assertTransition, computeDates, effectiveState } from './lifecycle.ts';
import type { SecretCodeHasher } from './secret-code.ts';
import { revokeSessionsForCard, type SessionRevokeReason } from './sessions.ts';

export interface CardRow {
  id: string;
  tenant_id: string;
  kind: 'person' | 'company';
  person_id: string | null;
  card_number: string;
  state: CardState;
  issued_at: Date;
  activated_at: Date | null;
  expires_at: Date;
  grace_until: Date;
  renewal_due: Date;
  renewal_count: number;
  replaced_by_card_id: string | null;
  replaces_card_id: string | null;
}

export const CARD_COLUMNS = `cards.id, cards.tenant_id, cards.kind, cards.person_id, cards.card_number, cards.state, cards.issued_at,
  cards.activated_at, cards.expires_at, cards.grace_until, cards.renewal_due, cards.renewal_count,
  cards.replaced_by_card_id, cards.replaces_card_id`;

export interface RoleInput {
  role_key: RoleKey;
  department_id?: string | null;
}

export interface IssuedSecrets {
  card: CardRow;
  sc: string;
  enrollmentToken?: string;
  enrollmentTokenExpiresAt?: Date;
}

export type CardEventType =
  | 'issued' | 'activated' | 'login_success' | 'login_failed' | 'sc_locked' | 'unlocked' | 'suspended' | 'reinstated'
  | 'revoked' | 'expired' | 'renewed' | 'replaced' | 'role_assigned' | 'role_removed' | 'restriction_denied'
  | 'restrictions_changed' | 'credential_added' | 'credential_removed' | 'enrollment_token_issued' | 'owner_recovered'
  | 'anomaly_locked' | 'anomaly_not_locked';

/**
 * Who is doing something to a card: a card of the same tenant, nobody (the system), or a
 * LegacyAI platform operator - whose card lives in the operator tenant, so it can be named in
 * the audit log (kind 'operator') but never in this tenant's own tables.
 */
export type Actor = string | null | { operatorCardId: string };

/** The actor as a card of THIS tenant, or null. Safe to store in columns that reference cards. */
export const actorCard = (actor: Actor): string | null => (typeof actor === 'string' ? actor : null);

const ENROLLMENT_TOKEN_HOURS = 72;

export async function getCard(tx: Tx, cardId: string, forUpdate = false): Promise<CardRow | null> {
  const { rows } = await tx.query<CardRow>(
    forUpdate ? `SELECT ${CARD_COLUMNS} FROM cards WHERE id = $1 FOR UPDATE` : `SELECT ${CARD_COLUMNS} FROM cards WHERE id = $1`,
    [cardId],
  );
  return rows[0] ?? null;
}

export async function isLocked(tx: Tx, cardId: string): Promise<boolean> {
  const { rows } = await tx.query<{ locked_at: Date | null }>('SELECT locked_at FROM card_auth_state WHERE card_id = $1', [cardId]);
  return rows[0]?.locked_at != null;
}

/** Why the card is locked ('sc_attempts', 'admin', 'anomaly'), or null when it is not. */
async function lockReason(tx: Tx, cardId: string): Promise<string | null> {
  const { rows } = await tx.query<{ lock_reason: string | null }>('SELECT lock_reason FROM card_auth_state WHERE card_id = $1', [cardId]);
  return rows[0]?.lock_reason ?? null;
}

/** Per-tenant, per-transaction lock used by everything that changes roles or could leave a company without a usable Owner. */
export async function lockTenantRoles(tx: Tx, tenantId: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 42))', [`roles:${tenantId}`]);
}

export async function personDepartment(tx: Tx, personId: string | null): Promise<string | null> {
  if (personId === null) return null;
  const { rows } = await tx.query<{ department_id: string | null }>('SELECT department_id FROM people WHERE id = $1', [personId]);
  return rows[0]?.department_id ?? null;
}

export function maxRank(roles: readonly SubjectRole[]): number {
  return roles.reduce((m, r) => (r.rank > m ? r.rank : m), 0);
}

/**
 * How many OTHER cards are USABLE Company Owner cards: a person's card that is active, in date and not locked.
 * Zero means the given card is the last one that can act for the company. This is the ONE definition, used by
 * everything that could leave a company without such a card (suspend, revoke, role removal, offboarding, the
 * anomaly lock). Replacing a card is not in that list and need not be: the policy refuses replacing a card of equal
 * rank, so no Owner can replace another Owner's card, and a replacement issues a new usable card in the same step. A locked Owner card cannot sign in, so it does not count: before Phase 4 it did, which would have let the
 * last WORKING Owner card be suspended while a locked one was still "there".
 */
export async function otherUsableOwners(tx: Tx, tenantId: string, exceptCardId: string, now: Date): Promise<number> {
  const { rows } = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM cards c
       JOIN card_roles cr ON cr.tenant_id = c.tenant_id AND cr.card_id = c.id
       LEFT JOIN card_auth_state a ON a.tenant_id = c.tenant_id AND a.card_id = c.id
      WHERE c.tenant_id = $1 AND c.id <> $2 AND c.kind = 'person' AND c.state = 'active' AND c.expires_at > $3
        AND cr.role_key = 'company_owner' AND a.locked_at IS NULL`,
    [tenantId, exceptCardId, now],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function toApiCard(tx: Tx, card: CardRow, now: Date): Promise<Record<string, unknown>> {
  const assigned = await tx.query<{ role_key: string; department_id: string | null; assigned_at: Date }>(
    'SELECT role_key, department_id, assigned_at FROM card_roles WHERE tenant_id = $1 AND card_id = $2 ORDER BY role_key', [
      card.tenant_id, card.id,
    ]);
  return {
    id: card.id,
    kind: card.kind,
    card_number: formatCardNumber(card.card_number),
    state: effectiveState(card, now),
    person_id: card.person_id,
    issued_at: card.issued_at.toISOString(),
    activated_at: card.activated_at ? card.activated_at.toISOString() : null,
    expires_at: card.expires_at.toISOString(),
    grace_until: card.grace_until.toISOString(),
    renewal_due: card.renewal_due.toISOString(),
    renewal_count: card.renewal_count,
    locked: await isLocked(tx, card.id),
    lock_reason: await lockReason(tx, card.id),
    replaced_by_card_id: card.replaced_by_card_id,
    replaces_card_id: card.replaces_card_id,
    roles: assigned.rows.map((r) => ({ role_key: r.role_key, department_id: r.department_id, assigned_at: r.assigned_at.toISOString() })),
  };
}

export function withSecrets(card: Record<string, unknown>, issued: Pick<IssuedSecrets, 'sc' | 'enrollmentToken' | 'enrollmentTokenExpiresAt'>): Record<string, unknown> {
  const body: Record<string, unknown> = { card, sc: issued.sc, secret_already_shown: false };
  if (issued.enrollmentToken !== undefined && issued.enrollmentTokenExpiresAt !== undefined) {
    body.enrollment_token = issued.enrollmentToken;
    body.enrollment_token_expires_at = issued.enrollmentTokenExpiresAt.toISOString();
  }
  return body;
}

export interface CardServiceDeps {
  hasher: SecretCodeHasher;
  notifier: Notifier;
  hmacKey: Buffer;
}

export class CardService {
  readonly #hasher: SecretCodeHasher;
  readonly #notifier: Notifier;
  readonly #hmacKey: Buffer;

  constructor(deps: CardServiceDeps) {
    this.#hasher = deps.hasher;
    this.#notifier = deps.notifier;
    this.#hmacKey = deps.hmacKey;
  }

  async event(
    tx: Tx, card: Pick<CardRow, 'id' | 'tenant_id'>, type: CardEventType, actorCardId: string | null, ctx: RequestContext,
    metadata: Record<string, string | number | boolean | null> = {}, credentialId: string | null = null,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO card_events (tenant_id, card_id, event_type, actor_card_id, credential_id, device_hash, ip_hash, request_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        card.tenant_id, card.id, type, actorCardId, credentialId,
        ctx.userAgent === '' ? null : hmacSha256(this.#hmacKey, `ua:${ctx.userAgent}`),
        hmacSha256(this.#hmacKey, `ip:${ctx.ip}`), ctx.requestId, JSON.stringify(metadata),
      ],
    );
  }

  async #audit(
    tx: Tx, card: Pick<CardRow, 'id' | 'tenant_id'>, action: string, reasonCode: string, actor: Actor,
    ctx: RequestContext, details: Record<string, string | number | boolean | null> = {},
  ): Promise<void> {
    const who = actor === null ? { actorCardId: null, actorKind: 'system' as const }
      : typeof actor === 'string' ? { actorCardId: actor, actorKind: 'card' as const }
        : { actorCardId: actor.operatorCardId, actorKind: 'operator' as const };
    await writeAudit(tx, {
      tenantId: card.tenant_id, ...who, action,
      resourceType: 'card', resourceId: card.id, decision: 'event', reasonCode, requestId: ctx.requestId, ip: ctx.ip, details,
    });
  }

  /** Changes state through the state machine and records it. */
  async transition(
    tx: Tx, card: CardRow, to: CardState, eventType: CardEventType, actor: Actor, ctx: RequestContext,
    extra: { reasonColumn?: 'suspended_reason' | 'revoked_reason'; reason?: string } = {},
  ): Promise<CardRow> {
    assertTransition(card.state, to);
    if (extra.reasonColumn === 'suspended_reason') {
      await tx.query('UPDATE cards SET state = $2, suspended_reason = $3, updated_at = now() WHERE id = $1', [card.id, to, extra.reason ?? null]);
    } else if (extra.reasonColumn === 'revoked_reason') {
      await tx.query('UPDATE cards SET state = $2, revoked_reason = $3, updated_at = now() WHERE id = $1', [card.id, to, extra.reason ?? null]);
    } else {
      await tx.query('UPDATE cards SET state = $2, updated_at = now() WHERE id = $1', [card.id, to]);
    }
    await this.event(tx, card, eventType, actorCard(actor), ctx, { state_from: card.state, state_to: to });
    await this.#audit(tx, card, `card:${eventType}`, 'CARD_STATE_CHANGED', actor, ctx, { state_from: card.state, state_to: to });
    return { ...card, state: to };
  }

  /** If the clock has passed expires_at but the row still says active/issued, write the expiry down. */
  async materializeExpiry(tx: Tx, card: CardRow, ctx: RequestContext): Promise<CardRow> {
    if ((card.state === 'active' || card.state === 'issued') && effectiveState(card, ctx.now) === 'expired') {
      const updated = await this.transition(tx, card, 'expired', 'expired', null, ctx);
      if (card.kind === 'person') await revokeNonGraceSessions(tx, card, ctx.now);
      return updated;
    }
    return card;
  }

  /** Stores a new SC hash and retires the old one. The old SC stops working in the same transaction. */
  async rotateSecret(tx: Tx, card: Pick<CardRow, 'id' | 'tenant_id'>, actorCardId: string | null, now: Date): Promise<string> {
    const sc = this.#hasher.generate();
    const { hash, pepperId } = await this.#hasher.hash(card.id, sc);
    await tx.query(
      `UPDATE card_secrets SET status = 'retired', sc_hash = NULL, retired_at = $3
        WHERE tenant_id = $1 AND card_id = $2 AND status = 'current'`,
      [card.tenant_id, card.id, now],
    );
    await tx.query(
      'INSERT INTO card_secrets (tenant_id, card_id, sc_hash, pepper_id, created_by_card_id) VALUES ($1, $2, $3, $4, $5)',
      [card.tenant_id, card.id, hash, pepperId, actorCardId],
    );
    return sc;
  }

  async #newEnrollmentToken(
    tx: Tx, card: Pick<CardRow, 'id' | 'tenant_id'>, purpose: 'initial' | 'reset', actorCardId: string | null, now: Date,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken(32);
    const expiresAt = new Date(now.getTime() + ENROLLMENT_TOKEN_HOURS * 3_600_000);
    await tx.query(
      'INSERT INTO enrollment_tokens (tenant_id, card_id, token_hash, purpose, expires_at, created_by_card_id) VALUES ($1, $2, $3, $4, $5, $6)',
      [card.tenant_id, card.id, sha256(token), purpose, expiresAt, actorCardId],
    );
    return { token, expiresAt };
  }

  async #insertCard(
    tx: Tx, p: { tenantId: string; kind: 'person' | 'company'; personId: string | null; actorCardId: string | null; replaces?: string },
    dates: { expires_at: Date; grace_until: Date; renewal_due: Date }, now: Date,
  ): Promise<CardRow> {
    // A savepoint lets us retry the (astronomically unlikely) card-number collision
    // without aborting the surrounding transaction.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await tx.query('SAVEPOINT insert_card');
      try {
        const { rows } = await tx.query<CardRow>(
          `INSERT INTO cards (tenant_id, kind, person_id, card_number, issued_at, expires_at, grace_until, renewal_due,
                              issued_by_card_id, replaces_card_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${CARD_COLUMNS}`,
          [p.tenantId, p.kind, p.personId, generateCardNumber(), now, dates.expires_at, dates.grace_until, dates.renewal_due,
            p.actorCardId, p.replaces ?? null],
        );
        await tx.query('RELEASE SAVEPOINT insert_card');
        return rows[0] as CardRow;
      } catch (err) {
        await tx.query('ROLLBACK TO SAVEPOINT insert_card');
        const e = err as { code?: string; constraint?: string };
        if (e.code === '23505' && e.constraint === 'cards_card_number_key') continue;
        if (e.code === '23505') throw problems.conflict('card-exists', 'This person (or company) already has a live card');
        if (e.code === '23503') throw problems.notFound();
        throw err;
      }
    }
    throw new Error('could not generate a unique card number');
  }

  async assignRoles(tx: Tx, card: Pick<CardRow, 'id' | 'tenant_id'>, roles: readonly RoleInput[], settings: TenantSettings, actorCardId: string | null): Promise<void> {
    for (const r of roles) {
      if (!settings.enabled_roles.includes(r.role_key)) {
        throw problems.unprocessable(`The role ${r.role_key} is not enabled for this tenant`);
      }
      try {
        await tx.query(
          `INSERT INTO card_roles (tenant_id, card_id, role_key, department_id, assigned_by_card_id) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, card_id, role_key) DO UPDATE SET department_id = EXCLUDED.department_id`,
          [card.tenant_id, card.id, r.role_key, r.department_id ?? null, actorCardId],
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23503') throw problems.unprocessable('Unknown department');
        throw err;
      }
    }
  }

  async issue(
    tx: Tx, p: { tenantId: string; kind: 'person' | 'company'; personId: string | null; roles: readonly RoleInput[]; actorCardId: string | null },
    settings: TenantSettings, ctx: RequestContext,
  ): Promise<IssuedSecrets> {
    let card = await this.#insertCard(tx, p, computeDates(ctx.now, settings), ctx.now);
    await tx.query('INSERT INTO card_auth_state (tenant_id, card_id) VALUES ($1, $2)', [card.tenant_id, card.id]);
    const sc = await this.rotateSecret(tx, card, p.actorCardId, ctx.now);
    await this.assignRoles(tx, card, p.roles, settings, p.actorCardId);
    await this.event(tx, card, 'issued', p.actorCardId, ctx);
    await this.#audit(tx, card, 'card:issue', 'CARD_ISSUED', p.actorCardId, ctx);
    await this.#notifier.notify({ type: 'card_issued', tenantId: card.tenant_id, cardId: card.id });

    if (p.kind === 'company') {
      // A company card identifies the company and carries its expiry. Nobody logs in with it,
      // so there is no strong factor to enrol and it becomes active immediately.
      await tx.query('UPDATE cards SET activated_at = $2 WHERE id = $1', [card.id, ctx.now]);
      card = await this.transition(tx, { ...card, activated_at: ctx.now }, 'active', 'activated', p.actorCardId, ctx);
      return { card, sc };
    }
    const enrollment = await this.#newEnrollmentToken(tx, card, 'initial', p.actorCardId, ctx.now);
    return { card, sc, enrollmentToken: enrollment.token, enrollmentTokenExpiresAt: enrollment.expiresAt };
  }

  async suspend(tx: Tx, card: CardRow, reason: string, actorCardId: string, ctx: RequestContext): Promise<CardRow> {
    const current = await this.materializeExpiry(tx, card, ctx);
    const updated = await this.transition(tx, current, 'suspended', 'suspended', actorCardId, ctx, { reasonColumn: 'suspended_reason', reason });
    await this.revokeSessions(tx, card, 'card_suspended', ctx.now);
    await this.#notifier.notify({ type: 'card_suspended', tenantId: card.tenant_id, cardId: card.id });
    return updated;
  }

  async reinstate(tx: Tx, card: CardRow, actorCardId: string, ctx: RequestContext): Promise<CardRow> {
    return this.transition(tx, card, 'active', 'reinstated', actorCardId, ctx);
  }

  async revoke(tx: Tx, card: CardRow, reason: string, actorCardId: string | null, ctx: RequestContext): Promise<CardRow> {
    const current = await this.materializeExpiry(tx, card, ctx);
    const updated = await this.transition(tx, current, 'revoked', 'revoked', actorCardId, ctx, { reasonColumn: 'revoked_reason', reason });
    await this.revokeSessions(tx, card, 'card_revoked', ctx.now);
    await tx.query(`UPDATE card_secrets SET status = 'retired', sc_hash = NULL, retired_at = $2 WHERE card_id = $1 AND status = 'current'`, [card.id, ctx.now]);
    await this.#notifier.notify({ type: 'card_revoked', tenantId: card.tenant_id, cardId: card.id });
    return updated;
  }

  /** A new validity period starting now. An expired card becomes active again. */
  async #extendValidity(
    tx: Tx, card: CardRow, validityDays: number | undefined, actor: Actor, settings: TenantSettings, ctx: RequestContext,
  ): Promise<CardRow> {
    let current = await this.materializeExpiry(tx, card, ctx);
    if (current.state === 'expired') current = await this.transition(tx, current, 'active', 'renewed', actor, ctx);
    else if (current.state === 'active') await this.event(tx, current, 'renewed', actorCard(actor), ctx);
    else throw problems.conflict('illegal-transition', `A card that is ${current.state} cannot be renewed`);

    const dates = computeDates(ctx.now, settings, validityDays);
    const { rows } = await tx.query<CardRow>(
      `UPDATE cards SET expires_at = $2, grace_until = $3, renewal_due = $4, renewal_count = renewal_count + 1,
              last_renewed_at = $5, updated_at = now() WHERE id = $1 RETURNING ${CARD_COLUMNS}`,
      [card.id, dates.expires_at, dates.grace_until, dates.renewal_due, ctx.now],
    );
    return rows[0] as CardRow;
  }

  async renew(tx: Tx, card: CardRow, validityDays: number | undefined, actor: Actor, settings: TenantSettings, ctx: RequestContext): Promise<IssuedSecrets> {
    const renewed = await this.#extendValidity(tx, card, validityDays, actor, settings, ctx);
    // Renewal ALWAYS rotates the SC: the old code is dead from this moment.
    const sc = await this.rotateSecret(tx, card, actorCard(actor), ctx.now);
    await tx.query(
      'UPDATE card_auth_state SET sc_failed_count = 0, locked_at = NULL, lock_reason = NULL WHERE tenant_id = $1 AND card_id = $2',
      [card.tenant_id, card.id]);
    await this.revokeSessions(tx, card, 'sc_rotated', ctx.now);
    await this.#audit(tx, card, 'card:renew', 'CARD_RENEWED_SC_ROTATED', actor, ctx);
    await this.#notifier.notify({ type: 'card_renewed', tenantId: card.tenant_id, cardId: card.id });
    return { card: renewed, sc };
  }

  /**
   * Platform-operator recovery of a Company Owner who can no longer sign in (locked, lost
   * device, expired). Nobody inside the tenant can do this for an Owner. What it does, all in
   * the caller's transaction:
   *   - every existing strong factor, session and unused enrollment token of the card is revoked;
   *   - the SC is rotated (forced) and any lock or sign-in pause is cleared;
   *   - an expired card gets a new validity period;
   *   - a new one-time enrollment token is issued, so the Owner must enrol a NEW strong factor.
   * The operator receives the new SC and the token to hand over out of band. Together they only
   * let someone enrol a factor - which the audit log, the card history and the notifications to
   * the other Owners make visible.
   */
  async recoverOwner(
    tx: Tx, card: CardRow, actor: { operatorCardId: string } | null, verificationRef: string, settings: TenantSettings, ctx: RequestContext,
  ): Promise<IssuedSecrets> {
    let current = await this.materializeExpiry(tx, card, ctx);
    if (current.kind !== 'person' || (current.state !== 'active' && current.state !== 'expired' && current.state !== 'issued')) {
      throw problems.conflict('illegal-transition', `A card that is ${current.state} cannot be recovered`);
    }
    if (current.state === 'expired') current = await this.#extendValidity(tx, current, undefined, actor, settings, ctx);

    await tx.query(`UPDATE credentials SET status = 'revoked' WHERE tenant_id = $1 AND card_id = $2`, [card.tenant_id, card.id]);
    await tx.query('UPDATE enrollment_tokens SET used_at = $3 WHERE tenant_id = $1 AND card_id = $2 AND used_at IS NULL', [card.tenant_id, card.id, ctx.now]);
    await this.revokeSessions(tx, card, 'credentials_reset', ctx.now);
    const sc = await this.rotateSecret(tx, card, null, ctx.now);
    await tx.query(
      `UPDATE card_auth_state SET sc_failed_count = 0, locked_at = NULL, lock_reason = NULL, factor_failed_count = 0,
              factor_window_start = NULL, factor_throttle_level = 0, factor_throttled_until = NULL
        WHERE tenant_id = $1 AND card_id = $2`,
      [card.tenant_id, card.id]);
    const enrollment = await this.#newEnrollmentToken(tx, card, current.activated_at === null ? 'initial' : 'reset', null, ctx.now);

    await this.event(tx, card, 'owner_recovered', null, ctx);
    await this.#audit(tx, card, 'card:owner_recovery', 'OWNER_RECOVERED_BY_OPERATOR', actor, ctx, { verification_ref: verificationRef });
    await this.#notifier.notify({ type: 'owner_recovered', tenantId: card.tenant_id, cardId: card.id });
    return { card: current, sc, enrollmentToken: enrollment.token, enrollmentTokenExpiresAt: enrollment.expiresAt };
  }

  /**
   * THE lock: the card stops working until someone with the right to unlock it issues a new secret code. Used by
   * the secret-code lockout and by the anomaly rules, so both leave exactly the same state behind. Returns false
   * (and changes nothing) when the card is already locked.
   */
  async lock(
    tx: Tx, card: Pick<CardRow, 'id' | 'tenant_id'>,
    how: { reason: 'sc_attempts' | 'anomaly'; event: CardEventType; auditReason: string; details: Record<string, string | number | boolean | null> },
    ctx: RequestContext,
  ): Promise<boolean> {
    await tx.query('INSERT INTO card_auth_state (tenant_id, card_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [card.tenant_id, card.id]);
    const locked = await tx.query(
      'UPDATE card_auth_state SET locked_at = $3, lock_reason = $4 WHERE tenant_id = $1 AND card_id = $2 AND locked_at IS NULL',
      [card.tenant_id, card.id, ctx.now, how.reason]);
    if (locked.rowCount === 0) return false;
    await this.revokeSessions(tx, card, 'card_locked', ctx.now);
    await this.event(tx, card, how.event, null, ctx, how.details);
    await this.#audit(tx, card, 'card:lock', how.auditReason, null, ctx, how.details);
    return true;
  }

  async unlock(tx: Tx, card: CardRow, actorCardId: string, ctx: RequestContext): Promise<IssuedSecrets> {
    const state = effectiveState(card, ctx.now);
    if (card.kind !== 'person' || (state !== 'active' && state !== 'expired')) {
      throw problems.conflict('illegal-transition', `A card that is ${state} cannot be unlocked`);
    }
    if (!(await isLocked(tx, card.id))) throw problems.conflict('not-locked', 'This card is not locked');
    // why it was locked ('sc_attempts' or 'anomaly'), for the audit trail: an unlock after an anomaly lock must be visible as such
    const why = await lockReason(tx, card.id);
    // The old SC was forgotten or under attack, so unlocking always issues a new one.
    const sc = await this.rotateSecret(tx, card, actorCardId, ctx.now);
    await tx.query(
      'UPDATE card_auth_state SET sc_failed_count = 0, locked_at = NULL, lock_reason = NULL WHERE tenant_id = $1 AND card_id = $2',
      [card.tenant_id, card.id]);
    await this.revokeSessions(tx, card, 'sc_rotated', ctx.now);
    // an anomaly rule starts counting from nothing again
    await tx.query('DELETE FROM card_anomaly_counters WHERE tenant_id = $1 AND card_id = $2', [card.tenant_id, card.id]);
    await this.event(tx, card, 'unlocked', actorCardId, ctx);
    await this.#audit(tx, card, 'card:unlock', 'CARD_UNLOCKED_SC_ROTATED', actorCardId, ctx, why === null ? {} : { reason: why });
    await this.#notifier.notify({ type: 'card_unlocked', tenantId: card.tenant_id, cardId: card.id });
    return { card, sc };
  }

  async replace(
    tx: Tx, card: CardRow, p: { reason: 'lost' | 'damaged' | 'compromised'; resetCredentials: boolean }, actorCardId: string,
    settings: TenantSettings, ctx: RequestContext,
  ): Promise<IssuedSecrets> {
    const current = await this.materializeExpiry(tx, card, ctx);
    if (card.kind === 'company') throw problems.conflict('illegal-transition', 'A company card cannot be replaced');
    // 1. Kill the old card first: its number, SC and sessions stop working immediately.
    //    (A suspended card cannot be replaced - the state machine refuses - so replacing can never undo a suspension.)
    await this.transition(tx, current, 'replaced', 'replaced', actorCardId, ctx);
    await this.revokeSessions(tx, card, 'card_replaced', ctx.now);
    await tx.query(`UPDATE card_secrets SET status = 'retired', sc_hash = NULL, retired_at = $2 WHERE card_id = $1 AND status = 'current'`, [card.id, ctx.now]);

    // 2. New card: new number, new SC, same person, same roles and restrictions.
    let next = await this.#insertCard(
      tx, { tenantId: card.tenant_id, kind: card.kind, personId: card.person_id, actorCardId, replaces: card.id },
      computeDates(ctx.now, settings), ctx.now);
    await tx.query('UPDATE cards SET replaced_by_card_id = $2 WHERE id = $1', [card.id, next.id]);
    await tx.query('INSERT INTO card_auth_state (tenant_id, card_id) VALUES ($1, $2)', [next.tenant_id, next.id]);
    const sc = await this.rotateSecret(tx, next, actorCardId, ctx.now);
    await tx.query(
      `INSERT INTO card_roles (tenant_id, card_id, role_key, department_id, assigned_by_card_id)
       SELECT tenant_id, $2, role_key, department_id, $3 FROM card_roles WHERE tenant_id = $4 AND card_id = $1`,
      [card.id, next.id, actorCardId, card.tenant_id]);
    await tx.query(
      `INSERT INTO card_restrictions (tenant_id, card_id, type, config, enabled, created_by_card_id)
       SELECT tenant_id, $2, type, config, enabled, $3 FROM card_restrictions WHERE tenant_id = $4 AND card_id = $1`,
      [card.id, next.id, actorCardId, card.tenant_id]);
    await this.event(tx, next, 'issued', actorCardId, ctx, { old_card_id: card.id, reason: p.reason });
    await this.#audit(tx, next, 'card:replace', 'CARD_REPLACED', actorCardId, ctx, { old_card_id: card.id, new_card_id: next.id, reason: p.reason });
    await this.#notifier.notify({ type: 'card_replaced', tenantId: card.tenant_id, cardId: next.id });

    const result: IssuedSecrets = { card: next, sc };
    if (p.resetCredentials || current.activated_at === null) {
      // Lost or compromised device: the old strong factors must not carry over.
      await tx.query(`UPDATE credentials SET status = 'revoked' WHERE tenant_id = $1 AND card_id = $2`, [card.tenant_id, card.id]);
      const enrollment = await this.#newEnrollmentToken(tx, next, 'initial', actorCardId, ctx.now);
      result.enrollmentToken = enrollment.token;
      result.enrollmentTokenExpiresAt = enrollment.expiresAt;
    } else {
      // Same person, same devices: their strong factors move to the new card.
      await tx.query('UPDATE credentials SET card_id = $2 WHERE tenant_id = $3 AND card_id = $1', [card.id, next.id, card.tenant_id]);
      await tx.query('UPDATE cards SET activated_at = $2 WHERE id = $1', [next.id, ctx.now]);
      next = await this.transition(tx, { ...next, activated_at: ctx.now }, 'active', 'activated', actorCardId, ctx);
    }
    result.card = (await getCard(tx, next.id)) as CardRow;
    return result;
  }

  async issueEnrollmentToken(tx: Tx, card: CardRow, revokeExisting: boolean, actorCardId: string, ctx: RequestContext): Promise<{ token: string; expiresAt: Date }> {
    const state = effectiveState(card, ctx.now);
    if (card.kind !== 'person' || (state !== 'issued' && state !== 'active')) {
      throw problems.conflict('illegal-transition', `A card that is ${state} cannot enrol a new factor`);
    }
    await tx.query('UPDATE enrollment_tokens SET used_at = $3 WHERE tenant_id = $1 AND card_id = $2 AND used_at IS NULL', [card.tenant_id, card.id, ctx.now]);
    if (revokeExisting) {
      await tx.query(`UPDATE credentials SET status = 'revoked' WHERE tenant_id = $1 AND card_id = $2`, [card.tenant_id, card.id]);
      await this.revokeSessions(tx, card, 'credentials_reset', ctx.now);
    }
    const enrollment = await this.#newEnrollmentToken(tx, card, card.activated_at === null ? 'initial' : 'reset', actorCardId, ctx.now);
    // The cardholder is always told that someone can now add a sign-in factor to their card.
    await this.#notifier.notify({ type: 'enrollment_token_issued', tenantId: card.tenant_id, cardId: card.id });
    await this.event(tx, card, 'enrollment_token_issued', actorCardId, ctx);
    await this.#audit(tx, card, 'card:reset_credentials', 'ENROLLMENT_TOKEN_ISSUED', actorCardId, ctx);
    return enrollment;
  }

  /**
   * Ends the card's sessions and, with them, the API keys it made (sessions.ts). Every change of a card's sign-in
   * or rights in this module goes through here. When keys were revoked, the company's Owners are told.
   */
  async revokeSessions(
    tx: Tx, card: Pick<CardRow, 'id' | 'tenant_id'>, reason: SessionRevokeReason, now: Date, only?: { openedWithCredentialId: string },
  ): Promise<void> {
    const { revokedKeyIds } = await revokeSessionsForCard(tx, card.tenant_id, card.id, reason, now, only);
    if (revokedKeyIds.length > 0) await this.#notifier.notify({ type: 'api_key_stopped', tenantId: card.tenant_id, cardId: card.id, audience: 'owners' });
  }
}

/** On expiry sessions are not all killed: the policy point allows read-only use during grace. */
async function revokeNonGraceSessions(tx: Tx, card: CardRow, now: Date): Promise<void> {
  if (now.getTime() >= card.grace_until.getTime()) {
    await revokeSessionsForCard(tx, card.tenant_id, card.id, 'card_expired', now);
  }
}
