// Outgoing webhooks (feature 28, part B): against the real server and database, with a stand-in sender that records
// what would have gone out (no network). Synthetic companies only. The pure rules and the real https sender are in
// test/unit/webhooks.test.ts.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifySignature, type SendOutcome, type WebhookRequest, type WebhookTransport } from '../../src/modules/webhooks/index.ts';
import type { NotificationEvent, Notifier } from '../../src/modules/platform/index.ts';
import { appRoleClient, addMember, createTenant, startApp, superuser, type Res, type TestApp, type TestTenant } from '../helpers/harness.ts';

/** Records every message instead of sending it; answers what the test scripted (default: 204). */
class RecordingTransport implements WebhookTransport {
  readonly name = 'recording';
  readonly sent: WebhookRequest[] = [];
  answer: (req: WebhookRequest) => SendOutcome = () => ({ ok: true, status: 204 });
  async send(req: WebhookRequest): Promise<SendOutcome> {
    this.sent.push(req);
    return this.answer(req);
  }
}

class RecordingNotifier implements Notifier {
  readonly events: NotificationEvent[] = [];
  async notify(event: NotificationEvent): Promise<void> {
    this.events.push(event);
  }
}

let t: TestApp;
let off: TestApp;
let su: pg.Client;
const transport = new RecordingTransport();
const notifier = new RecordingNotifier();

beforeAll(async () => {
  t = await startApp({ webhookTransport: transport, notifier });
  off = await startApp();   // WEBHOOK_DELIVERY unset: nothing is sent
  su = await superuser();
});
afterAll(async () => {
  await su.end();
  await t.close();
  await off.close();
});

async function seed(tenantId: string, sql: string, params: unknown[] = [], opts: { relabel?: boolean } = {}): Promise<any[]> {
  await su.query('BEGIN');
  try {
    await su.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    // a label changes only the way relabel() changes it (the database's guard); this test plays that role
    if (opts.relabel === true) await su.query("SELECT set_config('app.relabel', 'on', true)");
    const { rows } = await su.query(sql, params);
    await su.query('COMMIT');
    return rows;
  } catch (err) {
    await su.query('ROLLBACK');
    throw err;
  }
}

/** A company item (synthetic), in review; `verify` makes it released - the trigger writes the event. */
async function item(tn: TestTenant, sensitivity: number): Promise<string> {
  const id = randomUUID();
  await seed(tn.tenantId, `INSERT INTO knowledge_items (id, tenant_id, title, origin, sensitivity) VALUES ($1, $2, $3, 'manual', $4)`,
    [id, tn.tenantId, `Synthetic item ${id.slice(0, 8)}`, sensitivity]);
  const v = await seed(tn.tenantId, `INSERT INTO knowledge_versions (tenant_id, item_id, version_no, body, change_kind) VALUES ($1, $2, 1, $3, 'written') RETURNING id`,
    [tn.tenantId, id, `Synthetic body ${id}.`]);
  await seed(tn.tenantId, "UPDATE knowledge_items SET current_version_id = $1, status = 'in_review' WHERE id = $2", [v[0].id, id]);
  return id;
}
const verify = (tn: TestTenant, id: string): Promise<unknown> =>
  seed(tn.tenantId, "UPDATE knowledge_items SET status = 'verified', verified_by_card_id = $1, verified_at = now() WHERE id = $2", [tn.ownerCard.id, id]);

const outbox = async (tenantId: string): Promise<Array<{ topic: string; payload: Record<string, unknown> }>> =>
  (await su.query('SELECT topic, payload FROM outbox_events WHERE tenant_id = $1 ORDER BY created_at, id', [tenantId])).rows;

