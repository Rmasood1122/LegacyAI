// E-mail of notices (docs/phase4/06, part C): against the real server and database, with the stand-in sender that
// sends nothing and keeps what it was given. Synthetic companies and example.test addresses only.
// The pure rules (texts, recipients, addresses, retries) are in test/unit/mail.test.ts.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeMailSender, SETTLE_MS } from '../../src/modules/mail/index.ts';
import { createTenant, startApp, superuser, type TestApp, type TestTenant } from '../helpers/harness.ts';

const sender = new FakeMailSender();
let t: TestApp;
let off: TestApp;
let su: pg.Client;

beforeAll(async () => {
  t = await startApp({ mailSender: sender });
  off = await startApp();   // MAIL_SENDER unset
  su = await superuser();
});
afterAll(async () => {
  await su.end();
  await t.close();
  await off.close();
});

/** Gives the company's Owner an e-mail address (createTenant makes the Owner without one). */
async function ownerAddress(tn: TestTenant, email: string): Promise<string> {
  const { rows } = await su.query('SELECT person_id FROM cards WHERE id = $1', [tn.ownerCard.id]);
  await su.query('UPDATE people SET email = $1 WHERE id = $2', [email, rows[0].person_id]);
  return rows[0].person_id as string;
}

async function person(tn: TestTenant, email: string | null): Promise<{ personId: string; cardId: string }> {
  const p = await tn.owner.post('/v1/people', { display_name: 'Synthetic Person', department_id: null, ...(email === null ? {} : { email }) });
  if (p.status !== 201) throw new Error(`create person failed: ${p.status} ${p.raw}`);
  const c = await tn.owner.post('/v1/cards', { person_id: p.body.id, roles: [{ role_key: 'expert' }] });
  if (c.status !== 201) throw new Error(`issue card failed: ${c.status} ${c.raw}`);
  return { personId: p.body.id, cardId: c.body.card?.id ?? c.body.id };
}

const mailTo = (address: string): typeof sender.sent => sender.sent.filter((m) => m.to === address);
/** A run as it happens a little later: a notice is worked out only once it has settled (SETTLE_MS). */
const settled = (ms = 0): Date => new Date(Date.now() + SETTLE_MS + 1_000 + ms);
const deliver = (tenantId: string, at: Date = settled()) => t.app.mail.runCompany(tenantId, () => at);

