// Card lifecycle through the API and directly against the database trigger; renewal with
// SC rotation (old SC dead immediately, new SC shown once); replacement; offboarding.
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LEGAL_TRANSITIONS, CARD_STATES } from '../../src/modules/identity-access/index.ts';
import {
  addMember, appRoleClient, createTenant, enrollPasskey, fromSecrets, login, startApp, superuser, tryLogin,
  type TestApp, type TestTenant,
} from '../helpers/harness.ts';

let t: TestApp;
let su: pg.Client;
let tenant: TestTenant;

beforeAll(async () => {
  t = await startApp();
  su = await superuser();
  tenant = await createTenant(t, 'lifecycle');
});
afterAll(async () => {
  await su.end();
  await t.close();
});

afterEach(() => t.clock.reset());

const stateOf = async (cardId: string): Promise<string> => (await su.query('SELECT state FROM cards WHERE id = $1', [cardId])).rows[0].state;
const events = async (cardId: string): Promise<string[]> =>
  (await su.query('SELECT event_type FROM card_events WHERE card_id = $1 ORDER BY id', [cardId])).rows.map((r) => r.event_type);

describe('the database trigger enforces the same state machine as the code', () => {
  it('all 36 from/to pairs, attempted directly in SQL as the app role', async () => {
    const legal = new Set(LEGAL_TRANSITIONS.map(([f, to]) => `${f}>${to}`));
    const app = await appRoleClient();
    let checked = 0;
    try {
      const person = await tenant.owner.post('/v1/people', { display_name: 'Trigger Probe' });
      const issued = await tenant.owner.post('/v1/cards', { person_id: person.body.id, roles: [{ role_key: 'expert' }] });
      const cardId = issued.body.card.id;
      for (const from of CARD_STATES) {
        for (const to of CARD_STATES) {
          if (from === to) { checked += 1; continue; }
          // Put the card into `from` as superuser (trigger off), then try from -> to as the app role.
          await su.query('ALTER TABLE cards DISABLE TRIGGER cards_lifecycle');
          await su.query('UPDATE cards SET state = $2 WHERE id = $1', [cardId, from]);
          await su.query('ALTER TABLE cards ENABLE TRIGGER cards_lifecycle');
          await app.query('BEGIN');
          await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.tenantId]);
          const attempt = app.query('UPDATE cards SET state = $2 WHERE id = $1', [cardId, to]);
          if (legal.has(`${from}>${to}`)) {
            await expect(attempt, `${from} -> ${to} should be legal`).resolves.toMatchObject({ rowCount: 1 });
          } else {
            await expect(attempt, `${from} -> ${to} should be illegal`).rejects.toThrow(/illegal card state transition/);
          }
          await app.query('ROLLBACK');
          checked += 1;
        }
      }
      // tidy: leave the probe card revoked
      await su.query('ALTER TABLE cards DISABLE TRIGGER cards_lifecycle');
      await su.query(`UPDATE cards SET state = 'revoked' WHERE id = $1`, [cardId]);
      await su.query('ALTER TABLE cards ENABLE TRIGGER cards_lifecycle');
    } finally {
      await app.end();
    }
    expect(checked).toBe(36);
  });

  it('a card cannot be inserted in any state but "issued", and its number, kind and tenant cannot change', async () => {
    const app = await appRoleClient();
    try {
      const inTx = async (sql: string, params: unknown[]): Promise<unknown> => {
        await app.query('BEGIN');
        await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.tenantId]);
        try {
          return await app.query(sql, params);
        } finally {
          await app.query('ROLLBACK');
        }
      };
      await expect(inTx(
        `INSERT INTO cards (tenant_id, kind, card_number, state, expires_at, grace_until, renewal_due)
         VALUES ($1, 'company', '1234567890123456', 'active', now(), now(), now())`, [tenant.tenantId])).rejects.toThrow(/must be inserted in state issued/);
      await expect(inTx(`UPDATE cards SET card_number = '0000000000000000' WHERE id = $1`, [tenant.ownerCard.id])).rejects.toThrow(/immutable/);
      await expect(inTx(`UPDATE cards SET kind = 'company', person_id = NULL WHERE id = $1`, [tenant.ownerCard.id])).rejects.toThrow();
      await expect(inTx(`UPDATE cards SET state = 'banana' WHERE id = $1`, [tenant.ownerCard.id])).rejects.toBeTruthy();
      // a card cannot be handed to a different person, and its id cannot change
      const other = await tenant.owner.post('/v1/people', { display_name: 'Card Thief' });
      await expect(inTx('UPDATE cards SET person_id = $2 WHERE id = $1', [tenant.ownerCard.id, other.body.id])).rejects.toThrow(/immutable/);
      await expect(inTx('UPDATE cards SET id = uuidv7() WHERE id = $1', [tenant.ownerCard.id])).rejects.toThrow(/immutable/);
    } finally {
      await app.end();
    }
  });
});

