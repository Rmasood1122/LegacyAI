// API keys for machines (feature 28, part A): against the real server and database. Synthetic companies only.
// The pure rules (what a key may carry, what the policy lets a key do, which changes of a card end its keys) are in
// test/unit/api-keys.test.ts and test/unit/api-key-events.test.ts.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiStub } from '../helpers/ai-stub.ts';
import { addMember, createTenant, startApp, superuser, type Res, type TestApp, type TestTenant } from '../helpers/harness.ts';

let stub: AiStub;
let t: TestApp;
let su: pg.Client;

beforeAll(async () => {
  stub = await new AiStub().start();
  t = await startApp({}, { AI_SERVICE_URL: stub.url });
  su = await superuser();
});
afterAll(async () => {
  await su.end();
  await t.close();
  await stub.stop();
});

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A request as a machine makes it: the key in the Authorization header, no cookie, no Origin, no CSRF token. */
async function withKey(key: string, method: Method, url: string, body?: unknown, opts: { idem?: boolean; ip?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'user-agent': 'legacyai-test-machine', authorization: `Bearer ${key}`, ...(opts.headers ?? {}) };
  if (opts.idem === true) headers['idempotency-key'] = `machine-${randomUUID()}`;
  const res = await t.app.http.app.inject({
    method, url, headers, remoteAddress: opts.ip ?? '127.0.0.1', ...(body === undefined ? {} : { payload: body as object }),
  });
  let parsed: unknown = null;
  try {
    parsed = res.body === '' ? null : JSON.parse(res.body);
  } catch {
    parsed = res.body;
  }
  return { status: res.statusCode, body: parsed, headers: res.headers as Record<string, unknown>, raw: res.body };
}

interface MadeKey { id: string; key: string }
async function makeKey(tenant: TestTenant, over: Record<string, unknown> = {}): Promise<MadeKey> {
  const res = await tenant.owner.post('/v1/api-keys', { name: 'Test machine', scope: ['topic:read'], max_sensitivity: 0, expires_in_days: 30, ...over });
  if (res.status !== 201) throw new Error(`create key failed: ${res.status} ${res.raw}`);
  return { id: res.body.id, key: res.body.api_key };
}

const detailsOf = (row: { details: unknown }): Record<string, unknown> =>
  (typeof row.details === 'string' ? JSON.parse(row.details) : row.details ?? {}) as Record<string, unknown>;

