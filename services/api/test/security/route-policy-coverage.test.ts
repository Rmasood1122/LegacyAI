// Every route must go through the policy decision point. This file proves it four ways:
// registration refuses unprotected routes, the public list is pinned, a deny really blocks
// every protected operation, and handlers contain no access decisions of their own.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTRACT_PATH } from '../../src/app.ts';
import {
  createHttpServer, createLogger, loadConfig, PLATFORM_TENANT_ID, PostgresIdempotencyStore,
  honoursFilter, type AuthPort, type HttpServer, type ListFilter, type RouteDef,
} from '../../src/modules/platform/index.ts';
import { systemClock } from '../../src/shared/clock.ts';
import type { Decision, Obligation, CardSubject } from '../../src/shared/policy-types.ts';
import { TEST_ORIGIN, testEnv } from '../helpers/env.ts';
import { addMember, createTenant, startApp, superuser, type TestApp, type TestMember, type TestTenant } from '../helpers/harness.ts';

let t: TestApp;
let tenant: TestTenant;
let successor: TestMember;
beforeAll(async () => {
  t = await startApp();
  tenant = await createTenant(t, 'coverage');
  successor = await addMember(t, tenant.owner, [{ role_key: 'successor' }]);
});
afterAll(async () => t.close());

const FAKE_TOKEN = `v1.${PLATFORM_TENANT_ID}.${'A'.repeat(43)}`;
const fakeSubject = (): CardSubject => ({
  kind: 'card', tenant_id: PLATFORM_TENANT_ID, card_id: randomUUID(), card_number: '0000000000000000', person_id: null, department_id: null,
  card_state: 'active', activated_at: new Date(), expires_at: new Date(Date.now() + 1e9), grace_until: new Date(Date.now() + 2e9),
  renewal_due: new Date(), locked: false, roles: [], is_platform_tenant: true, session_id: randomUUID(),
  session_idle_expires_at: new Date(), session_absolute_expires_at: new Date(),
});

/** A bare HTTP layer with a scripted policy decision point, to test the layer itself. */
async function bareServer(decision: Decision, calls: string[] = []): Promise<HttpServer> {
  const auth: AuthPort = {
    tenantOf: () => PLATFORM_TENANT_ID,
    resolveCredential: async () => ({ kind: 'session', subject: fakeSubject(), csrfToken: 'csrf' }),
    auditDetails: () => ({}),
    authorize: async (_tx, _s, action) => {
      calls.push(action);
      return decision;
    },
    recordDecision: async (_tx, _s, action, _r, d) => {
      calls.push(`recorded ${action} ${d.effect}`);
    },
  };
  return createHttpServer({
    config: loadConfig(testEnv()), db: t.app.db, log: createLogger('silent'), clock: systemClock, auth,
    rateLimiter: { hit: async () => ({ allowed: true, retryAfterSeconds: 0 }) }, idempotency: new PostgresIdempotencyStore(),
    contractPath: CONTRACT_PATH,
  });
}
const allow = (obligations: Obligation[] = []): Decision => ({ effect: 'allow', reason_code: 'ALLOW', obligations });
const tenantRoute = (handler: () => Promise<{ body: unknown }>): RouteDef => ({
  operationId: 'getCurrentTenant', kind: 'session',
  policy: { resource: async () => ({ type: 'tenant', tenant_id: PLATFORM_TENANT_ID }) },
  handler,
});
const tenantBody = { id: PLATFORM_TENANT_ID, name: 'x', slug: 'x', status: 'active', plan_code: 'pilot', region: 'us', created_at: new Date().toISOString() };

