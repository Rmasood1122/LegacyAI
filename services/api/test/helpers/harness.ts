// Shared test harness: starts the real app against the real test database, and provides a
// software passkey ("virtual authenticator") and a TOTP generator so the full login flow
// can be exercised without a browser.
import { encodeCBOR } from '@levischuck/tiny-cbor';
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import { generate as totpGenerate } from 'otplib';
import pg from 'pg';
import { createApp, type App, type AppOverrides } from '../../src/app.ts';
import { DEFAULT_AUTH_LIMITS, formatCardNumber } from '../../src/modules/identity-access/index.ts';
import { createLogger, getSettings, loadConfig, PLATFORM_TENANT_ID, SESSION_COOKIE } from '../../src/modules/platform/index.ts';
import { ManualClock } from '../../src/shared/clock.ts';
import { DB_URLS, TEST_ORIGIN, TEST_RP_ID, testEnv } from './env.ts';

export interface TestApp {
  app: App;
  clock: ManualClock;
  logs: string[];
  close(): Promise<void>;
}

const HUGE = { limit: 1_000_000, windowSeconds: 60 };

export async function startApp(overrides: AppOverrides = {}, env: Record<string, string | undefined> = {}): Promise<TestApp> {
  const clock = new ManualClock();
  const logs: string[] = [];
  const logger = createLogger('info', { write: (line: string) => void logs.push(line) });
  const app = await createApp(loadConfig(testEnv(env)), {
    clock,
    logger,
    generalLimit: HUGE,
    authLimits: { ...DEFAULT_AUTH_LIMITS, loginPerIp: HUGE, loginGlobal: HUGE },
    ...overrides,
  });
  return { app, clock, logs, close: () => app.close() };
}

/** Superuser connection - used ONLY by tests that prove what a superuser can and cannot hide. */
export async function superuser(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: DB_URLS.superuser });
  await client.connect();
  return client;
}

/** A raw connection as the application role, for tests that bypass the API on purpose. */
export async function appRoleClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: DB_URLS.app });
  await client.connect();
  return client;
}

// ----------------------------------------------------------------- HTTP client

export interface Res {
  status: number;
  body: any;
  headers: Record<string, unknown>;
  raw: string;
}

export class Client {
  readonly t: TestApp;
  cookie: string | null = null;
  csrf: string | null = null;
  ip = '127.0.0.1';

  constructor(t: TestApp) {
    this.t = t;
  }

  async request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown,
    opts: { idem?: string | false; headers?: Record<string, string>; noCsrf?: boolean; origin?: string | null } = {},
  ): Promise<Res> {
    const headers: Record<string, string> = { 'user-agent': 'legacyai-test-agent', ...(opts.headers ?? {}) };
    if (method !== 'GET') {
      if (opts.origin !== null) headers.origin = opts.origin ?? TEST_ORIGIN;
      if (this.csrf && !opts.noCsrf) headers['x-csrf-token'] = this.csrf;
      if (opts.idem !== false && opts.idem !== undefined) headers['idempotency-key'] = opts.idem;
    }
    const res = await this.t.app.http.app.inject({
      method, url, headers, remoteAddress: this.ip,
      ...(body === undefined ? {} : { payload: body as object }),
      ...(this.cookie ? { cookies: { [SESSION_COOKIE]: this.cookie } } : {}),
    });
    const setCookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
    if (setCookie) this.cookie = setCookie.value === '' ? null : setCookie.value;
    let parsed: unknown = null;
    try {
      parsed = res.body === '' ? null : JSON.parse(res.body);
    } catch {
      parsed = res.body;
    }
    if (parsed && typeof parsed === 'object' && typeof (parsed as { csrf_token?: unknown }).csrf_token === 'string') {
      this.csrf = (parsed as { csrf_token: string }).csrf_token;
    } else if (setCookie && this.cookie !== null) {
      // The server rotated the session (privilege change). A real client re-reads its session
      // to pick up the new CSRF token; so does this one.
      const refreshed = await this.t.app.http.app.inject({ method: 'GET', url: '/v1/auth/session', remoteAddress: this.ip, cookies: { [SESSION_COOKIE]: this.cookie } });
      if (refreshed.statusCode === 200) this.csrf = (refreshed.json() as { csrf_token: string }).csrf_token;
    }
    return { status: res.statusCode, body: parsed, headers: res.headers as Record<string, unknown>, raw: res.body };
  }

  get(url: string): Promise<Res> {
    return this.request('GET', url);
  }

  /** POST/PUT/PATCH/DELETE with a fresh idempotency key (what a well-behaved client sends). */
  post(url: string, body?: unknown, idem: string | false = `k-${randomUUID()}`): Promise<Res> {
    return this.request('POST', url, body, { idem });
  }
  put(url: string, body?: unknown, idem: string | false = `k-${randomUUID()}`): Promise<Res> {
    return this.request('PUT', url, body, { idem });
  }
  patch(url: string, body?: unknown, idem: string | false = `k-${randomUUID()}`): Promise<Res> {
    return this.request('PATCH', url, body, { idem });
  }
  del(url: string, idem: string | false = `k-${randomUUID()}`): Promise<Res> {
    return this.request('DELETE', url, undefined, { idem });
  }
}

