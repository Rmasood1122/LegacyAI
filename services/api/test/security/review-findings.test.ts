// Regression tests for defects found by the independent review of the first build.
// Each test reproduces the attack the reviewer described and proves it no longer works.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_AUTH_LIMITS, SecretCodeHasher } from '../../src/modules/identity-access/index.ts';
import { ARGON2_FLOOR, Secret } from '../../src/modules/platform/index.ts';
import { addMember, Client, createTenant, login, startApp, superuser, tryLogin, type TestApp, type TestTenant } from '../helpers/harness.ts';

let t: TestApp;
let su: pg.Client;
let tenant: TestTenant;
beforeAll(async () => {
  t = await startApp();
  su = await superuser();
  tenant = await createTenant(t, 'review');
});
afterAll(async () => {
  await su.end();
  await t.close();
});

const lastDeny = async (cardId: string): Promise<string> =>
  (await su.query(`SELECT reason_code FROM audit_log WHERE actor_card_id = $1 AND decision = 'deny' ORDER BY seq DESC LIMIT 1`, [cardId])).rows[0]?.reason_code;

describe('the company card cannot be used to switch a tenant off or to dodge expiry', () => {
  it('an Admin cannot suspend, revoke, replace or renew the company card', async () => {
    const admin = await addMember(t, tenant.owner, [{ role_key: 'admin' }]);
    const id = tenant.companyCard.id;
    for (const [verb, body] of [['suspend', { reason: 'x' }], ['revoke', { reason: 'x' }], ['replace', { reason: 'lost' }], ['renew', {}], ['unlock', undefined], ['enrollment-token', {}]] as const) {
      expect((await admin.client.post(`/v1/cards/${id}/${verb}`, body)).status, verb).toBe(403);
    }
    expect((await admin.client.put(`/v1/cards/${id}/restrictions`, { restrictions: [] })).status).toBe(403);
    expect((await admin.client.post(`/v1/cards/${id}/roles`, { role_key: 'admin' })).status).toBe(403);
    expect((await su.query('SELECT state FROM cards WHERE id = $1', [id])).rows[0].state).toBe('active');
    // the tenant still works
    expect((await tenant.owner.get('/v1/cards')).status).toBe(200);
  });

  it('even an Owner cannot suspend, revoke or replace it; an Owner can renew it', async () => {
    const id = tenant.companyCard.id;
    for (const [verb, body] of [['suspend', { reason: 'x' }], ['revoke', { reason: 'x' }], ['replace', { reason: 'lost' }]] as const) {
      expect((await tenant.owner.post(`/v1/cards/${id}/${verb}`, body)).status, verb).toBe(403);
    }
    expect(await lastDeny(tenant.ownerCard.id)).toBe('DENY_COMPANY_CARD');
    expect((await tenant.owner.post(`/v1/cards/${id}/renew`, {})).status).toBe(200);
  });

  it('if a company card is revoked anyway (directly in the database), the tenant is treated as lapsed - not as "never expires"', async () => {
    const ten = await createTenant(t, 'nocompany');
    const admin = await addMember(t, ten.owner, [{ role_key: 'admin' }]);
    await su.query(`UPDATE cards SET state = 'revoked' WHERE id = $1`, [ten.companyCard.id]);
    expect((await admin.client.get('/v1/cards')).status).toBe(403);
    expect(await lastDeny(admin.card.id)).toBe('DENY_TENANT_EXPIRED');
    expect((await tryLogin(t, admin.card.number, admin.card.sc, { passkey: admin.passkey })).res.status).toBe(401);
    // the Owner keeps the one thing that is always free: export
    expect((await ten.owner.get('/v1/cards')).status).toBe(403);
    expect((await ten.owner.post('/v1/exports')).status).toBe(202);
  });
});

