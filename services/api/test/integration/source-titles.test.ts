// Document titles are sealed (decision D41, step 6 part 4a; the founder's choice of 2026-10-25): the API login may not
// read them, and the document list and page get them from the AI service, which names only documents the caller may
// read. Against the stand-in AI service (test/helpers/ai-stub.ts); the real service is tested in services/ai
// (tests/integration/test_sealed_document_titles.py).
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiStub, StubError } from '../helpers/ai-stub.ts';
import { appRoleClient, createTenant, startApp, superuser, type TestApp, type TestTenant } from '../helpers/harness.ts';

let stub: AiStub;
let t: TestApp;
let tenant: TestTenant;
let su: pg.Client;
let doc: string;

beforeAll(async () => {
  stub = await new AiStub().start();
  t = await startApp({}, { AI_SERVICE_URL: stub.url });
  su = await superuser();
  tenant = await createTenant(t, 'titles');
  doc = randomUUID();
  // a document written before the titles were sealed: its title is still readable in the database
  await su.query('BEGIN');
  await su.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.tenantId]);
  await su.query(`INSERT INTO sources (id, tenant_id, kind, title, department_id, sensitivity, company_owned_attested_by_card_id, uploaded_by_card_id, status)
                  VALUES ($1, $2, 'document', 'Title read from the database', NULL, 1, $3, $3, 'awaiting_content')`,
  [doc, tenant.tenantId, tenant.ownerCard.id]);
  await su.query('COMMIT');
});

afterAll(async () => {
  await su?.end();
  await t?.close();
  await stub?.stop();
});

beforeEach(() => stub.reset());

describe('document titles come from the AI service', () => {
  it('the list and the page show the title the AI service gives, never one read from the database', async () => {
    stub.answers.set('source.titles', (c) => ({ titles: Object.fromEntries((c.body.ids as string[]).map((id) => [id, 'Title from the AI service'])) }));
    const list = await tenant.owner.get('/v1/sources');
    expect(list.status, list.raw).toBe(200);
    expect(list.body.items.find((s: any) => s.id === doc).title).toBe('Title from the AI service');
    const page = await tenant.owner.get(`/v1/sources/${doc}`);
    expect(page.status, page.raw).toBe(200);
    expect(page.body.title).toBe('Title from the AI service');
    expect(JSON.stringify([list.body, page.body])).not.toContain('Title read from the database');
  });

  it('the AI service is asked for exactly the documents shown, with the caller\'s source:read filter', async () => {
    const list = await tenant.owner.get('/v1/sources');
    const calls = stub.ofAction('source.titles');
    expect(calls).toHaveLength(1);
    expect([...calls[0]!.body.ids].sort()).toEqual(list.body.items.map((s: any) => s.id).sort());
    expect(calls[0]!.claims.tenant_id).toBe(tenant.tenantId);
    expect(calls[0]!.claims.filter.action).toBe('source:read');
  });

  it('without the AI service there are no titles: the request fails instead of showing a wrong one', async () => {
    stub.answers.set('source.titles', () => new StubError(503, 'company_key_unavailable'));
    expect((await tenant.owner.get('/v1/sources')).status).toBe(503);
    expect((await tenant.owner.get(`/v1/sources/${doc}`)).status).toBe(503);
  });

  it('the API login cannot read a title from the database at all', async () => {
    const app = await appRoleClient();
    try {
      await app.query('BEGIN');
      await app.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.tenantId]);
      await expect(app.query('SELECT title FROM sources WHERE id = $1', [doc])).rejects.toThrow(/permission denied/);
    } finally {
      await app.query('ROLLBACK').catch(() => undefined);
      await app.end();
    }
  });
});
