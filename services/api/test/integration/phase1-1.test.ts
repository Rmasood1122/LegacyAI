// Phase 1.1 hardening.
//   1. Creating a tenant is ONE database transaction: a failure anywhere leaves nothing behind.
//   2. Only the platform operator can renew a tenant's company card.
//   3. Owners cannot renew / unlock / replace / re-enrol another Owner; a locked-out Owner is
//      recovered by the platform operator, and that action is audited, notified and forces a new
//      SC and a new strong factor.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recoverOperator } from '../../src/modules/identity-access/index.ts';
import { PLATFORM_TENANT_ID, type NotificationEvent, type Notifier } from '../../src/modules/platform/index.ts';
import {
  addMember, Client, createTenant, enrollPasskey, login, platformOperator, renewCompanyCard, startApp, superuser, tryLogin,
  type IssuedCard, type TestApp, type TestTenant,
} from '../helpers/harness.ts';

const DAY = 86_400_000;
const wrongSc = (sc: string): string => String((Number(sc) + 1) % 1000).padStart(3, '0');
/** The test clock keeps running, so "now + N days" is compared with a few seconds of tolerance. */
const expectAbout = (iso: string, expectedMs: number): void => expect(Math.abs(new Date(iso).getTime() - expectedMs)).toBeLessThan(10_000);

let t: TestApp;
let su: pg.Client;

beforeAll(async () => {
  t = await startApp();
  su = await superuser();
});
afterAll(async () => {
  await su.end();
  await t.close();
});