describe('lifecycle through the API', () => {
  it('issue -> activate -> suspend -> reinstate -> suspend -> revoke, with history; then nothing more is possible', async () => {
    const person = await tenant.owner.post('/v1/people', { display_name: 'Lifecycle Walk' });
    const issued = await tenant.owner.post('/v1/cards', { person_id: person.body.id, roles: [{ role_key: 'expert' }] });
    const card = fromSecrets(issued.body);
    expect(issued.body.card.state).toBe('issued');
    expect((await tenant.owner.post(`/v1/cards/${card.id}/suspend`, { reason: 'too early' })).status).toBe(409); // issued -> suspended is illegal

    await enrollPasskey(t, card);
    expect(await stateOf(card.id)).toBe('active');

    expect((await tenant.owner.post(`/v1/cards/${card.id}/suspend`, { reason: 'review' })).body.state).toBe('suspended');
    expect((await tenant.owner.post(`/v1/cards/${card.id}/suspend`, { reason: 'again' })).status).toBe(409);
    expect((await tenant.owner.post(`/v1/cards/${card.id}/renew`, {})).status).toBe(409); // cannot renew a suspended card
    expect((await tenant.owner.post(`/v1/cards/${card.id}/reinstate`)).body.state).toBe('active');
    expect((await tenant.owner.post(`/v1/cards/${card.id}/reinstate`)).status).toBe(409);
    expect((await tenant.owner.post(`/v1/cards/${card.id}/suspend`, { reason: 'second' })).body.state).toBe('suspended');
    expect((await tenant.owner.post(`/v1/cards/${card.id}/revoke`, { reason: 'gone' })).body.state).toBe('revoked');

    for (const [verb, body] of [['suspend', { reason: 'x' }], ['reinstate', undefined], ['revoke', { reason: 'x' }], ['renew', {}], ['replace', { reason: 'lost' }]] as const) {
      const res = await tenant.owner.post(`/v1/cards/${card.id}/${verb}`, body);
      expect(res.status, `${verb} on a revoked card`).toBe(409);
      expect(res.body.type).toBe('urn:legacyai:problem:illegal-transition');
    }
    expect(await stateOf(card.id)).toBe('revoked');
    expect(await events(card.id)).toEqual(['issued', 'credential_added', 'activated', 'suspended', 'reinstated', 'suspended', 'revoked']);

    const history = await tenant.owner.get(`/v1/cards/${card.id}/events?limit=3`);
    expect(history.body.items.map((e: any) => e.event_type)).toEqual(['revoked', 'suspended', 'reinstated']);
    expect(history.body.next_cursor).toBeTruthy();
    const older = await tenant.owner.get(`/v1/cards/${card.id}/events?limit=10&cursor=${history.body.next_cursor}`);
    expect(older.body.items.map((e: any) => e.event_type)).toEqual(['suspended', 'activated', 'credential_added', 'issued']);
    // a person whose card was revoked can be issued a new one
    expect((await tenant.owner.post('/v1/cards', { person_id: person.body.id, roles: [{ role_key: 'expert' }] })).status).toBe(201);
  });

  it('one live card per person; unknown person -> 404; disabled role -> 422', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    expect((await tenant.owner.post('/v1/cards', { person_id: m.personId, roles: [{ role_key: 'expert' }] })).status).toBe(409);
    expect((await tenant.owner.post('/v1/cards', { person_id: '11111111-1111-4111-8111-111111111111', roles: [{ role_key: 'expert' }] })).status).toBe(404);
    const p = await tenant.owner.post('/v1/people', { display_name: 'Role Check' });
    expect((await tenant.owner.post('/v1/cards', { person_id: p.body.id, roles: [{ role_key: 'auditor' }] })).status).toBe(422);
    expect((await tenant.owner.post('/v1/cards', { person_id: p.body.id, roles: [] })).status).toBe(400);
  });

  it('usage history shows what happened, when, and from which device - but no addresses or secrets', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    const own = await m.client.get(`/v1/cards/${m.card.id}/events`);
    expect(own.status).toBe(200);
    const loginEvent = own.body.items.find((e: any) => e.event_type === 'login_success');
    expect(loginEvent.credential_id).toBeTruthy();
    expect(loginEvent.device).toMatch(/^[0-9a-f]{12}$/);
    expect(loginEvent.metadata).toEqual({ factor_type: 'passkey' });
    expect(JSON.stringify(own.body)).not.toContain('127.0.0.1');
    // an Expert cannot read somebody else's history
    expect((await m.client.get(`/v1/cards/${tenant.ownerCard.id}/events`)).status).toBe(403);
  });
});

