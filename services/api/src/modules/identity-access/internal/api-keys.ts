// API keys for machines (feature 28, part A; docs/phase4/06-open-api-webhooks-email.md, decision D30).
//
// A key is its OWN kind of subject (ApiKeySubject): it has no roles, no session and no person. What a request with
// a key may do is decided by the policy decision point alone:
//   (1) the grants the maker's card holds at that moment (its roles; its state and expiry gate the key),
//   (2) cut down to the permissions written into the key when it was made,
//   (3) and to the short list a key may ever carry (API_KEY_PERMISSIONS in policy.ts: read and ask only),
// and nothing labelled above the key's level. The maker's card RESTRICTIONS (hours, networks, usage cap) do not
// apply to a key: a key has its own network list and its own limits (requests per minute, questions per hour).
//
// A key does not survive a change of its maker's sign-in or rights: see key-revocation.ts.
//
// The secret is shown once and only its SHA-256 is kept (32 random bytes: there is nothing to guess).
import { constantTimeEqual, isUuid, randomToken, sha256 } from '../../../shared/crypto.ts';
import type { ApiKeySubject, CardSubject, RequestContext } from '../../../shared/policy-types.ts';
import { API_KEY_SCHEME, writeAudit, type Notifier, type RateLimiter, type Tx } from '../../platform/index.ts';
import type { AnomalySettings } from './anomaly.ts';
import { countsTowardAnomaly, shouldLockForDenials } from './anomaly.ts';
import { effectiveState } from './lifecycle.ts';
import { API_KEY_PERMISSIONS, cidrsAllow, validCidrs } from './policy.ts';
import { subjectForCard } from './sessions.ts';

/** `lak1.<company id>.<key id>.<secret>`. The two ids only say where to look; forging them finds nothing. */
const KEY_RE = /^lak1\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;

export const API_KEY_LIMITS = {
  /** A key must expire: at most this many days after it is made. */
  maxDays: 366,
  /** Live (not revoked, not expired) keys per company. */
  maxPerCompany: 50,
  /** Requests per key per minute. */
  requestsPerMinute: 120,
  /** Questions per key per hour: the default, and the most a key may be given. */
  defaultAsksPerHour: 30,
  maxAsksPerHour: 600,
  /** Refused attempts to USE a key are counted in windows of this length ... */
  failureWindowMinutes: 15,
  /**
   * ... and at this many wrong secrets against one key within a window the Owners are told, ONCE. The key keeps
   * working: its id is not secret (it is in lists, logs and the key itself), so suspending on wrong secrets would let
   * anybody who has seen the id stop somebody else's integration, while a 256-bit secret cannot be guessed anyway.
   */
  wrongSecretsBeforeNotice: 10,
} as const;

export interface ParsedKey { tenantId: string; keyId: string; secret: string }

/** Takes a key apart. Pure. Null for anything that is not shaped like one. */
export function parseApiKey(token: unknown): ParsedKey | null {
  if (typeof token !== 'string' || token.length > 200) return null;
  const m = KEY_RE.exec(token);
  if (!m || !isUuid(m[1]) || !isUuid(m[2])) return null;
  return { tenantId: m[1] as string, keyId: m[2] as string, secret: m[3] as string };
}

export const formatApiKey = (tenantId: string, keyId: string, secret: string): string => `${API_KEY_SCHEME}${tenantId}.${keyId}.${secret}`;

export interface NewKeyRequest {
  name: string;
  scope: string[];
  max_sensitivity: number;
  expires_in_days: number;
  allowed_cidrs?: string[] | null;
  asks_per_hour?: number;
}

export type KeyRequestProblem =
  | 'empty-scope' | 'permission-not-allowed-for-keys' | 'permission-not-held' | 'level-above-own' | 'bad-expiry' | 'bad-networks'
  | 'bad-ask-limit';

/**
 * Is this a key its maker may ask for? Pure. `held` maps each permission the maker's card holds to the highest
 * level it holds it at. A key may name only permissions from the short list AND held by its maker, and no level
 * above the lowest level at which the maker holds any of them (so the key is never above its maker anywhere).
 */
