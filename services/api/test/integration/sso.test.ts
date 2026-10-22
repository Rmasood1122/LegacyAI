// SSO (feature 16, part A; D33): against the real server and database, with a stand-in identity provider (no network).
// Synthetic companies and people only. The pure rules are in test/unit/sso.test.ts.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeIdp } from '../helpers/fake-idp.ts';
import { addMember, Client, issueMember, createTenant, startApp, superuser, type IssuedCard, type Res, type TestApp, type TestTenant } from '../helpers/harness.ts';

let t: TestApp;
let su: pg.Client;
// one provider object serves every company in this file; each company registers it (or another) as its issuer
const idp = new FakeIdp();
const other = new FakeIdp();
const providers = [idp, other];

beforeAll(async () => {
  await idp.start();
  await other.start();
  t = await startApp({ oidcHttp: async (req) => (providers.find((p) => req.url.startsWith(`${p.issuer}/`)) ?? idp).http(req) });
  su = await superuser();
});
afterAll(async () => {
  await su.end();
  await t.close();
});

async function connect(tn: TestTenant, provider = idp, opts: { allow?: boolean; enabled?: boolean } = {}): Promise<Res> {
  const res = await tn.owner.request('PUT', '/v1/sso/connection',
    { name: 'Company sign-in', issuer: provider.issuer, client_id: provider.clientId, client_secret: provider.clientSecret, enabled: opts.enabled ?? true },
    { idem: `sso-${Math.random()}` });
  if (opts.allow !== false) {
    const s = await tn.owner.patch('/v1/tenants/current/settings', { allowed_factor_types: ['passkey', 'totp', 'sso'] });
    if (s.status !== 200) throw new Error(`settings: ${s.status} ${s.raw}`);
  }
  return res;
}

/** Where the provider sent the browser back: /sso/return/<company id>. */
const returnedTo = (redirectUri: string): string => {
  const m = /\/sso\/return\/([0-9a-f-]{36})$/.exec(redirectUri);
  if (m === null) throw new Error(`not a company return address: ${redirectUri}`);
  return m[1] as string;
};

/** The web application's part on return: hands on code, state and the company id from the address. */
const finishAt = (client: Client, back: { state: string; code: string; redirectUri: string }, extra: Record<string, unknown> = {}): Promise<Res> =>
  client.request('POST', '/v1/auth/sso/finish', { state: back.state, code: back.code, tenant_id: returnedTo(back.redirectUri), ...extra });

/** The browser's part: start, sign in at the provider as `sub`, come back. Returns the finish answer. */
async function viaProvider(client: Client, txn: string, sub: string, opts: { company?: string; provider?: FakeIdp } = {}): Promise<Res> {
  const start = await client.request('POST', '/v1/auth/sso/start', { txn, ...(opts.company === undefined ? {} : { company: opts.company }) });
  if (start.status !== 200) return start;
  const provider = providers.find((p) => start.body.authorization_url.startsWith(`${p.issuer}/`)) ?? opts.provider ?? idp;
  const back = provider.authorize(start.body.authorization_url, sub);
  return finishAt(client, back);
}

/** A card's set-up with the company's provider. */
async function enrolWithSso(card: IssuedCard, sub: string, opts: { company?: string } = {}): Promise<Res> {
  const client = new Client(t);
  const begin = await client.request('POST', '/v1/auth/enrollment/begin', {
    card_number: card.number, sc: card.sc, enrollment_token: card.enrollmentToken, factor_type: 'sso', label: 'Company sign-in',
  });
  if (begin.status !== 200) return begin;
  expect(begin.body.factor_type).toBe('sso');
  const back = await viaProvider(client, begin.body.enrollment_txn, sub, opts);
  if (back.status !== 200) return back;
  expect(back.body.purpose).toBe('enroll');
  return client.request('POST', '/v1/auth/enrollment/complete', { enrollment_txn: back.body.enrollment_txn });
}

/** Signing in with the company's provider: card number, company, provider, 3-digit code. */
async function signInWithSso(cardNumber: string, sc: string, sub: string, company: string): Promise<{ client: Client; res: Res }> {
  const client = new Client(t);
  const begin = await client.request('POST', '/v1/auth/login/begin', { card_number: cardNumber });
  const back = await viaProvider(client, begin.body.login_txn, sub, { company });
  if (back.status !== 200) return { client, res: back };
  expect(back.body.purpose).toBe('login');
  const res = await client.request('POST', '/v1/auth/login/verify', { login_txn: back.body.login_txn, sc, factor: { type: 'sso' } });
  return { client, res };
}

