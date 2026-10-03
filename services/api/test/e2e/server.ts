// TEST ONLY. Starts the real API (with the built web application) on a local port for the browser
// tests in web/e2e, creates one synthetic company with four cards, and offers a small control
// listener the tests use to obtain sign-in codes. Never part of the product: it lives under test/,
// is not compiled into the image, and uses the throwaway test database and fake keys only.
//
//   WEB_DIST_DIR=../../web/dist AI_SERVICE_URL_REAL=http://127.0.0.1:8090 node test/e2e/server.ts
//
// Why a control listener: an authenticator-app code works once per 30-second step. The test clock
// is moved one step forward for every code handed out, so the tests need not wait in real time.
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { generate as totpGenerate } from 'otplib';
import { TEST_ORIGIN } from '../helpers/env.ts';
import { Client, enrollTotp, fromSecrets, login, platformOperator, startApp, type IssuedCard, type TestApp } from '../helpers/harness.ts';

const PORT = Number(process.env.E2E_PORT ?? '8787');
const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT ?? '8788');
const WEB_ORIGIN = `http://localhost:${PORT}`;

interface Persona {
  card: IssuedCard;
  totpSecret: string;
}

async function freshCode(t: TestApp, secret: string): Promise<string> {
  t.clock.advance(31_000);
  return totpGenerate({ secret, epoch: Math.floor(t.clock.now().getTime() / 1000) });
}

async function issue(owner: Client, name: string, roles: string[]): Promise<IssuedCard> {
  const person = await owner.post('/v1/people', { display_name: name, department_id: null });
  if (person.status !== 201) throw new Error(`create person failed: ${person.status} ${person.raw}`);
  const issued = await owner.post('/v1/cards', { person_id: person.body.id, roles: roles.map((role_key) => ({ role_key })) });
  if (issued.status !== 201) throw new Error(`issue card failed: ${issued.status} ${issued.raw}`);
  return fromSecrets(issued.body);
}

async function main(): Promise<void> {
  const webDist = process.env.WEB_DIST_DIR;
  const aiUrl = process.env.AI_SERVICE_URL_REAL;
  if (!webDist || !aiUrl) throw new Error('WEB_DIST_DIR and AI_SERVICE_URL_REAL are required');
  const t = await startApp({}, { AI_SERVICE_URL: aiUrl, WEB_DIST_DIR: webDist, ALLOWED_ORIGINS: `${TEST_ORIGIN},${WEB_ORIGIN}` });

  // One synthetic company. The owner signs in with an authenticator app (browser tests type the code).
  const operator = await platformOperator(t);
  const created = await operator.post('/v1/tenants', { name: 'Synthetic Browser Test Co', slug: `e2e-${Date.now().toString(36)}`, owner_display_name: 'Synthetic Owner' });
  if (created.status !== 201) throw new Error(`create tenant failed: ${created.status} ${created.raw}`);
  const ownerCard = fromSecrets(created.body.owner_card);
  const personas = new Map<string, Persona>();
  const ownerSecret = await enrollTotp(t, ownerCard);
  personas.set('owner', { card: ownerCard, totpSecret: ownerSecret });
  t.clock.advance(31_000);
  const owner = await login(t, ownerCard, { totp: ownerSecret });
  for (const [name, roles] of [['author', ['expert']], ['reviewer', ['reviewer']], ['learner', ['successor']]] as const) {
    const card = await issue(owner, `Synthetic ${name}`, [...roles]);
    personas.set(name, { card, totpSecret: await enrollTotp(t, card) });
  }

  await t.app.identity.hasher.warmUp();
  await t.app.http.app.listen({ port: PORT, host: '127.0.0.1' });

  // The control listener: local only, plain node:http, separate from the API server.
  const control = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${CONTROL_PORT}`);
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    void (async () => {
      if (url.pathname === '/health') return reply(200, { ok: true });
      if (url.pathname === '/credentials') {
        const persona = personas.get(url.searchParams.get('persona') ?? '');
        if (!persona) return reply(404, { error: 'unknown persona' });
        return reply(200, { card_number: persona.card.number, sc: persona.card.sc, code: await freshCode(t, persona.totpSecret) });
      }
      if (url.pathname === '/code') return reply(200, { code: await freshCode(t, url.searchParams.get('secret') ?? '') });
      if (url.pathname === '/new-card') {
        t.clock.advance(31_000); // the owner's previous code must not be reused
        const again = await login(t, ownerCard, { totp: ownerSecret });
        const card = await issue(again, `Synthetic newcomer ${randomUUID().slice(0, 8)}`, ['successor']);
        return reply(200, { card_number: card.number, sc: card.sc, enrollment_token: card.enrollmentToken });
      }
      return reply(404, { error: 'not found' });
    })().catch((err: unknown) => reply(500, { error: err instanceof Error ? err.message : 'failed' }));
  });
  control.listen(CONTROL_PORT, '127.0.0.1', () => {
    process.stdout.write(`e2e-server: ready - application at ${WEB_ORIGIN}, control at http://127.0.0.1:${CONTROL_PORT}\n`);
  });

  const stop = (): void => {
    control.close();
    void t.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-server: failed to start - ${err instanceof Error ? err.stack ?? err.message : 'unknown error'}\n`);
  process.exit(1);
});