interface Made { id: string; secret: string; body: any }
async function makeEndpoint(tn: TestTenant, over: Record<string, unknown> = {}): Promise<Made> {
  const res = await tn.owner.post('/v1/webhooks', { name: 'Search index', url: 'https://hooks.example.com/legacyai', topics: ['knowledge.item_released', 'knowledge.item_withdrawn'], max_sensitivity: 1, ...over });
  if (res.status !== 201) throw new Error(`create endpoint failed: ${res.status} ${res.raw}`);
  return { id: res.body.id, secret: res.body.signing_secret, body: res.body };
}
const sentTo = (tn: TestTenant): WebhookRequest[] => transport.sent.filter((r) => JSON.parse(r.body).company_id === tn.tenantId);
const run = (tn: TestTenant, at = new Date()) => t.app.webhooks.runCompany(tn.tenantId, () => at);

describe('the outbox: every change of a released item writes its event, in the same transaction', () => {
  let tenant: TestTenant;
  beforeAll(async () => {
    tenant = await createTenant(t, 'outbox');
  });

  it('released, changed, withdrawn - with identifiers and labels only, never the title or the text', async () => {
    const id = await item(tenant, 1);
    expect(await outbox(tenant.tenantId)).toEqual([]);                      // candidate and in review: nothing
    await verify(tenant, id);
    await seed(tenant.tenantId, 'UPDATE knowledge_items SET sensitivity = 2 WHERE id = $1', [id], { relabel: true });
    await seed(tenant.tenantId, 'UPDATE knowledge_items SET usage_count = usage_count + 1 WHERE id = $1', [id]);   // not a change anybody outside needs
    await seed(tenant.tenantId, "UPDATE knowledge_items SET status = 'stale' WHERE id = $1", [id]);
    const events = await outbox(tenant.tenantId);
    expect(events.map((e) => e.topic)).toEqual(['knowledge.item_released', 'knowledge.item_changed', 'knowledge.item_withdrawn']);
    expect(events[0]?.payload).toEqual({ item_id: id, status: 'verified', department_id: null, sensitivity: 1, previous_sensitivity: 1 });
    expect(events[1]?.payload).toMatchObject({ sensitivity: 2, previous_sensitivity: 1 });
    const raw = JSON.stringify(events);
    expect(raw).not.toContain('Synthetic item');
    expect(raw).not.toContain('Synthetic body');
  });

  it('a change that is rolled back leaves no event', async () => {
    const id = await item(tenant, 0);
    const before = (await outbox(tenant.tenantId)).length;
    await su.query('BEGIN');
    await su.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.tenantId]);
    await su.query("UPDATE knowledge_items SET status = 'verified', verified_by_card_id = $1, verified_at = now() WHERE id = $2", [tenant.ownerCard.id, id]);
    await su.query('ROLLBACK');
    expect((await outbox(tenant.tenantId)).length).toBe(before);
  });

  it('the AI service cannot touch the outbox or the endpoints; the API cannot delete an endpoint or write an event itself', async () => {
    const app = await appRoleClient();
    try {
      await app.query('BEGIN');
      await app.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.tenantId]);
      await expect(app.query('DELETE FROM webhook_endpoints')).rejects.toMatchObject({ code: '42501' });
      await app.query('ROLLBACK');
      await app.query('BEGIN');
      await app.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.tenantId]);
      await expect(app.query(`INSERT INTO outbox_events (tenant_id, topic, payload) VALUES ($1, 'knowledge.item_released', '{}')`, [tenant.tenantId]))
        .rejects.toMatchObject({ code: '42501' });
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
    const grants = await su.query(
      `SELECT t AS table_name FROM unnest(ARRAY['outbox_events', 'webhook_endpoints', 'webhook_deliveries', 'mail_notices', 'mail_messages']) AS t
        WHERE has_table_privilege('legacyai_ai', t, 'SELECT') OR has_table_privilege('legacyai_ai', t, 'INSERT')
           OR has_table_privilege('legacyai_ai', t, 'UPDATE') OR has_table_privilege('legacyai_ai', t, 'DELETE')`);
    expect(grants.rows).toEqual([]);
  });
});

