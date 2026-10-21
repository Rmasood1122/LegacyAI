// The delivery job: one run for one company. Three steps, each in its own short transaction, and the network only
// between them:
//   1. fan-out: events in the outbox become one delivery per endpoint that gets them (rules.ts endpointGets) and are
//      marked published - in the same transaction, so an event is turned into deliveries exactly once;
//   2. claim: deliveries that are due are marked 'sending' for a minute (attempt counted), committed;
//   3. send each one (no transaction open), then record what happened. A success clears the endpoint's run of
//      failures; a failure is retried later (rules.ts nextAttemptAt) or given up; an endpoint that keeps failing is
//      paused and the Owners are told.
// A process that dies between 2 and 3 leaves 'sending' rows; after their minute they are claimed again, so a
// receiver can get the same message twice (same webhook-id) - documented, and the reason for the id.
import { writeAudit, type Notifier, type Tx } from '../../platform/index.ts';
import type { WebhookStore } from './endpoints.ts';
import { endpointGets, messageBody, nextAttemptAt, shouldPause, WEBHOOK_LIMITS, type OutboxEvent } from './rules.ts';
import { signedHeaders } from './signing.ts';
import type { SendOutcome, WebhookTransport } from './transport.ts';

const CLAIM_MS = 60_000;
const FAN_OUT_BATCH = 500;

export interface RunResult { published: number; queued: number; delivered: number; failed: number; paused: number }

interface Claimed {
  id: string;
  endpoint_id: string;
  event_id: string;
  body: Record<string, unknown>;
  attempts: number;
  url: string;
  secret_enc: Buffer | null;
  secret_key_id: string | null;
}