describe('the Owner sets up the company\'s provider', () => {
  let tenant: TestTenant;
  beforeAll(async () => {
    tenant = await createTenant(t, 'sso-setup');
  });

  it('the client secret is stored only encrypted, never shown, and reaches neither the audit trail nor the log', async () => {
    expect((await tenant.owner.get('/v1/sso/connection')).body).toMatchObject({ connection: null, redirect_uri: expect.stringMatching(new RegExp(`/sso/return/${tenant.tenantId}$`)) });
    const res = await connect(tenant);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ issuer: idp.issuer, client_id: idp.clientId, enabled: true, has_client_secret: true, protocol: 'oidc' });
    expect(res.raw).not.toContain(idp.clientSecret);
    const row = await su.query('SELECT to_jsonb(c)::text AS whole, client_secret_enc FROM sso_connections c WHERE id = $1', [res.body.id]);
    expect(row.rows[0].whole).not.toContain(idp.clientSecret);
    expect((row.rows[0].client_secret_enc as Buffer).toString('latin1')).not.toContain(idp.clientSecret);
    for (const table of ['audit_log', 'idempotency_keys']) {
      const n = await su.query(`SELECT count(*)::int AS n FROM ${table} x WHERE tenant_id = $1 AND to_jsonb(x)::text LIKE $2`, [tenant.tenantId, `%${idp.clientSecret}%`]);
      expect(n.rows[0].n, table).toBe(0);
    }
    expect(t.logs.join('\n')).not.toContain(idp.clientSecret);
    expect((await tenant.owner.get('/v1/sso/connection')).raw).not.toContain(idp.clientSecret);
  });

  it('another provider needs a new connection; a new connection needs a secret; the issuer must be https', async () => {
    const own = await createTenant(t, 'sso-rules');
    const put = (body: Record<string, unknown>): Promise<Res> => own.owner.request('PUT', '/v1/sso/connection', body, { idem: `x-${Math.random()}` });
    expect((await put({ name: 'x', issuer: idp.issuer, client_id: 'c' })).status).toBe(422);
    expect((await put({ name: 'x', issuer: 'http://idp.example.test', client_id: 'c', client_secret: 's' })).status).toBe(400);
    // the server must not be made to knock on another port, an address literal or an internal name
    for (const issuer of ['https://idp.example.test:22', 'https://203.0.113.9', 'https://idp.corp']) {
      expect((await put({ name: 'x', issuer, client_id: 'c', client_secret: 's' })).status, issuer).toBe(422);
    }
    expect((await put({ name: 'x', issuer: idp.issuer, client_id: 'c', client_secret: 's' })).status).toBe(200);
    expect((await put({ name: 'renamed', issuer: idp.issuer, client_id: 'c2' })).body).toMatchObject({ name: 'renamed', client_id: 'c2', has_client_secret: true });
    const moved = await put({ name: 'x', issuer: other.issuer, client_id: 'c', client_secret: 's' });
    expect(moved.status).toBe(409);
    expect(moved.raw).toContain('sso-issuer-changed');
    await expect(su.query(`UPDATE sso_connections SET issuer = 'https://evil.example.test' WHERE tenant_id = $1`, [own.tenantId])).rejects.toThrow(/cannot change/);
  });

  it('only the Owner: an Admin can neither read, set up nor remove the connection', async () => {
    const admin = await addMember(t, tenant.owner, [{ role_key: 'admin' }]);
    expect((await admin.client.get('/v1/sso/connection')).status).toBe(403);
    expect((await admin.client.request('PUT', '/v1/sso/connection', { name: 'x', issuer: idp.issuer, client_id: 'c', client_secret: 's' }, { idem: 'admin-put-0001' })).status).toBe(403);
    expect((await admin.client.post('/v1/sso/connection/remove')).status).toBe(403);
  });
});