const details = (raw: unknown): Record<string, unknown> => (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
const lastDeny = async (cardId: string): Promise<string> =>
  (await su.query(`SELECT reason_code FROM audit_log WHERE actor_card_id = $1 AND decision = 'deny' ORDER BY seq DESC LIMIT 1`, [cardId])).rows[0]?.reason_code;
const operatorCardId = async (op: Client): Promise<string> => (await op.get('/v1/auth/session')).body.card_id as string;
const chainIntact = async (owner: Client): Promise<unknown> => (await owner.request('POST', '/v1/audit/verify', { from_seq: 1 })).body;

async function lockCard(card: Pick<IssuedCard, 'number' | 'sc'>, passkey: Parameters<typeof tryLogin>[3]): Promise<void> {
  for (let i = 0; i < 5; i += 1) await tryLogin(t, card.number, wrongSc(card.sc), passkey);
  expect((await tryLogin(t, card.number, card.sc, passkey)).res.status).toBe(401); // right SC, right factor: still locked
}

// ------------------------------------------------------------------ 1. tenant creation

describe('creating a tenant is one transaction', () => {
  /** A notifier that can be told to fail at a chosen moment of the request. */
  class FailingNotifier implements Notifier {
    failWhen: ((event: NotificationEvent, seen: number) => boolean) | null = null;
    seen: string[] = [];
    async notify(event: NotificationEvent): Promise<void> {
      this.seen.push(event.type);
      if (this.failWhen?.(event, this.seen.filter((s) => s === event.type).length)) throw new Error('injected failure');
    }
  }
  const notifier = new FailingNotifier();
  let app2: TestApp;
  let op: Client;

  beforeAll(async () => {
    app2 = await startApp({ notifier });
    op = await platformOperator(app2);
  });
  afterAll(async () => app2.close());

  /** Row count of EVERY table in the database (read as superuser, so row-level security hides nothing). */
  async function rowCounts(): Promise<Record<string, number>> {
    const tables = (await su.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.tablename as string);
    const out: Record<string, number> = {};
    for (const table of tables) out[table] = (await su.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
    return out;
  }
  // The only rows a FAILED request may add: its own "allowed, but failed" line in the OPERATOR's
  // audit chain, and rate-limit counters. Everything else must be exactly as before.
  const MAY_CHANGE = new Set(['audit_log', 'audit_chain_heads', 'rate_limit_buckets']);
  const comparable = (c: Record<string, number>): Record<string, number> =>
    Object.fromEntries(Object.entries(c).filter(([table]) => !MAY_CHANGE.has(table)));

  it.each([
    ['right after the company card is issued', (e: NotificationEvent, n: number) => e.type === 'card_issued' && n === 1],
    ['mid-creation: while the first Owner card is being issued', (e: NotificationEvent, n: number) => e.type === 'card_issued' && n === 2],
    ['at the very end, after the operator\'s own audit row was written', (e: NotificationEvent) => e.type === 'tenant_created'],
  ])('a failure %s leaves nothing behind', async (_name, failWhen) => {
    const slug = `atomic-${randomUUID().slice(0, 12)}`;
    const body = { name: 'Atomic Co', slug, owner_display_name: 'Atomic Owner', owner_email: `${slug}@example.test` };
    const key = `atomic-${randomUUID()}`;
    const before = await rowCounts();
    const auditBefore = before.audit_log as number;

    notifier.seen = [];
    notifier.failWhen = failWhen;
    const failed = await op.post('/v1/tenants', body, key);
    notifier.failWhen = null;
    expect(failed.status).toBe(500);
    expect(failed.raw).not.toMatch(/"sc"|enrollment_token|card_number/);
    expect(notifier.seen.length).toBeGreaterThan(0); // the injected failure point was really reached

    // Nothing was left behind: not the tenant, not a person, not a card, not a secret, not an audit chain.
    const after = await rowCounts();
    expect(comparable(after)).toEqual(comparable(before));
    expect((await su.query('SELECT count(*)::int AS n FROM tenants WHERE slug = $1', [slug])).rows[0].n).toBe(0);
    expect((await su.query('SELECT count(*)::int AS n FROM people WHERE email = $1', [body.owner_email])).rows[0].n).toBe(0);
    // The audit trail has no silent gap: exactly one new row, in the operator's chain, saying the request failed.
    expect(after.audit_log).toBe(auditBefore + 1);
    const trail = (await su.query('SELECT tenant_id, action, decision, details FROM audit_log WHERE request_id = $1', [failed.headers['x-request-id']])).rows;
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ tenant_id: PLATFORM_TENANT_ID, action: 'tenant:create', decision: 'allow' });
    expect(details(trail[0].details)).toEqual({ outcome: 'failed', status: 500 });

    // Control: the SAME request with the SAME idempotency key now succeeds - the slug is free and the
    // failed attempt's idempotency record was rolled back too. (Also shows the row counter can see a tenant.)
    const ok = await op.post('/v1/tenants', body, key);
    expect(ok.status).toBe(201);
    expect(ok.body.secret_already_shown).toBeUndefined();
    expect(ok.body.owner_card.sc).toMatch(/^\d{3}$/);
    const created = await rowCounts();
    expect(created.tenants).toBe((before.tenants as number) + 1);
    expect(created.cards).toBe((before.cards as number) + 2);
    expect(created.people).toBe((before.people as number) + 1);
    expect(created.tenant_settings).toBe((before.tenant_settings as number) + 1);
    // and the new tenant really works
    const ownerCard: IssuedCard = { id: ok.body.owner_card.card.id, number: ok.body.owner_card.card.card_number, sc: ok.body.owner_card.sc, enrollmentToken: ok.body.owner_card.enrollment_token };
    const owner = await login(app2, ownerCard, { passkey: await enrollPasskey(app2, ownerCard) });
    expect((await owner.get('/v1/cards')).body.items).toHaveLength(2);
    expect(await chainIntact(owner)).toMatchObject({ ok: true });
  });

  it('the tenant switch inside a transaction: sees only the other tenant, always switches back, cannot be nested, rolls back together', async () => {
    const a = await createTenant(t, 'switch-a');
    const b = await createTenant(t, 'switch-b');
    const db = t.app.db;
    const current = async (tx: { query: (q: string) => Promise<{ rows: unknown[] }> }): Promise<string> =>
      ((await tx.query(`SELECT current_setting('app.tenant_id') AS id`)).rows[0] as { id: string }).id;

    await db.withTenantTx(PLATFORM_TENANT_ID, async (tx) => {
      const mine = (await tx.query<{ tenant_id: string }>('SELECT DISTINCT tenant_id FROM cards')).rows.map((r) => r.tenant_id);
      expect(mine).toEqual([PLATFORM_TENANT_ID]);
      const theirs = await db.withinTenant(tx, b.tenantId, async () => {
        expect(await current(tx)).toBe(b.tenantId);
        await expect(db.withinTenant(tx, a.tenantId, async () => 1)).rejects.toThrow(/already switched/);
        return (await tx.query<{ tenant_id: string }>('SELECT DISTINCT tenant_id FROM cards')).rows.map((r) => r.tenant_id);
      });
      expect(theirs).toEqual([b.tenantId]);
      expect(await current(tx)).toBe(PLATFORM_TENANT_ID);
      // an error thrown by the caller's code (no failed statement) still switches back
      await expect(db.withinTenant(tx, b.tenantId, async () => { throw new Error('caller bug'); })).rejects.toThrow('caller bug');
      expect(await current(tx)).toBe(PLATFORM_TENANT_ID);
      await expect(db.withinTenant(tx, 'not-a-uuid', async () => 1)).rejects.toThrow(/not a UUID/);
    });
    await expect(db.withinTenant({ query: async () => ({ rows: [], rowCount: 0 }) }, b.tenantId, async () => 1)).rejects.toThrow(/not a transaction/);

    // A CUSTOMER's transaction can never be switched - to another customer or to the operator tenant.
    await db.withTenantTx(a.tenantId, async (tx) => {
      await expect(db.withinTenant(tx, b.tenantId, async () => 1)).rejects.toThrow(/only a transaction of the operator tenant/);
      await expect(db.withinTenant(tx, PLATFORM_TENANT_ID, async () => 1)).rejects.toThrow(/only a transaction of the operator tenant/);
      expect(await current(tx)).toBe(a.tenantId);
      expect((await tx.query<{ tenant_id: string }>('SELECT DISTINCT tenant_id FROM cards')).rows.map((r) => r.tenant_id)).toEqual([a.tenantId]);
    });

    // rows written for BOTH tenants roll back together
    await expect(db.withTenantTx(PLATFORM_TENANT_ID, async (tx) => {
      await db.withinTenant(tx, b.tenantId, async () => {
        await tx.query('INSERT INTO departments (tenant_id, name) VALUES ($1, $2)', [b.tenantId, 'Rollback B']);
      });
      await tx.query('INSERT INTO departments (tenant_id, name) VALUES ($1, $2)', [PLATFORM_TENANT_ID, 'Rollback A']);
      throw new Error('late failure');
    })).rejects.toThrow('late failure');
    expect((await su.query(`SELECT count(*)::int AS n FROM departments WHERE name IN ('Rollback A', 'Rollback B')`)).rows[0].n).toBe(0);

    // row-level security is still in force while switched: a row for a THIRD tenant is refused
    await expect(db.withTenantTx(PLATFORM_TENANT_ID, (tx) => db.withinTenant(tx, b.tenantId, async () => {
      await tx.query('INSERT INTO departments (tenant_id, name) VALUES ($1, $2)', [a.tenantId, 'Wrong Tenant']);
    }))).rejects.toMatchObject({ code: '42501' });
  });

  it('a failure inside an operator action on a customer tenant also leaves nothing behind', async () => {
    const ten = await createTenant(app2, 'atomic-rec');
    const before = await rowCounts();
    const secretBefore = (await su.query(`SELECT id FROM card_secrets WHERE card_id = $1 AND status = 'current'`, [ten.ownerCard.id])).rows[0].id;
    notifier.failWhen = (e) => e.type === 'owner_recovered' || e.type === 'company_card_renewed';
    const rec = await op.post(`/v1/tenants/${ten.tenantId}/owner-recovery`, { card_id: ten.ownerCard.id, verification_reference: 'CASE-ATOMIC-1' });
    const ren = await op.post(`/v1/tenants/${ten.tenantId}/company-card/renew`, {});
    notifier.failWhen = null;
    expect([rec.status, ren.status]).toEqual([500, 500]);
    expect(comparable(await rowCounts())).toEqual(comparable(before));
    expect((await su.query(`SELECT id FROM card_secrets WHERE card_id = $1 AND status = 'current'`, [ten.ownerCard.id])).rows[0].id).toBe(secretBefore);
    expect((await su.query('SELECT renewal_count FROM cards WHERE id = $1', [ten.companyCard.id])).rows[0].renewal_count).toBe(0);
    // the Owner was not touched: same SC, same passkey, still signs in
    expect((await tryLogin(app2, ten.ownerCard.number, ten.ownerCard.sc, { passkey: ten.ownerPasskey })).res.status).toBe(200);
  });
});