export async function fanOut(tx: Tx, tenantId: string, now: Date): Promise<{ published: number; queued: number }> {
  const { rows: events } = await tx.query<OutboxEvent>(
    `SELECT id, tenant_id, topic, payload, created_at FROM outbox_events WHERE tenant_id = $1 AND published_at IS NULL
      ORDER BY created_at, id LIMIT $2 FOR UPDATE SKIP LOCKED`, [tenantId, FAN_OUT_BATCH]);
  if (events.length === 0) return { published: 0, queued: 0 };
  // only endpoints that are switched on and not paused: one that is off or paused does not collect a backlog
  const { rows: endpoints } = await tx.query<{ id: string; topics: string[]; max_sensitivity: number; created_at: Date }>(
    `SELECT id, topics, max_sensitivity, created_at FROM webhook_endpoints
      WHERE tenant_id = $1 AND removed_at IS NULL AND enabled AND paused_at IS NULL`, [tenantId]);
  let queued = 0;
  for (const event of events) {
    for (const endpoint of endpoints) {
      if (!endpointGets(endpoint, event)) continue;
      const res = await tx.query(
        `INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, topic, body, next_attempt_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, endpoint_id, event_id) DO NOTHING`,
        [tenantId, endpoint.id, event.id, event.topic, JSON.stringify(messageBody(event)), now]);
      queued += res.rowCount;
    }
  }
  await tx.query('UPDATE outbox_events SET published_at = $3 WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [tenantId, events.map((e) => e.id), now]);
  return { published: events.length, queued };
}

async function claim(tx: Tx, tenantId: string, now: Date, limit: number): Promise<Claimed[]> {
  // an attempt that was claimed and never recorded (the sender died) counts as made; at the last one, give up
  await tx.query(
    `UPDATE webhook_deliveries SET status = 'failed', locked_until = NULL, last_error = coalesce(last_error, 'timeout')
      WHERE tenant_id = $1 AND status = 'sending' AND locked_until <= $2 AND attempts >= $3`, [tenantId, now, WEBHOOK_LIMITS.maxAttempts]);
  const { rows } = await tx.query<Claimed>(
    `UPDATE webhook_deliveries d SET status = 'sending', locked_until = $2::timestamptz + make_interval(secs => $4::int / 1000),
            attempts = d.attempts + 1, last_attempt_at = $2
       FROM webhook_endpoints e
      WHERE d.id IN (SELECT x.id FROM webhook_deliveries x
                       JOIN webhook_endpoints y ON y.tenant_id = x.tenant_id AND y.id = x.endpoint_id
                      WHERE x.tenant_id = $1 AND y.removed_at IS NULL AND y.enabled AND y.paused_at IS NULL
                        AND ((x.status = 'pending' AND x.next_attempt_at <= $2) OR (x.status = 'sending' AND x.locked_until <= $2))
                      ORDER BY x.next_attempt_at, x.id LIMIT $3 FOR UPDATE OF x SKIP LOCKED)
        AND e.tenant_id = d.tenant_id AND e.id = d.endpoint_id
    RETURNING d.id, d.endpoint_id, d.event_id, d.body, d.attempts, e.url, e.secret_enc, e.secret_key_id`,
    [tenantId, now, limit, CLAIM_MS]);
  return rows;
}

export interface DeliveryDeps {
  store: WebhookStore;
  transport: WebhookTransport;
  notifier: Notifier;
  withTx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

/** Records the outcome of one attempt. Ignored when the delivery was claimed again meanwhile (its attempt count moved on). */
async function record(tx: Tx, tenantId: string, d: Claimed, outcome: SendOutcome | { ok: false; error: 'secret_unreadable' }, now: Date): Promise<'delivered' | 'failed' | 'stale' | 'paused'> {
  if (outcome.ok) {
    const { rowCount } = await tx.query(
      `UPDATE webhook_deliveries SET status = 'delivered', delivered_at = $3, locked_until = NULL, last_status_code = $4, last_error = NULL
        WHERE tenant_id = $1 AND id = $2 AND status = 'sending' AND attempts = $5`, [tenantId, d.id, now, outcome.status, d.attempts]);
    if (rowCount === 0) return 'stale';
    await tx.query(
      'UPDATE webhook_endpoints SET consecutive_failures = 0, last_success_at = $3 WHERE tenant_id = $1 AND id = $2 AND removed_at IS NULL',
      [tenantId, d.endpoint_id, now]);
    return 'delivered';
  }
  const retryAt = nextAttemptAt(d.attempts, now);
  const status = 'status' in outcome && outcome.status !== undefined ? outcome.status : null;
  const { rowCount } = await tx.query(
    `UPDATE webhook_deliveries SET status = $3, next_attempt_at = coalesce($4, next_attempt_at), locked_until = NULL, last_status_code = $5, last_error = $6
      WHERE tenant_id = $1 AND id = $2 AND status = 'sending' AND attempts = $7`,
    [tenantId, d.id, retryAt === null ? 'failed' : 'pending', retryAt, status, outcome.error, d.attempts]);
  if (rowCount === 0) return 'stale';
  const { rows } = await tx.query<{ consecutive_failures: number; last_success_at: Date | null; created_at: Date; paused_at: Date | null; created_by_card_id: string }>(
    `UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1, last_failure_at = $3
      WHERE tenant_id = $1 AND id = $2 AND removed_at IS NULL
      RETURNING consecutive_failures, last_success_at, created_at, paused_at, created_by_card_id`, [tenantId, d.endpoint_id, now]);
  const endpoint = rows[0];
  if (endpoint === undefined || endpoint.paused_at !== null) return 'failed';
  if (!shouldPause({ consecutiveFailures: endpoint.consecutive_failures, lastSuccessAt: endpoint.last_success_at, createdAt: endpoint.created_at, now })) return 'failed';
  await tx.query(`UPDATE webhook_endpoints SET paused_at = $3, paused_reason = 'failing' WHERE tenant_id = $1 AND id = $2`, [tenantId, d.endpoint_id, now]);
  await writeAudit(tx, {
    tenantId, actorKind: 'system', action: 'webhook:manage', resourceType: 'webhook_endpoint', resourceId: d.endpoint_id, decision: 'event',
    reasonCode: 'WEBHOOK_PAUSED', details: { webhook_id: d.endpoint_id, count: endpoint.consecutive_failures },
  });
  return 'paused';
}

/** One run for one company. Never throws for a failed delivery; a database error stops this company's run only. */
export async function runCompany(deps: DeliveryDeps, tenantId: string, now: () => Date): Promise<RunResult> {
  const result: RunResult = { published: 0, queued: 0, delivered: 0, failed: 0, paused: 0 };
  const fanned = await deps.withTx((tx) => fanOut(tx, tenantId, now()));
  result.published = fanned.published;
  result.queued = fanned.queued;
  const claimed = await deps.withTx((tx) => claim(tx, tenantId, now(), WEBHOOK_LIMITS.perCompanyPerRun));
  // once per run: with the company's own key (D35) switched off, every delivery fails as "secret_unreadable"
  const sealer = claimed.length === 0 ? null : await deps.withTx((tx) => deps.store.sealerFor(tx, tenantId));
  for (const d of claimed) {
    const secret = sealer === null ? null : deps.store.revealSecret(sealer, tenantId, d.endpoint_id, d.secret_enc, d.secret_key_id);
    const body = JSON.stringify(d.body);
    const outcome = secret === null
      ? { ok: false as const, error: 'secret_unreadable' as const }
      : await deps.transport.send({ url: d.url, headers: { ...signedHeaders(secret, d.event_id, now(), body) }, body });
    const done = await deps.withTx((tx) => record(tx, tenantId, d, outcome, now()));
    if (done === 'delivered') result.delivered += 1;
    if (done === 'failed' || done === 'paused') result.failed += 1;
    if (done === 'paused') {
      result.paused += 1;
      await deps.notifier.notify({ type: 'webhook_paused', tenantId, audience: 'owners' }).catch(() => undefined);
    }
  }
  return result;
}
