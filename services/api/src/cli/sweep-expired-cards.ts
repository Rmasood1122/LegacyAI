// Records expiry for cards whose expires_at has passed (state -> expired, usage-history
// event, audit row). ENFORCEMENT NEVER DEPENDS ON THIS JOB: the API treats a card as expired
// the moment the clock passes expires_at. This only writes it down, and sends renewal notices.
//
//   npm run cards:sweep-expired
import { fileURLToPath } from 'node:url';
import { createApp, type App } from '../app.ts';
import type { CardRow } from '../modules/identity-access/internal/cards.ts';
import { listTenants, loadConfig, PLATFORM_TENANT_ID } from '../modules/platform/index.ts';

export async function sweepExpiredCards(app: App, now: Date): Promise<number> {
  const ctx = { requestId: `sweep-${now.toISOString()}`, ip: '', userAgent: '', now };
  const tenants = await app.db.withTenantTx(PLATFORM_TENANT_ID, (tx) => listTenants(tx, 10_000, null), { platformScope: true });
  let swept = 0;
  for (const tenant of tenants) {
    swept += await app.db.withTenantTx(tenant.id, async (tx) => {
      const { rows } = await tx.query<CardRow>(
        `SELECT id, tenant_id, kind, person_id, card_number, state, issued_at, activated_at, expires_at, grace_until, renewal_due,
                renewal_count, replaced_by_card_id, replaces_card_id
           FROM cards WHERE state IN ('active', 'issued') AND expires_at <= $1 FOR UPDATE`, [now]);
      for (const card of rows) await app.identity.cards.materializeExpiry(tx, card, ctx);
      return rows.length;
    });
  }
  return swept;
}

const DAY_MS = 86_400_000;

/**
 * Housekeeping for tables that otherwise only grow: sessions that ended more than 30 days ago,
 * spent or expired enrollment tokens, expired idempotency keys and login transactions, old
 * rate-limit windows, and login attempts older than 90 days. The audit log and the card usage
 * history are never touched.
 */
export async function purgeOldRows(app: App, now: Date): Promise<{ sessions: number; enrollment_tokens: number; idempotency_keys: number; global: number }> {
  const cutoff = new Date(now.getTime() - 30 * DAY_MS);
  const removed = { sessions: 0, enrollment_tokens: 0, idempotency_keys: 0, global: 0 };
  const tenants = await app.db.withTenantTx(PLATFORM_TENANT_ID, (tx) => listTenants(tx, 100_000, null), { platformScope: true });
  for (const tenant of tenants) {
    await app.db.withTenantTx(tenant.id, async (tx) => {
      removed.sessions += (await tx.query(
        'DELETE FROM sessions WHERE tenant_id = $1 AND (revoked_at < $2 OR absolute_expires_at < $2)', [tenant.id, cutoff])).rowCount;
      removed.enrollment_tokens += (await tx.query(
        'DELETE FROM enrollment_tokens WHERE tenant_id = $1 AND (used_at < $2 OR expires_at < $2)', [tenant.id, cutoff])).rowCount;
      removed.idempotency_keys += (await tx.query(
        'DELETE FROM idempotency_keys WHERE tenant_id = $1 AND expires_at < $2', [tenant.id, now])).rowCount;
    });
  }
  removed.global += (await app.db.global('DELETE FROM auth_transactions WHERE expires_at < $1', [new Date(now.getTime() - DAY_MS)])).rowCount;
  removed.global += (await app.db.global('DELETE FROM rate_limit_buckets WHERE window_start < $1', [new Date(now.getTime() - 2 * DAY_MS)])).rowCount;
  // login_attempts is write-only for the app; this database function deletes rows older than the given number of days.
  const purged = await app.db.global<{ n: string }>('SELECT purge_login_attempts(90)::text AS n');
  removed.global += Number(purged.rows[0]?.n ?? 0);
  return removed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await createApp(loadConfig(process.env));
  try {
    const n = await sweepExpiredCards(app, new Date());
    console.log(JSON.stringify({ swept: n, purged: await purgeOldRows(app, new Date()) }));
  } finally {
    await app.close();
  }
}