describe('a route cannot exist without policy metadata', () => {
  it('registering a route directly on Fastify makes the server refuse to start (seen firing)', async () => {
    const server = await bareServer(allow());
    expect(() => server.app.get('/v1/rogue', async () => ({ leaked: true }))).toThrow(/without defineRoutes\(\); it has no policy check/);
    expect(() => server.app.post('/v1/rogue', async () => ({}))).toThrow(/no policy check/);
    expect(() => server.app.route({ method: 'DELETE', url: '/v1/rogue', handler: async () => ({}) })).toThrow(/no policy check/);
    await server.app.close();
  });

  it('defineRoutes refuses: unknown operation, duplicate, public flag that disagrees with the contract, public without a reason', async () => {
    const server = await bareServer(allow());
    const ok = async (): Promise<{ body: unknown }> => ({ body: {} });
    expect(() => server.defineRoutes([{ operationId: 'notInTheContract', kind: 'public', policy: { public: true, reason: 'made up for the test' }, handler: ok }])).toThrow(/not an operation in openapi.yaml/);
    // a protected operation declared public in code:
    expect(() => server.defineRoutes([{ operationId: 'listCards', kind: 'public', policy: { public: true, reason: 'trying to open it up' }, handler: ok }])).toThrow(/differs from openapi.yaml/);
    // a public operation declared protected in code is also a mismatch:
    expect(() => server.defineRoutes([{ operationId: 'getHealth', kind: 'session', policy: { resource: async () => null }, handler: ok }])).toThrow(/differs from openapi.yaml/);
    expect(() => server.defineRoutes([{ operationId: 'getHealth', kind: 'public', policy: { public: true, reason: 'short' }, handler: ok }])).toThrow(/needs a written reason/);
    server.defineRoutes([tenantRoute(ok)]);
    expect(() => server.defineRoutes([tenantRoute(ok)])).toThrow(/registered twice/);
    await server.app.close();
  });

  it('the contract itself cannot declare a protected operation without a permission', () => {
    const yaml = readFileSync(CONTRACT_PATH, 'utf8');
    for (const op of t.app.http.contract.operations.values()) {
      if (!op.isPublic) expect(op.permission, op.operationId).toMatch(/^[a-z_]+:[a-z_]+$/);
    }
    expect(yaml).toContain('x-permission');
  });
});

describe('the list of routes that skip the session check is short and pinned', () => {
  it('public = exactly these seven (six without any data, and the signed messages of the payment provider); there are no service-to-service routes on the public API', () => {
    const routes = t.app.http.registeredRoutes();
    expect(routes.filter((r) => r.kind === 'public').map((r) => r.operationId).sort()).toEqual(
      ['enrollmentBegin', 'enrollmentComplete', 'getHealth', 'getReady', 'loginBegin', 'loginVerify', 'receivePaymentEvent']);
    expect(routes.every((r) => r.kind === 'public' || r.kind === 'session' || r.kind === 'gateway')).toBe(true);
    for (const r of routes.filter((x) => x.kind === 'public')) expect(r.publicReason!.length).toBeGreaterThan(20);
  });

  it('every other route (113) is a session or gateway route with a permission that exists in the permission table', async () => {
    const su = await superuser();
    const known = new Set((await su.query('SELECT permission_key FROM permissions')).rows.map((r) => r.permission_key as string));
    await su.end();
    const session = t.app.http.registeredRoutes().filter((r) => r.kind === 'session' || r.kind === 'gateway');
    expect(session).toHaveLength(162);
    for (const r of session) expect(known.has(r.permission!), `${r.operationId} uses unknown permission ${r.permission}`).toBe(true);
  });

  it('routes registered in the server == operations in openapi.yaml (169, no more, no fewer)', () => {
    const registered = t.app.http.registeredRoutes().map((r) => `${r.method} ${r.path}`).sort();
    const contract = [...t.app.http.contract.operations.values()].map((o) => `${o.method} ${o.path}`).sort();
    expect(registered).toEqual(contract);
    expect(registered).toHaveLength(169);
    // and Fastify itself knows no route beyond those (HEAD/OPTIONS helpers aside)
    const printed = t.app.http.app.printRoutes({ commonPrefix: false });
    expect(printed).not.toMatch(/rogue/);
  });
});

