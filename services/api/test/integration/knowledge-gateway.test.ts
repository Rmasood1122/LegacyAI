// The knowledge gateway against the real database and a stand-in AI service (test/helpers/ai-stub.ts).
// What is checked here is the API's side: the gateway route kind, the service token, the approval step
// of an answer, the knowledge guards of the policy decision point, consent withdrawal, the review
// queue and the settings. The real AI service is exercised by test/contract/phase2-walk.test.ts.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiStub, StubError } from '../helpers/ai-stub.ts';
import { addMember, createTenant, platformOperator, startApp, superuser, type TestApp, type TestMember, type TestTenant } from '../helpers/harness.ts';

let stub: AiStub;
let t: TestApp;
let tenant: TestTenant;
let other: TestTenant;
let expert: TestMember;
let reviewer: TestMember;
let learner: TestMember;
let su: pg.Client;
let ownerPerson: string;

/** Runs SQL as the superuser for one company (row-level security binds the guard functions' owner too). */
async function seed<T = any>(tenantId: string, fn: (q: (sql: string, params?: unknown[]) => Promise<T[]>) => Promise<unknown>): Promise<void> {
  await su.query('BEGIN');
  try {
    await su.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await fn(async (sql, params) => (await su.query(sql, params)).rows as T[]);
    await su.query('COMMIT');
  } catch (err) {
    await su.query('ROLLBACK');
    throw err;
  }
}

/** A ready company document with one active passage. Returns (source id, chunk id). */
async function readySource(tn: TestTenant, opts: { sensitivity?: number; department?: string | null } = {}): Promise<{ source: string; chunk: string }> {
  const source = randomUUID();
  const chunk = randomUUID();
  const vec = `[${Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`;
  await seed(tn.tenantId, async (q) => {
    await q(`INSERT INTO sources (id, tenant_id, kind, title, department_id, sensitivity, company_owned_attested_by_card_id, uploaded_by_card_id, status)
             VALUES ($1, $2, 'document', 'Synthetic manual', $3, $4, $5, $5, 'awaiting_content')`,
    [source, tn.tenantId, opts.department ?? null, opts.sensitivity ?? 1, tn.ownerCard.id]);
    await q("UPDATE sources SET status = 'processing' WHERE id = $1", [source]);
    await q(`INSERT INTO chunks (id, tenant_id, kind, source_id, ordinal, text, token_estimate, embedding, embedding_model, department_id, sensitivity, status)
             VALUES ($1, $2, 'source', $3, 0, 'Synthetic passage about the boiler.', 8, $4::halfvec, 'fake-hash-384@1', $5, $6, 'active')`,
    [chunk, tn.tenantId, source, vec, opts.department ?? null, opts.sensitivity ?? 1]);
    await q("UPDATE sources SET status = 'ready' WHERE id = $1", [source]);
  });
  return { source, chunk };
}

/** An item in review (or verified by `verifierCard`), contributed by `owner` (with consent) or by nobody. */
async function item(tn: TestTenant, opts: { owner?: TestMember; author?: TestMember; verifierCard?: string; sensitivity?: number } = {}): Promise<string> {
  const id = randomUUID();
  await seed(tn.tenantId, async (q) => {
    let consent: string | null = null;
    if (opts.owner) {
      // one live consent per person and scope (the database enforces it): reuse it if there is one
      const live = await q(`SELECT id FROM consents WHERE tenant_id = $1 AND person_id = $2 AND scope = 'own_words'
                              AND withdrawn_at IS NULL AND superseded_at IS NULL`, [tn.tenantId, opts.owner.personId]);
      const rows = live.length > 0 ? live : await q(`INSERT INTO consents (tenant_id, person_id, scope, purpose, policy_version, granted_by_card_id)
                            VALUES ($1, $2, 'own_words', 'Synthetic', 't1', $3) RETURNING id`, [tn.tenantId, opts.owner.personId, opts.owner.card.id]);
      consent = rows[0].id;
    }
    await q(`INSERT INTO knowledge_items (id, tenant_id, title, origin, department_id, sensitivity, owner_person_id, consent_id)
             VALUES ($1, $2, 'Synthetic item', 'manual', NULL, $3, $4, $5)`, [id, tn.tenantId, opts.sensitivity ?? 1, opts.owner?.personId ?? null, consent]);
    const v = await q(`INSERT INTO knowledge_versions (tenant_id, item_id, version_no, body, change_kind, author_card_id, author_person_id)
                       VALUES ($1, $2, 1, 'Synthetic body.', 'written', $3, $4) RETURNING id`,
    [tn.tenantId, id, opts.author?.card.id ?? null, opts.author?.personId ?? null]);
    await q("UPDATE knowledge_items SET current_version_id = $1, status = 'in_review' WHERE id = $2", [v[0].id, id]);
    if (opts.verifierCard) {
      await q("UPDATE knowledge_items SET status = 'verified', verified_by_card_id = $1, verified_at = now() WHERE id = $2", [opts.verifierCard, id]);
    }
  });
  return id;
}

beforeAll(async () => {
  stub = await new AiStub().start();
  t = await startApp({}, { AI_SERVICE_URL: stub.url });
  su = await superuser();
  tenant = await createTenant(t, 'kgw');
  other = await createTenant(t, 'kgw-other');
  expert = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
  reviewer = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);   // during the pilot, Experts are the reviewers
  learner = await addMember(t, tenant.owner, [{ role_key: 'successor' }]);
  ownerPerson = (await su.query('SELECT person_id FROM cards WHERE id = $1', [tenant.ownerCard.id])).rows[0].person_id;
});

afterAll(async () => {
  await su?.end();
  await t?.close();
  await stub?.stop();
});

beforeEach(() => stub.reset());

