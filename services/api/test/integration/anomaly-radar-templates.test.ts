// Phase 4 step 2: anomaly lock (feature 5), retirement radar (feature 11), department templates (feature 26).
// Synthetic people and companies only. The anomaly rules are OFF by default in the test app (see the harness);
// each test here switches them on for its own company.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiStub } from '../helpers/ai-stub.ts';
import {
  addMember, Client, createTenant, login, startApp, superuser, tryLogin, type TestApp, type TestMember, type TestTenant,
} from '../helpers/harness.ts';
import { TEST_ORIGIN } from '../helpers/env.ts';

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

const lockState = async (cardId: string): Promise<{ locked: boolean; reason: string | null }> => {
  const { rows } = await su.query('SELECT locked_at, lock_reason FROM card_auth_state WHERE card_id = $1', [cardId]);
  return { locked: rows[0]?.locked_at != null, reason: rows[0]?.lock_reason ?? null };
};
const eventsOf = async (cardId: string, type: string): Promise<Array<{ metadata: { rule: string; count: number } }>> =>
  (await su.query('SELECT metadata FROM card_events WHERE card_id = $1 AND event_type = $2 ORDER BY id', [cardId, type])).rows;
const iso = (d: Date): string => d.toISOString().slice(0, 10);
const inMonths = (months: number): string => iso(new Date(t.clock.now().getTime() + months * 30.44 * 86_400_000 + 86_400_000));

