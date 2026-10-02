// Lockout, and the proof that it cannot be used as a weapon: a wrong SC only counts AFTER a
// valid strong factor, so someone who merely knows a card number can never lock its owner out.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember, appRoleClient, Client, createTenant, enrollTotp, fromSecrets, login, startApp, superuser, totpCode, tryLogin, VirtualPasskey,
  type TestApp, type TestMember, type TestTenant,
} from '../helpers/harness.ts';

let t: TestApp;
let su: pg.Client;
let tenant: TestTenant;

beforeAll(async () => {
  t = await startApp();
  su = await superuser();
  tenant = await createTenant(t, 'lockout');
});
afterAll(async () => {
  await su.end();
  await t.close();
});

const wrongSc = (sc: string): string => String((Number(sc) + 1) % 1000).padStart(3, '0');
const authState = async (cardId: string) =>
  (await su.query('SELECT sc_failed_count, locked_at, lock_reason, factor_failed_count, factor_throttled_until FROM card_auth_state WHERE card_id = $1', [cardId])).rows[0];
const lastReason = async (cardId: string) =>
  (await su.query('SELECT real_reason FROM login_attempts WHERE card_id = $1 ORDER BY id DESC LIMIT 1', [cardId])).rows[0]?.real_reason;

describe('lockout cannot be used to lock a victim out', () => {
  let victim: TestMember;
  beforeAll(async () => {
    victim = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
  });

  it('60 guesses by someone who only knows the card number: card is NOT locked, counter stays 0', async () => {
    const strangerKey = new VirtualPasskey();
    for (let i = 0; i < 40; i += 1) {
      const { res } = await tryLogin(t, victim.card.number, String(i).padStart(3, '0'), { passkey: strangerKey });
      expect(res.status).toBe(401);
    }
    for (let i = 0; i < 20; i += 1) {
      // Right SC, wrong factor: even knowing the SC does not move the counter.
      const { res } = await tryLogin(t, victim.card.number, victim.card.sc, { passkey: strangerKey });
      expect(res.status).toBe(401);
    }
    const state = await authState(victim.card.id);
    expect(state.sc_failed_count).toBe(0);
    expect(state.locked_at).toBeNull();
    expect(await lastReason(victim.card.id)).toBe('bad_factor');
  });

  it('...and the real cardholder still signs in', async () => {
    const { res } = await tryLogin(t, victim.card.number, victim.card.sc, { passkey: victim.passkey });
    expect(res.status).toBe(200);
  });
});

