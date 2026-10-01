// Sessions: cookie flags, storage, timeouts, CSRF, rotation, and INSTANT revocation when a
// card is suspended, revoked, locked or expires.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/modules/platform/index.ts';
import { TEST_ORIGIN } from '../helpers/env.ts';
import { addMember, Client, createTenant, login, startApp, superuser, tryLogin, type TestApp, type TestTenant } from '../helpers/harness.ts';

let t: TestApp;
let su: pg.Client;
let tenant: TestTenant;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

beforeAll(async () => {
  t = await startApp();
  su = await superuser();
  tenant = await createTenant(t, 'sessions');
});
afterAll(async () => {
  await su.end();
  await t.close();
});

describe('the session cookie', () => {
  it('is HttpOnly, Secure, SameSite=Strict, host-only, and the token is opaque', async () => {
    const c = new Client(t);
    const begin = await c.request('POST', '/v1/auth/login/begin', { card_number: tenant.ownerCard.number });
    const res = await t.app.http.app.inject({
      method: 'POST', url: '/v1/auth/login/verify', headers: { origin: TEST_ORIGIN },
      payload: { login_txn: begin.body.login_txn, sc: tenant.ownerCard.sc, factor: { type: 'passkey', assertion: tenant.ownerPasskey.assert(begin.body.webauthn_options) } },
    });
    expect(res.statusCode).toBe(200);
    const header = String(res.headers['set-cookie']);
    expect(header.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(SESSION_COOKIE.startsWith('__Host-')).toBe(true);
    expect(header).toMatch(/; HttpOnly/);
    expect(header).toMatch(/; Secure/);
    expect(header).toMatch(/; SameSite=Strict/);
    expect(header).toMatch(/; Path=\//);
    expect(header).not.toMatch(/Domain=/i);
    expect(header).not.toMatch(/Expires=|Max-Age=/i); // a browser-session cookie; lifetime is enforced server-side
    const token = res.cookies[0]!.value;
    expect(token).toMatch(/^v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('only a SHA-256 of the token is stored: a database leak does not leak usable sessions', async () => {
    const client = await login(t, tenant.ownerCard, { passkey: tenant.ownerPasskey });
    const hash = createHash('sha256').update(client.cookie!).digest();
    const { rows } = await su.query('SELECT token_hash, csrf_hash FROM sessions WHERE token_hash = $1', [hash]);
    expect(rows).toHaveLength(1);
    const dump = await su.query(`SELECT string_agg(s::text, ' ') AS all FROM sessions s WHERE card_id = $1`, [tenant.ownerCard.id]);
    expect(dump.rows[0].all).not.toContain(client.cookie!.split('.')[2]);
    expect(dump.rows[0].all).not.toContain(client.csrf!);
  });

  it.each([
    ['no cookie', undefined],
    ['empty cookie', ''],
    ['garbage', 'not-a-session'],
    ['right shape, random token', 'v1.11111111-1111-4111-8111-111111111111.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['card number and SC', '4821937601527730:123'],
  ])('%s -> 401', async (_name, value) => {
    const res = await t.app.http.app.inject({ method: 'GET', url: '/v1/auth/session', ...(value === undefined ? {} : { cookies: { [SESSION_COOKIE]: value } }) });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('a real token with one character changed -> 401', async () => {
    const client = await login(t, tenant.ownerCard, { passkey: tenant.ownerPasskey });
    const last = client.cookie!.slice(-1);
    const tampered = client.cookie!.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    const res = await t.app.http.app.inject({ method: 'GET', url: '/v1/auth/session', cookies: { [SESSION_COOKIE]: tampered } });
    expect(res.statusCode).toBe(401);
  });
});

describe('timeouts (30 minutes idle, 12 hours absolute by default)', () => {
  beforeEach(() => t.clock.reset());

  it('idle: unused for 31 minutes -> signed out', async () => {
    const c = await login(t, tenant.ownerCard, { passkey: tenant.ownerPasskey });
    t.clock.advance(29 * MIN);
    expect((await c.get('/v1/auth/session')).status).toBe(200); // activity extends it
    t.clock.advance(29 * MIN);
    expect((await c.get('/v1/auth/session')).status).toBe(200);
    t.clock.advance(31 * MIN);
    expect((await c.get('/v1/auth/session')).status).toBe(401);
  });

  it('absolute: even with constant activity the session ends after 12 hours', async () => {
    const c = await login(t, tenant.ownerCard, { passkey: tenant.ownerPasskey });
    for (let i = 0; i < 35; i += 1) {
      t.clock.advance(20 * MIN);
      expect((await c.get('/v1/auth/session')).status, `after ${(i + 1) * 20} minutes`).toBe(200);
    }
    t.clock.advance(25 * MIN); // 12h05m
    expect((await c.get('/v1/auth/session')).status).toBe(401);
  });

  it('logout ends the session immediately and clears the cookie', async () => {
    const c = await login(t, tenant.ownerCard, { passkey: tenant.ownerPasskey });
    const old = c.cookie!;
    const res = await c.request('POST', '/v1/auth/logout');
    expect(res.status).toBe(204);
    expect(c.cookie).toBeNull();
    const again = await t.app.http.app.inject({ method: 'GET', url: '/v1/auth/session', cookies: { [SESSION_COOKIE]: old } });
    expect(again.statusCode).toBe(401);
    const row = await su.query('SELECT revoked_reason FROM sessions WHERE token_hash = $1', [createHash('sha256').update(old).digest()]);
    expect(row.rows[0].revoked_reason).toBe('logout');
  });
});

describe('CSRF protection on state-changing requests', () => {
  let c: Client;
  beforeAll(async () => {
    t.clock.reset();
    c = await login(t, tenant.ownerCard, { passkey: tenant.ownerPasskey });
  });

  const people = async () => (await su.query('SELECT count(*)::int AS n FROM people WHERE tenant_id = $1', [tenant.tenantId])).rows[0].n;

  it.each([
    ['no CSRF token', { noCsrf: true }],
    ['wrong CSRF token', { headers: { 'x-csrf-token': 'wrong' }, noCsrf: true }],
    ['another session\'s CSRF token', { other: true }],
    ['no Origin header', { origin: null }],
    ['an Origin that is not on the allow-list', { origin: 'https://evil.example.test' }],
    ['Origin "null"', { origin: 'null' }],
  ])('%s -> 403 and nothing happens', async (_name, opts: any) => {
    const before = await people();
    if (opts.other) {
      const otherSession = await login(t, tenant.ownerCard, { passkey: tenant.ownerPasskey });
      opts = { headers: { 'x-csrf-token': otherSession.csrf! }, noCsrf: true };
    }
    const res = await c.request('POST', '/v1/people', { display_name: 'CSRF Victim' }, { idem: 'csrf-test-key-1', ...opts });
    expect(res.status).toBe(403);
    expect(await people()).toBe(before);
  });

  it('with the right token and Origin the same request succeeds; GET needs neither', async () => {
    expect((await c.post('/v1/people', { display_name: 'Legit' })).status).toBe(201);
    const res = await t.app.http.app.inject({ method: 'GET', url: '/v1/auth/session', cookies: { [SESSION_COOKIE]: c.cookie! } });
    expect(res.statusCode).toBe(200);
  });

  it('CORS: only the allow-listed origin is echoed, with credentials', async () => {
    const ok = await t.app.http.app.inject({ method: 'OPTIONS', url: '/v1/cards', headers: { origin: TEST_ORIGIN, 'access-control-request-method': 'POST' } });
    expect(ok.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const bad = await t.app.http.app.inject({ method: 'OPTIONS', url: '/v1/cards', headers: { origin: 'https://evil.example.test', 'access-control-request-method': 'POST' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('security headers are present on every response', async () => {
    const res = await t.app.http.app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'none'");
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});

describe('instant revocation', () => {
  beforeEach(() => t.clock.reset());

  it('suspend: the very next request with the old session fails; reinstating does not bring it back', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    expect((await m.client.get('/v1/auth/session')).status).toBe(200);
    expect((await tenant.owner.post(`/v1/cards/${m.card.id}/suspend`, { reason: 'test' })).status).toBe(200);
    expect((await m.client.get('/v1/auth/session')).status).toBe(401);
    expect((await tryLogin(t, m.card.number, m.card.sc, { passkey: m.passkey })).res.status).toBe(401);
    expect((await tenant.owner.post(`/v1/cards/${m.card.id}/reinstate`)).status).toBe(200);
    expect((await m.client.get('/v1/auth/session')).status).toBe(401); // old session stays dead
    expect((await tryLogin(t, m.card.number, m.card.sc, { passkey: m.passkey })).res.status).toBe(200); // a new login works
  });

  it('revoke: session dead, login impossible, forever', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    expect((await tenant.owner.post(`/v1/cards/${m.card.id}/revoke`, { reason: 'test' })).status).toBe(200);
    expect((await m.client.get('/v1/auth/session')).status).toBe(401);
    expect((await tryLogin(t, m.card.number, m.card.sc, { passkey: m.passkey })).res.status).toBe(401);
  });

  it('even if the session row were NOT revoked, a suspended card is refused (state is re-read on every request)', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    // Bypass the API: flip the card state directly, leaving the session row untouched.
    await su.query(`UPDATE cards SET state = 'suspended' WHERE id = $1`, [m.card.id]);
    const live = await su.query('SELECT count(*)::int AS n FROM sessions WHERE card_id = $1 AND revoked_at IS NULL', [m.card.id]);
    expect(live.rows[0].n).toBe(1);
    expect((await m.client.get('/v1/auth/session')).status).toBe(401);
  });

  it('role change on a card ends that card\'s sessions', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    expect((await tenant.owner.post(`/v1/cards/${m.card.id}/roles`, { role_key: 'admin' })).status).toBe(201);
    expect((await m.client.get('/v1/auth/session')).status).toBe(401);
    const again = await login(t, m.card, { passkey: m.passkey });
    expect((await again.get('/v1/auth/session')).body.roles.sort()).toEqual(['admin', 'expert']);
  });

  it('privilege change for the caller rotates the caller\'s own session id', async () => {
    const other = await createTenant(t, 'rotate');
    const old = other.owner.cookie!;
    const res = await other.owner.patch('/v1/tenants/current/settings', { pilot_reviewer_grant: false });
    expect(res.status).toBe(200);
    expect(other.owner.cookie).not.toBe(old);
    const stale = await t.app.http.app.inject({ method: 'GET', url: '/v1/auth/session', cookies: { [SESSION_COOKIE]: old } });
    expect(stale.statusCode).toBe(401);
    expect((await other.owner.get('/v1/auth/session')).status).toBe(200);
  });
});

describe('expiry: 14-day read-only grace, then nothing (except Owner export)', () => {
  it('walks a card through expiry, grace and lapse with no background job running', async () => {
    t.clock.reset();
    const ten = await createTenant(t, 'expiry');
    const admin = await addMember(t, ten.owner, [{ role_key: 'admin' }]);

    // Day 89: renew the COMPANY card and the Owner card so only the admin's card expires at day 90.
    t.clock.advance(89 * DAY);
    let owner = await login(t, ten.ownerCard, { passkey: ten.ownerPasskey });
    const company = await owner.post(`/v1/cards/${ten.companyCard.id}/renew`, {});
    expect(company.status).toBe(200);
    const ownerRenew = await owner.post(`/v1/cards/${ten.ownerCard.id}/renew`, {});
    expect(ownerRenew.status).toBe(200);
    const ownerCard = { number: ten.ownerCard.number, sc: ownerRenew.body.sc as string };
    owner = await login(t, ownerCard, { passkey: ten.ownerPasskey }); // renewal rotated the SC and ended the session

    // 10 minutes before the admin card expires: normal.
    t.clock.advance(DAY - 10 * MIN);
    let c = await login(t, admin.card, { passkey: admin.passkey });
    expect((await c.get('/v1/auth/session')).body).toMatchObject({ card_state: 'active', read_only: false, export_only: false });
    expect((await c.post('/v1/people', { display_name: 'Before Expiry' })).status).toBe(201);

    // 10 minutes after expiry, same session: read-only.
    t.clock.advance(20 * MIN);
    const inGrace = await c.get('/v1/auth/session');
    expect(inGrace.status).toBe(200);
    expect(inGrace.body).toMatchObject({ card_state: 'expired', read_only: true, export_only: false });
    expect((await c.get('/v1/cards')).status).toBe(200);
    expect((await c.post('/v1/people', { display_name: 'During Grace' })).status).toBe(403);
    expect((await su.query(`SELECT 1 FROM people WHERE display_name = 'During Grace'`)).rowCount).toBe(0);

    // A NEW login during grace also works, and is also read-only.
    t.clock.advance(5 * DAY);
    c = await login(t, admin.card, { passkey: admin.passkey });
    expect((await c.get('/v1/auth/session')).body.read_only).toBe(true);
    expect((await c.post(`/v1/cards/${admin.card.id}/renew`, {})).status).toBe(403); // cannot renew itself out of grace

    // Day 104+: grace is over. Session dead, login refused.
    t.clock.advance(9 * DAY + HOUR);
    expect((await c.get('/v1/auth/session')).status).toBe(401);
    expect((await tryLogin(t, admin.card.number, admin.card.sc, { passkey: admin.passkey })).res.status).toBe(401);
    const reason = await su.query('SELECT real_reason FROM login_attempts WHERE card_id = $1 ORDER BY id DESC LIMIT 1', [admin.card.id]);
    expect(reason.rows[0].real_reason).toBe('expired');

    // The Owner renews it: new SC, works again.
    owner = await login(t, ownerCard, { passkey: ten.ownerPasskey });
    const renewed = await owner.post(`/v1/cards/${admin.card.id}/renew`, {});
    expect(renewed.status).toBe(200);
    expect(renewed.body.card.state).toBe('active');
    const back = await login(t, { number: admin.card.number, sc: renewed.body.sc }, { passkey: admin.passkey });
    expect((await back.get('/v1/auth/session')).body).toMatchObject({ card_state: 'active', read_only: false });
    t.clock.reset();
  });

  it('"data export is always free": after the grace window the Owner can still sign in, export, and nothing else', async () => {
    t.clock.reset();
    const ten = await createTenant(t, 'lapsed');
    t.clock.advance(120 * DAY); // owner card AND company card are 16 days past grace
    const owner = await login(t, ten.ownerCard, { passkey: ten.ownerPasskey });
    const s = await owner.get('/v1/auth/session');
    expect(s.body).toMatchObject({ card_state: 'expired', read_only: true, export_only: true });
    expect((await owner.get('/v1/cards')).status).toBe(403);
    expect((await owner.post('/v1/people', { display_name: 'After Lapse' })).status).toBe(403);
    const exp = await owner.post('/v1/exports');
    expect(exp.status).toBe(202);
    expect((await owner.get(`/v1/exports/${exp.body.id}`)).status).toBe(200);
    t.clock.reset();
  });

  it('when the COMPANY card is in grace the whole tenant is read-only, even for cards that are still valid', async () => {
    t.clock.reset();
    const ten = await createTenant(t, 'cograce');
    t.clock.advance(80 * DAY);
    let owner = await login(t, ten.ownerCard, { passkey: ten.ownerPasskey });
    const ownerRenew = await owner.post(`/v1/cards/${ten.ownerCard.id}/renew`, {}); // owner card now valid to day 170
    t.clock.advance(11 * DAY); // day 91: company card expired yesterday
    owner = await login(t, { number: ten.ownerCard.number, sc: ownerRenew.body.sc }, { passkey: ten.ownerPasskey });
    expect((await owner.get('/v1/auth/session')).body).toMatchObject({ card_state: 'active', read_only: true });
    expect((await owner.post('/v1/people', { display_name: 'Tenant Grace' })).status).toBe(403);
    expect((await owner.get('/v1/cards')).status).toBe(200);
    const audit = await su.query(`SELECT reason_code FROM audit_log WHERE tenant_id = $1 AND decision = 'deny' ORDER BY seq DESC LIMIT 1`, [ten.tenantId]);
    expect(audit.rows[0].reason_code).toBe('DENY_TENANT_GRACE_READ_ONLY');
    t.clock.reset();
  });
});