describe('anomaly lock: refused actions of a signed-in card', () => {
  let tenant: TestTenant;
  let learner: TestMember;
  beforeAll(async () => {
    tenant = await createTenant(t, 'anomaly');
    learner = await addMember(t, tenant.owner, [{ role_key: 'successor' }]);
  });

  it('is off in the test app until the company sets its rules; ranges are enforced; only who may change settings can', async () => {
    const before = await tenant.owner.get('/v1/tenants/current/anomaly-settings');
    expect(before.status).toBe(200);
    expect(before.body).toEqual({
      enabled: false, denials_enabled: true, denials_threshold: 20, denials_window_minutes: 10,
      second_address_enabled: false, second_address_window_minutes: 15, updated_at: null,
    });
    // "off" is a switch, never a number: 0 minutes is refused
    expect((await tenant.owner.patch('/v1/tenants/current/anomaly-settings', { second_address_window_minutes: 0 })).status).toBe(400);
    expect((await tenant.owner.patch('/v1/tenants/current/anomaly-settings', { denials_threshold: 4 })).status).toBe(400);
    expect((await tenant.owner.patch('/v1/tenants/current/anomaly-settings', {})).status).toBe(400);
    expect((await learner.client.get('/v1/tenants/current/anomaly-settings')).status).toBe(403);
    expect((await learner.client.patch('/v1/tenants/current/anomaly-settings', { enabled: false })).status).toBe(403);
    const set = await tenant.owner.patch('/v1/tenants/current/anomaly-settings', { enabled: true, denials_threshold: 5, denials_window_minutes: 10 });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ enabled: true, denials_threshold: 5 });
    expect(typeof set.body.updated_at).toBe('string');
  });

  it('the fifth refusal inside the window locks the card: sessions end, history and audit name the rule, an admin unlocks it', async () => {
    for (let i = 0; i < 4; i += 1) expect((await learner.client.get('/v1/audit/events')).status).toBe(403);
    expect(await lockState(learner.card.id)).toEqual({ locked: false, reason: null });
    expect((await learner.client.get('/v1/audit/events')).status).toBe(403);      // the fifth is still answered "refused"
    expect(await lockState(learner.card.id)).toEqual({ locked: true, reason: 'anomaly' });
    expect((await learner.client.get('/v1/auth/session')).status).toBe(401);       // every session of the card has ended
    expect((await eventsOf(learner.card.id, 'anomaly_locked')).map((e) => e.metadata)).toEqual([{ rule: 'denials', count: 5 }]);
    const audit = await su.query(
      `SELECT reason_code, actor_kind, details FROM audit_log WHERE tenant_id = $1 AND resource_id = $2 AND action = 'card:lock'`,
      [tenant.tenantId, learner.card.id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ reason_code: 'CARD_LOCKED_ANOMALY_DENIALS', actor_kind: 'system' });
    expect(JSON.parse(audit.rows[0].details)).toEqual({ count: 5, rule: 'denials' });
    // signing in again does not work while locked
    expect((await tryLogin(t, learner.card.number, learner.card.sc, { passkey: learner.passkey })).res.status).toBe(401);

    // the owner sees it: on the card and in the list of recent anomalies
    const card = await tenant.owner.get(`/v1/cards/${learner.card.id}`);
    expect(card.body).toMatchObject({ locked: true, lock_reason: 'anomaly' });
    const list = await tenant.owner.get('/v1/anomalies');
    expect(list.status).toBe(200);
    expect(list.body.items[0]).toMatchObject({ card_id: learner.card.id, outcome: 'locked', rule: 'denials', count: 5 });
    expect(list.body.items[0].card_number).toMatch(/\d{4}$/);
    expect(list.body.items[0].card_number).not.toBe(learner.card.number);                 // masked, as everywhere
    expect(Object.keys(list.body.items[0]).sort()).toEqual(['card_id', 'card_number', 'count', 'id', 'occurred_at', 'outcome', 'rule']);

    // the same unlock as after wrong secret codes: a new secret code is issued
    const unlocked = await tenant.owner.post(`/v1/cards/${learner.card.id}/unlock`);
    expect(unlocked.status).toBe(200);
    expect(await lockState(learner.card.id)).toEqual({ locked: false, reason: null });
    // the audit trail says that this unlock followed an anomaly lock
    const unlockAudit = await su.query(`SELECT details FROM audit_log WHERE tenant_id = $1 AND resource_id = $2 AND action = 'card:unlock'`,
      [tenant.tenantId, learner.card.id]);
    expect(unlockAudit.rows.map((r) => JSON.parse(r.details))).toEqual([{ reason: 'anomaly' }]);
    learner.card.sc = unlocked.body.sc;
    learner.client = await login(t, learner.card, { passkey: learner.passkey });
    // counting starts from nothing: four more refusals do not lock again
    for (let i = 0; i < 4; i += 1) expect((await learner.client.get('/v1/audit/events')).status).toBe(403);
    expect(await lockState(learner.card.id)).toEqual({ locked: false, reason: null });
  });

  it('refusals older than the window do not add up', async () => {
    const other = await addMember(t, tenant.owner, [{ role_key: 'successor' }]);
    for (let i = 0; i < 4; i += 1) expect((await other.client.get('/v1/audit/events')).status).toBe(403);
    t.clock.advance(11 * 60_000);
    other.client = await login(t, other.card, { passkey: other.passkey });         // the idle session ended meanwhile
    for (let i = 0; i < 4; i += 1) expect((await other.client.get('/v1/audit/events')).status).toBe(403);
    expect(await lockState(other.card.id)).toEqual({ locked: false, reason: null });
  });

  it('a card NUMBER alone cannot be used to lock somebody\'s card: requests without that card\'s session count for nothing', async () => {
    const victim = await addMember(t, tenant.owner, [{ role_key: 'successor' }]);
    const digits = victim.card.number.replace(/\D/g, '');
    const anonymous = new Client(t);
    for (let i = 0; i < 12; i += 1) {
      // no session at all, a made-up session cookie, the number in a header: none of these is a session of the card
      expect((await anonymous.get('/v1/audit/events')).status).toBe(401);
      const forged = await t.app.http.app.inject({
        method: 'GET', url: '/v1/audit/events', headers: { 'x-card-number': digits }, cookies: { '__Host-lai_session': `v1.${tenant.tenantId}.${'A'.repeat(43)}` },
      });
      expect(forged.statusCode).toBe(401);
    }
    // somebody ELSE's refusals (another signed-in card of the same company) are counted for that other card only
    const noisy = await addMember(t, tenant.owner, [{ role_key: 'successor' }]);
    for (let i = 0; i < 4; i += 1) expect((await noisy.client.get(`/v1/cards/${victim.card.id}/restrictions`)).status).toBe(403);
    expect(await lockState(victim.card.id)).toEqual({ locked: false, reason: null });
    const counters = await su.query('SELECT denials FROM card_anomaly_counters WHERE card_id = $1', [victim.card.id]);
    expect(counters.rows).toEqual([]);
    expect((await victim.client.get('/v1/auth/session')).status).toBe(200);
  });

  it('a card cannot unlock itself, and a learner cannot unlock anyone', async () => {
    const helper = await addMember(t, tenant.owner, [{ role_key: 'successor' }]);
    expect((await helper.client.post(`/v1/cards/${helper.card.id}/unlock`)).status).toBe(403);
    expect((await helper.client.post(`/v1/cards/${learner.card.id}/unlock`)).status).toBe(403);
  });

  it('switched off, nothing is counted', async () => {
    expect((await tenant.owner.patch('/v1/tenants/current/anomaly-settings', { enabled: false })).status).toBe(200);
    const quiet = await addMember(t, tenant.owner, [{ role_key: 'successor' }]);
    for (let i = 0; i < 8; i += 1) expect((await quiet.client.get('/v1/audit/events')).status).toBe(403);
    expect(await lockState(quiet.card.id)).toEqual({ locked: false, reason: null });
  });
});

