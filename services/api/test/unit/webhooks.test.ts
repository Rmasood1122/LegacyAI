// Webhooks (feature 28, part B): the rules that need no database - which addresses may be registered and connected
// to, the signature (against the published Standard Webhooks example and against our own example receiver), which
// endpoint gets which event, retries and pausing - and the real https sender against a local TLS server.
// The database side (outbox trigger, endpoints, deliveries) is in test/integration/webhooks.test.ts.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkedAddress, endpointGets, HttpsTransport, isPublicAddress, messageBody, newSigningSecret, nextAttemptAt, pinnedLookup, shouldPause,
  signatureOf, signedHeaders, TOPICS, urlProblem, verifySignature, WEBHOOK_LIMITS, type OutboxEvent,
} from '../../src/modules/webhooks/index.ts';
import { ConfigError, loadConfig } from '../../src/modules/platform/index.ts';
import { testEnv } from '../helpers/env.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..', '..', '..');

describe('which addresses can be registered', () => {
  it.each([
    ['https://hooks.example.com/legacyai', null],
    ['https://hooks.example.com:8443/a?b=c', null],
    ['http://hooks.example.com/x', 'not-https'],
    ['ftp://hooks.example.com/x', 'not-https'],
    ['https://user:pw@hooks.example.com/x', 'credentials'],
    ['https://hooks.example.com/x#frag', 'fragment'],
    ['https://127.0.0.1/x', 'ip-literal'],
    ['https://[::1]/x', 'ip-literal'],
    ['https://2130706433/x', 'ip-literal'],          // 127.0.0.1 written as one number
    ['https://0x7f.0x0.0x0.0x1/x', 'ip-literal'],
    ['https://169.254.169.254/latest/meta-data', 'ip-literal'],
    ['https://localhost/x', 'internal-host'],
    ['https://metadata.google.internal/x', 'internal-host'],
    ['https://printer.local/x', 'internal-host'],
    ['https://db.corp/x', 'internal-host'],
    ['https://intranet/x', 'bad-host'],              // no dot: a name only an internal resolver knows
    ['https://under_score.example.com/x', 'bad-host'],
    ['not a url', 'unreadable'],
    [`https://hooks.example.com/${'a'.repeat(2048)}`, 'too-long'],
  ])('%s -> %s', (url, expected) => {
    expect(urlProblem(url)).toBe(expected);
  });
});

