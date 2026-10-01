import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ScProof, SecretCodeHasher } from '../../src/modules/identity-access/index.ts';
import { ARGON2_FLOOR, Secret, type Keyring } from '../../src/modules/platform/index.ts';

const key = (seed: string): Secret<Buffer> => new Secret(Buffer.from(seed.repeat(8).slice(0, 32)));
const ring = (current: string, ids: string[]): Keyring => ({ currentId: current, keys: new Map(ids.map((id) => [id, key(`pepper-${id}-`)])) });
const params = { ...ARGON2_FLOOR, maxConcurrency: 4 };

describe('SC hashing', () => {
  const hasher = new SecretCodeHasher(ring('v1', ['v1']), params);
  const cardA = randomUUID();
  const cardB = randomUUID();

  it('generates 3-digit codes from 000 to 999', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i += 1) {
      const sc = hasher.generate();
      expect(sc).toMatch(/^[0-9]{3}$/);
      seen.add(sc);
    }
    expect(seen.size).toBeGreaterThan(900); // of 1000 possible
  });

  it('stores an Argon2id hash at or above the OWASP minimum, never the code', async () => {
    const { hash, pepperId } = await hasher.hash(cardA, '123');
    expect(pepperId).toBe('v1');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    // The parameters are recorded inside the hash (order of m/t/p is the library's choice).
    const recorded = Object.fromEntries((hash.split('$')[3] as string).split(',').map((kv) => kv.split('=')));
    expect(recorded).toEqual({ m: '19456', t: '2', p: '1' });
    expect(hash).not.toContain('123');
  });

  it('accepts the right code and rejects every other one of the 1,000 (sampled: 25 wrong codes)', async () => {
    const stored = await hasher.hash(cardA, '123');
    const ok = await hasher.verify(cardA, '123', { hash: stored.hash, pepperId: stored.pepperId });
    expect(ok.proof).toBeInstanceOf(ScProof);
    expect(ok.proof?.cardId).toBe(cardA);
    for (let i = 0; i < 25; i += 1) {
      const wrong = String((124 + i * 37) % 1000).padStart(3, '0');
      const res = await hasher.verify(cardA, wrong, { hash: stored.hash, pepperId: stored.pepperId });
      expect(res.proof, `wrong code ${wrong} was accepted`).toBeNull();
    }
  });

  it('gives different hashes for the same code on two cards, and for the same card twice (unique salt)', async () => {
    const a1 = await hasher.hash(cardA, '555');
    const a2 = await hasher.hash(cardA, '555');
    const b = await hasher.hash(cardB, '555');
    expect(a1.hash).not.toBe(a2.hash);
    expect(a1.hash).not.toBe(b.hash);
  });

  it('a hash copied to another card does not verify (card id is bound into the HMAC)', async () => {
    const stored = await hasher.hash(cardA, '555');
    const res = await hasher.verify(cardB, '555', { hash: stored.hash, pepperId: stored.pepperId });
    expect(res.proof).toBeNull();
  });

  it('never authenticates on missing or malformed input', async () => {
    const stored = await hasher.hash(cardA, '123');
    expect((await hasher.verify(null, '123', { hash: stored.hash, pepperId: 'v1' })).proof).toBeNull();
    expect((await hasher.verify(cardA, '123', null)).proof).toBeNull();
    expect((await hasher.verify(cardA, '123', { hash: 'not-a-hash', pepperId: 'v1' })).proof).toBeNull();
    expect((await hasher.verify(cardA, '123', { hash: '', pepperId: 'v1' })).proof).toBeNull();
    expect((await hasher.verify(cardA, '', { hash: stored.hash, pepperId: 'v1' })).proof).toBeNull();
    await expect(hasher.hash(cardA, '12')).rejects.toThrow();
    await expect(hasher.hash(cardA, '1234')).rejects.toThrow();
    await expect(hasher.hash(cardA, 'abc')).rejects.toThrow();
  });

  it('a ScProof cannot be forged', () => {
    expect(() => new ScProof(Symbol('ScProof'), cardA)).toThrow();
    expect(() => new (ScProof as any)(undefined, cardA)).toThrow();
  });
});

describe('the pepper', () => {
  const card = randomUUID();

  it('is REQUIRED to verify: the same database row is useless with a different pepper', async () => {
    const real = new SecretCodeHasher(ring('v1', ['v1']), params);
    const stored = await real.hash(card, '042');
    // An attacker who stole the database but not the pepper: every one of the 1,000 guesses fails.
    const attacker = new SecretCodeHasher({ currentId: 'v1', keys: new Map([['v1', key('attacker-guess-')]]) }, params);
    expect((await attacker.verify(card, '042', { hash: stored.hash, pepperId: 'v1' })).proof).toBeNull();
    expect((await real.verify(card, '042', { hash: stored.hash, pepperId: 'v1' })).proof).not.toBeNull();
  });

  it('rotation: a hash made under v1 still verifies when v2 is current, and is flagged for re-hash', async () => {
    const old = new SecretCodeHasher(ring('v1', ['v1']), params);
    const stored = await old.hash(card, '777');
    const rotated = new SecretCodeHasher(ring('v2', ['v1', 'v2']), params);
    const res = await rotated.verify(card, '777', { hash: stored.hash, pepperId: stored.pepperId });
    expect(res.proof).not.toBeNull();
    expect(res.needsRehash).toBe(true);
    const upgraded = await rotated.hash(card, '777');
    expect(upgraded.pepperId).toBe('v2');
    const again = await rotated.verify(card, '777', { hash: upgraded.hash, pepperId: upgraded.pepperId });
    expect(again.proof).not.toBeNull();
    expect(again.needsRehash).toBe(false);
  });

  it('an unknown pepper id fails closed', async () => {
    const old = new SecretCodeHasher(ring('v1', ['v1']), params);
    const stored = await old.hash(card, '777');
    const withoutOld = new SecretCodeHasher(ring('v2', ['v2']), params);
    expect((await withoutOld.verify(card, '777', { hash: stored.hash, pepperId: 'v1' })).proof).toBeNull();
    expect((await withoutOld.verify(card, '777', { hash: stored.hash, pepperId: 'nope' })).proof).toBeNull();
  });
});

describe('Argon2 parameter floor', () => {
  const good = ring('v1', ['v1']);
  it.each([
    ['memory below 19 MiB', { ...params, memoryKiB: 19455 }],
    ['1 iteration', { ...params, iterations: 1 }],
    ['parallelism 0', { ...params, parallelism: 0 }],
    ['NaN memory', { ...params, memoryKiB: Number.NaN }],
    ['fractional iterations', { ...params, iterations: 2.5 }],
    ['zero concurrency', { ...params, maxConcurrency: 0 }],
  ])('refuses to start with %s', (_name, bad) => {
    expect(() => new SecretCodeHasher(good, bad)).toThrow();
  });

  it('refuses a keyring whose current key is missing', () => {
    expect(() => new SecretCodeHasher({ currentId: 'v9', keys: new Map() }, params)).toThrow();
  });
});
