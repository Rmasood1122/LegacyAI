// Both services together (docs/phase2/10, "API <-> Python contract"): the API and the REAL AI service
// (fake AI provider, fake embedder) against the same test database. Walks every Phase 2 operation
// through realistic flows; every response is validated against openapi.yaml by the server itself,
// and the server's calls are validated against the internal contract by its client.
//
// Runs only when AI_SERVICE_URL_REAL points at a running AI service (the "both services" CI job).
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, createTenant, platformOperator, startApp, superuser, type Res, type TestApp, type TestTenant } from '../helpers/harness.ts';

const REAL = process.env.AI_SERVICE_URL_REAL;
// Phase 2, plus Phase 4: five quality operations (features 22, 23), two for department templates (26), one for activity numbers (27), two for the graph (30)
const PHASE2_OPERATIONS = 78 + 5 + 2 + 3;

describe.skipIf(!REAL)('Phase 2 walk with the real AI service', () => {
  let t: TestApp;
  let tenant: TestTenant;
  let su: pg.Client;

  beforeAll(async () => {
    t = await startApp({}, { AI_SERVICE_URL: REAL });
    su = await superuser();
    tenant = await createTenant(t, 'walk');
  });
  afterAll(async () => {
    await su?.end();
    await t?.close();
  });

  it('every Phase 2 operation answers as the contract says', async () => {
    const hit = new Set<string>();
    const ok = (id: string, res: Res, status: number | number[]): Res => {
      const want = Array.isArray(status) ? status : [status];
      expect(want, `${id}: ${res.status} ${res.raw.slice(0, 400)}`).toContain(res.status);
      hit.add(id);
      return res;
    };
    const o = tenant.owner;
    const expert = await addMember(t, o, [{ role_key: 'expert' }]);
    const reviewer = await addMember(t, o, [{ role_key: 'expert' }]);
    const reviewer2 = await addMember(t, o, [{ role_key: 'expert' }]);
    const learner = await addMember(t, o, [{ role_key: 'successor' }]);
    const e = expert.client;
    const r = reviewer.client;
    const r2 = reviewer2.client;
    const l = learner.client;

    // ---- consent
    for (const scope of ['own_words', 'documents', 'named_expert']) {
      ok('giveConsent', await e.post('/v1/consents', { scope, purpose: 'Synthetic walk', policy_version: 'walk-1' }), 201);
    }
    const mine = ok('listMyConsents', await e.get('/v1/me/consents?limit=2'), 200);
    expect(mine.body.items).toHaveLength(2);                                   // three were given: the list is cut and says so
    expect((await e.get(`/v1/me/consents?limit=2&cursor=${mine.body.next_cursor}`)).body.items).toHaveLength(1);
    ok('listConsents', await o.get(`/v1/consents?person_id=${expert.personId}`), 200);

    // ---- settings and budget
    ok('getKnowledgeSettings', await o.get('/v1/knowledge/settings'), 200);
    ok('updateKnowledgeSettings', await o.patch('/v1/knowledge/settings', { quiz_min_questions_per_topic: 1 }), 200);
    ok('getAiBudget', await o.get('/v1/ai/budget'), 200);
    const op = await platformOperator(t);
    ok('setTenantAiBudget', await op.put(`/v1/tenants/${tenant.tenantId}/ai-budget`, { monthly_cap_micro_usd: 5_000_000 }), 200);
    ok('setAiKillSwitch', await op.put('/v1/platform/ai/kill-switch', { on: false }), 200);
    ok('getPlatformStorage', await op.get('/v1/platform/storage'), 200);

    // ---- documents
    const doc = ok('createSource', await o.post('/v1/sources', { title: 'Boiler manual', company_document: true, sensitivity: 1 }), 201);
    const text = 'Boiler start-up. Purge the furnace for five minutes before lighting the burner.\n\n'
      + 'Relief valves. Lift each relief valve lever monthly until steam escapes, then release it.\n\n'
      + 'Questions go to plant.office@corp.test.';
    const up = ok('uploadSourceContent', await o.request('PUT', `/v1/sources/${doc.body.id}/content`, Buffer.from(text) as unknown as object,
      { headers: { 'content-type': 'text/plain' } }), 200);
    expect(up.body.status).toBe('ready');
    const detail = ok('getSource', await o.get(`/v1/sources/${doc.body.id}`), 200);
    expect(detail.body.redactions.map((x: any) => x.type)).toContain('EMAIL');
    ok('listSources', await o.get('/v1/sources'), 200);
    ok('setSourceLabels', await o.patch(`/v1/sources/${doc.body.id}/labels`, { department_id: null, sensitivity: 1 }), 200);
    const named = ok('createSource', await o.post('/v1/sources', { title: 'Expert notes', contributor_person_id: expert.personId }), 201);
    ok('confirmSource', await e.post(`/v1/sources/${named.body.id}/confirm`), 200);
    ok('suggestTopics', await o.post('/v1/topics/suggest', { source_id: doc.body.id }), 201);

    // ---- topics, roles, gaps
    const role = 'Boiler operator';
    const topic = ok('createTopic', await o.post('/v1/topics', { name: 'Relief valves', description: 'testing relief valves on the boiler' }), 201);
    ok('updateTopic', await o.patch(`/v1/topics/${topic.body.id}`, { description: 'monthly relief valve testing' }), 200);
    ok('listTopics', await o.get('/v1/topics'), 200);
    ok('setRoleTopics', await o.put(`/v1/job-roles/${encodeURIComponent(role)}/topics`, { topics: [{ topic_id: topic.body.id, importance: 3 }] }), 200);
    ok('setRolePeople', await o.put(`/v1/job-roles/${encodeURIComponent(role)}/people`, { people: [{ person_id: learner.personId, relation: 'successor' }] }), 200);
    ok('getGapReport', await o.get(`/v1/gaps?job_role=${encodeURIComponent(role)}`), 200);
    const roles = ok('listJobRoles', await l.get('/v1/job-roles'), 200);
    expect(roles.body.items).toEqual([{ job_role: role, topic_count: 1 }]);
    const roleTopics = ok('getRoleTopics', await l.get(`/v1/job-roles/${encodeURIComponent(role)}/topics`), 200);
    expect(roleTopics.body.topics).toEqual([{ topic_id: topic.body.id, required: true, importance: 3 }]);
    const rolePeople = ok('getRolePeople', await o.get(`/v1/job-roles/${encodeURIComponent(role)}/people`), 200);
    expect(rolePeople.body.people).toEqual([{ person_id: learner.personId, relation: 'successor' }]);
    expect((await l.get(`/v1/job-roles/${encodeURIComponent(role)}/people`)).status).toBe(403);   // a learner has no gap report

    // ---- knowledge items and verification
    const itemRes = ok('createKnowledgeItem', await e.post('/v1/knowledge/items', {
      title: 'Relief valve test', body: 'Lift each relief valve lever monthly until steam escapes, then release it slowly.', sensitivity: 1,
      contributor_person_id: expert.personId,
    }), 201);
    const itemId = itemRes.body.id as string;
    ok('submitKnowledgeItem', await e.post(`/v1/knowledge/items/${itemId}/submit`), 200);
    expect((await e.post(`/v1/knowledge/items/${itemId}/verify`)).status).toBe(403);       // the contributor may not verify
    ok('verifyKnowledgeItem', await r.post(`/v1/knowledge/items/${itemId}/verify`), 200);
    ok('getKnowledgeItem', await o.get(`/v1/knowledge/items/${itemId}`), 200);
    ok('listKnowledgeItems', await o.get('/v1/knowledge/items'), 200);
    ok('proposeItemVersion', await r.post(`/v1/knowledge/items/${itemId}/versions`, {
      body: 'Lift each relief valve lever monthly until steam escapes, then release it slowly. Wear gloves.',
    }), 201);
    expect((await r.post(`/v1/knowledge/items/${itemId}/verify`)).status).toBe(403);       // nobody confirms their own correction
    expect((await r2.post(`/v1/knowledge/items/${itemId}/verify`)).body.status).toBe('corrected');
    ok('setItemLabels', await o.patch(`/v1/knowledge/items/${itemId}/labels`, { department_id: null, sensitivity: 0 }), 200);   // released to learners
    // the reviewer links the item to its topic through the API (until 2026-10 this was only possible in the database)
    expect((await l.put(`/v1/knowledge/items/${itemId}/topics`, { topic_ids: [topic.body.id] })).status).toBe(403);   // a learner may not
    expect((await e.put(`/v1/knowledge/items/${itemId}/topics`, { topic_ids: [topic.body.id] })).status).toBe(403);   // nor its contributor, once it is verified
    expect((await r.put(`/v1/knowledge/items/${itemId}/topics`, { topic_ids: [topic.body.id] })).status).toBe(403);   // nor the author of its current version
    expect((await r2.put(`/v1/knowledge/items/${itemId}/topics`, { topic_ids: [randomUUID()] })).status).toBe(422);   // not a topic of this company
    const linked = ok('setItemTopics', await r2.put(`/v1/knowledge/items/${itemId}/topics`, { topic_ids: [topic.body.id] }), 200);
    expect(linked.body.topics).toEqual([{ topic_id: topic.body.id, name: 'Relief valves', link_source: 'reviewer' }]);
    expect((await o.get(`/v1/knowledge/items/${itemId}`)).body.topics).toEqual(linked.body.topics);
    const stored = await su.query('SELECT link_source FROM knowledge_item_topics WHERE item_id = $1 AND topic_id = $2', [itemId, topic.body.id]);
    expect(stored.rows).toEqual([{ link_source: 'reviewer' }]);

    // ---- asking
    const answer = ok('askKnowledge', await l.post('/v1/knowledge/ask', { question: 'How often do I test a relief valve lever?' }), 200);
    expect(['answered', 'dont_know', 'search_only']).toContain(answer.body.outcome);
    ok('askKnowledge', await l.post('/v1/knowledge/ask', { question: 'Relief valve lever test?', expert_person_id: expert.personId }), 200);

    // ---- ask-the-expert
    const q1 = ok('createExpertQuestion', await l.post('/v1/expert-questions', { expert_person_id: expert.personId, question: 'What if the lever sticks?' }), 201);
    const q2 = ok('createExpertQuestion', await l.post('/v1/expert-questions', { expert_person_id: expert.personId, question: 'What is the payroll calendar?' }), 201);
    const asked = ok('listExpertQuestions', await e.get('/v1/expert-questions?box=addressed&limit=1'), 200);
    expect(asked.body.items.map((q: any) => q.id)).toEqual([q2.body.id]);      // newest first, one per page
    const older = await e.get(`/v1/expert-questions?box=addressed&limit=1&cursor=${asked.body.next_cursor}`);
    expect(older.body.items.map((q: any) => q.id)).toEqual([q1.body.id]);
    expect(older.body.next_cursor).toBeNull();
    ok('replyExpertQuestion', await e.post(`/v1/expert-questions/${q1.body.id}/reply`, { answer: 'Tap it gently and report it; never force it.', title: 'Sticking lever' }), 200);
    ok('declineExpertQuestion', await e.post(`/v1/expert-questions/${q2.body.id}/decline`, { reason: 'not_my_area' }), 200);

    // ---- interviews
    const iv = ok('createInterview', await o.post('/v1/interviews', { expert_person_id: expert.personId, job_role: role }), 201);
    ok('acceptInterview', await e.post(`/v1/interviews/${iv.body.id}/accept`), 200);
    ok('answerInterviewTurn', await e.post(`/v1/interviews/${iv.body.id}/turns`, {
      answer: 'Before a relief valve test I tell the control room, because the noise sets off the alarm panel otherwise.',
    }), 200);
    ok('pauseInterview', await e.post(`/v1/interviews/${iv.body.id}/pause`), 200);
    ok('resumeInterview', await e.post(`/v1/interviews/${iv.body.id}/resume`), 200);
    ok('getInterview', await o.get(`/v1/interviews/${iv.body.id}`), 200);
    ok('listInterviews', await o.get('/v1/interviews'), 200);
    ok('completeInterview', await e.post(`/v1/interviews/${iv.body.id}/complete`), 200);

    // ---- readiness
    const gen = ok('generateQuizQuestions', await r.post('/v1/readiness/questions/generate', { kind: 'mcq', item_ids: [itemId] }), 201);
    const qid = gen.body.created[0] as string;
    ok('listQuizQuestions', await r.get('/v1/readiness/questions'), 200);
    ok('editQuizQuestion', await r.patch(`/v1/readiness/questions/${qid}`, {
      stem: 'How often is a relief valve lever tested?', options: ['Monthly', 'Yearly', 'Never', 'Daily'], correct_option: 0,
    }), 200);
    ok('approveQuizQuestion', await r2.post(`/v1/readiness/questions/${qid}/approve`), 200);
    const attempt = ok('startReadinessAttempt', await l.post('/v1/readiness/attempts', { job_role: role }), 201);
    ok('saveAttemptAnswer', await l.post(`/v1/readiness/attempts/${attempt.body.id}/answers`, { position: 1, chosen_option: 0 }), 200);
    ok('submitReadinessAttempt', await l.post(`/v1/readiness/attempts/${attempt.body.id}/submit`), 200);
    const read = ok('getReadinessAttempt', await l.get(`/v1/readiness/attempts/${attempt.body.id}`), 200);
    ok('overrideQuizAnswer', await r.post(`/v1/readiness/answers/${read.body.questions[0].answer_id}/override`, { score: 1 }), 200);
    const taken = ok('listReadinessAttempts', await l.get('/v1/readiness/attempts'), 200);
    expect(taken.body.items.map((a: any) => [a.id, a.job_role, a.learner_person_id])).toEqual([[attempt.body.id, role, learner.personId]]);
    expect(JSON.stringify(taken.body)).not.toMatch(/correct_option|rubric|stem|score/);     // labels and times only
    expect((await o.get('/v1/readiness/attempts')).body.items.map((a: any) => a.id)).toEqual([attempt.body.id]);   // the owner sees the company's
    expect((await e.get('/v1/readiness/attempts')).status).toBe(403);                         // an expert has no right to results
    const report = ok('getReadinessReport', await o.get(`/v1/readiness/reports/${attempt.body.id}`), 200);
    expect(report.body.statement).toContain('not a certificate');
    ok('retireQuizQuestion', await r2.post(`/v1/readiness/questions/${qid}/retire`), 200);

    // ---- review queue and allow-list
    const tasks = ok('listReviewTasks', await o.get('/v1/review/tasks?limit=50'), 200);
    expect(tasks.body.items.length).toBeGreaterThan(0);
    const anyTask = tasks.body.items.find((x: any) => x.status === 'open') ?? tasks.body.items[0];
    ok('getReviewTask', await o.get(`/v1/review/tasks/${anyTask.id}`), 200);
    ok('assignReviewTask', await r.post(`/v1/review/tasks/${anyTask.id}/assign`, {}), [200, 409]);
    ok('unassignReviewTask', await r.post(`/v1/review/tasks/${anyTask.id}/unassign`), [200, 409]);
    ok('dismissReviewTask', await r.post(`/v1/review/tasks/${anyTask.id}/dismiss`), [200, 409]);
    ok('bulkReviewTasks', await r.post('/v1/review/tasks/bulk', { action: 'assign', task_ids: [anyTask.id, randomUUID()] }), 200);
    const term = ok('addRedactionAllowlistTerm', await r.post('/v1/redaction/allowlist', { term: 'Hydrovac', entity_type: 'OTHER' }), 201);
    ok('listRedactionAllowlist', await r.get('/v1/redaction/allowlist'), 200);
    ok('deleteRedactionAllowlistTerm', await r.del(`/v1/redaction/allowlist/${term.body.id}`), 204);

    // ---- the contributor's own controls, reopen, revert, retire
    ok('listMyContributions', await e.get('/v1/me/contributions'), 200);
    const second = (await e.post('/v1/knowledge/items', { title: 'Purge', body: 'Purge the furnace for five minutes before lighting the burner.', contributor_person_id: expert.personId })).body.id as string;
    ok('restrictContribution', await e.post(`/v1/me/contributions/${second}/restrict`, { sensitivity: 2 }), [200, 403]);
    ok('reopenKnowledgeItem', await r2.post(`/v1/knowledge/items/${itemId}/reopen`, {}), 200);
    ok('rejectKnowledgeItem', await r2.post(`/v1/knowledge/items/${itemId}/reject`), 200);
    ok('retireKnowledgeItem', await r2.post(`/v1/knowledge/items/${itemId}/retire`), [409]);   // only stale items retire
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const until = new Date(Date.now() + 3_600_000).toISOString();
    ok('revertVerifications', await o.post('/v1/knowledge/verifications/revert', { card_id: reviewer.card.id, since, until }), 200);

    // ---- withdrawing
    ok('withdrawSource', await o.post(`/v1/sources/${doc.body.id}/withdraw`), 200);
    const consents = (await e.get('/v1/me/consents')).body.items as Array<{ id: string; scope: string; withdrawn_at: string | null }>;
    const docs = consents.find((c) => c.scope === 'documents' && c.withdrawn_at === null)!;
    ok('holdConsent', await o.post(`/v1/consents/${docs.id}/hold`, { reason: 'Synthetic walk hold' }), 200);
    ok('withdrawConsent', await e.post(`/v1/consents/${docs.id}/withdraw`), 200);
    ok('releaseConsentHold', await o.post(`/v1/consents/${docs.id}/release-hold`), 200);
    ok('recordWithdrawalForPerson', await o.post(`/v1/people/${expert.personId}/consent-withdrawals`, { reference: 'WALK-REQ-0001' }), 200);

    // ---- answer quality (features 22, 23)
    expect(typeof answer.body.answer_id).toBe('string');
    expect(answer.body.conflicts).toEqual([]);
    const feedbackUrl = `/v1/knowledge/answers/${answer.body.answer_id}/feedback`;
    expect((await e.put(feedbackUrl, { verdict: 'wrong' })).status).toBe(404);                                         // not the card that asked
    expect((await l.get(feedbackUrl)).status).toBe(404);                                                               // no opinion given yet
    ok('putAnswerFeedback', await l.put(feedbackUrl, { verdict: 'helpful', share_question: true }), 200);
    const myOpinion = ok('getAnswerFeedback', await l.get(feedbackUrl), 200);
    expect(myOpinion.body.verdict).toBe('helpful');
    expect(typeof myOpinion.body.question).toBe('string');                                                                 // shared, so it comes back
    ok('withdrawAnswerFeedback', await l.request('DELETE', feedbackUrl, undefined, { idem: `k-${randomUUID()}` }), 204);
    expect((await l.get(feedbackUrl)).status).toBe(404);
    const wrong = ok('putAnswerFeedback', await l.put(feedbackUrl, { verdict: 'wrong', comment: 'Synthetic: the lever is tested weekly here.' }), 200);
    expect(wrong.body.question).toBeNull();                                                                            // not shared: nobody reads the question
    expect((await l.get('/v1/quality/summary')).status).toBe(403);                                                     // a learner may not read the company's numbers
    const quality = ok('getQualitySummary', await o.get('/v1/quality/summary?weeks=2'), 200);
    expect(quality.body.weeks[0].questions).toBeGreaterThanOrEqual(2);
    expect(quality.body.weeks[0].feedback_wrong).toBe(1);
    expect(quality.body.waiting_for_review.answers_marked_wrong).toBe(1);
    const said = ok('listAnswerFeedback', await o.get('/v1/quality/feedback?verdict=wrong'), 200);
    expect(said.body.items.map((f: any) => f.answer_id)).toEqual([answer.body.answer_id]);
    expect(said.body.items[0].question).toBeNull();
    expect(said.body.items[0].question_shared).toBe(false);
    const wrongTasks = await o.get('/v1/review/tasks?kind=answer_feedback');
    expect(wrongTasks.body.items.map((x: any) => x.subject_id)).toEqual([answer.body.answer_id]);

    // department templates (feature 26): topics are created and embedded exactly as createTopic does it
    const templates = ok('listTopicTemplates', await o.get('/v1/topic-templates'), 200);
    expect(templates.body.items.length).toBeGreaterThanOrEqual(6);
    const applied = ok('applyTopicTemplate', await o.post('/v1/topic-templates/warehouse/apply'), 200);
    expect(applied.body).toMatchObject({ template_key: 'warehouse', topics_created: 6, topics_skipped: 0 });
    expect((await o.post('/v1/topic-templates/warehouse/apply')).body).toMatchObject({ topics_created: 0, topics_existing: 6, links_created: 0 });

    // activity numbers (feature 27): every month of the range; a job role with one learner shows no numbers
    const activity = ok('getActivity', await o.get('/v1/analytics/activity?months=3'), 200);
    expect(activity.body.months).toHaveLength(3);
    expect(activity.body.months[0].items_captured).toBeGreaterThanOrEqual(1);
    expect(activity.body.months[0].interviews_completed).not.toBeNull();        // the Owner may read interviews: a number, not null
    expect(activity.body.job_role_results).toMatchObject({ state: 'shown', minimum_group: 5 });
    for (const j of activity.body.job_role_results.rows) expect(j).toMatchObject({ state: 'too_few_people', people: null, attempts: null, mean_score: null });
    expect((await l.get('/v1/analytics/activity')).status).toBe(403);

    // the knowledge map (feature 30): taking it out is an export (the Owner's right), then the neighbourhood of one of its nodes
    expect((await l.post('/v1/knowledge/graph/export')).status).toBe(403);                               // a learner may browse the map, not take it out
    const whole = ok('exportKnowledgeGraph', await o.post('/v1/knowledge/graph/export'), 200);
    expect(whole.body).toMatchObject({ schema: 'legacyai-knowledge-graph/1', limits: { nodes_per_kind: 2000, edges: 10000 } });
    const start = whole.body.nodes.find((n: any) => n.kind === 'item' || n.kind === 'topic');
    expect(start, 'the walk created topics, so the map cannot be empty').toBeDefined();
    const around = ok('getGraphNeighbourhood', await o.get(`/v1/knowledge/graph?kind=${start.kind}&id=${start.id}`), 200);
    expect(around.body.node).toMatchObject({ kind: start.kind, id: start.id });
    for (const g of around.body.neighbours) expect(typeof g.truncated).toBe('boolean');
    expect((await o.get(`/v1/knowledge/graph?kind=item&id=${randomUUID()}`)).status).toBe(404);          // unknown and unreadable look the same
    expect((await o.get('/v1/knowledge/graph?kind=person&id=x')).status).toBe(400);                       // people are not nodes
    const has = (r: any): boolean => whole.body.nodes.some((n: any) => n.kind === r.kind && n.id === r.id);
    for (const e of whole.body.edges) expect(has(e.from) && has(e.to), JSON.stringify(e)).toBe(true);

    expect(hit.size).toBe(PHASE2_OPERATIONS);
  });
});
