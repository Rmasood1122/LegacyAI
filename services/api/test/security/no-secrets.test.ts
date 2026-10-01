// No secret may ever appear in logs, error bodies, the audit log, usage history, stored
// idempotency responses or exports. This test drives the API widely, collecting every secret
// it is handed, then searches everything the system wrote for those exact values.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Notifier } from '../../src/modules/platform/index.ts';
import { DB_URLS, PEPPER_V1, testEnv } from '../helpers/env.ts';
import {
  addMember, Client, createTenant, enrollTotp, fromSecrets, login, startApp, superuser, totpCode, tryLogin, type Res, type TestApp, type TestTenant,
} from '../helpers/harness.ts';

let t: TestApp;
let su: pg.Client;
let tenant: TestTenant;
const secrets = new Map<string, string>(); // value -> what it is
const errorBodies: string[] = [];
const PII_NAME = 'Zebediah Quixote-Featherstonehaugh';
const PII_EMAIL = 'zebediah.quixote@example.test';

const remember = (what: string, value: unknown): void => {
  if (typeof value === 'string' && value.length >= 6) secrets.set(value, what);
};
const cardNumbers = new Set<string>(); // every card number that went through the API, in each spelling
const sawCard = (formatted: string): void => {
  cardNumbers.add(formatted);
  cardNumbers.add(formatted.replace(/\D/g, ''));
  cardNumbers.add(formatted.replace(/^LGY-/, '').replaceAll('-', ' '));
};
const note = (r: Res): Res => {
  if (r.status >= 400) errorBodies.push(r.raw);
  return r;
};

