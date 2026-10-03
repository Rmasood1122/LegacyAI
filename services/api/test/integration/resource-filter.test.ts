// The retrieval-time hook for Phase 2 (feature 17): buildResourceFilter() returns the SQL
// predicate a query must apply so a user can never retrieve content they may not see.
//
// Tested on a simple example resource shaped like Phase 2's knowledge items (tenant,
// department, owner, sensitivity). The central property: for every subject, the rows the
// filter returns are EXACTLY the rows decide() allows - no more, no fewer.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildResourceFilter, decide, loadMatrix, type Matrix, type PolicyContext, type ResourceDescriptor, type Restriction,
} from '../../src/modules/identity-access/index.ts';
import type { RoleKey, Subject, SubjectRole } from '../../src/shared/policy-types.ts';
import { addMember, createTenant, startApp, superuser, type TestApp, type TestTenant } from '../helpers/harness.ts';

let t: TestApp;
let su: pg.Client;
let a: TestTenant;
let b: TestTenant;
let matrix: Matrix;

const DESCRIPTOR: ResourceDescriptor = {
  type: 'knowledge', tenantExpr: 'i.tenant_id', ownerCardExpr: 'i.owner_card_id', departmentExpr: 'i.department_id', sensitivityExpr: 'i.sensitivity',
};
const ALL_ROLES: RoleKey[] = ['company_owner', 'admin', 'department_manager', 'auditor', 'reviewer', 'expert', 'successor', 'contractor'];
const RANK: Record<RoleKey, number> = { company_owner: 100, admin: 80, department_manager: 60, auditor: 50, reviewer: 40, expert: 30, successor: 20, contractor: 10 };

interface Item { id: string; tenant_id: string; owner_card_id: string | null; department_id: string | null; sensitivity: number }
let items: Item[];
let depts: string[];
let owners: string[];
const NOW = new Date();
const DAY = 86_400_000;

beforeAll(async () => {
  t = await startApp();
  su = await superuser();
  a = await createTenant(t, 'filter-a');
  b = await createTenant(t, 'filter-b');
  matrix = await t.app.db.withTenantTx(a.tenantId, (tx) => loadMatrix(tx));

  // Example resource (test-only table, with the same row-level security as real tables).
  await su.query(`
    CREATE TABLE IF NOT EXISTS policy_example_items (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, owner_card_id uuid, department_id uuid, sensitivity smallint NOT NULL, title text NOT NULL);
    ALTER TABLE policy_example_items ENABLE ROW LEVEL SECURITY;
    ALTER TABLE policy_example_items FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation ON policy_example_items;
    CREATE POLICY tenant_isolation ON policy_example_items USING (tenant_id = app_current_tenant());
    GRANT SELECT ON policy_example_items TO legacyai_app;`);

  depts = [randomUUID(), randomUUID(), randomUUID()];
  owners = [a.ownerCard.id, randomUUID(), randomUUID(), randomUUID()];
  items = [];
  let n = 0;
  for (const tenantId of [a.tenantId, b.tenantId]) {
    for (const dept of [...depts, null]) {
      for (const owner of [...owners, null]) {
        for (const sensitivity of [0, 1, 2, 3]) {
          items.push({ id: randomUUID(), tenant_id: tenantId, owner_card_id: owner, department_id: dept, sensitivity });
          n += 1;
        }
      }
    }
  }
  expect(n).toBe(2 * 4 * 5 * 4);
  for (const i of items) {
    await su.query('INSERT INTO policy_example_items (id, tenant_id, owner_card_id, department_id, sensitivity, title) VALUES ($1, $2, $3, $4, $5, $6)',
      [i.id, i.tenant_id, i.owner_card_id, i.department_id, i.sensitivity, 'example']);
  }
});
afterAll(async () => {
  await su.query('DROP TABLE IF EXISTS policy_example_items');
  await su.end();
  await t.close();
});