describe('gateway route kind (commit, call, finish)', () => {
  it('the allow decision is committed and no database transaction is open while the AI service works', async () => {
    let seen: { allowRows: number; openTx: number } | null = null;
    stub.during = async () => {
      const allow = await su.query(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'capture:upload' AND decision = 'allow'`,
        [tenant.tenantId]);
      const open = await su.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'legacyai_app' AND state = 'idle in transaction'`);
      seen = { allowRows: allow.rows[0].n, openTx: open.rows[0].n };
    };
    const res = await tenant.owner.post('/v1/sources', { title: 'Synthetic manual', company_document: true });
    expect(res.status).toBe(201);
    expect(seen).not.toBeNull();
    expect(seen!.allowRows).toBeGreaterThan(0);
    expect(seen!.openTx).toBe(0);
  });

  it('a failed call answers 502, records "allowed but failed", and frees the idempotency key for a retry', async () => {
    stub.answers.set('source.create', () => new StubError(500, 'boom'));
    const key = `k-${randomUUID()}`;
    const res = await tenant.owner.post('/v1/sources', { title: 'Fails', company_document: true }, key);
    expect(res.status).toBe(502);
    const failed = await su.query(`SELECT details FROM audit_log WHERE tenant_id = $1 AND action = 'capture:upload' AND decision = 'allow'
                                    AND details::jsonb->>'outcome' = 'failed' ORDER BY seq DESC LIMIT 1`, [tenant.tenantId]);
    expect(JSON.parse(failed.rows[0]?.details ?? '{}')).toMatchObject({ outcome: 'failed', status: 502 });
    stub.answers.delete('source.create');
    const retry = await tenant.owner.post('/v1/sources', { title: 'Fails', company_document: true }, key);
    expect(retry.status).toBe(201);
    expect(stub.ofAction('source.create')).toHaveLength(2);
  });

  it('a replayed request returns the stored answer without calling the AI service again', async () => {
    const key = `k-${randomUUID()}`;
    const first = await tenant.owner.post('/v1/sources', { title: 'Once', company_document: true }, key);
    const second = await tenant.owner.post('/v1/sources', { title: 'Once', company_document: true }, key);
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(stub.ofAction('source.create')).toHaveLength(1);
  });

  it('when the AI service cannot be reached the caller gets 502 and nothing else changes', async () => {
    const offline = await startApp({}, { AI_SERVICE_URL: 'http://127.0.0.1:9' });
    try {
      const owner = (await import('../helpers/harness.ts')).login;
      const client = await owner(offline, tenant.ownerCard, { passkey: tenant.ownerPasskey });
      expect((await client.post('/v1/sources', { title: 'x', company_document: true })).status).toBe(502);
    } finally {
      await offline.close();
    }
  });
});

describe('the service token', () => {
  it('names one operation and one record, lives 60 seconds, and carries the access filter for reads', async () => {
    const id = await item(tenant, { verifierCard: reviewer.card.id });
    expect((await tenant.owner.get(`/v1/knowledge/items/${id}`)).status).toBe(200);
    const call = stub.ofAction('item.read')[0]!;
    expect(call.claims.subject).toBe(id);
    expect(call.claims.exp - call.claims.iat).toBe(60);
    expect(call.claims.tenant_id).toBe(tenant.tenantId);
    expect(call.claims.card_id).toBe(tenant.ownerCard.id);
    expect(call.claims.filter).toMatchObject({ v: 1, tenant_id: tenant.tenantId, action: 'knowledge:read', nothing: false });
    expect(call.claims.limits).toEqual({});        // reading content never carries an AI budget
  });

  it('only operations that may use a model carry the AI limits', async () => {
    await learner.client.post('/v1/knowledge/ask', { question: 'How do I start the boiler?' });
    expect(stub.ofAction('knowledge.candidates')[0]!.claims.limits).toEqual({});
    expect(stub.ofAction('knowledge.answer')[0]!.claims.limits).toMatchObject({ monthly_cap_micro_usd: expect.any(Number), calls_per_hour: expect.any(Number) });
  });
});

describe('asking: lock 3 - every candidate is checked again before it may reach the prompt', () => {
  it('passages the reader may not see are dropped, whatever the AI service proposes', async () => {
    const released = await item(tenant, { verifierCard: reviewer.card.id, sensitivity: 0 });
    const releasedChunk = randomUUID();
    const vec = `[${Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`;
    await seed(tenant.tenantId, (q) => q(
      `INSERT INTO chunks (id, tenant_id, kind, knowledge_item_id, ordinal, text, token_estimate, embedding, embedding_model, sensitivity, verification_status, status)
       VALUES ($1, $2, 'item', $3, 0, 'Released know-how.', 4, $4::halfvec, 'fake-hash-384@1', 0, 'verified', 'active')`,
      [releasedChunk, tenant.tenantId, released, vec]));
    const internal = await readySource(tenant, { sensitivity: 1 });       // unverified, internal
    const restricted = await readySource(tenant, { sensitivity: 3 });
    const elsewhere = await readySource(other, { sensitivity: 0 });         // another company
    stub.answers.set('knowledge.candidates', () => ({
      candidates: [releasedChunk, internal.chunk, restricted.chunk, elsewhere.chunk, randomUUID()].map((id) => ({ id, kind: 'source' })),
    }));
    const res = await learner.client.post('/v1/knowledge/ask', { question: 'How do I start the boiler?' });
    expect(res.status).toBe(200);
    expect(stub.ofAction('knowledge.answer')[0]!.claims.approved).toEqual([releasedChunk]);

    stub.reset();
    stub.answers.set('knowledge.candidates', () => ({ candidates: [releasedChunk, internal.chunk, restricted.chunk].map((id) => ({ id, kind: 'source' })) }));
    await tenant.owner.post('/v1/knowledge/ask', { question: 'How do I start the boiler?' });
    expect(new Set(stub.ofAction('knowledge.answer')[0]!.claims.approved)).toEqual(new Set([releasedChunk, internal.chunk, restricted.chunk]));
  });

  it('asking a named expert needs that person\'s consent to be named', async () => {
    const res = await learner.client.post('/v1/knowledge/ask', { question: 'Anything?', expert_person_id: expert.personId });
    expect(res.status).toBe(422);
    expect(stub.calls).toHaveLength(0);
  });

  it('expert names on citations come from the API, only with consent', async () => {
    const id = await item(tenant, { owner: expert, verifierCard: reviewer.card.id });
    stub.answers.set('knowledge.answer', () => ({
      outcome: 'answered', answer: 'Do it.', reason: null, confidence: 'medium', contains_unverified_sources: false, can_ask_expert: false,
      citations: [{ ref: 'S1', kind: 'item', id, title: 'Synthetic item', snippet: 'Synthetic body.', verification_status: 'verified', derived_from: [], expert_display_name: 'leak?' }],
    }));
    const before = await tenant.owner.post('/v1/knowledge/ask', { question: 'How?' });
    expect(before.body.citations[0].expert_display_name).toBeNull();     // no named_expert consent: no name, whatever Python says
    await seed(tenant.tenantId, (q) => q(`INSERT INTO consents (tenant_id, person_id, scope, purpose, policy_version, granted_by_card_id)
                                          VALUES ($1, $2, 'named_expert', 'Synthetic', 't1', $3)`, [tenant.tenantId, expert.personId, expert.card.id]));
    const after = await tenant.owner.post('/v1/knowledge/ask', { question: 'How?' });
    expect(after.body.citations[0].expert_display_name).toMatch(/^Member /);
  });
});