// ------------------------------------------------------------- 2. company-card renewal

describe('the company card is renewed by the platform operator only', () => {
  let ten: TestTenant;
  beforeAll(async () => {
    ten = await createTenant(t, 'cc-renew');
  });

  it('nobody inside the tenant can renew it: not an Admin, not an Owner', async () => {
    const admin = await addMember(t, ten.owner, [{ role_key: 'admin' }]);
    for (const c of [admin.client, ten.owner]) {
      const res = await c.post(`/v1/cards/${ten.companyCard.id}/renew`, {});
      expect(res.status).toBe(403);
      expect(res.raw).not.toMatch(/"sc"/);
    }
    expect(await lastDeny(admin.card.id)).toBe('DENY_COMPANY_CARD');
    expect(await lastDeny(ten.ownerCard.id)).toBe('DENY_COMPANY_CARD');
    expect((await su.query('SELECT renewal_count FROM cards WHERE id = $1', [ten.companyCard.id])).rows[0].renewal_count).toBe(0);
  });

  it('the operator endpoint is refused to a customer Owner and Admin - for their own tenant and for another one', async () => {
    const other = await createTenant(t, 'cc-other');
    const admin = await addMember(t, ten.owner, [{ role_key: 'admin' }]);
    for (const target of [ten.tenantId, other.tenantId]) {
      expect((await ten.owner.post(`/v1/tenants/${target}/company-card/renew`, {})).status).toBe(403);
      expect(await lastDeny(ten.ownerCard.id)).toBe('DENY_PLATFORM_ONLY');
      expect((await admin.client.post(`/v1/tenants/${target}/company-card/renew`, {})).status).toBe(403);
      expect(await lastDeny(admin.card.id)).toBe('DENY_PLATFORM_ONLY');
    }
    expect((await new Client(t).request('POST', `/v1/tenants/${ten.tenantId}/company-card/renew`, {}, { idem: 'anonymous-probe' })).status).toBe(401);
  });

  it('the operator renews it: new validity, rotated SC, recorded in BOTH audit chains as an operator action', async () => {
    const before = (await su.query('SELECT expires_at, renewal_count FROM cards WHERE id = $1', [ten.companyCard.id])).rows[0];
    const op = await platformOperator(t);
    const opCard = await operatorCardId(op);
    t.clock.advance(3 * DAY);
    const key = `cc-${randomUUID()}`;
    const res = await (await platformOperator(t)).post(`/v1/tenants/${ten.tenantId}/company-card/renew`, { validity_days: 60 }, key);
    expect(res.status).toBe(200);
    expect(res.body.card).toMatchObject({ id: ten.companyCard.id, kind: 'company', state: 'active', renewal_count: 1 });
    expect(res.body.sc).toMatch(/^\d{3}$/);
    expect(res.body.enrollment_token).toBeUndefined(); // nobody signs in with a company card
    expectAbout(res.body.card.expires_at, t.clock.now().getTime() + 60 * DAY);
    expect(new Date(res.body.card.expires_at).getTime()).not.toBe(new Date(before.expires_at).getTime());

    // the customer's chain names the operator's card, with the distinct actor kind
    const inTenant = (await su.query(
      `SELECT actor_kind, actor_card_id, reason_code FROM audit_log WHERE tenant_id = $1 AND action = 'card:renew' AND resource_id = $2 AND decision = 'event'`,
      [ten.tenantId, ten.companyCard.id])).rows;
    expect(inTenant).toEqual([{ actor_kind: 'operator', actor_card_id: opCard, reason_code: 'CARD_RENEWED_SC_ROTATED' }]);
    // the operator's own chain says which tenant was touched
    const inPlatform = (await su.query(
      `SELECT actor_card_id, details FROM audit_log WHERE tenant_id = $1 AND action = 'tenant:renew_company_card' AND decision = 'event' AND resource_id = $2`,
      [PLATFORM_TENANT_ID, ten.tenantId])).rows;
    expect(inPlatform).toHaveLength(1);
    expect(inPlatform[0].actor_card_id).toBe(opCard);
    expect(details(inPlatform[0].details)).toEqual({ target_tenant_id: ten.tenantId });
    // the customer can read that row through the API, and their chain still verifies
    const owner = await login(t, ten.ownerCard, { passkey: ten.ownerPasskey });
    const listed = await owner.get('/v1/audit/events?limit=100&action=card:renew');
    expect(listed.status).toBe(200);
    expect(listed.body.items.some((e: { actor_kind: string; action: string }) => e.actor_kind === 'operator' && e.action === 'card:renew')).toBe(true);
    expect(await chainIntact(owner)).toMatchObject({ ok: true });

    // an idempotent replay does not renew twice and does not repeat the SC
    const replay = await (await platformOperator(t)).post(`/v1/tenants/${ten.tenantId}/company-card/renew`, { validity_days: 60 }, key);
    expect(replay.status).toBe(200);
    expect(replay.body.secret_already_shown).toBe(true);
    expect(replay.body.sc).toBeUndefined();
    expect((await su.query('SELECT renewal_count FROM cards WHERE id = $1', [ten.companyCard.id])).rows[0].renewal_count).toBe(1);
    t.clock.reset();
  });

  it('refuses a tenant that does not exist, the operator tenant itself, and an out-of-range validity', async () => {
    const op = await platformOperator(t);
    expect((await op.post(`/v1/tenants/${randomUUID()}/company-card/renew`, {})).status).toBe(404);
    expect((await op.post(`/v1/tenants/${PLATFORM_TENANT_ID}/company-card/renew`, {})).status).toBe(404);
    expect((await op.post(`/v1/tenants/not-a-uuid/company-card/renew`, {})).status).toBe(400);
    expect((await op.post(`/v1/tenants/${ten.tenantId}/company-card/renew`, { validity_days: 0 })).status).toBe(400);
    expect((await op.post(`/v1/tenants/${ten.tenantId}/company-card/renew`, { validity_days: 91 })).status).toBe(422);
  });

  it('a lapsed tenant comes back to life when - and only when - the operator renews its company card', async () => {
    t.clock.reset();
    const lapsed = await createTenant(t, 'cc-lapsed');
    t.clock.advance(80 * DAY);
    let owner = await login(t, lapsed.ownerCard, { passkey: lapsed.ownerPasskey });
    const own = await owner.post(`/v1/cards/${lapsed.ownerCard.id}/renew`, {}); // an Owner may renew their OWN card
    expect(own.status).toBe(200);
    const ownerCard = { number: lapsed.ownerCard.number, sc: own.body.sc as string };
    t.clock.advance(26 * DAY); // day 106: company card expired on day 90, grace ended on day 104
    owner = await login(t, ownerCard, { passkey: lapsed.ownerPasskey });
    expect((await owner.get('/v1/auth/session')).body).toMatchObject({ card_state: 'active', read_only: true, export_only: true });
    expect((await owner.post('/v1/people', { display_name: 'While Lapsed' })).status).toBe(403);
    expect((await owner.post(`/v1/cards/${lapsed.companyCard.id}/renew`, {})).status).toBe(403); // cannot buy itself back in

    const renewed = await renewCompanyCard(t, lapsed.tenantId, { fresh: true });
    expect(renewed.status).toBe(200);
    expect(renewed.body.card.state).toBe('active');
    expect((await owner.get('/v1/auth/session')).body).toMatchObject({ read_only: false, export_only: false });
    expect((await owner.post('/v1/people', { display_name: 'After Renewal' })).status).toBe(201);
    t.clock.reset();
  });
});

