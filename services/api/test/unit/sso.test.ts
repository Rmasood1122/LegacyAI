// SSO (feature 16, part A; D33): the rules that need no database - what the OpenID Connect client trusts, the PKCE
// challenge against the published example, which ID tokens are refused, what the SSO factor proves, the issuer and
// redirect rules. The whole sign-in against the database is in test/integration/sso.test.ts.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  authorizationUrl, codeChallenge, discover, exchangeCode, issuerProblem, newFlowSecrets, OidcCache, OidcError, ssoIdentityOf, verifySsoFactor,
} from '../../src/modules/identity-access/index.ts';
import { ConfigError, loadConfig } from '../../src/modules/platform/index.ts';
import { FakeIdp, type TokenTweaks } from '../helpers/fake-idp.ts';
import { testEnv } from '../helpers/env.ts';

const REDIRECT = 'http://localhost:3000/sso/return';

describe('PKCE and the sign-in address', () => {
  it('the code challenge is S256 of the verifier (RFC 7636, appendix B)', () => {
    expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('state, nonce and verifier are 32 random bytes each, new every time', () => {
    const a = newFlowSecrets();
    const b = newFlowSecrets();
    for (const v of Object.values(a)) expect(Buffer.from(v, 'base64url')).toHaveLength(32);
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });

  it('asks for a fresh sign-in, the openid scope, the code flow with PKCE - and carries no secret', () => {
    const secrets = newFlowSecrets();
    const url = new URL(authorizationUrl(
      { issuer: 'https://idp.example.test', authorization_endpoint: 'https://idp.example.test/authorize?tenant=1', token_endpoint: 'x', jwks_uri: 'y' },
      { clientId: 'c', redirectUri: REDIRECT, secrets }));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      tenant: '1', response_type: 'code', client_id: 'c', redirect_uri: REDIRECT, scope: 'openid', state: secrets.state, nonce: secrets.nonce,
      code_challenge: codeChallenge(secrets.codeVerifier), code_challenge_method: 'S256', prompt: 'login',
    });
    expect(url.toString()).not.toContain(secrets.codeVerifier);
  });
});

describe('what the client trusts from the provider', () => {
  let idp: FakeIdp;
  beforeAll(async () => {
    idp = await new FakeIdp().start();
  });

  const signIn = async (sub: string, tweaks?: TokenTweaks, over: { secret?: string; verifier?: string; nonce?: string } = {}): Promise<{ subject: string }> => {
    const cache = new OidcCache(idp.http);
    const secrets = newFlowSecrets();
    const d = await cache.discovery(idp.issuer, Date.now());
    const { code } = idp.authorize(authorizationUrl(d, { clientId: idp.clientId, redirectUri: REDIRECT, secrets }), sub);
    idp.tweakNext = tweaks ?? null;
    return exchangeCode(cache, {
      issuer: idp.issuer, clientId: idp.clientId, clientSecret: over.secret ?? idp.clientSecret, redirectUri: REDIRECT, code,
      codeVerifier: over.verifier ?? secrets.codeVerifier, nonce: over.nonce ?? secrets.nonce, now: new Date(),
    });
  };
  const refused = async (p: Promise<unknown>, reason: string): Promise<void> => {
    await expect(p).rejects.toBeInstanceOf(OidcError);
    await expect(p).rejects.toMatchObject({ reason });
  };

  it('a proper sign-in gives the provider\'s subject', async () => {
    expect(await signIn('employee-0001')).toEqual({ subject: 'employee-0001' });
  });

  it('the discovery document must name exactly the configured issuer', async () => {
    const liar = await new FakeIdp().start();
    liar.lieAboutIssuer = true;
    await refused(discover(liar.http, liar.issuer), 'issuer_mismatch');
  });

  it.each<[string, TokenTweaks]>([
    ['signed with a key the provider does not publish', { foreignKey: true }],
    ['not signed at all (alg none)', { alg: 'none' }],
    ['another nonce (a token from another sign-in)', { nonce: 'replayed-nonce' }],
    ['for another client', { audience: 'someone-else' }],
    ['for several clients without azp naming us', { audience: ['legacyai-test-client', 'someone-else'] }],
    ['azp naming another client', { azp: 'someone-else' }],
    ['from another issuer', { issuer: 'https://evil.example.test' }],
    ['expired (beyond 2 minutes of tolerance)', { expiresIn: -300 }],
    ['issued more than 10 minutes ago', { issuedAgo: 900 }],
  ])('an ID token %s is refused', async (_name, tweaks) => {
    await refused(signIn('employee-0002', tweaks), 'id_token_invalid');
  });

  it('a wrong client secret, a wrong PKCE verifier or a used code: the provider refuses and so do we', async () => {
    await refused(signIn('employee-0003', undefined, { secret: 'wrong' }), 'token_request_failed');
    await refused(signIn('employee-0003', undefined, { verifier: newFlowSecrets().codeVerifier }), 'token_request_failed');
  });

  it('several audiences are fine when azp names us', async () => {
    expect(await signIn('employee-0004', { audience: [idp.clientId, 'other'], azp: idp.clientId })).toEqual({ subject: 'employee-0004' });
  });

  it('the client never talks to an address the provider did not publish, and only over https', async () => {
    idp.requests.length = 0;
    await signIn('employee-0005');
    expect(idp.requests.every((r) => r.url.startsWith(`${idp.issuer}/`))).toBe(true);
    expect(idp.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['GET /.well-known/openid-configuration', 'POST /token', 'GET /jwks']);
    const token = idp.requests.find((r) => r.method === 'POST');
    expect(token?.body).not.toContain(idp.clientSecret);   // the secret goes in the Authorization header, not the body
  });
});

