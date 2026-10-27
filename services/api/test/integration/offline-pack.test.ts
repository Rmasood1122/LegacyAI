// Offline packs (feature 9; the founder's choices of 2026-10-27): the API asks the AI service for the verified level-0/1
// knowledge of a job role with the caller's own read filters, stamps when the pack was made and that it may be opened
// for 7 days, writes the audit entry, and refuses a machine's key. Against the stand-in AI service; what goes into a
// pack is tested in services/ai (tests/integration/test_offline_pack.py).
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiStub, StubError } from '../helpers/ai-stub.ts';
import { addMember, createTenant, startApp, superuser, type TestApp, type TestTenant } from '../helpers/harness.ts';

let stub: AiStub;
let t: TestApp;
let tenant: TestTenant;
let su: pg.Client;
const ITEM = randomUUID();
const TOPIC = randomUUID();

beforeAll(async () => {
  stub = await new AiStub().start();
  t = await startApp({}, { AI_SERVICE_URL: stub.url });
  su = await superuser();
  tenant = await createTenant(t, 'offline');
});

afterAll(async () => {
  await su?.end();
  await t?.close();
  await stub?.stop();
});

beforeEach(() => {
  stub.reset();
  stub.answers.set('offline.pack', (c) => ({
    job_role: c.body.job_role, truncated: false, topics: [{ topic_id: TOPIC, name: 'Relief valves' }],
    items: [{ id: ITEM, title: 'Relief valve check', body: 'Lift the lever monthly.', status: 'verified', sensitivity: 0, verified_at: new Date().toISOString(),
      topic_ids: [TOPIC], extra: 'not passed on' }],
  }));
});

describe('offline packs', () => {
  it('a pack says when it was made and that it may be opened for 7 days, and holds what the AI service gave', async () => {
    const res = await tenant.owner.get(`/v1/offline-pack?job_role=${encodeURIComponent('Boiler operator')}`);
    expect(res.status, res.raw).toBe(200);
    expect(Math.abs(Date.parse(res.body.as_of) - t.clock.now().getTime())).toBeLessThan(60_000);   // made now
    expect(Date.parse(res.body.expires_at) - Date.parse(res.body.as_of)).toBe(7 * 86_400_000);
    expect(res.body).toMatchObject({ job_role: 'Boiler operator', max_sensitivity: 1, truncated: false, topics: [{ topic_id: TOPIC, name: 'Relief valves' }] });
    expect(res.body.items).toEqual([expect.objectContaining({ id: ITEM, title: 'Relief valve check', body: 'Lift the lever monthly.' })]);
    expect(res.raw).not.toContain('not passed on');
  });

  it('the AI service is asked with the caller\'s own knowledge:read and topic:read filters', async () => {
    const learner = await addMember(t, tenant.owner, [{ role_key: 'successor' }]);
    expect((await learner.client.get('/v1/offline-pack?job_role=x')).status).toBe(200);
    const [call] = stub.ofAction('offline.pack');
    expect(call!.body).toEqual({ job_role: 'x' });
    expect(call!.claims.card_id).toBe(learner.card.id);
    expect(call!.claims.filter.action).toBe('knowledge:read');
    expect(call!.claims.topic_filter.action).toBe('topic:read');
  });

  it('every download is in the audit log, with the count and nothing of the content', async () => {
    expect((await tenant.owner.get('/v1/offline-pack?job_role=y')).status).toBe(200);
    const { rows } = await su.query(
      "SELECT actor_card_id::text AS card, details FROM audit_log WHERE tenant_id = $1 AND reason_code = 'OFFLINE_PACK_ISSUED' ORDER BY seq DESC LIMIT 1",
      [tenant.tenantId]);
    expect(rows[0]?.card).toBe(tenant.ownerCard.id);
    const details = typeof rows[0]?.details === 'string' ? JSON.parse(rows[0].details) : rows[0]?.details;
    expect(details).toEqual({ count: 1 });
    expect(JSON.stringify(rows)).not.toContain('Relief valve');
  });

  it('without the AI service, or with the company key off, there is no pack and nothing is logged as given', async () => {
    stub.answers.set('offline.pack', () => new StubError(503, 'company_key_unavailable'));
    const before = (await su.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND reason_code = 'OFFLINE_PACK_ISSUED'",
      [tenant.tenantId])).rows[0].n;
    const res = await tenant.owner.get('/v1/offline-pack?job_role=z');
    expect(res.status).toBe(503);
    expect(res.body.type).toContain('company-key-unavailable');
    const after = (await su.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND reason_code = 'OFFLINE_PACK_ISSUED'",
      [tenant.tenantId])).rows[0].n;
    expect(after).toBe(before);
  });

  it('a machine\'s key cannot take a pack', async () => {
    const made = await tenant.owner.post('/v1/api-keys', { name: 'Test machine', scope: ['knowledge:read'], max_sensitivity: 0, expires_in_days: 30 });
    expect(made.status, made.raw).toBe(201);
    const res = await t.app.http.app.inject({ method: 'GET', url: '/v1/offline-pack?job_role=x', headers: { authorization: `Bearer ${made.body.api_key}` } });
    expect(res.statusCode).toBe(403);
    expect(stub.ofAction('offline.pack')).toHaveLength(0);
  });
});
