// Contract tests. openapi.yaml is the source of truth:
//  - the server validates every REQUEST against it,
//  - with VALIDATE_RESPONSES=true (all tests) the server validates every RESPONSE against it
//    and turns a mismatch into a 500 - so every 2xx in the whole suite is a conformance check,
//  - this file walks all 47 operations successfully at least once, and proves the validator
//    really fires on a non-conforming response.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTRACT_PATH } from '../../src/app.ts';
import {
  createHttpServer, createLogger, loadConfig, loadContract, PostgresIdempotencyStore, type AuthPort,
} from '../../src/modules/platform/index.ts';
import { systemClock } from '../../src/shared/clock.ts';
import { testEnv } from '../helpers/env.ts';
import {
  addMember, Client, createTenant, enrollPasskey, fromSecrets, platformOperator, startApp, tryLogin, VirtualPasskey, type Res, type TestApp, type TestTenant,
} from '../helpers/harness.ts';

let t: TestApp;
let tenant: TestTenant;
beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t, 'contract');
});
afterAll(async () => t.close());

/** Paths of the Phase 2 (knowledge) operations. */
const PHASE2_PATH = /^\/v1\/(sources|knowledge|interviews|gaps|topics|job-roles|expert-questions|readiness|consents|review|redaction|quality|ai|me\/(consents|contributions)|people\/\{person_id\}\/consent-withdrawals|tenants\/\{tenant_id\}\/ai-budget|platform\/(ai|storage)|topic-templates)(\/|$)/;

describe('the contract file', () => {
  it('is OpenAPI 3.1 with 141 operations (46 from Phase 1, 78 from Phase 2, 17 from Phase 4), all under /v1, each with a unique operationId', () => {
    const c = loadContract(CONTRACT_PATH);
    expect(c.operations.size).toBe(141);
    for (const op of c.operations.values()) {
      expect(op.path.startsWith('/v1/')).toBe(true);
      expect(op.responses.size).toBeGreaterThanOrEqual(2);
      expect([...op.responses.keys()].some((s) => s >= 200 && s < 300)).toBe(true);
      expect(op.responses.has(429), `${op.operationId} declares 429`).toBe(true);
      if (!op.isPublic) expect(op.responses.has(401) && op.responses.has(403), `${op.operationId} declares 401/403`).toBe(true);
    }
  });

  it('pagination, errors and idempotency are defined once and reused', async () => {
    const { readFileSync } = await import('node:fs');
    const yaml = readFileSync(CONTRACT_PATH, 'utf8');
    const count = (needle: string): number => yaml.split(needle).length - 1;
    expect(count('$ref: "#/components/parameters/Limit"')).toBe(7);   // + listAnomalyEvents
    expect(count('$ref: "#/components/parameters/Cursor"')).toBe(19);   // 13 + listReadinessAttempts, listExpertQuestions, listMyConsents (listJobRoles has its own, longer name cursor)
    expect(count('$ref: "#/components/parameters/IdempotencyKey"')).toBe(77);   // + anomaly settings, leaving date (set, clear), apply a template
    expect(count('$ref: "#/components/responses/TooManyRequests"')).toBe(141);
    expect(yaml).toContain('openapi: 3.1.0');
  });
});

