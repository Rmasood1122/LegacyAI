// Rate limiting: by IP, globally, and (for TOTP guessing) by card - see lockout.test.ts.
// Limits answer with one uniform 429 whether or not the card exists.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_AUTH_LIMITS } from '../../src/modules/identity-access/index.ts';
import { PostgresRateLimiter } from '../../src/modules/platform/index.ts';
import { Client, createTenant, startApp, type Res, type TestApp, type TestTenant } from '../helpers/harness.ts';

let seed: TestApp;
let tenant: TestTenant;
beforeAll(async () => {
  seed = await startApp();
  tenant = await createTenant(seed, 'ratelimit');
});
afterAll(async () => seed.close());

const HUGE = { limit: 1_000_000, windowSeconds: 60 };
const from = (t: TestApp, ip: string): Client => {
  const c = new Client(t);
  c.ip = ip;
  return c;
};
const strip = (r: Res): unknown => ({ ...r.body, request_id: '-' });

describe('login rate limit per IP', () => {
  it('the 6th attempt in the window gets a uniform 429 - identical for a real and an unknown card - and other IPs are unaffected', async () => {
    const t = await startApp({ authLimits: { ...DEFAULT_AUTH_LIMITS, loginPerIp: { limit: 5, windowSeconds: 300 }, loginGlobal: HUGE } });
    try {
      const ip = '198.51.100.10';
      for (let i = 0; i < 5; i += 1) {
        expect((await from(t, ip).request('POST', '/v1/auth/login/begin', { card_number: tenant.ownerCard.number })).status).toBe(200);
      }
      const known = await from(t, ip).request('POST', '/v1/auth/login/begin', { card_number: tenant.ownerCard.number });
      const unknown = await from(t, ip).request('POST', '/v1/auth/login/begin', { card_number: '0000 0000 0000 0000' });
      const verify = await from(t, ip).request('POST', '/v1/auth/login/verify', { login_txn: 'A'.repeat(43), sc: '123', factor: { type: 'totp', code: '000000' } });
      const enroll = await from(t, ip).request('POST', '/v1/auth/enrollment/begin', { card_number: tenant.ownerCard.number, sc: '123', enrollment_token: 'x'.repeat(43), factor_type: 'totp' });
      for (const r of [known, unknown, verify, enroll]) {
        expect(r.status).toBe(429);
        expect(strip(r)).toEqual({ type: 'urn:legacyai:problem:rate-limited', title: 'Too many requests', status: 429, request_id: '-' });
        expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
        expect(Number(r.headers['retry-after'])).toBeLessThanOrEqual(300);
        expect(r.headers['content-type']).toContain('application/problem+json');
      }
      // a different address still gets through
      expect((await from(t, '198.51.100.11').request('POST', '/v1/auth/login/begin', { card_number: tenant.ownerCard.number })).status).toBe(200);
      // and the limit lifts when the window passes
      t.clock.advance(301_000);
      expect((await from(t, ip).request('POST', '/v1/auth/login/begin', { card_number: tenant.ownerCard.number })).status).toBe(200);
    } finally {
      await t.close();
    }
  });

  it('no hashing happens once the limit is reached (the limiter runs before the expensive work)', async () => {
    const t = await startApp({ authLimits: { ...DEFAULT_AUTH_LIMITS, loginPerIp: { limit: 2, windowSeconds: 300 }, loginGlobal: HUGE } });
    try {
      const ip = '198.51.100.20';
      await t.app.identity.hasher.warmUp(); // one-time preparation of the dummy hash, as at start-up
      const before = t.app.identity.hasher.computations;
      for (let i = 0; i < 10; i += 1) {
        await from(t, ip).request('POST', '/v1/auth/login/verify', { login_txn: 'A'.repeat(43), sc: '123', factor: { type: 'totp', code: '000000' } });
      }
      expect(t.app.identity.hasher.computations - before).toBe(2);
    } finally {
      await t.close();
    }
  });
});

describe('global login rate limit', () => {
  it('caps total attempts across ALL addresses (bounds total Argon2 work and cost)', async () => {
    const t = await startApp({ authLimits: { ...DEFAULT_AUTH_LIMITS, loginPerIp: HUGE, loginGlobal: { limit: 8, windowSeconds: 60 } } });
    try {
      // The global bucket is shared with any other app instance using this database: start a fresh window.
      t.clock.advance(3_600_000 * 24 * 400);
      const statuses: number[] = [];
      for (let i = 0; i < 12; i += 1) {
        statuses.push((await from(t, `203.0.113.${i + 1}`).request('POST', '/v1/auth/login/begin', { card_number: tenant.ownerCard.number })).status);
      }
      expect(statuses.filter((s) => s === 200)).toHaveLength(8);
      expect(statuses.filter((s) => s === 429)).toHaveLength(4);
      expect(statuses.slice(0, 8).every((s) => s === 200)).toBe(true);
    } finally {
      await t.close();
    }
  });
});

describe('general per-IP limit on every endpoint', () => {
  it('applies even to public endpoints and returns the same uniform 429', async () => {
    const t = await startApp({ generalLimit: { limit: 3, windowSeconds: 60 } });
    try {
      const ip = '198.51.100.30';
      for (let i = 0; i < 3; i += 1) expect((await from(t, ip).get('/v1/health')).status).toBe(200);
      const blocked = await from(t, ip).get('/v1/health');
      expect(blocked.status).toBe(429);
      expect(strip(blocked)).toEqual({ type: 'urn:legacyai:problem:rate-limited', title: 'Too many requests', status: 429, request_id: '-' });
      expect((await from(t, ip).get('/v1/cards')).status).toBe(429);
      expect((await from(t, '198.51.100.31').get('/v1/health')).status).toBe(200);
    } finally {
      await t.close();
    }
  });
});

describe('the limiter itself', () => {
  it('counts exactly, per key and per window, and stores no raw key', async () => {
    const limiter = new PostgresRateLimiter(seed.app.db, Buffer.alloc(32, 7));
    const now = new Date('2031-05-05T10:00:10Z');
    const key = `unit:${Math.random()}`;
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await limiter.hit(key, 3, 60, now));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results[3]!.retryAfterSeconds).toBe(50);
    expect((await limiter.hit(`${key}:other`, 3, 60, now)).allowed).toBe(true);
    expect((await limiter.hit(key, 3, 60, new Date('2031-05-05T10:01:00Z'))).allowed).toBe(true); // next window
    const raw = await seed.app.db.global<{ n: string }>(`SELECT count(*)::text AS n FROM rate_limit_buckets WHERE encode(bucket_key, 'escape') LIKE '%unit:%'`);
    expect(raw.rows[0]!.n).toBe('0');
  });

  it.each([
    ['NaN limit', Number.NaN, 60],
    ['negative limit', -1, 60],
    ['fractional limit', 2.5, 60],
    ['infinite limit', Number.POSITIVE_INFINITY, 60],
    ['zero-second window', 5, 0],
    ['NaN window', 5, Number.NaN],
  ])('garbage configuration (%s) blocks instead of meaning "unlimited"', async (_name, limit, window) => {
    const limiter = new PostgresRateLimiter(seed.app.db, Buffer.alloc(32, 7));
    expect((await limiter.hit('garbage', limit, window, new Date())).allowed).toBe(false);
  });

  it('a limit of zero allows nothing', async () => {
    const limiter = new PostgresRateLimiter(seed.app.db, Buffer.alloc(32, 7));
    expect((await limiter.hit(`zero:${Math.random()}`, 0, 60, new Date())).allowed).toBe(false);
  });
});
