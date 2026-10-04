// Idempotency keys on state-changing admin endpoints: a retry or a double click must not
// do the thing twice, and a replay must never reveal a one-time secret again.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, createTenant, startApp, superuser, type TestApp, type TestTenant } from '../helpers/harness.ts';

let t: TestApp;
let su: pg.Client;
let tenant: TestTenant;
beforeAll(async () => {
  t = await startApp();
  su = await superuser();
  tenant = await createTenant(t, 'idem');
});
afterAll(async () => {
  await su.end();
  await t.close();
});

const cardsOf = async (personId: string): Promise<number> =>
  (await su.query('SELECT count(*)::int AS n FROM cards WHERE person_id = $1', [personId])).rows[0].n;

describe('idempotency keys', () => {
  it('issue: same key + same request -> one card; the replay has no SC and no enrollment token', async () => {
    const person = await tenant.owner.post('/v1/people', { display_name: 'Idem One' });
    const body = { person_id: person.body.id, roles: [{ role_key: 'expert' }] };
    const first = await tenant.owner.post('/v1/cards', body, 'issue-key-0001');
    expect(first.status).toBe(201);
    expect(first.body.sc).toMatch(/^\d{3}$/);
    expect(first.body.enrollment_token).toBeTruthy();
    expect(first.body.secret_already_shown).toBe(false);

    const second = await tenant.owner.post('/v1/cards', body, 'issue-key-0001');
    expect(second.status).toBe(201);
    expect(second.body.card.id).toBe(first.body.card.id);
    expect(second.body.card.card_number).toBe(first.body.card.card_number);
    expect(second.body.sc).toBeUndefined();
    expect(second.body.enrollment_token).toBeUndefined();
    expect(second.body.secret_already_shown).toBe(true);
    expect(second.raw).not.toContain(first.body.enrollment_token);
    expect(await cardsOf(person.body.id)).toBe(1);

    const stored = await su.query(`SELECT response_body::text AS b FROM idempotency_keys WHERE key = 'issue-key-0001'`);
    expect(stored.rows[0].b).not.toContain(first.body.enrollment_token);
    expect(stored.rows[0].b).not.toMatch(/"sc"\s*:/);
  });

  it('five simultaneous requests with the same key create exactly one card', async () => {
    const person = await tenant.owner.post('/v1/people', { display_name: 'Idem Race' });
    const body = { person_id: person.body.id, roles: [{ role_key: 'expert' }] };
    const results = await Promise.all(Array.from({ length: 5 }, () => tenant.owner.post('/v1/cards', body, 'issue-key-race-1')));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.body.card.id)).size).toBe(1);
    expect(results.filter((r) => typeof r.body.sc === 'string')).toHaveLength(1); // the SC was shown exactly once
    expect(await cardsOf(person.body.id)).toBe(1);
  });

  it('same key + DIFFERENT request -> 409, and nothing is created', async () => {
    const p1 = await tenant.owner.post('/v1/people', { display_name: 'Idem A' });
    const p2 = await tenant.owner.post('/v1/people', { display_name: 'Idem B' });
    expect((await tenant.owner.post('/v1/cards', { person_id: p1.body.id, roles: [{ role_key: 'expert' }] }, 'issue-key-0002')).status).toBe(201);
    const clash = await tenant.owner.post('/v1/cards', { person_id: p2.body.id, roles: [{ role_key: 'expert' }] }, 'issue-key-0002');
    expect(clash.status).toBe(409);
    expect(clash.body.type).toBe('urn:legacyai:problem:idempotency-key-reuse');
    expect(await cardsOf(p2.body.id)).toBe(0);
    // the same key on a different ENDPOINT is also a reuse
    const other = await tenant.owner.post('/v1/departments', { name: 'Idem Dept' }, 'issue-key-0002');
    expect(other.status).toBe(409);
  });

  it('a missing or malformed key is rejected before anything happens', async () => {
    const person = await tenant.owner.post('/v1/people', { display_name: 'Idem None' });
    const body = { person_id: person.body.id, roles: [{ role_key: 'expert' }] };
    expect((await tenant.owner.post('/v1/cards', body, false)).status).toBe(400);
    for (const bad of ['short', 'has spaces in it', 'x'.repeat(200), 'semi;colon-key']) {
      expect((await tenant.owner.post('/v1/cards', body, bad)).status, bad).toBe(400);
    }
    expect(await cardsOf(person.body.id)).toBe(0);
  });

  it.each([
    ['suspend', (id: string) => [`/v1/cards/${id}/suspend`, { reason: 'idem' }] as const, 'suspended'],
    ['revoke', (id: string) => [`/v1/cards/${id}/revoke`, { reason: 'idem' }] as const, 'revoked'],
  ])('%s twice with the same key happens once', async (_name, req, eventType) => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }], { login: false });
    const [url, body] = req(m.card.id);
    const key = `twice-${eventType}-${m.card.id}`;
    const a = await tenant.owner.post(url, body, key);
    const b = await tenant.owner.post(url, body, key);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.body).toEqual(a.body);
    const n = await su.query('SELECT count(*)::int AS n FROM card_events WHERE card_id = $1 AND event_type = $2', [m.card.id, eventType]);
    expect(n.rows[0].n).toBe(1);
    // without the key protection the second call would have been a 409 illegal transition:
    expect((await tenant.owner.post(url, body)).status).toBe(409);
  });

  it('keys are scoped to the acting card: two admins may use the same key independently', async () => {
    const admin = await addMember(t, tenant.owner, [{ role_key: 'admin' }]);
    const a = await tenant.owner.post('/v1/departments', { name: 'Scoped One' }, 'shared-key-0001');
    const b = await admin.client.post('/v1/departments', { name: 'Scoped Two' }, 'shared-key-0001');
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.id).not.toBe(b.body.id);
  });

  it('a request that failed is not remembered: fixing the problem and retrying the key works', async () => {
    const person = await tenant.owner.post('/v1/people', { display_name: 'Idem Retry' });
    const bad = await tenant.owner.post('/v1/cards', { person_id: person.body.id, roles: [{ role_key: 'auditor' }] }, 'retry-key-0001');
    expect(bad.status).toBe(422); // role not enabled for this tenant
    const sameAgain = await tenant.owner.post('/v1/cards', { person_id: person.body.id, roles: [{ role_key: 'auditor' }] }, 'retry-key-0001');
    expect(sameAgain.status).toBe(422);
    expect(await cardsOf(person.body.id)).toBe(0);
  });

  it('a denied request is not stored either, so a key cannot be used to replay someone else\'s success', async () => {
    const expert = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    const denied = await expert.client.post('/v1/departments', { name: 'Nope Dept' }, 'denied-key-0001');
    expect(denied.status).toBe(403);
    expect((await su.query(`SELECT 1 FROM idempotency_keys WHERE key = 'denied-key-0001'`)).rowCount).toBe(0);
  });

  it('every state-changing admin operation in the contract requires a key', () => {
    const required = ['issueCard', 'suspendCard', 'reinstateCard', 'revokeCard', 'replaceCard', 'renewCard', 'unlockCard',
      'issueEnrollmentToken', 'putCardRestrictions', 'assignCardRole', 'replaceCardRoles', 'removeCardRole', 'createPerson',
      'updatePerson', 'createDepartment', 'createTenant', 'updateTenantSettings', 'createExport', 'renewCompanyCard', 'recoverOwnerCard',
      // Phase 2: every state-changing operation except asking a question (a read that may cost AI money, never stored)
      // and sending a file (its body is the file; the source it belongs to can only receive one).
      'acceptInterview', 'addRedactionAllowlistTerm', 'answerInterviewTurn', 'approveQuizQuestion', 'assignReviewTask', 'bulkReviewTasks',
      'completeInterview', 'confirmSource', 'createExpertQuestion', 'createInterview', 'createKnowledgeItem', 'createSource', 'createTopic',
      'declineExpertQuestion', 'deleteRedactionAllowlistTerm', 'dismissReviewTask', 'editQuizQuestion', 'generateQuizQuestions', 'giveConsent',
      'holdConsent', 'overrideQuizAnswer', 'pauseInterview', 'proposeItemVersion', 'putAnswerFeedback', 'recordWithdrawalForPerson', 'rejectKnowledgeItem',
      'releaseConsentHold', 'reopenKnowledgeItem', 'replyExpertQuestion', 'restrictContribution', 'resumeInterview', 'retireKnowledgeItem',
      'retireQuizQuestion', 'revertVerifications', 'saveAttemptAnswer', 'setAiKillSwitch', 'setItemLabels', 'setItemTopics', 'setRolePeople', 'setRoleTopics',
      'setSourceLabels', 'setTenantAiBudget', 'startReadinessAttempt', 'submitKnowledgeItem', 'submitReadinessAttempt', 'suggestTopics',
      'unassignReviewTask', 'updateKnowledgeSettings', 'updateTopic', 'verifyKnowledgeItem', 'withdrawAnswerFeedback', 'withdrawConsent', 'withdrawSource',
      // Phase 4, step 2 (anomaly lock, retirement radar, department templates)
      'updateAnomalySettings', 'setLeavingDate', 'clearLeavingDate', 'applyTopicTemplate',
      // Phase 4, step 4 (scenario replay): every write
      'createScenario', 'updateScenario', 'approveScenario', 'retireScenario', 'proposeScenarioRubric', 'startScenarioAttempt',
      'saveScenarioAnswer', 'submitScenarioAttempt', 'overrideScenarioAnswer',
      // Phase 4, billing: a renewal must never be issued or applied twice
      'updateSubscription', 'startRenewal', 'recordManualPayment', 'setTenantSeatLimit',
      // Phase 4, API keys: a retried request must not make a second key
      'createApiKey', 'revokeApiKey'];
    for (const id of required) expect(t.app.http.contract.operations.get(id)?.idempotent, id).toBe(true);
    const actual = [...t.app.http.contract.operations.values()].filter((o) => o.idempotent).map((o) => o.operationId).sort();
    expect(actual).toEqual([...required].sort());
  });
});
