// THE non-negotiable rule: card number + SC alone must NEVER authenticate anyone, in any code path.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSession, ScProof, StrongFactorProof, VerifiedLogin } from '../../src/modules/identity-access/index.ts';
import { getSettings, SESSION_COOKIE } from '../../src/modules/platform/index.ts';
import { TEST_ORIGIN } from '../helpers/env.ts';
import { addMember, Client, createTenant, startApp, superuser, tryLogin, type TestApp, type TestMember, type TestTenant } from '../helpers/harness.ts';

let t: TestApp;
let su: pg.Client;
let tenant: TestTenant;
let victim: TestMember;
let other: TestMember;

beforeAll(async () => {
  t = await startApp();
  su = await superuser();
  tenant = await createTenant(t, 'cardsc');
  victim = await addMember(t, tenant.owner, [{ role_key: 'admin' }], { login: false });
  other = await addMember(t, tenant.owner, [{ role_key: 'expert' }], { login: false });
});
afterAll(async () => {
  await su.end();
  await t.close();
});

const sessionsOf = async (cardId: string): Promise<number> =>
  (await su.query('SELECT count(*)::int AS n FROM sessions WHERE card_id = $1', [cardId])).rows[0].n;

describe('login/verify with a correct card number and a correct SC but no valid strong factor', () => {
  const attempt = async (factor: unknown, omit = false) => {
    const c = new Client(t);
    const begin = await c.request('POST', '/v1/auth/login/begin', { card_number: victim.card.number });
    const body: Record<string, unknown> = { login_txn: begin.body.login_txn, sc: victim.card.sc };
    if (!omit) body.factor = factor;
    const res = await c.request('POST', '/v1/auth/login/verify', body);
    return { res, cookie: c.cookie };
  };

  it.each([
    ['no factor field at all', undefined, true, 400],
    ['factor: null', null, false, 400],
    ['factor: {}', {}, false, 400],
    ['factor: "passkey"', 'passkey', false, 400],
    ['factor: true', true, false, 400],
    ['factor with unknown type', { type: 'none' }, false, 400],
    ['factor type "sc"', { type: 'sc', code: '123' }, false, 400],
    ['passkey without an assertion', { type: 'passkey' }, false, 400],
    ['totp without a code', { type: 'totp' }, false, 400],
    ['totp with an empty code', { type: 'totp', code: '' }, false, 400],
    ['totp with the SC as the code', { type: 'totp', code: '123' }, false, 400],
    ['passkey with an empty assertion', { type: 'passkey', assertion: {} }, false, 401],
    ['passkey with a made-up assertion', { type: 'passkey', assertion: { id: 'AAAA', rawId: 'AAAA', type: 'public-key', response: { clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AAAA' } } }, false, 401],
    ['a wrong 6-digit code', { type: 'totp', code: '000000' }, false, 401],
    ['both factors named but neither valid', { type: 'totp', code: '000000', assertion: {} }, false, 400],
  ])('%s -> rejected, no session', async (_name, factor, omit, expected) => {
    const before = await sessionsOf(victim.card.id);
    const { res, cookie } = await attempt(factor, omit as boolean);
    expect(res.status).toBe(expected);
    expect(cookie).toBeNull();
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await sessionsOf(victim.card.id)).toBe(before);
  });

  it('a VALID passkey that belongs to a DIFFERENT card does not work', async () => {
    const { res, client } = await tryLogin(t, victim.card.number, victim.card.sc, { passkey: other.passkey });
    expect(res.status).toBe(401);
    expect(client.cookie).toBeNull();
    expect(await sessionsOf(victim.card.id)).toBe(0);
  });

  it('a passkey assertion signed for a different origin (phishing site) does not work', async () => {
    victim.passkey.origin = 'https://evil.example.test';
    const { res } = await tryLogin(t, victim.card.number, victim.card.sc, { passkey: victim.passkey });
    victim.passkey.origin = TEST_ORIGIN;
    expect(res.status).toBe(401);
  });

  it('a passkey assertion without user verification (no biometric / PIN) does not work', async () => {
    victim.passkey.userVerified = false;
    const { res } = await tryLogin(t, victim.card.number, victim.card.sc, { passkey: victim.passkey });
    victim.passkey.userVerified = true;
    expect(res.status).toBe(401);
  });

  it('an assertion replayed against a new login transaction does not work (the challenge is single-use)', async () => {
    const c = new Client(t);
    const b1 = await c.request('POST', '/v1/auth/login/begin', { card_number: victim.card.number });
    const assertion = victim.passkey.assert(b1.body.webauthn_options);
    const ok = await c.request('POST', '/v1/auth/login/verify', { login_txn: b1.body.login_txn, sc: victim.card.sc, factor: { type: 'passkey', assertion } });
    expect(ok.status).toBe(200);
    const again = await new Client(t).request('POST', '/v1/auth/login/verify', { login_txn: b1.body.login_txn, sc: victim.card.sc, factor: { type: 'passkey', assertion } });
    expect(again.status).toBe(401);
    const c2 = new Client(t);
    const b2 = await c2.request('POST', '/v1/auth/login/begin', { card_number: victim.card.number });
    const replay = await c2.request('POST', '/v1/auth/login/verify', { login_txn: b2.body.login_txn, sc: victim.card.sc, factor: { type: 'passkey', assertion } });
    expect(replay.status).toBe(401);
    expect(c2.cookie).toBeNull();
  });

  it('control: the same card and SC WITH its own passkey does sign in', async () => {
    const { res, client } = await tryLogin(t, victim.card.number, victim.card.sc, { passkey: victim.passkey });
    expect(res.status).toBe(200);
    expect(client.cookie).toBeTruthy();
  });
});

describe('every endpoint: card number + SC presented any other way never opens anything', () => {
  it('for all 169 operations: no 2xx on a protected route and no session cookie anywhere', async () => {
    const digits = victim.card.number.replace(/\D/g, '');
    const basic = Buffer.from(`${digits}:${victim.card.sc}`).toString('base64');
    const before = await sessionsOf(victim.card.id);
    let checked = 0;
    for (const op of t.app.http.contract.operations.values()) {
      const url = op.path.replace(/\{[a-z_]+\}/g, (m) => (m === '{role_key}' ? 'admin' : randomUUID()));
      for (const variant of ['headers', 'cookie', 'body'] as const) {
        const res = await t.app.http.app.inject({
          method: op.method,
          url: variant === 'body' && op.method === 'GET' ? `${url}?card_number=${digits}&sc=${victim.card.sc}` : url,
          headers: {
            origin: TEST_ORIGIN,
            ...(variant === 'headers'
              ? { authorization: `Basic ${basic}`, 'x-card-number': digits, 'x-sc': victim.card.sc, 'x-csrf-token': victim.card.sc, 'idempotency-key': 'card-sc-alone-probe' }
              : {}),
          },
          ...(variant === 'cookie' ? { cookies: { [SESSION_COOKIE]: `${digits}:${victim.card.sc}`, card_number: digits, sc: victim.card.sc } } : {}),
          ...(variant === 'body' && op.method !== 'GET' ? { payload: { card_number: digits, sc: victim.card.sc } } : {}),
        });
        checked += 1;
        expect(res.cookies.find((c) => c.name === SESSION_COOKIE), `${op.operationId} set a session cookie`).toBeUndefined();
        if (!op.isPublic) {
          expect(res.statusCode, `${op.operationId} (${variant}) answered ${res.statusCode}`).toBeGreaterThanOrEqual(400);
          expect(res.statusCode).toBeLessThan(500);
        }
      }
    }
    expect(checked).toBe(169 * 3);
    expect(await sessionsOf(victim.card.id)).toBe(before);
  });

  it('enrollment: card number + SC without a valid enrollment token adds no factor', async () => {
    const creds = async () => (await su.query('SELECT count(*)::int AS n FROM credentials WHERE card_id = $1', [victim.card.id])).rows[0].n;
    const before = await creds();
    const c = new Client(t);
    const noToken = await c.request('POST', '/v1/auth/enrollment/begin', { card_number: victim.card.number, sc: victim.card.sc, factor_type: 'passkey' });
    expect(noToken.status).toBe(400);
    const wrongToken = await c.request('POST', '/v1/auth/enrollment/begin', {
      card_number: victim.card.number, sc: victim.card.sc, enrollment_token: 'x'.repeat(43), factor_type: 'passkey',
    });
    expect(wrongToken.status).toBe(401);
    // The token that was used at first enrollment cannot be used again.
    const usedToken = await c.request('POST', '/v1/auth/enrollment/begin', {
      card_number: victim.card.number, sc: victim.card.sc, enrollment_token: victim.card.enrollmentToken, factor_type: 'totp',
    });
    expect(usedToken.status).toBe(401);
    expect(await creds()).toBe(before);
  });
});

describe('by construction: a session cannot be created without a verified strong factor', () => {
  const ctx = () => ({ requestId: 'test', ip: '127.0.0.1', userAgent: 'test', now: new Date() });

  it('the proof objects cannot be forged', () => {
    expect(() => new StrongFactorProof(Symbol('StrongFactorProof'), victim.card.id, randomUUID(), 'passkey')).toThrow();
    expect(() => new (StrongFactorProof as any)(undefined, victim.card.id, randomUUID(), 'passkey')).toThrow();
    expect(() => new ScProof(Symbol('ScProof'), victim.card.id)).toThrow();
  });

  it('VerifiedLogin refuses anything that is not a real StrongFactorProof plus a real ScProof', () => {
    const fakeStrong = { cardId: victim.card.id, credentialId: randomUUID(), factorType: 'passkey' };
    const fakeSc = { cardId: victim.card.id };
    expect(() => new VerifiedLogin(tenant.tenantId, fakeStrong as never, fakeSc as never)).toThrow(/strong factor/);
    expect(() => new VerifiedLogin(tenant.tenantId, Object.create(StrongFactorProof.prototype), fakeSc as never)).toThrow(/secret code/);
    expect(() => new VerifiedLogin(tenant.tenantId, null as never, null as never)).toThrow();
  });

  it('createSession refuses anything that is not a VerifiedLogin, and writes nothing', async () => {
    const before = await sessionsOf(victim.card.id);
    for (const fake of [{ cardId: victim.card.id, tenantId: tenant.tenantId, credentialId: randomUUID() }, Object.create(null), null, undefined, 'login']) {
      await expect(t.app.db.withTenantTx(tenant.tenantId, async (tx) =>
        createSession(tx, fake as never, ctx(), await getSettings(tx, tenant.tenantId), Buffer.alloc(32)))).rejects.toThrow(/VerifiedLogin/);
    }
    expect(await sessionsOf(victim.card.id)).toBe(before);
  });

  it('source check: exactly one place inserts sessions, and the proofs are minted only in their own files', () => {
    const root = path.resolve(import.meta.dirname, '..', '..', 'src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(dir, e.name));
        else if (e.name.endsWith('.ts')) files.push(path.join(dir, e.name));
      }
    };
    walk(root);
    const where = (needle: RegExp): string[] =>
      files.filter((f) => needle.test(readFileSync(f, 'utf8'))).map((f) => path.relative(root, f).replaceAll('\\', '/'));

    expect(where(/INSERT INTO sessions/i)).toEqual(['modules/identity-access/internal/sessions.ts']);
    expect(where(/new VerifiedLogin\(/)).toEqual(['modules/identity-access/internal/auth.ts']);
    expect(where(/new StrongFactorProof\(/)).toEqual(['modules/identity-access/internal/factors.ts']);
    expect(where(/new ScProof\(/)).toEqual(['modules/identity-access/internal/secret-code.ts']);
    expect(where(/createSession\(/).sort()).toEqual(['modules/identity-access/internal/auth.ts', 'modules/identity-access/internal/sessions.ts']);
    // The session cookie is set in exactly one place, and only login asks for it (plus rotation on privilege change).
    expect(where(/setSessionCookie:/).sort()).toEqual([
      'modules/identity-access/internal/auth.ts', 'modules/identity-access/internal/routes.ts',
    ]);
  });
});
