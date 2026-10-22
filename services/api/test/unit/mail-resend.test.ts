// The Resend e-mail sender (decision D36, docs/phase4/06 part C) against a stand-in for Resend: a local TLS server
// that answers the way Resend's documentation says it does (https://resend.com/docs/api-reference/emails/send-email
// and /errors, read 2026-10-22). Nothing here reaches Resend; the key is a made-up value.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RESEND_URL, ResendMailSender, resendOutcome, type MailMessage } from '../../src/modules/mail/index.ts';
import { ConfigError, createLogger, loadConfig, Secret } from '../../src/modules/platform/index.ts';
import { testEnv } from '../helpers/env.ts';

const KEY = 're_FAKE_test_key_0123456789';
const message: MailMessage = {
  id: '6f1c2b9e-4d3a-4e8f-9b2c-1a7d5e3f0c4b.b8e2f7a1-9c3d-4f6e-8a5b-2d1c0e9f7a63',
  from: 'LegacyAI <no-reply@mail.example.test>', to: 'person@example.test', subject: 'A notice', text: 'Plain text.',
};
const answerOf = (status: number, body: unknown = {}): Parameters<typeof resendOutcome>[0] => ({ ok: true, status, body: Buffer.from(JSON.stringify(body)) });

describe('what an answer from Resend means', () => {
  it('2xx: sent', () => {
    expect(resendOutcome(answerOf(200, { id: 'x' }))).toEqual({ outcome: { ok: true }, problem: null });
  });

  it('a message that cannot be sent as it is (400, 422, a re-used idempotency key with another body): rejected, not tried again', () => {
    expect(resendOutcome(answerOf(422, { name: 'missing_required_field' })).outcome).toEqual({ ok: false, error: 'rejected' });
    expect(resendOutcome(answerOf(400, { name: 'validation_error' })).outcome).toEqual({ ok: false, error: 'rejected' });
    expect(resendOutcome(answerOf(409, { name: 'invalid_idempotent_request' })).outcome).toEqual({ ok: false, error: 'rejected' });
  });

  it('our set-up is wrong (key, unverified domain, wrong address): tried again, and the operator hears the code', () => {
    for (const [status, name] of [[401, 'validation_error'], [403, 'validation_error'], [404, 'not_found'], [405, 'method_not_allowed']] as const) {
      const { outcome, problem } = resendOutcome(answerOf(status, { name, message: 'The person@example.test domain is not verified' }));
      expect(outcome).toEqual({ ok: false, error: 'unavailable' });
      expect(problem).toBe(`HTTP ${status} ${name}`);
      expect(problem).not.toContain('@');   // Resend's message can carry an address; only its fixed name is kept
    }
  });

  it('passing trouble (a request with the same key in progress, too many requests, Resend down): tried again, quietly', () => {
    for (const [status, name] of [[409, 'concurrent_idempotent_requests'], [429, 'rate_limit_exceeded'], [500, 'application_error'], [503, 'service_unavailable']] as const) {
      expect(resendOutcome(answerOf(status, { name }))).toEqual({ outcome: { ok: false, error: 'unavailable' }, problem: null });
    }
  });

  it('no answer: a timeout is a timeout; anything else is unavailable', () => {
    expect(resendOutcome({ ok: false, error: 'timeout' }).outcome).toEqual({ ok: false, error: 'timeout' });
    expect(resendOutcome({ ok: false, error: 'tls' }).outcome).toEqual({ ok: false, error: 'unavailable' });
    expect(resendOutcome({ ok: false, error: 'dns' }).outcome).toEqual({ ok: false, error: 'unavailable' });
  });

  it('a body that is not Resend\'s error shape does not break anything', () => {
    expect(resendOutcome({ ok: true, status: 502, body: Buffer.from('<html>bad gateway</html>') }).outcome).toEqual({ ok: false, error: 'unavailable' });
    expect(resendOutcome({ ok: true, status: 403, body: Buffer.from('{"name":"<script>"}') }).problem).toBe('HTTP 403');
  });

  it('the real address is Resend\'s, over https', () => {
    expect(RESEND_URL).toBe('https://api.resend.com/emails');
  });
});

