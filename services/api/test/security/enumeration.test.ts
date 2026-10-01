// No enumeration: an outsider must not be able to tell "no such card" from "wrong code",
// "locked", "expired", "suspended" or "wrong factor" - not by message, status, headers, or
// (approximately) timing. The real reason is recorded internally only.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dammCheckDigit, formatCardNumber } from '../../src/modules/identity-access/index.ts';
import {
  addMember, Client, createTenant, startApp, superuser, tryLogin, VirtualPasskey, type Factor, type Res, type TestApp, type TestMember, type TestTenant,
} from '../helpers/harness.ts';

let t: TestApp;
let su: pg.Client;
let tenant: TestTenant;
let normal: TestMember;
let locked: TestMember;
let lapsed: TestMember;
let suspended: TestMember;
let revoked: TestMember;
let unknownNumber: string;
const stranger = new VirtualPasskey();

interface Case {
  name: string;
  reason: string | null;
  number: () => string;
  sc: () => string;
  factor: () => Factor;
}
let cases: Case[];

const wrong = (sc: string): string => String((Number(sc) + 7) % 1000).padStart(3, '0');
const comparable = (r: Res): unknown => ({ ...r.body, request_id: '<removed>' });

beforeAll(async () => {
  t = await startApp();
  su = await superuser();
  tenant = await createTenant(t, 'enum');
  normal = await addMember(t, tenant.owner, [{ role_key: 'expert' }], { login: false });
  locked = await addMember(t, tenant.owner, [{ role_key: 'expert' }], { login: false });
  lapsed = await addMember(t, tenant.owner, [{ role_key: 'expert' }], { login: false });
  suspended = await addMember(t, tenant.owner, [{ role_key: 'expert' }], { login: false });
  revoked = await addMember(t, tenant.owner, [{ role_key: 'expert' }], { login: false });

  for (let i = 0; i < 5; i += 1) await tryLogin(t, locked.card.number, wrong(locked.card.sc), { passkey: locked.passkey });
  await su.query(
    `UPDATE cards SET expires_at = now() - interval '30 days', grace_until = now() - interval '16 days', renewal_due = now() - interval '44 days' WHERE id = $1`,
    [lapsed.card.id]);
  await tenant.owner.post(`/v1/cards/${suspended.card.id}/suspend`, { reason: 'test' });
  await tenant.owner.post(`/v1/cards/${revoked.card.id}/revoke`, { reason: 'test' });

  // A well-formed number (valid check digit) that was never issued.
  for (;;) {
    const body = '9' + String(Math.floor(Math.random() * 1e14)).padStart(14, '0');
    const candidate = body + dammCheckDigit(body);
    if ((await su.query('SELECT 1 FROM card_directory WHERE card_number = $1', [candidate])).rowCount === 0) {
      unknownNumber = formatCardNumber(candidate);
      break;
    }
  }

  cases = [
    { name: 'unknown card', reason: 'unknown_card', number: () => unknownNumber, sc: () => '123', factor: () => ({ passkey: stranger }) },
    { name: 'wrong SC (valid passkey)', reason: 'bad_sc', number: () => normal.card.number, sc: () => wrong(normal.card.sc), factor: () => ({ passkey: normal.passkey }) },
    { name: 'wrong factor (right SC)', reason: 'bad_factor', number: () => normal.card.number, sc: () => normal.card.sc, factor: () => ({ passkey: stranger }) },
    { name: 'locked card (everything correct)', reason: 'locked', number: () => locked.card.number, sc: () => locked.card.sc, factor: () => ({ passkey: locked.passkey }) },
    { name: 'expired card past grace (everything correct)', reason: 'expired', number: () => lapsed.card.number, sc: () => lapsed.card.sc, factor: () => ({ passkey: lapsed.passkey }) },
    { name: 'suspended card (everything correct)', reason: 'state', number: () => suspended.card.number, sc: () => suspended.card.sc, factor: () => ({ passkey: suspended.passkey }) },
    { name: 'revoked card (everything correct)', reason: 'bad_sc', number: () => revoked.card.number, sc: () => revoked.card.sc, factor: () => ({ passkey: revoked.passkey }) },
    { name: 'card number with a wrong check digit', reason: 'unknown_card', number: () => normal.card.number.slice(0, -1) + String((Number(normal.card.number.slice(-1)) + 1) % 10), sc: () => normal.card.sc, factor: () => ({ passkey: normal.passkey }) },
    { name: 'wrong TOTP code on a passkey-only card', reason: 'bad_factor', number: () => normal.card.number, sc: () => normal.card.sc, factor: () => ({ totp: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' }) },
  ];
});
afterAll(async () => {
  await su.end();
  await t.close();
});

describe('login/verify: every failure looks the same from outside', () => {
  it('status, body and headers are identical across all failure causes; the real reason is logged internally', async () => {
    const seen: Array<{ name: string; res: Res; cookie: string | null }> = [];
    for (const c of cases) {
      const { res, client } = await tryLogin(t, c.number(), c.sc(), c.factor());
      seen.push({ name: c.name, res, cookie: client.cookie });
      const { rows } = await su.query('SELECT real_reason FROM login_attempts WHERE request_id = $1', [res.body.request_id]);
      expect(rows[0]?.real_reason, `internal reason for "${c.name}"`).toBe(c.reason);
    }
    const reference = seen[0]!;
    expect(reference.res.status).toBe(401);
    expect(comparable(reference.res)).toEqual({ type: 'urn:legacyai:problem:auth-failed', title: 'Sign-in failed', status: 401, request_id: '<removed>' });
    for (const s of seen) {
      expect(s.res.status, s.name).toBe(401);
      expect(comparable(s.res), s.name).toEqual(comparable(reference.res));
      expect(Object.keys(s.res.headers).sort(), s.name).toEqual(Object.keys(reference.res.headers).sort());
      expect(s.res.headers['content-type'], s.name).toBe(reference.res.headers['content-type']);
      expect(s.res.raw.length, s.name).toBe(reference.res.raw.length);
      expect(s.cookie, s.name).toBeNull();
      expect(s.res.headers['set-cookie'], s.name).toBeUndefined();
    }
    // The internal reasons really were different - the uniformity is not an accident of identical causes.
    expect(new Set(cases.map((c) => c.reason)).size).toBeGreaterThanOrEqual(6);
  });

  it('an expired, unknown or reused login transaction gives the same answer too', async () => {
    const c = new Client(t);
    const begin = await c.request('POST', '/v1/auth/login/begin', { card_number: normal.card.number });
    const assertion = normal.passkey.assert(begin.body.webauthn_options);
    t.clock.advance(6 * 60_000); // transactions live 5 minutes
    const late = await c.request('POST', '/v1/auth/login/verify', { login_txn: begin.body.login_txn, sc: normal.card.sc, factor: { type: 'passkey', assertion } });
    t.clock.reset();
    const madeUp = await c.request('POST', '/v1/auth/login/verify', { login_txn: 'A'.repeat(43), sc: normal.card.sc, factor: { type: 'passkey', assertion } });
    const { res: reference } = await tryLogin(t, unknownNumber, '123', { passkey: stranger });
    for (const r of [late, madeUp]) {
      expect(r.status).toBe(401);
      expect(comparable(r)).toEqual(comparable(reference));
    }
  });

  it('control: the valid card signs in (so the uniform 401 is not just "everything fails")', async () => {
    const { res } = await tryLogin(t, normal.card.number, normal.card.sc, { passkey: normal.passkey });
    expect(res.status).toBe(200);
  });
});

describe('login/begin: known and unknown cards get the same shape of answer', () => {
  const shape = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(shape);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, shape(x)]));
    return typeof v === 'string' ? `string(${v.length})` : typeof v;
  };

  it('same status, same fields, same lengths, no credential list, TOTP always offered', async () => {
    const answers: Res[] = [];
    for (const number of [normal.card.number, unknownNumber, locked.card.number, revoked.card.number, lapsed.card.number, '0000 0000 0000 0000']) {
      const res = await new Client(t).request('POST', '/v1/auth/login/begin', { card_number: number });
      expect(res.status).toBe(200);
      expect(res.body.totp_allowed).toBe(true);
      expect(res.body.webauthn_options.allowCredentials ?? []).toEqual([]);
      answers.push(res);
    }
    for (const a of answers) {
      expect(shape(a.body)).toEqual(shape(answers[0]!.body));
      expect(Object.keys(a.headers).sort()).toEqual(Object.keys(answers[0]!.headers).sort());
    }
    // every answer carries its own fresh challenge and transaction
    expect(new Set(answers.map((a) => a.body.login_txn)).size).toBe(answers.length);
    expect(new Set(answers.map((a) => a.body.webauthn_options.challenge)).size).toBe(answers.length);
  });
});

