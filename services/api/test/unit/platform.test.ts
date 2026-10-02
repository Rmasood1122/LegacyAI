// Unit tests for platform pieces that need no database: config loader (fail closed),
// log redaction, audit detail allow-list, idempotency secret stripping.
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  canonicalDetails, ConfigError, createLogger, loadConfig, scrub, scrubString, Secret, stripOneTimeSecrets,
} from '../../src/modules/platform/index.ts';
import { testEnv } from '../helpers/env.ts';

describe('config loader fails closed', () => {
  it('accepts a complete configuration', () => {
    const c = loadConfig(testEnv());
    expect(c.env).toBe('test');
    expect(c.argon2.memoryKiB).toBe(19456);
    expect(c.allowedOrigins).toEqual(['https://app.legacyai.test']);
  });

  const SECRETS = ['DATABASE_URL', 'SC_PEPPER_KEYRING', 'CREDENTIAL_ENC_KEYRING', 'HMAC_INDEX_KEY', 'INTERNAL_SERVICE_TOKEN'];
  const garbage: Array<[string, string | undefined]> = [['missing', undefined], ['empty', ''], ['whitespace', '   ']];
  for (const name of [...SECRETS, 'NODE_ENV', 'ALLOWED_ORIGINS', 'WEBAUTHN_RP_ID']) {
    it.each(garbage)(`refuses to start when ${name} is %s`, (_label, value) => {
      expect(() => loadConfig(testEnv({ [name]: value }))).toThrow(ConfigError);
    });
  }

  it.each([
    ['DATABASE_URL not a postgres URL', { DATABASE_URL: 'mysql://x' }],
    ['pepper keyring not JSON', { SC_PEPPER_KEYRING: 'v1=abc' }],
    ['pepper keyring is an array', { SC_PEPPER_KEYRING: '[]' }],
    ['pepper keyring current key absent', { SC_PEPPER_KEYRING: JSON.stringify({ current: 'v2', keys: { v1: Buffer.alloc(32, 1).toString('base64') } }) }],
    ['pepper key too short', { SC_PEPPER_KEYRING: JSON.stringify({ current: 'v1', keys: { v1: Buffer.alloc(16, 1).toString('base64') } }) }],
    ['pepper key not base64', { SC_PEPPER_KEYRING: JSON.stringify({ current: 'v1', keys: { v1: '!!!not base64!!!' } }) }],
    ['pepper key is a number', { SC_PEPPER_KEYRING: JSON.stringify({ current: 'v1', keys: { v1: 12345 } }) }],
    ['encryption key not exactly 32 bytes', { CREDENTIAL_ENC_KEYRING: JSON.stringify({ current: 'k1', keys: { k1: Buffer.alloc(48, 1).toString('base64') } }) }],
    ['HMAC key too short', { HMAC_INDEX_KEY: Buffer.alloc(8, 1).toString('base64') }],
    ['service token too short', { INTERNAL_SERVICE_TOKEN: 'short' }],
    ['wildcard origin', { ALLOWED_ORIGINS: '*' }],
    ['wildcard subdomain origin', { ALLOWED_ORIGINS: 'https://*.example.test' }],
    ['plain http origin', { ALLOWED_ORIGINS: 'http://app.example.test' }],
    ['origin with a path', { ALLOWED_ORIGINS: 'https://app.example.test/login' }],
    ['Argon2 memory below the OWASP floor', { ARGON2_MEMORY_KIB: '4096' }],
    ['Argon2 iterations below the floor', { ARGON2_ITERATIONS: '1' }],
    ['Argon2 memory not a number', { ARGON2_MEMORY_KIB: 'lots' }],
    ['Argon2 memory negative', { ARGON2_MEMORY_KIB: '-19456' }],
    ['port not a number', { PORT: 'http' }],
    ['port out of range', { PORT: '70000' }],
    ['boolean typo', { TRUST_PROXY: 'yes' }],
    ['unknown environment', { NODE_ENV: 'staging' }],
    ['unknown log level', { LOG_LEVEL: 'chatty' }],
  ])('refuses: %s', (_name, override) => {
    expect(() => loadConfig(testEnv(override))).toThrow(ConfigError);
  });

  it('the documented .env.example is a complete, valid configuration (so the quick-start works as written)', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    const env: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1] as string] = m[2] as string;
    }
    const c = loadConfig(env);
    expect(c.env).toBe('development');
    expect(c.scPepper.currentId).toBe('v1');
    // and every value in it is visibly fake
    expect(text).toMatch(/FAKE PLACEHOLDER/);
    for (const key of ['SC_PEPPER_KEYRING', 'CREDENTIAL_ENC_KEYRING', 'HMAC_INDEX_KEY']) {
      const b64 = /[A-Za-z0-9+/]{20,}=*/.exec(env[key] as string)?.[0] as string;
      expect(Buffer.from(b64, 'base64').toString('utf8')).toMatch(/^FAKE-/);
    }
  });

  it('error messages name the variable and never contain its value', () => {
    const secretValue = 'postgres-url-with-password-S3CR3T';
    try {
      loadConfig(testEnv({ DATABASE_URL: secretValue, INTERNAL_SERVICE_TOKEN: 'tiny-S3CR3T' }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain('DATABASE_URL');
      expect((e as Error).message).not.toContain('S3CR3T');
    }
  });

  it('secrets do not leak when the config object is printed', () => {
    const c = loadConfig(testEnv());
    const printed = `${JSON.stringify(c)} ${inspect(c, { depth: 10 })} ${String(c.databaseUrl)} ${`${c.internalServiceToken}`}`;
    expect(printed).not.toContain('local-test-app-password');
    expect(printed).not.toContain('test-internal-service-token');
    expect(printed).toContain('[redacted]');
    expect(new Secret('x').reveal()).toBe('x');
  });
});