describe('the handler never runs unless the policy decision point said allow', () => {
  it('deny -> 403, handler not called, decision was asked for the contract permission', async () => {
    const calls: string[] = [];
    let ran = 0;
    const server = await bareServer({ effect: 'deny', reason_code: 'DENY_DEFAULT', obligations: [] }, calls);
    server.defineRoutes([tenantRoute(async () => { ran += 1; return { body: tenantBody }; })]);
    const res = await server.app.inject({ method: 'GET', url: '/v1/tenants/current', cookies: { '__Host-lai_session': FAKE_TOKEN } });
    expect(res.statusCode).toBe(403);
    expect(ran).toBe(0);
    expect(calls).toEqual(['tenant:read', 'recorded tenant:read deny']); // asked, and the denial was written down
    await server.app.close();
  });

  it('allow -> handler runs exactly once', async () => {
    let ran = 0;
    const calls: string[] = [];
    const server = await bareServer(allow(), calls);
    server.defineRoutes([tenantRoute(async () => { ran += 1; return { body: tenantBody }; })]);
    const res = await server.app.inject({ method: 'GET', url: '/v1/tenants/current', cookies: { '__Host-lai_session': FAKE_TOKEN } });
    expect(res.statusCode).toBe(200);
    expect(ran).toBe(1);
    expect(calls).toEqual(['tenant:read', 'recorded tenant:read allow']); // every decision is recorded, allow included
    await server.app.close();
  });

  it.each([
    ['an effect that is neither allow nor deny', { effect: 'maybe', reason_code: 'X', obligations: [] }],
    ['an allow carrying an obligation this layer does not understand', { effect: 'allow', reason_code: 'ALLOW', obligations: [{ type: 'require_blood_sample' }] }],
  ])('%s -> refused, handler not called', async (_name, decision) => {
    let ran = 0;
    const server = await bareServer(decision as unknown as Decision);
    server.defineRoutes([tenantRoute(async () => { ran += 1; return { body: tenantBody }; })]);
    const res = await server.app.inject({ method: 'GET', url: '/v1/tenants/current', cookies: { '__Host-lai_session': FAKE_TOKEN } });
    expect(res.statusCode).toBe(403);
    expect(ran).toBe(0);
    await server.app.close();
  });

  it('a policy point that throws -> 500, handler not called', async () => {
    let ran = 0;
    const server = await bareServer(allow());
    (server as any); // same server type; replace authorize via a new server with a throwing port:
    await server.app.close();
    const auth: AuthPort = {
      tenantOf: () => PLATFORM_TENANT_ID,
      resolveCredential: async () => ({ kind: 'session', subject: fakeSubject(), csrfToken: 'csrf' }),
      auditDetails: () => ({}),
      authorize: async () => { throw new Error('policy store unavailable'); },
      recordDecision: async () => undefined,
    };
    const s2 = await createHttpServer({
      config: loadConfig(testEnv()), db: t.app.db, log: createLogger('silent'), clock: systemClock, auth,
      rateLimiter: { hit: async () => ({ allowed: true, retryAfterSeconds: 0 }) }, idempotency: new PostgresIdempotencyStore(), contractPath: CONTRACT_PATH,
    });
    s2.defineRoutes([tenantRoute(async () => { ran += 1; return { body: tenantBody }; })]);
    const res = await s2.app.inject({ method: 'GET', url: '/v1/tenants/current', cookies: { '__Host-lai_session': FAKE_TOKEN } });
    expect(res.statusCode).toBe(500);
    expect(ran).toBe(0);
    await s2.app.close();
  });
});