describe('response validation really fires (seen firing)', () => {
  const server = async (body: unknown, status = 200) => {
    const auth: AuthPort = { tenantOfToken: () => null, resolveSession: async () => null, authorize: async () => ({ effect: 'deny', reason_code: 'X', obligations: [] }), recordDecision: async () => undefined };
    const s = await createHttpServer({
      config: loadConfig(testEnv()), db: t.app.db, log: createLogger('silent'), clock: systemClock, auth,
      rateLimiter: { hit: async () => ({ allowed: true, retryAfterSeconds: 0 }) }, idempotency: new PostgresIdempotencyStore(), contractPath: CONTRACT_PATH,
    });
    s.defineRoutes([{ operationId: 'getHealth', kind: 'public', policy: { public: true, reason: 'contract test fixture route' }, handler: async () => ({ status, body }) }]);
    return s;
  };

  it.each([
    ['a conforming body', { status: 'ok', version: '1' }, 200, 200],
    ['a wrong value', { status: 'fine', version: '1' }, 200, 500],
    ['a missing field', { status: 'ok' }, 200, 500],
    ['an extra field (e.g. a leaked secret)', { status: 'ok', version: '1', sc_hash: 'x' }, 200, 500],
    ['a wrong type', { status: 'ok', version: 1 }, 200, 500],
    ['a status code the contract does not declare', { status: 'ok', version: '1' }, 201, 500],
  ])('%s -> %s', async (_name, body, status, expected) => {
    const s = await server(body, status as number);
    const res = await s.app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(expected);
    if (expected === 500) expect(res.body).not.toContain('sc_hash');
    await s.app.close();
  });

  it('with validation switched off the same bad response would go out - which is why tests run with it on', async () => {
    const auth: AuthPort = { tenantOfToken: () => null, resolveSession: async () => null, authorize: async () => ({ effect: 'deny', reason_code: 'X', obligations: [] }), recordDecision: async () => undefined };
    const s = await createHttpServer({
      config: loadConfig(testEnv({ VALIDATE_RESPONSES: 'false' })), db: t.app.db, log: createLogger('silent'), clock: systemClock, auth,
      rateLimiter: { hit: async () => ({ allowed: true, retryAfterSeconds: 0 }) }, idempotency: new PostgresIdempotencyStore(), contractPath: CONTRACT_PATH,
    });
    s.defineRoutes([{ operationId: 'getHealth', kind: 'public', policy: { public: true, reason: 'contract test fixture route' }, handler: async () => ({ body: { status: 'fine' } }) }]);
    expect((await s.app.inject({ method: 'GET', url: '/v1/health' })).statusCode).toBe(200);
    expect(loadConfig(testEnv()).validateResponses).toBe(true);
    await s.app.close();
  });
});