// --------------------------------------------------- 3. Owners do not manage each other

describe('an Owner cannot take over another Owner', () => {
  it('renew, unlock, replace and enrollment token are all refused; nothing about the other Owner changes', async () => {
    const ten = await createTenant(t, 'two-owners');
    const o2 = await addMember(t, ten.owner, [{ role_key: 'company_owner' }]);
    await lockCard(o2.card, { passkey: o2.passkey }); // so that "unlock" would have something to do
    const secretBefore = (await su.query(`SELECT id FROM card_secrets WHERE card_id = $1 AND status = 'current'`, [o2.card.id])).rows[0].id;

    for (const [verb, body] of [['renew', {}], ['unlock', undefined], ['replace', { reason: 'lost' }], ['enrollment-token', {}]] as const) {
      const res = await ten.owner.post(`/v1/cards/${o2.card.id}/${verb}`, body);
      expect(res.status, verb).toBe(403);
      expect(res.raw, verb).not.toMatch(/"sc"|enrollment_token/);
      expect(await lastDeny(ten.ownerCard.id), verb).toBe('DENY_RANK');
    }
    const state = (await su.query('SELECT state, renewal_count, replaced_by_card_id FROM cards WHERE id = $1', [o2.card.id])).rows[0];
    expect(state).toEqual({ state: 'active', renewal_count: 0, replaced_by_card_id: null });
    expect((await su.query(`SELECT id FROM card_secrets WHERE card_id = $1 AND status = 'current'`, [o2.card.id])).rows[0].id).toBe(secretBefore);
    expect((await su.query('SELECT count(*)::int AS n FROM enrollment_tokens WHERE card_id = $1 AND used_at IS NULL', [o2.card.id])).rows[0].n).toBe(0);
    expect((await su.query('SELECT locked_at FROM card_auth_state WHERE card_id = $1', [o2.card.id])).rows[0].locked_at).not.toBeNull();

    // and the same from the other side
    const o3 = await addMember(t, ten.owner, [{ role_key: 'company_owner' }]);
    expect((await o3.client.post(`/v1/cards/${ten.ownerCard.id}/renew`, {})).status).toBe(403);
    expect((await o3.client.post(`/v1/cards/${ten.ownerCard.id}/enrollment-token`, {})).status).toBe(403);
    expect((await ten.owner.get('/v1/auth/session')).status).toBe(200); // the first Owner is untouched
  });

  it('not in two steps either: an Owner cannot demote another Owner first, nor revoke the card and issue a new one to the same person', async () => {
    const ten = await createTenant(t, 'two-step');
    const o2 = await addMember(t, ten.owner, [{ role_key: 'company_owner' }]);
    // step 1 of "demote, take over, promote again" is refused
    expect((await ten.owner.del(`/v1/cards/${o2.card.id}/roles/company_owner`)).status).toBe(403);
    expect((await ten.owner.put(`/v1/cards/${o2.card.id}/roles`, { roles: [{ role_key: 'expert' }] })).status).toBe(403);
    expect((await ten.owner.post(`/v1/cards/${o2.card.id}/roles`, { role_key: 'admin' })).status).toBe(403);
    expect(await lastDeny(ten.ownerCard.id)).toBe('DENY_RANK');
    expect((await su.query('SELECT role_key FROM card_roles WHERE card_id = $1', [o2.card.id])).rows).toEqual([{ role_key: 'company_owner' }]);

    // An Owner CAN still stop another Owner (defence against a compromised account): revoke is allowed...
    expect((await ten.owner.post(`/v1/cards/${o2.card.id}/revoke`, { reason: 'left the company' })).status).toBe(200);
    // ...but cannot then issue a new card - of any role - in that person's name
    for (const role_key of ['company_owner', 'admin', 'expert']) {
      const again = await ten.owner.post('/v1/cards', { person_id: o2.personId, roles: [{ role_key }] });
      expect(again.status, role_key).toBe(403);
      expect(again.raw).not.toMatch(/"sc"|enrollment_token/);
    }
    expect(await lastDeny(ten.ownerCard.id)).toBe('DENY_RANK');
    expect((await su.query('SELECT count(*)::int AS n FROM cards WHERE person_id = $1', [o2.personId])).rows[0].n).toBe(1);

    // The same hole one level down: an Admin cannot revoke a peer Admin and re-issue; the Owner can re-issue.
    const a1 = await addMember(t, ten.owner, [{ role_key: 'admin' }]);
    const a2 = await addMember(t, ten.owner, [{ role_key: 'admin' }]);
    expect((await a1.client.post(`/v1/cards/${a2.card.id}/revoke`, { reason: 'peer' })).status).toBe(200);
    expect((await a1.client.post('/v1/cards', { person_id: a2.personId, roles: [{ role_key: 'expert' }] })).status).toBe(403);
    expect((await ten.owner.post('/v1/cards', { person_id: a2.personId, roles: [{ role_key: 'admin' }] })).status).toBe(201);
    // ordinary issuing is unaffected
    const fresh = await a1.client.post('/v1/people', { display_name: 'Brand New' });
    expect((await a1.client.post('/v1/cards', { person_id: fresh.body.id, roles: [{ role_key: 'expert' }] })).status).toBe(201);
  });

  it('what an Owner CAN still do: renew their own card, and manage everyone below', async () => {
    const ten = await createTenant(t, 'owner-can');
    const admin = await addMember(t, ten.owner, [{ role_key: 'admin' }], { login: false });
    expect((await ten.owner.post(`/v1/cards/${admin.card.id}/renew`, {})).status).toBe(200);
    expect((await ten.owner.post(`/v1/cards/${admin.card.id}/enrollment-token`, {})).status).toBe(201);
    expect((await ten.owner.post(`/v1/cards/${admin.card.id}/replace`, { reason: 'lost' })).status).toBe(201);
    const self = await ten.owner.post(`/v1/cards/${ten.ownerCard.id}/renew`, {});
    expect(self.status).toBe(200);
    expect((await tryLogin(t, ten.ownerCard.number, self.body.sc, { passkey: ten.ownerPasskey })).res.status).toBe(200);
    // ...but not the other self-service shortcuts
    const again = await login(t, { number: ten.ownerCard.number, sc: self.body.sc }, { passkey: ten.ownerPasskey });
    expect((await again.post(`/v1/cards/${ten.ownerCard.id}/enrollment-token`, {})).status).toBe(403);
    expect((await again.post(`/v1/cards/${ten.ownerCard.id}/replace`, { reason: 'lost' })).status).toBe(403);
  });
});

