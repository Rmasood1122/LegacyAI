// Bring-your-own-key (feature 21, D35) against the real server and database, with the stand-in key service: a company's
// own key seals its secrets, and switching that key off stops them - without anybody here holding the key.
// Synthetic companies only; the "company key" is random bytes made by this test. The pure rules are in
// test/unit/company-keys.test.ts.
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalKeyService, Secret } from '../../src/modules/platform/index.ts';
import {
  addMember, Client, createTenant, enrollTotp, issueMember, platformOperator, startApp, superuser, tryLogin, type TestApp, type TestTenant,
} from '../helpers/harness.ts';

let t: TestApp;
let su: pg.Client;
const keys = new LocalKeyService(new Map([['acme', new Secret(randomBytes(32))], ['spare', new Secret(randomBytes(32))]]));

beforeAll(async () => {
  // no cache: switching the key off takes effect at once (in production it takes up to the cache time, 5 minutes)
  t = await startApp({ keyService: keys, keyCacheSeconds: 0 }, { KEY_SERVICE: 'local', LOCAL_KEY_SERVICE_KEYS: JSON.stringify({ unused: randomBytes(32).toString('base64') }) });
  su = await superuser();
});
afterAll(async () => {
  keys.enable('acme');
  await su.end();
  await t.close();
});

const keyOf = (op: Client, tenant: TestTenant, keyRef: string | null) =>
  op.request('PUT', `/v1/tenants/${tenant.tenantId}/encryption-key`, { key_ref: keyRef }, { idem: `key-${Math.random()}` });
const totpKeyId = async (cardId: string): Promise<string> =>
  (await su.query(`SELECT totp_key_id FROM credentials WHERE card_id = $1 AND type = 'totp' AND status = 'active'`, [cardId])).rows[0].totp_key_id;
/** A new 30-second step, so that the next authenticator code is not refused as a replay. */
const nextStep = (): void => t.clock.advance(31_000);

describe('setting a company\'s key', () => {
  let tenant: TestTenant;
  let op: Client;
  beforeAll(async () => {
    tenant = await createTenant(t, 'byok-set');
    op = await platformOperator(t);
  });

  it('only the platform operator: the company\'s own Owner cannot read or set it', async () => {
    expect((await tenant.owner.get(`/v1/tenants/${tenant.tenantId}/encryption-key`)).status).toBe(403);
    expect((await keyOf(tenant.owner, tenant, 'local:acme')).status).toBe(403);
  });

  it('a key that does not work, or that the service does not know, is refused before anything is sealed with it', async () => {
    expect((await op.get(`/v1/tenants/${tenant.tenantId}/encryption-key`)).body).toMatchObject({ key_service: 'local', key_ref: null, version: null });
    expect((await keyOf(op, tenant, 'local:nobody')).status).toBe(422);
    expect((await keyOf(op, tenant, 'projects/p/locations/l/keyRings/r/cryptoKeys/k')).status).toBe(422);
    keys.disable('acme');
    expect((await keyOf(op, tenant, 'local:acme')).status).toBe(422);
    keys.enable('acme');
    expect((await su.query('SELECT count(*)::int AS n FROM company_data_keys WHERE tenant_id = $1', [tenant.tenantId])).rows[0].n).toBe(0);
  });

  it('set, changed, cleared: each change is a new version; the company\'s log records an operator action and no reference', async () => {
    expect((await keyOf(op, tenant, 'local:acme')).body).toMatchObject({ key_ref: 'local:acme', version: 1, earlier_versions: 0 });
    expect((await keyOf(op, tenant, 'local:spare')).body).toMatchObject({ key_ref: 'local:spare', version: 2, earlier_versions: 1 });
    expect((await keyOf(op, tenant, null)).body).toMatchObject({ key_ref: null, version: null, earlier_versions: 2 });
    const rows = await su.query(`SELECT actor_kind, reason_code, details::text AS details FROM audit_log WHERE tenant_id = $1 AND action = 'tenant:encryption_key' ORDER BY seq`, [tenant.tenantId]);
    expect(rows.rows.map((r) => [r.actor_kind, r.reason_code])).toEqual([['operator', 'COMPANY_KEY_SET'], ['operator', 'COMPANY_KEY_SET'], ['operator', 'COMPANY_KEY_CLEARED']]);
    for (const r of rows.rows) expect(r.details ?? '').not.toContain('local:');
    // a version never changes, and nothing is deleted
    await expect(su.query(`UPDATE company_data_keys SET key_ref = 'local:other' WHERE tenant_id = $1`, [tenant.tenantId])).rejects.toThrow(/cannot change/);
  });
});