describe('renewal rotates the SC (feature 1 / "34")', () => {
  it('old SC is invalid immediately, new SC is shown once, dates move, sessions end', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    const before = (await tenant.owner.get(`/v1/cards/${m.card.id}`)).body;
    t.clock.advance(3 * 86_400_000);
    const owner = await login(t, tenant.ownerCard, { passkey: tenant.ownerPasskey }); // 3 days later the earlier sessions have timed out

    const key = 'renew-key-0001';
    const renewed = await owner.post(`/v1/cards/${m.card.id}/renew`, {}, key);
    expect(renewed.status).toBe(200);
    expect(renewed.body.sc).toMatch(/^\d{3}$/);
    expect(renewed.body.secret_already_shown).toBe(false);
    expect(renewed.body.enrollment_token).toBeUndefined();
    expect(renewed.body.card.renewal_count).toBe(1);
    // the new expiry is 90 days from the (moved) clock: 3 days later than before, give or take the seconds between the two calls
    const moved = new Date(renewed.body.card.expires_at).getTime() - new Date(before.expires_at).getTime();
    expect(moved).toBeGreaterThanOrEqual(3 * 86_400_000);
    expect(moved).toBeLessThan(3 * 86_400_000 + 60_000);
    expect(new Date(renewed.body.card.grace_until).getTime() - new Date(renewed.body.card.expires_at).getTime()).toBe(14 * 86_400_000);
    expect(new Date(renewed.body.card.expires_at).getTime() - new Date(renewed.body.card.renewal_due).getTime()).toBe(14 * 86_400_000);

    // the session that existed before renewal is gone
    expect((await m.client.get('/v1/auth/session')).status).toBe(401);

    // exactly one usable hash; the old one is destroyed, not just flagged
    const secrets = await su.query('SELECT status, sc_hash IS NULL AS destroyed FROM card_secrets WHERE card_id = $1 ORDER BY id', [m.card.id]);
    expect(secrets.rows).toEqual([{ status: 'retired', destroyed: true }, { status: 'current', destroyed: false }]);

    if (renewed.body.sc !== m.card.sc) {
      expect((await tryLogin(t, m.card.number, m.card.sc, { passkey: m.passkey })).res.status).toBe(401);
    }
    expect((await tryLogin(t, m.card.number, renewed.body.sc, { passkey: m.passkey })).res.status).toBe(200);

    // The new SC is shown ONCE: replaying the same request returns the card without it.
    const replay = await owner.post(`/v1/cards/${m.card.id}/renew`, {}, key);
    expect(replay.status).toBe(200);
    expect(replay.body.sc).toBeUndefined();
    expect(replay.body.secret_already_shown).toBe(true);
    expect(replay.body.card.renewal_count).toBe(1);
    expect((await su.query('SELECT renewal_count FROM cards WHERE id = $1', [m.card.id])).rows[0].renewal_count).toBe(1);
    // and the SC is nowhere in the database in readable form
    const stored = await su.query('SELECT response_body::text AS b FROM idempotency_keys WHERE key = $1', [key]);
    expect(stored.rows[0].b).not.toContain(`"sc"`);
    t.clock.reset();
  });

  it('25 renewals: the SC really changes (not a constant), and a renewal cannot exceed the tenant maximum', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }], { login: false });
    const seen = new Set<string>([m.card.sc]);
    for (let i = 0; i < 25; i += 1) {
      const r = await tenant.owner.post(`/v1/cards/${m.card.id}/renew`, { validity_days: 30 });
      expect(r.status).toBe(200);
      seen.add(r.body.sc);
    }
    expect(seen.size).toBeGreaterThan(15);
    expect((await tenant.owner.post(`/v1/cards/${m.card.id}/renew`, { validity_days: 91 })).status).toBe(422);
    expect((await tenant.owner.post(`/v1/cards/${m.card.id}/renew`, { validity_days: 0 })).status).toBe(400);
  });
});