describe('endpoints: made, listed, changed and removed by the Owner only', () => {
  let tenant: TestTenant;
  beforeAll(async () => {
    tenant = await createTenant(t, 'hooks');
  });

  it('the secret is shown once and stored only encrypted; nothing secret reaches the audit trail, the retry record or the log', async () => {
    const idem = `hook-${randomUUID()}`;
    const body = { name: 'Intranet', url: 'https://hooks.example.com/a', topics: ['knowledge.item_released'], max_sensitivity: 0 };
    const made = await tenant.owner.post('/v1/webhooks', body, idem);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: 'Intranet', url: 'https://hooks.example.com/a', topics: ['knowledge.item_released'], max_sensitivity: 0, status: 'active', secret_already_shown: false });
    const secret = made.body.signing_secret as string;
    expect(secret).toMatch(/^whsec_/);
    expect(made.body.secret_hint).toBe(secret.slice(-4));

    const again = await tenant.owner.post('/v1/webhooks', body, idem);
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(made.body.id);
    expect(again.body.secret_already_shown).toBe(true);
    expect(again.body.signing_secret).toBeUndefined();

    const key = secret.slice('whsec_'.length);
    const row = await su.query('SELECT to_jsonb(e)::text AS whole, secret_enc FROM webhook_endpoints e WHERE id = $1', [made.body.id]);
    expect(row.rows[0].whole).not.toContain(key);
    expect((row.rows[0].secret_enc as Buffer).toString('latin1')).not.toContain(key);
    for (const table of ['idempotency_keys', 'audit_log']) {
      const n = await su.query(`SELECT count(*)::int AS n FROM ${table} x WHERE tenant_id = $1 AND to_jsonb(x)::text LIKE $2`, [tenant.tenantId, `%${key}%`]);
      expect(n.rows[0].n, table).toBe(0);
    }
    expect(t.logs.join('\n')).not.toContain(key);

    const audit = await su.query(`SELECT reason_code FROM audit_log WHERE tenant_id = $1 AND resource_id = $2 AND decision = 'event'`, [tenant.tenantId, made.body.id]);
    expect(audit.rows.map((r) => r.reason_code)).toEqual(['WEBHOOK_CREATED']);

    const list = await tenant.owner.get('/v1/webhooks?limit=20');
    expect(list.body.items.map((e: { id: string }) => e.id)).toContain(made.body.id);
    expect(list.raw).not.toContain(key);
    const options = await tenant.owner.get('/v1/webhooks/options');
    expect(options.body.delivery_enabled).toBe(true);
    expect(options.body.topics.map((x: { topic: string }) => x.topic)).toEqual(['knowledge.item_released', 'knowledge.item_changed', 'knowledge.item_withdrawn']);
    expect((await off.app.http.app.inject({ method: 'GET', url: '/v1/webhooks/options' })).statusCode).toBe(401);
  });

  it.each([
    ['http://hooks.example.com/a', 400],                 // the contract asks for https
    ['https://10.0.0.5/a', 422],
    ['https://169.254.169.254/latest/meta-data', 422],
    ['https://localhost/a', 422],
    ['https://metadata.google.internal/a', 422],
    ['https://user:pw@hooks.example.com/a', 422],
    ['https://hooks.example.com:22/a', 422],
    ['https://intranet/a', 422],
  ])('refuses %s (%s)', async (url, status) => {
    const res = await tenant.owner.post('/v1/webhooks', { name: 'x', url, topics: ['knowledge.item_released'], max_sensitivity: 0 });
    expect(res.status).toBe(status);
  });

  it('only the Owner: an Admin can neither list, make, change, test nor remove endpoints', async () => {
    const admin = await addMember(t, tenant.owner, [{ role_key: 'admin' }]);
    const made = await makeEndpoint(tenant);
    expect((await admin.client.get('/v1/webhooks')).status).toBe(403);
    expect((await admin.client.get('/v1/webhooks/options')).status).toBe(403);
    expect((await admin.client.post('/v1/webhooks', { name: 'x', url: 'https://hooks.example.com/x', topics: ['knowledge.item_released'], max_sensitivity: 0 })).status).toBe(403);
    expect((await admin.client.patch(`/v1/webhooks/${made.id}`, { enabled: false })).status).toBe(403);
    expect((await admin.client.post(`/v1/webhooks/${made.id}/test`)).status).toBe(403);
    expect((await admin.client.post(`/v1/webhooks/${made.id}/rotate-secret`)).status).toBe(403);
    expect((await admin.client.get(`/v1/webhooks/${made.id}/deliveries`)).status).toBe(403);
    expect((await admin.client.post(`/v1/webhooks/${made.id}/remove`)).status).toBe(403);
  });

  it('an endpoint of another company is not found', async () => {
    const other = await createTenant(t, 'hooks-other');
    const theirs = await makeEndpoint(other);
    expect((await tenant.owner.patch(`/v1/webhooks/${theirs.id}`, { enabled: false })).status).toBe(404);
    expect((await tenant.owner.get(`/v1/webhooks/${theirs.id}/deliveries`)).status).toBe(404);
    expect((await tenant.owner.post(`/v1/webhooks/${theirs.id}/remove`)).status).toBe(404);
    expect((await tenant.owner.get('/v1/webhooks?limit=50')).body.items.map((e: { id: string }) => e.id)).not.toContain(theirs.id);
  });

  it('at most ten live endpoints; removing one makes room', async () => {
    const own = await createTenant(t, 'hooks-many');
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) ids.push((await makeEndpoint(own)).id);
    const eleventh = await own.owner.post('/v1/webhooks', { name: 'x', url: 'https://hooks.example.com/x', topics: ['knowledge.item_released'], max_sensitivity: 0 });
    expect(eleventh.status).toBe(409);
    expect(eleventh.raw).toContain('too-many-endpoints');
    expect((await own.owner.post(`/v1/webhooks/${ids[0]}/remove`)).status).toBe(200);
    await makeEndpoint(own);
  });

  it('removing is final: the secret is wiped, waiting messages are cancelled, the address cannot change, nothing is deleted', async () => {
    const made = await makeEndpoint(tenant);
    const test = await tenant.owner.post(`/v1/webhooks/${made.id}/test`);
    expect(test.status).toBe(202);
    const removed = await tenant.owner.post(`/v1/webhooks/${made.id}/remove`);
    expect(removed.body).toMatchObject({ status: 'removed', secret_hint: null });
    const twice = await tenant.owner.post(`/v1/webhooks/${made.id}/remove`);
    expect(twice.status).toBe(200);
    const row = await su.query('SELECT secret_enc, secret_key_id FROM webhook_endpoints WHERE id = $1', [made.id]);
    expect(row.rows[0]).toEqual({ secret_enc: null, secret_key_id: null });
    const deliveries = await su.query('SELECT status FROM webhook_deliveries WHERE endpoint_id = $1', [made.id]);
    expect(deliveries.rows.map((r) => r.status)).toEqual(['cancelled']);
    expect((await tenant.owner.patch(`/v1/webhooks/${made.id}`, { enabled: true })).status).toBe(409);
    expect((await tenant.owner.post(`/v1/webhooks/${made.id}/test`)).status).toBe(409);
    expect((await tenant.owner.post(`/v1/webhooks/${made.id}/rotate-secret`)).status).toBe(409);
    // the database refuses what the code never tries
    await expect(seed(tenant.tenantId, `UPDATE webhook_endpoints SET enabled = true WHERE id = $1`, [made.id])).rejects.toThrow(/stays removed/);
    const live = await makeEndpoint(tenant);
    await expect(seed(tenant.tenantId, `UPDATE webhook_endpoints SET url = 'https://evil.example.com/' WHERE id = $1`, [live.id])).rejects.toThrow(/cannot change/);
  });
});