describe('knowledge guards in the policy decision point', () => {
  it('second reviewer: neither the contributor nor the author may verify - refused before any AI call', async () => {
    const byContributor = await item(tenant, { owner: expert });
    expect((await expert.client.post(`/v1/knowledge/items/${byContributor}/verify`)).status).toBe(403);
    const byAuthor = await item(tenant, { author: reviewer });
    expect((await reviewer.client.post(`/v1/knowledge/items/${byAuthor}/verify`)).status).toBe(403);
    expect(stub.ofAction('item.verify')).toHaveLength(0);
    expect((await reviewer.client.post(`/v1/knowledge/items/${byContributor}/verify`)).status).toBe(200);
    const denied = await su.query(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'knowledge:verify' AND reason_code = 'DENY_SELF_REVIEW'`,
      [tenant.tenantId]);
    expect(denied.rows[0].n).toBe(2);
  });

  it('the contributor cannot release their own item to learners', async () => {
    const own = await item(tenant, { owner: reviewer, verifierCard: expert.card.id });
    expect((await reviewer.client.patch(`/v1/knowledge/items/${own}/labels`, { sensitivity: 0 })).status).toBe(403);
    expect((await expert.client.patch(`/v1/knowledge/items/${own}/labels`, { sensitivity: 0 })).status).toBe(200);
  });

  it('verified only: a learner reads verified released items, not unverified ones', async () => {
    const verified = await item(tenant, { verifierCard: reviewer.card.id, sensitivity: 0 });
    const unverified = await item(tenant, { sensitivity: 0 });
    expect((await learner.client.get(`/v1/knowledge/items/${verified}`)).status).toBe(200);
    expect((await learner.client.get(`/v1/knowledge/items/${unverified}`)).status).toBe(403);
    // the filter handed to the AI service for lists says the same
    await learner.client.get('/v1/knowledge/items');
    expect(stub.ofAction('item.list').at(-1)!.claims.filter).toMatchObject({ only_verified: true });
    // with the company setting changed, unverified released material is visible to learners
    expect((await tenant.owner.patch('/v1/knowledge/settings', { learner_sources: 'all_marked' })).status).toBe(200);
    expect((await learner.client.get(`/v1/knowledge/items/${unverified}`)).status).toBe(200);
    await tenant.owner.patch('/v1/knowledge/settings', { learner_sources: 'verified_only' });
  });

  it('another company\'s item is simply not found', async () => {
    const theirs = await item(other, { verifierCard: other.ownerCard.id });
    expect((await tenant.owner.get(`/v1/knowledge/items/${theirs}`)).status).toBe(404);
  });
});

describe('uploads', () => {
  async function waitingSource(): Promise<string> {
    const id = randomUUID();
    await seed(tenant.tenantId, (q) => q(`INSERT INTO sources (id, tenant_id, kind, title, sensitivity, company_owned_attested_by_card_id, uploaded_by_card_id, status)
                                          VALUES ($1, $2, 'document', 'Waiting', 1, $3, $3, 'awaiting_content')`, [id, tenant.tenantId, tenant.ownerCard.id]));
    return id;
  }
  const put = (id: string, body: Buffer, type: string): Promise<any> => tenant.owner.request('PUT', `/v1/sources/${id}/content`, body as unknown as object,
    { headers: { 'content-type': type } });

  it('a text file is passed on as bytes with its type', async () => {
    const id = await waitingSource();
    const res = await put(id, Buffer.from('Synthetic notes about the chiller.\n'), 'text/plain');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ready' });
    const call = stub.ofAction('source.content')[0]!;
    expect(call.contentType).toBe('text/plain');
    expect(call.bytes).toBe(35);
    expect(call.claims.subject).toBe(id);
  });

  it('other types and oversized files are refused by the API', async () => {
    const id = await waitingSource();
    expect((await put(id, Buffer.from('PK\u0003\u0004'), 'application/zip')).status).toBeGreaterThanOrEqual(400);
    expect((await put(id, Buffer.alloc(10 * 1024 * 1024 + 10, 97), 'text/plain')).status).toBe(413);
    expect((await tenant.owner.request('PUT', `/v1/sources/${id}/content`, { text: 'json is not a file' })).status).toBe(400);
    expect(stub.ofAction('source.content')).toHaveLength(0);
  });
});

describe('the company-wide consent list', () => {
  it('shows a card with an "own" grant only its own consents; the owner sees everyone\'s', async () => {
    const mine = await learner.client.post('/v1/consents', { scope: 'own_words', purpose: 'Synthetic test', policy_version: 't1' });
    const theirs = await reviewer.client.post('/v1/consents', { scope: 'named_expert', purpose: 'Synthetic test', policy_version: 't1' });
    expect([mine.status, theirs.status]).toEqual([201, 201]);
    const ids = async (who: TestMember['client'], query = ''): Promise<string[]> => {
      const res = await who.get(`/v1/consents?limit=50${query}`);
      expect(res.status).toBe(200);
      return (res.body.items as Array<{ id: string }>).map((c) => c.id);
    };
    const seenByLearner = await ids(learner.client);
    expect(seenByLearner).toContain(mine.body.id);
    expect(seenByLearner).not.toContain(theirs.body.id);
    // asking for another person by id gives nothing either
    expect(await ids(learner.client, `&person_id=${reviewer.personId}`)).toEqual([]);
    const seenByOwner = await ids(tenant.owner);
    expect(seenByOwner).toEqual(expect.arrayContaining([mine.body.id, theirs.body.id]));
  });
});

describe('consent withdrawal', () => {
  it('hides the material in the request\'s own transaction and erases it in the same request', async () => {
    const given = await expert.client.post('/v1/consents', { scope: 'documents', purpose: 'Synthetic test', policy_version: 't1' });
    expect(given.status).toBe(201);
    const source = randomUUID();
    await seed(tenant.tenantId, async (q) => {
      await q(`INSERT INTO sources (id, tenant_id, kind, title, sensitivity, owner_person_id, consent_id, uploaded_by_card_id, status)
               VALUES ($1, $2, 'document', 'Expert notes', 1, $3, $4, $5, 'awaiting_content')`, [source, tenant.tenantId, expert.personId, given.body.id, expert.card.id]);
    });
    stub.during = async (call) => {
      if (call.action !== 'consent.erase') return;
      // step 1 is already committed when step 2 is asked for
      const s = await su.query('SELECT status FROM sources WHERE id = $1', [source]);
      expect(s.rows[0].status).toBe('withdrawn');
    };
    const res = await expert.client.post(`/v1/consents/${given.body.id}/withdraw`);
    expect(res.status).toBe(200);
    expect(stub.ofAction('consent.erase')).toHaveLength(1);
    expect(stub.ofAction('consent.erase')[0]!.claims.subject).toBe(given.body.id);
    expect((await expert.client.post(`/v1/consents/${given.body.id}/withdraw`)).status).toBe(409);
  });

  it('someone else\'s consent cannot be withdrawn; an Owner records it for a person who has left', async () => {
    const given = await expert.client.post('/v1/consents', { scope: 'own_words', purpose: 'Synthetic test', policy_version: 't1' });
    expect((await reviewer.client.post(`/v1/consents/${given.body.id}/withdraw`)).status).toBe(403);
    const res = await tenant.owner.post(`/v1/people/${expert.personId}/consent-withdrawals`, { reference: 'REQ-2026-0001', scope: 'own_words' });
    expect(res.status).toBe(200);
    expect(res.body.withdrawals).toHaveLength(1);
  });

  it('a legal hold keeps the material hidden; releasing it completes the erasure', async () => {
    const given = await reviewer.client.post('/v1/consents', { scope: 'documents', purpose: 'Synthetic test', policy_version: 't1' });
    expect((await tenant.owner.post(`/v1/consents/${given.body.id}/hold`, { reason: 'Synthetic dispute' })).status).toBe(200);
    stub.answers.set('consent.erase', (c) => ({ id: c.claims.subject, withdrawal_status: 'held' }));
    const res = await reviewer.client.post(`/v1/consents/${given.body.id}/withdraw`);
    expect(res.body).toMatchObject({ legal_hold: true, withdrawal_status: 'held' });
    stub.answers.delete('consent.erase');
    const released = await tenant.owner.post(`/v1/consents/${given.body.id}/release-hold`);
    expect(released.status).toBe(200);
    expect(stub.ofAction('consent.erase')).toHaveLength(2);
  });
});

describe('review queue', () => {
  async function task(kind: string, subjectType: string, visibleTo: string | null = null): Promise<string> {
    const id = randomUUID();
    await seed(tenant.tenantId, (q) => q(`INSERT INTO review_tasks (id, tenant_id, kind, subject_type, subject_id, sensitivity, visible_to_person_id, priority, due_at)
                                          VALUES ($1, $2, $3, $4, $5, 1, $6, 10, now() + interval '5 days')`,
    [id, tenant.tenantId, kind, subjectType, randomUUID(), visibleTo]));
    return id;
  }

  it('lists, assigns, refuses to dismiss what must be acted on, and handles a mixed bulk request', async () => {
    const verify = await task('verify_item', 'knowledge_item');
    const redaction = await task('redaction_review', 'source');
    const question = await task('expert_question', 'expert_question', expert.personId);
    const seenByReviewer = (await reviewer.client.get('/v1/review/tasks?limit=50')).body.items.map((x: any) => x.id);
    expect(seenByReviewer).toContain(verify);
    expect(seenByReviewer).not.toContain(question);                    // addressed to someone else
    expect((await reviewer.client.get(`/v1/review/tasks/${question}`)).status).toBe(404);
    expect((await expert.client.get(`/v1/review/tasks/${question}`)).status).toBe(200);
    expect((await tenant.owner.get('/v1/review/tasks?limit=50')).body.items.map((x: any) => x.id)).toContain(question);

    const assigned = await reviewer.client.post(`/v1/review/tasks/${verify}/assign`, {});
    expect(assigned.body).toMatchObject({ status: 'assigned', assigned_to_card_id: reviewer.card.id });
    expect(assigned.body.first_response_at).not.toBeNull();
    expect((await reviewer.client.post(`/v1/review/tasks/${verify}/dismiss`)).status).toBe(409);

    const bulk = await reviewer.client.post('/v1/review/tasks/bulk', { action: 'dismiss', task_ids: [redaction, verify, question, randomUUID()] });
    expect(bulk.status).toBe(200);
    const outcome = Object.fromEntries(bulk.body.results.map((r: any) => [r.task_id, r.outcome]));
    expect(outcome[redaction]).toBe('done');
    expect(outcome[verify]).toBe('refused');
    expect(outcome[question]).toBe('not_found');
  });

  it('a learner cannot read the queue', async () => {
    expect((await learner.client.get('/v1/review/tasks')).status).toBe(403);
  });
});

describe('settings, AI budget and the operator controls', () => {
  it('settings: defaults, a valid change, a refused change, and who may change them', async () => {
    const before = await tenant.owner.get('/v1/knowledge/settings');
    expect(before.body).toMatchObject({ second_reviewer_required: true, learner_sources: 'verified_only', review_sla_days: 5 });
    expect((await tenant.owner.patch('/v1/knowledge/settings', { review_sla_days: 7 })).body.review_sla_days).toBe(7);
    expect((await tenant.owner.patch('/v1/knowledge/settings', { review_sla_days: 900 })).status).toBe(400);
    expect((await reviewer.client.patch('/v1/knowledge/settings', { review_sla_days: 1 })).status).toBe(403);
  });

  it('the AI budget, the per-company cap and the kill switch', async () => {
    const budget = await tenant.owner.get('/v1/ai/budget');
    expect(budget.status).toBe(200);
    expect(budget.body).toMatchObject({ monthly_cap_micro_usd: 5_000_000, spent_micro_usd: 0, ai_stopped: false });
    expect((await tenant.owner.put(`/v1/tenants/${tenant.tenantId}/ai-budget`, { monthly_cap_micro_usd: 1 })).status).toBe(403);
    const op = await platformOperator(t);
    expect((await op.put(`/v1/tenants/${tenant.tenantId}/ai-budget`, { monthly_cap_micro_usd: 2_000_000 })).status).toBe(200);
    expect((await tenant.owner.get('/v1/ai/budget')).body.monthly_cap_micro_usd).toBe(2_000_000);
    expect((await op.put('/v1/platform/ai/kill-switch', { on: true, reason: 'synthetic test' })).status).toBe(200);
    expect((await tenant.owner.get('/v1/ai/budget')).body.ai_stopped).toBe(true);
    await op.put('/v1/platform/ai/kill-switch', { on: false });
    const storage = await op.get('/v1/platform/storage');
    expect(storage.status).toBe(200);
    expect(storage.body.database_bytes).toBeGreaterThan(0);
    expect((await tenant.owner.get('/v1/platform/storage')).status).toBe(403);
    await op.put(`/v1/tenants/${tenant.tenantId}/ai-budget`, { monthly_cap_micro_usd: 5_000_000 });
    void ownerPerson;
  });
});

describe('item topics, job roles and tests taken (the screens no longer need the database for these)', () => {
  const role = `Synthetic operator ${randomUUID().slice(0, 8)}`;
  const path = (suffix: string): string => `/v1/job-roles/${encodeURIComponent(role)}/${suffix}`;
  let open: string;        // a topic everyone may read (sensitivity 0)
  let restricted: string;  // a topic only the Owner may read (sensitivity 3)

  beforeAll(async () => {
    const o = tenant.owner;
    const a = await o.post('/v1/topics', { name: `Open ${randomUUID().slice(0, 8)}`, description: 'synthetic', sensitivity: 0 });
    const b = await o.post('/v1/topics', { name: `Restricted ${randomUUID().slice(0, 8)}`, description: 'synthetic', sensitivity: 3 });
    expect([a.status, b.status]).toEqual([201, 201]);
    open = a.body.id;
    restricted = b.body.id;
    expect((await o.put(path('topics'), { topics: [{ topic_id: open, importance: 3 }, { topic_id: restricted, importance: 1 }] })).status).toBe(200);
    expect((await o.put(path('people'), { people: [{ person_id: learner.personId, relation: 'successor' }, { person_id: expert.personId, relation: 'holder' }] })).status).toBe(200);
  });

  it('setItemTopics: needs the label right on the item and topics the caller may read; refused before any AI call otherwise', async () => {
    const it1 = await item(tenant, { verifierCard: expert.card.id });
    const url = `/v1/knowledge/items/${it1}/topics`;
    expect((await learner.client.put(url, { topic_ids: [open] })).status).toBe(403);                 // no knowledge:label
    expect((await reviewer.client.put(url, { topic_ids: [randomUUID()] })).status).toBe(422);        // no such topic
    expect((await reviewer.client.put(url, { topic_ids: [restricted] })).status).toBe(422);          // exists, but this card may not read it: same answer
    const otherTopic = (await other.owner.post('/v1/topics', { name: `Theirs ${randomUUID().slice(0, 8)}` })).body.id as string;
    expect((await tenant.owner.put(url, { topic_ids: [otherTopic] })).status).toBe(422);             // another company's topic
    expect((await other.owner.put(url, { topic_ids: [otherTopic] })).status).toBe(404);              // another company's item
    expect(stub.ofAction('item.topics')).toHaveLength(0);

    const res = await reviewer.client.put(url, { topic_ids: [open, open] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: it1, topics: [{ topic_id: open, name: 'Synthetic topic', link_source: 'reviewer' }] });
    const call = stub.ofAction('item.topics');
    expect(call).toHaveLength(1);
    expect(call[0]!.body).toEqual({ topic_ids: [open] });
    expect(call[0]!.claims.subject).toBe(it1);
    // the token carries the card's topic:read filter as its own claim, and no knowledge filter
    expect(call[0]!.claims.topic_filter).toMatchObject({ v: 1, action: 'topic:read', nothing: false, tenant_id: tenant.tenantId });
    expect(call[0]!.claims.filter).toBeNull();
    expect((await tenant.owner.put(url, { topic_ids: [open, restricted] })).status).toBe(200);       // the Owner may read both
    expect((await tenant.owner.put(url, { topic_ids: [] })).status).toBe(200);                       // an empty list removes every link
  });

  it('setItemTopics: the contributor and the author of the current version may not change the topics of a verified item', async () => {
    const released = await item(tenant, { owner: expert, author: reviewer, verifierCard: tenant.ownerCard.id });
    const url = `/v1/knowledge/items/${released}/topics`;
    expect((await expert.client.put(url, { topic_ids: [open] })).status).toBe(403);                 // the contributor
    expect((await reviewer.client.put(url, { topic_ids: [open] })).status).toBe(403);               // the author of the current version
    expect((await expert.client.put(url, { topic_ids: [] })).status).toBe(403);                     // not even to remove links
    expect(stub.ofAction('item.topics')).toHaveLength(0);
    const denied = await su.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND resource_id = $2 AND decision = 'deny' AND reason_code = 'DENY_SELF_REVIEW'`,
      [tenant.tenantId, released]);
    expect(denied.rows[0].n).toBe(3);                                                                // each refusal is in the audit log
    expect((await tenant.owner.put(url, { topic_ids: [open] })).status).toBe(200);                  // a second person may

    // while the item is still in review, its contributor may sort it into topics
    const draft = await item(tenant, { owner: expert, author: expert });
    expect((await expert.client.put(`/v1/knowledge/items/${draft}/topics`, { topic_ids: [open] })).status).toBe(200);
  });

  it('reading an item sends the topic:read filter next to the knowledge filter, each for its own permission', async () => {
    const it2 = await item(tenant, { verifierCard: expert.card.id });
    expect((await reviewer.client.get(`/v1/knowledge/items/${it2}`)).status).toBe(200);
    const call = stub.ofAction('item.read');
    expect(call).toHaveLength(1);
    expect(call[0]!.claims.filter).toMatchObject({ action: 'knowledge:read', nothing: false });
    expect(call[0]!.claims.topic_filter).toMatchObject({ action: 'topic:read', nothing: false });
    // an operation that has nothing to do with topics carries no topic filter
    expect((await reviewer.client.get('/v1/knowledge/items')).status).toBe(200);
    expect(stub.ofAction('item.list')[0]!.claims.topic_filter).toBeNull();
  });

  it('a cursor that is not a record id is a 400, not a database error', async () => {
    const notAnId = Buffer.from('1234', 'utf8').toString('base64url');      // well-formed for a numbered list, but these lists are ordered by id
    for (const [who, url] of [
      [learner.client, '/v1/me/consents'], [learner.client, '/v1/expert-questions'], [tenant.owner, '/v1/consents'], [tenant.owner, '/v1/topics'],
      [tenant.owner, '/v1/readiness/attempts'], [tenant.owner, '/v1/knowledge/items'],
    ] as const) {
      expect((await who.get(`${url}?cursor=${notAnId}`)).status, url).toBe(400);
    }
  });

  it('job roles: a role is listed through the topics the caller may read', async () => {
    const mine = (r: { body: { items: Array<{ job_role: string; topic_count: number }> } }) => r.body.items.filter((x) => x.job_role === role);
    const asLearner = await learner.client.get('/v1/job-roles?limit=50');
    expect(asLearner.status).toBe(200);
    expect(mine(asLearner)).toEqual([{ job_role: role, topic_count: 1 }]);                            // the restricted topic is not counted
    expect(mine(await tenant.owner.get('/v1/job-roles?limit=50'))).toEqual([{ job_role: role, topic_count: 2 }]);
    expect((await other.owner.get('/v1/job-roles?limit=50')).body.items.map((x: any) => x.job_role)).not.toContain(role);

    const topicsAsLearner = await learner.client.get(path('topics'));
    expect(topicsAsLearner.body).toEqual({ job_role: role, topics: [{ topic_id: open, required: true, importance: 3 }] });
    expect((await tenant.owner.get(path('topics'))).body.topics.map((x: any) => x.topic_id)).toEqual([open, restricted]);
    expect((await other.owner.get(path('topics'))).body.topics).toEqual([]);                          // same name, another company: nothing

    // a role whose only topic the caller may not read does not exist for that caller
    const hidden = `Hidden ${randomUUID().slice(0, 8)}`;
    expect((await tenant.owner.put(`/v1/job-roles/${encodeURIComponent(hidden)}/topics`, { topics: [{ topic_id: restricted }] })).status).toBe(200);
    expect((await learner.client.get('/v1/job-roles?limit=50')).body.items.map((x: any) => x.job_role)).not.toContain(hidden);
  });

  it('job roles are read a page at a time, by name', async () => {
    const first = await tenant.owner.get('/v1/job-roles?limit=1');
    expect(first.body.items).toHaveLength(1);
    expect(typeof first.body.next_cursor).toBe('string');
    const second = await tenant.owner.get(`/v1/job-roles?limit=1&cursor=${first.body.next_cursor}`);
    expect(second.status).toBe(200);
    expect(second.body.items[0].job_role > first.body.items[0].job_role).toBe(true);
    expect((await tenant.owner.get(`/v1/job-roles?cursor=${'A'.repeat(180)}`)).status).toBe(400);
  });

  it('the people of a job role are part of the gap picture: Owner yes, Expert and Successor no', async () => {
    const res = await tenant.owner.get(path('people'));
    expect(res.status).toBe(200);
    expect(res.body.people).toEqual(expect.arrayContaining([
      { person_id: expert.personId, relation: 'holder' }, { person_id: learner.personId, relation: 'successor' },
    ]));
    expect(res.body.people).toHaveLength(2);
    expect((await learner.client.get(path('people'))).status).toBe(403);
    expect((await expert.client.get(path('people'))).status).toBe(403);
    expect((await other.owner.get(path('people'))).body.people).toEqual([]);
  });

  it('tests taken: a learner sees only its own, the Owner the company\'s, an Expert none; no questions or scores', async () => {
    const second = await addMember(t, tenant.owner, [{ role_key: 'successor' }]);
    const ids = { mine: randomUUID(), theirs: randomUUID() };
    await seed(tenant.tenantId, async (q) => {
      for (const [id, who] of [[ids.mine, learner], [ids.theirs, second]] as const) {
        await q(`INSERT INTO quiz_attempts (id, tenant_id, learner_card_id, learner_person_id, owner_person_id, job_role, expires_at)
                 VALUES ($1, $2, $3, $4, $4, $5, now() + interval '1 hour')`, [id, tenant.tenantId, who.card.id, who.personId, role]);
      }
    });
    const asLearner = await learner.client.get('/v1/readiness/attempts');
    expect(asLearner.status).toBe(200);
    expect(asLearner.body.items.map((a: any) => a.id)).toEqual([ids.mine]);
    expect(Object.keys(asLearner.body.items[0]).sort()).toEqual(
      ['expires_at', 'graded_at', 'id', 'job_role', 'learner_person_id', 'started_at', 'status', 'submitted_at']);
    // asking for someone else by id does not widen what a learner sees
    expect((await learner.client.get(`/v1/readiness/attempts?learner_person_id=${second.personId}`)).body.items).toEqual([]);
    const asOwner = await tenant.owner.get('/v1/readiness/attempts?limit=50');
    expect(asOwner.body.items.map((a: any) => a.id)).toEqual(expect.arrayContaining([ids.mine, ids.theirs]));
    expect((await tenant.owner.get(`/v1/readiness/attempts?learner_person_id=${second.personId}`)).body.items.map((a: any) => a.id)).toEqual([ids.theirs]);
    expect((await expert.client.get('/v1/readiness/attempts')).status).toBe(403);
    expect((await other.owner.get('/v1/readiness/attempts')).body.items).toEqual([]);
  });

  it('setting a job role\'s topics replaces only what the caller can see; what was read can be written back; a bad id is 422', async () => {
    const o = tenant.owner;
    const admin = await addMember(t, o, [{ role_key: 'admin' }]);                                    // may read topics up to level 1
    const own = `Kept ${randomUUID().slice(0, 8)}`;
    const url = `/v1/job-roles/${encodeURIComponent(own)}/topics`;
    const old = await o.post('/v1/topics', { name: `Old ${randomUUID().slice(0, 8)}`, description: 'synthetic', sensitivity: 0 });
    expect(old.status).toBe(201);
    expect((await o.put(url, { topics: [{ topic_id: open, importance: 3 }, { topic_id: restricted, importance: 1 }, { topic_id: old.body.id }] })).status).toBe(200);
    expect((await o.patch(`/v1/topics/${old.body.id}`, { status: 'retired' })).status).toBe(200);

    // the list and the topics of the role use one rule: the retired topic is in neither
    const count = async (who: typeof o): Promise<number | undefined> =>
      (await who.get('/v1/job-roles?limit=50')).body.items.find((x: { job_role: string }) => x.job_role === own)?.topic_count;
    expect(await count(o)).toBe(2);
    expect((await o.get(url)).body.topics.map((x: { topic_id: string }) => x.topic_id)).toEqual([open, restricted]);
    expect(await count(admin.client)).toBe(1);

    // the admin sees one topic, sends back exactly what it read (job role included), and nothing it cannot see is lost
    const read = await admin.client.get(url);
    expect(read.body).toEqual({ job_role: own, topics: [{ topic_id: open, required: true, importance: 3 }] });
    expect((await admin.client.put(url, read.body)).status).toBe(200);
    expect((await admin.client.put(url, { topics: [] })).status).toBe(200);                           // "none" - among what the admin can see
    expect((await o.get(url)).body.topics.map((x: { topic_id: string }) => x.topic_id)).toEqual([restricted]);
    const kept = await su.query('SELECT topic_id FROM role_topic_maps WHERE tenant_id = $1 AND job_role = $2 ORDER BY topic_id', [tenant.tenantId, own]);
    expect(kept.rows.map((r) => r.topic_id).sort()).toEqual([restricted, old.body.id].sort());        // the hidden and the retired link are still there

    // a bad id in the body is 422, whoever asks and whatever is wrong with it - and nothing is changed by the refused request
    expect((await admin.client.put(url, { topics: [{ topic_id: restricted }] })).status).toBe(422);  // exists, but the admin may not read it
    expect((await o.put(url, { topics: [{ topic_id: randomUUID() }] })).status).toBe(422);           // no such topic
    expect((await o.put(url, { topics: [{ topic_id: old.body.id }] })).status).toBe(422);            // retired
    expect((await o.put(url, { job_role: 'Another role', topics: [] })).status).toBe(422);           // not the role in the address
    expect((await o.put(`/v1/job-roles/${encodeURIComponent(own)}/people`, { people: [{ person_id: randomUUID(), relation: 'holder' }] })).status).toBe(422);
    expect((await o.get(url)).body.topics.map((x: { topic_id: string }) => x.topic_id)).toEqual([restricted]);

    // people: what was read can be written back
    const people = `/v1/job-roles/${encodeURIComponent(own)}/people`;
    expect((await o.put(people, { people: [{ person_id: learner.personId, relation: 'successor' }] })).status).toBe(200);
    const readPeople = await o.get(people);
    expect((await o.put(people, readPeople.body)).status).toBe(200);
    expect((await o.get(people)).body).toEqual(readPeople.body);
  });

  it('a job role\'s name follows one rule in the address and in a body; a name cursor carries any allowed name', async () => {
    const o = tenant.owner;
    for (const bad of [' padded', 'padded ', 'tab\tinside', ' ']) {
      expect((await o.get(`/v1/job-roles/${encodeURIComponent(bad)}/topics`)).status, JSON.stringify(bad)).toBe(400);
      expect((await o.get(`/v1/gaps?job_role=${encodeURIComponent(bad)}`)).status, JSON.stringify(bad)).toBe(400);
      expect((await learner.client.post('/v1/readiness/attempts', { job_role: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    // the longest name there can be, in characters that take four bytes each: the cursor made from it is accepted
    const long = '\u{1F527}'.repeat(120);                                                             // 120 characters, 480 bytes
    expect((await o.put(`/v1/job-roles/${encodeURIComponent(long)}/topics`, { topics: [{ topic_id: open }] })).status).toBe(200);
    const cursor = Buffer.from(long, 'utf8').toString('base64url');
    expect((await o.get(`/v1/job-roles?limit=1&cursor=${cursor}`)).status).toBe(200);
    expect((await o.put(`/v1/job-roles/${encodeURIComponent(long)}/topics`, { topics: [] })).status).toBe(200);
  });
});

describe('answer quality: readers\' feedback and the weekly counts (features 22 and 23)', () => {
  it('an answer names its record, who found a conflict and what disagrees; nothing else from the AI service gets through', async () => {
    const answerId = randomUUID();
    const a = { kind: 'item', id: randomUUID(), title: 'Handbook', value: '3.0 bar' };
    const b = { kind: 'source', id: randomUUID(), title: 'Fault table', value: '3.2 bar' };
    stub.answers.set('knowledge.answer', () => ({
      outcome: 'dont_know', answer: null, reason: 'sources_conflict', confidence: null, contains_unverified_sources: false, citations: [],
      can_ask_expert: true, answer_id: answerId, conflict_found_by: 'value_check', conflict_check_partial: true,
      conflicts: [{ measure: 'pressure', a: { ...a, chunk_text: 'must not pass' }, b, internal_note: 'must not pass' }],
    }));
    const res = await learner.client.post('/v1/knowledge/ask', { question: 'At what pressure does the alarm come?' });
    expect(res.status).toBe(200);
    expect(res.body.answer_id).toBe(answerId);
    expect(res.body.conflict_found_by).toBe('value_check');
    expect(res.body.conflict_check_partial).toBe(true);
    expect(res.body.conflicts).toEqual([{ measure: 'pressure', a, b }]);
    stub.answers.delete('knowledge.answer');
  });

  it('feedback is replaced, read and withdrawn bound to that one answer, with the card that gives it', async () => {
    const answerId = randomUUID();
    const url = `/v1/knowledge/answers/${answerId}/feedback`;
    expect((await learner.client.put(url, { verdict: 'excellent' })).status).toBe(400);
    expect((await learner.client.put(url, { verdict: 'wrong', share_question: 'yes' })).status).toBe(400);
    expect((await learner.client.request('PUT', url, { verdict: 'wrong' }, { idem: false })).status).toBe(400);
    expect((await learner.client.post(url, { verdict: 'wrong' })).status).toBe(404);                 // there is no POST: an opinion is put
    const res = await learner.client.put(url, { verdict: 'wrong', comment: 'Synthetic comment.' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ answer_id: answerId, verdict: 'wrong', comment: 'Synthetic comment.', question_shared: false, question: null });
    const calls = stub.ofAction('answer.feedback');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.claims.subject).toBe(answerId);
    expect(calls[0]!.claims.card_id).toBe(learner.card.id);
    expect(calls[0]!.body).toEqual({ verdict: 'wrong', comment: 'Synthetic comment.', share_question: false });   // not shared unless the reader says so
    await learner.client.put(url, { verdict: 'wrong', share_question: true });
    expect(stub.ofAction('answer.feedback')[1]!.body).toEqual({ verdict: 'wrong', comment: null, share_question: true });

    expect((await learner.client.get(url)).status).toBe(200);
    expect(stub.ofAction('answer.feedback_read')[0]!.claims.subject).toBe(answerId);
    expect((await learner.client.request('DELETE', url, undefined, { idem: false })).status).toBe(400);            // a change needs a key
    const gone = await learner.client.request('DELETE', url, undefined, { idem: `k-${randomUUID()}` });
    expect(gone.status).toBe(204);
    expect(gone.raw).toBe('');
    expect(stub.ofAction('answer.feedback_withdraw')[0]!.claims.subject).toBe(answerId);

    // the AI service says "not found" for an answer that was given to another card: the caller gets the same, for every verb
    const actions = ['answer.feedback', 'answer.feedback_read', 'answer.feedback_withdraw'];
    for (const action of actions) stub.answers.set(action, () => new StubError(404, 'not_found'));
    expect((await expert.client.put(url, { verdict: 'helpful' })).status).toBe(404);
    expect((await expert.client.get(url)).status).toBe(404);
    expect((await expert.client.request('DELETE', url, undefined, { idem: `k-${randomUUID()}` })).status).toBe(404);
    for (const action of actions) stub.answers.delete(action);
  });

  it('the company\'s quality numbers and the readers\' feedback are for the Owner; an Expert and a Successor are refused before any call', async () => {
    for (const who of [expert, learner]) {
      expect((await who.client.get('/v1/quality/summary')).status).toBe(403);
      expect((await who.client.get('/v1/quality/feedback')).status).toBe(403);
    }
    expect(stub.ofAction('quality.summary')).toHaveLength(0);
    expect(stub.ofAction('quality.feedback')).toHaveLength(0);
    expect((await tenant.owner.get('/v1/quality/summary?weeks=27')).status).toBe(400);
    const summary = await tenant.owner.get('/v1/quality/summary?weeks=4');
    expect(summary.status).toBe(200);
    expect(summary.body).toEqual({ weeks: [], kept_for_days: 90, waiting_for_review: { item_conflicts: 0, stale_items: 0, answers_marked_wrong: 0 } });
    expect(stub.ofAction('quality.summary')[0]!.body).toEqual({ weeks: 4 });
    expect((await tenant.owner.get('/v1/quality/feedback?verdict=wrong&limit=5')).body).toEqual({ items: [], next_cursor: null });
    expect((await tenant.owner.get('/v1/quality/feedback?cursor=not-an-id')).status).toBe(400);
  });
});