function subject(roles: SubjectRole[], over: Partial<Subject> = {}): Subject {
  return {
    kind: 'card', tenant_id: a.tenantId, card_id: owners[0]!, card_number: '0', person_id: null, department_id: null, card_state: 'active',
    activated_at: new Date(NOW.getTime() - DAY), expires_at: new Date(NOW.getTime() + 30 * DAY), grace_until: new Date(NOW.getTime() + 44 * DAY),
    renewal_due: NOW, locked: false, roles, is_platform_tenant: false, session_id: 's', session_idle_expires_at: NOW, session_absolute_expires_at: NOW, ...over,
  };
}
function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    now: NOW, ip: '10.1.1.1', tenant: { status: 'active' }, settings: { enabled_roles: ALL_ROLES, pilot_reviewer_grant: true }, matrix,
    companyCard: { state: 'active', expires_at: new Date(NOW.getTime() + 60 * DAY), grace_until: new Date(NOW.getTime() + 74 * DAY) },
    restrictions: [], usage: new Map(), planAllows: true, ...over,
  };
}
const role = (k: RoleKey, department_id: string | null = null): SubjectRole => ({ role_key: k, department_id, rank: RANK[k] });

/** Runs the filter against the real database as the app role and returns the ids it lets through. */
async function viaFilter(s: Subject, c: PolicyContext, action = 'knowledge:read'): Promise<Set<string>> {
  const filter = buildResourceFilter(s, action, DESCRIPTOR, c, 1);
  return t.app.db.withTenantTx(s.tenant_id, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(`SELECT i.id FROM policy_example_items i WHERE ${filter.sql}`, filter.params);
    return new Set(rows.map((r) => r.id));
  });
}
function viaDecide(s: Subject, c: PolicyContext, action = 'knowledge:read'): Set<string> {
  return new Set(items.filter((i) => decide(s, action, {
    type: 'knowledge', id: i.id, tenant_id: i.tenant_id, owner_card_id: i.owner_card_id, department_id: i.department_id, sensitivity: i.sensitivity,
  }, c).effect === 'allow').map((i) => i.id));
}

