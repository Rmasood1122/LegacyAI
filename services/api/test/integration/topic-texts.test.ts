// Topic names and descriptions are written and read only by the AI service (decision D41, step 6 part 4b; the
// founder's choice of 2026-10-25), so they can be stored sealed: the API login may not read or write them, the topic
// list gets them from the AI service (only for topics the caller may read), and creating or changing a topic is done
// there. Against the stand-in AI service (test/helpers/ai-stub.ts); the real service is tested in services/ai
// (tests/integration/test_topic_texts.py).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiStub, StubError } from '../helpers/ai-stub.ts';
import { appRoleClient, createTenant, startApp, type TestApp, type TestTenant } from '../helpers/harness.ts';

let stub: AiStub;
let t: TestApp;
let tenant: TestTenant;

beforeAll(async () => {
  stub = await new AiStub().start();
  t = await startApp({}, { AI_SERVICE_URL: stub.url });
  tenant = await createTenant(t, 'topic-texts');
});

afterAll(async () => {
  await t?.close();
  await stub?.stop();
});

beforeEach(() => stub.reset());

describe('topic names come from the AI service', () => {
  it('a topic is created and changed by the AI service, with the caller named in the token', async () => {
    const name = `Boiler blowdown ${randomUUID().slice(0, 8)}`;
    const made = await tenant.owner.post('/v1/topics', { name, description: 'synthetic', sensitivity: 1 });
    expect(made.status, made.raw).toBe(201);
    expect(made.body).toMatchObject({ name, description: 'synthetic', sensitivity: 1, origin: 'admin', status: 'active' });
    const create = stub.ofAction('topic.create');
    expect(create).toHaveLength(1);
    expect(create[0]!.body).toEqual({ name, description: 'synthetic', department_id: null, sensitivity: 1 });
    expect(create[0]!.claims.card_id).toBe(tenant.ownerCard.id);

    const changed = await tenant.owner.patch(`/v1/topics/${made.body.id}`, { description: 'changed' });
    expect(changed.status, changed.raw).toBe(200);
    expect(changed.body).toMatchObject({ id: made.body.id, name, description: 'changed' });
    expect(stub.ofAction('topic.update')[0]!.claims.subject).toBe(made.body.id);
  });

  it('what the AI service refuses comes back as before: a duplicate name and an illegal status change are 409', async () => {
    const name = `Duplicate ${randomUUID().slice(0, 8)}`;
    expect((await tenant.owner.post('/v1/topics', { name })).status).toBe(201);
    const again = await tenant.owner.post('/v1/topics', { name: name.toUpperCase() });
    expect(again.status).toBe(409);
    expect(again.body.type).toContain('duplicate-topic');
    const other = await tenant.owner.post('/v1/topics', { name: `Retired ${randomUUID().slice(0, 8)}` });
    expect((await tenant.owner.patch(`/v1/topics/${other.body.id}`, { status: 'retired' })).status).toBe(200);
    const back = await tenant.owner.patch(`/v1/topics/${other.body.id}`, { status: 'active' });
    expect(back.status).toBe(409);
    expect(back.body.type).toContain('illegal-transition');
  });

  it('the list shows the names the AI service gives, asking for exactly the topics shown with the caller\'s topic:read filter', async () => {
    stub.answers.set('topic.texts', (c) => ({
      topics: Object.fromEntries((c.body.ids as string[]).map((id) => [id, { name: 'Name from the AI service', description: 'Described there' }])),
    }));
    const list = await tenant.owner.get('/v1/topics?limit=50');
    expect(list.status, list.raw).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    for (const item of list.body.items) expect(item).toMatchObject({ name: 'Name from the AI service', description: 'Described there' });
    const calls = stub.ofAction('topic.texts');
    expect(calls).toHaveLength(1);
    expect([...calls[0]!.body.ids].sort()).toEqual(list.body.items.map((x: any) => x.id).sort());
    expect(calls[0]!.claims.tenant_id).toBe(tenant.tenantId);
    expect(calls[0]!.claims.filter.action).toBe('topic:read');
  });

  it('without the AI service there are no names: the list, creating and changing fail instead of showing wrong ones', async () => {
    const made = await tenant.owner.post('/v1/topics', { name: `Before ${randomUUID().slice(0, 8)}` });
    for (const action of ['topic.texts', 'topic.create', 'topic.update']) stub.answers.set(action, () => new StubError(503, 'company_key_unavailable'));
    expect((await tenant.owner.get('/v1/topics')).status).toBe(503);
    expect((await tenant.owner.post('/v1/topics', { name: `During ${randomUUID().slice(0, 8)}` })).status).toBe(503);
    expect((await tenant.owner.patch(`/v1/topics/${made.body.id}`, { description: 'x' })).status).toBe(503);
  });

  it('the API login can neither read a topic name nor write a topic', async () => {
    const app = await appRoleClient();
    try {
      await app.query('BEGIN');
      await app.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.tenantId]);
      await app.query('SAVEPOINT a');
      await expect(app.query('SELECT name FROM topics LIMIT 1')).rejects.toThrow(/permission denied/);
      await app.query('ROLLBACK TO SAVEPOINT a');
      await expect(app.query('SELECT description FROM topics LIMIT 1')).rejects.toThrow(/permission denied/);
      await app.query('ROLLBACK TO SAVEPOINT a');
      await expect(app.query("UPDATE topics SET status = 'retired'")).rejects.toThrow(/permission denied/);
      await app.query('ROLLBACK TO SAVEPOINT a');
      await expect(app.query(`INSERT INTO topics (tenant_id, name, origin, status) VALUES ($1, 'Synthetic', 'admin', 'active')`, [tenant.tenantId]))
        .rejects.toThrow(/permission denied/);
      await app.query('ROLLBACK TO SAVEPOINT a');
      expect((await app.query('SELECT id, status FROM topics LIMIT 1')).rows.length).toBe(1);   // the rest stays readable
    } finally {
      await app.query('ROLLBACK').catch(() => undefined);
      await app.end();
    }
  });
});