// ---------------------------------------------------------- virtual passkey

const b64u = (b: Buffer | Uint8Array): string => Buffer.from(b).toString('base64url');
const sha = (b: Buffer | string): Buffer => createHash('sha256').update(b).digest();

/** A software authenticator that produces real, verifiable WebAuthn responses. */
export class VirtualPasskey {
  readonly credentialId = randomBytes(16);
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  signCount = 0;
  origin = TEST_ORIGIN;
  rpId = TEST_RP_ID;
  userVerified = true;

  constructor() {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  #clientData(type: string, challenge: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  #authData(withCredential: boolean): Buffer {
    const flags = 0x01 | (this.userVerified ? 0x04 : 0) | (withCredential ? 0x40 : 0);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.signCount);
    const parts = [sha(this.rpId), Buffer.from([flags]), counter];
    if (withCredential) {
      const jwk = this.publicKey.export({ format: 'jwk' });
      const cose = encodeCBOR(new Map<number, number | Uint8Array>([
        [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x as string, 'base64url')], [-3, Buffer.from(jwk.y as string, 'base64url')],
      ]));
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), len, this.credentialId, Buffer.from(cose));
    }
    return Buffer.concat(parts);
  }

  /** Response to navigator.credentials.create(). */
  attest(options: { challenge: string }): Record<string, unknown> {
    const clientDataJSON = this.#clientData('webauthn.create', options.challenge);
    const attestationObject = encodeCBOR(new Map<string, unknown>([
      ['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(this.#authData(true))],
    ]) as never);
    return {
      id: b64u(this.credentialId), rawId: b64u(this.credentialId), type: 'public-key',
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] },
      clientExtensionResults: {}, authenticatorAttachment: 'platform',
    };
  }

  /** Response to navigator.credentials.get(). */
  assert(options: { challenge: string }): Record<string, unknown> {
    this.signCount += 1;
    const clientDataJSON = this.#clientData('webauthn.get', options.challenge);
    const authData = this.#authData(false);
    const signature = createSign('sha256').update(Buffer.concat([authData, sha(clientDataJSON)])).sign(this.privateKey);
    return {
      id: b64u(this.credentialId), rawId: b64u(this.credentialId), type: 'public-key',
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature) },
      clientExtensionResults: {}, authenticatorAttachment: 'platform',
    };
  }
}

export async function totpCode(secret: string, t: TestApp): Promise<string> {
  return totpGenerate({ secret, epoch: Math.floor(t.clock.now().getTime() / 1000) });
}

// --------------------------------------------------------------- flow helpers

export interface IssuedCard {
  id: string;
  number: string;
  sc: string;
  enrollmentToken: string;
}

export type Factor = { passkey: VirtualPasskey } | { totp: string };

export async function enrollPasskey(t: TestApp, card: IssuedCard): Promise<VirtualPasskey> {
  const c = new Client(t);
  const begin = await c.request('POST', '/v1/auth/enrollment/begin', {
    card_number: card.number, sc: card.sc, enrollment_token: card.enrollmentToken, factor_type: 'passkey', label: 'test device',
  });
  if (begin.status !== 200) throw new Error(`enrollment begin failed: ${begin.status} ${begin.raw}`);
  const passkey = new VirtualPasskey();
  const done = await c.request('POST', '/v1/auth/enrollment/complete', {
    enrollment_txn: begin.body.enrollment_txn, attestation: passkey.attest(begin.body.webauthn_options),
  });
  if (done.status !== 204) throw new Error(`enrollment complete failed: ${done.status} ${done.raw}`);
  return passkey;
}

export async function enrollTotp(t: TestApp, card: IssuedCard): Promise<string> {
  const c = new Client(t);
  const begin = await c.request('POST', '/v1/auth/enrollment/begin', {
    card_number: card.number, sc: card.sc, enrollment_token: card.enrollmentToken, factor_type: 'totp',
  });
  if (begin.status !== 200) throw new Error(`enrollment begin failed: ${begin.status} ${begin.raw}`);
  const secret = begin.body.totp.secret as string;
  const done = await c.request('POST', '/v1/auth/enrollment/complete', {
    enrollment_txn: begin.body.enrollment_txn, totp_code: await totpCode(secret, t),
  });
  if (done.status !== 204) throw new Error(`enrollment complete failed: ${done.status} ${done.raw}`);
  // The code used to enrol cannot be reused to log in; move to the next 30-second step.
  t.clock.advance(31_000);
  return secret;
}

/** One login attempt. Returns the client (holding the cookie on success) and the verify response. */
export async function tryLogin(t: TestApp, cardNumber: string, sc: string, factor: Factor, ip = '127.0.0.1'): Promise<{ client: Client; res: Res }> {
  const client = new Client(t);
  client.ip = ip;
  const begin = await client.request('POST', '/v1/auth/login/begin', { card_number: cardNumber });
  if (begin.status !== 200) return { client, res: begin };
  const f = 'passkey' in factor
    ? { type: 'passkey', assertion: factor.passkey.assert(begin.body.webauthn_options) }
    : { type: 'totp', code: await totpCode(factor.totp, t) };
  const res = await client.request('POST', '/v1/auth/login/verify', { login_txn: begin.body.login_txn, sc, factor: f });
  return { client, res };
}