beforeAll(async () => {
  t = await startApp();
  su = await superuser();
  tenant = await createTenant(t, 'nosecrets');

  const env = testEnv();
  remember('internal service token', env.INTERNAL_SERVICE_TOKEN);
  remember('SC pepper', PEPPER_V1);
  remember('HMAC index key', env.HMAC_INDEX_KEY);
  remember('TOTP encryption keyring', env.CREDENTIAL_ENC_KEYRING);
  remember('database password', new URL(DB_URLS.app).password);
  remember('database URL', DB_URLS.app);
  sawCard(tenant.ownerCard.number);
  sawCard(tenant.companyCard.number);
  sawCard('LGY-0000-0000-0000-0000');
  remember('owner enrollment token', tenant.ownerCard.enrollmentToken);
  remember('owner session token', tenant.owner.cookie);
  remember('owner session token (random part)', tenant.owner.cookie!.split('.')[2]);
  remember('owner CSRF token', tenant.owner.csrf);

  // --- a busy day in the life of the API ---
  const person = await tenant.owner.post('/v1/people', { display_name: PII_NAME, email: PII_EMAIL });
  const issued = await tenant.owner.post('/v1/cards', { person_id: person.body.id, roles: [{ role_key: 'admin' }] }, 'nosecrets-issue-1');
  const card = fromSecrets(issued.body);
  sawCard(card.number);
  remember('enrollment token', card.enrollmentToken);
  await tenant.owner.post('/v1/cards', { person_id: person.body.id, roles: [{ role_key: 'admin' }] }, 'nosecrets-issue-1'); // replay

  // TOTP enrollment: the seed and the codes are secrets too.
  const c = new Client(t);
  const begin = await c.request('POST', '/v1/auth/enrollment/begin', { card_number: card.number, sc: card.sc, enrollment_token: card.enrollmentToken, factor_type: 'totp', label: 'phone' });
  remember('TOTP seed', begin.body.totp.secret);
  remember('otpauth URI', begin.body.totp.otpauth_uri);
  remember('enrollment transaction', begin.body.enrollment_txn);
  const code = await totpCode(begin.body.totp.secret, t);
  remember('TOTP code', code);
  await c.request('POST', '/v1/auth/enrollment/complete', { enrollment_txn: begin.body.enrollment_txn, totp_code: code });
  t.clock.advance(31_000);

  // failed logins of every kind
  for (let i = 0; i < 3; i += 1) note((await tryLogin(t, card.number, '999', { totp: begin.body.totp.secret })).res);
  note((await tryLogin(t, card.number, card.sc, { passkey: tenant.ownerPasskey })).res);
  note((await tryLogin(t, '0000 0000 0000 0000', '123', { passkey: tenant.ownerPasskey })).res);
  t.clock.advance(31_000);
  const admin = await login(t, card, { totp: begin.body.totp.secret });
  remember('admin session token', admin.cookie);
  remember('admin CSRF token', admin.csrf);

  // lifecycle operations that mint new secrets
  const member = await addMember(t, admin, [{ role_key: 'expert' }]);
  sawCard(member.card.number);
  remember('member enrollment token', member.card.enrollmentToken);
  remember('member session token', member.client.cookie);
  const token = await admin.post(`/v1/cards/${member.card.id}/enrollment-token`, {}, 'nosecrets-token-1');
  remember('reset enrollment token', token.body.enrollment_token);
  await admin.post(`/v1/cards/${member.card.id}/enrollment-token`, {}, 'nosecrets-token-1'); // replay
  await admin.post(`/v1/cards/${member.card.id}/renew`, {}, 'nosecrets-renew-1');
  await admin.post(`/v1/cards/${member.card.id}/renew`, {}, 'nosecrets-renew-1'); // replay
  const replaced = await admin.post(`/v1/cards/${member.card.id}/replace`, { reason: 'compromised' });
  sawCard(replaced.body.card.card_number);
  remember('replacement enrollment token', replaced.body.enrollment_token);
  const second = await enrollTotp(t, fromSecrets(replaced.body));
  remember('second TOTP seed', second);

  // every kind of error
  note(await tenant.owner.post('/v1/cards', { person_id: 'not-a-uuid', roles: [] }));
  note(await tenant.owner.post('/v1/people', { display_name: PII_NAME, email: PII_EMAIL, unknown_field: card.enrollmentToken }));
  note(await tenant.owner.post('/v1/people', { display_name: 'Dup', email: PII_EMAIL }));
  note(await member.client.post('/v1/people', { display_name: 'x' }));
  note(await tenant.owner.get('/v1/cards/11111111-1111-4111-8111-111111111111'));
  note(await tenant.owner.post(`/v1/cards/${member.card.id}/reinstate`));
  note(await new Client(t).get('/v1/auth/session'));
  note(await new Client(t).get('/v1/no-such-route'));
  note(await new Client(t).request('POST', '/v1/internal/policy/check', {}, { headers: { authorization: 'Bearer wrong-token-value' } }));
  note(await tenant.owner.request('POST', '/v1/people', undefined, { idem: 'nosecrets-raw-1', headers: { 'content-type': 'application/json' } }));
  const malformed = await t.app.http.app.inject({ method: 'POST', url: '/v1/auth/login/begin', headers: { 'content-type': 'application/json' }, payload: `{"card_number": "${card.number}", "sc": ` });
  errorBodies.push(malformed.body);
  const big = await t.app.http.app.inject({ method: 'POST', url: '/v1/auth/login/begin', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ card_number: 'x'.repeat(100_000) }) });
  errorBodies.push(big.body);
  expect([400, 413]).toContain(malformed.statusCode);
  expect(big.statusCode).toBe(413);

  await tenant.owner.post('/v1/exports');
  await tenant.owner.get('/v1/audit/events?limit=100');
});
afterAll(async () => {
  await su.end();
  await t.close();
});

function findLeaks(haystack: string): string[] {
  const hits: string[] = [];
  for (const [value, what] of secrets) if (haystack.includes(value)) hits.push(what);
  return hits;
}