export function keyRequestProblem(req: NewKeyRequest, held: ReadonlyMap<string, number>): KeyRequestProblem | null {
  const scope = [...new Set(req.scope)];
  if (scope.length === 0) return 'empty-scope';
  if (scope.some((p) => !API_KEY_PERMISSIONS.has(p))) return 'permission-not-allowed-for-keys';
  if (scope.some((p) => !held.has(p))) return 'permission-not-held';
  if (!Number.isInteger(req.max_sensitivity) || req.max_sensitivity < 0 || req.max_sensitivity > 3) return 'level-above-own';
  if (scope.some((p) => (held.get(p) as number) < req.max_sensitivity)) return 'level-above-own';
  if (!Number.isInteger(req.expires_in_days) || req.expires_in_days < 1 || req.expires_in_days > API_KEY_LIMITS.maxDays) return 'bad-expiry';
  if (req.allowed_cidrs !== undefined && req.allowed_cidrs !== null && !validCidrs(req.allowed_cidrs)) return 'bad-networks';
  const asks = req.asks_per_hour;
  if (asks !== undefined && (!Number.isInteger(asks) || asks < 1 || asks > API_KEY_LIMITS.maxAsksPerHour)) return 'bad-ask-limit';
  return null;
}

export interface KeyRow {
  id: string;
  name: string;
  created_by_card_id: string;
  secret_hint: string;
  scope: string[];
  max_sensitivity: number;
  asks_per_hour: number;
  allowed_cidrs: string[] | null;
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
  suspended_at: Date | null;
}

const KEY_COLUMNS = `id, name, created_by_card_id, secret_hint, scope, max_sensitivity, asks_per_hour, allowed_cidrs, created_at, expires_at,
                     last_used_at, revoked_at, revoked_reason, suspended_at`;

export type KeyStatus = 'active' | 'expired' | 'revoked' | 'suspended';
export function keyStatus(row: Pick<KeyRow, 'revoked_at' | 'suspended_at' | 'expires_at'>, now: Date): KeyStatus {
  if (row.revoked_at !== null) return 'revoked';
  if (row.suspended_at !== null) return 'suspended';
  return now.getTime() < row.expires_at.getTime() ? 'active' : 'expired';
}

/** What is shown of a key: never the secret, never its hash. */
export function toApiKey(row: KeyRow, now: Date): Record<string, unknown> {
  return {
    id: row.id, name: row.name, created_by_card_id: row.created_by_card_id, secret_hint: row.secret_hint, scope: [...row.scope].sort(),
    max_sensitivity: row.max_sensitivity, asks_per_hour: row.asks_per_hour, allowed_cidrs: row.allowed_cidrs, status: keyStatus(row, now),
    created_at: row.created_at.toISOString(), expires_at: row.expires_at.toISOString(),
    last_used_at: row.last_used_at?.toISOString() ?? null,
    revoked_at: row.revoked_at?.toISOString() ?? null, revoked_reason: row.revoked_reason,
  };
}

/** Why an attempt to use a key was refused before the policy was asked. The caller is told none of this. */
export type KeyRefusal = 'unknown' | 'wrong-secret' | 'revoked' | 'suspended' | 'expired' | 'network' | 'maker-cannot-act';

/**
 * May this stored key be used by this request? Pure. The secret is compared first and always - also when there is
 * no row - so that "no such key" takes as long as "wrong secret", and a caller without the secret learns nothing
 * about the key's state.
 */
export function keyUsable(
  row: (Pick<KeyRow, 'revoked_at' | 'suspended_at' | 'expires_at' | 'allowed_cidrs'> & { secret_hash: Buffer }) | undefined,
  parsed: Pick<ParsedKey, 'secret'>, ctx: Pick<RequestContext, 'now' | 'ip'>,
): 'ok' | Exclude<KeyRefusal, 'maker-cannot-act'> {
  const matches = constantTimeEqual(sha256(parsed.secret), row?.secret_hash ?? Buffer.alloc(32));
  if (row === undefined) return 'unknown';
  if (!matches) return 'wrong-secret';
  const status = keyStatus(row, ctx.now);
  if (status !== 'active') return status;
  if (row.allowed_cidrs !== null && !cidrsAllow(row.allowed_cidrs, ctx.ip)) return 'network';
  return 'ok';
}

