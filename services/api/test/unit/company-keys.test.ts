// Bring-your-own-key (feature 21, D35): the key service stand-in and the per-company sealer, without a database (an
// in-memory stand-in for the one table). The routes and the places that seal secrets are tested against the database in
// test/integration/company-keys.test.ts. The keys below are random bytes made by the test, not real keys.
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError, EXPECTED_SCHEMA_VERSION, KeyUnavailable, loadConfig, LocalKeyService, NoKeyService, SealingCipher, Secret, TenantSealing,
  type CompanyKeyRow, type Tx,
} from '../../src/modules/platform/index.ts';
import { testEnv } from '../helpers/env.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const keys = (): LocalKeyService => new LocalKeyService(new Map([['acme', new Secret(randomBytes(32))], ['spare', new Secret(randomBytes(32))]]));
const platform = new SealingCipher({ currentId: 'p1', keys: new Map([['p1', new Secret(randomBytes(32))]]) });

/** The one table, in memory, answering exactly the statements TenantSealing makes. */
class FakeTx implements Tx {
  readonly rows: Array<CompanyKeyRow & { tenant_id: string }> = [];
  async query<R>(sql: string, params: unknown[] = []): Promise<{ rows: R[]; rowCount: number }> {
    const mine = this.rows.filter((r) => r.tenant_id === params[0]);
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
    if (sql.startsWith('SELECT version, key_ref')) return { rows: [...mine].sort((a, b) => b.version - a.version) as unknown as R[], rowCount: mine.length };
    if (sql.startsWith('SELECT coalesce(max(version)')) return { rows: [{ v: Math.max(0, ...mine.map((r) => r.version)) + 1 }] as unknown as R[], rowCount: 1 };
    if (sql.startsWith('UPDATE company_data_keys SET retired_at')) {
      const live = mine.filter((r) => r.retired_at === null);
      for (const r of live) r.retired_at = params[1] as Date;
      return { rows: [], rowCount: live.length };
    }
    if (sql.startsWith('INSERT INTO company_data_keys')) {
      const [tenant_id, version, key_ref, wrapped_key, created_at] = params as [string, number, string, Buffer, Date];
      this.rows.push({ tenant_id, version, key_ref, wrapped_key, created_at, retired_at: null });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`FakeTx: unexpected statement ${sql}`);
  }
}

describe('the key service stand-in', () => {
  it('wraps and unwraps a data key; the wrapped key is bound to its company and version', async () => {
    const ks = keys();
    const data = randomBytes(32);
    const wrapped = await ks.wrap('local:acme', data, 'company-data-key:a:1');
    expect(wrapped.includes(data)).toBe(false);
    expect((await ks.unwrap('local:acme', wrapped, 'company-data-key:a:1')).equals(data)).toBe(true);
    await expect(ks.unwrap('local:acme', wrapped, 'company-data-key:b:1')).rejects.toBeInstanceOf(KeyUnavailable);
    await expect(ks.unwrap('local:spare', wrapped, 'company-data-key:a:1')).rejects.toBeInstanceOf(KeyUnavailable);
  });

  it('a key switched off at the service opens nothing until it is switched on again', async () => {
    const ks = keys();
    const wrapped = await ks.wrap('local:acme', randomBytes(32), 'x');
    ks.disable('acme');
    await expect(ks.unwrap('local:acme', wrapped, 'x')).rejects.toThrow(/switched off/);
    await expect(ks.wrap('local:acme', randomBytes(32), 'x')).rejects.toBeInstanceOf(KeyUnavailable);
    ks.enable('acme');
    expect((await ks.unwrap('local:acme', wrapped, 'x')).length).toBe(32);
  });

  it('references: only local:<name>; an unknown name is unavailable; with no key service nothing works', async () => {
    const ks = keys();
    expect(['local:acme', 'local:a-1'].map((r) => ks.validRef(r))).toEqual([true, true]);
    expect(['acme', 'local:', 'local:ACME', 'projects/x/keys/y', 'local:a b'].map((r) => ks.validRef(r))).toEqual([false, false, false, false, false]);
    await expect(ks.wrap('local:nobody', randomBytes(32), 'x')).rejects.toThrow(/unknown key/);
    const none = new NoKeyService();
    expect(none.validRef('local:acme')).toBe(false);
    await expect(none.wrap()).rejects.toBeInstanceOf(KeyUnavailable);
  });
});