describe('anomaly lock: the last usable Owner card is never locked by a rule', () => {
  it('a rule that fires on the only Owner is recorded, the card stays usable; with a second Owner the first can be locked', async () => {
    const tenant = await createTenant(t, 'lastowner');
    expect((await tenant.owner.patch('/v1/tenants/current/anomaly-settings', { enabled: true, denials_threshold: 5 })).status).toBe(200);
    // five refusals for the Owner: an operator-only address
    for (let i = 0; i < 5; i += 1) expect((await tenant.owner.get('/v1/tenants')).status).toBe(403);
    expect(await lockState(tenant.ownerCard.id)).toEqual({ locked: false, reason: null });
    expect((await tenant.owner.get('/v1/auth/session')).status).toBe(200);
    expect((await eventsOf(tenant.ownerCard.id, 'anomaly_not_locked')).map((e) => e.metadata)).toEqual([{ rule: 'denials', count: 5 }]);
    const audit = await su.query(`SELECT reason_code FROM audit_log WHERE tenant_id = $1 AND resource_id = $2 AND action = 'card:lock'`,
      [tenant.tenantId, tenant.ownerCard.id]);
    expect(audit.rows.map((r) => r.reason_code)).toEqual(['ANOMALY_NOT_LOCKED_LAST_OWNER']);
    const list = await tenant.owner.get('/v1/anomalies');
    expect(list.body.items[0]).toMatchObject({ card_id: tenant.ownerCard.id, outcome: 'not_locked_last_owner' });

    // a second usable Owner exists now: the same behaviour locks the first one
    const second = await addMember(t, tenant.owner, [{ role_key: 'company_owner' }]);
    for (let i = 0; i < 5; i += 1) await tenant.owner.get('/v1/tenants');
    expect(await lockState(tenant.ownerCard.id)).toEqual({ locked: true, reason: 'anomaly' });
    // ... and now the SECOND is the last usable one: it is not locked
    for (let i = 0; i < 5; i += 1) expect((await second.client.get('/v1/tenants')).status).toBe(403);
    expect(await lockState(second.card.id)).toEqual({ locked: false, reason: null });
    // (Owners do not manage each other: a locked Owner card is recovered by the platform operator, as after wrong codes.)
  });
});

describe('anomaly lock: sign-in from a second network address (off unless switched on)', () => {
  it('with the rule on, a successful sign-in from another address while a session is in use locks the card; the same address does not', async () => {
    const tenant = await createTenant(t, 'address');
    const member = await addMember(t, tenant.owner, [{ role_key: 'successor' }]);          // signed in from 127.0.0.1
    // rule off (the default): a second address is fine
    const elsewhere = await tryLogin(t, member.card.number, member.card.sc, { passkey: member.passkey }, '203.0.113.9');
    expect(elsewhere.res.status).toBe(200);
    expect(await lockState(member.card.id)).toEqual({ locked: false, reason: null });

    expect((await tenant.owner.patch('/v1/tenants/current/anomaly-settings', { enabled: true, second_address_enabled: true, second_address_window_minutes: 10 })).status).toBe(200);
    // the same address again: no anomaly
    expect((await tryLogin(t, member.card.number, member.card.sc, { passkey: member.passkey }, '203.0.113.9')).res.status).toBe(200);
    expect(await lockState(member.card.id)).toEqual({ locked: false, reason: null });
    // a third address while the others were just used: the sign-in fails like any failed sign-in, and the card is locked
    const third = await tryLogin(t, member.card.number, member.card.sc, { passkey: member.passkey }, '198.51.100.7');
    expect(third.res.status).toBe(401);
    expect(await lockState(member.card.id)).toEqual({ locked: true, reason: 'anomaly' });
    expect((await member.client.get('/v1/auth/session')).status).toBe(401);
    const events = await eventsOf(member.card.id, 'anomaly_locked');
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata.rule).toBe('second_address');
    // no address is written to the audit details or the usage-history metadata
    const audit = await su.query(`SELECT details FROM audit_log WHERE resource_id = $1 AND action = 'card:lock'`, [member.card.id]);
    expect(JSON.stringify(audit.rows) + JSON.stringify(events)).not.toMatch(/198\.51|203\.0|127\.0/);
  });

  it('a wrong secret code from another address does not trigger the rule (only successful sign-ins are looked at)', async () => {
    const tenant = await createTenant(t, 'address2');
    expect((await tenant.owner.patch('/v1/tenants/current/anomaly-settings', { enabled: true, second_address_enabled: true, second_address_window_minutes: 10 })).status).toBe(200);
    const member = await addMember(t, tenant.owner, [{ role_key: 'successor' }]);
    const wrong = String((Number(member.card.sc) + 1) % 1000).padStart(3, '0');
    expect((await tryLogin(t, member.card.number, wrong, { passkey: member.passkey }, '198.51.100.7')).res.status).toBe(401);
    expect(await lockState(member.card.id)).toEqual({ locked: false, reason: null });
    expect((await member.client.get('/v1/auth/session')).status).toBe(200);
  });
});