describe('request validation on every endpoint', () => {
  it.each([
    ['unknown property', 'POST', '/v1/people', { display_name: 'x', is_admin: true }],
    ['wrong type', 'POST', '/v1/people', { display_name: 42 }],
    ['missing required field', 'POST', '/v1/people', {}],
    ['empty string where text is required', 'POST', '/v1/people', { display_name: '' }],
    ['too long', 'POST', '/v1/people', { display_name: 'x'.repeat(201) }],
    ['invalid email', 'POST', '/v1/people', { display_name: 'x', email: 'not-an-email' }],
    ['array instead of object', 'POST', '/v1/people', []],
    ['bad enum', 'POST', '/v1/departments', { name: 'ok', kind: 'x' }],
    ['invalid uuid in body', 'POST', '/v1/cards', { person_id: 'abc', roles: [{ role_key: 'expert' }] }],
    ['invalid role', 'POST', '/v1/cards', { person_id: '11111111-1111-4111-8111-111111111111', roles: [{ role_key: 'emperor' }] }],
    ['SQL in a field with a pattern', 'POST', '/v1/tenants', { name: 'x', slug: "x'; DROP TABLE cards;--", owner_display_name: 'x' }],
    ['restriction with a bad time', 'PUT', '/v1/cards/11111111-1111-4111-8111-111111111111/restrictions', { restrictions: [{ type: 'time_window', enabled: true, config: { timezone: 'UTC', days: [1], start: '25:00', end: '26:00' } }] }],
    ['restriction of unknown type', 'PUT', '/v1/cards/11111111-1111-4111-8111-111111111111/restrictions', { restrictions: [{ type: 'moon', enabled: true, config: {} }] }],
    ['restriction without a type', 'PUT', '/v1/cards/11111111-1111-4111-8111-111111111111/restrictions', { restrictions: [{ enabled: true, config: {} }] }],
    ['network range with an empty prefix (would mean "everything")', 'PUT', '/v1/cards/11111111-1111-4111-8111-111111111111/restrictions', { restrictions: [{ type: 'network_allowlist', enabled: true, config: { cidrs: ['10.0.0.0/'] } }] }],
    ['audit verify range beyond any possible sequence', 'POST', '/v1/audit/verify', { from_seq: 1e30 }],
    ['empty settings patch', 'PATCH', '/v1/tenants/current/settings', {}],
    ['settings: unknown key', 'PATCH', '/v1/tenants/current/settings', { is_platform: true }],
  ])('%s -> 400 with field-level problems and no echo of the input', async (_name, method, url, body) => {
    const res = await tenant.owner.request(method as 'POST', url, body, { idem: `val-${Math.random().toString(36).slice(2)}-key` });
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.type).toBe('urn:legacyai:problem:bad-request');
    expect(Array.isArray(res.body.errors) && res.body.errors.length > 0).toBe(true);
    expect(res.raw).not.toContain('DROP TABLE');
  });

  it.each([
    ['path id that is not a uuid', '/v1/cards/1%20OR%201=1'],
    ['limit too large', '/v1/cards?limit=101'],
    ['limit zero', '/v1/cards?limit=0'],
    ['limit not a number', '/v1/cards?limit=ten'],
    ['unknown query parameter', '/v1/cards?admin=true'],
    ['bad filter value', '/v1/cards?state=banana'],
    ['garbage cursor', '/v1/cards?cursor=%00%00'],
    ['cursor that is not an id', `/v1/cards?cursor=${Buffer.from('abc').toString('base64url')}`],
    ['audit cursor that is not a number', `/v1/audit/events?cursor=${Buffer.from('abc').toString('base64url')}`],
    ['audit cursor too large', `/v1/audit/events?cursor=${Buffer.from('9'.repeat(40)).toString('base64url')}`],
    ['upper-case uuid in the path', '/v1/cards/11111111-1111-4111-8111-11111111AAAA'],
    ['urn-style uuid in the path', '/v1/cards/urn:uuid:11111111-1111-4111-8111-111111111111'],
    ['cursor with SQL', `/v1/cards?cursor=${Buffer.from("' OR 1=1 --").toString('base64url')}`],
  ])('query/path: %s -> 400', async (_name, url) => {
    expect((await tenant.owner.get(url)).status).toBe(400);
  });

  it('SQL injection attempts in text fields are stored as plain text and change nothing else', async () => {
    const evil = `Robert'); DROP TABLE cards; --`;
    const created = await tenant.owner.post('/v1/people', { display_name: evil });
    expect(created.status).toBe(201);
    expect(created.body.display_name).toBe(evil);
    expect((await tenant.owner.get('/v1/cards')).status).toBe(200);
    const filtered = await tenant.owner.get(`/v1/audit/events?action=${encodeURIComponent("x' OR '1'='1")}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.items).toEqual([]);
  });

  it('request size limit: a body over 64 KiB is refused', async () => {
    const res = await tenant.owner.post('/v1/people', { display_name: 'x', email: null, department_id: null, pad: 'y'.repeat(70_000) });
    expect(res.status).toBe(413);
  });

  it('pagination walks the full list with no repeats and no gaps', async () => {
    for (let i = 0; i < 7; i += 1) await tenant.owner.post('/v1/people', { display_name: `Page ${i}` });
    const all = (await tenant.owner.get('/v1/people?limit=100')).body.items.map((p: any) => p.id);
    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Res = await tenant.owner.get(`/v1/people?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      expect(page.status).toBe(200);
      expect(page.body.items.length).toBeLessThanOrEqual(3);
      walked.push(...page.body.items.map((p: any) => p.id));
      cursor = page.body.next_cursor;
    } while (cursor !== null);
    expect(walked).toEqual(all);
    expect(new Set(walked).size).toBe(walked.length);
  });
});