export async function login(t: TestApp, card: Pick<IssuedCard, 'number' | 'sc'>, factor: Factor): Promise<Client> {
  const { client, res } = await tryLogin(t, card.number, card.sc, factor);
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.raw}`);
  return client;
}

const fromSecrets = (s: any): IssuedCard => ({
  id: s.card.id, number: s.card.card_number, sc: s.sc, enrollmentToken: s.enrollment_token,
});

let operator: { card: IssuedCard; passkey: VirtualPasskey } | null = null;

/**
 * A LegacyAI operator card in the platform tenant. Each test file makes its own (test files
 * do not share memory), using the same card service the bootstrap CLI uses.
 */
export async function platformOperator(t: TestApp, opts: { fresh?: boolean } = {}): Promise<Client> {
  // `fresh`: issue a NEW operator card at the current (test) time - needed after a test has moved
  // the clock past the first operator card's 90-day validity.
  if (operator === null || opts.fresh === true) {
    const ctx = { requestId: 'test-operator', ip: '127.0.0.1', userAgent: 'test', now: t.clock.now() };
    const issued = await t.app.db.withTenantTx(PLATFORM_TENANT_ID, async (tx) => {
      const person = await tx.query<{ id: string }>(
        'INSERT INTO people (tenant_id, display_name) VALUES ($1, $2) RETURNING id', [PLATFORM_TENANT_ID, `Operator ${randomUUID().slice(0, 8)}`]);
      return t.app.identity.cards.issue(
        tx, { tenantId: PLATFORM_TENANT_ID, kind: 'person', personId: (person.rows[0] as { id: string }).id, roles: [{ role_key: 'company_owner' }], actorCardId: null },
        await getSettings(tx, PLATFORM_TENANT_ID), ctx);
    });
    const card: IssuedCard = {
      id: issued.card.id, number: formatCardNumber(issued.card.card_number), sc: issued.sc, enrollmentToken: issued.enrollmentToken as string,
    };
    operator = { card, passkey: await enrollPasskey(t, card) };
  }
  return login(t, operator.card, { passkey: operator.passkey });
}

export interface TestTenant {
  tenantId: string;
  slug: string;
  companyCard: { id: string; number: string; sc: string };
  ownerCard: IssuedCard;
  ownerPasskey: VirtualPasskey;
  owner: Client;
}

let tenantCounter = 0;

export async function createTenant(t: TestApp, label = 'acme'): Promise<TestTenant> {
  const op = await platformOperator(t);
  tenantCounter += 1;
  const slug = `${label}-${Date.now().toString(36)}-${tenantCounter}`.slice(0, 40);
  const res = await op.post('/v1/tenants', { name: `Test ${label}`, slug, owner_display_name: 'Test Owner' });
  if (res.status !== 201) throw new Error(`create tenant failed: ${res.status} ${res.raw}`);
  const ownerCard = fromSecrets(res.body.owner_card);
  const ownerPasskey = await enrollPasskey(t, ownerCard);
  return {
    tenantId: res.body.tenant.id, slug,
    companyCard: { id: res.body.company_card.card.id, number: res.body.company_card.card.card_number, sc: res.body.company_card.sc },
    ownerCard, ownerPasskey, owner: await login(t, ownerCard, { passkey: ownerPasskey }),
  };
}

/** The platform operator renews a tenant's company card (nobody inside the tenant can). */
export async function renewCompanyCard(t: TestApp, tenantId: string, opts: { fresh?: boolean; body?: unknown } = {}): Promise<Res> {
  const op = await platformOperator(t, { fresh: opts.fresh });
  return op.post(`/v1/tenants/${tenantId}/company-card/renew`, opts.body ?? {});
}

export interface TestMember {
  personId: string;
  card: IssuedCard;
  passkey: VirtualPasskey;
  client: Client;
}

/** Creates a person, issues a card with the given roles, enrols a passkey and logs in. */
export async function addMember(
  t: TestApp, admin: Client, roles: Array<{ role_key: string; department_id?: string }>, opts: { departmentId?: string; login?: boolean } = {},
): Promise<TestMember> {
  const person = await admin.post('/v1/people', { display_name: `Member ${randomUUID().slice(0, 8)}`, department_id: opts.departmentId ?? null });
  if (person.status !== 201) throw new Error(`create person failed: ${person.status} ${person.raw}`);
  const issued = await admin.post('/v1/cards', { person_id: person.body.id, roles });
  if (issued.status !== 201) throw new Error(`issue card failed: ${issued.status} ${issued.raw}`);
  const card = fromSecrets(issued.body);
  const passkey = await enrollPasskey(t, card);
  const client = opts.login === false ? new Client(t) : await login(t, card, { passkey });
  return { personId: person.body.id, card, passkey, client };
}

export { fromSecrets };