describe('no secrets or personal data where they must not be', () => {
  it('collected a meaningful set of secrets to search for', () => {
    expect(secrets.size).toBeGreaterThanOrEqual(18);
    expect(errorBodies.length).toBeGreaterThanOrEqual(14);
  });

  it('application logs: no secret, no SC field, no card number, no name, no email', () => {
    const logs = t.logs.join('\n');
    expect(logs.length).toBeGreaterThan(1000);
    expect(findLeaks(logs)).toEqual([]);
    expect(logs).not.toContain(PII_NAME);
    expect(logs).not.toContain(PII_EMAIL);
    // Every card number that passed through the API, in every spelling (digits, LGY-dashed, spaced).
    // (A generic "16 digits" pattern would also match response-time decimals in access-log lines.)
    expect(cardNumbers.size).toBeGreaterThanOrEqual(15);
    expect([...cardNumbers].filter((n) => logs.includes(n))).toEqual([]);
    expect(logs).not.toMatch(/"sc"\s*:\s*"\d{3}"/);
    expect(logs).not.toMatch(/postgres:\/\//);
  });

  it('error responses: generic, no stack traces, no internals, no secrets', () => {
    for (const body of errorBodies) {
      expect(findLeaks(body)).toEqual([]);
      expect(body).not.toMatch(/\bat .+\(.+:\d+:\d+\)|node_modules|\.ts:\d+|SELECT |INSERT |UPDATE |violates|constraint|pg_|DENY_|legacyai_app/i);
      expect(body).not.toContain(PII_EMAIL);
      const parsed = JSON.parse(body);
      expect(Object.keys(parsed).every((k) => ['type', 'title', 'status', 'request_id', 'detail', 'errors'].includes(k))).toBe(true);
      expect(String(parsed.type)).toMatch(/^urn:legacyai:problem:[a-z-]+$/);
    }
  });

  it('an unexpected internal error becomes a bare 500 with nothing about the cause', async () => {
    const exploding: Notifier = { notify: async () => { throw new Error('INTERNAL-DETAIL connection string postgres://user:hunter2@db/x'); } };
    const t2 = await startApp({ notifier: exploding });
    try {
      const owner = await login(t2, tenant.ownerCard, { passkey: tenant.ownerPasskey });
      const p = await owner.post('/v1/people', { display_name: 'Boom' });
      const res = await owner.post('/v1/cards', { person_id: p.body.id, roles: [{ role_key: 'expert' }] });
      expect(res.status).toBe(500);
      expect({ ...res.body, request_id: '-' }).toEqual({ type: 'urn:legacyai:problem:internal', title: 'Something went wrong', status: 500, request_id: '-' });
      expect(res.raw).not.toMatch(/INTERNAL-DETAIL|hunter2|postgres|Error|stack/);
      // nothing was half-done: the card insert rolled back with the failed request
      expect((await su.query('SELECT count(*)::int AS n FROM cards WHERE person_id = $1', [p.body.id])).rows[0].n).toBe(0);
      // the failure is in the log for operators, minus anything that looks like a credential
      const logged = t2.logs.join('\n');
      expect(logged).toContain('unhandled error');
      expect(logged).toContain('INTERNAL-DETAIL'); // operators can see what failed...
      expect(logged).not.toContain('hunter2');     // ...but never a password
      expect(logged).toContain('[connection-string]');
    } finally {
      await t2.close();
    }
  });

  it('audit log: no secret in any column, and only whitelisted detail keys', async () => {
    const { rows } = await su.query(`SELECT string_agg(a::text, E'\\n') AS all, count(*)::int AS n FROM audit_log a WHERE tenant_id = $1`, [tenant.tenantId]);
    expect(rows[0].n).toBeGreaterThan(40);
    expect(findLeaks(rows[0].all)).toEqual([]);
    expect(rows[0].all).not.toContain(PII_NAME);
    expect(rows[0].all).not.toContain(PII_EMAIL);
    expect(rows[0].all).not.toMatch(/\b\d{16}\b/);
  });

  it('usage history, login attempts, idempotency store: no secrets', async () => {
    for (const sql of [
      `SELECT string_agg(e::text, E'\\n') AS all FROM card_events e WHERE tenant_id = '${tenant.tenantId}'`,
      `SELECT string_agg(l::text, E'\\n') AS all FROM login_attempts l`,
      `SELECT string_agg(i::text, E'\\n') AS all FROM idempotency_keys i WHERE tenant_id = '${tenant.tenantId}'`,
      `SELECT string_agg(x::text, E'\\n') AS all FROM auth_transactions x`,
    ]) {
      const { rows } = await su.query(sql);
      expect(findLeaks(String(rows[0].all)), sql.slice(0, 60)).toEqual([]);
    }
    const idem = await su.query(`SELECT response_body::text AS b FROM idempotency_keys WHERE tenant_id = $1`, [tenant.tenantId]);
    for (const r of idem.rows) expect(String(r.b)).not.toMatch(/"sc"\s*:|"enrollment_token"\s*:/);
    // login attempts never hold the raw card number - not even for unknown cards
    const attempts = await su.query(`SELECT string_agg(l::text, ' ') AS all FROM login_attempts l`);
    expect(String(attempts.rows[0].all)).not.toMatch(/\b\d{16}\b/);
  });

  it('the database holds no readable SC, token, session or TOTP seed anywhere', async () => {
    const tables = (await su.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).rows.map((r) => r.tablename as string);
    let scanned = 0;
    for (const table of tables) {
      const { rows } = await su.query(`SELECT string_agg(x::text, E'\\n') AS all, count(*)::int AS n FROM ${table} x`);
      scanned += rows[0].n;
      const leaks = findLeaks(String(rows[0].all ?? ''));
      expect(leaks, `table ${table}`).toEqual([]);
    }
    console.log(`NO_SECRETS_SCAN tables=${tables.length} rows=${scanned} secrets_searched=${secrets.size} STATUS=COMPLETE`);
    const hashes = await su.query(`SELECT sc_hash FROM card_secrets WHERE sc_hash IS NOT NULL`);
    expect(hashes.rows.length).toBeGreaterThan(0);
    for (const r of hashes.rows) expect(r.sc_hash).toMatch(/^\$argon2id\$v=19\$m=\d+,/);
  });

  it('tenant export: own data only, in open formats, with no secret columns', () => {
    const base = path.resolve(testEnv().EXPORT_DIR as string, tenant.tenantId);
    const job = readdirSync(base)[0]!;
    const files = readdirSync(path.join(base, job));
    expect(files).toContain('manifest.json');
    expect(files.filter((f) => f.endsWith('.jsonl')).length).toBeGreaterThanOrEqual(6);
    const all = files.map((f) => readFileSync(path.join(base, job, f), 'utf8')).join('\n');
    expect(findLeaks(all)).toEqual([]);
    expect(all).not.toMatch(/sc_hash|\$argon2id|token_hash|totp_secret|webauthn_public_key|pepper/);
    expect(all).toContain(PII_NAME); // an export IS the customer's own data, names included
  });

  it('API responses never include SC hashes or key material, on any read endpoint', async () => {
    for (const url of ['/v1/cards', `/v1/cards/${tenant.ownerCard.id}`, '/v1/auth/session', '/v1/auth/credentials', '/v1/people', '/v1/roles',
      '/v1/tenants/current', '/v1/tenants/current/settings', '/v1/tenants/current/usage', `/v1/cards/${tenant.ownerCard.id}/events`, '/v1/audit/events?limit=100']) {
      const res = await tenant.owner.get(url);
      expect(res.status, url).toBe(200);
      expect(res.raw, url).not.toMatch(/argon2|sc_hash|pepper|token_hash|totp_secret|public_key|csrf_hash/);
      const leaks = findLeaks(res.raw).filter((w) => w !== 'owner CSRF token'); // the session endpoint returns the caller's own CSRF token by design
      expect(leaks, url).toEqual([]);
    }
  });
});
