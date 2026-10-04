// Scenario replay (feature 8): what the API decides, against the real database and a stand-in AI service.
// The texts and the grading are the AI service's (tested there, and end to end by test/contract/phase2-walk.test.ts).
// Here: who may do what, and which ids the API vouches for in the service token ("approved") - the items a writer may
// link, the scenarios a learner is offered, the items a reader of a result may be pointed to.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiStub, StubError } from '../helpers/ai-stub.ts';
import { addMember, createTenant, startApp, superuser, type TestApp, type TestMember, type TestTenant } from '../helpers/harness.ts';

let stub: AiStub;
let t: TestApp;
let tenant: TestTenant;
let other: TestTenant;
let writer: TestMember;      // an Expert: during the pilot, Experts write and approve
let approver: TestMember;
let third: TestMember;         // a third Expert: the Company Owner holds no right to manage the question bank or scenarios
let learner: TestMember;
let learner2: TestMember;
let su: pg.Client;

async function seed(tenantId: string, fn: (q: (sql: string, params?: unknown[]) => Promise<any[]>) => Promise<unknown>): Promise<void> {
  await su.query('BEGIN');
  try {
    await su.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await fn(async (sql, params) => (await su.query(sql, params)).rows);
    await su.query('COMMIT');
  } catch (err) {
    await su.query('ROLLBACK');
    throw err;
  }
}

/** A company item (nobody's own words), verified unless told otherwise, at the given level. Each has its own text. */
async function item(tn: TestTenant, opts: { sensitivity: number; verified?: boolean }): Promise<string> {
  const id = randomUUID();
  await seed(tn.tenantId, async (q) => {
    await q(`INSERT INTO knowledge_items (id, tenant_id, title, origin, department_id, sensitivity, owner_person_id, consent_id)
             VALUES ($1, $2, $3, 'manual', NULL, $4, NULL, NULL)`, [id, tn.tenantId, `Synthetic item ${id.slice(0, 8)}`, opts.sensitivity]);
    const v = await q(`INSERT INTO knowledge_versions (tenant_id, item_id, version_no, body, change_kind, author_card_id, author_person_id)
                       VALUES ($1, $2, 1, $3, 'written', NULL, NULL) RETURNING id`, [tn.tenantId, id, `Synthetic body ${id}.`]);
    await q("UPDATE knowledge_items SET current_version_id = $1, status = 'in_review' WHERE id = $2", [v[0].id, id]);
    if (opts.verified !== false) {
      await q("UPDATE knowledge_items SET status = 'verified', verified_by_card_id = $1, verified_at = now() WHERE id = $2", [tn.ownerCard.id, id]);
    }
  });
  return id;
}

/** A scenario with one step tied to these items; a draft unless `approved`. Rows go through the database's own guards. */
async function scenario(tn: TestTenant, itemIds: string[],
  opts: { approved?: boolean; authorCard?: string; creatorCard?: string; approverCard?: string } = {}): Promise<string> {
  const id = randomUUID();
  const step = randomUUID();
  await seed(tn.tenantId, async (q) => {
    const author = opts.authorCard ?? tn.ownerCard.id;
    await q(`INSERT INTO scenarios (id, tenant_id, title, situation, job_role, owner_person_id, author_card_id, created_by_card_id)
             VALUES ($1, $2, $3, 'Synthetic situation.', 'Synthetic operator', NULL, $4, $5)`,
      [id, tn.tenantId, `Synthetic scenario ${id.slice(0, 8)}`, author, opts.creatorCard ?? author]);
    await q(`INSERT INTO scenario_steps (id, tenant_id, scenario_id, position, prompt, rubric) VALUES ($1, $2, $3, 1, 'Synthetic prompt?', '["Synthetic expected point"]'::jsonb)`,
      [step, tn.tenantId, id]);
    for (const i of itemIds) await q('INSERT INTO scenario_step_items (tenant_id, step_id, item_id) VALUES ($1, $2, $3)', [tn.tenantId, step, i]);
    if (opts.approved === true) {
      await q("UPDATE scenarios SET status = 'approved', approved_by_card_id = $1, approved_at = now() WHERE id = $2", [opts.approverCard ?? approver.card.id, id]);
    }
  });
  return id;
}