describe('a read of a whole collection must say how it is narrowed to what the caller may see', () => {
  const FILTER: Obligation[] = [{ type: 'filter' }];
  const rolesRoute = (listFilter: ListFilter | undefined, onRun: () => void): RouteDef => ({
    operationId: 'listRoles', kind: 'session', ...(listFilter === undefined ? {} : { listFilter }),
    policy: { resource: async () => ({ type: 'role', tenant_id: PLATFORM_TENANT_ID, collection: true }) },
    handler: async () => { onRun(); return { body: { items: [] } }; },
  });
  const get = (server: HttpServer) => server.app.inject({ method: 'GET', url: '/v1/roles', cookies: { '__Host-lai_session': FAKE_TOKEN } });

  it.each([
    ['declares nothing', undefined],
    ['declares that it does not filter', { unfiltered: 'the same list for the whole company' }],
  ] as const)('the policy asks for a filter and the route %s -> refused, handler not called, the denial is recorded', async (_name, declared) => {
    const calls: string[] = [];
    let ran = 0;
    const server = await bareServer(allow(FILTER), calls);
    server.defineRoutes([rolesRoute(declared, () => { ran += 1; })]);
    expect((await get(server)).statusCode).toBe(403);
    expect(ran).toBe(0);
    expect(calls).toEqual(['role:read', 'recorded role:read deny']);
    await server.app.close();
  });

  it.each(['applied', 'delegated'] as const)('the policy asks for a filter and the route declares "%s" -> the handler runs', async (declared) => {
    let ran = 0;
    const server = await bareServer(allow(FILTER));
    server.defineRoutes([rolesRoute(declared, () => { ran += 1; })]);
    await get(server);
    expect(ran).toBe(1);
    await server.app.close();
  });

  it('a list route that declares nothing is refused even when no filter was asked for (so it cannot be forgotten)', async () => {
    const calls: string[] = [];
    let ran = 0;
    const server = await bareServer(allow(), calls);
    server.defineRoutes([rolesRoute(undefined, () => { ran += 1; })]);
    expect((await get(server)).statusCode).toBe(403);
    expect(ran).toBe(0);
    expect(calls).toEqual(['role:read', 'recorded role:read deny']);
    await server.app.close();
  });

  it('a company-wide route called with a company-wide grant is not affected', async () => {
    let ran = 0;
    const server = await bareServer(allow());
    server.defineRoutes([rolesRoute({ unfiltered: 'the same list for the whole company' }, () => { ran += 1; })]);
    await get(server);
    expect(ran).toBe(1);
    await server.app.close();
  });

  it('the declarations of the real app are pinned: adding or changing one is a deliberate act', () => {
    const declared = Object.fromEntries(t.app.http.registeredRoutes().filter((r) => r.listFilter !== null)
      .map((r) => [r.operationId, typeof r.listFilter === 'string' ? r.listFilter : 'unfiltered']));
    expect(declared).toEqual({
      listCards: 'applied', listPeople: 'applied', listConsents: 'applied', listReviewTasks: 'applied', listSources: 'applied',
      listInterviews: 'applied', listTopics: 'applied', listJobRoles: 'applied', getRoleTopics: 'applied', getRolePeople: 'applied',
      listReadinessAttempts: 'applied', listAnomalyEvents: 'applied', getRetirementRadar: 'applied',
      askKnowledge: 'delegated', listKnowledgeItems: 'delegated', getGapReport: 'delegated', listExpertQuestions: 'delegated',
      listQuizQuestions: 'delegated', getGraphNeighbourhood: 'delegated', listScenarios: 'delegated', listScenarioAttempts: 'delegated',
      listRoles: 'unfiltered', listDepartments: 'unfiltered', listTenants: 'unfiltered', listAuditEvents: 'unfiltered',
      verifyAuditChain: 'unfiltered', listRedactionAllowlist: 'unfiltered', getKnowledgeSettings: 'unfiltered', getAiBudget: 'unfiltered',
      getPlatformStorage: 'unfiltered', getQualitySummary: 'unfiltered', listAnswerFeedback: 'unfiltered',
      getActivity: 'unfiltered', listInvoices: 'unfiltered', listApiKeys: 'unfiltered', getApiKeyOptions: 'unfiltered',
    });
    for (const r of t.app.http.registeredRoutes()) {
      if (r.listFilter !== null && typeof r.listFilter !== 'string') expect(r.listFilter.unfiltered.length, r.operationId).toBeGreaterThan(20);
    }
  });

  it('table: for every seeded role, which company-wide routes refuse it because its grant is narrower than the company', async () => {
    const su = await superuser();
    // read permissions a role holds ONLY at a scope narrower than the company
    const { rows } = await su.query<{ role_key: string; permission_key: string }>(
      `SELECT rp.role_key, rp.permission_key FROM role_permissions rp JOIN permissions p USING (permission_key)
        WHERE NOT p.is_write
        GROUP BY rp.role_key, rp.permission_key HAVING bool_and(rp.scope <> 'tenant')`);
    await su.end();
    const narrow = new Map<string, string[]>();
    for (const r of rows) narrow.set(r.permission_key, [...(narrow.get(r.permission_key) ?? []), r.role_key].sort());
    const refused: Record<string, string[]> = {};
    for (const r of t.app.http.registeredRoutes()) {
      if (r.listFilter === null || honoursFilter(r.listFilter)) continue;
      const roles = narrow.get(r.permission as string);
      if (roles !== undefined) refused[r.operationId] = roles;
    }
    // Today exactly one: the redaction allow-list has no department, and the Department Manager's review:read is
    // department-wide. A new narrower grant on a company-wide route shows up here before it reaches anyone.
    expect(refused).toEqual({ listRedactionAllowlist: ['department_manager'] });
  });

  it('real app: a Department Manager is refused the company-wide allow-list but still gets its own review queue', async () => {
    const owner = tenant.owner;
    expect((await owner.patch('/v1/tenants/current/settings', {
      enabled_roles: ['company_owner', 'admin', 'expert', 'successor', 'department_manager'],
    })).status).toBe(200);
    const dept = await owner.post('/v1/departments', { name: `Filter ${randomUUID().slice(0, 8)}` });
    expect(dept.status).toBe(201);
    const manager = await addMember(t, owner, [{ role_key: 'department_manager', department_id: dept.body.id }], { departmentId: dept.body.id });
    expect((await manager.client.get('/v1/redaction/allowlist')).status).toBe(403);
    expect((await manager.client.get('/v1/review/tasks')).status).toBe(200);
    expect((await owner.get('/v1/redaction/allowlist')).status).toBe(200);
    const su = await superuser();
    const audit = await su.query(
      `SELECT reason_code FROM audit_log WHERE tenant_id = $1 AND actor_card_id = $2 AND action = 'review:read' AND decision = 'deny'`,
      [tenant.tenantId, manager.card.id]);
    await su.end();
    expect(audit.rows.map((r) => r.reason_code)).toEqual(['DENY_FILTER_NOT_SUPPORTED']);
  });
});