describe('retirement radar', () => {
  let tenant: TestTenant;
  let expert: TestMember;
  let learner: TestMember;
  beforeAll(async () => {
    tenant = await createTenant(t, 'radar');
    expert = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    learner = await addMember(t, tenant.owner, [{ role_key: 'successor' }]);
  });
  const nudges = async (personId: string): Promise<number[]> =>
    (await su.query('SELECT stage FROM retirement_nudges WHERE person_id = $1 ORDER BY stage', [personId])).rows.map((r) => r.stage as number);

  it('a manager records a leaving date; the person reads their own; nobody else reads it; the date itself is not in the audit log', async () => {
    const empty = await tenant.owner.get(`/v1/people/${expert.personId}/leaving-date`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ person_id: expert.personId, leaving_on: null, months_left: null, stage: null, updated_at: null });

    const date = inMonths(8);
    const set = await tenant.owner.put(`/v1/people/${expert.personId}/leaving-date`, { leaving_on: date });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ person_id: expert.personId, leaving_on: date, stage: 12 });
    expect(await nudges(expert.personId)).toEqual([12]);                        // one nudge: the stage the date is in now

    expect((await expert.client.get(`/v1/people/${expert.personId}/leaving-date`)).body.leaving_on).toBe(date);   // own
    expect((await learner.client.get(`/v1/people/${expert.personId}/leaving-date`)).status).toBe(403);            // a colleague
    expect((await expert.client.put(`/v1/people/${expert.personId}/leaving-date`, { leaving_on: date })).status).toBe(403);   // not one's own, not without the right
    expect((await learner.client.del(`/v1/people/${expert.personId}/leaving-date`)).status).toBe(403);
    // the people list and the person record do not carry the date
    const person = await tenant.owner.get(`/v1/people/${expert.personId}`);
    expect(JSON.stringify(person.body)).not.toContain(date);
    expect(JSON.stringify((await tenant.owner.get('/v1/people?limit=100')).body)).not.toContain(date);
    const audit = await su.query(`SELECT reason_code, details FROM audit_log WHERE tenant_id = $1 AND resource_id = $2 AND action LIKE 'person:%' AND decision = 'event'`,
      [tenant.tenantId, expert.personId]);
    expect(audit.rows.map((r) => r.reason_code)).toEqual(expect.arrayContaining(['LEAVING_DATE_SET', 'RETIREMENT_NUDGE']));
    expect(JSON.stringify(audit.rows)).not.toContain(date);
  });

  it('refuses a date in the past, an impossible day and a date absurdly far ahead; an unknown person is not found', async () => {
    const put = (leaving_on: string) => tenant.owner.put(`/v1/people/${expert.personId}/leaving-date`, { leaving_on });
    expect((await put(iso(new Date(t.clock.now().getTime() - 2 * 86_400_000)))).status).toBe(422);
    expect((await put('2031-02-30')).status).toBeGreaterThanOrEqual(400);
    expect((await put('2031-02-30')).status).toBeLessThan(500);
    expect((await put('2199-01-01')).status).toBe(422);
    expect((await put('soon')).status).toBe(400);
    expect((await tenant.owner.put(`/v1/people/${randomUUID()}/leaving-date`, { leaving_on: inMonths(8) })).status).toBe(404);
  });

  it('the radar lists who leaves within 24 months, soonest first; a card that may read only itself sees only itself', async () => {
    const far = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    expect((await tenant.owner.put(`/v1/people/${far.personId}/leaving-date`, { leaving_on: inMonths(40) })).status).toBe(200);   // outside the radar
    expect((await tenant.owner.put(`/v1/people/${learner.personId}/leaving-date`, { leaving_on: inMonths(3) })).status).toBe(200);
    const radar = await tenant.owner.get('/v1/retirement-radar');
    expect(radar.status).toBe(200);
    expect(radar.body.next_cursor).toBeNull();
    expect(radar.body.items.map((e: any) => e.person_id)).toEqual([learner.personId, expert.personId]);
    // the Owner may read knowledge, interviews and who holds which job role: numbers, not null
    expect(radar.body.items[0]).toMatchObject({ stage: 6, verified_items: 0, interviews_completed: 0, job_roles: [] });
    // one page at a time, in the same order
    const page1 = await tenant.owner.get('/v1/retirement-radar?limit=1');
    expect(page1.body.items.map((e: any) => e.person_id)).toEqual([learner.personId]);
    expect(typeof page1.body.next_cursor).toBe('string');
    const page2 = await tenant.owner.get(`/v1/retirement-radar?limit=1&cursor=${page1.body.next_cursor}`);
    expect(page2.body.items.map((e: any) => e.person_id)).toEqual([expert.personId]);
    expect(page2.body.next_cursor).toBeNull();
    expect((await tenant.owner.get('/v1/retirement-radar?cursor=bm90LWEtY3Vyc29y')).status).toBe(400);
    expect(radar.body.items[1]).toMatchObject({ stage: 12 });
    expect(await nudges(far.personId)).toEqual([]);

    const own = await expert.client.get('/v1/retirement-radar');
    expect(own.status).toBe(200);
    expect(own.body.items.map((e: any) => e.person_id)).toEqual([expert.personId]);
    // an Expert may not read who holds which job role: it is told nothing, not "none"
    expect(own.body.items[0].job_roles).toBeNull();
    const none = await far.client.get('/v1/retirement-radar');
    expect(none.body.items).toEqual([]);
  });

  it('a changed date starts its nudges again; time passing brings the next stage once; removing the date removes them', async () => {
    // the housekeeping command (npm run housekeeping) does this for every company
    const { sweepRetirementNudges } = await import('../../src/cli/housekeeping.ts');
    const sweep = (at: Date) => sweepRetirementNudges(t.app, at);
    expect((await tenant.owner.put(`/v1/people/${expert.personId}/leaving-date`, { leaving_on: inMonths(20) })).status).toBe(200);
    expect(await nudges(expert.personId)).toEqual([24]);
    expect(await sweep(t.clock.now())).toBe(0);                                 // nothing new: each nudge is created once
    // the job runs nine months later (the test clock itself is not moved: cards would expire): about eleven months left
    const later = new Date(t.clock.now().getTime() + 9 * 30.44 * 86_400_000);
    expect(await sweep(later)).toBeGreaterThanOrEqual(1);
    expect(await nudges(expert.personId)).toEqual([12, 24]);
    expect(await sweep(later)).toBe(0);
    expect((await tenant.owner.del(`/v1/people/${expert.personId}/leaving-date`)).status).toBe(204);
    expect(await nudges(expert.personId)).toEqual([]);
    expect((await tenant.owner.get(`/v1/people/${expert.personId}/leaving-date`)).body.leaving_on).toBeNull();
    expect((await tenant.owner.del(`/v1/people/${expert.personId}/leaving-date`)).status).toBe(204);   // nothing to remove: still fine
  });

  it('another company never sees the date or the radar entry', async () => {
    const other = await createTenant(t, 'radar-other');
    expect((await other.owner.get(`/v1/people/${learner.personId}/leaving-date`)).status).toBe(404);
    expect((await other.owner.get('/v1/retirement-radar')).body.items).toEqual([]);
  });
});

