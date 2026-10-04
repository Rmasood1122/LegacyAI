// Unit tests for platform pieces that need no database: config loader (fail closed),
// log redaction, audit detail allow-list, idempotency secret stripping.
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  canonicalDetails, ConfigError, createLogger, decodeCursor, decodeIdCursor, decodeNameCursor, encodeCursor, encodeNameCursor, loadConfig, scrub, scrubString, Secret, stripOneTimeSecrets, pageOf,
} from '../../src/modules/platform/index.ts';
import { checkedHeaderNames, declaredHeaders, NEVER_DECLARED_HEADERS } from '../../src/modules/platform/index.ts';
import { testEnv } from '../helpers/env.ts';

describe('config loader fails closed', () => {
  it('accepts a complete configuration', () => {
    const c = loadConfig(testEnv());
    expect(c.env).toBe('test');
    expect(c.argon2.memoryKiB).toBe(19456);
    expect(c.allowedOrigins).toEqual(['https://app.legacyai.test']);
    expect(c.trustProxyHops).toBe(0);
    expect(loadConfig(testEnv({ TRUST_PROXY: '1' })).trustProxyHops).toBe(1);
    expect(loadConfig(testEnv({ TRUST_PROXY: 'false' })).trustProxyHops).toBe(0);
    expect(() => loadConfig(testEnv({ NODE_ENV: 'production', PAYMENT_PROVIDER: undefined }))).not.toThrow();
    // the stand-in payment provider takes no money: it must never run where real companies renew
    expect(() => loadConfig(testEnv({ NODE_ENV: 'production' }))).toThrow(/PAYMENT_PROVIDER=fake/);
    // ... nor in development, nor with NODE_ENV left out: only where the automated tests run
    expect(() => loadConfig(testEnv({ NODE_ENV: 'development' }))).toThrow(/allowed only when NODE_ENV=test/);
    expect(() => loadConfig(testEnv({ NODE_ENV: undefined }))).toThrow(/PAYMENT_PROVIDER=fake/);
    expect(loadConfig(testEnv({ NODE_ENV: 'test' })).payment.provider).toBe('fake');
    expect(() => loadConfig(testEnv({ NODE_ENV: 'development', PAYMENT_PROVIDER: undefined }))).not.toThrow();
    expect(() => loadConfig(testEnv({ PAYMENT_EVENT_KEY: undefined }))).toThrow(/PAYMENT_EVENT_KEY is required/);
    expect(loadConfig(testEnv({ PAYMENT_PROVIDER: undefined, PAYMENT_EVENT_KEY: undefined })).payment).toEqual({ provider: 'none', eventKey: null });
  });

  const SECRETS = ['DATABASE_URL', 'SC_PEPPER_KEYRING', 'CREDENTIAL_ENC_KEYRING', 'HMAC_INDEX_KEY', 'SERVICE_TOKEN_KEY'];
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
    ['service token key too short', { SERVICE_TOKEN_KEY: 'short' }],
    ['AI service over plain http to another host', { AI_SERVICE_URL: 'http://ai.example.test' }],
    ['AI service URL with credentials', { AI_SERVICE_URL: 'https://user:pw@ai.example.test' }],
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
    ['proxy trust that is not a hop count', { TRUST_PROXY: 'yes' }],
    ['proxy trust "true" (would trust a caller-written X-Forwarded-For)', { TRUST_PROXY: 'true' }],
    ['proxy trust of too many hops', { TRUST_PROXY: '9' }],
    ['the placeholder keys from .env.example in production', { NODE_ENV: 'production', PAYMENT_PROVIDER: undefined, SC_PEPPER_KEYRING: JSON.stringify({ current: 'v1', keys: { v1: Buffer.from('FAKE-PEPPER-DO-NOT-USE-FAKE-PEPPER-').toString('base64') } }) }],
    ['the placeholder payment key from .env.example in production (it would make a forged "paid" message believable)', { NODE_ENV: 'production', PAYMENT_PROVIDER: undefined, PAYMENT_EVENT_KEY: Buffer.from('FAKE-PAYMENT-EVENT-KEY-DO-NOT-USE-FAKE-').toString('base64') }],
    ['boolean typo', { VALIDATE_RESPONSES: 'yes' }],
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
      loadConfig(testEnv({ DATABASE_URL: secretValue, SERVICE_TOKEN_KEY: 'tiny-S3CR3T' }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain('DATABASE_URL');
      expect((e as Error).message).not.toContain('S3CR3T');
    }
  });

  it('secrets do not leak when the config object is printed', () => {
    const c = loadConfig(testEnv());
    const printed = `${JSON.stringify(c)} ${inspect(c, { depth: 10 })} ${String(c.databaseUrl)} ${`${c.serviceTokenKey}`}`;
    expect(printed).not.toContain('local-test-app-password');
    expect(printed).not.toContain('test-service-token-key');
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

describe('grouped secrets (docs/phase2/01, "Secrets: five")', () => {
  it('the three API keys may arrive as one JSON value, API_KEYRINGS', () => {
    const env = testEnv();
    const bundled = testEnv({
      SC_PEPPER_KEYRING: undefined, CREDENTIAL_ENC_KEYRING: undefined, HMAC_INDEX_KEY: undefined,
      API_KEYRINGS: JSON.stringify({ SC_PEPPER_KEYRING: env.SC_PEPPER_KEYRING, CREDENTIAL_ENC_KEYRING: env.CREDENTIAL_ENC_KEYRING, HMAC_INDEX_KEY: env.HMAC_INDEX_KEY }),
    });
    const a = loadConfig(env);
    const b = loadConfig(bundled);
    expect(b.hmacIndexKey.reveal().equals(a.hmacIndexKey.reveal())).toBe(true);
    expect(b.scPepper.currentId).toBe(a.scPepper.currentId);
  });

  it('a malformed or unexpected bundle stops the service', () => {
    expect(() => loadConfig(testEnv({ API_KEYRINGS: '{not json' }))).toThrow(ConfigError);
    expect(() => loadConfig(testEnv({ API_KEYRINGS: JSON.stringify({ DATABASE_URL: 'postgres://x' }) }))).toThrow(ConfigError);
  });

  it('the AI service identity mode is none unless the cloud asks for Google identity tokens', () => {
    expect(loadConfig(testEnv()).aiServiceIdentity).toBe('none');
    expect(loadConfig(testEnv({ AI_SERVICE_IDENTITY: 'google-metadata' })).aiServiceIdentity).toBe('google-metadata');
    expect(() => loadConfig(testEnv({ AI_SERVICE_IDENTITY: 'anything' }))).toThrow(ConfigError);
  });
});

describe('list cursors', () => {
  const id = '01a10174-0000-7000-8000-000000000001';

  it('an id cursor round-trips, and nothing else is accepted as one', () => {
    expect(decodeIdCursor(encodeCursor(id))).toBe(id);
    expect(decodeIdCursor(undefined)).toBeNull();
    for (const bad of ['1234', 'abc', id.slice(0, 35), `${id}0`, id.toUpperCase(), "'; DROP TABLE topics; --", '']) {
      expect(() => decodeIdCursor(encodeCursor(bad)), bad).toThrowError();
    }
    expect(() => decodeIdCursor(42)).toThrowError();
  });

  it('a name cursor round-trips every name a job role can have, also ones stored before today\'s rules', () => {
    for (const name of ['Boiler operator', 'x', '\u{1F527}'.repeat(120), 'Opérateur de chaudière', 'old name\twith a tab', ' padded ']) {
      expect(decodeNameCursor(encodeNameCursor(name)), name).toBe(name);
    }
    expect(encodeNameCursor('\u{1F527}'.repeat(120)).length).toBeLessThanOrEqual(700);                 // the contract's limit for this cursor
    expect(decodeNameCursor(undefined)).toBeNull();
    for (const bad of ['', 'x'.repeat(121), 'nul\u0000inside']) {
      expect(() => decodeNameCursor(encodeNameCursor(bad)), JSON.stringify(bad)).toThrowError();
    }
    expect(() => decodeNameCursor(Buffer.from([0xff, 0xfe]).toString('base64url'))).toThrowError();   // not valid UTF-8
    expect(() => decodeNameCursor(7)).toThrowError();
  });

  it('pageOf cuts one page out of limit + 1 rows and gives the next cursor only when there is more', () => {
    expect(pageOf([1, 2, 3], 2, String)).toEqual({ items: [1, 2], next_cursor: '2' });
    expect(pageOf([1, 2], 2, String)).toEqual({ items: [1, 2], next_cursor: null });
    expect(pageOf([], 2, String)).toEqual({ items: [], next_cursor: null });
  });

  it('a numbered cursor (the audit log is ordered by sequence number) is still accepted by the general decoder', () => {
    expect(decodeCursor(encodeCursor(1234))).toBe('1234');
    expect(() => decodeCursor(encodeCursor('not hex'))).toThrowError();
  });
});

describe('a public handler receives only the headers its route declared', () => {
  const sent = { cookie: '__Host-lai_session=abc', authorization: 'Bearer x', 'x-csrf-token': 't', 'x-provider-signature': 'sig', 'user-agent': 'ua', 'x-twice': ['a', 'b'] };

  it('nothing is declared: nothing is passed on', () => {
    expect(declaredHeaders(sent, checkedHeaderNames('anyRoute', undefined))).toEqual({});
    expect(declaredHeaders(sent, [])).toEqual({});
  });

  it('a declared header is passed on (first value of a repeated one); everything else is not', () => {
    expect(declaredHeaders(sent, checkedHeaderNames('providerRoute', ['X-Provider-Signature', 'x-twice', 'x-absent']))).toEqual({ 'x-provider-signature': 'sig', 'x-twice': 'a' });
  });

  it('a route cannot declare a cookie, Authorization or the CSRF token - it is refused when the route is defined', () => {
    for (const name of ['cookie', 'Cookie', 'authorization', 'x-csrf-token', 'proxy-authorization', 'set-cookie', 'bad name', '']) {
      expect(() => checkedHeaderNames('providerRoute', [name]), name).toThrow(/may not receive/);
    }
    // and even a hand-made list cannot get them through
    expect(declaredHeaders(sent, [...NEVER_DECLARED_HEADERS])).toEqual({});
  });
});
