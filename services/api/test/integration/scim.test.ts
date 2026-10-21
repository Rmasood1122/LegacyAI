// SCIM (feature 16, part B; D34): a company directory provisions people with a directory key - against the real server
// and database. Synthetic companies and people only (example.test addresses). The pure rules are in test/unit/scim.test.ts.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenant, startApp, superuser, type Res, type TestApp, type TestTenant } from '../helpers/harness.ts';

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

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A request as a directory makes it: the key in the Authorization header, SCIM's own content type, nothing else. */
async function directory(key: string, method: Method, url: string, body?: unknown): Promise<Res> {
  const res = await t.app.http.app.inject({
    method, url: `/v1/scim/v2${url}`, remoteAddress: '127.0.0.1',
    headers: { 'user-agent': 'legacyai-test-directory', authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/scim+json' }) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  let parsed: unknown = null;
  try {
    parsed = res.body === '' ? null : JSON.parse(res.body);
  } catch {
    parsed = res.body;
  }
  return { status: res.statusCode, body: parsed, headers: res.headers as Record<string, unknown>, raw: res.body };
}

async function directoryKey(tenant: TestTenant): Promise<{ id: string; key: string }> {
  const res = await tenant.owner.post('/v1/api-keys', { name: 'Company directory', scope: ['person:scim'], max_sensitivity: 0, expires_in_days: 30 });
  if (res.status !== 201) throw new Error(`directory key: ${res.status} ${res.raw}`);
  return { id: res.body.id, key: res.body.api_key };
}

const user = (n: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: `${n}@example.test`, externalId: `ext-${n}`,
  name: { givenName: 'Test', familyName: n }, emails: [{ value: `${n}@example.test`, primary: true, type: 'work' }], active: true, ...over,
});

describe('the directory key', () => {
  let tenant: TestTenant;
  beforeAll(async () => {
    tenant = await createTenant(t, 'scim-key');
  });

  it('carries person:scim alone: mixed with anything else it is refused, by the API and by the database', async () => {
    const mixed = await tenant.owner.post('/v1/api-keys', { name: 'x', scope: ['person:scim', 'topic:read'], max_sensitivity: 0, expires_in_days: 30 });
    expect(mixed.status).toBe(422);
    const { id } = await directoryKey(tenant);
    await expect(su.query(`INSERT INTO api_keys (tenant_id, name, created_by_card_id, secret_hash, secret_hint, scope, max_sensitivity, expires_at)
      VALUES ($1, 'x', $2, $3, 'abcd', ARRAY['person:scim', 'topic:read'], 0, now() + interval '1 day')`,
    [tenant.tenantId, tenant.ownerCard.id, Buffer.alloc(32)])).rejects.toThrow(/api_keys_directory_key_alone/);
    expect(id).toBeTruthy();
  });

  it('only a key can use it: the Owner signed in is refused, and the session does not report person:scim', async () => {
    expect((await tenant.owner.get('/v1/scim/v2/Users')).status).toBe(403);
    expect((await tenant.owner.request('POST', '/v1/scim/v2/Users', user('owner-tries'))).status).toBe(403);
    const denied = await su.query(`SELECT reason_code FROM audit_log WHERE tenant_id = $1 AND action = 'person:scim' AND decision = 'deny'`, [tenant.tenantId]);
    expect(denied.rows.map((r) => r.reason_code)).toEqual(['DENY_KEY_ONLY', 'DENY_KEY_ONLY']);
    expect((await tenant.owner.get('/v1/auth/session')).body.permissions).not.toContain('person:scim');
  });

  it('a reading key cannot provision, and a directory key reads no knowledge', async () => {
    const reading = await tenant.owner.post('/v1/api-keys', { name: 'Reader', scope: ['topic:read'], max_sensitivity: 0, expires_in_days: 30 });
    expect((await directory(reading.body.api_key, 'GET', '/Users')).status).toBe(403);
    const { key } = await directoryKey(tenant);
    const topics = await t.app.http.app.inject({ method: 'GET', url: '/v1/topics', headers: { authorization: `Bearer ${key}` } });
    expect(topics.statusCode).toBe(403);
  });
});

describe('provisioning people', () => {
  let tenant: TestTenant;
  let key: string;
  let keyId: string;
  beforeAll(async () => {
    tenant = await createTenant(t, 'scim-flow');
    ({ key, id: keyId } = await directoryKey(tenant));
  });

  it('says what it supports', async () => {
    const res = await directory(key, 'GET', '/ServiceProviderConfig');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ patch: { supported: true }, bulk: { supported: false }, filter: { supported: true } });
  });

  it('creates a person (application/scim+json) - with no card, so with no way in', async () => {
    const res = await directory(key, 'POST', '/Users', user('ada'));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ userName: 'ada@example.test', externalId: 'ext-ada', displayName: 'Test ada', active: true, emails: [{ value: 'ada@example.test', primary: true }] });
    const row = await su.query('SELECT scim_managed, status FROM people WHERE id = $1', [res.body.id]);
    expect(row.rows[0]).toEqual({ scim_managed: true, status: 'active' });
    expect((await su.query('SELECT count(*)::int AS n FROM cards WHERE person_id = $1', [res.body.id])).rows[0].n).toBe(0);
  });

  it('userName is unique in the company whatever its case; so are externalId and the e-mail address', async () => {
    expect((await directory(key, 'POST', '/Users', user('ada', { userName: 'ADA@EXAMPLE.TEST', externalId: 'other', emails: [] }))).status).toBe(409);
    expect((await directory(key, 'POST', '/Users', user('bob', { externalId: 'ext-ada' }))).status).toBe(409);
    expect((await directory(key, 'POST', '/Users', user('bob', { emails: [{ value: 'ada@example.test' }] }))).status).toBe(409);
    expect((await directory(key, 'POST', '/Users', { userName: '' })).status).toBe(400);
  });

  it('finds by userName (any case) and by externalId; lists with SCIM paging', async () => {
    const found = await directory(key, 'GET', `/Users?filter=${encodeURIComponent('userName eq "Ada@Example.test"')}`);
    expect(found.body).toMatchObject({ totalResults: 1, startIndex: 1, itemsPerPage: 1 });
    expect(found.body.Resources[0].userName).toBe('ada@example.test');
    expect((await directory(key, 'GET', `/Users?filter=${encodeURIComponent('externalId eq "ext-ada"')}`)).body.totalResults).toBe(1);
    expect((await directory(key, 'GET', `/Users?filter=${encodeURIComponent('userName eq "nobody@example.test"')}`)).body).toMatchObject({ totalResults: 0, Resources: [] });
    expect((await directory(key, 'GET', `/Users?filter=${encodeURIComponent('displayName co "a"')}`)).status).toBe(400);
    await directory(key, 'POST', '/Users', user('cyd'));
    const page = await directory(key, 'GET', '/Users?startIndex=2&count=1');
    expect(page.body).toMatchObject({ totalResults: 2, startIndex: 2, itemsPerPage: 1 });
  });

  it('sees only the people it manages: the Owner and anyone an administrator added are "not found"', async () => {
    const all = await directory(key, 'GET', '/Users?count=200');
    expect(all.body.Resources.map((r: { userName: string }) => r.userName).sort()).toEqual(['ada@example.test', 'cyd@example.test']);
    const byHand = await tenant.owner.post('/v1/people', { display_name: 'Added by hand' });
    expect((await directory(key, 'GET', `/Users/${byHand.body.id}`)).status).toBe(404);
    expect((await directory(key, 'PATCH', `/Users/${byHand.body.id}`, { Operations: [{ op: 'replace', path: 'active', value: false }] })).status).toBe(404);
    expect((await directory(key, 'DELETE', `/Users/${byHand.body.id}`)).status).toBe(404);
    expect((await su.query('SELECT status FROM people WHERE id = $1', [byHand.body.id])).rows[0].status).toBe('active');
  });

  it('PUT replaces what it manages; PATCH changes single attributes', async () => {
    const id = (await directory(key, 'GET', `/Users?filter=${encodeURIComponent('userName eq "ada@example.test"')}`)).body.Resources[0].id;
    const put = await directory(key, 'PUT', `/Users/${id}`, user('ada', { displayName: 'Ada Lovelace', emails: [{ value: 'ada.l@example.test' }] }));
    expect(put.body).toMatchObject({ displayName: 'Ada Lovelace', emails: [{ value: 'ada.l@example.test', primary: true }] });
    const patched = await directory(key, 'PATCH', `/Users/${id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', path: 'name.familyName', value: 'King' }, { op: 'replace', path: 'name.givenName', value: 'Ada' }],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.displayName).toBe('Ada King');
    expect((await directory(key, 'PATCH', `/Users/${id}`, { Operations: [{ op: 'add', path: 'groups', value: [{ value: 'admins' }] }] })).status).toBe(400);
  });

  it('active false = the person has left: their card is revoked (and its sessions end), as when an administrator does it', async () => {
    const created = await directory(key, 'POST', '/Users', user('dee'));
    const card = await tenant.owner.post('/v1/cards', { person_id: created.body.id, roles: [{ role_key: 'expert' }] });
    expect(card.status).toBe(201);
    const off = await directory(key, 'PATCH', `/Users/${created.body.id}`, { Operations: [{ op: 'Replace', path: 'active', value: 'False' }] });
    expect(off.body.active).toBe(false);
    expect((await su.query('SELECT state, revoked_reason FROM cards WHERE id = $1', [card.body.id])).rows[0]).toEqual({ state: 'revoked', revoked_reason: 'offboarded' });
    expect((await su.query('SELECT status FROM people WHERE id = $1', [created.body.id])).rows[0].status).toBe('departed');
    // back again: the person is active, the card stays revoked (an administrator issues a new one)
    const on = await directory(key, 'PATCH', `/Users/${created.body.id}`, { Operations: [{ op: 'replace', value: { active: true } }] });
    expect(on.body.active).toBe(true);
    expect((await su.query('SELECT state FROM cards WHERE id = $1', [card.body.id])).rows[0].state).toBe('revoked');
  });

  it('DELETE: the person has left and leaves the directory\'s reach (404 from then on); the record and its history stay', async () => {
    const created = await directory(key, 'POST', '/Users', user('eve'));
    expect((await directory(key, 'DELETE', `/Users/${created.body.id}`)).status).toBe(204);
    expect((await directory(key, 'GET', `/Users/${created.body.id}`)).status).toBe(404);
    expect((await directory(key, 'DELETE', `/Users/${created.body.id}`)).status).toBe(404);
    const row = await su.query('SELECT status, scim_managed, scim_user_name, external_id FROM people WHERE id = $1', [created.body.id]);
    expect(row.rows[0]).toEqual({ status: 'departed', scim_managed: false, scim_user_name: null, external_id: null });
    // the same userName can be provisioned again (a returning employee is a new record); the e-mail address still
    // belongs to the departed record, so it is refused until an administrator clears it there
    expect((await directory(key, 'POST', '/Users', user('eve'))).status).toBe(409);
    expect((await directory(key, 'POST', '/Users', user('eve', { emails: [] }))).status).toBe(201);
  });

  it('never reaches an Owner: a person the directory created and an administrator made an Owner is refused', async () => {
    const created = await directory(key, 'POST', '/Users', user('fay'));
    expect((await tenant.owner.post('/v1/cards', { person_id: created.body.id, roles: [{ role_key: 'company_owner' }] })).status).toBe(201);
    expect((await directory(key, 'GET', `/Users/${created.body.id}`)).status).toBe(403);
    expect((await directory(key, 'PATCH', `/Users/${created.body.id}`, { Operations: [{ op: 'replace', path: 'active', value: false }] })).status).toBe(403);
    expect((await directory(key, 'DELETE', `/Users/${created.body.id}`)).status).toBe(403);
    expect((await directory(key, 'GET', '/Users?count=200')).body.Resources.map((r: { id: string }) => r.id)).not.toContain(created.body.id);
    expect((await su.query('SELECT status FROM people WHERE id = $1', [created.body.id])).rows[0].status).toBe('active');
  });

  it('every change is in the audit trail, naming the key - and no name, user name or e-mail address', async () => {
    const rows = (await su.query(`SELECT reason_code, details::text AS details FROM audit_log WHERE tenant_id = $1 AND action = 'person:scim' AND decision = 'event'`, [tenant.tenantId])).rows;
    expect(new Set(rows.map((r) => r.reason_code))).toEqual(new Set(['SCIM_USER_CREATED', 'SCIM_USER_UPDATED', 'SCIM_USER_DEPARTED', 'SCIM_USER_REMOVED']));
    for (const r of rows) {
      expect(r.details).toContain(keyId);
      expect(r.details).not.toMatch(/example\.test|Lovelace|King/);
    }
  });

  it('the directory stops with its maker: revoking the key ends it', async () => {
    expect((await tenant.owner.post(`/v1/api-keys/${keyId}/revoke`)).status).toBe(200);
    expect((await directory(key, 'GET', '/Users')).status).toBe(401);
  });
});

describe('another company', () => {
  it('a directory key of one company sees nothing of another', async () => {
    const a = await createTenant(t, 'scim-a');
    const b = await createTenant(t, 'scim-b');
    const keyA = (await directoryKey(a)).key;
    const keyB = (await directoryKey(b)).key;
    const inB = await directory(keyB, 'POST', '/Users', user(`b-${randomUUID().slice(0, 8)}`));
    expect((await directory(keyA, 'GET', `/Users/${inB.body.id}`)).status).toBe(404);
    expect((await directory(keyA, 'GET', '/Users')).body.totalResults).toBe(0);
  });
});