describe('setting up a card, and signing in, with the company\'s provider', () => {
  let tenant: TestTenant;
  let card: IssuedCard;
  beforeAll(async () => {
    tenant = await createTenant(t, 'sso-flow');
    await connect(tenant);
    card = (await issueMember(tenant.owner, [{ role_key: 'expert' }])).card;
  });

  it('set-up links the provider\'s identity to the card; then card + 3-digit code + provider sign the person in', async () => {
    expect((await enrolWithSso(card, 'employee-1001')).status).toBe(204);
    const stored = await su.query(`SELECT type, sso_subject, label FROM credentials WHERE card_id = $1 AND status = 'active'`, [card.id]);
    expect(stored.rows).toEqual([{ type: 'sso', sso_subject: 'employee-1001', label: 'Company sign-in' }]);
    expect((await su.query('SELECT state FROM cards WHERE id = $1', [card.id])).rows[0].state).toBe('active');

    const { client, res } = await signInWithSso(card.number, card.sc, 'employee-1001', tenant.slug);
    expect(res.status).toBe(200);
    expect(res.body.card_id).toBe(card.id);
    expect((await client.get('/v1/auth/session')).status).toBe(200);
    const audit = await su.query(`SELECT details FROM audit_log WHERE tenant_id = $1 AND reason_code = 'LOGIN_OK' AND actor_card_id = $2`, [tenant.tenantId, card.id]);
    const details = audit.rows[audit.rows.length - 1].details as unknown;
    expect(typeof details === 'string' ? details : JSON.stringify(details)).toContain('"factor_type":"sso"');
  });

  it('the provider alone never signs anyone in: a wrong 3-digit code is refused', async () => {
    expect((await signInWithSso(card.number, card.sc === '000' ? '001' : '000', 'employee-1001', tenant.slug)).res.status).toBe(401);
  });

  it('another person at the provider, or the right person through ANOTHER company\'s provider, is refused', async () => {
    expect((await signInWithSso(card.number, card.sc, 'employee-9999', tenant.slug)).res.status).toBe(401);
    // a second company that registered the OTHER provider; its employee "employee-1001" is not this card's person
    const rival = await createTenant(t, 'sso-rival');
    await connect(rival, other);
    expect((await signInWithSso(card.number, card.sc, 'employee-1001', rival.slug)).res.status).toBe(401);
  });

  it('the answer of "start" does not depend on the card: an unknown card gets the same provider address, and fails at the end', async () => {
    const client = new Client(t);
    const begin = await client.request('POST', '/v1/auth/login/begin', { card_number: '4000 0000 0000 0002' });
    const start = await client.request('POST', '/v1/auth/sso/start', { txn: begin.body.login_txn, company: tenant.slug });
    expect(start.status).toBe(200);
    expect(start.body.authorization_url.startsWith(`${idp.issuer}/authorize?`)).toBe(true);
    const back = idp.authorize(start.body.authorization_url, 'employee-1001');
    const finish = await finishAt(client, back);
    expect(finish.status).toBe(200);
    expect((await client.request('POST', '/v1/auth/login/verify', { login_txn: finish.body.login_txn, sc: '123', factor: { type: 'sso' } })).status).toBe(401);
  });

  it('every step is single use: a state, a code and a finished step cannot be used twice', async () => {
    const client = new Client(t);
    const begin = await client.request('POST', '/v1/auth/login/begin', { card_number: card.number });
    const start = await client.request('POST', '/v1/auth/sso/start', { txn: begin.body.login_txn, company: tenant.slug });
    const back = idp.authorize(start.body.authorization_url, 'employee-1001');
    const first = await finishAt(client, back);
    expect(first.status).toBe(200);
    expect((await finishAt(client, back)).status).toBe(401);
    // the original step was swapped for the one that carries the identity: the old token is spent
    expect((await client.request('POST', '/v1/auth/login/verify', { login_txn: begin.body.login_txn, sc: card.sc, factor: { type: 'sso' } })).status).toBe(401);
    const ok = await client.request('POST', '/v1/auth/login/verify', { login_txn: first.body.login_txn, sc: card.sc, factor: { type: 'sso' } });
    expect(ok.status).toBe(200);
    expect((await client.request('POST', '/v1/auth/login/verify', { login_txn: first.body.login_txn, sc: card.sc, factor: { type: 'sso' } })).status).toBe(401);
  });

  it('a sign-in can only be finished in the browser that started it (the flow cookie)', async () => {
    const client = new Client(t);
    const begin = await client.request('POST', '/v1/auth/login/begin', { card_number: card.number });
    const start = await client.request('POST', '/v1/auth/sso/start', { txn: begin.body.login_txn, company: tenant.slug });
    expect(client.flowCookie).not.toBeNull();
    const back = idp.authorize(start.body.authorization_url, 'employee-1001');
    // somebody else's browser (no cookie, or its own cookie from another start) is refused ...
    expect((await finishAt(new Client(t), back)).status).toBe(401);
    const stranger = new Client(t);
    const own = await stranger.request('POST', '/v1/auth/login/begin', { card_number: card.number });
    await stranger.request('POST', '/v1/auth/sso/start', { txn: own.body.login_txn, company: tenant.slug });
    expect((await finishAt(stranger, back)).status).toBe(401);
    // ... and does not spend the flow: the browser that started still can
    expect((await finishAt(client, back)).status).toBe(200);
    expect(client.flowCookie).toBeNull();
  });

  it('mix-up: a code handed on under ANOTHER company\'s return address, or from another provider (iss), is refused', async () => {
    // a hostile company with its own provider: its flow must not receive this company's code, and vice versa
    const hostile = await createTenant(t, 'sso-mixup');
    await connect(hostile, other);
    const client = new Client(t);
    const begin = await client.request('POST', '/v1/auth/login/begin', { card_number: card.number });
    const start = await client.request('POST', '/v1/auth/sso/start', { txn: begin.body.login_txn, company: tenant.slug });
    const back = idp.authorize(start.body.authorization_url, 'employee-1001');
    expect(returnedTo(back.redirectUri)).toBe(tenant.tenantId);
    other.requests.length = 0;
    expect((await finishAt(client, { ...back, redirectUri: back.redirectUri.replace(tenant.tenantId, hostile.tenantId) })).status).toBe(401);
    expect((await finishAt(client, back, { iss: other.issuer })).status).toBe(401);   // (this spends the flow)
    expect(other.requests.filter((r) => r.method === 'POST')).toEqual([]);   // the code never reached the other provider
    // the provider naming itself correctly is fine
    const again = await client.request('POST', '/v1/auth/login/begin', { card_number: card.number });
    const restart = await client.request('POST', '/v1/auth/sso/start', { txn: again.body.login_txn, company: tenant.slug });
    expect((await finishAt(client, idp.authorize(restart.body.authorization_url, 'employee-1001'), { iss: idp.issuer })).status).toBe(200);
  });

  it('switching the connection off stops a sign-in already under way', async () => {
    const client = new Client(t);
    const begin = await client.request('POST', '/v1/auth/login/begin', { card_number: card.number });
    const back = await viaProvider(client, begin.body.login_txn, 'employee-1001', { company: tenant.slug });
    expect(back.status).toBe(200);
    await connect(tenant, idp, { enabled: false });
    expect((await client.request('POST', '/v1/auth/login/verify', { login_txn: back.body.login_txn, sc: card.sc, factor: { type: 'sso' } })).status).toBe(401);
    await connect(tenant, idp, { enabled: true });
  });

  it('the factor "sso" without a sign-in at the provider proves nothing', async () => {
    const client = new Client(t);
    const begin = await client.request('POST', '/v1/auth/login/begin', { card_number: card.number });
    expect((await client.request('POST', '/v1/auth/login/verify', { login_txn: begin.body.login_txn, sc: card.sc, factor: { type: 'sso' } })).status).toBe(401);
  });

  it('one identity at the provider opens one card: linking it to a second card is refused', async () => {
    const second = (await issueMember(tenant.owner, [{ role_key: 'expert' }])).card;
    expect((await enrolWithSso(second, 'employee-1001')).status).toBe(401);
    // the set-up token was not used up: the person can set up another way
    const unused = await su.query('SELECT used_at FROM enrollment_tokens WHERE card_id = $1', [second.id]);
    expect(unused.rows.every((r) => r.used_at === null)).toBe(true);
  });

  it('a company that did not allow the factor, or switched its connection off: no sign-in at the provider', async () => {
    const own = await createTenant(t, 'sso-off');
    await connect(own, idp, { allow: false });
    const c = (await issueMember(own.owner, [{ role_key: 'expert' }])).card;
    expect((await enrolWithSso(c, 'employee-2001')).status).toBe(401);
    const client = new Client(t);
    const begin = await client.request('POST', '/v1/auth/login/begin', { card_number: c.number });
    expect((await client.request('POST', '/v1/auth/sso/start', { txn: begin.body.login_txn, company: own.slug })).status).toBe(401);
    expect((await client.request('POST', '/v1/auth/sso/start', { txn: begin.body.login_txn, company: 'no-such-company' })).status).toBe(401);
  });
});