describe('department templates', () => {
  let tenant: TestTenant;
  beforeAll(async () => {
    tenant = await createTenant(t, 'templates');
  });

  it('lists the built-in templates to who may manage topics, and to nobody else', async () => {
    const list = await tenant.owner.get('/v1/topic-templates');
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThanOrEqual(6);
    expect(list.body.items.map((x: any) => x.key)).toContain('maintenance');
    const learner = await addMember(t, tenant.owner, [{ role_key: 'successor' }]);
    expect((await learner.client.get('/v1/topic-templates')).status).toBe(403);
    expect((await learner.client.post('/v1/topic-templates/maintenance/apply')).status).toBe(403);
  });

  it('applying adds topics and job-role maps through the usual path; applying again adds nothing; nothing existing is changed', async () => {
    // a topic of the same name exists already, with the company's own description
    const mine = await tenant.owner.post('/v1/topics', { name: 'lubrication', description: 'Our own wording.' });
    expect(mine.status).toBe(201);
    stub.reset();
    const first = await tenant.owner.post('/v1/topic-templates/maintenance/apply');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ template_key: 'maintenance', topics_created: 5, topics_existing: 1, topics_skipped: 0, links_created: 9, links_existing: 0 });
    expect(first.body.created_topic_ids).toHaveLength(5);
    expect(first.body.created_topic_ids).not.toContain(mine.body.id);
    expect(stub.ofAction('topic.embed')).toHaveLength(5);                       // each new topic got its search vector, as with createTopic
    const topics = await tenant.owner.get('/v1/topics?limit=50');
    const kept = topics.body.items.find((x: any) => x.id === mine.body.id);
    expect(kept).toMatchObject({ name: 'lubrication', description: 'Our own wording.' });
    expect(topics.body.items).toHaveLength(6);
    const technician = await tenant.owner.get(`/v1/job-roles/${encodeURIComponent('Maintenance technician')}/topics`);
    expect(technician.body.topics).toHaveLength(6);
    expect(technician.body.topics.map((x: any) => x.topic_id)).toContain(mine.body.id);

    // the company changes a map entry; applying again must not put it back
    const changed = technician.body.topics.map((x: any) => (x.topic_id === mine.body.id ? { ...x, importance: 1, required: false } : x));
    expect((await tenant.owner.put(`/v1/job-roles/${encodeURIComponent('Maintenance technician')}/topics`, { topics: changed })).status).toBe(200);
    stub.reset();
    const again = await tenant.owner.post('/v1/topic-templates/maintenance/apply');
    expect(again.body).toEqual({
      template_key: 'maintenance', topics_created: 0, created_topic_ids: [], topics_existing: 6, topics_skipped: 0, links_created: 0, links_existing: 9,
    });
    expect(stub.ofAction('topic.embed')).toHaveLength(0);
    const after = await tenant.owner.get(`/v1/job-roles/${encodeURIComponent('Maintenance technician')}/topics`);
    expect(after.body.topics.find((x: any) => x.topic_id === mine.body.id)).toMatchObject({ importance: 1, required: false });
    const audit = await su.query(`SELECT details FROM audit_log WHERE tenant_id = $1 AND reason_code = 'TOPIC_TEMPLATE_APPLIED' ORDER BY seq`, [tenant.tenantId]);
    expect(audit.rows.map((r) => JSON.parse(r.details))).toEqual([{ count: 5, template_key: 'maintenance' }, { count: 0, template_key: 'maintenance' }]);
  });

  it('a retired topic of the same name is not revived and not linked; an unknown template is not found', async () => {
    const other = await createTenant(t, 'templates2');
    const old = await other.owner.post('/v1/topics', { name: 'Sampling plans' });
    expect((await other.owner.patch(`/v1/topics/${old.body.id}`, { status: 'retired' })).status).toBe(200);
    const res = await other.owner.post('/v1/topic-templates/quality-lab/apply');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ topics_created: 5, topics_existing: 0, topics_skipped: 1 });
    const still = await other.owner.get('/v1/topics?status=retired');
    expect(still.body.items.map((x: any) => x.id)).toEqual([old.body.id]);
    expect((await other.owner.post('/v1/topic-templates/no-such-template/apply')).status).toBe(404);
    expect((await other.owner.post('/v1/topic-templates/NOT%20A%20KEY/apply')).status).toBe(400);
  });
});