describe('ResendMailSender against a stand-in for Resend', () => {
  let dir: string;
  let cert: string;
  let otherCa: string;
  let server: Server;
  let port: number;
  const received: Array<{ method: string; path: string; headers: Record<string, unknown>; body: string }> = [];
  let answer: (res: ServerResponse) => void = (res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"re-msg-1"}');
  const logLines: string[] = [];

  const selfSigned = (name: string): { key: string; cert: string } => {
    const key = path.join(dir, `${name}.key`);
    const crt = path.join(dir, `${name}.crt`);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', `/CN=${name}`, '-addext', `subjectAltName=DNS:${name}`, '-keyout', key, '-out', crt], { stdio: 'ignore' });
    return { key: readFileSync(key, 'utf8'), cert: readFileSync(crt, 'utf8') };
  };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'legacyai-resend-tls-'));
    const pair = selfSigned('api.resend.test');
    cert = pair.cert;
    otherCa = selfSigned('other.test').cert;
    server = createServer({ key: pair.key, cert: pair.cert }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        answer(res);
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

  const log = createLogger('info', new Writable({
    write(chunk: Buffer, _enc, done) {
      logLines.push(chunk.toString('utf8'));
      done();
    },
  }));
  // the stand-in's host name resolves to the local server; 127.0.0.1 is allowed ONLY in these tests
  const sender = (over: { ca?: string; timeoutMs?: number } = {}): ResendMailSender => new ResendMailSender({
    apiKey: new Secret(KEY), log, url: `https://api.resend.test:${port}/emails`,
    http: { resolve: async () => [{ address: '127.0.0.1', family: 4 }], isAllowed: (a) => a === '127.0.0.1', ca: over.ca ?? cert, ...(over.timeoutMs === undefined ? {} : { timeoutMs: over.timeoutMs }) },
  });
  const last = () => received[received.length - 1] as (typeof received)[number];

  it('sends one POST the way Resend documents it: Bearer key, JSON, the message id as the idempotency key', async () => {
    answer = (res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"re-msg-1"}');
    expect(await sender().send(message)).toEqual({ ok: true });
    const r = last();
    expect(r.method).toBe('POST');
    expect(r.path).toBe('/emails');
    expect(r.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.headers['idempotency-key']).toBe(message.id);
    expect(JSON.parse(r.body)).toEqual({ from: message.from, to: [message.to], subject: message.subject, text: message.text });
  });

  it('a retry of the same message carries the same idempotency key (Resend sends it once)', async () => {
    const before = received.length;
    await sender().send(message);
    await sender().send(message);
    const keys = received.slice(before).map((r) => r.headers['idempotency-key']);
    expect(keys).toEqual([message.id, message.id]);
  });

  it('a refusal is rejected; a wrong set-up is unavailable and logged with no key, address or text', async () => {
    answer = (res) => res.writeHead(422, { 'content-type': 'application/json' }).end('{"statusCode":422,"name":"missing_required_field","message":"x"}');
    expect(await sender().send(message)).toEqual({ ok: false, error: 'rejected' });
    logLines.length = 0;
    answer = (res) => res.writeHead(403, { 'content-type': 'application/json' })
      .end('{"statusCode":403,"name":"validation_error","message":"The mail.example.test domain is not verified"}');
    expect(await sender().send(message)).toEqual({ ok: false, error: 'unavailable' });
    const logged = logLines.join('\n');
    expect(logged).toContain('HTTP 403 validation_error');
    expect(logged).toContain(message.id);
    for (const secretOrPersonal of [KEY, 're_FAKE', message.to, message.text, 'not verified']) expect(logged).not.toContain(secretOrPersonal);
  });

  it('Resend too slow: timeout', async () => {
    answer = () => undefined;   // never answers
    expect(await sender({ timeoutMs: 300 }).send(message)).toEqual({ ok: false, error: 'timeout' });
  });

  it('a server whose certificate is not trusted gets nothing, not even the key', async () => {
    answer = (res) => res.writeHead(200).end('{}');
    const before = received.length;
    expect(await sender({ ca: otherCa }).send(message)).toEqual({ ok: false, error: 'unavailable' });
    expect(received.length).toBe(before);
  });

  it('the guarded client is used: a private address is refused before any connection', async () => {
    const before = received.length;
    const strict = new ResendMailSender({
      apiKey: new Secret(KEY), log, url: `https://api.resend.test:${port}/emails`,
      http: { resolve: async () => [{ address: '127.0.0.1', family: 4 }], ca: cert },
    });
    expect(await strict.send(message)).toEqual({ ok: false, error: 'unavailable' });
    expect(received.length).toBe(before);
  });
});

describe('configuration', () => {
  const resend = (over: Record<string, string | undefined> = {}) =>
    testEnv({ MAIL_SENDER: 'resend', RESEND_API_KEY: KEY, MAIL_FROM: 'LegacyAI <no-reply@mail.example.test>', ...over });

  it('MAIL_SENDER=resend with a key and a real sender line; the key is kept as a secret', () => {
    const c = loadConfig(resend());
    expect(c.mail.sender).toBe('resend');
    expect(c.mail.resendApiKey?.reveal()).toBe(KEY);
    expect(JSON.stringify(c.mail)).not.toContain(KEY);
    expect(loadConfig(testEnv()).mail.resendApiKey).toBeNull();
  });

  it('no key, a malformed key, or the default localhost sender line: refused at start-up', () => {
    expect(() => loadConfig(resend({ RESEND_API_KEY: undefined }))).toThrow(/RESEND_API_KEY/);
    expect(() => loadConfig(resend({ RESEND_API_KEY: 'sk_live_123456789' }))).toThrow(/RESEND_API_KEY/);
    expect(() => loadConfig(resend({ RESEND_API_KEY: 're_has space 12345' }))).toThrow(ConfigError);
    expect(() => loadConfig(resend({ MAIL_FROM: undefined }))).toThrow(/MAIL_FROM/);
    expect(() => loadConfig(resend({ MAIL_FROM: 'LegacyAI <no-reply@localhost>' }))).toThrow(/MAIL_FROM/);
    expect(() => loadConfig(resend({ MAIL_FROM: 'not an address' }))).toThrow(/MAIL_FROM/);
    expect(loadConfig(resend({ MAIL_FROM: 'no-reply@mail.example.test' })).mail.from).toBe('no-reply@mail.example.test');
  });

  it('the .env.example placeholder key never sends from production', () => {
    let error: unknown;
    try {
      loadConfig(resend({ NODE_ENV: 'production' }));
    } catch (err) {
      error = err;
    }
    expect(String((error as Error).message)).toMatch(/RESEND_API_KEY is the placeholder/);
  });
});
