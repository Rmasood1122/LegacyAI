// SSO with the providers companies use (decision D39): the connection rules and a Google sign-in, against the real
// server and database. The provider is the test stand-in playing Google's address and quirks (no network, no Google
// account). Synthetic companies and people only. The pure rules are in test/unit/sso-providers.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GOOGLE_ISSUER } from '../../src/modules/identity-access/index.ts';
import { FakeIdp, type TokenTweaks } from '../helpers/fake-idp.ts';
import { Client, createTenant, issueMember, startApp, type IssuedCard, type Res, type TestApp, type TestTenant } from '../helpers/harness.ts';

let t: TestApp;
const google = new FakeIdp({ issuer: GOOGLE_ISSUER });

beforeAll(async () => {
  await google.start();
  t = await startApp({ oidcHttp: (req) => google.http(req) });
});
afterAll(async () => {
  await t.close();
});

const put = (tn: TestTenant, body: Record<string, unknown>): Promise<Res> =>
  tn.owner.request('PUT', '/v1/sso/connection', body, { idem: `sso-${Math.random()}` });
const googleConnection = (domain?: string | null): Record<string, unknown> => ({
  name: 'Google Workspace', issuer: GOOGLE_ISSUER, client_id: google.clientId, client_secret: google.clientSecret, enabled: true,
  ...(domain === undefined ? {} : { allowed_domain: domain }),
});

/** Start at the provider, "sign in" there as `sub` (the token carrying `tweaks`), come back. */
async function viaGoogle(client: Client, txn: string, sub: string, tweaks: TokenTweaks, company?: string): Promise<Res> {
  const start = await client.request('POST', '/v1/auth/sso/start', { txn, ...(company === undefined ? {} : { company }) });
  if (start.status !== 200) return start;
  const back = google.authorize(start.body.authorization_url, sub);
  google.tweakNext = tweaks;
  const tenantId = /\/sso\/return\/([0-9a-f-]{36})$/.exec(back.redirectUri)?.[1];
  return client.request('POST', '/v1/auth/sso/finish', { state: back.state, code: back.code, tenant_id: tenantId });
}
async function enrol(card: IssuedCard, sub: string, tweaks: TokenTweaks): Promise<Res> {
  const client = new Client(t);
  const begin = await client.request('POST', '/v1/auth/enrollment/begin', {
    card_number: card.number, sc: card.sc, enrollment_token: card.enrollmentToken, factor_type: 'sso', label: 'Google',
  });
  if (begin.status !== 200) return begin;
  const back = await viaGoogle(client, begin.body.enrollment_txn, sub, tweaks);
  if (back.status !== 200) return back;
  return client.request('POST', '/v1/auth/enrollment/complete', { enrollment_txn: back.body.enrollment_txn });
}

describe('the connection follows each provider\'s rules', () => {
  let tenant: TestTenant;
  beforeAll(async () => {
    tenant = await createTenant(t, 'sso-rules');
  });

  it('Google without the company\'s domain is refused: any Google account could otherwise be used', async () => {
    const res = await put(tenant, googleConnection());
    expect(res.status).toBe(422);
    expect(res.raw).toContain('Google Workspace domain');
    expect((await put(tenant, googleConnection('Not A Domain'))).status).toBe(400);   // the contract's pattern
  });

  it('Microsoft: a shared address (common, organizations) or a domain name instead of the tenant id is refused, with what to use', async () => {
    for (const tenantPart of ['common', 'organizations', 'contoso.onmicrosoft.com']) {
      const res = await put(tenant, { name: 'Entra', issuer: `https://login.microsoftonline.com/${tenantPart}/v2.0`, client_id: 'c', client_secret: 's' });
      expect(res.status, tenantPart).toBe(422);
      expect(res.raw).toContain('tenant ID');
    }
  });

  it('a domain is refused for any provider but Google', async () => {
    const res = await put(tenant, { name: 'Okta', issuer: 'https://acme.okta.com', client_id: 'c', client_secret: 's', allowed_domain: 'example.com' });
    expect(res.status).toBe(422);
    expect(res.raw).toContain('Google connections only');
  });

  it('Google with its domain: made; the answer names the provider and the domain; the domain can be corrected, not dropped', async () => {
    const made = await put(tenant, googleConnection('example.com'));
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ provider: 'google', issuer: GOOGLE_ISSUER, allowed_domain: 'example.com' });
    const kept = await put(tenant, { name: 'Google', issuer: GOOGLE_ISSUER, client_id: google.clientId });
    expect(kept.body.allowed_domain).toBe('example.com');   // left out = kept
    expect((await put(tenant, { name: 'Google', issuer: GOOGLE_ISSUER, client_id: google.clientId, allowed_domain: 'example.org' })).body.allowed_domain).toBe('example.org');
    expect((await put(tenant, { name: 'Google', issuer: GOOGLE_ISSUER, client_id: google.clientId, allowed_domain: null })).status).toBe(422);
    expect((await tenant.owner.get('/v1/sso/connection')).body.connection).toMatchObject({ provider: 'google', allowed_domain: 'example.org' });
  });
});

describe('signing in with Google', () => {
  let tenant: TestTenant;
  beforeAll(async () => {
    tenant = await createTenant(t, 'sso-google');
    expect((await put(tenant, googleConnection('example.com'))).status).toBe(200);
    const s = await tenant.owner.patch('/v1/tenants/current/settings', { allowed_factor_types: ['passkey', 'totp', 'sso'] });
    expect(s.status).toBe(200);
  });

  it('a card is set up with an account of the company\'s domain - also when the token says Google\'s issuer without https://', async () => {
    const { card } = await issueMember(tenant.owner, [{ role_key: 'expert' }]);
    const res = await enrol(card, '104500000000000000001', { hd: 'example.com', issuer: 'accounts.google.com' });
    expect(res.status).toBe(200);
    expect(google.asked.at(-1)).toEqual({ prompt: 'select_account', hd: 'example.com' });
  });

  it('a personal Google account (no domain) or another company\'s account cannot set a card up: one 401', async () => {
    for (const tweaks of [{}, { hd: 'other.example' }] as TokenTweaks[]) {
      const { card } = await issueMember(tenant.owner, [{ role_key: 'expert' }]);
      expect((await enrol(card, '104500000000000000002', tweaks)).status).toBe(401);
    }
  });
});
