// Rate limiter, idempotency keys and notifications. Each sits behind an interface so the
// PostgreSQL implementation can be swapped (e.g. for Redis) without touching callers.
import { hmacSha256, sha256 } from '../../../shared/crypto.ts';
import { ProblemError, problems } from '../../../shared/errors.ts';
import type { Database, Tx } from './db.ts';
import type { Logger } from './logger.ts';

// ------------------------------------------------------------------ rate limiter

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Counts one hit against `key` in the current fixed window and says whether it is within `limit`. */
  hit(key: string, limit: number, windowSeconds: number, now: Date): Promise<RateLimitResult>;
}

export class PostgresRateLimiter implements RateLimiter {
  readonly #db: Database;
  readonly #key: Buffer;

  constructor(db: Database, hmacKey: Buffer) {
    this.#db = db;
    this.#key = hmacKey;
  }

  async hit(key: string, limit: number, windowSeconds: number, now: Date): Promise<RateLimitResult> {
    if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
      // A nonsense limit must never mean "unlimited".
      return { allowed: false, retryAfterSeconds: 60 };
    }
    const windowMs = windowSeconds * 1000;
    const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
    const bucket = hmacSha256(this.#key, `${windowSeconds}:${key}`);
    const { rows } = await this.#db.global<{ count: number }>(
      `INSERT INTO rate_limit_buckets (bucket_key, window_start, count) VALUES ($1, $2, 1)
       ON CONFLICT (bucket_key, window_start) DO UPDATE SET count = rate_limit_buckets.count + 1
       RETURNING count`,
      [bucket, windowStart],
    );
    const count = rows[0]?.count;
    if (typeof count !== 'number') return { allowed: false, retryAfterSeconds: windowSeconds };
    const retryAfterSeconds = Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000);
    return { allowed: count <= limit, retryAfterSeconds };
  }

  async purge(olderThan: Date): Promise<number> {
    const res = await this.#db.global('DELETE FROM rate_limit_buckets WHERE window_start < $1', [olderThan]);
    return res.rowCount;
  }
}

// ---------------------------------------------------------------- idempotency keys

/**
 * Removes one-time secrets before a response is stored for replay. WHICH fields those are is said by the operation's
 * contract (`x-one-time-secrets`), not known here. A replayed response therefore never contains them;
 * `secret_already_shown` tells the caller.
 */
export function stripOneTimeSecrets(value: unknown, secretFields: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => stripOneTimeSecrets(v, secretFields));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    let stripped = false;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (secretFields.includes(k)) stripped = true;
      else out[k] = stripOneTimeSecrets(v, secretFields);
    }
    if (stripped || 'secret_already_shown' in out) out.secret_already_shown = true;
    return out;
  }
  return value;
}

export type IdempotencyStart =
  | { kind: 'new' }
  | { kind: 'replay'; status: number; body: unknown };

/**
 * Whose records these are: a card's, or an API key's. All this file knows about a key is that it is not a card:
 * the two are stored in different columns, each with its own foreign key, so a key never shares records with the
 * card that made it or with another key.
 */
export type IdempotencyActor = { kind: 'card'; id: string } | { kind: 'api_key'; id: string };

export interface IdempotencyStore {
  begin(tx: Tx, p: { tenantId: string; actor: IdempotencyActor; key: string; operationId: string; requestHash: Buffer; now: Date }): Promise<IdempotencyStart>;
  complete(tx: Tx, p: { tenantId: string; actor: IdempotencyActor; key: string; status: number; body: unknown; secretFields: readonly string[] }): Promise<void>;
  /** Frees a key whose work did not complete, so the caller can try again. */
  release(tx: Tx, p: { tenantId: string; actor: IdempotencyActor; key: string }): Promise<void>;
}

// The statements exist once per actor column. They are written out in full (not built from a column name), because
// "no SQL built from pieces" is one of the lint rules this project proves in CI.
const STATEMENTS = {
  card: {
    purge: 'DELETE FROM idempotency_keys WHERE tenant_id = $1 AND actor_card_id = $2 AND key = $3 AND expires_at < $4',
    insert: `INSERT INTO idempotency_keys (tenant_id, actor_card_id, key, operation_id, request_hash, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'in_progress', $6)
       ON CONFLICT (tenant_id, actor_card_id, key) WHERE actor_card_id IS NOT NULL DO NOTHING RETURNING key`,
    read: 'SELECT operation_id, request_hash, status, response_status, response_body FROM idempotency_keys WHERE tenant_id = $1 AND actor_card_id = $2 AND key = $3',
    release: 'DELETE FROM idempotency_keys WHERE tenant_id = $1 AND actor_card_id = $2 AND key = $3 AND status = $4',
    complete: `UPDATE idempotency_keys SET status = 'done', response_status = $4, response_body = $5
        WHERE tenant_id = $1 AND actor_card_id = $2 AND key = $3`,
  },
  api_key: {
    purge: 'DELETE FROM idempotency_keys WHERE tenant_id = $1 AND actor_api_key_id = $2 AND key = $3 AND expires_at < $4',
    insert: `INSERT INTO idempotency_keys (tenant_id, actor_api_key_id, key, operation_id, request_hash, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'in_progress', $6)
       ON CONFLICT (tenant_id, actor_api_key_id, key) WHERE actor_api_key_id IS NOT NULL DO NOTHING RETURNING key`,
    read: 'SELECT operation_id, request_hash, status, response_status, response_body FROM idempotency_keys WHERE tenant_id = $1 AND actor_api_key_id = $2 AND key = $3',
    release: 'DELETE FROM idempotency_keys WHERE tenant_id = $1 AND actor_api_key_id = $2 AND key = $3 AND status = $4',
    complete: `UPDATE idempotency_keys SET status = 'done', response_status = $4, response_body = $5
        WHERE tenant_id = $1 AND actor_api_key_id = $2 AND key = $3`,
  },
} as const;