describe('which addresses may be connected to', () => {
  it.each([
    ['93.184.216.34', true], ['8.8.8.8', true], ['2606:4700:4700::1111', true],
    ['127.0.0.1', false], ['10.1.2.3', false], ['172.16.0.1', false], ['172.31.255.255', false], ['192.168.1.1', false],
    ['169.254.169.254', false], ['100.64.0.1', false], ['0.0.0.0', false], ['224.0.0.1', false], ['255.255.255.255', false],
    ['192.0.2.1', false], ['198.18.0.1', false],
    ['::1', false], ['::', false], ['fe80::1', false], ['fc00::1', false], ['fd12:3456::1', false], ['ff02::1', false],
    ['::ffff:127.0.0.1', false], ['::ffff:10.0.0.1', false], ['::ffff:8.8.8.8', true],
    ['64:ff9b::7f00:1', false], ['2002:7f00:1::', false], ['2001:db8::1', false], ['2001::1', false],
    ['not-an-address', false],
  ])('%s -> %s', (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });

  it('every address of the name must be public: one internal address refuses the whole name', async () => {
    expect(await checkedAddress('h', async () => [{ address: '8.8.8.8', family: 4 }])).toEqual({ address: '8.8.8.8', family: 4 });
    expect(await checkedAddress('h', async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.5', family: 4 }])).toBe('address_refused');
    expect(await checkedAddress('h', async () => [])).toBe('dns');
    expect(await checkedAddress('h', async () => {
      throw new Error('ENOTFOUND');
    })).toBe('dns');
  });

  it('the pinned lookup answers with the checked address, whatever it is asked (both call styles of node)', () => {
    const lookup = pinnedLookup({ address: '203.0.113.9', family: 4 });
    const one: unknown[] = [];
    lookup('anything.example', {}, (...args) => one.push(...args));
    expect(one).toEqual([null, '203.0.113.9', 4]);
    const all: unknown[] = [];
    lookup('anything.example', { all: true }, (...args) => all.push(...args));
    expect(all).toEqual([null, [{ address: '203.0.113.9', family: 4 }]]);
  });
});

describe('the signature (Standard Webhooks)', () => {
  it('matches the example published with the Standard Webhooks specification', () => {
    // https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md (checked 2026-10-06)
    expect(signatureOf('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}'))
      .toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('a new secret is whsec_ + 32 random bytes, different every time', () => {
    const a = newSigningSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(a.slice(6), 'base64')).toHaveLength(32);
    expect(newSigningSecret()).not.toBe(a);
  });

  const secret = newSigningSecret();
  const now = new Date('2026-10-06T12:00:00Z');
  const body = JSON.stringify({ id: 'e1', type: 'knowledge.item_released', data: { item_id: 'x' } });
  const headers = signedHeaders(secret, 'e1', now, body);

  it('what we send is accepted - by our own check and by the example receiver', async () => {
    expect(verifySignature(secret, headers, body, now)).toBe(true);
    const receiver = await import(path.join(REPO, 'examples', 'webhook-receiver', 'receiver.mjs')) as {
      verifyWebhook: (s: string, h: Record<string, string>, b: string, n: Date) => boolean;
    };
    expect(receiver.verifyWebhook(secret, { ...headers }, body, now)).toBe(true);
    // ... and the receiver refuses what our check refuses
    expect(receiver.verifyWebhook(secret, { ...headers }, body.replace('x', 'y'), now)).toBe(false);
    expect(receiver.verifyWebhook(newSigningSecret(), { ...headers }, body, now)).toBe(false);
    expect(receiver.verifyWebhook(secret, { ...headers }, body, new Date(now.getTime() + 6 * 60_000))).toBe(false);
  });

  it.each([
    ['a changed body', { body: body.replace('x', 'y') }],
    ['another secret', { secret: newSigningSecret() }],
    ['another id (a signature copied onto another message)', { headers: { ...headers, 'webhook-id': 'e2' } }],
    ['a moved timestamp', { headers: { ...headers, 'webhook-timestamp': String(Number(headers['webhook-timestamp']) + 1) } }],
    ['a message 6 minutes old', { now: new Date(now.getTime() + 6 * 60_000) }],
    ['a message from 6 minutes in the future', { now: new Date(now.getTime() - 6 * 60_000) }],
    ['no signature', { headers: { 'webhook-id': 'e1', 'webhook-timestamp': headers['webhook-timestamp'] } }],
    ['an unknown version', { headers: { ...headers, 'webhook-signature': headers['webhook-signature'].replace('v1,', 'v2,') } }],
  ])('refused: %s', (_name, change: { body?: string; secret?: string; headers?: Record<string, string>; now?: Date }) => {
    expect(verifySignature(change.secret ?? secret, change.headers ?? headers, change.body ?? body, change.now ?? now)).toBe(false);
  });

  it('several signatures in one header (a receiver during a change of secret): one match is enough', () => {
    const both = { ...headers, 'webhook-signature': `v1,AAAA ${headers['webhook-signature']}` };
    expect(verifySignature(secret, both, body, now)).toBe(true);
  });
});

describe('which endpoint gets which event', () => {
  const at = new Date('2026-10-06T12:00:00Z');
  const event = (over: Partial<OutboxEvent> & { payload?: Record<string, unknown> } = {}): OutboxEvent => ({
    id: 'e', tenant_id: 't', topic: 'knowledge.item_released', created_at: at, ...over,
    payload: { item_id: 'i', status: 'verified', department_id: null, sensitivity: 1, previous_sensitivity: 1, ...(over.payload ?? {}) },
  });
  const endpoint = { topics: ['knowledge.item_released', 'knowledge.item_withdrawn'], max_sensitivity: 1, created_at: new Date(at.getTime() - 1000) };

  it('a subscribed topic, an item within the level, an endpoint that existed: sent', () => {
    expect(endpointGets(endpoint, event())).toBe(true);
  });
  it('a topic it did not subscribe to: not sent', () => {
    expect(endpointGets(endpoint, event({ topic: 'knowledge.item_changed' }))).toBe(false);
  });
  it('an item above its level: not sent', () => {
    expect(endpointGets(endpoint, event({ payload: { sensitivity: 2, previous_sensitivity: 2 } }))).toBe(false);
  });
  it('an item relabelled OUT of its level: sent (it must learn the item is gone from its reach)', () => {
    expect(endpointGets({ ...endpoint, topics: ['knowledge.item_changed'] }, event({ topic: 'knowledge.item_changed', payload: { sensitivity: 3, previous_sensitivity: 1 } }))).toBe(true);
  });
  it('an item relabelled INTO its level: sent', () => {
    expect(endpointGets({ ...endpoint, topics: ['knowledge.item_changed'] }, event({ topic: 'knowledge.item_changed', payload: { sensitivity: 0, previous_sensitivity: 3 } }))).toBe(true);
  });
  it('an event from before the endpoint existed: not sent', () => {
    expect(endpointGets({ ...endpoint, created_at: new Date(at.getTime() + 1) }, event())).toBe(false);
  });
  it('an event whose label cannot be read: not sent', () => {
    expect(endpointGets(endpoint, event({ payload: { sensitivity: 'high' } }))).toBe(false);
    expect(endpointGets(endpoint, event({ payload: { sensitivity: 9, previous_sensitivity: 9 } }))).toBe(false);
  });
  it('the body is the event and nothing more', () => {
    expect(messageBody(event())).toEqual({
      id: 'e', type: 'knowledge.item_released', created_at: at.toISOString(), company_id: 't',
      data: { item_id: 'i', status: 'verified', department_id: null, sensitivity: 1, previous_sensitivity: 1 },
    });
  });
  it('the topics in code are the topics the database accepts (outbox and endpoints)', () => {
    const sql = readFileSync(path.join(REPO, 'db', 'migrations', '20261006000100_webhooks_mail.sql'), 'utf8');
    const lists = [...sql.matchAll(/topic IN \(([^)]*)\)|topics <@ ARRAY\[([^\]]*)\]/g)].map((m) => (m[1] ?? m[2] as string).match(/'[^']+'/g)?.map((x) => x.slice(1, -1)));
    expect(lists).toHaveLength(2);
    for (const list of lists) expect(list).toEqual([...TOPICS]);
  });
});

describe('retries and pausing', () => {
  const now = new Date('2026-10-06T00:00:00Z');
  it('waits 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h, then gives up after the 8th attempt', () => {
    const waits = [1, 2, 3, 4, 5, 6, 7].map((n) => ((nextAttemptAt(n, now) as Date).getTime() - now.getTime()) / 60_000);
    expect(waits).toEqual([1, 5, 30, 120, 360, 720, 1440]);
    expect(nextAttemptAt(8, now)).toBeNull();
    expect(WEBHOOK_LIMITS.maxAttempts).toBe(8);
  });
  it('pauses after 15 failures in a row AND a day without success - not after one bad hour', () => {
    const day = 86_400_000;
    const base = { createdAt: new Date(now.getTime() - 10 * day), now };
    expect(shouldPause({ ...base, consecutiveFailures: 15, lastSuccessAt: new Date(now.getTime() - day) })).toBe(true);
    expect(shouldPause({ ...base, consecutiveFailures: 14, lastSuccessAt: new Date(now.getTime() - 2 * day) })).toBe(false);
    expect(shouldPause({ ...base, consecutiveFailures: 100, lastSuccessAt: new Date(now.getTime() - 3_600_000) })).toBe(false);
    expect(shouldPause({ consecutiveFailures: 20, lastSuccessAt: null, createdAt: new Date(now.getTime() - 3_600_000), now })).toBe(false);
    expect(shouldPause({ consecutiveFailures: 20, lastSuccessAt: null, createdAt: new Date(now.getTime() - day), now })).toBe(true);
  });
});

describe('configuration', () => {
  it('nothing is sent unless WEBHOOK_DELIVERY=https; anything else is refused', () => {
    expect(loadConfig(testEnv()).webhooks.delivery).toBe('none');
    expect(loadConfig(testEnv({ WEBHOOK_DELIVERY: 'https' })).webhooks.delivery).toBe('https');
    expect(() => loadConfig(testEnv({ WEBHOOK_DELIVERY: 'http' }))).toThrow(ConfigError);
  });
});

// ------------------------------------------------------------------ the real sender, against a local TLS server

describe('HttpsTransport against a local https server', () => {
  let dir: string;
  let cert: string;
  let server: Server;
  let port: number;
  let otherCa: string;
  const received: Array<{ headers: Record<string, unknown>; body: string; path: string }> = [];
  let answer: (res: import('node:http').ServerResponse, path: string) => void = (res) => res.writeHead(204).end();

  const selfSigned = (name: string): { key: string; cert: string } => {
    const key = path.join(dir, `${name}.key`);
    const crt = path.join(dir, `${name}.crt`);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', `/CN=${name}`, '-addext', `subjectAltName=DNS:${name}`, '-keyout', key, '-out', crt], { stdio: 'ignore' });
    return { key: readFileSync(key, 'utf8'), cert: readFileSync(crt, 'utf8') };
  };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'legacyai-webhook-tls-'));
    const pair = selfSigned('hooks.test');
    cert = pair.cert;
    otherCa = selfSigned('other.test').cert;
    server = createServer({ key: pair.key, cert: pair.cert }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), path: req.url ?? '' });
        answer(res, req.url ?? '');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  // the test host name resolves to the local server; the address rule is relaxed for 127.0.0.1 ONLY in these tests
  const local = (over: { ca?: string; timeoutMs?: number; resolveTo?: string; strict?: boolean } = {}): HttpsTransport => new HttpsTransport({
    resolve: async () => [{ address: over.resolveTo ?? '127.0.0.1', family: 4 }],
    ...(over.strict === true ? {} : { isAllowed: (a: string) => a === '127.0.0.1' }),
    ca: over.ca ?? cert, timeoutMs: over.timeoutMs ?? 2_000,
  });
  const url = (p = '/hook'): string => `https://hooks.test:${port}${p}`;
  const secret = newSigningSecret();

  it('sends a signed POST that the receiver can check; 2xx is a success', async () => {
    answer = (res) => res.writeHead(204).end();
    const body = JSON.stringify({ id: 'evt-1', type: 'webhook.test' });
    const headers = signedHeaders(secret, 'evt-1', new Date(), body);
    const out = await local().send({ url: url('/hook?x=1'), headers: { ...headers }, body });
    expect(out).toEqual({ ok: true, status: 204 });
    const got = received[received.length - 1];
    expect(got?.path).toBe('/hook?x=1');
    expect(got?.body).toBe(body);
    expect(got?.headers['content-type']).toBe('application/json');
    expect(got?.headers['user-agent']).toBe('LegacyAI-Webhooks/1');
    expect(verifySignature(secret, got?.headers as Record<string, string>, got?.body ?? '', new Date())).toBe(true);
  });

  it('a non-2xx answer is a failure with its status; a redirect is NOT followed', async () => {
    answer = (res, p) => (p === '/moved' ? res.writeHead(302, { location: `https://hooks.test:${port}/hook` }).end() : res.writeHead(500).end('x'.repeat(10_000)));
    const before = received.length;
    expect(await local().send({ url: url('/broken'), headers: {}, body: '{}' })).toEqual({ ok: false, error: 'http_status', status: 500 });
    expect(await local().send({ url: url('/moved'), headers: {}, body: '{}' })).toEqual({ ok: false, error: 'http_status', status: 302 });
    expect(received.length - before).toBe(2);   // the redirect target was never called
  });

  it('a receiver that does not answer in time: timeout', async () => {
    answer = () => undefined;   // never answers
    expect(await local({ timeoutMs: 300 }).send({ url: url('/slow'), headers: {}, body: '{}' })).toEqual({ ok: false, error: 'timeout' });
  });

  it('a certificate the sender does not trust: tls, and nothing reaches the receiver', async () => {
    answer = (res) => res.writeHead(204).end();
    const before = received.length;
    expect(await local({ ca: otherCa }).send({ url: url(), headers: {}, body: '{}' })).toEqual({ ok: false, error: 'tls' });
    expect(received.length).toBe(before);
  });

  it('with the production rule, a name that resolves to 127.0.0.1 is refused before any connection', async () => {
    const before = received.length;
    expect(await local({ strict: true }).send({ url: url(), headers: {}, body: '{}' })).toEqual({ ok: false, error: 'address_refused' });
    expect(received.length).toBe(before);
  });

  it('an http address is refused without a connection', async () => {
    expect(await local().send({ url: `http://hooks.test:${port}/hook`, headers: {}, body: '{}' })).toEqual({ ok: false, error: 'address_refused' });
  });
});
