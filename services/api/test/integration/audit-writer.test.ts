// Phase 2: one path into the audit log for both services - the database function audit_write().
// The allow-list of detail keys is enforced in the database; the Python service's login can only
// record 'service' events; the chain stays verifiable whoever writes.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALLOWED_DETAIL_KEYS, verifyChain, writeAudit } from '../../src/modules/platform/index.ts';
import { DB_URLS } from '../helpers/env.ts';
import { appRoleClient, createTenant, startApp, superuser, type TestApp, type TestTenant } from '../helpers/harness.ts';

let t: TestApp;
let su: pg.Client;
let tenant: TestTenant;
beforeAll(async () => {
  t = await startApp();
  su = await superuser();
  tenant = await createTenant(t, 'audit-writer');
});
afterAll(async () => {
  await su.end();
  await t.close();
});

/** Runs fn as the given login inside one transaction with the tenant set, then rolls back (or commits). */
async function as<T>(url: string, tenantId: string, fn: (c: pg.Client) => Promise<T>, commit = false): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await fn(c);
    await c.query(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
}

const write = (c: pg.Client, tenantId: string, over: { kind?: string; decision?: string; details?: string; card?: string | null } = {}) =>
  c.query('SELECT audit_write($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)', [
    tenantId, over.card ?? null, over.kind ?? 'system', 'test:write', 'thing', 'x', over.decision ?? 'event', 'TEST', 'req-1', null,
    over.details ?? '{}',
  ]);

describe('audit_write()', () => {
  it('the TypeScript allow-list and the database allow-list are the same list', async () => {
    const { rows } = await su.query('SELECT key FROM audit_detail_keys ORDER BY key');
    expect(rows.map((r) => r.key)).toEqual([...ALLOWED_DETAIL_KEYS].sort());
  });

  it('the API writes through it, and the chain still verifies', async () => {
    await t.app.db.withTenantTx(tenant.tenantId, (tx) => writeAudit(tx, {
      tenantId: tenant.tenantId, actorKind: 'system', action: 'test:via_api', decision: 'event', reasonCode: 'TEST', details: { count: 3 },
    }));
    const result = await t.app.db.withTenantTx(tenant.tenantId, (tx) => verifyChain(tx, tenant.tenantId));
    expect(result).toMatchObject({ ok: true, complete: true });
  });

  it.each([
    ['an unknown detail key', '{"secret_code":"123"}', /not on the allow-list/],
    ['a nested value', '{"count":{"a":1}}', /plain value/],
    ['something that looks like a card number', '{"reason":"card 1234567890123456"}', /card number/],
    ['a value over 200 characters', `{"reason":"${'x'.repeat(201)}"}`, /too long/],
    ['a JSON array instead of an object', '[1,2]', /JSON object/],
    ['text that is not JSON', 'not json', /not valid JSON/],
  ])('refuses %s - enforced by the database, not only by our code', async (_name, details, message) => {
    await expect(as(DB_URLS.app, tenant.tenantId, (c) => write(c, tenant.tenantId, { details }))).rejects.toThrow(message);
  });

  it('refuses a row for another tenant than the one the transaction works for', async () => {
    const other = await createTenant(t, 'audit-writer-b');
    await expect(as(DB_URLS.app, tenant.tenantId, (c) => write(c, other.tenantId))).rejects.toMatchObject({ code: '42501' });
  });

  it('the Python service login: rows become "service" events; it cannot record decisions, insert directly or read the log', async () => {
    const before = (await su.query('SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1', [tenant.tenantId])).rows[0].n;
    await as(DB_URLS.ai, tenant.tenantId, (c) => write(c, tenant.tenantId, { kind: 'card', card: tenant.ownerCard.id, details: '{"count":1}' }), true);
    const row = (await su.query(
      `SELECT actor_kind, actor_card_id, decision FROM audit_log WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1`, [tenant.tenantId])).rows[0];
    expect(row).toEqual({ actor_kind: 'service', actor_card_id: tenant.ownerCard.id, decision: 'event' });
    expect((await su.query('SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1', [tenant.tenantId])).rows[0].n).toBe(before + 1);

    await expect(as(DB_URLS.ai, tenant.tenantId, (c) => write(c, tenant.tenantId, { decision: 'allow' }))).rejects.toThrow(/only record events/);
    await expect(as(DB_URLS.ai, tenant.tenantId, (c) => c.query('SELECT 1 FROM audit_log LIMIT 1'))).rejects.toMatchObject({ code: '42501' });
    await expect(as(DB_URLS.ai, tenant.tenantId, (c) => c.query(
      `INSERT INTO audit_log (tenant_id, seq, occurred_at, actor_kind, action, decision, reason_code, prev_hash, row_hash)
       VALUES ($1, 1, now(), 'card', 'x:y', 'allow', 'FORGED', ''::bytea, ''::bytea)`, [tenant.tenantId]))).rejects.toMatchObject({ code: '42501' });
    await expect(as(DB_URLS.ai, tenant.tenantId, (c) => c.query('DELETE FROM audit_log'))).rejects.toMatchObject({ code: '42501' });

    // and the chain - now containing a row written by the second service - still verifies
    const result = await t.app.db.withTenantTx(tenant.tenantId, (tx) => verifyChain(tx, tenant.tenantId));
    expect(result).toMatchObject({ ok: true, complete: true });
  });

  it('the Python service login exists, cannot bypass row-level security and has no access to sign-in data', async () => {
    const role = (await su.query(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'legacyai_ai'`)).rows[0];
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
    for (const table of ['cards', 'card_secrets', 'credentials', 'sessions', 'enrollment_tokens', 'card_directory', 'tenants', 'people']) {
      await expect(as(DB_URLS.ai, tenant.tenantId, (c) => c.query(`SELECT 1 FROM ${table} LIMIT 1`)), table).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('the app login still cannot change or delete audit rows', async () => {
    const app = await appRoleClient();
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.tenantId]);
      await expect(app.query(`UPDATE audit_log SET reason_code = 'X'`)).rejects.toMatchObject({ code: '42501' });
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
  });
});