describe('real app: a card with almost no permissions cannot get a 2xx from anything it is not granted', () => {
  it('walks all 162 protected operations as a Successor', async () => {
    const su = await superuser();
    const granted = new Set((await su.query(`SELECT permission_key FROM role_permissions WHERE role_key = 'successor'`)).rows.map((r) => r.permission_key as string));
    await su.end();
    expect([...granted].sort()).toEqual(['card:list', 'card:read', 'card_events:read', 'card_roles:read', 'consent:give', 'consent:read',
      'consent:withdraw', 'contribution:restrict', 'department:read', 'expert_question:create', 'expert_question:read', 'knowledge:ask',
      'knowledge:read', 'person:read', 'quiz:read_results', 'quiz:take', 'role:read', 'self:credential_remove', 'self:logout', 'self:read',
      'source:confirm', 'topic:read']);

    const scenarioBody = {
      title: 'x', situation: 'x', job_role: 'x', steps: [{ prompt: 'x', item_ids: [randomUUID()], rubric: ['y'] }],
    };
    const bodies: Record<string, unknown> = {
      issueCard: { person_id: successor.personId, roles: [{ role_key: 'expert' }] },
      suspendCard: { reason: 'x' }, revokeCard: { reason: 'x' }, replaceCard: { reason: 'lost' }, renewCard: {}, issueEnrollmentToken: {},
      putCardRestrictions: { restrictions: [] }, assignCardRole: { role_key: 'expert' }, replaceCardRoles: { roles: [{ role_key: 'expert' }] },
      createPerson: { display_name: 'x' }, updatePerson: { display_name: 'x' }, createDepartment: { name: 'x' },
      createTenant: { name: 'x', slug: 'x-tenant', owner_display_name: 'x' }, updateTenantSettings: { grace_days: 1 }, verifyAuditChain: {},
      renewCompanyCard: {}, recoverOwnerCard: { card_id: tenant.ownerCard.id, verification_reference: 'CASE-000001' },
      // Phase 2: valid bodies, so that the contract check cannot be what stops the request
      createSource: { title: 'x', company_document: true }, setSourceLabels: { sensitivity: 1 }, createKnowledgeItem: { title: 'x', body: 'x' },
      proposeItemVersion: { body: 'x' }, reopenKnowledgeItem: {}, setItemLabels: { sensitivity: 1 }, setItemTopics: { topic_ids: [] },
      revertVerifications: { card_id: tenant.ownerCard.id, since: '2026-01-01T00:00:00Z', until: '2026-12-31T00:00:00Z' },
      createInterview: { expert_person_id: successor.personId, job_role: 'x' }, answerInterviewTurn: { answer: 'x' }, createTopic: { name: 'x' },
      updateTopic: { name: 'x' }, setRoleTopics: { topics: [] }, setRolePeople: { people: [] }, suggestTopics: { source_id: randomUUID() },
      replyExpertQuestion: { answer: 'x' }, declineExpertQuestion: { reason: 'other' }, generateQuizQuestions: { kind: 'mcq', item_ids: [randomUUID()] },
      editQuizQuestion: { stem: 'x' }, overrideQuizAnswer: { score: 1 }, recordWithdrawalForPerson: { reference: 'REF-000001' }, holdConsent: { reason: 'x' },
      assignReviewTask: {}, bulkReviewTasks: { action: 'dismiss', task_ids: [randomUUID()] }, addRedactionAllowlistTerm: { term: 'x', entity_type: 'OTHER' },
      updateKnowledgeSettings: { review_sla_days: 5 }, setTenantAiBudget: { monthly_cap_micro_usd: 1 }, setAiKillSwitch: { on: false },
      // Phase 4, step 2
      updateAnomalySettings: { enabled: true }, setLeavingDate: { leaving_on: '2031-06-30' },
      // Phase 4, step 4 (scenario replay)
      // Phase 4, billing
      updateSubscription: { auto_renew: false }, setTenantSeatLimit: { seat_limit: 5 },
      // Phase 4, API keys
      createApiKey: { name: 'x', scope: ['topic:read'], max_sensitivity: 0, expires_in_days: 1 },
      recordManualPayment: { invoice_id: randomUUID(), amount: { amount_minor: 1500, currency: 'USD' }, reference: 'TRANSFER-000001' },
      createScenario: scenarioBody, updateScenario: scenarioBody, proposeScenarioRubric: { item_ids: [randomUUID()] }, overrideScenarioAnswer: { score: 1 },
    };
    let denied = 0;
    for (const op of t.app.http.contract.operations.values()) {
      if (op.isPublic || op.isService || granted.has(op.permission!)) continue;
      // Target a REAL resource in the same tenant (the Owner's card / the Successor's own person), so that
      // "not found" cannot be what stops the request.
      let url = op.path.replace('{card_id}', tenant.ownerCard.id).replace('{person_id}', successor.personId).replace('{tenant_id}', tenant.tenantId)
        .replace('{role_key}', 'company_owner').replace('{export_id}', randomUUID()).replace('{credential_id}', randomUUID()).replace('{job_role}', 'x')
        .replace('{template_key}', 'maintenance');
      const phase2Target = /\{[a-z_]+_id\}/.test(url);   // Phase 2 record ids are random here: "not found" is an acceptable refusal
      url = url.replace(/\{[a-z_]+_id\}/g, () => randomUUID());
      if (op.operationId === 'getGapReport') url += '?job_role=x';
      const upload = op.binaryTypes.length > 0;
      const res = await successor.client.request(op.method, url, upload ? (Buffer.from('x') as unknown as object) : bodies[op.operationId],
        { idem: op.idempotent ? `walk-${randomUUID()}` : false, headers: upload ? { 'content-type': 'text/plain' } : {} });
      expect([403, 404], `${op.operationId} answered ${res.status}: ${res.raw}`).toContain(res.status);
      if (res.status === 404 && !phase2Target) expect(op.operationId).toBe('getExport'); // the only Phase 1 one whose target does not exist
      denied += 1;
    }
    // Phase 1: 40 protected operations minus the 12 the Successor's permissions reach; Phase 2: 78 minus the 21 its permissions reach
    // (of the five added later it reaches the job-role list, a role's topics and its own tests taken; not item topics, not a role's people).
    // Phase 4 (features 22, 23): feedback on its own answers it may give (knowledge:ask); the company's quality numbers and
    // the readers' feedback list it may not read.
    // Phase 4 (features 5, 11, 26): it may read its own leaving date, its own radar entry and its own cards' anomaly events;
    // it may not read or change the anomaly rules, set or clear a leaving date, or read or apply department templates.
    // Phase 4 (features 27, 30): the map it may read (knowledge:read, narrowed by its own filters); the company's activity numbers
    // it may not read, and the map it may not take out (an export: export:create).
    // Phase 4 (feature 8): it may see what is offered to it, run a scenario and read its own runs (quiz:take, quiz:read_results);
    // it may not write, read, approve or retire scenarios, ask for proposed points, read a step in order to grade it, or override a grade.
    // Phase 4 (billing): nothing of it - the subscription and invoices are the Owner's, the rest the platform operator's.
    // Phase 4 (API keys): nothing of it - making, listing and revoking keys, and asking what a key could carry, is the Owner's.
    expect(denied).toBe(28 + 57 + 2 + 6 + 2 + 9 + 8 + 4);
  });
});