describe('buildResourceFilter agrees with decide() on every row', () => {
  it('for 8 roles, role pairs, departments, expiry phases, disabled roles, restrictions and plan limits', async () => {
    const expiredGrace = { expires_at: new Date(NOW.getTime() - DAY), grace_until: new Date(NOW.getTime() + 13 * DAY) };
    const lapsed = { expires_at: new Date(NOW.getTime() - 30 * DAY), grace_until: new Date(NOW.getTime() - 16 * DAY) };
    const readOnly: Restriction = { type: 'read_only', enabled: true, config: {} };
    const offSite: Restriction = { type: 'network_allowlist', enabled: true, config: { cidrs: ['192.0.2.0/24'] } };

    const variants: Array<{ name: string; s: Subject; c: PolicyContext }> = [];
    for (const r of ALL_ROLES) {
      variants.push({ name: r, s: subject([role(r, depts[0])]), c: ctx() });
      variants.push({ name: `${r} (dept 2)`, s: subject([role(r, depts[1])]), c: ctx() });
      variants.push({ name: `${r} (no dept)`, s: subject([role(r, null)]), c: ctx() });
      variants.push({ name: `${r} in grace`, s: subject([role(r, depts[0])], expiredGrace), c: ctx() });
      variants.push({ name: `${r} lapsed`, s: subject([role(r, depts[0])], lapsed), c: ctx() });
      variants.push({ name: `${r}, only pilot roles enabled`, s: subject([role(r, depts[0])]), c: ctx({ settings: { enabled_roles: ['company_owner', 'admin', 'expert', 'successor'], pilot_reviewer_grant: true } }) });
      variants.push({ name: `${r}, other card`, s: subject([role(r, depts[2])], { card_id: owners[2]! }), c: ctx() });
    }
    variants.push({ name: 'expert + department manager', s: subject([role('expert'), role('department_manager', depts[1])]), c: ctx() });
    variants.push({ name: 'contractor + successor', s: subject([role('contractor'), role('successor')]), c: ctx() });
    variants.push({ name: 'no roles', s: subject([]), c: ctx() });
    variants.push({ name: 'suspended owner', s: subject([role('company_owner')], { card_state: 'suspended' }), c: ctx() });
    variants.push({ name: 'locked owner', s: subject([role('company_owner')], { locked: true }), c: ctx() });
    variants.push({ name: 'owner, tenant suspended', s: subject([role('company_owner')]), c: ctx({ tenant: { status: 'suspended' } }) });
    variants.push({ name: 'owner, plan limit reached', s: subject([role('company_owner')]), c: ctx({ planAllows: false }) });
    variants.push({ name: 'owner, read-only card', s: subject([role('company_owner')]), c: ctx({ restrictions: [readOnly] }) });
    variants.push({ name: 'owner, off-site', s: subject([role('company_owner')]), c: ctx({ restrictions: [offSite] }) });
    variants.push({ name: 'owner, company card lapsed', s: subject([role('company_owner')]), c: ctx({ companyCard: { state: 'active', ...lapsed } }) });
    variants.push({ name: 'reviewer, company card in grace', s: subject([role('reviewer')]), c: ctx({ companyCard: { state: 'active', ...expiredGrace } }) });
    variants.push({ name: 'owner, tenant with no company card at all', s: subject([role('company_owner')]), c: ctx({ companyCard: null }) });
    variants.push({ name: 'owner of tenant B', s: subject([role('company_owner')], { tenant_id: b.tenantId, card_id: b.ownerCard.id }), c: ctx() });

    let nonEmpty = 0;
    let empty = 0;
    let comparisons = 0;
    const sizes = new Set<number>();
    for (const v of variants) {
      const got = await viaFilter(v.s, v.c);
      const want = viaDecide(v.s, v.c);
      comparisons += items.length;
      expect([...got].sort(), `filter and decide disagree for: ${v.name}`).toEqual([...want].sort());
      // never anything from the other tenant
      for (const id of got) expect(items.find((i) => i.id === id)!.tenant_id).toBe(v.s.tenant_id);
      sizes.add(got.size);
      if (got.size > 0) nonEmpty += 1; else empty += 1;
    }
    console.log(`RESOURCE_FILTER_PROPERTY variants=${variants.length} rows=${items.length} comparisons=${comparisons} non_empty=${nonEmpty} empty=${empty} distinct_result_sizes=${sizes.size} STATUS=COMPLETE`);
    // The property is not vacuous: many variants see something, many see nothing, and result sizes vary.
    expect(nonEmpty).toBeGreaterThanOrEqual(15);
    expect(empty).toBeGreaterThanOrEqual(15);
    expect(sizes.size).toBeGreaterThanOrEqual(6);
  });

  it('spot checks with hand-computed answers (so the property test is not just "both wrong the same way")', async () => {
    const mine = (pred: (i: Item) => boolean): number => items.filter((i) => i.tenant_id === a.tenantId && pred(i)).length;
    // Owner: tenant-wide, sensitivity up to 3 -> every row of tenant A (4 depts x 5 owners x 4 levels = 80).
    expect((await viaFilter(subject([role('company_owner')]), ctx())).size).toBe(80);
    // Successor: tenant-wide but sensitivity 0 only -> 20.
    expect((await viaFilter(subject([role('successor')]), ctx())).size).toBe(mine((i) => i.sensitivity === 0));
    expect(mine((i) => i.sensitivity === 0)).toBe(20);
    // Department manager of dept 0: that department only, sensitivity <= 1 -> 5 owners x 2 levels = 10.
    expect((await viaFilter(subject([role('department_manager', depts[0])]), ctx())).size).toBe(10);
    // Phase 2: while the pilot reviewer grant is on, Admins and Experts are the reviewers and read all
    // internal content: tenant-wide, sensitivity <= 1 -> 4 depts x 5 owners x 2 levels = 40.
    expect((await viaFilter(subject([role('expert')]), ctx())).size).toBe(40);
    expect((await viaFilter(subject([role('admin')]), ctx())).size).toBe(40);
    // With the grant off: an Expert reads own items only, sensitivity <= 1 -> 4 depts x 2 levels = 8 ...
    const pilotOff = (): ReturnType<typeof ctx> => { const c = ctx(); return { ...c, settings: { ...c.settings, pilot_reviewer_grant: false } }; };
    expect((await viaFilter(subject([role('expert')]), pilotOff())).size).toBe(8);
    // ... and an Admin reads no knowledge at all.
    expect((await viaFilter(subject([role('admin')]), pilotOff())).size).toBe(0);
    // Contractor: own, sensitivity 0 -> 4.
    expect((await viaFilter(subject([role('contractor')]), ctx())).size).toBe(4);
    // Auditor has no knowledge access at all.
    expect((await viaFilter(subject([role('auditor')]), ctx())).size).toBe(0);
  });
});