// ----------------------------------------------------------- 4. operator recovery

describe('a locked-out Owner is recovered by the platform operator', () => {
  const REF = 'CASE-2026-000123';
  const recover = async (tenantId: string, cardId: string, opts: { fresh?: boolean; ref?: unknown; key?: string } = {}) =>
    (await platformOperator(t, { fresh: opts.fresh })).post(
      `/v1/tenants/${tenantId}/owner-recovery`, { card_id: cardId, verification_reference: opts.ref === undefined ? REF : opts.ref }, opts.key);
  const recoverByNumber = async (tenantId: string, cardNumber: string) =>
    (await platformOperator(t)).post(`/v1/tenants/${tenantId}/owner-recovery`, { card_number: cardNumber, verification_reference: REF });

  it('only the operator can call it', async () => {
    const ten = await createTenant(t, 'rec-who');
    const o2 = await addMember(t, ten.owner, [{ role_key: 'company_owner' }]);
    const admin = await addMember(t, ten.owner, [{ role_key: 'admin' }]);
    const body = { card_id: o2.card.id, verification_reference: REF };
    expect((await ten.owner.post(`/v1/tenants/${ten.tenantId}/owner-recovery`, body)).status).toBe(403);
    expect(await lastDeny(ten.ownerCard.id)).toBe('DENY_PLATFORM_ONLY');
    expect((await admin.client.post(`/v1/tenants/${ten.tenantId}/owner-recovery`, body)).status).toBe(403);
    expect((await new Client(t).request('POST', `/v1/tenants/${ten.tenantId}/owner-recovery`, body, { idem: 'anonymous-probe' })).status).toBe(401);
    expect((await su.query(`SELECT count(*)::int AS n FROM card_events WHERE card_id = $1 AND event_type = 'owner_recovered'`, [o2.card.id])).rows[0].n).toBe(0);
  });

  it('it insists on the reference of an identity check, and accepts only an identifier (no spaces, no @, no card number)', async () => {
    const ten = await createTenant(t, 'rec-ref');
    const op = await platformOperator(t);
    const url = `/v1/tenants/${ten.tenantId}/owner-recovery`;
    expect((await op.post(url, { card_id: ten.ownerCard.id })).status).toBe(400);
    for (const ref of ['', 'abc', 'Jane Example, phone 555 0100', 'jane@example.test', 'x'.repeat(65), 42, null]) {
      expect((await recover(ten.tenantId, ten.ownerCard.id, { ref })).status, String(ref)).toBe(400);
    }
    // a reference that contains 16 digits in a row looks like a card number: refused clearly (422), not with a server error
    for (const ref of ['1234567890123456', 'CASE-2026100312345678']) {
      const res = await recover(ten.tenantId, ten.ownerCard.id, { ref });
      expect(res.status, ref).toBe(422);
    }
    // the card must be named exactly once
    expect((await op.post(url, { verification_reference: REF })).status).toBe(400);
    expect((await op.post(url, { card_id: ten.ownerCard.id, card_number: ten.ownerCard.number, verification_reference: REF })).status).toBe(400);
    expect((await tryLogin(t, ten.ownerCard.number, ten.ownerCard.sc, { passkey: ten.ownerPasskey })).res.status).toBe(200); // untouched
  });

  it('the card can be named by its number (what the Owner can read off their own card)', async () => {
    const ten = await createTenant(t, 'rec-number');
    const other = await createTenant(t, 'rec-number-other');
    expect((await recoverByNumber(ten.tenantId, other.ownerCard.number)).status).toBe(404); // another tenant's card number
    expect((await recoverByNumber(ten.tenantId, 'LGY-0000-0000-0000-0000')).status).toBe(404); // not a valid number
    expect((await recoverByNumber(ten.tenantId, ten.companyCard.number)).status).toBe(409);
    const res = await recoverByNumber(ten.tenantId, ten.ownerCard.number);
    expect(res.status).toBe(201);
    expect(res.body.card.id).toBe(ten.ownerCard.id);
    const inPlatform = (await su.query(
      `SELECT details FROM audit_log WHERE tenant_id = $1 AND action = 'tenant:recover_owner' AND decision = 'event' AND resource_id = $2`,
      [PLATFORM_TENANT_ID, ten.tenantId])).rows;
    expect(details(inPlatform[0].details)).toMatchObject({ target_card_id: ten.ownerCard.id });
    expect(JSON.stringify(inPlatform)).not.toContain(ten.ownerCard.number.replace(/\D/g, ''));
  });

  it('it works on Company Owner cards only, in the named tenant only', async () => {
    const ten = await createTenant(t, 'rec-target');
    const other = await createTenant(t, 'rec-other');
    const admin = await addMember(t, ten.owner, [{ role_key: 'admin' }]);
    const notOwner = await recover(ten.tenantId, admin.card.id);
    expect(notOwner.status).toBe(409);
    expect(notOwner.body.type).toMatch(/not-an-owner-card$/);
    expect((await recover(ten.tenantId, ten.companyCard.id)).status).toBe(409);
    expect((await recover(ten.tenantId, other.ownerCard.id)).status).toBe(404); // a card of another tenant
    expect((await recover(ten.tenantId, randomUUID())).status).toBe(404);
    expect((await recover(randomUUID(), ten.ownerCard.id)).status).toBe(404);
    expect((await recover(PLATFORM_TENANT_ID, ten.ownerCard.id)).status).toBe(404);
    // a suspended Owner is not "locked out": another Owner reinstates it
    const o2 = await addMember(t, ten.owner, [{ role_key: 'company_owner' }]);
    expect((await ten.owner.post(`/v1/cards/${o2.card.id}/suspend`, { reason: 'test' })).status).toBe(200);
    expect((await recover(ten.tenantId, o2.card.id)).status).toBe(409);
    // none of the refusals changed anything
    expect((await admin.client.get('/v1/auth/session')).status).toBe(200);
    expect((await other.owner.get('/v1/auth/session')).status).toBe(200);
  });

  it('a locked-out SOLE Owner: recovered, forced onto a new SC and a new strong factor, with a full trail', async () => {
    const ten = await createTenant(t, 'rec-sole');
    const admin = await addMember(t, ten.owner, [{ role_key: 'admin' }]);
    await lockCard(ten.ownerCard, { passkey: ten.ownerPasskey });
    // nobody inside the tenant can help
    expect((await admin.client.post(`/v1/cards/${ten.ownerCard.id}/unlock`)).status).toBe(403);
    expect((await admin.client.post(`/v1/cards/${ten.ownerCard.id}/enrollment-token`, {})).status).toBe(403);

    const op = await platformOperator(t);
    const opCard = await operatorCardId(op);
    const logMark = t.logs.length;
    const key = `rec-${randomUUID()}`;
    const res = await recover(ten.tenantId, ten.ownerCard.id, { key });
    expect(res.status).toBe(201);
    expect(res.body.card).toMatchObject({ id: ten.ownerCard.id, state: 'active', locked: false });
    expect(res.body.sc).toMatch(/^\d{3}$/);
    expect(typeof res.body.enrollment_token).toBe('string');
    expect(res.body.notified_owner_count).toBe(0);

    // every old way in is dead: old factor, old SC, old sessions
    const creds = (await su.query('SELECT status FROM credentials WHERE card_id = $1', [ten.ownerCard.id])).rows.map((r) => r.status);
    expect(creds.length).toBeGreaterThan(0);
    expect(new Set(creds)).toEqual(new Set(['revoked']));
    expect((await ten.owner.get('/v1/auth/session')).status).toBe(401);
    expect((await tryLogin(t, ten.ownerCard.number, res.body.sc, { passkey: ten.ownerPasskey })).res.status).toBe(401);
    expect((await su.query(`SELECT count(*)::int AS n FROM card_secrets WHERE card_id = $1 AND status = 'current'`, [ten.ownerCard.id])).rows[0].n).toBe(1);
    expect((await su.query(`SELECT count(*)::int AS n FROM card_secrets WHERE card_id = $1 AND status = 'retired' AND sc_hash IS NOT NULL`, [ten.ownerCard.id])).rows[0].n).toBe(0);
    // the new SC and the token do not sign anyone in by themselves: a factor must be enrolled first
    const noFactor = new Client(t);
    const begin = await noFactor.request('POST', '/v1/auth/login/begin', { card_number: ten.ownerCard.number });
    expect((await noFactor.request('POST', '/v1/auth/login/verify', { login_txn: begin.body.login_txn, sc: res.body.sc, factor: { type: 'totp', code: '000000' } })).status).toBe(401);

    // the Owner enrols a NEW factor with the new SC + token and is back, with full rights
    const recovered: IssuedCard = { id: ten.ownerCard.id, number: ten.ownerCard.number, sc: res.body.sc, enrollmentToken: res.body.enrollment_token };
    const newKey = await enrollPasskey(t, recovered);
    if (res.body.sc !== ten.ownerCard.sc) {
      // the OLD SC does not work even with the new factor
      expect((await tryLogin(t, ten.ownerCard.number, ten.ownerCard.sc, { passkey: newKey })).res.status).toBe(401);
    }
    const owner = await login(t, recovered, { passkey: newKey });
    expect((await owner.get('/v1/auth/session')).body).toMatchObject({ card_state: 'active', read_only: false, roles: ['company_owner'] });
    expect((await owner.post('/v1/people', { display_name: 'After Recovery' })).status).toBe(201);
    // the token was single-use
    const reuse = await new Client(t).request('POST', '/v1/auth/enrollment/begin', {
      card_number: recovered.number, sc: recovered.sc, enrollment_token: recovered.enrollmentToken, factor_type: 'passkey', label: 'again',
    });
    expect(reuse.status).toBe(401);

    // the trail: customer chain (operator kind + the identity-check reference), card history, operator chain, notification
    const inTenant = (await su.query(
      `SELECT actor_kind, actor_card_id, reason_code, details FROM audit_log WHERE tenant_id = $1 AND action = 'card:owner_recovery'`, [ten.tenantId])).rows;
    expect(inTenant).toHaveLength(1);
    expect(inTenant[0]).toMatchObject({ actor_kind: 'operator', actor_card_id: opCard, reason_code: 'OWNER_RECOVERED_BY_OPERATOR' });
    expect(details(inTenant[0].details)).toEqual({ verification_ref: REF });
    const history = (await su.query(`SELECT actor_card_id FROM card_events WHERE card_id = $1 AND event_type = 'owner_recovered'`, [ten.ownerCard.id])).rows;
    expect(history).toEqual([{ actor_card_id: null }]);
    const inPlatform = (await su.query(
      `SELECT actor_card_id, details FROM audit_log WHERE tenant_id = $1 AND action = 'tenant:recover_owner' AND decision = 'event' AND resource_id = $2`,
      [PLATFORM_TENANT_ID, ten.tenantId])).rows;
    expect(inPlatform).toHaveLength(1);
    expect(inPlatform[0].actor_card_id).toBe(opCard);
    expect(details(inPlatform[0].details)).toEqual({ target_tenant_id: ten.tenantId, target_card_id: ten.ownerCard.id, verification_ref: REF });
    expect(t.logs.slice(logMark).some((l) => l.includes('"notification":"owner_recovered"') && l.includes(ten.ownerCard.id))).toBe(true);
    const events = await owner.get(`/v1/cards/${ten.ownerCard.id}/events?event_type=owner_recovered`);
    expect(events.body.items).toHaveLength(1);
    expect(await chainIntact(owner)).toMatchObject({ ok: true });
    // neither the SC nor the token was written to any log line
    expect(t.logs.slice(logMark).some((l) => l.includes(res.body.enrollment_token))).toBe(false);

    // an idempotent replay repeats nothing and does not rotate again
    const replay = await recover(ten.tenantId, ten.ownerCard.id, { key });
    expect(replay.status).toBe(201);
    expect(replay.body.secret_already_shown).toBe(true);
    expect(replay.body.sc).toBeUndefined();
    expect(replay.body.enrollment_token).toBeUndefined();
    expect((await owner.get('/v1/auth/session')).status).toBe(200);
  });

  it('every OTHER Owner of the company is notified', async () => {
    const ten = await createTenant(t, 'rec-notify');
    const o2 = await addMember(t, ten.owner, [{ role_key: 'company_owner' }]);
    const o3 = await addMember(t, ten.owner, [{ role_key: 'company_owner' }]);
    const admin = await addMember(t, ten.owner, [{ role_key: 'admin' }]);
    const logMark = t.logs.length;
    const res = await recover(ten.tenantId, o2.card.id);
    expect(res.status).toBe(201);
    expect(res.body.notified_owner_count).toBe(2);
    const told = t.logs.slice(logMark).filter((l) => l.includes('"notification":"owner_recovered"')).map((l) => JSON.parse(l) as { card_id: string; recipient_card_id?: string });
    expect(told.every((n) => n.card_id === o2.card.id)).toBe(true);
    expect(told.map((n) => n.recipient_card_id).filter(Boolean).sort()).toEqual([ten.ownerCard.id, o3.card.id].sort());
    expect(told.some((n) => n.recipient_card_id === admin.card.id)).toBe(false);
    // the other Owners' own access is untouched
    expect((await ten.owner.get('/v1/auth/session')).status).toBe(200);
    expect((await o3.client.get('/v1/auth/session')).status).toBe(200);
    expect((await o2.client.get('/v1/auth/session')).status).toBe(401);
  });

  it('an enrollment token that was still unused when the recovery happened is dead', async () => {
    const ten = await createTenant(t, 'rec-token');
    const o2 = await addMember(t, ten.owner, [{ role_key: 'company_owner' }], { login: false });
    // two recoveries in a row: the token handed out by the first must stop working when the second happens
    const first = await recover(ten.tenantId, o2.card.id);
    expect(first.status).toBe(201);
    const second = await recover(ten.tenantId, o2.card.id);
    expect(second.status).toBe(201);
    const stale = await new Client(t).request('POST', '/v1/auth/enrollment/begin', {
      card_number: o2.card.number, sc: second.body.sc, enrollment_token: first.body.enrollment_token, factor_type: 'passkey', label: 'stale',
    });
    expect(stale.status).toBe(401);
    expect((await su.query('SELECT count(*)::int AS n FROM enrollment_tokens WHERE card_id = $1 AND used_at IS NULL', [o2.card.id])).rows[0].n).toBe(1);
    const card: IssuedCard = { id: o2.card.id, number: o2.card.number, sc: second.body.sc, enrollmentToken: second.body.enrollment_token };
    expect((await (await login(t, card, { passkey: await enrollPasskey(t, card) })).get('/v1/auth/session')).status).toBe(200);
  });

  it('a first Owner who never enrolled and whose card has expired can be recovered and can then sign in', async () => {
    t.clock.reset();
    const op = await platformOperator(t);
    const created = await op.post('/v1/tenants', { name: 'Never Enrolled', slug: `never-${randomUUID().slice(0, 10)}`, owner_display_name: 'Late Owner' });
    expect(created.status).toBe(201);
    const tenantId = created.body.tenant.id as string;
    const cardId = created.body.owner_card.card.id as string;
    t.clock.advance(120 * DAY);
    expect((await renewCompanyCard(t, tenantId, { fresh: true })).status).toBe(200);
    const res = await recover(tenantId, cardId);
    expect(res.status).toBe(201);
    expect(res.body.card.state).toBe('active');
    const card: IssuedCard = { id: cardId, number: created.body.owner_card.card.card_number, sc: res.body.sc, enrollmentToken: res.body.enrollment_token };
    const owner = await login(t, card, { passkey: await enrollPasskey(t, card) });
    expect((await owner.get('/v1/auth/session')).body).toMatchObject({ card_state: 'active', read_only: false });
    expect((await su.query('SELECT activated_at FROM cards WHERE id = $1', [cardId])).rows[0].activated_at).not.toBeNull();
    t.clock.reset();
  });

  it('break-glass: a locked-out OPERATOR is recovered from the command line, never through the API', async () => {
    t.clock.reset();
    const op = await platformOperator(t, { fresh: true });
    const session = (await op.get('/v1/auth/session')).body;
    const opCard = (await su.query('SELECT id, card_number FROM cards WHERE id = $1', [session.card_id])).rows[0];
    // through the API the operator tenant is never a target, and operators cannot help each other
    const peer = await platformOperator(t, { fresh: true });
    expect((await peer.post(`/v1/tenants/${PLATFORM_TENANT_ID}/owner-recovery`, { card_id: opCard.id, verification_reference: REF })).status).toBe(404);
    expect((await peer.post(`/v1/cards/${opCard.id}/renew`, {})).status).toBe(403);
    expect((await peer.post(`/v1/cards/${opCard.id}/enrollment-token`, {})).status).toBe(403);

    const ctx = { requestId: 'test-break-glass', ip: '', userAgent: 'cli', now: t.clock.now() };
    await expect(recoverOperator(t.app.db, t.app.identity.cards, 'LGY-1234', ctx)).rejects.toThrow(/not a valid card number/);
    const customer = await createTenant(t, 'not-operator');
    await expect(recoverOperator(t.app.db, t.app.identity.cards, customer.ownerCard.number, ctx)).rejects.toThrow(/No operator card/);

    const result = await recoverOperator(t.app.db, t.app.identity.cards, opCard.card_number, ctx);
    expect(result.card_id).toBe(opCard.id);
    expect((await op.get('/v1/auth/session')).status).toBe(401); // the old session is gone
    expect((await su.query(`SELECT count(*)::int AS n FROM credentials WHERE card_id = $1 AND status = 'active'`, [opCard.id])).rows[0].n).toBe(0);
    const card: IssuedCard = { id: opCard.id, number: result.card_number, sc: result.sc, enrollmentToken: result.enrollment_token };
    const back = await login(t, card, { passkey: await enrollPasskey(t, card) });
    expect((await back.get('/v1/tenants?limit=1')).status).toBe(200); // an operator again
    const trail = (await su.query(
      `SELECT actor_kind, actor_card_id, reason_code, details FROM audit_log WHERE tenant_id = $1 AND action = 'card:owner_recovery' AND resource_id = $2`,
      [PLATFORM_TENANT_ID, opCard.id])).rows;
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ actor_kind: 'system', actor_card_id: null, reason_code: 'OWNER_RECOVERED_BY_OPERATOR' });
    expect(details(trail[0].details)).toEqual({ verification_ref: 'cli-break-glass' });
  });

  it('an Owner whose card expired long ago: recovery gives the card a new validity period', async () => {
    t.clock.reset();
    const ten = await createTenant(t, 'rec-expired');
    t.clock.advance(120 * DAY); // owner card and company card both 16 days past their grace window
    expect((await renewCompanyCard(t, ten.tenantId, { fresh: true })).status).toBe(200);
    const stuck = await login(t, ten.ownerCard, { passkey: ten.ownerPasskey });
    expect((await stuck.get('/v1/auth/session')).body).toMatchObject({ card_state: 'expired', export_only: true });
    expect((await stuck.post(`/v1/cards/${ten.ownerCard.id}/renew`, {})).status).toBe(403); // too late to renew itself

    const res = await recover(ten.tenantId, ten.ownerCard.id);
    expect(res.status).toBe(201);
    expect(res.body.card).toMatchObject({ state: 'active', renewal_count: 1 });
    expectAbout(res.body.card.expires_at, t.clock.now().getTime() + 90 * DAY);
    const recovered: IssuedCard = { id: ten.ownerCard.id, number: ten.ownerCard.number, sc: res.body.sc, enrollmentToken: res.body.enrollment_token };
    const owner = await login(t, recovered, { passkey: await enrollPasskey(t, recovered) });
    expect((await owner.get('/v1/auth/session')).body).toMatchObject({ card_state: 'active', read_only: false, export_only: false });
    expect(await chainIntact(owner)).toMatchObject({ ok: true });
    t.clock.reset();
  });
});