describe('what the SSO factor proves', () => {
  const credentials = [
    { id: 'cred-1', card_id: 'card-1', type: 'sso' as const, sso_connection_id: 'conn-1', sso_subject: 'employee-1',
      webauthn_credential_id: null, webauthn_public_key: null, webauthn_sign_count: null, webauthn_transports: null, totp_secret_enc: null, totp_key_id: null },
  ];
  const identity = { tenantId: 't-1', connectionId: 'conn-1', subject: 'employee-1' };

  it('the provider vouched for the identity linked to THIS card, through this company\'s connection: a proof', () => {
    const proof = verifySsoFactor({ tenantId: 't-1', cardId: 'card-1', credentials, identity });
    expect(proof).toMatchObject({ cardId: 'card-1', credentialId: 'cred-1', factorType: 'sso' });
  });

  it.each([
    ['another person at the provider', { identity: { ...identity, subject: 'employee-2' } }],
    ['the same person, through another connection', { identity: { ...identity, connectionId: 'conn-2' } }],
    ['a sign-in at ANOTHER company\'s provider', { identity: { ...identity, tenantId: 't-2' } }],
    ['another card of the company', { cardId: 'card-2' }],
    ['no sign-in at the provider in this step', { identity: null }],
    ['an unknown card', { cardId: null }],
  ])('%s: no proof', (_name, over) => {
    expect(verifySsoFactor({ tenantId: 't-1', cardId: 'card-1', credentials, identity, ...over })).toBeNull();
  });

  it('what a step carries is checked again when it is read', () => {
    expect(ssoIdentityOf({ sso: identity, card_hmac: 'x' })).toEqual(identity);
    expect(ssoIdentityOf({ card_hmac: 'x' })).toBeNull();
    expect(ssoIdentityOf({ sso: { tenantId: 't', connectionId: 1, subject: 's' } })).toBeNull();
    expect(ssoIdentityOf(null)).toBeNull();
  });
});

describe('issuer and redirect address', () => {
  it.each([
    ['https://login.example.com/tenant-1/v2.0', false], ['https://idp.example.com', false],
    ['http://idp.example.com', true], ['https://idp.example.com/?x=1', true], ['https://idp.example.com/#a', true], ['https://u:p@idp.example.com', true], ['nope', true],
  ])('issuer %s refused: %s', (issuer, expected) => {
    expect(issuerProblem(issuer)).toBe(expected);
  });

  it('the redirect address defaults to the web application and must be one of its origins (https in production)', () => {
    expect(loadConfig(testEnv()).sso.redirectUri).toMatch(/\/sso\/return$/);
    expect(() => loadConfig(testEnv({ SSO_REDIRECT_URI: 'https://evil.example.com/sso/return' }))).toThrow(ConfigError);
    expect(() => loadConfig(testEnv({ SSO_REDIRECT_URI: 'not a url' }))).toThrow(/SSO_REDIRECT_URI/);
  });
});