describe('the filter fails closed', () => {
  it('returns FALSE for a write action, an unknown action, a broken subject or a broken context', () => {
    const s = subject([role('company_owner')]);
    expect(buildResourceFilter(s, 'knowledge:contribute', DESCRIPTOR, ctx())).toEqual({ sql: 'FALSE', params: [] });
    expect(buildResourceFilter(s, 'knowledge:teleport', DESCRIPTOR, ctx())).toEqual({ sql: 'FALSE', params: [] });
    expect(buildResourceFilter(null as never, 'knowledge:read', DESCRIPTOR, ctx())).toEqual({ sql: 'FALSE', params: [] });
    expect(buildResourceFilter(s, 'knowledge:read', DESCRIPTOR, {} as never)).toEqual({ sql: 'FALSE', params: [] });
    expect(buildResourceFilter(subject([]), 'knowledge:read', DESCRIPTOR, ctx())).toEqual({ sql: 'FALSE', params: [] });
  });

  it('never puts values into the SQL text: ids are bound parameters', () => {
    const s = subject([role('expert'), role('department_manager', depts[1])]);
    const f = buildResourceFilter(s, 'knowledge:read', DESCRIPTOR, ctx(), 3);
    expect(f.sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(f.sql).toMatch(/^\(i\.tenant_id = \$3 AND \(/);
    const placeholders = [...f.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...placeholders)).toBe(3);
    expect(new Set(placeholders).size).toBe(f.params.length);
    expect(f.params).toContain(a.tenantId);
  });

  it('a department-scoped role with no department sees nothing through it', async () => {
    expect((await viaFilter(subject([role('department_manager', null)]), ctx())).size).toBe(0);
  });
});

describe('the filter is used for real by list endpoints', () => {
  it('GET /v1/cards and /v1/people: Owner sees all, Expert sees own, Department Manager sees their department', async () => {
    const owner = a.owner;
    await owner.patch('/v1/tenants/current/settings', { enabled_roles: ['company_owner', 'admin', 'expert', 'successor', 'department_manager'] });
    const d1 = (await owner.post('/v1/departments', { name: 'Welding' })).body.id;
    const d2 = (await owner.post('/v1/departments', { name: 'Paint' })).body.id;
    const w1 = await addMember(t, owner, [{ role_key: 'expert' }], { departmentId: d1 });
    const w2 = await addMember(t, owner, [{ role_key: 'expert' }], { departmentId: d1 });
    const p1 = await addMember(t, owner, [{ role_key: 'expert' }], { departmentId: d2 });
    const mgr = await addMember(t, owner, [{ role_key: 'department_manager', department_id: d1 }], { departmentId: d2 });

    const ids = async (c: typeof owner, url: string): Promise<string[]> => (await c.get(url)).body.items.map((x: any) => x.id).sort();

    expect(await ids(owner, '/v1/cards?limit=100')).toEqual([a.companyCard.id, a.ownerCard.id, w1.card.id, w2.card.id, p1.card.id, mgr.card.id].sort());
    expect(await ids(w1.client, '/v1/cards')).toEqual([w1.card.id]);
    expect(await ids(w1.client, '/v1/people')).toEqual([w1.personId]);
    // the manager manages Welding (d1): sees the two welders' cards - not Paint, not the Owner, not even their own card (they sit in Paint)
    expect(await ids(mgr.client, '/v1/cards')).toEqual([w1.card.id, w2.card.id].sort());
    expect(await ids(mgr.client, '/v1/people')).toEqual([w1.personId, w2.personId].sort());

    // and single reads agree with the lists
    expect((await mgr.client.get(`/v1/cards/${w1.card.id}`)).status).toBe(200);
    expect((await mgr.client.get(`/v1/cards/${p1.card.id}`)).status).toBe(403);
    expect((await mgr.client.get(`/v1/people/${p1.personId}`)).status).toBe(403);
    expect((await w1.client.get(`/v1/cards/${w2.card.id}`)).status).toBe(403);
    expect((await w1.client.get(`/v1/people/${w1.personId}`)).status).toBe(200);
    // a filter cannot be bypassed with query parameters
    expect(await ids(w1.client, `/v1/cards?person_id=${w2.personId}`)).toEqual([]);
    expect(await ids(mgr.client, `/v1/people?department_id=${d2}`)).toEqual([]);
  });
});