describe('a company\'s sealer', () => {
  const setUp = async (cacheSeconds = 0) => {
    const ks = keys();
    const sealing = new TenantSealing({ platform, keys: ks, cacheSeconds });
    const tx = new FakeTx();
    return { ks, sealing, tx };
  };

  it('without its own key a company is sealed with the platform key, as before', async () => {
    const { sealing, tx } = await setUp();
    const sealer = await sealing.forTenant(tx, TENANT);
    const sealed = sealer.encrypt('seed', 'aad');
    expect(sealed.keyId).toBe('p1');
    expect(sealer.decrypt(sealed.ciphertext, sealed.keyId, 'aad')).toBe('seed');
  });

  it('with its own key: new secrets are sealed with the company\'s data key; old ones still open with the platform key', async () => {
    const { sealing, tx } = await setUp();
    const before = (await sealing.forTenant(tx, TENANT)).encrypt('old seed', 'aad');
    expect(await sealing.setKey(tx, TENANT, 'local:acme', new Date())).toEqual({ version: 1 });
    const sealer = await sealing.forTenant(tx, TENANT);
    const after = sealer.encrypt('new seed', 'aad');
    expect(after.keyId).toBe('company:1');
    expect(sealer.decrypt(after.ciphertext, after.keyId, 'aad')).toBe('new seed');
    expect(sealer.decrypt(before.ciphertext, before.keyId, 'aad')).toBe('old seed');
    // the platform key alone cannot open what the company's key sealed
    expect(platform.decrypt(after.ciphertext, after.keyId, 'aad')).toBeNull();
    expect(sealing.platform.decrypt(after.ciphertext, 'p1', 'aad')).toBeNull();
  });

  it('the company switches its key off: nothing of it opens, and nothing new is sealed with the platform key instead', async () => {
    const { ks, sealing, tx } = await setUp();
    await sealing.setKey(tx, TENANT, 'local:acme', new Date());
    const sealed = (await sealing.forTenant(tx, TENANT)).encrypt('seed', 'aad');
    ks.disable('acme');
    const off = await sealing.forTenant(tx, TENANT);
    // callers learn it is an outage, not a mistake: no wrong code is counted, no delivery attempt used up
    expect(off.unavailable).toBe(true);
    expect(off.decrypt(sealed.ciphertext, sealed.keyId, 'aad')).toBeNull();
    expect(() => off.encrypt('another', 'aad')).toThrow(expect.objectContaining({ status: 503, code: 'company-key-unavailable' }));
    ks.enable('acme');
    const on = await sealing.forTenant(tx, TENANT);
    expect(on.unavailable).toBe(false);
    expect(on.decrypt(sealed.ciphertext, sealed.keyId, 'aad')).toBe('seed');
  });

  it('a change of key retires the live version; what the old version sealed opens while the old key works', async () => {
    const { ks, sealing, tx } = await setUp();
    await sealing.setKey(tx, TENANT, 'local:acme', new Date());
    const v1 = (await sealing.forTenant(tx, TENANT)).encrypt('one', 'aad');
    expect(await sealing.setKey(tx, TENANT, 'local:spare', new Date())).toEqual({ version: 2 });
    const sealer = await sealing.forTenant(tx, TENANT);
    expect(sealer.encrypt('two', 'aad').keyId).toBe('company:2');
    expect(sealer.decrypt(v1.ciphertext, v1.keyId, 'aad')).toBe('one');
    expect(tx.rows.map((r) => [r.version, r.retired_at === null])).toEqual([[1, false], [2, true]]);
    ks.disable('acme');
    expect((await sealing.forTenant(tx, TENANT)).decrypt(v1.ciphertext, v1.keyId, 'aad')).toBeNull();
    // back to none: new secrets go to the platform key again
    expect(await sealing.setKey(tx, TENANT, null, new Date())).toEqual({ version: null });
    expect((await sealing.forTenant(tx, TENANT)).encrypt('three', 'aad').keyId).toBe('p1');
  });

  it('a key that does not work, or a reference the service cannot use, is refused before anything is sealed with it', async () => {
    const { ks, sealing, tx } = await setUp();
    ks.disable('acme');
    expect(await sealing.setKey(tx, TENANT, 'local:acme', new Date())).toBe('unavailable');
    expect(await sealing.setKey(tx, TENANT, 'local:nobody', new Date())).toBe('unavailable');
    expect(await sealing.setKey(tx, TENANT, 'projects/p/keys/k', new Date())).toBe('bad-ref');
    expect(tx.rows).toEqual([]);
  });

  it('a wrapped data key copied to another company does not open there', async () => {
    const { sealing, tx } = await setUp();
    await sealing.setKey(tx, TENANT, 'local:acme', new Date());
    const row = tx.rows[0] as CompanyKeyRow & { tenant_id: string };
    tx.rows.push({ ...row, tenant_id: OTHER });
    const sealed = (await sealing.forTenant(tx, TENANT)).encrypt('seed', 'aad');
    expect((await sealing.forTenant(tx, OTHER)).decrypt(sealed.ciphertext, sealed.keyId, 'aad')).toBeNull();
  });

  it('unwrapped keys are kept for the cache time: switching the key off takes effect when that runs out', async () => {
    const { ks, sealing, tx } = await setUp(300);
    await sealing.setKey(tx, TENANT, 'local:acme', new Date());
    const sealed = (await sealing.forTenant(tx, TENANT)).encrypt('seed', 'aad');
    ks.disable('acme');
    expect((await sealing.forTenant(tx, TENANT)).decrypt(sealed.ciphertext, sealed.keyId, 'aad')).toBe('seed');   // still cached
  });
});