describe('replacement (lost card)', () => {
  it('lost: new number and SC, old card dead at once, the person keeps their passkey', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    const rep = await tenant.owner.post(`/v1/cards/${m.card.id}/replace`, { reason: 'lost' });
    expect(rep.status).toBe(201);
    expect(rep.body.card.card_number).not.toBe(m.card.number);
    expect(rep.body.card.replaces_card_id).toBe(m.card.id);
    expect(rep.body.card.state).toBe('active');
    expect(rep.body.card.roles.map((r: any) => r.role_key)).toEqual(['expert']);
    expect(rep.body.enrollment_token).toBeUndefined();

    const old = await tenant.owner.get(`/v1/cards/${m.card.id}`);
    expect(old.body).toMatchObject({ state: 'replaced', replaced_by_card_id: rep.body.card.id });
    expect((await m.client.get('/v1/auth/session')).status).toBe(401);
    expect((await tryLogin(t, m.card.number, m.card.sc, { passkey: m.passkey })).res.status).toBe(401); // old number
    expect((await tryLogin(t, m.card.number, rep.body.sc, { passkey: m.passkey })).res.status).toBe(401); // old number, new SC
    const fresh = await login(t, { number: rep.body.card.card_number, sc: rep.body.sc }, { passkey: m.passkey });
    expect((await fresh.get('/v1/auth/session')).body.card_id).toBe(rep.body.card.id);
  });

  it('compromised: the old strong factors do NOT carry over; a new enrollment is required', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    const rep = await tenant.owner.post(`/v1/cards/${m.card.id}/replace`, { reason: 'compromised' });
    expect(rep.status).toBe(201);
    expect(rep.body.card.state).toBe('issued');
    expect(rep.body.enrollment_token).toBeTruthy();
    const next = fromSecrets(rep.body);
    expect((await tryLogin(t, next.number, next.sc, { passkey: m.passkey })).res.status).toBe(401); // stolen device is useless
    const newKey = await enrollPasskey(t, next);
    expect((await tryLogin(t, next.number, next.sc, { passkey: newKey })).res.status).toBe(200);
  });
});