describe('enrollment/begin: failures are uniform as well', () => {
  it('unknown card, wrong token and wrong SC all return the same 401', async () => {
    const fresh = await (async () => {
      const p = await tenant.owner.post('/v1/people', { display_name: 'Enroll Probe' });
      return (await tenant.owner.post('/v1/cards', { person_id: p.body.id, roles: [{ role_key: 'expert' }] })).body;
    })();
    const base = { factor_type: 'passkey' };
    const responses = [
      await new Client(t).request('POST', '/v1/auth/enrollment/begin', { ...base, card_number: unknownNumber, sc: '123', enrollment_token: 'x'.repeat(43) }),
      await new Client(t).request('POST', '/v1/auth/enrollment/begin', { ...base, card_number: fresh.card.card_number, sc: fresh.sc, enrollment_token: 'x'.repeat(43) }),
      await new Client(t).request('POST', '/v1/auth/enrollment/begin', { ...base, card_number: fresh.card.card_number, sc: wrong(fresh.sc), enrollment_token: fresh.enrollment_token }),
      await new Client(t).request('POST', '/v1/auth/enrollment/begin', { ...base, card_number: revoked.card.number, sc: revoked.card.sc, enrollment_token: revoked.card.enrollmentToken }),
    ];
    for (const r of responses) {
      expect(r.status).toBe(401);
      expect(comparable(r)).toEqual(comparable(responses[0]!));
    }
    // a wrong SC with an INVALID token must not count toward lockout (the token is the strong factor here)
    const state = await su.query('SELECT sc_failed_count FROM card_auth_state WHERE card_id = $1', [fresh.card.id]);
    expect(state.rows[0].sc_failed_count).toBe(1); // only the attempt that carried the real token
  });
});