describe('delivery', () => {
  let tenant: TestTenant;
  beforeAll(async () => {
    tenant = await createTenant(t, 'deliver');
  });

  it('a released item reaches a subscribed endpoint once, signed with its secret, in the documented shape', async () => {
    const hook = await makeEndpoint(tenant);
    const id = await item(tenant, 1);
    await verify(tenant, id);
    const result = await run(tenant);
    expect(result).toMatchObject({ published: 1, queued: 1, delivered: 1, failed: 0 });
    const sent = sentTo(tenant);
    expect(sent).toHaveLength(1);
    const msg = sent[0] as WebhookRequest;
    expect(msg.url).toBe('https://hooks.example.com/legacyai');
    expect(verifySignature(hook.secret, msg.headers, msg.body, new Date())).toBe(true);
    const body = JSON.parse(msg.body);
    expect(body).toMatchObject({ type: 'knowledge.item_released', company_id: tenant.tenantId, data: { item_id: id, status: 'verified', sensitivity: 1 } });
    expect(msg.headers['webhook-id']).toBe(body.id);
    // a second run sends nothing more
    expect(await run(tenant)).toMatchObject({ published: 0, queued: 0, delivered: 0 });
    expect(sentTo(tenant)).toHaveLength(1);
    const listed = await tenant.owner.get(`/v1/webhooks/${hook.id}/deliveries`);
    expect(listed.body.items[0]).toMatchObject({ status: 'delivered', attempts: 1, last_status_code: 204, topic: 'knowledge.item_released', next_attempt_at: null });
    await tenant.owner.post(`/v1/webhooks/${hook.id}/remove`);
  });

  it('only what an endpoint subscribed to, within its level, and nothing from before it existed', async () => {
    const before = await item(tenant, 0);
    await verify(tenant, before);
    const low = await makeEndpoint(tenant, { max_sensitivity: 0, topics: ['knowledge.item_released'] });
    const high = await item(tenant, 2);
    const fine = await item(tenant, 0);
    await verify(tenant, high);
    await verify(tenant, fine);
    await seed(tenant.tenantId, "UPDATE knowledge_items SET status = 'stale' WHERE id = $1", [fine]);   // a topic `low` did not take
    transport.sent.length = 0;
    await run(tenant);
    const items = sentTo(tenant).map((m) => JSON.parse(m.body).data.item_id);
    expect(items).toEqual([fine]);
    await tenant.owner.post(`/v1/webhooks/${low.id}/remove`);
  });

  it('a failure is retried later with the same id and body, then given up after 8 attempts', async () => {
    const hook = await makeEndpoint(tenant);
    transport.answer = () => ({ ok: false, error: 'http_status', status: 503 });
    const id = await item(tenant, 0);
    await verify(tenant, id);
    transport.sent.length = 0;
    let at = new Date();
    await run(tenant, at);
    const [row] = (await su.query('SELECT status, attempts, next_attempt_at, last_error, last_status_code FROM webhook_deliveries WHERE endpoint_id = $1', [hook.id])).rows;
    expect(row).toMatchObject({ status: 'pending', attempts: 1, last_error: 'http_status', last_status_code: 503 });
    expect((row.next_attempt_at as Date).getTime() - at.getTime()).toBe(60_000);
    // not before its time
    await run(tenant, new Date(at.getTime() + 30_000));
    expect(sentTo(tenant)).toHaveLength(1);
    for (let n = 2; n <= 8; n += 1) {
      at = new Date(at.getTime() + 2 * 86_400_000);
      await run(tenant, at);
    }
    const sent = sentTo(tenant);
    expect(sent).toHaveLength(8);
    expect(new Set(sent.map((m) => m.headers['webhook-id'])).size).toBe(1);
    expect(new Set(sent.map((m) => m.body)).size).toBe(1);
    const [last] = (await su.query('SELECT status, attempts FROM webhook_deliveries WHERE endpoint_id = $1', [hook.id])).rows;
    expect(last).toEqual({ status: 'failed', attempts: 8 });
    transport.answer = () => ({ ok: true, status: 204 });
    await tenant.owner.post(`/v1/webhooks/${hook.id}/remove`);
  });

  it('an endpoint that keeps failing for a day is paused and the Owners are told; switching it on clears the pause', async () => {
    const own = await createTenant(t, 'deliver-pause');
    const hook = await makeEndpoint(own, { max_sensitivity: 3 });
    transport.answer = () => ({ ok: false, error: 'connect' });
    const ids: string[] = [];
    for (let i = 0; i < 15; i += 1) ids.push(await item(own, 0));
    for (const id of ids) await verify(own, id);
    const later = new Date(Date.now() + 2 * 86_400_000);   // more than a day after the endpoint was made
    notifier.events.length = 0;
    const result = await t.app.webhooks.runCompany(own.tenantId, () => later);
    expect(result.failed).toBe(15);
    expect(result.paused).toBe(1);
    const listed = await own.owner.get('/v1/webhooks');
    expect(listed.body.items[0]).toMatchObject({ id: hook.id, status: 'paused', paused_reason: 'failing', consecutive_failures: 15 });
    expect(notifier.events.filter((e) => e.type === 'webhook_paused' && e.tenantId === own.tenantId)).toHaveLength(1);
    const audit = await su.query(`SELECT reason_code FROM audit_log WHERE tenant_id = $1 AND reason_code = 'WEBHOOK_PAUSED'`, [own.tenantId]);
    expect(audit.rows).toHaveLength(1);
    // paused: nothing is tried, and new events are not queued for it
    const sentBefore = sentTo(own).length;
    await t.app.webhooks.runCompany(own.tenantId, () => new Date(later.getTime() + 86_400_000));
    expect(sentTo(own).length).toBe(sentBefore);
    expect((await own.owner.post(`/v1/webhooks/${hook.id}/test`)).status).toBe(409);
    transport.answer = () => ({ ok: true, status: 200 });
    const on = await own.owner.patch(`/v1/webhooks/${hook.id}`, { enabled: true });
    expect(on.body).toMatchObject({ status: 'active', paused_reason: null, consecutive_failures: 0 });
    await t.app.webhooks.runCompany(own.tenantId, () => new Date(later.getTime() + 3 * 86_400_000));
    expect(sentTo(own).length).toBeGreaterThan(sentBefore);
  });

  it('a test message; a new secret signs the next attempt and the old one no longer does', async () => {
    const hook = await makeEndpoint(tenant);
    const queued = await tenant.owner.post(`/v1/webhooks/${hook.id}/test`);
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ topic: 'webhook.test', status: 'pending', attempts: 0 });
    // one waiting test message per endpoint
    const again = await tenant.owner.post(`/v1/webhooks/${hook.id}/test`);
    expect(again.status).toBe(409);
    expect(again.raw).toContain('webhook-test-waiting');
    const rotated = await tenant.owner.post(`/v1/webhooks/${hook.id}/rotate-secret`);
    expect(rotated.status).toBe(200);
    const fresh = rotated.body.signing_secret as string;
    expect(fresh).not.toBe(hook.secret);
    transport.sent.length = 0;
    await run(tenant);
    const msg = sentTo(tenant).find((m) => JSON.parse(m.body).type === 'webhook.test') as WebhookRequest;
    expect(JSON.parse(msg.body).data).toEqual({ endpoint_id: hook.id });
    expect(verifySignature(fresh, msg.headers, msg.body, new Date())).toBe(true);
    expect(verifySignature(hook.secret, msg.headers, msg.body, new Date())).toBe(false);
    await tenant.owner.post(`/v1/webhooks/${hook.id}/remove`);
  });

  it('a narrower choice applies at once: waiting messages above the new level or for a dropped event are cancelled', async () => {
    const hook = await makeEndpoint(tenant, { max_sensitivity: 2, topics: ['knowledge.item_released', 'knowledge.item_withdrawn'] });
    transport.answer = () => ({ ok: false, error: 'http_status', status: 500 });
    const low = await item(tenant, 0);
    const high = await item(tenant, 2);
    await verify(tenant, low);
    await verify(tenant, high);
    await run(tenant);   // both fail once and wait for their retry
    transport.answer = () => ({ ok: true, status: 204 });
    await tenant.owner.patch(`/v1/webhooks/${hook.id}`, { max_sensitivity: 1 });
    const rows = await su.query(
      `SELECT body->'data'->>'item_id' AS item, status FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY item`, [hook.id]);
    expect(Object.fromEntries(rows.rows.map((r) => [r.item, r.status]))).toEqual({ [low]: 'pending', [high]: 'cancelled' });
    await tenant.owner.patch(`/v1/webhooks/${hook.id}`, { topics: ['knowledge.item_withdrawn'] });
    const after = await su.query(`SELECT status FROM webhook_deliveries WHERE endpoint_id = $1 AND body->'data'->>'item_id' = $2`, [hook.id, low]);
    expect(after.rows[0].status).toBe('cancelled');
    await tenant.owner.post(`/v1/webhooks/${hook.id}/remove`);
  });

  it('switched off by the Owner: nothing is sent and events of that time are not sent later', async () => {
    const hook = await makeEndpoint(tenant);
    await tenant.owner.patch(`/v1/webhooks/${hook.id}`, { enabled: false });
    const id = await item(tenant, 0);
    await verify(tenant, id);
    transport.sent.length = 0;
    await run(tenant);
    await tenant.owner.patch(`/v1/webhooks/${hook.id}`, { enabled: true });
    await run(tenant);
    expect(sentTo(tenant)).toEqual([]);
    await tenant.owner.post(`/v1/webhooks/${hook.id}/remove`);
  });

  it('with WEBHOOK_DELIVERY unset the server sends nothing and says so', async () => {
    const quiet = await createTenant(off, 'deliver-off');
    const res: Res = await quiet.owner.get('/v1/webhooks/options');
    expect(res.body.delivery_enabled).toBe(false);
    await quiet.owner.post('/v1/webhooks', { name: 'x', url: 'https://hooks.example.com/x', topics: ['knowledge.item_released'], max_sensitivity: 0 });
    const id = await item(quiet, 0);
    await verify(quiet, id);
    expect(await off.app.webhooks.runCompany(quiet.tenantId)).toEqual({ published: 0, queued: 0, delivered: 0, failed: 0, paused: 0 });
    const events = await su.query('SELECT published_at FROM outbox_events WHERE tenant_id = $1', [quiet.tenantId]);
    expect(events.rows).toEqual([{ published_at: null }]);
  });

  it('housekeeping removes old events and finished deliveries, and keeps what is still waiting', async () => {
    const own = await createTenant(t, 'deliver-purge');
    const hook = await makeEndpoint(own, { max_sensitivity: 3 });
    const id = await item(own, 0);
    await verify(own, id);
    await t.app.webhooks.runCompany(own.tenantId);
    await own.owner.post(`/v1/webhooks/${hook.id}/test`);   // waiting
    const removed = await t.app.db.withTenantTx(own.tenantId, (tx) => t.app.webhooks.purge(tx, own.tenantId, new Date(Date.now() + 60_000)));
    expect(removed).toBe(2);   // the event and its delivered message
    const left = await su.query('SELECT topic, status FROM webhook_deliveries WHERE tenant_id = $1', [own.tenantId]);
    expect(left.rows).toEqual([{ topic: 'webhook.test', status: 'pending' }]);
  });
});