describe('making, listing and revoking keys', () => {
  let tenant: TestTenant;
  beforeAll(async () => {
    tenant = await createTenant(t, 'keys');
  });

  it('the Owner makes a key: the secret is shown once, only its hash is stored, and nothing secret reaches the audit trail or the log', async () => {
    const idem = `make-${randomUUID()}`;
    const body = { name: 'Intranet search', scope: ['knowledge:read', 'topic:read'], max_sensitivity: 1, expires_in_days: 90 };
    const made = await tenant.owner.post('/v1/api-keys', body, idem);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      name: 'Intranet search', scope: ['knowledge:read', 'topic:read'], max_sensitivity: 1, allowed_cidrs: null, status: 'active',
      created_by_card_id: tenant.ownerCard.id, last_used_at: null, secret_already_shown: false, asks_per_hour: 30, revoked_at: null, revoked_reason: null,
    });
    const key = made.body.api_key as string;
    expect(key).toMatch(/^lak1\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    const secret = key.split('.')[3] as string;
    expect(made.body.secret_hint).toBe(secret.slice(-4));

    // the same request again: the same key, and the secret is NOT repeated
    const again = await tenant.owner.post('/v1/api-keys', body, idem);
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(made.body.id);
    expect(again.body.secret_already_shown).toBe(true);
    expect(again.body.api_key).toBeUndefined();
    expect(again.raw).not.toContain(secret);

    const stored = await su.query('SELECT secret_hash, to_jsonb(k)::text AS whole FROM api_keys k WHERE id = $1', [made.body.id]);
    expect(stored.rows).toHaveLength(1);
    expect((stored.rows[0].secret_hash as Buffer).length).toBe(32);
    expect(stored.rows[0].whole).not.toContain(secret);
    const replay = await su.query('SELECT count(*)::int AS n FROM idempotency_keys k WHERE tenant_id = $1 AND to_jsonb(k)::text LIKE $2', [tenant.tenantId, `%${secret}%`]);
    expect(replay.rows[0].n).toBe(0);
    const audit = await su.query('SELECT count(*)::int AS n FROM audit_log a WHERE tenant_id = $1 AND to_jsonb(a)::text LIKE $2', [tenant.tenantId, `%${secret}%`]);
    expect(audit.rows[0].n).toBe(0);
    expect(t.logs.join('\n')).not.toContain(secret);

    const event = await su.query(`SELECT reason_code, details FROM audit_log WHERE tenant_id = $1 AND resource_id = $2 AND decision = 'event'`, [tenant.tenantId, made.body.id]);
    expect(event.rows.map((r) => r.reason_code)).toEqual(['API_KEY_CREATED']);
    expect(detailsOf(event.rows[0])).toEqual({ api_key_id: made.body.id, scope: 'knowledge:read,topic:read' });

    const list = await tenant.owner.get('/v1/api-keys?limit=10');
    expect(list.status).toBe(200);
    expect(list.body.items.map((k: { id: string }) => k.id)).toContain(made.body.id);
    expect(list.raw).not.toContain(secret);
    expect(list.raw).not.toContain('secret_hash');
    expect(Object.keys(list.body).sort()).toEqual(['items', 'next_cursor']);
    // what a key made by this card could carry is a question of its own
    const options = await tenant.owner.get('/v1/api-keys/options');
    expect(options.body.grantable.map((g: { permission: string }) => g.permission)).toEqual(expect.arrayContaining(['knowledge:read', 'topic:read']));
  });

  it('refuses a key that asks for more than a key may carry', async () => {
    const ask = (over: Record<string, unknown>): Promise<Res> =>
      tenant.owner.post('/v1/api-keys', { name: 'x', scope: ['topic:read'], max_sensitivity: 0, expires_in_days: 30, ...over });
    expect((await ask({ scope: ['card:issue'] })).status).toBe(400);            // not on the short list: the contract itself refuses it
    expect((await ask({ scope: ['api_key:manage'] })).status).toBe(400);
    expect((await ask({ scope: ['capture:upload'] })).status).toBe(400);        // a key adds nothing
    expect((await ask({ asks_per_hour: 601 })).status).toBe(400);
    expect((await ask({ asks_per_hour: 0 })).status).toBe(400);
    expect((await ask({ scope: [] })).status).toBe(400);
    expect((await ask({ expires_in_days: 400 })).status).toBe(400);
    expect((await ask({ expires_in_days: undefined })).status).toBe(400);      // no key without an expiry
    expect((await ask({ allowed_cidrs: ['not-a-network'] })).status).toBe(422);
  });

  it('only the Owner: an Admin can neither make, list nor revoke keys', async () => {
    const admin = await addMember(t, tenant.owner, [{ role_key: 'admin' }]);
    const made = await makeKey(tenant);
    expect((await admin.client.get('/v1/api-keys')).status).toBe(403);
    expect((await admin.client.get('/v1/api-keys/options')).status).toBe(403);
    expect((await admin.client.post('/v1/api-keys', { name: 'x', scope: ['topic:read'], max_sensitivity: 0, expires_in_days: 30 })).status).toBe(403);
    expect((await admin.client.post(`/v1/api-keys/${made.id}/revoke`)).status).toBe(403);
  });

  it('a key of another company is not found, and its key opens nothing here', async () => {
    const other = await createTenant(t, 'keys-other');
    const theirs = await makeKey(other);
    expect((await tenant.owner.post(`/v1/api-keys/${theirs.id}/revoke`)).status).toBe(404);
    // the other company's key with THIS company's id written into it finds nothing
    const forged = theirs.key.replace(other.tenantId, tenant.tenantId);
    expect((await withKey(forged, 'GET', '/v1/topics')).status).toBe(401);
    expect((await withKey(theirs.key, 'GET', '/v1/topics')).status).toBe(200);
  });

  it('a revoked key stops working on the next request; revoking twice changes nothing', async () => {
    const made = await makeKey(tenant);
    expect((await withKey(made.key, 'GET', '/v1/topics')).status).toBe(200);
    const revoked = await tenant.owner.post(`/v1/api-keys/${made.id}/revoke`);
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ status: 'revoked', revoked_reason: 'by_owner' });
    expect(typeof revoked.body.revoked_at).toBe('string');
    expect((await withKey(made.key, 'GET', '/v1/topics')).status).toBe(401);
    expect((await tenant.owner.post(`/v1/api-keys/${made.id}/revoke`)).body.status).toBe('revoked');
    const events = await su.query(`SELECT reason_code FROM audit_log WHERE tenant_id = $1 AND resource_id = $2 AND reason_code = 'API_KEY_REVOKED'`, [tenant.tenantId, made.id]);
    expect(events.rows).toHaveLength(1);
  });
});