describe('configuration', () => {
  const LOCAL = JSON.stringify({ acme: randomBytes(32).toString('base64') });
  it('KEY_SERVICE defaults to none; local needs its keys and is refused in production', () => {
    expect(loadConfig(testEnv()).keyService.kind).toBe('none');
    expect(loadConfig(testEnv({ KEY_SERVICE: 'local', LOCAL_KEY_SERVICE_KEYS: LOCAL })).keyService.localKeys.size).toBe(1);
    expect(() => loadConfig(testEnv({ KEY_SERVICE: 'local' }))).toThrow(ConfigError);
    expect(() => loadConfig(testEnv({ KEY_SERVICE: 'local', LOCAL_KEY_SERVICE_KEYS: JSON.stringify({ acme: 'c2hvcnQ=' }) }))).toThrow(/LOCAL_KEY_SERVICE_KEYS/);
    expect(() => loadConfig(testEnv({ KEY_SERVICE: 'local', LOCAL_KEY_SERVICE_KEYS: LOCAL, NODE_ENV: 'production' }))).toThrow(/not allowed when NODE_ENV=production/);
  });
});

describe('the readiness check expects the newest migration', () => {
  it('EXPECTED_SCHEMA_VERSION is the version of the newest file in db/migrations (found missing once: SSO did not raise it)', () => {
    const files = readdirSync(path.resolve(import.meta.dirname, '..', '..', '..', '..', 'db', 'migrations')).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort();
    expect(EXPECTED_SCHEMA_VERSION).toBe(files[files.length - 1]?.slice(0, 14));
  });
});