async function run(tn: TestTenant, scenarioId: string, who: TestMember): Promise<string> {
  const id = randomUUID();
  await seed(tn.tenantId, async (q) => {
    await q(`INSERT INTO scenario_attempts (id, tenant_id, scenario_id, learner_card_id, learner_person_id, owner_person_id, expires_at)
             VALUES ($1, $2, $3, $4, $5, $5, now() + interval '1 hour')`, [id, tn.tenantId, scenarioId, who.card.id, who.personId]);
  });
  return id;
}

const body = (itemIds: string[]): Record<string, unknown> => ({
  title: 'Synthetic scenario', situation: 'Synthetic situation.', job_role: 'Synthetic operator',
  steps: [{ prompt: 'What do you do?', item_ids: itemIds, rubric: ['Synthetic expected point'] }],
});

beforeAll(async () => {
  stub = await new AiStub().start();
  t = await startApp({}, { AI_SERVICE_URL: stub.url });
  su = await superuser();
  tenant = await createTenant(t, 'scn');
  other = await createTenant(t, 'scn-other');
  writer = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
  approver = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
  third = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
  learner = await addMember(t, tenant.owner, [{ role_key: 'successor' }]);
  learner2 = await addMember(t, tenant.owner, [{ role_key: 'successor' }]);
});

afterAll(async () => {
  await su?.end();
  await t?.close();
  await stub?.stop();
});

beforeEach(() => stub.reset());

describe('writing a scenario', () => {
  it('a learner may not write, read, approve or retire scenarios, nor ask for proposed points or override a grade', async () => {
    const released = await item(tenant, { sensitivity: 0 });
    const id = await scenario(tenant, [released]);
    const l = learner.client;
    expect((await l.post('/v1/scenarios', body([released]))).status).toBe(403);
    expect((await l.get('/v1/scenarios')).status).toBe(403);
    expect((await l.get(`/v1/scenarios/${id}`)).status).toBe(403);
    expect((await l.put(`/v1/scenarios/${id}`, body([released]))).status).toBe(403);
    expect((await l.post(`/v1/scenarios/${id}/approve`)).status).toBe(403);
    expect((await l.post(`/v1/scenarios/${id}/retire`)).status).toBe(403);
    expect((await l.post('/v1/scenario-rubric-proposals', { item_ids: [released] })).status).toBe(403);
    expect(stub.calls).toEqual([]);                                   // nothing reached the AI service
  });

  it('every linked item must be verified, released to learners and readable by the writer; the token names exactly the checked items', async () => {
    const released = await item(tenant, { sensitivity: 0 });
    const internal = await item(tenant, { sensitivity: 1 });          // verified, but not released to learners
    const unverified = await item(tenant, { sensitivity: 0, verified: false });
    const foreign = await item(other, { sensitivity: 0 });            // another company's item
    for (const bad of [internal, unverified, foreign, randomUUID()]) {
      expect((await writer.client.post('/v1/scenarios', body([released, bad]))).status, bad).toBe(422);
    }
    expect(stub.ofAction('scenario.write')).toEqual([]);
    expect((await writer.client.post('/v1/scenarios', body([released]))).status).toBe(201);
    const sent = stub.ofAction('scenario.write');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.claims.approved).toEqual([released]);
    expect(sent[0]!.body.steps[0].item_ids).toEqual([released]);
    // proposed points: only for items that pass the same check; the call may use AI, so it carries the limits
    expect((await writer.client.post('/v1/scenario-rubric-proposals', { item_ids: [internal] })).status).toBe(422);
    expect((await writer.client.post('/v1/scenario-rubric-proposals', { item_ids: [released, internal] })).status).toBe(200);
    const proposal = stub.ofAction('scenario.rubric');
    expect(proposal).toHaveLength(1);
    expect(proposal[0]!.claims.approved).toEqual([released]);
    expect(proposal[0]!.claims.limits).toBeDefined();
  });

  it('a scenario of another company is "not found", whatever is asked of it', async () => {
    const id = await scenario(other, [await item(other, { sensitivity: 0 })], { authorCard: other.ownerCard.id });
    const released = await item(tenant, { sensitivity: 0 });
    expect((await writer.client.get(`/v1/scenarios/${id}`)).status).toBe(404);
    expect((await writer.client.put(`/v1/scenarios/${id}`, body([released]))).status).toBe(404);
    expect((await approver.client.post(`/v1/scenarios/${id}/approve`)).status).toBe(404);
    expect((await learner.client.post(`/v1/scenarios/${id}/attempts`)).status).toBe(404);
    expect(stub.calls).toEqual([]);
  });

  it('the database itself refuses an approval by the card that wrote the scenario, and a change to the steps of an approved one', async () => {
    const released = await item(tenant, { sensitivity: 0 });
    const own = await scenario(tenant, [released], { authorCard: writer.card.id });
    await expect(seed(tenant.tenantId, (q) => q("UPDATE scenarios SET status = 'approved', approved_by_card_id = $1, approved_at = now() WHERE id = $2", [writer.card.id, own])))
      .rejects.toThrow(/creator or last editor cannot approve/);
    const approved = await scenario(tenant, [released], { approved: true, authorCard: writer.card.id });
    await expect(seed(tenant.tenantId, (q) => q("UPDATE scenario_steps SET prompt = 'Changed?' WHERE scenario_id = $1", [approved]))).rejects.toThrow(/approved scenario cannot change/);
    await expect(seed(tenant.tenantId, (q) => q('DELETE FROM scenario_step_items WHERE item_id = $1', [released]))).rejects.toThrow(/approved scenario cannot change/);
    await expect(seed(tenant.tenantId, (q) => q("UPDATE scenarios SET title = 'Changed' WHERE id = $1", [approved]))).rejects.toThrow(/cannot be edited/);
  });
});