describe('same work on every path', () => {
  it('every failure cause performs EXACTLY ONE Argon2id computation (so none can be told apart by skipping the slow step)', async () => {
    const hasher = t.app.identity.hasher;
    for (const c of cases) {
      const client = new Client(t);
      const begin = await client.request('POST', '/v1/auth/login/begin', { card_number: c.number() });
      const f = c.factor();
      const factor = 'passkey' in f ? { type: 'passkey', assertion: f.passkey.assert(begin.body.webauthn_options) } : { type: 'totp', code: '000000' };
      const before = hasher.computations;
      const res = await client.request('POST', '/v1/auth/login/verify', { login_txn: begin.body.login_txn, sc: '000', factor });
      expect(res.status, c.name).toBe(401);
      expect(hasher.computations - before, `Argon2 computations for "${c.name}"`).toBe(1);
    }
    // login/begin does no hashing at all, for known and unknown cards alike
    const before = hasher.computations;
    await new Client(t).request('POST', '/v1/auth/login/begin', { card_number: normal.card.number });
    await new Client(t).request('POST', '/v1/auth/login/begin', { card_number: unknownNumber });
    expect(hasher.computations).toBe(before);
    await su.query('UPDATE card_auth_state SET sc_failed_count = 0, locked_at = NULL, lock_reason = NULL WHERE card_id = $1', [normal.card.id]);
  });

  it('timing, measured (coarse; reported, with a loose bound)', async () => {
    const ROUNDS = 12;
    const medians: Record<string, number> = {};
    const run = async (c: Case): Promise<number> => {
      const client = new Client(t);
      const begin = await client.request('POST', '/v1/auth/login/begin', { card_number: c.number() });
      const f = c.factor();
      const factor = 'passkey' in f ? { type: 'passkey', assertion: f.passkey.assert(begin.body.webauthn_options) } : { type: 'totp', code: '000000' };
      // "wrong SC" would lock the card after 5 rounds; keep the cause stable by resetting the counter.
      if (c.reason === 'bad_sc') await su.query('UPDATE card_auth_state SET sc_failed_count = 0, locked_at = NULL, lock_reason = NULL WHERE card_id = $1', [normal.card.id]);
      const start = process.hrtime.bigint();
      const res = await client.request('POST', '/v1/auth/login/verify', { login_txn: begin.body.login_txn, sc: c.sc(), factor });
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      expect(res.status).toBe(401);
      return ms;
    };
    for (const c of cases) await run(c); // warm-up, not measured
    for (const c of cases) {
      const samples: number[] = [];
      for (let i = 0; i < ROUNDS; i += 1) samples.push(await run(c));
      samples.sort((a, b) => a - b);
      medians[c.name] = samples[Math.floor(samples.length / 2)]!;
    }
    const values = Object.values(medians);
    const fastest = Math.min(...values);
    const slowest = Math.max(...values);
    console.log(`ENUMERATION_TIMING_MS (MEASURED, median of ${ROUNDS}): ${JSON.stringify(Object.fromEntries(Object.entries(medians).map(([k, v]) => [k, Math.round(v)])))}`);
    console.log(`ENUMERATION_TIMING_MS fastest=${fastest.toFixed(1)} slowest=${slowest.toFixed(1)} ratio=${(slowest / fastest).toFixed(2)}`);
    // Loose bound: catches a path that is grossly different. Fine-grained timing analysis is NOT claimed.
    expect(slowest / fastest).toBeLessThan(3);
    await su.query('UPDATE card_auth_state SET sc_failed_count = 0, locked_at = NULL, lock_reason = NULL WHERE card_id = $1', [normal.card.id]);
  });
});