describe('notices by e-mail', () => {
  let tenant: TestTenant;
  beforeAll(async () => {
    tenant = await createTenant(t, 'mail');
    await ownerAddress(tenant, 'owner.mail@example.test');
  });

  it('a card issued to a person reaches that person, in the fixed wording, from the configured sender', async () => {
    await person(tenant, 'new.holder@example.test');
    const result = await deliver(tenant.tenantId);
    expect(result.sent).toBeGreaterThanOrEqual(1);
    const [mail] = mailTo('new.holder@example.test');
    expect(mail).toMatchObject({ subject: 'A LegacyAI card was issued to you', from: 'LegacyAI <no-reply@localhost>' });
    expect(mail?.text).not.toMatch(/\d/);   // no card number, no code
    // a second run sends nothing more
    const before = sender.sent.length;
    await deliver(tenant.tenantId);
    expect(sender.sent.length).toBe(before);
  });

  it('a company notice reaches the Owners: an API key made, a renewal reminder (feature 33), a retirement nudge (feature 11)', async () => {
    const key = await tenant.owner.post('/v1/api-keys', { name: 'Mail test', scope: ['topic:read'], max_sensitivity: 0, expires_in_days: 30 });
    expect(key.status).toBe(201);
    await t.app.mail.notifier.notify({ type: 'renewal_reminder', tenantId: tenant.tenantId });
    await t.app.mail.notifier.notify({ type: 'retirement_nudge', tenantId: tenant.tenantId });
    await deliver(tenant.tenantId);
    const subjects = mailTo('owner.mail@example.test').map((m) => m.subject);
    expect(subjects).toEqual(expect.arrayContaining([
      'A LegacyAI API key was made', 'Your LegacyAI renewal date is coming closer', 'Someone\'s leaving date is coming closer',
    ]));
    expect(sender.sent.map((m) => m.text).join('\n')).not.toContain(key.body.api_key);
  });

  it('nobody\'s address is copied into the queue; a person without an address is recorded as such', async () => {
    const none = await person(tenant, null);
    await deliver(tenant.tenantId);
    const rows = await su.query(
      `SELECT to_jsonb(m)::text AS m FROM mail_messages m WHERE tenant_id = $1 UNION ALL SELECT to_jsonb(n)::text FROM mail_notices n WHERE tenant_id = $1`,
      [tenant.tenantId]);
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const r of rows.rows) expect(r.m).not.toContain('@');
    const status = await su.query('SELECT status FROM mail_messages WHERE tenant_id = $1 AND person_id = $2', [tenant.tenantId, none.personId]);
    expect(status.rows.map((r) => r.status)).toEqual(['no_address']);
  });

  it('a service that is unavailable is tried again later; an address the service refuses is not', async () => {
    const own = await createTenant(t, 'mail-retry');
    await ownerAddress(own, 'owner.retry@example.test');
    await deliver(own.tenantId);                 // the notices of setting the company up go first
    const sentBefore = mailTo('owner.retry@example.test').length;
    const ofType = async (type: string) => (await su.query(
      `SELECT m.status, m.attempts, m.next_attempt_at, m.last_error FROM mail_messages m JOIN mail_notices n ON n.tenant_id = m.tenant_id AND n.id = m.notice_id
        WHERE m.tenant_id = $1 AND n.type = $2`, [own.tenantId, type])).rows;

    await t.app.mail.notifier.notify({ type: 'payment_failed', tenantId: own.tenantId });
    sender.failNext('unavailable');
    const now = settled(60_000);
    await deliver(own.tenantId, now);
    const [row] = await ofType('payment_failed');
    expect(row).toMatchObject({ status: 'pending', attempts: 1, last_error: 'unavailable' });
    expect((row.next_attempt_at as Date).getTime() - now.getTime()).toBe(5 * 60_000);
    expect(mailTo('owner.retry@example.test').length).toBe(sentBefore);
    await deliver(own.tenantId, new Date(now.getTime() + 6 * 60_000));
    expect(mailTo('owner.retry@example.test').slice(sentBefore).map((m) => m.subject)).toEqual(['A LegacyAI payment did not go through']);

    await t.app.mail.notifier.notify({ type: 'subscription_renewed', tenantId: own.tenantId });
    sender.failNext('rejected');
    await deliver(own.tenantId, new Date(now.getTime() + 7 * 60_000));
    await deliver(own.tenantId, new Date(now.getTime() + 2 * 86_400_000));
    expect((await ofType('subscription_renewed')).map((r) => ({ status: r.status, attempts: r.attempts }))).toEqual([{ status: 'failed', attempts: 1 }]);
  });

  it('a notice is worked out only once it has settled (the request that raised it has committed by then)', async () => {
    const own = await createTenant(t, 'mail-settle');
    await ownerAddress(own, 'owner.settle@example.test');
    await t.app.mail.notifier.notify({ type: 'renewal_reminder', tenantId: own.tenantId });
    expect((await t.app.mail.runCompany(own.tenantId, () => new Date())).notices).toBe(0);
    expect((await deliver(own.tenantId)).notices).toBeGreaterThan(0);
  });

  it('people who have left are not written to', async () => {
    const own = await createTenant(t, 'mail-left');
    await ownerAddress(own, 'owner.left@example.test');
    const leaver = await person(own, 'leaver@example.test');
    await deliver(own.tenantId);
    const before = mailTo('leaver@example.test').length;
    expect(before).toBeGreaterThanOrEqual(1);   // the card they were issued
    await su.query("UPDATE people SET status = 'departed' WHERE id = $1", [leaver.personId]);
    await t.app.mail.notifier.notify({ type: 'card_revoked', tenantId: own.tenantId, cardId: leaver.cardId });
    await deliver(own.tenantId);
    expect(mailTo('leaver@example.test').length).toBe(before);
  });

  it('housekeeping removes old notices and sent messages', async () => {
    const own = await createTenant(t, 'mail-purge');
    await ownerAddress(own, 'owner.purge@example.test');
    await t.app.mail.notifier.notify({ type: 'renewal_reminder', tenantId: own.tenantId });
    await deliver(own.tenantId);
    const removed = await t.app.db.withTenantTx(own.tenantId, (tx) => t.app.mail.purge(tx, own.tenantId, new Date(Date.now() + 120_000)));
    expect(removed).toBeGreaterThanOrEqual(2);
    const left = await su.query('SELECT count(*)::int AS n FROM mail_notices WHERE tenant_id = $1', [own.tenantId]);
    expect(left.rows[0].n).toBe(0);
  });
});

describe('with MAIL_SENDER unset (the default)', () => {
  it('nothing is queued and nothing is sent; notices are logged as before', async () => {
    const quiet = await createTenant(off, 'mail-off');
    await quiet.owner.post('/v1/people', { display_name: 'Synthetic Person', department_id: null, email: 'quiet@example.test' });
    await off.app.mail.notifier.notify({ type: 'renewal_reminder', tenantId: quiet.tenantId });
    await off.app.mail.flush();
    expect(off.app.mail.enabled).toBe(false);
    expect(await off.app.mail.runCompany(quiet.tenantId)).toEqual({ notices: 0, queued: 0, sent: 0, failed: 0, no_address: 0 });
    const rows = await su.query('SELECT count(*)::int AS n FROM mail_notices WHERE tenant_id = $1', [quiet.tenantId]);
    expect(rows.rows[0].n).toBe(0);
    expect(off.logs.join('\n')).toContain('"notification":"renewal_reminder"');
  });
});