describe('removing the connection', () => {
  it('revokes every SSO factor linked through it and ends the sessions opened with them', async () => {
    const tenant = await createTenant(t, 'sso-remove');
    await connect(tenant);
    const card = (await issueMember(tenant.owner, [{ role_key: 'expert' }])).card;
    expect((await enrolWithSso(card, 'employee-3001')).status).toBe(204);
    const { client } = await signInWithSso(card.number, card.sc, 'employee-3001', tenant.slug);
    expect((await client.get('/v1/auth/session')).status).toBe(200);

    const removed = await tenant.owner.post('/v1/sso/connection/remove');
    expect(removed.body).toEqual({ removed: true, factors_revoked: 1 });
    expect((await client.get('/v1/auth/session')).status).toBe(401);
    expect((await su.query(`SELECT status FROM credentials WHERE card_id = $1`, [card.id])).rows).toEqual([{ status: 'revoked' }]);
    const row = await su.query('SELECT client_secret_enc, enabled, removed_at IS NOT NULL AS removed FROM sso_connections WHERE tenant_id = $1', [tenant.tenantId]);
    expect(row.rows[0]).toEqual({ client_secret_enc: null, enabled: false, removed: true });
    expect((await tenant.owner.post('/v1/sso/connection/remove')).status).toBe(404);
    expect((await tenant.owner.get('/v1/sso/connection')).body.connection).toBeNull();
    // a new connection to the same provider: the old link does not come back; the person sets up again
    await connect(tenant);
    expect((await signInWithSso(card.number, card.sc, 'employee-3001', tenant.slug)).res.status).toBe(401);
  });
});
