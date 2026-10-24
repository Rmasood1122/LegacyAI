// Google Cloud KMS as the key service (decision D40) against a stand-in: a local TLS server that answers encrypt and
// decrypt the way Cloud KMS documents them (REST v1, read 2026-10-24), with CRC32C checksums. Nothing here reaches
// Google; the access token is a made-up value given by the test.
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crc32c, GoogleKmsKeyService, keyServiceFrom, KeyUnavailable, KMS_API, loadConfig } from '../../src/modules/platform/index.ts';
import { testEnv } from '../helpers/env.ts';

const KEY = 'projects/acme-prod-1234/locations/europe-west3/keyRings/legacyai/cryptoKeys/company-data';
const OTHER = 'projects/acme-prod-1234/locations/europe-west3/keyRings/legacyai/cryptoKeys/other-key';

describe('CRC32C and key references', () => {
  it('the checksum is CRC32C (Castagnoli): the standard check value of "123456789" is 0xE3069283', () => {
    expect(crc32c(Buffer.from('123456789'))).toBe(0xe3069283);
    expect(crc32c(Buffer.alloc(0))).toBe(0);
  });

  it('a key reference is the full name of a key (not a key version, not a URL)', () => {
    const kms = new GoogleKmsKeyService({ tokens: async () => ({ token: 't', expiresAt: Date.now() + 3_600_000 }) });
    expect(kms.validRef(KEY)).toBe(true);
    for (const bad of [
      `${KEY}/cryptoKeyVersions/1`, `https://cloudkms.googleapis.com/v1/${KEY}`, 'local:acme', 'projects/x/locations/l/keyRings/r/cryptoKeys/k',
      `${KEY}/../../other`, `${KEY}:decrypt`, '',
    ]) {
      expect(kms.validRef(bad), bad).toBe(false);
    }
  });

  it('the real address is Google\'s, and KEY_SERVICE=google-kms needs nothing else', () => {
    expect(KMS_API).toBe('https://cloudkms.googleapis.com');
    const config = loadConfig(testEnv({ KEY_SERVICE: 'google-kms' }));
    expect(config.keyService.kind).toBe('google-kms');
    expect(keyServiceFrom(config.keyService).kind).toBe('google-kms');
  });
});