describe('log redaction', () => {
  it('removes values under sensitive keys, at any depth', () => {
    const out = scrub({
      sc: '123', nested: { enrollment_token: 'ZZTOKENVALUE', deeper: [{ authorization: 'Bearer abc', ok: 'fine' }] },
      email: 'person@example.test', display_name: 'Some Person', cookie: 'c', totp_code: '000000',
    }) as any;
    expect(out.sc).toBe('[redacted]');
    expect(out.nested.enrollment_token).toBe('[redacted]');
    expect(out.nested.deeper[0].authorization).toBe('[redacted]');
    expect(out.nested.deeper[0].ok).toBe('fine');
    expect(out.email).toBe('[redacted]');
    expect(out.display_name).toBe('[redacted]');
    expect(JSON.stringify(out)).not.toMatch(/123|ZZTOKENVALUE|Bearer|person@|Some Person|000000/);
  });

  it('masks card numbers wherever they appear in text', () => {
    for (const s of ['4821937601527730', 'LGY-4821-9376-0152-7730', '4821 9376 0152 7730', 'card 4821-9376-0152-7730 failed']) {
      expect(scrubString(s)).not.toMatch(/\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}/);
    }
    expect(scrubString('request 42 took 17 ms')).toBe('request 42 took 17 ms');
  });

  it('runs in linear time on hostile input (regression: an unbounded pattern once took 30 s on 70 KB)', () => {
    for (const hostile of ['y'.repeat(500_000), 'a:'.repeat(200_000), '1234 '.repeat(100_000), 'x://'.repeat(100_000), `${'a'.repeat(100_000)}://u:p@h`]) {
      const started = process.hrtime.bigint();
      const out = scrubString(hostile);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      expect(ms, `scrub took ${ms.toFixed(0)} ms`).toBeLessThan(250);
      expect(out.length).toBeLessThanOrEqual(8_100);
    }
  });

  it('masks connection strings that carry a password', () => {
    expect(scrubString('could not connect to postgres://app:s3cretpw@db.internal:5432/x')).toBe('could not connect to [connection-string]');
    expect(scrubString('see https://example.test/docs')).toBe('see https://example.test/docs');
  });

  it('handles errors, buffers, cycles-by-depth and odd values without throwing', () => {
    const deep: any = {};
    let cur = deep;
    for (let i = 0; i < 20; i += 1) { cur.next = {}; cur = cur.next; }
    expect(() => scrub(deep)).not.toThrow();
    expect(scrub(Buffer.from('secret'))).toBe('[bytes]');
    expect((scrub(new Error('card 4821937601527730')) as any).message).toBe('card [card-number]');
    expect(scrub(undefined)).toBeUndefined();
    expect(scrub(10n)).toBe('10');
  });

  it('the real logger applies both layers', () => {
    const lines: string[] = [];
    const log = createLogger('info', { write: (l: string) => void lines.push(l) });
    log.info({ sc: '987', body: { enrollment_token: 'ENROLL-TOKEN-VALUE' }, note: 'LGY-4821-9376-0152-7730' }, 'login for 4821937601527730');
    const text = lines.join('');
    expect(text).not.toMatch(/987|ENROLL-TOKEN-VALUE|4821/);
    expect(text).toContain('[redacted]');
    expect(text).toContain('[card-number]');
    expect(JSON.parse(lines[0] as string).level).toBe('info');
  });
});

describe('audit details allow-list', () => {
  it('produces canonical JSON with sorted keys', () => {
    expect(canonicalDetails({ state_to: 'active', state_from: 'issued' })).toBe('{"state_from":"issued","state_to":"active"}');
    expect(canonicalDetails(undefined)).toBe('{}');
  });

  it('rejects keys that are not on the allow-list (so secrets cannot be written by accident)', () => {
    expect(() => canonicalDetails({ sc: '123' } as never)).toThrow();
    expect(() => canonicalDetails({ email: 'a@b.test' } as never)).toThrow();
    expect(() => canonicalDetails({ token: 'x' } as never)).toThrow();
  });

  it('rejects values that look like a card number or are very long', () => {
    expect(() => canonicalDetails({ reason: 'card 4821937601527730' })).toThrow();
    expect(() => canonicalDetails({ reason: 'x'.repeat(500) })).toThrow();
  });
});

describe('idempotency replay never stores one-time secrets', () => {
  it('strips sc and enrollment tokens at any depth and marks the response', () => {
    const stored = stripOneTimeSecrets({
      card: { id: 'c1' }, sc: '123', enrollment_token: 'tok', enrollment_token_expires_at: 'x', secret_already_shown: false,
      nested: { owner_card: { card: { id: 'c2' }, sc: '456', secret_already_shown: false } },
    }) as any;
    expect(JSON.stringify(stored)).not.toMatch(/123|456|tok/);
    expect(stored.secret_already_shown).toBe(true);
    expect(stored.nested.owner_card.secret_already_shown).toBe(true);
    expect(stored.card.id).toBe('c1');
  });

  it('leaves ordinary responses unchanged', () => {
    expect(stripOneTimeSecrets({ id: 'x', items: [1, 2] })).toEqual({ id: 'x', items: [1, 2] });
    expect(stripOneTimeSecrets(null)).toBeNull();
  });
});