export class PostgresIdempotencyStore implements IdempotencyStore {
  static readonly TTL_HOURS = 24;

  async begin(
    tx: Tx,
    p: { tenantId: string; actor: IdempotencyActor; key: string; operationId: string; requestHash: Buffer; now: Date },
  ): Promise<IdempotencyStart> {
    const sql = STATEMENTS[p.actor.kind];
    await tx.query(sql.purge, [p.tenantId, p.actor.id, p.key, p.now]);
    const expires = new Date(p.now.getTime() + PostgresIdempotencyStore.TTL_HOURS * 3600_000);
    // If another request holds the same key, this INSERT waits for it to finish, then sees the conflict.
    const inserted = await tx.query(sql.insert, [p.tenantId, p.actor.id, p.key, p.operationId, p.requestHash, expires]);
    if (inserted.rowCount === 1) return { kind: 'new' };

    const { rows } = await tx.query<{
      operation_id: string; request_hash: Buffer; status: string; response_status: number | null; response_body: unknown;
    }>(sql.read, [p.tenantId, p.actor.id, p.key]);
    const row = rows[0];
    if (!row) throw problems.conflict('idempotency-key-busy', 'This idempotency key is being processed; retry shortly');
    if (row.operation_id !== p.operationId || !row.request_hash.equals(p.requestHash)) {
      throw problems.conflict('idempotency-key-reuse', 'This idempotency key was already used with a different request');
    }
    if (row.status !== 'done' || row.response_status === null) {
      throw problems.conflict('idempotency-key-busy', 'This idempotency key is being processed; retry shortly');
    }
    return { kind: 'replay', status: row.response_status, body: row.response_body };
  }

  async release(tx: Tx, p: { tenantId: string; actor: IdempotencyActor; key: string }): Promise<void> {
    await tx.query(STATEMENTS[p.actor.kind].release, [p.tenantId, p.actor.id, p.key, 'in_progress']);
  }

  async complete(tx: Tx, p: { tenantId: string; actor: IdempotencyActor; key: string; status: number; body: unknown; secretFields: readonly string[] }): Promise<void> {
    await tx.query(STATEMENTS[p.actor.kind].complete,
      [p.tenantId, p.actor.id, p.key, p.status, JSON.stringify(stripOneTimeSecrets(p.body ?? null, p.secretFields))]);
  }
}

export function hashRequest(operationId: string, params: unknown, body: unknown): Buffer {
  return sha256(JSON.stringify([operationId, params ?? null, body ?? null]));
}

// ------------------------------------------------------------------ notifications

export interface NotificationEvent {
  type:
    | 'card_issued' | 'card_locked' | 'card_unlocked' | 'card_suspended' | 'card_revoked' | 'card_renewed'
    | 'card_replaced' | 'card_expiring' | 'unlock_capacity_low' | 'credential_added' | 'enrollment_token_issued'
    | 'tenant_created' | 'company_card_renewed' | 'owner_recovered'
    // Phase 4: an anomaly rule fired on the last usable Owner card (which is not locked); a leaving date came closer
    | 'card_anomaly' | 'retirement_nudge'
    // Phase 4, billing: the renewal date comes closer; a payment failed; the term was renewed
    | 'renewal_reminder' | 'payment_failed' | 'subscription_renewed'
    // a payment is on record that changed nothing by itself (late, repeated, unknown invoice, could not be applied)
    | 'payment_needs_attention'
    // an API key was made; a key was stopped by the system (suspended, or revoked because its maker's card changed)
    | 'api_key_created' | 'api_key_stopped'
    // many wrong secrets were tried against one key (the key keeps working; the Owners should know)
    | 'api_key_wrong_secrets';
  tenantId: string;
  /** When the notice goes to the platform operator: the company it is about. */
  aboutTenantId?: string;
  /** The card the event is about. */
  cardId?: string;
  /** Who is told, when that is someone other than the holder of `cardId` (e.g. the other Owners). */
  recipientCardId?: string;
  /** Who is told, when that is a group and not one cardholder: the company's Owners. */
  audience?: 'owners';
}

export interface Notifier {
  notify(event: NotificationEvent): Promise<void>;
}

/** Phase 1 implementation: writes a structured log line. An email provider replaces this later. */
export class LogNotifier implements Notifier {
  readonly #log: Logger;
  constructor(log: Logger) {
    this.#log = log;
  }
  async notify(event: NotificationEvent): Promise<void> {
    this.#log.info({
      notification: event.type, tenant_id: event.tenantId, card_id: event.cardId, recipient_card_id: event.recipientCardId,
      about_tenant_id: event.aboutTenantId, audience: event.audience,
    }, 'notification');
  }
}

export { ProblemError };