/** May the maker's card act at all right now? Pure. (The policy decides the rest - this only keeps the answer "401".) */
export function makerCanAct(maker: CardSubject | null, now: Date): maker is CardSubject {
  if (maker === null || maker.locked || maker.activated_at === null) return false;
  const state = effectiveState({ state: maker.card_state, expires_at: maker.expires_at, grace_until: maker.grace_until }, now);
  return state === 'active' || state === 'expired';
}

/** THE constructor of a key subject: from the stored key and the card that made it. Nothing of the card's rights is copied. */
export function apiKeySubject(
  tenantId: string, row: Pick<KeyRow, 'id' | 'scope' | 'max_sensitivity'>, maker: Pick<CardSubject, 'card_id' | 'person_id'>,
): ApiKeySubject {
  return {
    kind: 'api_key', tenant_id: tenantId, key_id: row.id, scope: [...row.scope], max_sensitivity: row.max_sensitivity,
    acts_for: { card_id: maker.card_id, person_id: maker.person_id },
  };
}

export type ResolvedKey = { subject: ApiKeySubject } | { limited: number } | null;

export class ApiKeyService {
  readonly #rateLimiter: RateLimiter;
  readonly #notifier: Notifier;

  constructor(rateLimiter: RateLimiter, notifier: Notifier) {
    this.#rateLimiter = rateLimiter;
    this.#notifier = notifier;
  }

