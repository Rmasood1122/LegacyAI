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

const ONE_TIME_SECRET_KEYS = new Set(['sc', 'enrollment_token', 'enrollment_token_expires_at']);

/**
 * Removes one-time secrets before a response is stored for replay. A replayed response
 * therefore never contains an SC or enrollment token; `secret_already_shown` tells the caller.
 */
export function stripOneTimeSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripOneTimeSecrets);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    let stripped = false;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (ONE_TIME_SECRET_KEYS.has(k)) stripped = true;
      else out[k] = stripOneTimeSecrets(v);
    }
    if (stripped || 'secret_already_shown' in out) out.secret_already_shown = true;
    return out;
  }
  return value;
}

export type IdempotencyStart =
  | { kind: 'new' }
  | { kind: 'replay'; status: number; body: unknown };

export interface IdempotencyStore {
  begin(tx: Tx, p: { tenantId: string; actorCardId: string; key: string; operationId: string; requestHash: Buffer; now: Date }): Promise<IdempotencyStart>;
  complete(tx: Tx, p: { tenantId: string; actorCardId: string; key: string; status: number; body: unknown }): Promise<void>;
}

export class PostgresIdempotencyStore implements IdempotencyStore {
  static readonly TTL_HOURS = 24;

  async begin(
    tx: Tx,
    p: { tenantId: string; actorCardId: string; key: string; operationId: string; requestHash: Buffer; now: Date },
  ): Promise<IdempotencyStart> {
    await tx.query('DELETE FROM idempotency_keys WHERE tenant_id = $1 AND actor_card_id = $2 AND key = $3 AND expires_at < $4', [
      p.tenantId, p.actorCardId, p.key, p.now,
    ]);
    const expires = new Date(p.now.getTime() + PostgresIdempotencyStore.TTL_HOURS * 3600_000);
    // If another request holds the same key, this INSERT waits for it to finish, then sees the conflict.
    const inserted = await tx.query(
      `INSERT INTO idempotency_keys (tenant_id, actor_card_id, key, operation_id, request_hash, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'in_progress', $6)
       ON CONFLICT (tenant_id, actor_card_id, key) DO NOTHING RETURNING key`,
      [p.tenantId, p.actorCardId, p.key, p.operationId, p.requestHash, expires],
    );
    if (inserted.rowCount === 1) return { kind: 'new' };

    const { rows } = await tx.query<{
      operation_id: string; request_hash: Buffer; status: string; response_status: number | null; response_body: unknown;
    }>(
      'SELECT operation_id, request_hash, status, response_status, response_body FROM idempotency_keys WHERE tenant_id = $1 AND actor_card_id = $2 AND key = $3',
      [p.tenantId, p.actorCardId, p.key],
    );
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

  async complete(tx: Tx, p: { tenantId: string; actorCardId: string; key: string; status: number; body: unknown }): Promise<void> {
    await tx.query(
      `UPDATE idempotency_keys SET status = 'done', response_status = $4, response_body = $5
        WHERE tenant_id = $1 AND actor_card_id = $2 AND key = $3`,
      [p.tenantId, p.actorCardId, p.key, p.status, JSON.stringify(stripOneTimeSecrets(p.body ?? null))],
    );
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
    | 'card_anomaly' | 'retirement_nudge';
  tenantId: string;
  /** The card the event is about. */
  cardId?: string;
  /** Who is told, when that is someone other than the holder of `cardId` (e.g. the other Owners). */
  recipientCardId?: string;
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
    this.#log.info({ notification: event.type, tenant_id: event.tenantId, card_id: event.cardId, recipient_card_id: event.recipientCardId }, 'notification');
  }
}

export { ProblemError };
