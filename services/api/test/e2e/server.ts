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
import { addMember, Client, enrollTotp, fromSecrets, login, platformOperator, startApp, superuser, type IssuedCard, type Res, type TestApp } from '../helpers/harness.ts';

const PORT = Number(process.env.E2E_PORT ?? '8787');
const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT ?? '8788');
const WEB_ORIGIN = `http://localhost:${PORT}`;

interface Persona {
  card: IssuedCard;
  totpSecret: string;
  /** null for the owner (not needed there). */
  personId: string | null;
}

/** The job role the seeded readiness material belongs to (web/e2e/more-screens.spec.ts types it). */
const SEED_JOB_ROLE = 'Boiler operator';

function must(what: string, res: Res, status: number): Res {
  if (res.status !== status) throw new Error(`${what} failed: ${res.status} ${res.raw.slice(0, 300)}`);
  return res;
}

async function freshCode(t: TestApp, secret: string): Promise<string> {
  t.clock.advance(31_000);
  return totpGenerate({ secret, epoch: Math.floor(t.clock.now().getTime() / 1000) });
}

async function issue(owner: Client, name: string, roles: string[]): Promise<{ card: IssuedCard; personId: string }> {
  const person = await owner.post('/v1/people', { display_name: name, department_id: null });
  if (person.status !== 201) throw new Error(`create person failed: ${person.status} ${person.raw}`);
  const issued = await owner.post('/v1/cards', { person_id: person.body.id, roles: roles.map((role_key) => ({ role_key })) });
  if (issued.status !== 201) throw new Error(`issue card failed: ${issued.status} ${issued.raw}`);
  return { card: fromSecrets(issued.body), personId: person.body.id as string };
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
  personas.set('owner', { card: ownerCard, totpSecret: ownerSecret, personId: null });
  const tenantId = created.body.tenant.id as string;
  t.clock.advance(31_000);
  const owner = await login(t, ownerCard, { totp: ownerSecret });
  const cast = [['author', ['expert']], ['reviewer', ['expert']], ['reviewer2', ['expert']], ['learner', ['successor']], ['admin', ['admin']]] as const;
  for (const [name, roles] of cast) {
    const { card, personId } = await issue(owner, `Synthetic ${name}`, [...roles]);
    personas.set(name, { card, totpSecret: await enrollTotp(t, card), personId });
  }

  // Material for the readiness and gap screens, made through the API the way the both-services walk
  // does it (services/api/test/contract/phase2-walk.test.ts): a verified item released to learners,
  // a topic, and a job role that needs the topic. One step has no API yet - linking an item to a
  // topic - and is done directly in the test database, exactly as that walk does.
  let seeded: Promise<{ job_role: string }> | null = null;
  const seedReadiness = async (): Promise<{ job_role: string }> => {
    t.clock.advance(31_000);
    const o = await login(t, ownerCard, { totp: ownerSecret });
    const writer = await addMember(t, o, [{ role_key: 'expert' }]);
    const checker = await addMember(t, o, [{ role_key: 'expert' }]);
    must('consent', await writer.client.post('/v1/consents', { scope: 'own_words', purpose: 'Synthetic browser test', policy_version: 'e2e-1' }), 201);
    const item = must('create item', await writer.client.post('/v1/knowledge/items', {
      title: 'Relief valve check', body: 'Lift each relief valve lever monthly until steam escapes, then release it slowly.', sensitivity: 1,
      contributor_person_id: writer.personId,
    }), 201).body.id as string;
    must('submit item', await writer.client.post(`/v1/knowledge/items/${item}/submit`), 200);
    must('verify item', await checker.client.post(`/v1/knowledge/items/${item}/verify`), 200);
    must('release item', await o.patch(`/v1/knowledge/items/${item}/labels`, { department_id: null, sensitivity: 0 }), 200);
    const topic = must('create topic', await o.post('/v1/topics', { name: 'Relief valves', description: 'monthly relief valve testing on the boiler' }), 201).body.id as string;
    const role = encodeURIComponent(SEED_JOB_ROLE);
    must('role topics', await o.put(`/v1/job-roles/${role}/topics`, { topics: [{ topic_id: topic, importance: 3 }] }), 200);
    const learner = personas.get('learner')?.personId;
    must('role people', await o.put(`/v1/job-roles/${role}/people`, { people: [{ person_id: learner, relation: 'successor' }] }), 200);
    must('test settings', await o.patch('/v1/knowledge/settings', { quiz_min_questions_per_topic: 1 }), 200);
    const su = await superuser();
    try {
      await su.query('BEGIN');
      await su.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await su.query("INSERT INTO knowledge_item_topics (tenant_id, item_id, topic_id, link_source) VALUES ($1, $2, $3, 'reviewer')", [tenantId, item, topic]);
      await su.query('COMMIT');
    } finally {
      await su.end();
    }
    return { job_role: SEED_JOB_ROLE };
  };

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
      if (url.pathname === '/seed-readiness') {
        seeded ??= seedReadiness();
        return reply(200, await seeded);
      }
      if (url.pathname === '/code') return reply(200, { code: await freshCode(t, url.searchParams.get('secret') ?? '') });
      if (url.pathname === '/new-card') {
        t.clock.advance(31_000); // the owner's previous code must not be reused
        const again = await login(t, ownerCard, { totp: ownerSecret });
        const { card } = await issue(again, `Synthetic newcomer ${randomUUID().slice(0, 8)}`, ['successor']);
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
