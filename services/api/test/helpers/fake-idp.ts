// A stand-in OpenID Connect provider for tests: no network, no account. It answers the API's requests (discovery, keys,
// token) through the OidcHttp port, and plays "the person signs in at the provider" with authorize(). Its keys are
// made when it starts and never leave the test. Everything it checks, it checks as a strict provider would: client
// secret, redirect address, PKCE verifier, single-use codes.
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import type { HttpsRequest, HttpsResponse } from '../../src/modules/platform/index.ts';

interface Issued { sub: string; nonce: string; challenge: string; redirectUri: string; clientId: string; used: boolean }

export interface TokenTweaks {
  /** Sign with a key the provider does not publish. */
  foreignKey?: boolean;
  nonce?: string;
  audience?: string | string[];
  azp?: string;
  issuer?: string;
  /** Seconds relative to now. */
  expiresIn?: number;
  issuedAgo?: number;
  alg?: 'none';
}

export class FakeIdp {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  #privateKey!: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  #foreignKey!: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  #jwk!: JWK;
  readonly #codes = new Map<string, Issued>();
  /** Every request the API made, for assertions. */
  readonly requests: HttpsRequest[] = [];
  /** The next token answer is changed like this (once). */
  tweakNext: TokenTweaks | null = null;
  /** The discovery document says another issuer. */
  lieAboutIssuer = false;
  /** The discovery document names these endpoints instead of its own. */
  endpoints: Partial<Record<'authorization_endpoint' | 'token_endpoint' | 'jwks_uri', string>> = {};

  constructor(p: { issuer?: string; clientId?: string; clientSecret?: string } = {}) {
    this.issuer = p.issuer ?? `https://idp-${randomBytes(4).toString('hex')}.example.test`;
    this.clientId = p.clientId ?? 'legacyai-test-client';
    this.clientSecret = p.clientSecret ?? `test-only-client-secret-${randomBytes(8).toString('hex')}`;
  }

  async start(): Promise<this> {
    const pair = await generateKeyPair('RS256', { extractable: true });
    this.#privateKey = pair.privateKey;
    this.#jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key-1', alg: 'RS256', use: 'sig' };
    this.#foreignKey = (await generateKeyPair('RS256')).privateKey;
    return this;
  }

  /** The OidcHttp port. Requests to other hosts fail like a host that does not exist. */
  readonly http = async (req: HttpsRequest): Promise<HttpsResponse> => {
    this.requests.push(req);
    const url = new URL(req.url);
    if (url.origin !== new URL(this.issuer).origin) return { ok: false, error: 'dns' };
    const json = (status: number, body: unknown): HttpsResponse => ({ ok: true, status, body: Buffer.from(JSON.stringify(body)) });
    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: this.lieAboutIssuer ? 'https://other.example.test' : this.issuer, authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`, jwks_uri: `${this.issuer}/jwks`, ...this.endpoints,
      });
    }
    if (req.method === 'GET' && url.pathname === '/jwks') return json(200, { keys: [this.#jwk] });
    if (req.method === 'POST' && url.pathname === '/token') return this.#token(req);
    return json(404, { error: 'not_found' });
  };

  /** "The person signs in at the provider as `sub`": checks the request the API built, returns what the browser brings back. */
  authorize(authorizationUrl: string, sub: string): { code: string; state: string; redirectUri: string } {
    const url = new URL(authorizationUrl);
    if (`${url.origin}${url.pathname}` !== `${this.issuer}/authorize`) throw new Error(`fake idp: not my authorize endpoint: ${url.origin}${url.pathname}`);
    const q = url.searchParams;
    for (const [k, v] of [['response_type', 'code'], ['client_id', this.clientId], ['scope', 'openid'], ['code_challenge_method', 'S256']] as const) {
      if (q.get(k) !== v) throw new Error(`fake idp: ${k} is ${q.get(k)}, expected ${v}`);
    }
    const state = q.get('state');
    const nonce = q.get('nonce');
    const challenge = q.get('code_challenge');
    const redirectUri = q.get('redirect_uri');
    if (!state || !nonce || !challenge || !redirectUri) throw new Error('fake idp: state, nonce, code_challenge and redirect_uri are required');
    const code = randomBytes(24).toString('base64url');
    this.#codes.set(code, { sub, nonce, challenge, redirectUri, clientId: this.clientId, used: false });
    return { code, state, redirectUri };
  }

  async #token(req: HttpsRequest): Promise<HttpsResponse> {
    const fail = (error: string): HttpsResponse => ({ ok: true, status: 400, body: Buffer.from(JSON.stringify({ error })) });
    const auth = req.headers?.authorization ?? '';
    const expected = `Basic ${Buffer.from(`${encodeURIComponent(this.clientId)}:${encodeURIComponent(this.clientSecret)}`).toString('base64')}`;
    if (auth !== expected) return { ok: true, status: 401, body: Buffer.from('{"error":"invalid_client"}') };
    const form = new URLSearchParams(req.body ?? '');
    const issued = this.#codes.get(form.get('code') ?? '');
    if (form.get('grant_type') !== 'authorization_code' || issued === undefined || issued.used) return fail('invalid_grant');
    issued.used = true;
    if (form.get('redirect_uri') !== issued.redirectUri) return fail('invalid_grant');
    const verifier = form.get('code_verifier') ?? '';
    if (createHash('sha256').update(verifier).digest('base64url') !== issued.challenge) return fail('invalid_grant');
    const t = this.tweakNext ?? {};
    this.tweakNext = null;
    const now = Math.floor(Date.now() / 1000);
    let idToken: string;
    const claims: Record<string, unknown> = { nonce: t.nonce ?? issued.nonce, ...(t.azp === undefined ? {} : { azp: t.azp }) };
    if (t.alg === 'none') {
      const enc = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url');
      idToken = `${enc({ alg: 'none' })}.${enc({ ...claims, iss: this.issuer, sub: issued.sub, aud: this.clientId, iat: now, exp: now + 300 })}.`;
    } else {
      idToken = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
        .setIssuer(t.issuer ?? this.issuer)
        .setSubject(issued.sub)
        .setAudience(t.audience ?? issued.clientId)
        .setIssuedAt(now - (t.issuedAgo ?? 0))
        .setExpirationTime(now + (t.expiresIn ?? 300))
        .sign(t.foreignKey === true ? this.#foreignKey : this.#privateKey);
    }
    return { ok: true, status: 200, body: Buffer.from(JSON.stringify({ access_token: 'unused', token_type: 'Bearer', id_token: idToken })) };
  }
}