describe('a company that brought its own key', () => {
  let tenant: TestTenant;
  let op: Client;
  let before: { card: Awaited<ReturnType<typeof issueMember>>['card']; secret: string };
  let after: { card: Awaited<ReturnType<typeof issueMember>>['card']; secret: string };
  beforeAll(async () => {
    tenant = await createTenant(t, 'byok-use');
    op = await platformOperator(t);
    const a = (await issueMember(tenant.owner, [{ role_key: 'expert' }])).card;
    before = { card: a, secret: await enrollTotp(t, a) };                       // sealed with the platform's key
    expect((await keyOf(op, tenant, 'local:acme')).status).toBe(200);
    const b = (await issueMember(tenant.owner, [{ role_key: 'expert' }])).card;
    after = { card: b, secret: await enrollTotp(t, b) };                        // sealed with the company's data key
  });

  it('new secrets are sealed with the company\'s data key; earlier ones stay with the platform\'s key', async () => {
    expect(await totpKeyId(after.card.id)).toBe('company:1');
    expect(await totpKeyId(before.card.id)).toBe('k1');
    nextStep();
    expect((await tryLogin(t, after.card.number, after.card.sc, { totp: after.secret })).res.status).toBe(200);
    nextStep();
    expect((await tryLogin(t, before.card.number, before.card.sc, { totp: before.secret })).res.status).toBe(200);
  });

  it('the company switches its key off: what it sealed cannot be opened, and nothing new is sealed with the platform\'s key instead', async () => {
    keys.disable('acme');
    try {
      nextStep();
      expect((await tryLogin(t, after.card.number, after.card.sc, { totp: after.secret })).res.status).toBe(401);
      nextStep();
      expect((await tryLogin(t, before.card.number, before.card.sc, { totp: before.secret })).res.status).toBe(200);   // not the company's key
      // a new authenticator set-up, a new webhook, a new SSO connection: refused, 503
      const c = (await issueMember(tenant.owner, [{ role_key: 'expert' }])).card;
      const begin = await new Client(t).request('POST', '/v1/auth/enrollment/begin', {
        card_number: c.number, sc: c.sc, enrollment_token: c.enrollmentToken, factor_type: 'totp', label: 'App',
      });
      expect(begin.status).toBe(503);
      expect(begin.raw).toContain('company-key-unavailable');
      const hook = await tenant.owner.post('/v1/webhooks', { name: 'x', url: 'https://hooks.example.com/x', topics: ['knowledge.item_released'], max_sensitivity: 0 });
      expect(hook.status).toBe(503);
      const sso = await tenant.owner.request('PUT', '/v1/sso/connection', { name: 'x', issuer: 'https://idp.example.com', client_id: 'x', client_secret: 'x' }, { idem: `s-${Math.random()}` });
      expect(sso.status).toBe(503);
      expect((await su.query(`SELECT count(*)::int AS n FROM webhook_endpoints WHERE tenant_id = $1`, [tenant.tenantId])).rows[0].n).toBe(0);
    } finally {
      keys.enable('acme');
    }
    // switched on again: everything opens as before
    nextStep();
    expect((await tryLogin(t, after.card.number, after.card.sc, { totp: after.secret })).res.status).toBe(200);
  });

  it('the platform\'s key alone opens nothing the company\'s key sealed (the stored value is not the secret)', async () => {
    const row = await su.query(`SELECT totp_secret_enc FROM credentials WHERE card_id = $1 AND type = 'totp' AND status = 'active'`, [after.card.id]);
    expect((row.rows[0].totp_secret_enc as Buffer).toString('latin1')).not.toContain(after.secret);
    const wrapped = await su.query('SELECT wrapped_key FROM company_data_keys WHERE tenant_id = $1', [tenant.tenantId]);
    expect(wrapped.rows).toHaveLength(1);
  });

  it('another company is not affected by this company\'s key', async () => {
    const other = await createTenant(t, 'byok-other');
    const m = await addMember(t, other.owner, [{ role_key: 'expert' }]);
    keys.disable('acme');
    try {
      expect((await m.client.get('/v1/auth/session')).status).toBe(200);
      expect((await other.owner.post('/v1/webhooks', { name: 'x', url: 'https://hooks.example.com/y', topics: ['knowledge.item_released'], max_sensitivity: 0 })).status).toBe(201);
    } finally {
      keys.enable('acme');
    }
  });
});