describe('an administrator cannot take over a peer account', () => {
  it('Admin A cannot obtain Admin B\'s new SC, enrollment token or replacement card', async () => {
    const a = await addMember(t, tenant.owner, [{ role_key: 'admin' }]);
    const b = await addMember(t, tenant.owner, [{ role_key: 'admin' }]);
    for (const [verb, body] of [['renew', {}], ['enrollment-token', {}], ['replace', { reason: 'lost' }], ['unlock', undefined]] as const) {
      const res = await a.client.post(`/v1/cards/${b.card.id}/${verb}`, body);
      expect(res.status, verb).toBe(403);
      expect(res.raw).not.toMatch(/"sc"|enrollment_token/);
    }
    expect(await lastDeny(a.card.id)).toBe('DENY_RANK');
    // B is untouched and still signed in
    expect((await b.client.get('/v1/auth/session')).status).toBe(200);
    // A cannot extend its own card either
    expect((await a.client.post(`/v1/cards/${a.card.id}/renew`, {})).status).toBe(403);
    // ...but A can still do its job on lower-ranked cards
    const expert = await addMember(t, tenant.owner, [{ role_key: 'expert' }], { login: false });
    expect((await a.client.post(`/v1/cards/${expert.card.id}/renew`, {})).status).toBe(200);
  });

  it('when a sign-in factor is added to a card by token, the cardholder is told and their sessions end', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    const before = t.logs.length;
    const token = await tenant.owner.post(`/v1/cards/${m.card.id}/enrollment-token`, {});
    expect(token.status).toBe(201);
    expect(t.logs.slice(before).some((l) => l.includes('"notification":"enrollment_token_issued"') && l.includes(m.card.id))).toBe(true);
    const c = new Client(t);
    const begin = await c.request('POST', '/v1/auth/enrollment/begin', { card_number: m.card.number, sc: m.card.sc, enrollment_token: token.body.enrollment_token, factor_type: 'totp' });
    const { generate } = await import('otplib');
    const done = await c.request('POST', '/v1/auth/enrollment/complete', {
      enrollment_txn: begin.body.enrollment_txn, totp_code: await generate({ secret: begin.body.totp.secret, epoch: Math.floor(t.clock.now().getTime() / 1000) }),
    });
    expect(done.status).toBe(204);
    expect(t.logs.slice(before).some((l) => l.includes('"notification":"credential_added"') && l.includes(m.card.id))).toBe(true);
    expect((await m.client.get('/v1/auth/session')).status).toBe(401);
  });

  it('nobody can edit or offboard themselves, and an Admin cannot edit an Owner', async () => {
    const admin = await addMember(t, tenant.owner, [{ role_key: 'admin' }]);
    expect((await admin.client.patch(`/v1/people/${admin.personId}`, { status: 'departed' })).status).toBe(403);
    expect((await admin.client.patch(`/v1/people/${admin.personId}`, { display_name: 'Renamed Myself' })).status).toBe(403);
    const ownerPerson = (await su.query('SELECT person_id FROM cards WHERE id = $1', [tenant.ownerCard.id])).rows[0].person_id;
    expect((await admin.client.patch(`/v1/people/${ownerPerson}`, { display_name: 'Renamed The Owner' })).status).toBe(403);
    expect((await su.query('SELECT state FROM cards WHERE id = $1', [admin.card.id])).rows[0].state).toBe('active');
  });
});

