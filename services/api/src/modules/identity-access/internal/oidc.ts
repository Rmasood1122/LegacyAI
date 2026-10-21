// OpenID Connect against a company's identity provider: the authorization-code flow with PKCE, for a confidential
// client (the API holds a client secret). docs/phase4/07-sso-scim.md, decision D33.
//
// What is trusted, and why:
//   - the provider's endpoints come from its discovery document, fetched from the configured issuer; the document's
//     own `issuer` must equal the configured one exactly; every endpoint must be an address the server may call
//     (https, port 443, a public host name - the webhook rules), and the sign-in page must be on the issuer's own
//     host (the browser is sent there from our sign-in screen: it must not become a way to send people anywhere);
//   - every request goes through the platform's guarded https client (public addresses only, pinned, no redirect,
//     time and size limits) - a company cannot point the server at an internal address;
//   - the ID token is checked with `jose` (already a dependency): signature against the provider's published keys,
//     asymmetric algorithms only, issuer, audience = our client id (and `azp` when there are several audiences),
//     expiry with 2 minutes of tolerance, issued within the last 10 minutes, and the nonce we sent;
//   - the identity is `sub`, which the provider promises never to reassign. E-mail addresses are NOT used to link
//     anyone: a provider may let people choose them.
import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { urlProblem, type HttpsRequest, type HttpsResponse } from '../../platform/index.ts';

export type OidcHttp = (req: HttpsRequest) => Promise<HttpsResponse>;

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export type OidcFailure =
  | 'discovery_unreachable' | 'discovery_invalid' | 'issuer_mismatch'
  | 'token_request_failed' | 'token_response_invalid' | 'id_token_invalid' | 'jwks_unreachable';

export class OidcError extends Error {
  readonly reason: OidcFailure;
  constructor(reason: OidcFailure) {
    super(`oidc: ${reason}`);
    this.reason = reason;
  }
}

const callable = (v: unknown): v is string => typeof v === 'string' && urlProblem(v) === null;
const hostOf = (v: string): string => new URL(v).hostname.toLowerCase();

async function getJson(http: OidcHttp, url: string, failure: OidcFailure): Promise<unknown> {
  const res = await http({ url, method: 'GET', headers: { accept: 'application/json' } });
  if (!res.ok || res.status !== 200) throw new OidcError(failure);
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    throw new OidcError(failure);
  }
}