describe('lockout after wrong SCs with a valid strong factor', () => {
  it('4 wrong codes then the right one: signs in and the counter resets', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }], { login: false });
    for (let i = 0; i < 4; i += 1) {
      expect((await tryLogin(t, m.card.number, wrongSc(m.card.sc), { passkey: m.passkey })).res.status).toBe(401);
    }
    expect((await authState(m.card.id)).sc_failed_count).toBe(4);
    expect((await tryLogin(t, m.card.number, m.card.sc, { passkey: m.passkey })).res.status).toBe(200);
    expect(await authState(m.card.id)).toMatchObject({ sc_failed_count: 0, locked_at: null });
  });

  it('5 wrong codes (default threshold): the card locks; the right code no longer works; sessions end; admins are notified', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    expect((await m.client.get('/v1/auth/session')).status).toBe(200);
    for (let i = 0; i < 5; i += 1) {
      expect((await tryLogin(t, m.card.number, wrongSc(m.card.sc), { passkey: m.passkey })).res.status).toBe(401);
    }
    const state = await authState(m.card.id);
    expect(state.sc_failed_count).toBe(5);
    expect(state.locked_at).not.toBeNull();
    expect(state.lock_reason).toBe('sc_attempts');

    // Correct everything, but locked: same generic failure.
    const { res } = await tryLogin(t, m.card.number, m.card.sc, { passkey: m.passkey });
    expect(res.status).toBe(401);
    expect(await lastReason(m.card.id)).toBe('locked');

    // The session that existed before the lock is dead.
    expect((await m.client.get('/v1/auth/session')).status).toBe(401);

    const events = await su.query(`SELECT 1 FROM card_events WHERE card_id = $1 AND event_type = 'sc_locked'`, [m.card.id]);
    expect(events.rowCount).toBe(1);
    const audit = await su.query(`SELECT 1 FROM audit_log WHERE resource_id = $1 AND reason_code = 'CARD_LOCKED_SC_ATTEMPTS'`, [m.card.id]);
    expect(audit.rowCount).toBe(1);
    expect(t.logs.some((l) => l.includes('"notification":"card_locked"') && l.includes(m.card.id))).toBe(true);
    const shown = await tenant.owner.get(`/v1/cards/${m.card.id}`);
    expect(shown.body.locked).toBe(true);
  });

  it('the threshold is a tenant setting (3): the card locks on the third wrong code', async () => {
    const other = await createTenant(t, 'lockout3');
    expect((await other.owner.patch('/v1/tenants/current/settings', { sc_lockout_threshold: 3 })).status).toBe(200);
    const m = await addMember(t, other.owner, [{ role_key: 'expert' }], { login: false });
    for (let i = 0; i < 2; i += 1) await tryLogin(t, m.card.number, wrongSc(m.card.sc), { passkey: m.passkey });
    expect((await authState(m.card.id)).locked_at).toBeNull();
    await tryLogin(t, m.card.number, wrongSc(m.card.sc), { passkey: m.passkey });
    expect((await authState(m.card.id)).locked_at).not.toBeNull();
  });

  it('the threshold cannot be set outside 3-5: API rejects it, and so does the database itself', async () => {
    for (const bad of [0, 1, 2, 6, 100, -1, 3.5, '5', null]) {
      const res = await tenant.owner.patch('/v1/tenants/current/settings', { sc_lockout_threshold: bad });
      expect(res.status, `threshold ${String(bad)}`).toBe(400);
    }
    const app = await appRoleClient();
    try {
      for (const bad of [2, 6]) {
        await app.query('BEGIN');
        await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.tenantId]);
        await expect(app.query('UPDATE tenant_settings SET sc_lockout_threshold = $1', [bad])).rejects.toMatchObject({ code: '23514' });
        await app.query('ROLLBACK');
      }
    } finally {
      await app.end();
    }
    expect((await tenant.owner.get('/v1/tenants/current/settings')).body.sc_lockout_threshold).toBe(5);
  });
});

describe('unlock', () => {
  it('an admin unlocks a card: a new SC is issued, the old hash is destroyed, the cardholder signs in with the new SC', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }], { login: false });
    for (let i = 0; i < 5; i += 1) await tryLogin(t, m.card.number, wrongSc(m.card.sc), { passkey: m.passkey });
    expect((await authState(m.card.id)).locked_at).not.toBeNull();

    const unlocked = await tenant.owner.post(`/v1/cards/${m.card.id}/unlock`);
    expect(unlocked.status).toBe(200);
    expect(unlocked.body.sc).toMatch(/^\d{3}$/);
    expect(unlocked.body.card.locked).toBe(false);
    expect(await authState(m.card.id)).toMatchObject({ sc_failed_count: 0, locked_at: null, lock_reason: null });

    const secrets = await su.query('SELECT status, sc_hash IS NULL AS destroyed FROM card_secrets WHERE card_id = $1 ORDER BY id', [m.card.id]);
    expect(secrets.rows).toEqual([{ status: 'retired', destroyed: true }, { status: 'current', destroyed: false }]);

    if (unlocked.body.sc !== m.card.sc) {
      expect((await tryLogin(t, m.card.number, m.card.sc, { passkey: m.passkey })).res.status).toBe(401);
      // that one wrong attempt must not have re-locked the card
      expect((await authState(m.card.id)).locked_at).toBeNull();
    }
    expect((await tryLogin(t, m.card.number, unlocked.body.sc, { passkey: m.passkey })).res.status).toBe(200);
  });

  it('unlocking a card that is not locked is refused (409), and so is unlocking without the permission (403)', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    expect((await tenant.owner.post(`/v1/cards/${m.card.id}/unlock`)).status).toBe(409);
    const other = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    expect((await other.client.post(`/v1/cards/${m.card.id}/unlock`)).status).toBe(403);
  });
});

