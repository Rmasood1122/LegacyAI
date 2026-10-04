// Housekeeping: the things that have to be written down or cleaned up as time passes. One command, four jobs:
//   1. cards whose expires_at has passed are RECORDED as expired (state -> expired, usage-history event, audit
//      row) and renewal notices go out. Enforcement never depends on this: the API treats a card as expired the
//      moment the clock passes expires_at.
//   2. retirement radar: the nudges that have become due are created, each once, and leaving dates that passed
//      more than 30 days ago are removed. The radar screen never depends on this: it computes the stage from
//      the date when it is read. WITHOUT THIS COMMAND NO NUDGE IS EVER CREATED after the day a date was set.
//   3. billing: renewal reminders and the automatic renewal attempt (docs/phase4/05-billing.md). WITHOUT THIS
//      COMMAND NO REMINDER IS CREATED AND NOTHING RENEWS BY ITSELF.
//   4. rows that otherwise only grow (ended sessions, used tokens, old rate-limit windows) are removed.
// Nothing schedules this command yet (docs/runbooks/housekeeping.md): someone has to run it.
//
//   npm run housekeeping        (npm run cards:sweep-expired is the old name of the same command)
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

/**
 * Retirement radar: creates the nudges that have become due (24, 12 and 6 months before a recorded leaving date),
 * each once, for every company. The radar screen itself never depends on this job: it computes the stage from the
 * date when it is read. This only writes the nudge down and tells the people who look after knowledge capture.
 */
export async function sweepRetirementNudges(app: App, now: Date): Promise<number> {
  const tenants = await app.db.withTenantTx(PLATFORM_TENANT_ID, (tx) => listTenants(tx, 10_000, null), { platformScope: true });
  let created = 0;
  for (const tenant of tenants) {
    created += await app.db.withTenantTx(tenant.id, (tx) => app.identity.retirementSweep(tx, tenant.id, now, `sweep-${now.toISOString()}`));
  }
  return created;
}

/**
 * Billing: for every customer company, close invoices nobody answered, create the renewal reminders (each once per
 * renewal date and stage) and try the automatic renewal. WITHOUT THIS COMMAND none of that happens. Every company
 * and every step runs by itself: a failure is printed with the company and the reason, counted, and makes the
 * command end with a non-zero exit code - it does not stop the others.
 */
export async function sweepBilling(app: App, now: Date): Promise<{ notices: number; attempts: number; closed: number; finished: number; failed: number; failures: string[] }> {
  const ctx = { requestId: `sweep-${now.toISOString()}`, ip: '', userAgent: '', now, fetchSite: null };
  const tenants = await app.db.withTenantTx(PLATFORM_TENANT_ID, (tx) => listTenants(tx, 10_000, null), { platformScope: true });
  const total = { notices: 0, attempts: 0, closed: 0, finished: 0, failed: 0, failures: [] as string[] };
  for (const tenant of tenants) {
    if (tenant.is_platform) continue;
    const done = await app.billing.sweepCompany(tenant.id, tenant.plan_code, ctx);
    total.notices += done.notices;
    total.attempts += done.attempts;
    total.closed += done.closed;
    total.finished += done.finished;
    for (const failure of done.failures) {
      total.failed += 1;
      // the company's id and what went wrong; never more than the first 20, so one broken night stays readable
      if (total.failures.length < 20) total.failures.push(`${tenant.id}: ${failure.slice(0, 200)}`);
      app.log.error({ tenant_id: tenant.id, job: 'billing', reason: failure.slice(0, 200) }, 'housekeeping: a billing step failed');
    }
  }
  if (total.failed > 0) process.exitCode = 1;
  return total;
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

/** Everything, once, with ONE "now". A job that fails is reported and does not stop the others. */
export async function runHousekeeping(app: App, now: Date): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {};
  const jobs: Array<[string, () => Promise<unknown>]> = [
    ['swept', () => sweepExpiredCards(app, now)],
    ['retirement_nudges', () => sweepRetirementNudges(app, now)],
    ['billing', () => sweepBilling(app, now)],
    ['purged', () => purgeOldRows(app, now)],
  ];
  for (const [name, job] of jobs) {
    try {
      report[name] = await job();
    } catch (err) {
      report[name] = { failed: err instanceof Error ? err.message.slice(0, 200) : 'unknown error' };
      process.exitCode = 1;
    }
  }
  return report;
}

/** True when this file (or its old name, which re-exports it) is what was started. */
export const startedAs = (...files: string[]): boolean => files.some((f) => process.argv[1] === fileURLToPath(f));

if (startedAs(import.meta.url)) {
  const app = await createApp(loadConfig(process.env));
  try {
    console.log(JSON.stringify(await runHousekeeping(app, new Date())));
  } finally {
    await app.close();
  }
}