describe('anomaly lock: what does NOT count, and what must not break', () => {
  let tenant: TestTenant;
  beforeAll(async () => {
    tenant = await createTenant(t, 'anomaly-not');
    expect((await tenant.owner.patch('/v1/tenants/current/anomaly-settings', { enabled: true, denials_threshold: 5 })).status).toBe(200);
  });
  const counter = async (cardId: string): Promise<number | null> =>
    (await su.query('SELECT denials FROM card_anomaly_counters WHERE card_id = $1', [cardId])).rows[0]?.denials ?? null;

  it('a card outside its working hours can ask fifty times: refused each time, never locked, nothing counted', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    const hourUtc = t.clock.now().getUTCHours();
    const pad = (n: number): string => String(((n % 24) + 24) % 24).padStart(2, '0');
    expect((await tenant.owner.put(`/v1/cards/${m.card.id}/restrictions`, {
      restrictions: [{ type: 'time_window', enabled: true, config: { timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6], start: `${pad(hourUtc + 2)}:00`, end: `${pad(hourUtc + 3)}:00` } }],
    })).status).toBe(200);
    for (let i = 0; i < 50; i += 1) expect((await m.client.get('/v1/roles')).status).toBe(403);
    expect(await lockState(m.card.id)).toEqual({ locked: false, reason: null });
    expect(await counter(m.card.id)).toBeNull();
    expect((await m.client.get('/v1/auth/session')).status).toBe(200);
  });

  it('a request a page of another address made the browser send is refused before the policy and counts nothing; forging that mark blocks the forger', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'successor' }]);
    const reasons = async (): Promise<string[]> => (await su.query(
      `SELECT reason_code FROM audit_log WHERE tenant_id = $1 AND actor_card_id = $2 AND decision = 'deny' ORDER BY seq`, [tenant.tenantId, m.card.id],
    )).rows.map((r: { reason_code: string }) => r.reason_code);
    const get = (url: string, headers: Record<string, string>) => m.client.request('GET', url, undefined, { headers });

    for (const site of ['same-site', 'cross-site']) {
      // something the card may NOT read: refused, but by the HTTP layer, so nothing is counted against the card
      for (let i = 0; i < 6; i += 1) expect((await get('/v1/audit/events', { 'sec-fetch-site': site })).status, site).toBe(403);
      // something the card MAY read: refused all the same - a forged mark gains a thief nothing
      const refused = await get('/v1/auth/session', { 'sec-fetch-site': site });
      expect(refused.status, site).toBe(403);
      expect(refused.body.card_id, 'the handler did not run').toBeUndefined();
      expect(await lockState(m.card.id), site).toEqual({ locked: false, reason: null });
      expect(await counter(m.card.id), site).toBeNull();
    }
    expect(await reasons()).toEqual(Array.from({ length: 14 }, () => 'DENY_FETCH_SITE'));

    // a separately hosted front end that is allowed names its Origin: it is served as before
    expect((await get('/v1/auth/session', { 'sec-fetch-site': 'same-site', origin: TEST_ORIGIN })).status).toBe(200);
    expect((await get('/v1/auth/session', { 'sec-fetch-site': 'same-site', origin: 'https://evil.legacyai.test' })).status).toBe(403);
    // typed address or bookmark ("none"), our own pages ("same-origin"), and no browser at all: served as before
    for (const headers of [{ 'sec-fetch-site': 'none' }, { 'sec-fetch-site': 'same-origin' }, {}] as Array<Record<string, string>>) {
      expect((await get('/v1/auth/session', headers)).status).toBe(200);
    }
    expect(await counter(m.card.id)).toBeNull();

    // ... and what reaches the policy is counted by its reason alone, whatever the mark says
    expect((await get('/v1/audit/events', { 'sec-fetch-site': 'none' })).status).toBe(403);
    for (let i = 0; i < 3; i += 1) expect((await get('/v1/audit/events', { 'sec-fetch-site': 'same-origin' })).status).toBe(403);
    expect(await counter(m.card.id)).toBe(4);
    expect((await m.client.get('/v1/audit/events')).status).toBe(403);              // no header (a script or a tool): the fifth locks
    expect(await lockState(m.card.id)).toEqual({ locked: true, reason: 'anomaly' });
  });

  it('public addresses are not touched by that rule: health and sign-in answer whatever the mark says', async () => {
    expect((await t.app.http.app.inject({ method: 'GET', url: '/v1/health', headers: { 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(200);
    const begin = await t.app.http.app.inject({
      method: 'POST', url: '/v1/auth/login/begin', headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      payload: { card_number: 'LGY-0000-0000-0000-0000' },
    });
    expect(begin.statusCode).not.toBe(403);                                         // whatever sign-in says to an unknown card - not this refusal
  });

  it('"not found" is not counted (old links are ordinary use)', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    for (let i = 0; i < 8; i += 1) expect((await m.client.get(`/v1/cards/${randomUUID()}`)).status).toBe(404);
    expect(await counter(m.card.id)).toBeNull();
  });

  it('a failure of the counter never costs the refusal: the caller still gets 403 and the refusal is in the audit log', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'successor' }]);
    const denies = async (): Promise<number> => (await su.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND actor_card_id = $2 AND decision = 'deny'`, [tenant.tenantId, m.card.id])).rows[0].n;
    const before = await denies();
    // the counter table is made unusable for a moment: every counting statement fails
    await su.query('ALTER TABLE card_anomaly_counters RENAME TO card_anomaly_counters_away');
    try {
      expect((await m.client.get('/v1/audit/events')).status).toBe(403);
    } finally {
      await su.query('ALTER TABLE card_anomaly_counters_away RENAME TO card_anomaly_counters');
    }
    expect(await denies()).toBe(before + 1);
    expect(t.logs.join('\n')).toContain('the anomaly counter failed');
    // and counting works again afterwards
    expect((await m.client.get('/v1/audit/events')).status).toBe(403);
    expect(await counter(m.card.id)).toBe(1);
  });

  it('every changed setting is in the audit log with its old and its new value', async () => {
    expect((await tenant.owner.patch('/v1/tenants/current/anomaly-settings', { enabled: false, denials_threshold: 7 })).status).toBe(200);
    const rows = await su.query(
      `SELECT details FROM audit_log WHERE tenant_id = $1 AND reason_code = 'ANOMALY_SETTINGS_CHANGED' ORDER BY seq DESC LIMIT 2`, [tenant.tenantId]);
    expect(rows.rows.map((r) => JSON.parse(r.details)).sort((a, b) => a.changed.localeCompare(b.changed))).toEqual([
      { changed: 'denials_threshold', state_from: '5', state_to: '7' },
      { changed: 'enabled', state_from: 'true', state_to: 'false' },
    ]);
  });
});

describe('one definition of "another usable Owner card"', () => {
  it('an Owner card that is locked does not count as another usable Owner', async () => {
    const { otherUsableOwners } = await import('../../src/modules/identity-access/internal/cards.ts');
    const tenant = await createTenant(t, 'usable-owner');
    const second = await addMember(t, tenant.owner, [{ role_key: 'company_owner' }]);
    const others = (): Promise<number> => t.app.db.withTenantTx(tenant.tenantId, (tx) => otherUsableOwners(tx, tenant.tenantId, tenant.ownerCard.id, t.clock.now()));
    expect(await others()).toBe(1);
    await su.query(`UPDATE card_auth_state SET locked_at = now(), lock_reason = 'anomaly' WHERE card_id = $1`, [second.card.id]);
    expect(await others()).toBe(0);
  });
});

describe('retirement radar: the date goes with the person', () => {
  it('marking a person as departed removes the leaving date; a date more than 30 days past is removed by the housekeeping command', async () => {
    const tenant = await createTenant(t, 'radar-gone');
    const a = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    const b = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    const has = async (personId: string): Promise<boolean> => (await su.query('SELECT 1 FROM person_leaving WHERE person_id = $1', [personId])).rows.length === 1;
    for (const m of [a, b]) expect((await tenant.owner.put(`/v1/people/${m.personId}/leaving-date`, { leaving_on: inMonths(2) })).status).toBe(200);
    expect((await tenant.owner.patch(`/v1/people/${a.personId}`, { status: 'departed' })).status).toBe(200);
    expect(await has(a.personId)).toBe(false);
    expect(await has(b.personId)).toBe(true);
    const { sweepRetirementNudges } = await import('../../src/cli/housekeeping.ts');
    await sweepRetirementNudges(t.app, new Date(t.clock.now().getTime() + 80 * 86_400_000));    // about 20 days after the date: kept
    expect(await has(b.personId)).toBe(true);
    await sweepRetirementNudges(t.app, new Date(t.clock.now().getTime() + 120 * 86_400_000));   // about 60 days after: removed
    expect(await has(b.personId)).toBe(false);
  });
});