describe('authenticator-app (TOTP) guessing is throttled - temporarily, never permanently', () => {
  let card: ReturnType<typeof fromSecrets>;
  let secret: string;
  beforeAll(async () => {
    const person = await tenant.owner.post('/v1/people', { display_name: 'Totp User' });
    const issued = await tenant.owner.post('/v1/cards', { person_id: person.body.id, roles: [{ role_key: 'expert' }] });
    card = fromSecrets(issued.body);
    secret = await enrollTotp(t, card);
  });

  /** One login attempt with a chosen SC and TOTP code. */
  const attempt = async (sc: string, code: string) => {
    const c = new Client(t);
    const begin = await c.request('POST', '/v1/auth/login/begin', { card_number: card.number });
    return c.request('POST', '/v1/auth/login/verify', { login_txn: begin.body.login_txn, sc, factor: { type: 'totp', code } });
  };
  /** What a stranger can do: they know the card number only, so both the SC and the code are guesses. */
  const strangerGuess = () => attempt(wrongSc(card.sc), '000000');

  it('a code cannot be replayed', async () => {
    const first = await tryLogin(t, card.number, card.sc, { totp: secret });
    expect(first.res.status).toBe(200);
    const again = await tryLogin(t, card.number, card.sc, { totp: secret }); // same 30-second step, same code
    expect(again.res.status).toBe(401);
    t.clock.advance(31_000);
    expect((await tryLogin(t, card.number, card.sc, { totp: secret })).res.status).toBe(200);
    t.clock.advance(31_000);
  });

  it('a valid code is spent even when the SC was wrong (it cannot be reused to try other SCs)', async () => {
    const code = await totpCode(secret, t);
    expect((await attempt(wrongSc(card.sc), code)).status).toBe(401); // right code, wrong SC
    expect((await attempt(card.sc, code)).status).toBe(401);          // same code again, now with the right SC: refused
    await su.query('UPDATE card_auth_state SET sc_failed_count = 0, factor_failed_count = 0, factor_window_start = NULL WHERE card_id = $1', [card.id]);
    t.clock.advance(31_000);
    expect((await tryLogin(t, card.number, card.sc, { totp: secret })).res.status).toBe(200);
    t.clock.advance(31_000);
  });

  it('a stranger guessing codes pauses TOTP for the card - but can neither lock it nor keep the real cardholder out', async () => {
    for (let i = 0; i < 5; i += 1) expect((await strangerGuess()).status).toBe(401);
    const paused = await authState(card.id);
    expect(paused.factor_throttled_until).not.toBeNull();
    expect(paused.sc_failed_count).toBe(0);
    expect(paused.locked_at).toBeNull();

    // While paused, the stranger's further guesses are not even examined, and still move no counter.
    for (let i = 0; i < 10; i += 1) expect((await strangerGuess()).status).toBe(401);
    expect(await lastReason(card.id)).toBe('factor_throttled');
    expect(await authState(card.id)).toMatchObject({ sc_failed_count: 0, locked_at: null });

    // The REAL cardholder knows the SC, so their correct code is examined and they get in - during the pause.
    expect((await tryLogin(t, card.number, card.sc, { totp: secret })).res.status).toBe(200);
    expect((await authState(card.id)).factor_throttled_until).toBeNull();
    t.clock.advance(31_000);
  });

  it('the pause also ends by itself', async () => {
    for (let i = 0; i < 5; i += 1) await strangerGuess();
    expect((await authState(card.id)).factor_throttled_until).not.toBeNull();
    t.clock.advance(15 * 60_000 + 1000);
    await strangerGuess(); // examined again now (and wrong): proves the pause is over without a successful login
    expect(await lastReason(card.id)).toBe('bad_factor');
    expect((await tryLogin(t, card.number, card.sc, { totp: secret })).res.status).toBe(200);
    t.clock.advance(31_000);
  });

  it('someone who knows the SC and guesses codes during a pause locks the card (hard lock, admin unlock needed)', async () => {
    for (let i = 0; i < 5; i += 1) await strangerGuess();
    expect((await authState(card.id)).factor_throttled_until).not.toBeNull();
    for (let i = 0; i < 5; i += 1) expect((await attempt(card.sc, '000000')).status).toBe(401);
    const state = await authState(card.id);
    expect(state.locked_at).not.toBeNull();
    expect(state.lock_reason).toBe('sc_attempts');
    expect((await tryLogin(t, card.number, card.sc, { totp: secret })).res.status).toBe(401);
    const unlocked = await tenant.owner.post(`/v1/cards/${card.id}/unlock`);
    expect(unlocked.status).toBe(200);
    card.sc = unlocked.body.sc;
    t.clock.advance(61 * 60_000);
    expect((await tryLogin(t, card.number, card.sc, { totp: secret })).res.status).toBe(200);
    t.clock.advance(31_000);
  });

  it('a passkey on the same card is never affected by a TOTP pause', async () => {
    // The admin issues an enrollment token so the cardholder can add a passkey as well.
    const token = await tenant.owner.post(`/v1/cards/${card.id}/enrollment-token`, {});
    expect(token.status).toBe(201);
    const c = new Client(t);
    const begin = await c.request('POST', '/v1/auth/enrollment/begin', {
      card_number: card.number, sc: card.sc, enrollment_token: token.body.enrollment_token, factor_type: 'passkey',
    });
    expect(begin.status).toBe(200);
    const passkey = new VirtualPasskey();
    expect((await c.request('POST', '/v1/auth/enrollment/complete', { enrollment_txn: begin.body.enrollment_txn, attestation: passkey.attest(begin.body.webauthn_options) })).status).toBe(204);

    for (let i = 0; i < 5; i += 1) await strangerGuess();
    expect((await authState(card.id)).factor_throttled_until).not.toBeNull();
    expect((await login(t, card, { passkey })).cookie).toBeTruthy();
    t.clock.reset();
  });

  it('a mistyped code during enrollment does not use up the 72-hour enrollment token', async () => {
    const person = await tenant.owner.post('/v1/people', { display_name: 'Clumsy Enroller' });
    const issued = fromSecrets((await tenant.owner.post('/v1/cards', { person_id: person.body.id, roles: [{ role_key: 'expert' }] })).body);
    const start = () => new Client(t).request('POST', '/v1/auth/enrollment/begin', {
      card_number: issued.number, sc: issued.sc, enrollment_token: issued.enrollmentToken, factor_type: 'totp',
    });
    const first = await start();
    expect((await new Client(t).request('POST', '/v1/auth/enrollment/complete', { enrollment_txn: first.body.enrollment_txn, totp_code: '000000' })).status).toBe(401);
    expect((await su.query('SELECT state FROM cards WHERE id = $1', [issued.id])).rows[0].state).toBe('issued');
    // Same token, second try, correct code this time.
    const second = await start();
    expect(second.status).toBe(200);
    const done = await new Client(t).request('POST', '/v1/auth/enrollment/complete', {
      enrollment_txn: second.body.enrollment_txn, totp_code: await totpCode(second.body.totp.secret, t),
    });
    expect(done.status).toBe(204);
    expect((await su.query('SELECT state FROM cards WHERE id = $1', [issued.id])).rows[0].state).toBe('active');
    // ...and now the token really is spent.
    expect((await start()).status).toBe(401);
  });

  it('replacing a lost card keeps an authenticator-app user able to sign in (the seed moves with the person)', async () => {
    const person = await tenant.owner.post('/v1/people', { display_name: 'Totp Replace' });
    const old = fromSecrets((await tenant.owner.post('/v1/cards', { person_id: person.body.id, roles: [{ role_key: 'expert' }] })).body);
    const seed = await enrollTotp(t, old);
    const rep = await tenant.owner.post(`/v1/cards/${old.id}/replace`, { reason: 'lost' });
    expect(rep.status).toBe(201);
    expect(rep.body.card.state).toBe('active');
    expect((await tryLogin(t, rep.body.card.card_number, rep.body.sc, { totp: seed })).res.status).toBe(200);
    expect((await tryLogin(t, old.number, old.sc, { totp: seed })).res.status).toBe(401);
    t.clock.reset();
  });
});
