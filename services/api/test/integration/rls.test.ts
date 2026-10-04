// Tenant isolation is enforced by PostgreSQL itself. These tests connect with the REAL
// application role and try to cross the tenant boundary directly in SQL. Every attempt must fail.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { loadConfig, UnsafeDatabaseRoleError } from '../../src/modules/platform/index.ts';
import { DB_URLS, testEnv } from '../helpers/env.ts';
import { appRoleClient, createTenant, startApp, superuser, type TestApp, type TestTenant } from '../helpers/harness.ts';

let t: TestApp;
let a: TestTenant;
let b: TestTenant;
let app: pg.Client;
let su: pg.Client;

beforeAll(async () => {
  t = await startApp();
  a = await createTenant(t, 'rls-a');
  b = await createTenant(t, 'rls-b');
  app = await appRoleClient();
  su = await superuser();
});
afterAll(async () => {
  await app.end();
  await su.end();
  await t.close();
});

/** Runs statements as the app role inside one transaction with the given tenant set, then rolls back. */
async function asTenant<T>(tenantId: string | null, fn: () => Promise<T>): Promise<T> {
  await app.query('BEGIN');
  try {
    if (tenantId !== null) await app.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    return await fn();
  } finally {
    await app.query('ROLLBACK');
  }
}

const GLOBAL_TABLES = [
  'ai_global', 'ai_plan_defaults', 'audit_detail_keys', 'auth_transactions', 'card_directory', 'login_attempts',
  'permissions', 'plan_limits', 'rate_limit_buckets', 'role_permissions', 'roles', 'schema_migrations',
  'tenant_usage_counters',
];