describe('what a request with a key can do', () => {
  let tenant: TestTenant;
  beforeAll(async () => {
    tenant = await createTenant(t, 'keys-use');
  });

  it('does what was written into it and nothing else; the audit trail names the key', async () => {
    const made = await makeKey(tenant, { scope: ['topic:read'] });
    expect((await withKey(made.key, 'GET', '/v1/topics')).status).toBe(200);
    expect((await withKey(made.key, 'GET', '/v1/job-roles')).status).toBe(200);
    const refused = await withKey(made.key, 'GET', '/v1/sources');       // source:read is not in this key (its maker holds it)
    expect(refused.status).toBe(403);
    expect(refused.body.type).toBe('urn:legacyai:problem:api-key-scope');
    expect(refused.raw).not.toContain('source:read');                    // which permission is missing is not said
    expect((await tenant.owner.get('/v1/sources')).status).toBe(200);

    const rows = (await su.query('SELECT action, decision, reason_code, actor_card_id, actor_kind, details FROM audit_log WHERE tenant_id = $1', [tenant.tenantId])).rows
      .filter((r) => detailsOf(r).api_key_id === made.id);
    expect(rows.some((r) => r.action === 'topic:read' && r.decision === 'allow')).toBe(true);
    expect(rows.some((r) => r.action === 'source:read' && r.decision === 'deny' && r.reason_code === 'DENY_API_KEY_SCOPE')).toBe(true);
    // the key acts for the card that made it: that card is the actor, the key is named beside it
    for (const r of rows) expect(r).toMatchObject({ actor_card_id: tenant.ownerCard.id, actor_kind: 'card' });
    // ... and nothing was written on that card: no card event, no usage counter
    const cardSide = await su.query(
      `SELECT (SELECT count(*) FROM card_events WHERE card_id = $1 AND event_type = 'restriction_denied')::int AS events,
              (SELECT count(*) FROM card_usage_counters WHERE card_id = $1)::int AS counters`, [tenant.ownerCard.id]);
    expect(cardSide.rows[0]).toEqual({ events: 0, counters: 0 });

    const listed = await tenant.owner.get('/v1/api-keys');
    expect(typeof listed.body.items.find((k: { id: string }) => k.id === made.id).last_used_at).toBe('string');
  });

  it('a key adds nothing: the operations that take a document do not take a key', async () => {
    const made = await makeKey(tenant, { scope: ['source:read'] });
    const created = await withKey(made.key, 'POST', '/v1/sources', { title: 'Synthetic pump manual', company_document: true }, { idem: true });
    expect(created.status).toBe(403);
    expect(created.body.type).toBe('urn:legacyai:problem:api-key-not-accepted');
    expect((await withKey(made.key, 'GET', '/v1/sources')).status).toBe(200);
    // a session still needs its Origin and CSRF token
    const noCsrf = await tenant.owner.request('POST', '/v1/sources', { title: 'x', company_document: true }, { idem: `k-${randomUUID()}`, noCsrf: true });
    expect(noCsrf.status).toBe(403);
  });

  it('reading starts no work: a key that reads a document still being processed gets its status, and the AI service is not called', async () => {
    const source = randomUUID();
    await su.query('BEGIN');
    try {
      await su.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.tenantId]);
      await su.query(
        `INSERT INTO sources (id, tenant_id, kind, title, department_id, sensitivity, company_owned_attested_by_card_id, uploaded_by_card_id, status)
         VALUES ($1, $2, 'document', 'Synthetic manual in processing', NULL, 0, $3, $3, 'awaiting_content')`, [source, tenant.tenantId, tenant.ownerCard.id]);
      await su.query("UPDATE sources SET status = 'processing' WHERE id = $1", [source]);
      await su.query('COMMIT');
    } catch (err) {
      await su.query('ROLLBACK');
      throw err;
    }
    const made = await makeKey(tenant, { scope: ['source:read'], max_sensitivity: 0 });
    stub.reset();
    const byKey = await withKey(made.key, 'GET', `/v1/sources/${source}`);
    expect(byKey.status, byKey.raw).toBe(200);
    expect(byKey.body.status).toBe('processing');
    expect(stub.calls).toEqual([]);                                       // nothing was started, nothing was asked
    // the same request by a signed-in card continues the work (there is no background worker)
    const byCard = await tenant.owner.get(`/v1/sources/${source}`);
    expect(byCard.status, byCard.raw).toBe(200);
    expect(stub.ofAction('source.continue')).toHaveLength(1);
  });

  it('the restrictions on the maker\'s card do not bind its key (the key has its own network list)', async () => {
    const made = await makeKey(tenant);
    await su.query(
      `INSERT INTO card_restrictions (tenant_id, card_id, type, config, enabled) VALUES ($1, $2, 'network_allowlist', '{"cidrs":["203.0.113.0/24"]}', true)`,
      [tenant.tenantId, tenant.ownerCard.id]);
    try {
      expect((await withKey(made.key, 'GET', '/v1/topics')).status).toBe(200);
    } finally {
      await su.query(`DELETE FROM card_restrictions WHERE card_id = $1 AND type = 'network_allowlist'`, [tenant.ownerCard.id]);
    }
  });

  it('a key together with a session cookie is refused, and so is anything that is not a working key - with "WWW-Authenticate: Bearer"', async () => {
    const made = await makeKey(tenant);
    const both = await tenant.owner.request('GET', '/v1/topics', undefined, { headers: { authorization: `Bearer ${made.key}` } });
    expect(both.status).toBe(401);
    expect((await tenant.owner.get('/v1/topics')).status).toBe(200);     // the session itself is untouched
    for (const bad of [made.key.slice(0, -1), `${made.key.slice(0, -1)}${made.key.endsWith('A') ? 'B' : 'A'}`, 'lak1.x.y.z']) {
      const res = await withKey(bad, 'GET', '/v1/topics');
      expect(res.status, bad.slice(0, 12)).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.body.type).toBe('urn:legacyai:problem:unauthenticated');
    }
  });

  it('an Authorization header that carries no key is ignored: it does not sign anybody in, and does not break a session', async () => {
    const made = await makeKey(tenant);
    const basic = await t.app.http.app.inject({ method: 'GET', url: '/v1/topics', headers: { authorization: `Basic ${made.key}` } });
    expect(basic.statusCode).toBe(401);
    const proxied = await tenant.owner.request('GET', '/v1/topics', undefined, { headers: { authorization: 'Basic c3ludGhldGljOnByb3h5' } });
    expect(proxied.status).toBe(200);
    const onSessionRoute = await tenant.owner.request('GET', '/v1/api-keys', undefined, { headers: { authorization: 'Bearer some-proxy-token' } });
    expect(onSessionRoute.status).toBe(200);
  });

  it('a key limited to some networks works only from them', async () => {
    const made = await makeKey(tenant, { allowed_cidrs: ['203.0.113.0/24'] });
    expect((await withKey(made.key, 'GET', '/v1/topics', undefined, { ip: '127.0.0.1' })).status).toBe(401);
    expect((await withKey(made.key, 'GET', '/v1/topics', undefined, { ip: '203.0.113.9' })).status).toBe(200);
  });

  it('a key has its own number of questions per hour: beyond it, 429 with Retry-After, before the AI service is called', async () => {
    const made = await makeKey(tenant, { scope: ['knowledge:ask', 'knowledge:read'], max_sensitivity: 0, asks_per_hour: 2 });
    const ask = (): Promise<Res> => withKey(made.key, 'POST', '/v1/knowledge/ask', { question: 'What is the synthetic pump pressure?' });
    expect((await ask()).status).not.toBe(429);
    expect((await ask()).status).not.toBe(429);
    const callsBefore = stub.calls.length;
    const third = await ask();
    expect(third.status).toBe(429);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    expect(stub.calls.length).toBe(callsBefore);
    // reading is not a question
    expect((await withKey(made.key, 'GET', '/v1/knowledge/items')).status).not.toBe(429);
  });

  it('the table: with a key carrying everything a key may carry, every operation outside the ten refuses the key before anything is looked up', async () => {
    const options = await tenant.owner.get('/v1/api-keys/options');
    expect(options.status).toBe(200);
    expect(options.body.limits).toEqual({ max_expires_in_days: 366, requests_per_minute: 120, default_asks_per_hour: 30, max_asks_per_hour: 600 });
    const grantable = options.body.grantable as Array<{ permission: string; max_sensitivity: number }>;
    expect(grantable.map((g) => g.permission).sort()).toEqual(['gap:read', 'knowledge:ask', 'knowledge:read', 'source:read', 'topic:read']);
    const made = await makeKey(tenant, { scope: grantable.map((g) => g.permission), max_sensitivity: Math.min(...grantable.map((g) => g.max_sensitivity)), asks_per_hour: 600 });
    let closed = 0;
    let open = 0;
    let publicOps = 0;
    for (const op of t.app.http.contract.operations.values()) {
      if (op.isPublic || op.isService) { publicOps += 1; continue; }   // no sign-in of any kind is read there
      const url = op.path.replace('{job_role}', 'x').replace('{role_key}', 'company_owner').replace('{template_key}', 'maintenance')
        .replace(/\{[a-z_]+\}/g, () => randomUUID());
      const res = await withKey(made.key, op.method as Method, url, undefined, { idem: op.idempotent });
      if (op.apiKey) {
        // the key is read here: whatever the answer (found, not found, a missing field), it is not "sign-in required"
        expect(res.status, `${op.operationId} answered ${res.status}: ${res.raw}`).not.toBe(401);
        expect(res.body?.type, op.operationId).not.toBe('urn:legacyai:problem:api-key-not-accepted');
        open += 1;
      } else {
        // 400 = the request was turned away for its shape before anybody looked at who sent it
        expect([400, 403], `${op.operationId} answered ${res.status}: ${res.raw}`).toContain(res.status);
        if (res.status === 403) expect(res.body.type, op.operationId).toBe('urn:legacyai:problem:api-key-not-accepted');
        closed += 1;
      }
    }
    expect(open).toBe(10);
    expect(open + closed + publicOps).toBe(t.app.http.contract.operations.size);
    // and the stronger statement: the policy was never even asked, with this key, about anything but the five permissions
    const asked = new Set((await su.query('SELECT action, details FROM audit_log WHERE tenant_id = $1', [tenant.tenantId])).rows
      .filter((r) => detailsOf(r).api_key_id === made.id).map((r) => r.action as string));
    for (const action of asked) expect(['gap:read', 'knowledge:ask', 'knowledge:read', 'source:read', 'topic:read']).toContain(action);
  });
});