describe('what a learner is offered and may start', () => {
  it('only approved scenarios built entirely from knowledge that learner may read; the rest look as if they did not exist', async () => {
    const released = await item(tenant, { sensitivity: 0 });
    const released2 = await item(tenant, { sensitivity: 0 });
    const internal = await item(tenant, { sensitivity: 1 });
    const offered = await scenario(tenant, [released, released2], { approved: true, authorCard: writer.card.id });
    const draft = await scenario(tenant, [released], { authorCard: writer.card.id });
    const mixed = await scenario(tenant, [released, internal], { approved: true, authorCard: writer.card.id });   // one item above the learner's level
    const res = await learner.client.get('/v1/scenario-offers');
    expect(res.status).toBe(200);
    const sent = stub.ofAction('scenario.offered');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.claims.approved).toContain(offered);
    expect(sent[0]!.claims.approved).not.toContain(draft);
    expect(sent[0]!.claims.approved).not.toContain(mixed);
    stub.reset();
    for (const id of [draft, mixed, randomUUID()]) expect((await learner.client.post(`/v1/scenarios/${id}/attempts`)).status, id).toBe(404);
    expect(stub.calls).toEqual([]);
    expect((await learner.client.post(`/v1/scenarios/${offered}/attempts`)).status).toBe(201);
    const started = stub.ofAction('scenario.start');
    expect(started).toHaveLength(1);
    expect(started[0]!.claims).toMatchObject({ subject: offered, approved: [offered], person_id: learner.personId });
  });

  it('a linked item that stops being verified takes the scenario out of use at once: back to draft, flagged, running attempts ended', async () => {
    const released = await item(tenant, { sensitivity: 0 });
    const id = await scenario(tenant, [released], { approved: true, authorCard: writer.card.id });
    const attempt = await run(tenant, id, learner);
    await seed(tenant.tenantId, (q) => q("UPDATE knowledge_items SET status = 'stale' WHERE id = $1", [released]));
    const row = (await su.query('SELECT status, flag_reason, approved_by_card_id FROM scenarios WHERE id = $1', [id])).rows[0];
    expect(row).toEqual({ status: 'draft', flag_reason: 'item_changed', approved_by_card_id: null });
    expect((await su.query('SELECT status FROM scenario_attempts WHERE id = $1', [attempt])).rows[0].status).toBe('expired');
    expect((await learner.client.post(`/v1/scenarios/${id}/attempts`)).status).toBe(404);
    await learner.client.get('/v1/scenario-offers');
    expect(stub.ofAction('scenario.offered')[0]!.claims.approved).not.toContain(id);
  });

  it('a withdrawn item retires and HIDES the scenario at once; its words stay until the erasure step (a legal hold suspends erasure)', async () => {
    const released = await item(tenant, { sensitivity: 0 });
    const kept = await item(tenant, { sensitivity: 0 });
    const id = await scenario(tenant, [released, kept], { approved: true, authorCard: writer.card.id });
    const attempt = await run(tenant, id, learner);
    await seed(tenant.tenantId, (q) => q("UPDATE knowledge_items SET status = 'withdrawn' WHERE id = $1", [released]));
    const sc = (await su.query('SELECT status, flag_reason, situation, erased_at IS NOT NULL AS erased FROM scenarios WHERE id = $1', [id])).rows[0];
    expect(sc).toEqual({ status: 'retired', flag_reason: 'item_withdrawn', situation: 'Synthetic situation.', erased: false });   // nothing blanked by the trigger
    const steps = (await su.query('SELECT prompt, erased_at IS NOT NULL AS erased FROM scenario_steps WHERE scenario_id = $1', [id])).rows;
    expect(steps).toEqual([{ prompt: 'Synthetic prompt?', erased: false }]);
    expect((await su.query('SELECT status FROM scenario_attempts WHERE id = $1', [attempt])).rows[0].status).toBe('expired');
    // hidden from everybody through the API: the scenario and its runs answer like something that does not exist
    stub.reset();
    expect((await writer.client.get(`/v1/scenarios/${id}`)).status).toBe(404);
    expect((await approver.client.post(`/v1/scenarios/${id}/approve`)).status).toBe(404);
    expect((await learner.client.get(`/v1/scenario-attempts/${attempt}`)).status).toBe(404);
    expect((await tenant.owner.get(`/v1/scenario-attempts/${attempt}`)).status).toBe(404);
    expect(stub.calls).toEqual([]);
  });

  it('a re-labelled item takes the scenario with it: its level follows, it needs a new approval, and a learner can no longer open an old run', async () => {
    const released = await item(tenant, { sensitivity: 0 });
    const id = await scenario(tenant, [released], { approved: true, authorCard: writer.card.id });
    const attempt = await run(tenant, id, learner);
    expect((await learner.client.get(`/v1/scenario-attempts/${attempt}`)).status).toBe(200);
    // labels change only through relabel() (the database refuses a plain UPDATE); it is what the product itself calls
    await seed(tenant.tenantId, (q) => q("SELECT relabel('item', $1::uuid, NULL::uuid, 2::smallint)", [released]));
    const row = (await su.query('SELECT status, flag_reason, sensitivity FROM scenarios WHERE id = $1', [id])).rows[0];
    expect(row).toEqual({ status: 'draft', flag_reason: 'item_changed', sensitivity: 2 });
    expect((await su.query('SELECT status FROM scenario_attempts WHERE id = $1', [attempt])).rows[0].status).toBe('expired');
    stub.reset();
    // the run quotes the scenario: a reader who may not read every linked item any more does not get it
    expect((await learner.client.get(`/v1/scenario-attempts/${attempt}`)).status).toBe(403);
    expect((await tenant.owner.get(`/v1/scenario-attempts/${attempt}`)).status).toBe(200);         // the Owner may read level-2 knowledge
    stub.reset();
    expect((await learner.client.post(`/v1/scenarios/${id}/attempts`)).status).toBe(404);
    expect(stub.calls).toEqual([]);
  });
});

