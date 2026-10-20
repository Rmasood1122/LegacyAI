// Webhook endpoints and their deliveries in the database. Every function takes the transaction of its caller;
// no function here calls the network (deliver.ts does, outside any transaction).
import { SealingCipher, type Tx } from '../../platform/index.ts';
import { newSigningSecret } from './signing.ts';
import { TEST_TOPIC, WEBHOOK_LIMITS, type Topic } from './rules.ts';

export interface EndpointRow {
  id: string;
  tenant_id: string;
  name: string;
  url: string;
  topics: string[];
  max_sensitivity: number;
  secret_hint: string | null;
  enabled: boolean;
  paused_at: Date | null;
  paused_reason: string | null;
  consecutive_failures: number;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  created_by_card_id: string;
  created_at: Date;
  updated_at: Date;
  removed_at: Date | null;
}

const ENDPOINT_COLUMNS = `id, tenant_id, name, url, topics, max_sensitivity, secret_hint, enabled, paused_at, paused_reason, consecutive_failures,
  last_success_at, last_failure_at, created_by_card_id, created_at, updated_at, removed_at`;

export type EndpointStatus = 'active' | 'disabled' | 'paused' | 'removed';

export function statusOf(row: Pick<EndpointRow, 'enabled' | 'paused_at' | 'removed_at'>): EndpointStatus {
  if (row.removed_at !== null) return 'removed';
  if (!row.enabled) return 'disabled';
  if (row.paused_at !== null) return 'paused';
  return 'active';
}

/** The endpoint as the API shows it - never its secret (only the last four characters, to tell secrets apart). */
export function toApiEndpoint(row: EndpointRow): Record<string, unknown> {
  return {
    id: row.id, name: row.name, url: row.url, topics: row.topics, max_sensitivity: row.max_sensitivity, status: statusOf(row),
    paused_reason: row.paused_reason, consecutive_failures: row.consecutive_failures, secret_hint: row.secret_hint,
    last_success_at: row.last_success_at?.toISOString() ?? null, last_failure_at: row.last_failure_at?.toISOString() ?? null,
    created_by_card_id: row.created_by_card_id, created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
    removed_at: row.removed_at?.toISOString() ?? null,
  };
}

export interface DeliveryRow {
  id: string;
  endpoint_id: string;
  event_id: string;
  topic: string;
  status: string;
  attempts: number;
  next_attempt_at: Date;
  last_attempt_at: Date | null;
  last_status_code: number | null;
  last_error: string | null;
  delivered_at: Date | null;
  created_at: Date;
}

const DELIVERY_COLUMNS = `id, endpoint_id, event_id, topic, status, attempts, next_attempt_at, last_attempt_at, last_status_code, last_error,
  delivered_at, created_at`;

export function toApiDelivery(row: DeliveryRow): Record<string, unknown> {
  const waiting = row.status === 'pending' || row.status === 'sending';
  return {
    id: row.id, event_id: row.event_id, topic: row.topic, status: row.status, attempts: row.attempts,
    next_attempt_at: waiting ? row.next_attempt_at.toISOString() : null, last_attempt_at: row.last_attempt_at?.toISOString() ?? null,
    last_status_code: row.last_status_code, last_error: row.last_error, delivered_at: row.delivered_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  };
}

export interface NewEndpointRequest {
  name: string;
  url: string;
  topics: Topic[];
  max_sensitivity: number;
}

export interface EndpointChange {
  name?: string;
  topics?: Topic[];
  max_sensitivity?: number;
  enabled?: boolean;
}

/** The secret is encrypted for exactly one endpoint of one company: copied into another row, it does not decrypt. */
export const secretAad = (tenantId: string, endpointId: string): string => `webhook-secret:${tenantId}:${endpointId}`;

export class WebhookStore {
  readonly #cipher: SealingCipher;
  constructor(cipher: SealingCipher) {
    this.#cipher = cipher;
  }

  async list(tx: Tx, tenantId: string, before: string | null, limit: number): Promise<EndpointRow[]> {
    const { rows } = await tx.query<EndpointRow>(
      `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE tenant_id = $1 AND removed_at IS NULL AND ($2::uuid IS NULL OR id < $2)
        ORDER BY id DESC LIMIT $3`, [tenantId, before, limit]);
    return rows;
  }