/** The discovery document, checked. Pure apart from the request. */
export async function discover(http: OidcHttp, issuer: string): Promise<Discovery> {
  const doc = await getJson(http, `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, 'discovery_unreachable') as Record<string, unknown>;
  if (doc === null || typeof doc !== 'object') throw new OidcError('discovery_invalid');
  if (doc.issuer !== issuer) throw new OidcError('issuer_mismatch');
  const { authorization_endpoint: auth, token_endpoint: token, jwks_uri: jwks } = doc;
  if (!callable(auth) || !callable(token) || !callable(jwks)) throw new OidcError('discovery_invalid');
  if (hostOf(auth) !== hostOf(issuer)) throw new OidcError('discovery_invalid');
  return { issuer, authorization_endpoint: auth, token_endpoint: token, jwks_uri: jwks };
}

/** Discovery documents and key sets change rarely: kept for 10 minutes per issuer (in memory, per process). */
export class OidcCache {
  readonly #entries = new Map<string, { at: number; discovery: Discovery; jwks: JSONWebKeySet | null }>();
  readonly #http: OidcHttp;
  constructor(http: OidcHttp) {
    this.#http = http;
  }
  get http(): OidcHttp {
    return this.#http;
  }
  async discovery(issuer: string, now: number): Promise<Discovery> {
    const hit = this.#entries.get(issuer);
    if (hit && now - hit.at < 600_000) return hit.discovery;
    const discovery = await discover(this.#http, issuer);
    this.#entries.set(issuer, { at: now, discovery, jwks: null });
    return discovery;
  }
  /** The provider's keys. `fresh` fetches them again (a key the provider just rotated in). */
  async jwks(issuer: string, now: number, fresh = false): Promise<JSONWebKeySet> {
    const discovery = await this.discovery(issuer, now);
    const hit = this.#entries.get(issuer);
    if (!fresh && hit?.jwks) return hit.jwks;
    const set = await getJson(this.#http, discovery.jwks_uri, 'jwks_unreachable') as JSONWebKeySet;
    if (set === null || typeof set !== 'object' || !Array.isArray(set.keys)) throw new OidcError('jwks_unreachable');
    this.#entries.set(issuer, { at: hit?.at ?? now, discovery, jwks: set });
    return set;
  }
}

export interface FlowSecrets { state: string; nonce: string; codeVerifier: string }

export function newFlowSecrets(): FlowSecrets {
  return { state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'), codeVerifier: randomBytes(32).toString('base64url') };
}

export const codeChallenge = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

/** Where the browser is sent to sign in. Pure. */
export function authorizationUrl(d: Discovery, p: { clientId: string; redirectUri: string; secrets: FlowSecrets }): string {
  const url = new URL(d.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('scope', 'openid');
  url.searchParams.set('state', p.secrets.state);
  url.searchParams.set('nonce', p.secrets.nonce);
  url.searchParams.set('code_challenge', codeChallenge(p.secrets.codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'login');   // a sign-in is a factor: ask for it, do not reuse an old provider session silently
  return url.toString();
}

const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

/** The provider's ID token as an identity, or an OidcError. */
export async function verifyIdToken(idToken: string, keys: JSONWebKeySet, p: { issuer: string; clientId: string; nonce: string; now: Date }): Promise<{ subject: string }> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(idToken, createLocalJWKSet(keys), {
      issuer: p.issuer, audience: p.clientId, algorithms: ALGORITHMS, clockTolerance: 120, maxTokenAge: '10m', currentDate: p.now, requiredClaims: ['sub', 'iat', 'exp'],
    }));
  } catch {
    throw new OidcError('id_token_invalid');
  }
  if (payload.nonce !== p.nonce) throw new OidcError('id_token_invalid');
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== p.clientId) throw new OidcError('id_token_invalid');
  if (payload.azp !== undefined && payload.azp !== p.clientId) throw new OidcError('id_token_invalid');
  const sub = payload.sub;
  if (typeof sub !== 'string' || sub.length < 1 || sub.length > 255) throw new OidcError('id_token_invalid');
  return { subject: sub };
}

/** Code -> verified identity: the token request (client secret over HTTP Basic, the PKCE verifier) and the checks. */
export async function exchangeCode(cache: OidcCache, p: {
  issuer: string; clientId: string; clientSecret: string; redirectUri: string; code: string; codeVerifier: string; nonce: string; now: Date;
}): Promise<{ subject: string }> {
  const d = await cache.discovery(p.issuer, p.now.getTime());
  const basic = Buffer.from(`${encodeURIComponent(p.clientId)}:${encodeURIComponent(p.clientSecret)}`).toString('base64');
  const form = new URLSearchParams({ grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, code_verifier: p.codeVerifier });
  const res = await cache.http({
    url: d.token_endpoint, method: 'POST', body: form.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', authorization: `Basic ${basic}` },
  });
  if (!res.ok || res.status !== 200) throw new OidcError('token_request_failed');
  let tokens: Record<string, unknown>;
  try {
    tokens = JSON.parse(res.body.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new OidcError('token_response_invalid');
  }
  if (typeof tokens.id_token !== 'string' || tokens.id_token.length > 16_384) throw new OidcError('token_response_invalid');
  const check = (keys: JSONWebKeySet) => verifyIdToken(tokens.id_token as string, keys, { issuer: p.issuer, clientId: p.clientId, nonce: p.nonce, now: p.now });
  try {
    return await check(await cache.jwks(p.issuer, p.now.getTime()));
  } catch (err) {
    // the provider may have rotated its keys since we last fetched them: once more with fresh keys
    if (!(err instanceof OidcError) || err.reason !== 'id_token_invalid') throw err;
    return check(await cache.jwks(p.issuer, p.now.getTime(), true));
  }
}