describe('the application database role', () => {
  it('is not a superuser and cannot bypass row-level security', async () => {
    const { rows } = await app.query('SELECT current_user, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user');
    expect(rows[0]).toEqual({ current_user: 'legacyai_app', rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
  });

  it('the API refuses to start when given a superuser connection', async () => {
    await expect(createApp(loadConfig(testEnv({ DATABASE_URL: DB_URLS.superuser })))).rejects.toBeInstanceOf(UnsafeDatabaseRoleError);
  });

  it('the API refuses to start when given a role that can bypass row-level security', async () => {
    await expect(createApp(loadConfig(testEnv({ DATABASE_URL: DB_URLS.backup })))).rejects.toThrow(/bypass row-level security/);
  });
});

describe('every tenant table has forced row-level security', () => {
  it('no table with a tenant_id column is missing it (catalogue check)', async () => {
    const { rows } = await su.query<{ table: string; enabled: boolean; forced: boolean; policies: number }>(
      `SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
         FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
          AND (c.relname = 'tenants' OR EXISTS (
                SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped))
        ORDER BY 1`);
    // global on purpose (documented): sign-in tables, and the per-company chunk counter that holds counts only
    const exempt = new Set(['auth_transactions', 'card_directory', 'login_attempts', 'tenant_usage_counters']);
    const scoped = rows.filter((r) => !exempt.has(r.table));
    // 24 from Phase 1 + 25 from Phase 2 (docs/phase2/02) + 6 from Phase 4 (answer_feedback, knowledge_item_conflicts,
    // anomaly_settings, card_anomaly_counters, person_leaving, retirement_nudges)
    expect(scoped.length).toBe(60);   // + 5 for scenario replay (scenarios, steps, step items, attempts, answers)
    for (const r of scoped) {
      expect(r, `table ${r.table}`).toMatchObject({ enabled: true, forced: true });
      expect(r.policies, `table ${r.table} has no policy`).toBeGreaterThanOrEqual(1);
    }
  });

  it('the set of global tables is exactly the documented one', async () => {
    const { rows } = await su.query<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND NOT relrowsecurity ORDER BY 1`);
    expect(rows.map((r) => r.relname)).toEqual(GLOBAL_TABLES);
  });
});

describe('cross-tenant access attempts (as the app role, in SQL)', () => {
  const tenantTables = [
    'tenant_settings', 'departments', 'people', 'cards', 'card_secrets', 'card_auth_state', 'credentials', 'enrollment_tokens',
    'sessions', 'card_events', 'card_restrictions', 'card_usage_counters', 'card_roles', 'audit_log', 'audit_chain_heads',
    'audit_anchors', 'idempotency_keys', 'export_jobs',
  ];

  it('with NO tenant set, every tenant table returns zero rows (fails closed)', async () => {
    await asTenant(null, async () => {
      for (const table of [...tenantTables, 'tenants']) {
        const { rows } = await app.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect(rows[0].n, `table ${table} leaked rows with no tenant set`).toBe(0);
      }
    });
    // ...while the data is really there:
    const real = await su.query('SELECT count(*)::int AS n FROM cards');
    expect(real.rows[0].n).toBeGreaterThanOrEqual(4);
  });

  it('with tenant A set, tenant B rows are invisible in every tenant table', async () => {
    await asTenant(a.tenantId, async () => {
      for (const table of tenantTables) {
        const { rows } = await app.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [b.tenantId]);
        expect(rows[0].n, `table ${table} leaked tenant B rows`).toBe(0);
      }
      const tenants = await app.query('SELECT id FROM tenants');
      expect(tenants.rows.map((r) => r.id)).toEqual([a.tenantId]);
      const byId = await app.query('SELECT 1 FROM cards WHERE id = $1', [b.ownerCard.id]);
      expect(byId.rowCount).toBe(0);
    });
  });

  it('counts match per tenant: A sees exactly its own cards', async () => {
    const truth = await su.query('SELECT count(*)::int AS n FROM cards WHERE tenant_id = $1', [a.tenantId]);
    await asTenant(a.tenantId, async () => {
      const seen = await app.query('SELECT count(*)::int AS n FROM cards');
      expect(seen.rows[0].n).toBe(truth.rows[0].n);
    });
  });

  it('INSERT with another tenant id is rejected', async () => {
    await asTenant(a.tenantId, async () => {
      await expect(app.query('INSERT INTO people (tenant_id, display_name) VALUES ($1, $2)', [b.tenantId, 'Intruder']))
        .rejects.toMatchObject({ code: '42501' });
    });
    await asTenant(a.tenantId, async () => {
      await expect(app.query('INSERT INTO departments (tenant_id, name) VALUES ($1, $2)', [b.tenantId, 'Intruder']))
        .rejects.toMatchObject({ code: '42501' });
    });
    await asTenant(a.tenantId, async () => {
      await expect(app.query(
        `INSERT INTO audit_log (tenant_id, seq, occurred_at, actor_kind, action, decision, reason_code, prev_hash, row_hash)
         VALUES ($1, 0, now(), 'system', 'x:y', 'event', 'FORGED', ''::bytea, ''::bytea)`, [b.tenantId])).rejects.toBeTruthy();
    });
    const leaked = await su.query(`SELECT 1 FROM people WHERE display_name = 'Intruder' UNION ALL SELECT 1 FROM audit_log WHERE reason_code = 'FORGED'`);
    expect(leaked.rowCount).toBe(0);
  });

  it('UPDATE and DELETE of another tenant rows affect nothing', async () => {
    await asTenant(a.tenantId, async () => {
      const upd = await app.query(`UPDATE people SET display_name = 'Hacked' WHERE tenant_id = $1`, [b.tenantId]);
      expect(upd.rowCount).toBe(0);
      const updAll = await app.query(`UPDATE cards SET suspended_reason = 'hacked' WHERE id = $1`, [b.ownerCard.id]);
      expect(updAll.rowCount).toBe(0);
      const del = await app.query('DELETE FROM card_roles WHERE tenant_id = $1', [b.tenantId]);
      expect(del.rowCount).toBe(0);
      const move = await app.query('UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE tenant_id = $1', [b.tenantId, 'admin']);
      expect(move.rowCount).toBe(0);
    });
    const intact = await su.query(`SELECT count(*)::int AS n FROM card_roles WHERE tenant_id = $1`, [b.tenantId]);
    expect(intact.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('a row cannot be moved into another tenant', async () => {
    await asTenant(a.tenantId, async () => {
      await expect(app.query('UPDATE people SET tenant_id = $1 WHERE tenant_id = $2', [b.tenantId, a.tenantId])).rejects.toBeTruthy();
    });
  });

  it('a row in tenant A cannot reference a row in tenant B (composite foreign keys)', async () => {
    await asTenant(a.tenantId, async () => {
      await expect(app.query('INSERT INTO card_roles (tenant_id, card_id, role_key) VALUES ($1, $2, $3)', [a.tenantId, b.ownerCard.id, 'admin']))
        .rejects.toMatchObject({ code: '23503' });
    });
    await asTenant(a.tenantId, async () => {
      await expect(app.query(`INSERT INTO sessions (tenant_id, card_id, token_hash, csrf_hash, idle_expires_at, absolute_expires_at)
                              VALUES ($1, $2, '\\x00', '\\x00', now(), now())`, [a.tenantId, b.ownerCard.id]))
        .rejects.toMatchObject({ code: '23503' });
    });
  });

  it('a malformed tenant setting is an error, not "all tenants"', async () => {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', 'not-a-uuid', true)`);
    await expect(app.query('SELECT count(*) FROM cards')).rejects.toMatchObject({ code: '22P02' });
    await app.query('ROLLBACK');
  });

  it('the tenant setting ends with the transaction (safe with connection pooling)', async () => {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.tenantId]);
    expect((await app.query('SELECT count(*)::int AS n FROM cards')).rows[0].n).toBeGreaterThan(0);
    await app.query('COMMIT');
    // Same connection, next "request": nothing is visible until a tenant is set again.
    expect((await app.query(`SELECT coalesce(current_setting('app.tenant_id', true), '') AS v`)).rows[0].v).toBe('');
    expect((await app.query('SELECT count(*)::int AS n FROM cards')).rows[0].n).toBe(0);
  });

  it('the cross-tenant "platform scope" is read-only and limited to the tenants table', async () => {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.tenantId]);
    await app.query(`SELECT set_config('app.platform_scope', 'on', true)`);
    expect((await app.query('SELECT count(*)::int AS n FROM tenants')).rows[0].n).toBeGreaterThanOrEqual(3);
    expect((await app.query('SELECT count(*)::int AS n FROM cards WHERE tenant_id = $1', [b.tenantId])).rows[0].n).toBe(0);
    // The app role cannot change ANY tenant row - not another tenant's, not even its own (status, plan, platform flag).
    await expect(app.query(`UPDATE tenants SET name = 'Hacked' WHERE id = $1`, [b.tenantId])).rejects.toMatchObject({ code: '42501' });
    await app.query('ROLLBACK');
    await asTenant(a.tenantId, async () => {
      await expect(app.query(`UPDATE tenants SET status = 'active', is_platform = true WHERE id = $1`, [a.tenantId])).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('references to cards and credentials cannot point into another tenant (composite foreign keys on every reference column)', async () => {
    const cred = (await su.query('SELECT id FROM credentials WHERE card_id = $1 LIMIT 1', [b.ownerCard.id])).rows[0].id;
    const attempts: Array<[string, unknown[]]> = [
      [`INSERT INTO sessions (tenant_id, card_id, token_hash, csrf_hash, credential_id, idle_expires_at, absolute_expires_at)
        VALUES ($1, $2, '\\x01', '\\x01', $3, now(), now())`, [a.tenantId, a.ownerCard.id, cred]],
      [`INSERT INTO card_events (tenant_id, card_id, event_type, actor_card_id) VALUES ($1, $2, 'issued', $3)`, [a.tenantId, a.ownerCard.id, b.ownerCard.id]],
      [`UPDATE cards SET replaced_by_card_id = $2 WHERE id = $1`, [a.ownerCard.id, b.ownerCard.id]],
      [`UPDATE cards SET issued_by_card_id = $2 WHERE id = $1`, [a.ownerCard.id, b.ownerCard.id]],
      [`INSERT INTO card_roles (tenant_id, card_id, role_key, assigned_by_card_id) VALUES ($1, $2, 'admin', $3)`, [a.tenantId, a.ownerCard.id, b.ownerCard.id]],
      [`UPDATE tenant_settings SET updated_by_card_id = $2 WHERE tenant_id = $1`, [a.tenantId, b.ownerCard.id]],
      [`INSERT INTO export_jobs (tenant_id, requested_by_card_id) VALUES ($1, $2)`, [a.tenantId, b.ownerCard.id]],
      [`INSERT INTO idempotency_keys (tenant_id, actor_card_id, key, operation_id, request_hash, expires_at) VALUES ($1, $2, 'cross-tenant-key', 'x', '\\x00', now())`, [a.tenantId, b.ownerCard.id]],
    ];
    for (const [sql, params] of attempts) {
      await asTenant(a.tenantId, async () => {
        await expect(app.query(sql, params), sql.slice(0, 50)).rejects.toMatchObject({ code: '23503' });
      });
    }
  });
});

// Every function we create, and which of them run with their owner's rights. A new function must be
// added here on purpose - and pass the search-path rule below.
const OUR_FUNCTIONS = [
  'ai_usage_ledger_guard', 'app_current_tenant', 'audit_field', 'audit_log_chain', 'audit_log_reject_change',
  'audit_write', 'cards_enforce_lifecycle', 'cards_register_directory', 'chunks_count', 'chunks_guard',
  'citations_guard', 'consent_is_valid', 'consents_guard', 'consents_hide_on_withdrawal', 'erase_version', 'expert_questions_guard',
  'interviews_guard', 'knowledge_items_end_conflicts', 'knowledge_items_guard', 'knowledge_items_touch_scenarios', 'knowledge_versions_immutable',
  'purge_login_attempts', 'quiz_attempts_guard', 'quiz_items_guard', 'relabel', 'resolve_card', 'review_tasks_guard',
  'scenario_attempts_guard', 'scenario_is_hidden', 'scenario_parts_guard', 'scenarios_guard', 'sources_guard',
  'topics_delete_guard', 'topics_guard',
];
const OUR_DEFINER_FUNCTIONS = [
  'audit_log_chain', 'audit_write', 'cards_register_directory', 'chunks_count', 'consents_hide_on_withdrawal', 'erase_version',
  // knowledge_items_end_conflicts: runs with the owner's rights so that a consent withdrawal recorded from any
  // session also removes the conflict excerpts of the items it hides (same reason as consents_hide_on_withdrawal)
  // knowledge_items_touch_scenarios: the same reason - a withdrawal or a re-labelling recorded from any session also
  // takes the scenarios built on that item out of use (it hides them; their words are erased by the erasure step)
  'knowledge_items_end_conflicts', 'knowledge_items_guard', 'knowledge_items_touch_scenarios', 'purge_login_attempts', 'resolve_card', 'sources_guard',
];

describe('SECURITY DEFINER functions cannot be hijacked', () => {
  it('the app role cannot create temporary tables (which could shadow a real table inside a definer function)', async () => {
    await asTenant(a.tenantId, async () => {
      await expect(app.query('CREATE TEMP TABLE audit_chain_heads (tenant_id uuid PRIMARY KEY, last_seq bigint, last_hash bytea)')).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('every function in the schema pins its search path with pg_temp last', async () => {
    const { rows } = await su.query<{ proname: string; prosecdef: boolean; config: string[] | null }>(
      `SELECT p.proname, p.prosecdef, p.proconfig AS config FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          -- functions that belong to an extension (pgvector) are not ours to configure
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
        ORDER BY 1`);
    expect(rows.map((r) => r.proname)).toEqual(OUR_FUNCTIONS);
    for (const r of rows) {
      const path = (r.config ?? []).find((c) => c.startsWith('search_path='));
      expect(path, `${r.proname} has no pinned search_path`).toBeDefined();
      expect(path!.endsWith('pg_temp'), `${r.proname}: ${path}`).toBe(true);
      expect(path!.startsWith('search_path=pg_catalog'), `${r.proname}: ${path}`).toBe(true);
    }
    expect(rows.filter((r) => r.prosecdef).map((r) => r.proname)).toEqual(OUR_DEFINER_FUNCTIONS);
  });

  it('trigger functions cannot be called directly, and the purge function only removes OLD login attempts', async () => {
    await asTenant(a.tenantId, async () => {
      await expect(app.query('SELECT audit_log_chain()')).rejects.toBeTruthy();
    });
    await asTenant(a.tenantId, async () => {
      await expect(app.query('SELECT purge_login_attempts(0)')).rejects.toThrow(/at least 30 days/);
    });
    await asTenant(a.tenantId, async () => {
      await expect(app.query('SELECT purge_login_attempts(NULL)')).rejects.toThrow(/at least 30 days/);
    });
    const before = (await su.query('SELECT count(*)::int AS n FROM login_attempts')).rows[0].n;
    expect(before).toBeGreaterThan(0);
    const res = await app.query('SELECT purge_login_attempts(30) AS deleted');
    expect(Number(res.rows[0].deleted)).toBe(0); // nothing here is 30 days old
    expect((await su.query('SELECT count(*)::int AS n FROM login_attempts')).rows[0].n).toBe(before);
  });
});

describe('least privilege on global and design-only tables', () => {
  it.each([
    ['read the card directory', 'SELECT * FROM card_directory'],
    ['read login attempts (real failure reasons)', 'SELECT * FROM login_attempts'],
    ['change login attempts', `UPDATE login_attempts SET real_reason = 'x'`],
    ['delete login attempts', 'DELETE FROM login_attempts'],
    ['change the permission matrix', `INSERT INTO role_permissions (role_key, permission_key, scope) VALUES ('contractor', 'card:issue', 'tenant')`],
    ['change roles', `UPDATE roles SET rank = 1000 WHERE role_key = 'contractor'`],
    ['rewrite card history', `UPDATE card_events SET event_type = 'issued'`],
    ['delete card history', 'DELETE FROM card_events'],
    ['write the audit chain head', `UPDATE audit_chain_heads SET last_seq = 0`],
    ['read webhooks (design-only table)', 'SELECT * FROM webhook_endpoints'],
    ['read SSO connections (design-only table)', 'SELECT * FROM sso_connections'],
    ['create a table', 'CREATE TABLE intruder (id int)'],
    ['disable row-level security', 'ALTER TABLE cards DISABLE ROW LEVEL SECURITY'],
    ['drop a policy', 'DROP POLICY tenant_isolation ON cards'],
  ])('the app role cannot %s', async (_name, sql) => {
    await asTenant(a.tenantId, async () => {
      await expect(app.query(sql)).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('resolve_card answers exact matches only', async () => {
    const digits = a.ownerCard.number.replace(/\D/g, '');
    const hit = await app.query('SELECT tenant_id, card_id FROM resolve_card($1)', [digits]);
    expect(hit.rows).toEqual([{ tenant_id: a.tenantId, card_id: a.ownerCard.id }]);
    for (const probe of ['%', digits.slice(0, 8), `${digits.slice(0, 15)}_`, '']) {
      expect((await app.query('SELECT * FROM resolve_card($1)', [probe])).rowCount).toBe(0);
    }
  });
});

describe('cross-tenant access attempts (through the API)', () => {
  it('tenant A cannot read, list or act on tenant B cards - and gets 404, not 403', async () => {
    const read = await a.owner.get(`/v1/cards/${b.ownerCard.id}`);
    expect(read.status).toBe(404);
    const list = await a.owner.get('/v1/cards');
    expect(list.body.items.map((c: any) => c.id)).not.toContain(b.ownerCard.id);
    expect((await a.owner.post(`/v1/cards/${b.ownerCard.id}/suspend`, { reason: 'x' })).status).toBe(404);
    expect((await a.owner.post(`/v1/cards/${b.ownerCard.id}/renew`, {})).status).toBe(404);
    expect((await a.owner.get(`/v1/cards/${b.ownerCard.id}/events`)).status).toBe(404);
    const still = await b.owner.get(`/v1/cards/${b.ownerCard.id}`);
    expect(still.body.state).toBe('active');
  });

  it('a session token re-labelled with another tenant id is useless', async () => {
    const forged = a.owner.cookie!.replace(a.tenantId, b.tenantId);
    const res = await t.app.http.app.inject({ method: 'GET', url: '/v1/auth/session', cookies: { '__Host-lai_session': forged } });
    expect(res.statusCode).toBe(401);
  });

  it('only the platform tenant can create or list tenants', async () => {
    expect((await a.owner.post('/v1/tenants', { name: 'X', slug: 'intruder-tenant', owner_display_name: 'X' })).status).toBe(403);
    expect((await a.owner.get('/v1/tenants')).status).toBe(403);
    expect((await su.query(`SELECT 1 FROM tenants WHERE slug = 'intruder-tenant'`)).rowCount).toBe(0);
  });
});