describe('handlers contain no access decisions of their own (source check)', () => {
  const src = (p: string): string => readFileSync(path.resolve(import.meta.dirname, '..', '..', 'src', p), 'utf8');

  it('route files never read the caller\'s roles or compare role names', () => {
    for (const file of ['modules/identity-access/internal/routes.ts', 'modules/platform/internal/routes.ts']) {
      const text = src(file);
      expect(text, file).not.toMatch(/subject\.roles/);
      expect(text, file).not.toMatch(/subject\.is_platform_tenant/);
      expect(text, file).not.toMatch(/role_key\s*===\s*['"](admin|company_owner|expert|auditor)['"]\s*\)\s*(return|throw)/);
      expect(text, file).not.toMatch(/problems\.forbidden\(/);
    }
  });

  it('only the HTTP layer turns a decision into a 403', () => {
    expect(src('modules/platform/internal/http.ts')).toMatch(/problems\.forbidden\(\)/);
    for (const file of ['modules/identity-access/internal/cards.ts', 'modules/identity-access/internal/auth.ts', 'modules/platform/internal/tenants.ts']) {
      expect(src(file), file).not.toMatch(/problems\.forbidden\(/);
    }
  });

  it('request Origin used by tests is the allow-listed one (sanity)', () => {
    expect(loadConfig(testEnv()).allowedOrigins).toEqual([TEST_ORIGIN]);
  });
});