describe('the second-person rule (decided by the policy, recorded as DENY_SELF_REVIEW)', () => {
  const denials = async (resourceId: string): Promise<number> => (await su.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND resource_id = $2 AND decision = 'deny' AND reason_code = 'DENY_SELF_REVIEW'`,
    [tenant.tenantId, resourceId])).rows[0].n;

  it('neither the creator of a scenario nor its last editor may approve it; a third person may', async () => {
    const released = await item(tenant, { sensitivity: 0 });
    // created by one reviewer, last edited by the other: both are refused, a third reviewer is not.
    // (Not the Owner: that role holds no quiz:manage, so its refusal would say nothing about this rule.)
    const id = await scenario(tenant, [released], { creatorCard: approver.card.id, authorCard: writer.card.id });
    expect((await writer.client.post(`/v1/scenarios/${id}/approve`)).status).toBe(403);
    expect((await approver.client.post(`/v1/scenarios/${id}/approve`)).status).toBe(403);
    expect(await denials(id)).toBe(2);
    expect(stub.ofAction('scenario.status')).toEqual([]);                // refused before the AI service was asked
    expect((await tenant.owner.post(`/v1/scenarios/${id}/approve`)).status).toBe(403);       // no right to manage scenarios at all
    expect(await denials(id)).toBe(2);                                                      // ... and that refusal is not a second-person one
    expect((await third.client.post(`/v1/scenarios/${id}/approve`, { updated_at: '2026-01-01T00:00:00.000Z' })).status).toBe(200);
    const sent = stub.ofAction('scenario.status');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ status: 'approved', updated_at: '2026-01-01T00:00:00.000Z' });   // the version the approver read travels with the request
  });

  it('with the rule switched off by the Owner, the writer may approve', async () => {
    const released = await item(tenant, { sensitivity: 0 });
    const id = await scenario(tenant, [released], { authorCard: writer.card.id });
    expect((await writer.client.post(`/v1/scenarios/${id}/approve`)).status).toBe(403);
    expect((await tenant.owner.patch('/v1/knowledge/settings', { second_reviewer_required: false })).status).toBe(200);
    try {
      expect((await writer.client.post(`/v1/scenarios/${id}/approve`)).status).toBe(200);
    } finally {
      expect((await tenant.owner.patch('/v1/knowledge/settings', { second_reviewer_required: true })).status).toBe(200);
    }
  });

  it('a readiness test question: whoever generated it or last edited it may not approve it (a Phase 2 gap, closed)', async () => {
    const source = await item(tenant, { sensitivity: 0 });
    const question = randomUUID();
    const legacy = randomUUID();
    await seed(tenant.tenantId, async (q) => {
      const v = await q('SELECT current_version_id FROM knowledge_items WHERE id = $1', [source]);
      for (const [id, by, edited] of [[question, writer.card.id, approver.card.id], [legacy, null, null]] as const) {
        await q(`INSERT INTO quiz_items (id, tenant_id, knowledge_item_id, knowledge_version_id, kind, stem, rubric, sensitivity, written_by_card_id, edited_by_card_id)
                 VALUES ($1, $2, $3, $4, 'open', $5, '["Synthetic expected point"]'::jsonb, 0, $6, $7)`,
          [id, tenant.tenantId, source, v[0].current_version_id, `Synthetic question ${id.slice(0, 8)}?`, by, edited]);
      }
    });
    expect((await writer.client.post(`/v1/readiness/questions/${question}/approve`)).status).toBe(403);     // generated it
    expect((await approver.client.post(`/v1/readiness/questions/${question}/approve`)).status).toBe(403);   // last edited it
    expect(await denials(question)).toBe(2);
    expect(stub.ofAction('quiz.status')).toEqual([]);
    expect((await third.client.post(`/v1/readiness/questions/${question}/approve`)).status).toBe(200);    // a third reviewer
    // a question written before the rule existed names nobody: anyone who may approve can
    expect((await writer.client.post(`/v1/readiness/questions/${legacy}/approve`)).status).toBe(200);
    // retiring is not approving: the writer may retire the question
    expect((await writer.client.post(`/v1/readiness/questions/${question}/retire`)).status).toBe(200);
  });
});

describe('reading and grading a run', () => {
  it('a run is its learner\'s: another learner and an expert are refused; the token names only the linked items the reader may read', async () => {
    const released = await item(tenant, { sensitivity: 0 });
    const id = await scenario(tenant, [released], { approved: true, authorCard: writer.card.id });
    const attempt = await run(tenant, id, learner);
    expect((await learner2.client.get(`/v1/scenario-attempts/${attempt}`)).status).toBe(403);
    expect((await writer.client.get(`/v1/scenario-attempts/${attempt}`)).status).toBe(403);       // an expert has no right to results
    expect((await learner2.client.post(`/v1/scenario-attempts/${attempt}/answers`, { position: 1, answer_text: 'x' })).status).toBe(200);   // the policy lets any learner take runs; whose run it is, the AI service checks (stand-in here)
    expect((await writer.client.post(`/v1/scenario-attempts/${attempt}/submit`)).status).toBe(403);
    expect(stub.ofAction('scenario.attempt_read')).toEqual([]);
    expect((await learner.client.get(`/v1/scenario-attempts/${attempt}`)).status).toBe(200);
    expect((await tenant.owner.get(`/v1/scenario-attempts/${attempt}`)).status).toBe(200);
    const reads = stub.ofAction('scenario.attempt_read');
    expect(reads).toHaveLength(2);
    for (const r of reads) expect(r.claims).toMatchObject({ subject: attempt, approved: [released] });
    expect(reads[0]!.claims.filter.action).toBe('quiz:read_results');
    expect((await learner.client.get(`/v1/scenario-attempts/${randomUUID()}`)).status).toBe(404);
    expect((await learner.client.get('/v1/scenario-attempts')).status).toBe(200);
    expect(stub.ofAction('scenario.attempts')[0]!.claims.filter.action).toBe('quiz:read_results');
    expect((await writer.client.get('/v1/scenario-attempts')).status).toBe(403);
  });

  it('the running view passes on nothing but the prompt and the learner\'s own text, even if the AI service sent more', async () => {
    const released = await item(tenant, { sensitivity: 0 });
    const id = await scenario(tenant, [released], { approved: true, authorCard: writer.card.id });
    const attempt = await run(tenant, id, learner);
    stub.answers.set('scenario.attempt_read', (c) => ({
      id: c.claims.subject, scenario_id: id, title: 'Synthetic scenario', situation: 'Synthetic situation', job_role: 'Operator',
      learner_person_id: learner.personId, status: 'in_progress', started_at: new Date().toISOString(), expires_at: new Date().toISOString(),
      submitted_at: null, graded_at: null,
      steps: [{ answer_id: randomUUID(), position: 1, prompt: 'Synthetic prompt?', answer_text: null, rubric: ['LEAKED POINT'], final_score: 1,
        points: [{ text: 'LEAKED POINT', met: true }], read_these: [{ id: released, title: 'LEAKED TITLE' }] }],
    }));
    const res = await learner.client.get(`/v1/scenario-attempts/${attempt}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.steps[0]).sort()).toEqual(['answer_id', 'answer_text', 'position', 'prompt']);
    expect(res.raw).not.toContain('LEAKED');
  });

  it('an override needs the right to grade; a learner has none', async () => {
    const released = await item(tenant, { sensitivity: 0 });
    const id = await scenario(tenant, [released], { approved: true, authorCard: writer.card.id });
    const attempt = await run(tenant, id, learner);
    const answer = randomUUID();
    await seed(tenant.tenantId, async (q) => {
      const step = await q('SELECT id FROM scenario_steps WHERE scenario_id = $1', [id]);
      await q('INSERT INTO scenario_answers (id, tenant_id, attempt_id, step_id, position) VALUES ($1, $2, $3, $4, 1)', [answer, tenant.tenantId, attempt, step[0].id]);
    });
    expect((await learner.client.post(`/v1/scenario-answers/${answer}/override`, { score: 1 })).status).toBe(403);
    expect((await approver.client.post(`/v1/scenario-answers/${randomUUID()}/override`, { score: 1 })).status).toBe(404);
    expect((await approver.client.post(`/v1/scenario-answers/${answer}/override`, { score: 2 })).status).toBe(400);
    expect((await approver.client.post(`/v1/scenario-answers/${answer}/override`, { score: 0.5 })).status).toBe(200);
    expect(stub.ofAction('scenario.override')).toHaveLength(1);
    // the override carries the grader's right to read results, so that the AI service applies the "no blind grading" rule
    expect(stub.ofAction('scenario.override')[0]!.claims.filter.action).toBe('quiz:read_results');
  });

  it('nobody grades blind: a grader reads the one step first, under the same rule; the learner cannot; a hidden or foreign step is "not found"', async () => {
    const released = await item(tenant, { sensitivity: 0 });
    const id = await scenario(tenant, [released], { approved: true, authorCard: writer.card.id });
    const attempt = await run(tenant, id, learner);
    const answer = randomUUID();
    await seed(tenant.tenantId, async (q) => {
      const step = await q('SELECT id FROM scenario_steps WHERE scenario_id = $1', [id]);
      await q('INSERT INTO scenario_answers (id, tenant_id, attempt_id, step_id, position) VALUES ($1, $2, $3, $4, 1)', [answer, tenant.tenantId, attempt, step[0].id]);
    });
    expect((await learner.client.get(`/v1/scenario-answers/${answer}`)).status).toBe(403);          // no right to grade
    expect((await approver.client.get(`/v1/scenario-answers/${randomUUID()}`)).status).toBe(404);
    expect((await other.owner.get(`/v1/scenario-answers/${answer}`)).status).toBe(404);             // another company
    expect(stub.ofAction('scenario.answer_read')).toEqual([]);
    const seen = await approver.client.get(`/v1/scenario-answers/${answer}`);
    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({ awaiting_person: true, details_removed: false, points: [{ text: 'Stop the machine first', met: null }] });
    const call = stub.ofAction('scenario.answer_read')[0]!;
    expect(call.claims).toMatchObject({ subject: answer });
    expect(call.claims.filter.action).toBe('quiz:read_results');
    // what the AI service refuses ("not found": not handed in, not waiting, not readable) stays "not found" for the grader
    stub.answers.set('scenario.answer_read', () => new StubError(404, 'not_found'));   // the stand-in fails when a StubError is RETURNED
    expect((await approver.client.get(`/v1/scenario-answers/${answer}`)).status).toBe(404);
    stub.answers.set('scenario.override', () => new StubError(404, 'not_found'));
    expect((await approver.client.post(`/v1/scenario-answers/${answer}/override`, { score: 1 })).status).toBe(404);
  });

  it('a run that expired or waits for a person shows no score and no expected point, even if the AI service sent them', async () => {
    const released = await item(tenant, { sensitivity: 0 });
    const id = await scenario(tenant, [released], { approved: true, authorCard: writer.card.id });
    const attempt = await run(tenant, id, learner);
    for (const status of ['expired', 'submitted']) {
      stub.answers.set('scenario.attempt_read', (c) => ({
        id: c.claims.subject, scenario_id: id, title: 'Synthetic scenario', situation: 'Synthetic situation', job_role: 'Operator',
        learner_person_id: learner.personId, status, started_at: new Date().toISOString(), expires_at: new Date().toISOString(),
        submitted_at: null, graded_at: null, scores_released: true, points_released: true,
        steps: [{ answer_id: randomUUID(), position: 1, prompt: 'Synthetic prompt?', answer_text: 'mine', final_score: 1, decided_by: 'ai',
          points: [{ text: 'LEAKED POINT', met: true }], read_these: [{ id: released, title: 'LEAKED TITLE' }] }],
      }));
      const res = await learner.client.get(`/v1/scenario-attempts/${attempt}`);
      expect(res.status, status).toBe(200);
      expect(Object.keys(res.body.steps[0]).sort(), status).toEqual(['answer_id', 'answer_text', 'position', 'prompt']);
      expect(res.raw, status).not.toContain('LEAKED');
    }
  });
});