describe('every one of the 47 operations returns a contract-conforming success', () => {
  it('walks them all (responses are validated by the server; a mismatch would be a 500)', async () => {
    const hit = new Set<string>();
    const ok = (id: string, res: Res, status: number): Res => {
      expect(res.status, `${id}: ${res.raw}`).toBe(status);
      hit.add(id);
      return res;
    };
    const o = tenant.owner;
    const anon = new Client(t);

    ok('getHealth', await anon.get('/v1/health'), 200);
    ok('getReady', await anon.get('/v1/ready'), 200);

    // platform operator
    const op = await platformOperator(t);
    const created = ok('createTenant', await op.post('/v1/tenants', { name: 'Walk Co', slug: `walk-${Date.now().toString(36)}`, owner_display_name: 'Walk Owner', owner_email: 'walk.owner@example.test' }), 201);
    expect(created.body.company_card.card.kind).toBe('company');
    ok('listTenants', await op.get('/v1/tenants?limit=2'), 200);
    const companyRenewed = ok('renewCompanyCard', await op.post(`/v1/tenants/${created.body.tenant.id}/company-card/renew`, { validity_days: 30 }), 200);
    expect(companyRenewed.body.card.kind).toBe('company');
    const recovered = ok('recoverOwnerCard', await op.post(`/v1/tenants/${created.body.tenant.id}/owner-recovery`, { card_id: created.body.owner_card.card.id, verification_reference: 'CASE-2026-0001' }), 201);
    expect(recovered.body.notified_owner_count).toBe(0);

    // tenant + settings
    ok('getCurrentTenant', await o.get('/v1/tenants/current'), 200);
    ok('getTenantSettings', await o.get('/v1/tenants/current/settings'), 200);
    ok('updateTenantSettings', await o.patch('/v1/tenants/current/settings', { renewal_notice_days: 10, enabled_roles: ['company_owner', 'admin', 'expert', 'successor', 'department_manager', 'auditor'] }), 200);
    ok('getTenantUsage', await o.get('/v1/tenants/current/usage'), 200);

    // people, departments
    const dept = ok('createDepartment', await o.post('/v1/departments', { name: 'Maintenance' }), 201);
    ok('listDepartments', await o.get('/v1/departments'), 200);
    const person = ok('createPerson', await o.post('/v1/people', { display_name: 'Walk Person', email: 'Walk.Person@Example.test', department_id: dept.body.id }), 201);
    expect(person.body.email).toBe('walk.person@example.test');
    ok('listPeople', await o.get(`/v1/people?department_id=${dept.body.id}&status=active`), 200);
    ok('getPerson', await o.get(`/v1/people/${person.body.id}`), 200);
    ok('updatePerson', await o.patch(`/v1/people/${person.body.id}`, { display_name: 'Walk Person II', department_id: null }), 200);

    // cards
    const issued = ok('issueCard', await o.post('/v1/cards', { person_id: person.body.id, roles: [{ role_key: 'expert' }, { role_key: 'department_manager', department_id: dept.body.id }] }), 201);
    const card = fromSecrets(issued.body);
    ok('listCards', await o.get('/v1/cards?kind=person&state=issued&limit=5'), 200);
    ok('getCard', await o.get(`/v1/cards/${card.id}`), 200);

    // enrollment + login (public)
    const eb = ok('enrollmentBegin', await anon.request('POST', '/v1/auth/enrollment/begin', { card_number: card.number, sc: card.sc, enrollment_token: card.enrollmentToken, factor_type: 'passkey', label: 'walk' }), 200);
    const key = new VirtualPasskey();
    ok('enrollmentComplete', await anon.request('POST', '/v1/auth/enrollment/complete', { enrollment_txn: eb.body.enrollment_txn, attestation: key.attest(eb.body.webauthn_options) }), 204);
    const member = new Client(t);
    const lb = ok('loginBegin', await member.request('POST', '/v1/auth/login/begin', { card_number: card.number }), 200);
    ok('loginVerify', await member.request('POST', '/v1/auth/login/verify', { login_txn: lb.body.login_txn, sc: card.sc, factor: { type: 'passkey', assertion: key.assert(lb.body.webauthn_options) } }), 200);
    ok('getSession', await member.get('/v1/auth/session'), 200);
    const creds = ok('listOwnCredentials', await member.get('/v1/auth/credentials'), 200);
    expect(creds.body.items).toHaveLength(1);

    // second factor so one can be removed
    const tok = ok('issueEnrollmentToken', await o.post(`/v1/cards/${card.id}/enrollment-token`, { revoke_existing: false }), 201);
    const eb2 = await anon.request('POST', '/v1/auth/enrollment/begin', { card_number: card.number, sc: card.sc, enrollment_token: tok.body.enrollment_token, factor_type: 'totp' });
    const { generate } = await import('otplib');
    await anon.request('POST', '/v1/auth/enrollment/complete', { enrollment_txn: eb2.body.enrollment_txn, totp_code: await generate({ secret: eb2.body.totp.secret, epoch: Math.floor(t.clock.now().getTime() / 1000) }) });
    expect((await member.get('/v1/auth/credentials')).status).toBe(401); // adding a factor by token ends existing sessions
    const lb2 = await member.request('POST', '/v1/auth/login/begin', { card_number: card.number });
    expect((await member.request('POST', '/v1/auth/login/verify', { login_txn: lb2.body.login_txn, sc: card.sc, factor: { type: 'passkey', assertion: key.assert(lb2.body.webauthn_options) } })).status).toBe(200);
    const two = await member.get('/v1/auth/credentials');
    expect(two.body.items).toHaveLength(2);
    ok('removeOwnCredential', await member.request('DELETE', `/v1/auth/credentials/${two.body.items[1].id}`), 204);
    expect((await member.request('DELETE', `/v1/auth/credentials/${two.body.items[0].id}`)).status).toBe(409); // last one stays

    // roles
    ok('listRoles', await o.get('/v1/roles'), 200);
    ok('listCardRoles', await o.get(`/v1/cards/${card.id}/roles`), 200);
    ok('assignCardRole', await o.post(`/v1/cards/${card.id}/roles`, { role_key: 'successor' }), 201);
    ok('removeCardRole', await o.del(`/v1/cards/${card.id}/roles/successor`), 204);
    ok('replaceCardRoles', await o.put(`/v1/cards/${card.id}/roles`, { roles: [{ role_key: 'expert' }] }), 200);

    // restrictions, history
    ok('putCardRestrictions', await o.put(`/v1/cards/${card.id}/restrictions`, { restrictions: [
      { type: 'usage_cap', enabled: true, config: { limit_key: 'requests', window_seconds: 3600, max_count: 1000 } },
      { type: 'time_window', enabled: false, config: { timezone: 'Europe/Berlin', days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' } },
      { type: 'network_allowlist', enabled: false, config: { cidrs: ['10.0.0.0/8', '2001:db8::/32'] } },
      { type: 'read_only', enabled: false, config: {} },
    ] }), 200);
    ok('getCardRestrictions', await o.get(`/v1/cards/${card.id}/restrictions`), 200);
    ok('listCardEvents', await o.get(`/v1/cards/${card.id}/events?event_type=issued`), 200);

    // lifecycle
    ok('suspendCard', await o.post(`/v1/cards/${card.id}/suspend`, { reason: 'walk' }), 200);
    ok('reinstateCard', await o.post(`/v1/cards/${card.id}/reinstate`), 200);
    const renewed = ok('renewCard', await o.post(`/v1/cards/${card.id}/renew`, { validity_days: 30 }), 200);
    // lock it (valid passkey, wrong SC x5) so unlock has something to do
    const wrong = String((Number(renewed.body.sc) + 1) % 1000).padStart(3, '0');
    for (let i = 0; i < 5; i += 1) await tryLogin(t, card.number, wrong, { passkey: key });
    ok('unlockCard', await o.post(`/v1/cards/${card.id}/unlock`), 200);
    const replaced = ok('replaceCard', await o.post(`/v1/cards/${card.id}/replace`, { reason: 'damaged' }), 201);
    ok('revokeCard', await o.post(`/v1/cards/${replaced.body.card.id}/revoke`, { reason: 'walk done' }), 200);

    // anomaly lock and retirement radar (Phase 4, features 5 and 11)
    ok('getAnomalySettings', await o.get('/v1/tenants/current/anomaly-settings'), 200);
    ok('updateAnomalySettings', await o.patch('/v1/tenants/current/anomaly-settings', { denials_threshold: 50, second_address_enabled: false }), 200);
    ok('listAnomalyEvents', await o.get('/v1/anomalies?limit=5'), 200);
    const leavingOn = new Date(t.clock.now().getTime() + 200 * 86_400_000).toISOString().slice(0, 10);
    ok('setLeavingDate', await o.put(`/v1/people/${person.body.id}/leaving-date`, { leaving_on: leavingOn }), 200);
    ok('getLeavingDate', await o.get(`/v1/people/${person.body.id}/leaving-date`), 200);
    const radar = ok('getRetirementRadar', await o.get('/v1/retirement-radar'), 200);
    expect(radar.body.items.map((e: { person_id: string }) => e.person_id)).toContain(person.body.id);
    ok('clearLeavingDate', await o.del(`/v1/people/${person.body.id}/leaving-date`), 204);

    // audit, export
    ok('listAuditEvents', await o.get('/v1/audit/events?limit=3&decision=allow'), 200);
    ok('verifyAuditChain', await o.request('POST', '/v1/audit/verify', { from_seq: 1 }), 200);
    const exp = ok('createExport', await o.post('/v1/exports'), 202);
    ok('getExport', await o.get(`/v1/exports/${exp.body.id}`), 200);

    ok('logout', await member.request('POST', '/v1/auth/logout'), 401); // the member's session ended when the card was replaced...
    hit.delete('logout');
    const fresh = await addMember(t, o, [{ role_key: 'expert' }]);
    ok('logout', await fresh.client.request('POST', '/v1/auth/logout'), 204);

    // Phase 2 operations need the AI service: they are walked, with the real service, by test/contract/phase2-walk.test.ts.
    const all = [...t.app.http.contract.operations.values()].filter((op) => !PHASE2_PATH.test(op.path)).map((op) => op.operationId).sort();
    expect([...hit].sort()).toEqual(all);
    expect(hit.size).toBe(46 + 7);   // Phase 1, plus the seven anomaly-lock and retirement-radar operations of Phase 4
    expect(t.app.http.contract.operations.size).toBe(46 + 78 + 5 + 7 + 2);
  });
});

describe('errors use one format everywhere (RFC 9457 problem details)', () => {
  it('400, 401, 403, 404, 409, 413, 422, 429 all validate against the Problem schema', async () => {
    const o = tenant.owner;
    const expert = await addMember(t, o, [{ role_key: 'expert' }]);
    const p = await o.post('/v1/people', { display_name: 'Err' });
    const samples: Array<[number, Res]> = [
      [400, await o.post('/v1/people', {})],
      [401, await new Client(t).get('/v1/cards')],
      [401, await new Client(t).request('POST', '/v1/auth/login/verify', { login_txn: 'A'.repeat(43), sc: '123', factor: { type: 'totp', code: '000000' } })],
      [403, await expert.client.post('/v1/people', { display_name: 'x' })],
      [404, await o.get('/v1/cards/11111111-1111-4111-8111-111111111111')],
      [404, await o.get('/v1/nope')],
      [409, await o.post(`/v1/cards/${expert.card.id}/reinstate`)],
      [413, await o.post('/v1/people', { display_name: 'y'.repeat(70_000) })],
      [422, await o.post('/v1/cards', { person_id: p.body.id, roles: [{ role_key: 'contractor' }] })],
    ];
    for (const [status, res] of samples) {
      expect(res.status).toBe(status);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(t.app.http.contract.validateProblem(res.body), `${status}: ${res.raw}`).toBe(true);
      expect(res.body.status).toBe(status);
      expect(res.body.request_id).toBe(res.headers['x-request-id']);
    }
  });

  it('a bearer token is not accepted by session endpoints, and the removed internal endpoint is gone', async () => {
    for (const bad of [`Bearer ${testEnv().SERVICE_TOKEN_KEY}`, 'Bearer wrong', `Basic ${testEnv().SERVICE_TOKEN_KEY}`]) {
      const res = await t.app.http.app.inject({ method: 'GET', url: '/v1/cards', headers: { authorization: bad } });
      expect(res.statusCode, bad).toBe(401);
    }
    const gone = await t.app.http.app.inject({
      method: 'POST', url: '/v1/internal/policy/check', headers: { authorization: `Bearer ${testEnv().SERVICE_TOKEN_KEY}` },
      payload: { tenant_id: tenant.tenantId },
    });
    expect(gone.statusCode).toBe(404);
  });
});

// keep imports used
void enrollPasskey;