describe('guards', () => {
  it('nobody can suspend, revoke or re-role their own card', async () => {
    const id = tenant.ownerCard.id;
    expect((await tenant.owner.post(`/v1/cards/${id}/suspend`, { reason: 'x' })).status).toBe(403);
    expect((await tenant.owner.post(`/v1/cards/${id}/revoke`, { reason: 'x' })).status).toBe(403);
    expect((await tenant.owner.post(`/v1/cards/${id}/roles`, { role_key: 'admin' })).status).toBe(403);
    expect((await tenant.owner.del(`/v1/cards/${id}/roles/company_owner`)).status).toBe(403);
    expect(await stateOf(id)).toBe('active');
  });

  it('an Admin cannot act on an Owner, cannot make anyone an Owner, and cannot promote itself', async () => {
    const admin = await addMember(t, tenant.owner, [{ role_key: 'admin' }]);
    const expert = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    expect((await admin.client.post(`/v1/cards/${tenant.ownerCard.id}/suspend`, { reason: 'coup' })).status).toBe(403);
    expect((await admin.client.post(`/v1/cards/${tenant.ownerCard.id}/revoke`, { reason: 'coup' })).status).toBe(403);
    expect((await admin.client.post(`/v1/cards/${tenant.ownerCard.id}/renew`, {})).status).toBe(403);
    expect((await admin.client.post(`/v1/cards/${expert.card.id}/roles`, { role_key: 'company_owner' })).status).toBe(403);
    expect((await admin.client.post(`/v1/cards/${admin.card.id}/roles`, { role_key: 'company_owner' })).status).toBe(403);
    expect((await admin.client.put(`/v1/cards/${expert.card.id}/roles`, { roles: [{ role_key: 'company_owner' }] })).status).toBe(403);
    const reasons = await su.query(
      `SELECT DISTINCT reason_code FROM audit_log WHERE actor_card_id = $1 AND decision = 'deny' ORDER BY 1`, [admin.card.id]);
    expect(reasons.rows.map((r) => r.reason_code)).toEqual(['DENY_RANK', 'DENY_SELF_ACTION']);
    // ...but an Admin CAN do its job on lower-ranked cards
    expect((await admin.client.post(`/v1/cards/${expert.card.id}/roles`, { role_key: 'successor' })).status).toBe(201);
    expect((await admin.client.del(`/v1/cards/${expert.card.id}/roles/successor`)).status).toBe(204);
    expect((await admin.client.del(`/v1/cards/${expert.card.id}/roles/expert`)).status).toBe(409); // last role
  });

  it('offboarding: marking a person as departed revokes their card and ends their sessions', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    const res = await tenant.owner.patch(`/v1/people/${m.personId}`, { status: 'departed' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('departed');
    expect(await stateOf(m.card.id)).toBe('revoked');
    expect((await m.client.get('/v1/auth/session')).status).toBe(401);
    expect((await tryLogin(t, m.card.number, m.card.sc, { passkey: m.passkey })).res.status).toBe(401);
    expect((await su.query('SELECT revoked_reason FROM cards WHERE id = $1', [m.card.id])).rows[0].revoked_reason).toBe('offboarded');
  });
});

describe('expiry is written down by the sweeper, but never depends on it', () => {
  it('sweep marks overdue cards as expired and records the event', async () => {
    const { sweepExpiredCards } = await import('../../src/cli/sweep-expired-cards.ts');
    const ten = await createTenant(t, 'sweep');
    const m = await addMember(t, ten.owner, [{ role_key: 'expert' }], { login: false });
    await su.query(`UPDATE cards SET issued_at = now() - interval '91 days', expires_at = now() - interval '1 day', renewal_due = now() - interval '15 days', grace_until = now() + interval '13 days' WHERE id = $1`, [m.card.id]);
    expect(await stateOf(m.card.id)).toBe('active'); // stored state lags...
    expect((await ten.owner.get(`/v1/cards/${m.card.id}`)).body.state).toBe('expired'); // ...but the API already says expired
    const swept = await sweepExpiredCards(t.app, new Date());
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await stateOf(m.card.id)).toBe('expired');
    expect((await events(m.card.id)).at(-1)).toBe('expired');
    expect(await sweepExpiredCards(t.app, new Date())).toBe(0); // idempotent
  });

  it('housekeeping removes only rows that are long dead (so tables that only grow cannot fill the database)', async () => {
    const { purgeOldRows } = await import('../../src/cli/sweep-expired-cards.ts');
    const ten = await createTenant(t, 'purge');
    const m = await addMember(t, ten.owner, [{ role_key: 'expert' }]);
    await ten.owner.post(`/v1/cards/${m.card.id}/suspend`, { reason: 'purge test' }); // revokes m's session
    const count = async (table: string): Promise<number> => (await su.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [ten.tenantId])).rows[0].n;
    const sessions = await count('sessions');
    const tokens = await count('enrollment_tokens');
    expect(sessions).toBeGreaterThanOrEqual(2);

    // Today: nothing is old enough. Nothing in this tenant is removed.
    await purgeOldRows(t.app, new Date());
    expect(await count('sessions')).toBe(sessions);
    expect(await count('enrollment_tokens')).toBe(tokens);
    expect((await ten.owner.get('/v1/auth/session')).status).toBe(200);

    // 45 days from now: revoked / expired sessions and spent tokens are gone; the cards and the audit log are untouched.
    const audit = await count('audit_log');
    const cards = await count('cards');
    const removed = await purgeOldRows(t.app, new Date(Date.now() + 45 * 86_400_000));
    expect(removed.sessions).toBeGreaterThanOrEqual(sessions);
    expect(await count('sessions')).toBe(0);
    expect(await count('enrollment_tokens')).toBe(0);
    expect(await count('audit_log')).toBe(audit);
    expect(await count('cards')).toBe(cards);
  });
});