describe('GoogleKmsKeyService against a stand-in for Cloud KMS', () => {
  let dir: string;
  let cert: string;
  let server: Server;
  let port: number;
  // the stand-in's keys: one AES key per key name; a key can be disabled, as at Google
  const keys = new Map([[KEY, randomBytes(32)], [OTHER, randomBytes(32)]]);
  const disabled = new Set<string>();
  const seen: Array<{ path: string; auth: string | undefined; body: Record<string, string> }> = [];
  let damage: 'none' | 'ciphertext-crc' | 'plaintext-crc' | 'unverified' | 'garbage' = 'none';
  let status401Once = false;

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const handle = (req: IncomingMessage, raw: string, res: ServerResponse): void => {
    const m = /^\/v1\/(.+):(encrypt|decrypt)$/.exec(req.url ?? '');
    const body = JSON.parse(raw) as Record<string, string>;
    seen.push({ path: req.url ?? '', auth: req.headers.authorization, body });
    if (status401Once) {
      status401Once = false;
      return send(res, 401, { error: { code: 401, status: 'UNAUTHENTICATED' } });
    }
    const key = m ? keys.get(m[1] as string) : undefined;
    if (!m || key === undefined) return send(res, 404, { error: { code: 404, message: `${m?.[1]} not found`, status: 'NOT_FOUND' } });
    if (disabled.has(m[1] as string)) return send(res, 400, { error: { code: 400, message: 'KEY_VERSION_DISABLED', status: 'FAILED_PRECONDITION' } });
    if (damage === 'garbage') return send(res, 200, '<html>');
    const aad = Buffer.from(body.additionalAuthenticatedData ?? '', 'base64');
    if (m[2] === 'encrypt') {
      const plain = Buffer.from(body.plaintext ?? '', 'base64');
      const verified = body.plaintextCrc32c === String(crc32c(plain)) && body.additionalAuthenticatedDataCrc32c === String(crc32c(aad));
      const nonce = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, nonce);
      c.setAAD(aad);
      const ct = Buffer.concat([nonce, c.update(plain), c.final(), c.getAuthTag()]);
      return send(res, 200, {
        name: `${m[1]}/cryptoKeyVersions/1`, ciphertext: ct.toString('base64'),
        ciphertextCrc32c: damage === 'ciphertext-crc' ? '1' : String(crc32c(ct)),
        verifiedPlaintextCrc32c: damage === 'unverified' ? false : verified, verifiedAdditionalAuthenticatedDataCrc32c: verified, protectionLevel: 'SOFTWARE',
      });
    }
    const ct = Buffer.from(body.ciphertext ?? '', 'base64');
    if (body.ciphertextCrc32c !== String(crc32c(ct))) return send(res, 400, { error: { code: 400, message: 'checksum', status: 'INVALID_ARGUMENT' } });
    try {
      const d = createDecipheriv('aes-256-gcm', key, ct.subarray(0, 12));
      d.setAAD(aad);
      d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(12, ct.length - 16)), d.final()]);
      return send(res, 200, { plaintext: plain.toString('base64'), plaintextCrc32c: damage === 'plaintext-crc' ? '1' : String(crc32c(plain)), usedPrimary: true });
    } catch {
      return send(res, 400, { error: { code: 400, message: 'Decryption failed', status: 'INVALID_ARGUMENT' } });
    }
  };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'legacyai-kms-tls-'));
    const keyFile = path.join(dir, 'k.pem');
    const crt = path.join(dir, 'c.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', '/CN=kms.test', '-addext', 'subjectAltName=DNS:kms.test', '-keyout', keyFile, '-out', crt], { stdio: 'ignore' });
    cert = readFileSync(crt, 'utf8');
    server = createServer({ key: readFileSync(keyFile, 'utf8'), cert }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => handle(req, Buffer.concat(chunks).toString('utf8'), res));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  let tokenCalls = 0;
  const kms = (): GoogleKmsKeyService => new GoogleKmsKeyService({
    tokens: async () => {
      tokenCalls += 1;
      return { token: `test-access-token-${tokenCalls}`, expiresAt: Date.now() + 3_600_000 };
    },
    api: `https://kms.test:${port}`,
    http: { resolve: async () => [{ address: '127.0.0.1', family: 4 }], isAllowed: (a) => a === '127.0.0.1', ca: cert },
  });
  const AAD = 'company-data-key:tenant-1:v1';
  const unavailable = async (p: Promise<unknown>): Promise<void> => {
    await expect(p).rejects.toBeInstanceOf(KeyUnavailable);
  };

  it('wraps and unwraps a data key; the request is the documented one, with checksums and a bearer token', async () => {
    const k = kms();
    const dataKey = randomBytes(32);
    const wrapped = await k.wrap(KEY, dataKey, AAD);
    expect(wrapped.includes(dataKey)).toBe(false);
    expect(await k.unwrap(KEY, wrapped, AAD)).toEqual(dataKey);
    const [enc, dec] = seen.slice(-2);
    expect(enc?.path).toBe(`/v1/${KEY}:encrypt`);
    expect(dec?.path).toBe(`/v1/${KEY}:decrypt`);
    expect(enc?.auth).toMatch(/^Bearer test-access-token-\d+$/);
    expect(enc?.body).toEqual({
      plaintext: dataKey.toString('base64'), plaintextCrc32c: String(crc32c(dataKey)),
      additionalAuthenticatedData: Buffer.from(AAD).toString('base64'), additionalAuthenticatedDataCrc32c: String(crc32c(Buffer.from(AAD))),
    });
  });

  it('the token is fetched once and reused; a 401 drops it, so the next call fetches a fresh one', async () => {
    const k = kms();
    const before = tokenCalls;
    const wrapped = await k.wrap(KEY, randomBytes(32), AAD);
    await k.unwrap(KEY, wrapped, AAD);
    expect(tokenCalls - before).toBe(1);
    status401Once = true;
    await unavailable(k.unwrap(KEY, wrapped, AAD));
    await k.unwrap(KEY, wrapped, AAD);
    expect(tokenCalls - before).toBe(2);
  });

  it('the company disables its key: nothing it wrapped opens, nothing new is wrapped; enabled again, it all works', async () => {
    const k = kms();
    const dataKey = randomBytes(32);
    const wrapped = await k.wrap(KEY, dataKey, AAD);
    disabled.add(KEY);
    try {
      await unavailable(k.unwrap(KEY, wrapped, AAD));
      await unavailable(k.wrap(KEY, randomBytes(32), AAD));
    } finally {
      disabled.delete(KEY);
    }
    expect(await k.unwrap(KEY, wrapped, AAD)).toEqual(dataKey);
  });

  it('another company\'s binding (aad), another key, or an unknown key: does not open', async () => {
    const k = kms();
    const wrapped = await k.wrap(KEY, randomBytes(32), AAD);
    await unavailable(k.unwrap(KEY, wrapped, 'company-data-key:tenant-2:v1'));
    await unavailable(k.unwrap(OTHER, wrapped, AAD));
    await unavailable(k.unwrap(KEY.replace('company-data', 'nobody'), wrapped, AAD));
    await unavailable(k.wrap('local:acme', randomBytes(32), AAD));   // not a KMS reference: no request at all
  });

  it('an answer damaged on the way, unverified checksums or an unreadable answer: KeyUnavailable, never a wrong key', async () => {
    const k = kms();
    const wrapped = await k.wrap(KEY, randomBytes(32), AAD);
    for (const d of ['ciphertext-crc', 'unverified', 'garbage'] as const) {
      damage = d;
      try {
        await unavailable(k.wrap(KEY, randomBytes(32), AAD));
      } finally {
        damage = 'none';
      }
    }
    damage = 'plaintext-crc';
    try {
      await unavailable(k.unwrap(KEY, wrapped, AAD));
    } finally {
      damage = 'none';
    }
  });

  it('no token (no metadata server, no permission): KeyUnavailable; Google\'s message (project and key names) is not repeated', async () => {
    const noToken = new GoogleKmsKeyService({
      tokens: async () => {
        throw new Error('metadata server unreachable');
      },
      api: `https://kms.test:${port}`, http: { resolve: async () => [{ address: '127.0.0.1', family: 4 }], isAllowed: (a) => a === '127.0.0.1', ca: cert },
    });
    await unavailable(noToken.wrap(KEY, randomBytes(32), AAD));
    const err = await kms().unwrap(KEY.replace('company-data', 'nobody'), randomBytes(40), AAD).catch((e: unknown) => e) as Error;
    expect(err.message).toContain('HTTP 404');
    expect(err.message).not.toContain('acme-prod');
  });
});