  /** The company's Owners are told once the fact is committed; where there is no such queue (a job, a test), at once. */
  #tellOwners(ctx: RequestContext, type: 'api_key_created' | 'api_key_stopped' | 'api_key_wrong_secrets', tenantId: string, makerCardId: string): void {
    const send = (): Promise<void> => this.#notifier.notify({ type, tenantId, cardId: makerCardId, audience: 'owners' });
    if (ctx.afterCommit) ctx.afterCommit.push(send);
    else void send().catch(() => undefined);
  }

  async create(tx: Tx, tenantId: string, creatorCardId: string, req: NewKeyRequest, ctx: RequestContext): Promise<{ row: KeyRow; secret: string } | 'too-many-keys'> {
    const now = ctx.now;
    const { rows: live } = await tx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM api_keys WHERE tenant_id = $1 AND revoked_at IS NULL AND expires_at > $2', [tenantId, now]);
    if ((live[0]?.n ?? 0) >= API_KEY_LIMITS.maxPerCompany) return 'too-many-keys';
    const secret = randomToken(32);
    const { rows } = await tx.query<KeyRow>(
      `INSERT INTO api_keys (tenant_id, name, created_by_card_id, secret_hash, secret_hint, scope, max_sensitivity, asks_per_hour, allowed_cidrs, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${KEY_COLUMNS}`,
      [tenantId, req.name, creatorCardId, sha256(secret), secret.slice(-4), [...new Set(req.scope)].sort(), req.max_sensitivity,
        req.asks_per_hour ?? API_KEY_LIMITS.defaultAsksPerHour, req.allowed_cidrs ?? null, now, new Date(now.getTime() + req.expires_in_days * 86_400_000)]);
    this.#tellOwners(ctx, 'api_key_created', tenantId, creatorCardId);
    return { row: rows[0] as KeyRow, secret };
  }

  async list(tx: Tx, tenantId: string, before: string | null, limit: number): Promise<KeyRow[]> {
    const { rows } = await tx.query<KeyRow>(
      `SELECT ${KEY_COLUMNS} FROM api_keys WHERE tenant_id = $1 AND ($2::uuid IS NULL OR id < $2::uuid) ORDER BY id DESC LIMIT $3`,
      [tenantId, before, limit]);
    return rows;
  }

  async get(tx: Tx, tenantId: string, keyId: string): Promise<KeyRow | null> {
    const { rows } = await tx.query<KeyRow>(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE tenant_id = $1 AND id = $2`, [tenantId, keyId]);
    return rows[0] ?? null;
  }

  /** Revoking is final. True if this call revoked it; false if it already was. */
  async revoke(tx: Tx, tenantId: string, keyId: string, byCardId: string, now: Date): Promise<boolean> {
    const { rowCount } = await tx.query(
      `UPDATE api_keys SET revoked_at = $3, revoked_by_card_id = $4, revoked_reason = 'by_owner' WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL`,
      [tenantId, keyId, now, byCardId]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * Who a request with a key is. Null = the key does not work (see KeyRefusal) - the caller answers the same
   * "sign-in required" for every cause. `limited` = it works but has used up its requests (or, for `action`
   * "knowledge:ask", its questions) for now; the question limit is taken here, before the AI service is called.
   */
  async resolve(tx: Tx, token: string, action: string, ctx: RequestContext): Promise<ResolvedKey> {
    const parsed = parseApiKey(token);
    if (parsed === null) return null;
    const { rows } = await tx.query<KeyRow & { secret_hash: Buffer }>(
      `SELECT ${KEY_COLUMNS}, secret_hash FROM api_keys WHERE tenant_id = $1 AND id = $2`, [parsed.tenantId, parsed.keyId]);
    const row = rows[0];
    const verdict = keyUsable(row, parsed, ctx);
    if (row === undefined || verdict === 'unknown') return null;
    if (verdict !== 'ok') {
      await this.#refused(tx, parsed.tenantId, row, verdict, ctx);
      return null;
    }

    const hit = await this.#rateLimiter.hit(`api-key:${row.id}`, API_KEY_LIMITS.requestsPerMinute, 60, ctx.now);
    if (!hit.allowed) return { limited: hit.retryAfterSeconds };
    // the key's own limit on questions: taken here, before the policy and long before the AI service is called
    if (action === 'knowledge:ask') {
      const asks = await this.#rateLimiter.hit(`api-key-asks:${row.id}`, row.asks_per_hour, 3600, ctx.now);
      if (!asks.allowed) return { limited: asks.retryAfterSeconds };
    }

    const maker = await subjectForCard(tx, parsed.tenantId, row.created_by_card_id);
    if (!makerCanAct(maker, ctx.now)) {
      await this.#refused(tx, parsed.tenantId, row, 'maker-cannot-act', ctx);
      return null;
    }
    // once a minute is enough to answer "is this key still in use?", and saves a write on every request
    await tx.query(
      `UPDATE api_keys SET last_used_at = $3 WHERE tenant_id = $1 AND id = $2 AND (last_used_at IS NULL OR last_used_at < $3::timestamptz - interval '1 minute')`,
      [parsed.tenantId, row.id, ctx.now]);
    return { subject: apiKeySubject(parsed.tenantId, row, maker) };
  }

  /**
   * A refused attempt to use an EXISTING key. Always counted on the key's row (one small update); written to the
   * audit log at most once per key, reason and window, so a flood of attempts cannot flood the log. Wrong secrets
   * NEVER stop the key (see API_KEY_LIMITS): at the limit the Owners are told once per window - somebody is
   * guessing, or a broken client keeps sending an old key - and the key goes on working for whoever has the secret.
   */
  async #refused(tx: Tx, tenantId: string, row: Pick<KeyRow, 'id' | 'created_by_card_id'>, reason: Exclude<KeyRefusal, 'unknown'>, ctx: RequestContext): Promise<void> {
    const windowStart = new Date(ctx.now.getTime() - API_KEY_LIMITS.failureWindowMinutes * 60_000);
    const { rows } = await tx.query<{ first_in_window: boolean; wrong_secret_count: number }>(
      `WITH old AS (SELECT failed_window_start, failed_reasons FROM api_keys WHERE tenant_id = $1 AND id = $2 FOR UPDATE)
       UPDATE api_keys k SET
         failed_window_start = CASE WHEN old.failed_window_start IS NULL OR old.failed_window_start <= $4 THEN $3 ELSE old.failed_window_start END,
         failed_count        = CASE WHEN old.failed_window_start IS NULL OR old.failed_window_start <= $4 THEN 1 ELSE k.failed_count + 1 END,
         wrong_secret_count  = CASE WHEN old.failed_window_start IS NULL OR old.failed_window_start <= $4 THEN 0 ELSE k.wrong_secret_count END
                               + CASE WHEN $5::text = 'wrong-secret' THEN 1 ELSE 0 END,
         failed_reasons      = CASE WHEN old.failed_window_start IS NULL OR old.failed_window_start <= $4 THEN ARRAY[$5::text]
                                    WHEN $5::text = ANY (old.failed_reasons) THEN old.failed_reasons
                                    ELSE old.failed_reasons || $5::text END
       FROM old WHERE k.tenant_id = $1 AND k.id = $2
       RETURNING (old.failed_window_start IS NULL OR old.failed_window_start <= $4 OR NOT ($5::text = ANY (old.failed_reasons))) AS first_in_window,
                 k.wrong_secret_count`,
      [tenantId, row.id, ctx.now, windowStart, reason]);
    const counted = rows[0];
    if (counted === undefined) return;
    if (counted.first_in_window) {
      await writeAudit(tx, {
        tenantId, actorKind: 'anonymous', action: 'api_key:use', resourceType: 'api_key', resourceId: row.id, decision: 'deny',
        reasonCode: 'API_KEY_REFUSED', requestId: ctx.requestId, ip: ctx.ip, details: { api_key_id: row.id, reason },
      });
    }
    // exactly AT the limit, so once per window however many more follow (the count starts again with the window)
    if (reason === 'wrong-secret' && counted.wrong_secret_count === API_KEY_LIMITS.wrongSecretsBeforeNotice) {
      await writeAudit(tx, {
        tenantId, actorKind: 'system', action: 'api_key:use', resourceType: 'api_key', resourceId: row.id, decision: 'event',
        reasonCode: 'API_KEY_WRONG_SECRETS', requestId: ctx.requestId, ip: ctx.ip, details: { api_key_id: row.id, count: counted.wrong_secret_count },
      });
      this.#tellOwners(ctx, 'api_key_wrong_secrets', tenantId, row.created_by_card_id);
    }
  }

  /** Suspends the key (final). Writes the audit row and tells the Owners - once, by the call that suspended it. */
  async #suspend(
    tx: Tx, tenantId: string, row: Pick<KeyRow, 'id' | 'created_by_card_id'>, why: 'denials', count: number, ctx: RequestContext,
  ): Promise<boolean> {
    const { rowCount } = await tx.query(
      'UPDATE api_keys SET suspended_at = $3, suspended_reason = $4 WHERE tenant_id = $1 AND id = $2 AND suspended_at IS NULL AND revoked_at IS NULL',
      [tenantId, row.id, ctx.now, why]);
    if ((rowCount ?? 0) === 0) return false;
    await writeAudit(tx, {
      tenantId, actorKind: 'system', action: 'api_key:manage', resourceType: 'api_key', resourceId: row.id, decision: 'event',
      reasonCode: 'API_KEY_SUSPENDED_ANOMALY', requestId: ctx.requestId, ip: ctx.ip,
      details: { api_key_id: row.id, rule: why, count },
    });
    this.#tellOwners(ctx, 'api_key_stopped', tenantId, row.created_by_card_id);
    return true;
  }

  /**
   * The anomaly rule for a KEY: refusals that suggest probing are counted against the key and, at the company's
   * threshold, the key is suspended (only revoking remains). The creator's card is never locked for its key, and
   * nothing is written on that card. True = this call suspended the key.
   */
  async denied(tx: Tx, subject: ApiKeySubject, reasonCode: string, settings: AnomalySettings, ctx: RequestContext): Promise<boolean> {
    if (!countsTowardAnomaly(reasonCode) || !settings.enabled || !settings.denials_enabled) return false;
    const windowStart = new Date(ctx.now.getTime() - settings.denials_window_minutes * 60_000);
    const { rows } = await tx.query<{ denial_count: number }>(
      `UPDATE api_keys SET
         denial_count = CASE WHEN denial_window_start IS NULL OR denial_window_start <= $4 THEN 1 ELSE denial_count + 1 END,
         denial_window_start = CASE WHEN denial_window_start IS NULL OR denial_window_start <= $4 THEN $3 ELSE denial_window_start END
       WHERE tenant_id = $1 AND id = $2 RETURNING denial_count`,
      [subject.tenant_id, subject.key_id, ctx.now, windowStart]);
    const count = rows[0]?.denial_count ?? 0;
    if (!shouldLockForDenials(count, settings)) return false;
    return this.#suspend(tx, subject.tenant_id, { id: subject.key_id, created_by_card_id: subject.acts_for.card_id }, 'denials', count, ctx);
  }
}