  /** Any endpoint of the company, removed ones included (removing twice, and the deliveries of a removed endpoint). */
  async get(tx: Tx, tenantId: string, id: string): Promise<EndpointRow | null> {
    const { rows } = await tx.query<EndpointRow>(`SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    return rows[0] ?? null;
  }

  async create(tx: Tx, tenantId: string, cardId: string, req: NewEndpointRequest, now: Date): Promise<{ row: EndpointRow; secret: string } | 'too-many-endpoints'> {
    // one at a time per company, so two requests at once cannot both pass the count
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`webhook-endpoints:${tenantId}`]);
    const { rows: live } = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM webhook_endpoints WHERE tenant_id = $1 AND removed_at IS NULL', [tenantId]);
    if ((live[0]?.n ?? 0) >= WEBHOOK_LIMITS.maxPerCompany) return 'too-many-endpoints';
    const { rows: ids } = await tx.query<{ id: string }>('SELECT uuidv7()::text AS id');
    const id = (ids[0] as { id: string }).id;
    const secret = newSigningSecret();
    const sealed = this.#cipher.encrypt(secret, secretAad(tenantId, id));
    const { rows } = await tx.query<EndpointRow>(
      // created_at is the DATABASE's time, like the time of the outbox events it is compared with (rules.ts endpointGets)
      `INSERT INTO webhook_endpoints (id, tenant_id, name, url, topics, max_sensitivity, secret_enc, secret_key_id, secret_hint, created_by_card_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${ENDPOINT_COLUMNS}`,
      [id, tenantId, req.name, req.url, [...new Set(req.topics)].sort(), req.max_sensitivity, sealed.ciphertext, sealed.keyId, secret.slice(-4), cardId, now]);
    return { row: rows[0] as EndpointRow, secret };
  }

  /** Name, topics, level, on/off. Switching an endpoint on again clears a pause and its count of failures. */
  async update(tx: Tx, tenantId: string, id: string, change: EndpointChange, now: Date): Promise<EndpointRow | null> {
    const { rows } = await tx.query<EndpointRow>(
      `UPDATE webhook_endpoints SET
          name = coalesce($3, name),
          topics = coalesce($4, topics),
          max_sensitivity = coalesce($5, max_sensitivity),
          enabled = coalesce($6, enabled),
          paused_at = CASE WHEN $6 IS TRUE THEN NULL ELSE paused_at END,
          paused_reason = CASE WHEN $6 IS TRUE THEN NULL ELSE paused_reason END,
          consecutive_failures = CASE WHEN $6 IS TRUE THEN 0 ELSE consecutive_failures END,
          updated_at = $7
        WHERE tenant_id = $1 AND id = $2 AND removed_at IS NULL RETURNING ${ENDPOINT_COLUMNS}`,
      [tenantId, id, change.name ?? null, change.topics === undefined ? null : [...new Set(change.topics)].sort(), change.max_sensitivity ?? null,
        change.enabled ?? null, now]);
    return rows[0] ?? null;
  }

  /** Removed for good: switched off, secret wiped, deliveries not yet sent cancelled. False = it was removed already. */
  async remove(tx: Tx, tenantId: string, id: string, cardId: string, now: Date): Promise<boolean> {
    const { rowCount } = await tx.query(
      `UPDATE webhook_endpoints SET removed_at = $3, removed_by_card_id = $4, enabled = false, secret_enc = NULL, secret_key_id = NULL, secret_hint = NULL, updated_at = $3
        WHERE tenant_id = $1 AND id = $2 AND removed_at IS NULL`, [tenantId, id, now, cardId]);
    if (rowCount === 0) return false;
    await tx.query(
      `UPDATE webhook_deliveries SET status = 'cancelled', locked_until = NULL WHERE tenant_id = $1 AND endpoint_id = $2 AND status IN ('pending', 'sending')`,
      [tenantId, id]);
    return true;
  }

  /** A new secret at once; the old one stops being used for the next attempt. Null = no such live endpoint. */
  async rotate(tx: Tx, tenantId: string, id: string, now: Date): Promise<{ row: EndpointRow; secret: string } | null> {
    const secret = newSigningSecret();
    const sealed = this.#cipher.encrypt(secret, secretAad(tenantId, id));
    const { rows } = await tx.query<EndpointRow>(
      `UPDATE webhook_endpoints SET secret_enc = $3, secret_key_id = $4, secret_hint = $5, updated_at = $6
        WHERE tenant_id = $1 AND id = $2 AND removed_at IS NULL RETURNING ${ENDPOINT_COLUMNS}`,
      [tenantId, id, sealed.ciphertext, sealed.keyId, secret.slice(-4), now]);
    const row = rows[0];
    return row === undefined ? null : { row, secret };
  }

  /** A test message, queued like any delivery. Only to an endpoint that is switched on and not paused. */
  async queueTest(tx: Tx, tenantId: string, endpoint: EndpointRow, now: Date): Promise<DeliveryRow> {
    const { rows: ids } = await tx.query<{ id: string }>('SELECT uuidv7()::text AS id');
    const eventId = (ids[0] as { id: string }).id;
    const body = { id: eventId, type: TEST_TOPIC, created_at: now.toISOString(), company_id: tenantId, data: { endpoint_id: endpoint.id } };
    const { rows } = await tx.query<DeliveryRow>(
      `INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, topic, body, next_attempt_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING ${DELIVERY_COLUMNS}`,
      [tenantId, endpoint.id, eventId, TEST_TOPIC, JSON.stringify(body), now]);
    return rows[0] as DeliveryRow;
  }

  async deliveries(tx: Tx, tenantId: string, endpointId: string, before: string | null, limit: number): Promise<DeliveryRow[]> {
    const { rows } = await tx.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries WHERE tenant_id = $1 AND endpoint_id = $2 AND ($3::uuid IS NULL OR id < $3)
        ORDER BY id DESC LIMIT $4`, [tenantId, endpointId, before, limit]);
    return rows;
  }

  /** The signing secret of a live endpoint, or null when it cannot be read (removed, or the key is gone). */
  revealSecret(tenantId: string, endpointId: string, sealed: Buffer | null, keyId: string | null): string | null {
    if (sealed === null || keyId === null) return null;
    return this.#cipher.decrypt(sealed, keyId, secretAad(tenantId, endpointId));
  }
}