describe('a key never outlives or outranks its maker, and its mistakes are its own', () => {
  const keyRow = async (id: string): Promise<Record<string, unknown>> =>
    (await su.query('SELECT revoked_at, revoked_reason, revoked_by_card_id, suspended_at, suspended_reason FROM api_keys WHERE id = $1', [id])).rows[0];

  it.each([
    ['its secret code is rotated', 'sc_rotated', 'maker_code_rotated'],
    ['its sign-in factors are reset', 'credentials_reset', 'maker_credentials_reset'],
    ['its roles change', 'privilege_change', 'maker_privilege_change'],
    ['it is replaced', 'card_replaced', 'maker_card_replaced'],
    ['it is revoked', 'card_revoked', 'maker_card_revoked'],
    ['it is suspended', 'card_suspended', 'maker_card_suspended'],
    ['it is locked', 'card_locked', 'maker_card_locked'],
  ] as const)('when the maker\'s card changes - %s - its keys are revoked with its sessions, for good', async (_name, sessionReason, keyReason) => {
    const tenant = await createTenant(t, `keys-${sessionReason.replace(/_/g, '-')}`);
    const made = await makeKey(tenant);
    const other = await makeKey(tenant);
    expect((await withKey(made.key, 'GET', '/v1/topics')).status).toBe(200);
    // the one function every such change goes through (unit test: api-keys.test.ts "every place that ends a card's sessions")
    await t.app.db.withTenantTx(tenant.tenantId, (tx) =>
      t.app.identity.cards.revokeSessions(tx, { id: tenant.ownerCard.id, tenant_id: tenant.tenantId }, sessionReason, t.clock.now()));
    expect((await withKey(made.key, 'GET', '/v1/topics')).status).toBe(401);
    expect((await withKey(other.key, 'GET', '/v1/topics')).status).toBe(401);
    expect(await keyRow(made.id)).toMatchObject({ revoked_reason: keyReason, revoked_by_card_id: null });
    expect((await tenant.owner.get('/v1/auth/session')).status).toBe(401);          // the sessions ended in the same step
    const events = await su.query(
      `SELECT actor_kind, resource_id, details FROM audit_log WHERE tenant_id = $1 AND reason_code = 'API_KEY_REVOKED_MAKER_CHANGED' ORDER BY seq`, [tenant.tenantId]);
    expect(events.rows.map((r) => r.resource_id).sort()).toEqual([made.id, other.id].sort());
    for (const r of events.rows) {
      expect(r.actor_kind).toBe('system');
      expect(detailsOf(r)).toEqual({ api_key_id: r.resource_id, reason: keyReason, target_card_id: tenant.ownerCard.id });
    }
  });

  it('through the API: an Owner suspends another Owner\'s card - that Owner\'s key is revoked, and stays revoked after the card is reinstated', async () => {
    const tenant = await createTenant(t, 'keys-suspend');
    const second = await addMember(t, tenant.owner, [{ role_key: 'company_owner' }]);
    const made = await second.client.post('/v1/api-keys', { name: 'Second owner key', scope: ['topic:read'], max_sensitivity: 0, expires_in_days: 30 });
    expect(made.status).toBe(201);
    const key = made.body.api_key as string;
    expect((await withKey(key, 'GET', '/v1/topics')).status).toBe(200);
    expect((await tenant.owner.post(`/v1/cards/${second.card.id}/suspend`, { reason: 'synthetic test' })).status).toBe(200);
    expect((await withKey(key, 'GET', '/v1/topics')).status).toBe(401);
    expect((await tenant.owner.post(`/v1/cards/${second.card.id}/reinstate`)).status).toBe(200);
    expect((await withKey(key, 'GET', '/v1/topics')).status).toBe(401);
    const listed = await tenant.owner.get('/v1/api-keys');
    expect(listed.body.items.find((k: { id: string }) => k.id === made.body.id)).toMatchObject({ status: 'revoked', revoked_reason: 'maker_card_suspended' });
  });

  it('signing out, and the card\'s expiry, do not revoke its keys', async () => {
    const tenant = await createTenant(t, 'keys-logout');
    const made = await makeKey(tenant);
    for (const reason of ['logout', 'card_expired'] as const) {
      await t.app.db.withTenantTx(tenant.tenantId, (tx) =>
        t.app.identity.cards.revokeSessions(tx, { id: tenant.ownerCard.id, tenant_id: tenant.tenantId }, reason, t.clock.now()));
    }
    expect((await withKey(made.key, 'GET', '/v1/topics')).status).toBe(200);
  });

  it('while the maker\'s card is locked the key does not work - and the database refuses to undo a revocation or a suspension, or to change what a key is', async () => {
    const tenant = await createTenant(t, 'keys-final');
    const made = await makeKey(tenant);
    // a lock written straight into the table (not through the application): the card's STATE alone already stops the key
    await su.query(`UPDATE card_auth_state SET locked_at = now(), lock_reason = 'anomaly' WHERE card_id = $1`, [tenant.ownerCard.id]);
    expect((await withKey(made.key, 'GET', '/v1/topics')).status).toBe(401);
    await su.query('UPDATE card_auth_state SET locked_at = NULL, lock_reason = NULL WHERE card_id = $1', [tenant.ownerCard.id]);

    for (const change of [`scope = ARRAY['knowledge:read']`, 'max_sensitivity = 3', `secret_hash = decode(repeat('00', 32), 'hex')`,
      `expires_at = expires_at + interval '1 year'`, 'asks_per_hour = 600', `name = 'renamed'`, 'allowed_cidrs = NULL']) {
      // allowed_cidrs is already NULL for this key: that one statement changes nothing and passes
      const run = su.query(`UPDATE api_keys SET ${change} WHERE id = $1`, [made.id]);
      if (change === 'allowed_cidrs = NULL') await run;
      else await expect(run, change).rejects.toMatchObject({ code: '23514' });
    }
    const second = await addMember(t, tenant.owner, [{ role_key: 'company_owner' }]);
    await expect(su.query('UPDATE api_keys SET created_by_card_id = $2 WHERE id = $1', [made.id, second.card.id])).rejects.toMatchObject({ code: '23514' });

    expect((await tenant.owner.post(`/v1/api-keys/${made.id}/revoke`)).body).toMatchObject({ status: 'revoked', revoked_reason: 'by_owner' });
    await expect(su.query('UPDATE api_keys SET revoked_at = NULL, revoked_reason = NULL, revoked_by_card_id = NULL WHERE id = $1', [made.id])).rejects.toMatchObject({ code: '23514' });
    await expect(su.query(`UPDATE api_keys SET revoked_at = now() + interval '1 day' WHERE id = $1`, [made.id])).rejects.toMatchObject({ code: '23514' });
    expect((await withKey(made.key, 'GET', '/v1/topics')).status).toBe(401);
  });

  it('a key that keeps asking for what it may not have is suspended - the key, not its maker\'s card', async () => {
    const tenant = await createTenant(t, 'keys-anomaly');
    expect((await tenant.owner.patch('/v1/tenants/current/anomaly-settings', { enabled: true, denials_threshold: 5, denials_window_minutes: 10 })).status).toBe(200);
    const made = await makeKey(tenant, { scope: ['topic:read'] });
    for (let i = 0; i < 5; i += 1) expect((await withKey(made.key, 'GET', '/v1/sources')).status).toBe(403);
    expect((await withKey(made.key, 'GET', '/v1/topics')).status).toBe(401);           // suspended: even what it may do
    const cardLock = await su.query('SELECT locked_at FROM card_auth_state WHERE card_id = $1', [tenant.ownerCard.id]);
    expect(cardLock.rows[0]?.locked_at ?? null).toBeNull();
    expect((await tenant.owner.get('/v1/auth/session')).status).toBe(200);              // the Owner is still signed in
    const listed = await tenant.owner.get('/v1/api-keys');
    expect(listed.body.items.find((k: { id: string }) => k.id === made.id).status).toBe('suspended');
    const event = await su.query(`SELECT actor_kind, details FROM audit_log WHERE tenant_id = $1 AND reason_code = 'API_KEY_SUSPENDED_ANOMALY'`, [tenant.tenantId]);
    expect(event.rows.map(detailsOf)).toEqual([{ api_key_id: made.id, rule: 'denials', count: 5 }]);
    expect(event.rows[0].actor_kind).toBe('system');
    // suspension is final in the database too; only revoking remains
    await expect(su.query('UPDATE api_keys SET suspended_at = NULL, suspended_reason = NULL WHERE id = $1', [made.id])).rejects.toMatchObject({ code: '23514' });
    expect((await tenant.owner.post(`/v1/api-keys/${made.id}/revoke`)).body.status).toBe('revoked');
  });

  it('wrong secrets against an existing key are recorded and reported once - and never stop the key', async () => {
    const tenant = await createTenant(t, 'keys-guess');
    const made = await makeKey(tenant);
    const wrong = `${made.key.slice(0, -43)}${'B'.repeat(43)}`;
    // fifty wrong secrets by somebody who only knows the key's id (which is not secret) ...
    for (let i = 0; i < 50; i += 1) expect((await withKey(wrong, 'GET', '/v1/topics', undefined, { ip: '203.0.113.50' })).status).toBe(401);
    // ... and the machine that has the right secret is not affected
    expect((await withKey(made.key, 'GET', '/v1/topics')).status).toBe(200);
    expect(await keyRow(made.id)).toMatchObject({ suspended_at: null, suspended_reason: null, revoked_at: null });
    const rows = await su.query(
      `SELECT reason_code, actor_kind, details FROM audit_log WHERE tenant_id = $1 AND resource_id = $2 AND reason_code LIKE 'API_KEY_%' ORDER BY seq`, [tenant.tenantId, made.id]);
    // one row for the first wrong secret of the window, one when the tenth came - not fifty
    expect(rows.rows.filter((r) => r.reason_code === 'API_KEY_REFUSED').map(detailsOf)).toEqual([{ api_key_id: made.id, reason: 'wrong-secret' }]);
    expect(rows.rows.filter((r) => r.reason_code === 'API_KEY_WRONG_SECRETS').map(detailsOf)).toEqual([{ api_key_id: made.id, count: 10 }]);
    expect(rows.rows.some((r) => String(r.reason_code).startsWith('API_KEY_SUSPENDED'))).toBe(false);
    expect(JSON.stringify(rows.rows)).not.toContain('B'.repeat(43));
    // the database itself knows no suspension for wrong secrets
    await expect(su.query(`UPDATE api_keys SET suspended_at = now(), suspended_reason = 'wrong_secret' WHERE id = $1`, [made.id])).rejects.toMatchObject({ code: '23514' });
    // a key id that does not exist leaves no trace at all
    const before = await su.query('SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1', [tenant.tenantId]);
    expect((await withKey(wrong.replace(made.id, randomUUID()), 'GET', '/v1/topics')).status).toBe(401);
    const after = await su.query('SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1', [tenant.tenantId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('a repeated request of a key is answered from the key\'s own record: not its maker\'s, not another key\'s', async () => {
    const tenant = await createTenant(t, 'keys-idem');
    const made = await makeKey(tenant, { scope: ['knowledge:ask', 'knowledge:read'], max_sensitivity: 0 });
    const sibling = await makeKey(tenant, { scope: ['knowledge:ask', 'knowledge:read'], max_sensitivity: 0 });
    const idem = `ask-${randomUUID()}`;
    const question = { question: 'What is the synthetic pump pressure?' };
    const answerCalls = (): number => stub.ofAction('knowledge.answer').length + stub.ofAction('knowledge.candidates').length;

    const before = answerCalls();
    const first = await withKey(made.key, 'POST', '/v1/knowledge/ask', question, { headers: { 'idempotency-key': idem } });
    expect(first.status, first.raw).toBe(200);
    const afterFirst = answerCalls();
    expect(afterFirst).toBeGreaterThan(before);                                        // the AI service was asked

    // the same request again: the stored answer, and the AI service is NOT asked a second time
    const again = await withKey(made.key, 'POST', '/v1/knowledge/ask', question, { headers: { 'idempotency-key': idem } });
    expect(again.status, again.raw).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(answerCalls()).toBe(afterFirst);

    // the record belongs to the KEY: its id is in the key column, and the card column is empty
    const kept = await su.query('SELECT actor_card_id, actor_api_key_id FROM idempotency_keys WHERE tenant_id = $1 AND key = $2', [tenant.tenantId, idem]);
    expect(kept.rows).toEqual([{ actor_card_id: null, actor_api_key_id: made.id }]);

    // another key of the same maker, same key string: its own record, its own call
    const other = await withKey(sibling.key, 'POST', '/v1/knowledge/ask', question, { headers: { 'idempotency-key': idem } });
    expect(other.status, other.raw).toBe(200);
    expect(answerCalls()).toBeGreaterThan(afterFirst);
    const afterSibling = answerCalls();

    // the maker's own session, same key string and the same question: not the key's record either
    const own = await tenant.owner.request('POST', '/v1/knowledge/ask', question, { idem });
    expect(own.status, own.raw).toBe(200);
    expect(answerCalls()).toBeGreaterThan(afterSibling);

    const all = await su.query('SELECT actor_card_id, actor_api_key_id FROM idempotency_keys WHERE tenant_id = $1 AND key = $2 ORDER BY actor_api_key_id NULLS LAST', [tenant.tenantId, idem]);
    expect(all.rows).toHaveLength(3);
    expect(all.rows.filter((r) => r.actor_card_id !== null)).toEqual([{ actor_card_id: tenant.ownerCard.id, actor_api_key_id: null }]);
    expect(new Set(all.rows.map((r) => r.actor_api_key_id).filter((id) => id !== null))).toEqual(new Set([made.id, sibling.id]));

    // the same key string with a DIFFERENT request is refused for the key, as it is for a card
    const reuse = await withKey(made.key, 'POST', '/v1/knowledge/ask', { question: 'A different synthetic question?' }, { headers: { 'idempotency-key': idem } });
    expect(reuse.status).toBe(409);
    // the database refuses a record with both actors, or with none
    await expect(su.query(
      `INSERT INTO idempotency_keys (tenant_id, actor_card_id, actor_api_key_id, key, operation_id, request_hash, expires_at) VALUES ($1, $2, $3, 'both-actors-0001', 'x', '\\x00', now())`,
      [tenant.tenantId, tenant.ownerCard.id, made.id])).rejects.toMatchObject({ code: '23514' });
    await expect(su.query(
      `INSERT INTO idempotency_keys (tenant_id, key, operation_id, request_hash, expires_at) VALUES ($1, 'no-actor-00001', 'x', '\\x00', now())`,
      [tenant.tenantId])).rejects.toMatchObject({ code: '23514' });
  });

  // LAST in this file: it moves the clock by more than a day.
  it('a key stops at its expiry', async () => {
    const tenant = await createTenant(t, 'keys-expiry');
    const made = await makeKey(tenant, { expires_in_days: 1 });
    expect((await withKey(made.key, 'GET', '/v1/topics')).status).toBe(200);
    t.clock.advance(24 * 3_600_000 + 1_000);
    expect((await withKey(made.key, 'GET', '/v1/topics')).status).toBe(401);
  });
});