describe('the last Company Owner cannot be removed, even by two requests racing each other', () => {
  it('two Owners suspend each other at the same moment: exactly one succeeds', async () => {
    for (let round = 0; round < 3; round += 1) {
      const ten = await createTenant(t, `race${round}`);
      const second = await addMember(t, ten.owner, [{ role_key: 'company_owner' }]);
      const [x, y] = await Promise.all([
        ten.owner.post(`/v1/cards/${second.card.id}/suspend`, { reason: 'race' }),
        second.client.post(`/v1/cards/${ten.ownerCard.id}/suspend`, { reason: 'race' }),
      ]);
      const statuses = [x.status, y.status].sort();
      // One request wins (200). The other is refused: because it would remove the last Owner (403), because
      // its own card was suspended a moment earlier (401), or because the database aborted it as the loser
      // of the race (409, "please retry" - nothing was changed by it).
      expect(statuses[0]).toBe(200);
      expect([401, 403, 409]).toContain(statuses[1]);
      const active = await su.query(
        `SELECT count(*)::int AS n FROM cards c JOIN card_roles r ON r.card_id = c.id WHERE c.tenant_id = $1 AND r.role_key = 'company_owner' AND c.state = 'active'`,
        [ten.tenantId]);
      expect(active.rows[0].n, `round ${round}: active owners left`).toBe(1);
    }
  });

  it('two Owners remove each other\'s Owner role at the same moment: one Owner always remains', async () => {
    const ten = await createTenant(t, 'racerole');
    await ten.owner.patch('/v1/tenants/current/settings', { enabled_roles: ['company_owner', 'admin', 'expert', 'successor'] });
    // Both Owners also hold the Admin role, so "a card must keep one role" is not what stops the removal.
    const second = await addMember(t, ten.owner, [{ role_key: 'company_owner' }, { role_key: 'admin' }]);
    expect((await second.client.post(`/v1/cards/${ten.ownerCard.id}/roles`, { role_key: 'admin' })).status).toBe(201);
    const first = await login(t, ten.ownerCard, { passkey: ten.ownerPasskey }); // the role change ended its earlier session
    const results = await Promise.all([
      first.del(`/v1/cards/${second.card.id}/roles/company_owner`),
      second.client.del(`/v1/cards/${ten.ownerCard.id}/roles/company_owner`),
    ]);
    expect(results.map((r) => r.status).filter((s) => s === 204)).toHaveLength(1);
    const owners = await su.query(
      `SELECT count(*)::int AS n FROM cards c JOIN card_roles r ON r.card_id = c.id WHERE c.tenant_id = $1 AND r.role_key = 'company_owner' AND c.state = 'active'`,
      [ten.tenantId]);
    expect(owners.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});

describe('one address cannot use up the sign-in allowance of everybody else', () => {
  it('requests rejected by the per-IP limit do not count against the global limit', async () => {
    const t2 = await startApp({ authLimits: { ...DEFAULT_AUTH_LIMITS, loginPerIp: { limit: 3, windowSeconds: 300 }, loginGlobal: { limit: 10, windowSeconds: 60 } } });
    try {
      t2.clock.advance(3_600_000 * 24 * 800); // a fresh window for the shared global bucket
      const from = (ip: string): Client => {
        const c = new Client(t2);
        c.ip = ip;
        return c;
      };
      const flood: number[] = [];
      for (let i = 0; i < 40; i += 1) flood.push((await from('198.51.100.66').request('POST', '/v1/auth/login/begin', { card_number: tenant.ownerCard.number })).status);
      expect(flood.filter((s) => s === 200)).toHaveLength(3);
      expect(flood.filter((s) => s === 429)).toHaveLength(37);
      // 3 of the global 10 are used. Seven other people can still start a sign-in.
      const others: number[] = [];
      for (let i = 0; i < 9; i += 1) others.push((await from(`203.0.113.${100 + i}`).request('POST', '/v1/auth/login/begin', { card_number: tenant.ownerCard.number })).status);
      expect(others).toEqual([200, 200, 200, 200, 200, 200, 200, 429, 429]);
    } finally {
      await t2.close();
    }
  });
});

describe('the cap on simultaneous Argon2 computations is never exceeded', () => {
  it('60 concurrent hashes with a cap of 3: at most 3 run at once, and all complete', async () => {
    const hasher = new SecretCodeHasher({ currentId: 'v1', keys: new Map([['v1', new Secret(Buffer.alloc(32, 9))]]) }, { ...ARGON2_FLOOR, maxConcurrency: 3 });
    let peak = 0;
    const watch = setInterval(() => { peak = Math.max(peak, hasher.running); }, 1);
    const cardId = randomUUID();
    const results = await Promise.all(Array.from({ length: 60 }, async (_, i) => {
      const r = await hasher.hash(cardId, String(i % 1000).padStart(3, '0'));
      peak = Math.max(peak, hasher.running);
      return r;
    }));
    clearInterval(watch);
    expect(results).toHaveLength(60);
    expect(peak).toBeGreaterThanOrEqual(1);
    expect(peak).toBeLessThanOrEqual(3);
    expect(hasher.running).toBe(0);
  });
});

describe('a suspended card cannot be replaced (which would undo the suspension)', () => {
  it('replace on a suspended card is refused; unlock on a revoked card is refused', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }], { login: false });
    await tenant.owner.post(`/v1/cards/${m.card.id}/suspend`, { reason: 'under review' });
    expect((await tenant.owner.post(`/v1/cards/${m.card.id}/replace`, { reason: 'lost' })).status).toBe(409);
    expect((await su.query('SELECT state FROM cards WHERE id = $1', [m.card.id])).rows[0].state).toBe('suspended');
    await tenant.owner.post(`/v1/cards/${m.card.id}/revoke`, { reason: 'done' });
    expect((await tenant.owner.post(`/v1/cards/${m.card.id}/unlock`)).status).toBe(409);
  });
});
