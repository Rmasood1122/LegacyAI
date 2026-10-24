// SSO with the providers companies use (decision D39, docs/phase4/07-sso-scim.md "Real providers"): what differs between
// Google, Microsoft Entra ID and Okta, as each one documents it (read 2026-10-24). Against the test stand-in provider
// only - it plays each provider's address and quirks; no real provider, account or key is used.
import { describe, expect, it } from 'vitest';
import {
  authorizationUrl, domainMatches, exchangeCode, GOOGLE_ISSUER, issuerProblem, issuerSetupProblem, newFlowSecrets, OidcCache, OidcError,
  providerKind, rulesFor, tokenAuthOf,
} from '../../src/modules/identity-access/index.ts';
import { FakeIdp, type TokenTweaks } from '../helpers/fake-idp.ts';

const REDIRECT = 'http://localhost:3000/sso/return/00000000-0000-4000-8000-000000000001';
const ENTRA = 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0';

describe('which provider an issuer is, and its rules', () => {
  it('Google, Microsoft (also the US government and China clouds), Okta, anything else', () => {
    expect(providerKind(GOOGLE_ISSUER)).toBe('google');
    expect(providerKind('https://accounts.google.com/')).toBe('google');
    expect(providerKind(ENTRA)).toBe('microsoft');
    expect(providerKind('https://login.microsoftonline.us/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0')).toBe('microsoft');
    expect(providerKind('https://acme.okta.com')).toBe('okta');
    expect(providerKind('https://acme.okta.com/oauth2/default')).toBe('okta');
    expect(providerKind('https://acme.oktapreview.com/oauth2/aus1')).toBe('okta');
    expect(providerKind('https://keycloak.acme.example/realms/staff')).toBe('other');
    // a look-alike is not the provider
    expect(providerKind('https://accounts.google.com.evil.example')).toBe('other');
    expect(providerKind('https://okta.com.evil.example')).toBe('other');
    expect(providerKind('https://login.microsoftonline.com.evil.example/x/v2.0')).toBe('other');
  });

  it('Google: its ID tokens say either form of its issuer; it has no "login" prompt; it needs the company\'s domain', () => {
    expect(rulesFor(GOOGLE_ISSUER)).toEqual({ kind: 'google', issuers: [GOOGLE_ISSUER, 'accounts.google.com'], prompt: 'select_account', needsDomain: true });
    for (const issuer of [ENTRA, 'https://acme.okta.com', 'https://idp.example.test']) {
      expect(rulesFor(issuer)).toMatchObject({ issuers: [issuer], prompt: 'login', needsDomain: false });
    }
  });

  it('Microsoft: only a tenant-specific issuer - not common, organizations, consumers or a domain name', () => {
    expect(issuerSetupProblem(ENTRA)).toBeNull();
    for (const tenant of ['common', 'organizations', 'consumers', 'contoso.onmicrosoft.com']) {
      expect(issuerSetupProblem(`https://login.microsoftonline.com/${tenant}/v2.0`), tenant).toBe('microsoft-needs-tenant-id');
    }
    // the old v1 endpoint (no /v2.0) is not what the API speaks
    expect(issuerSetupProblem('https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad')).toBe('microsoft-needs-tenant-id');
    expect(issuerSetupProblem('https://acme.okta.com')).toBeNull();
    expect(issuerSetupProblem(GOOGLE_ISSUER)).toBeNull();
    // the address rules every issuer follows still apply
    expect(issuerProblem(ENTRA)).toBe(false);
  });

  it('the domain matches only exactly (case aside); a token without one never matches', () => {
    expect(domainMatches('Example.com', 'example.com')).toBe(true);
    for (const hd of [undefined, null, '', 'example.co', 'sub.example.com', 'example.com.evil.example', ['example.com']]) {
      expect(domainMatches(hd, 'example.com'), String(hd)).toBe(false);
    }
  });

  it('how the client secret is sent: HTTP Basic unless the provider offers only the form body', () => {
    expect(tokenAuthOf(undefined)).toBe('basic');
    expect(tokenAuthOf(['client_secret_post', 'client_secret_basic'])).toBe('basic');
    expect(tokenAuthOf(['client_secret_post', 'private_key_jwt'])).toBe('post');
    expect(() => tokenAuthOf(['private_key_jwt'])).toThrow(OidcError);
  });
});

describe('a sign-in through each provider', () => {
  const run = async (idp: FakeIdp, sub: string, p: { domain?: string | null; tweaks?: TokenTweaks } = {}): Promise<{ subject: string }> => {
    const cache = new OidcCache(idp.http);
    const secrets = newFlowSecrets();
    const d = await cache.discovery(idp.issuer, Date.now());
    const { code } = idp.authorize(authorizationUrl(d, { clientId: idp.clientId, redirectUri: REDIRECT, secrets, domain: p.domain ?? null }), sub);
    idp.tweakNext = p.tweaks ?? null;
    return exchangeCode(cache, {
      issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, redirectUri: REDIRECT, code, codeVerifier: secrets.codeVerifier,
      nonce: secrets.nonce, now: new Date(), domain: p.domain ?? null,
    });
  };
  const refused = async (p: Promise<unknown>): Promise<void> => {
    await expect(p).rejects.toBeInstanceOf(OidcError);
    await expect(p).rejects.toMatchObject({ reason: 'id_token_invalid' });
  };

  it('Google: an account of the company\'s domain gets in, with either form of Google\'s issuer; the page is asked for the account chooser and the domain', async () => {
    const google = await new FakeIdp({ issuer: GOOGLE_ISSUER }).start();
    google.discoveryExtra = { token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'] };
    expect(await run(google, '104512345678901234567', { domain: 'example.com', tweaks: { hd: 'example.com' } })).toEqual({ subject: '104512345678901234567' });
    expect(await run(google, '104512345678901234567', { domain: 'example.com', tweaks: { hd: 'example.com', issuer: 'accounts.google.com' } }))
      .toEqual({ subject: '104512345678901234567' });
    expect(google.asked.at(-1)).toEqual({ prompt: 'select_account', hd: 'example.com' });
  });

  it('Google: a personal account (no hd), another company\'s account, or a connection without a domain: refused', async () => {
    const google = await new FakeIdp({ issuer: GOOGLE_ISSUER }).start();
    await refused(run(google, '1045', { domain: 'example.com' }));
    await refused(run(google, '1045', { domain: 'example.com', tweaks: { hd: 'other.example' } }));
    await refused(run(google, '1045', { domain: null, tweaks: { hd: 'example.com' } }));
    // "accounts.google.com" is accepted from Google only: another provider's token saying it is refused
    const other = await new FakeIdp().start();
    await refused(run(other, 'x', { tweaks: { issuer: 'accounts.google.com' } }));
  });

  it('Microsoft Entra ID: a fresh sign-in is asked for (prompt=login); a token from another tenant is refused', async () => {
    const entra = await new FakeIdp({ issuer: ENTRA }).start();
    entra.discoveryExtra = { token_endpoint_auth_methods_supported: ['client_secret_post', 'private_key_jwt', 'client_secret_basic'] };
    expect(await run(entra, 'AAAAAAAAAAAAAAAAAAAAAIkzqFVrSaSaFHy782bbtaQ')).toEqual({ subject: 'AAAAAAAAAAAAAAAAAAAAAIkzqFVrSaSaFHy782bbtaQ' });
    expect(entra.asked.at(-1)).toEqual({ prompt: 'login', hd: null });
    await refused(run(entra, 'x', { tweaks: { issuer: 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0' } }));
  });

  it('Okta (custom authorization server): prompt=login; no domain is sent', async () => {
    const okta = await new FakeIdp({ issuer: 'https://acme.okta.com/oauth2/default' }).start();
    expect(await run(okta, '00u1abcd')).toEqual({ subject: '00u1abcd' });
    expect(okta.asked.at(-1)).toEqual({ prompt: 'login', hd: null });
  });

  it('a provider that takes the secret only in the form body gets it there - never both, never in a log-able header', async () => {
    const formOnly = await new FakeIdp().start();
    formOnly.discoveryExtra = { token_endpoint_auth_methods_supported: ['client_secret_post'] };
    formOnly.secretInBody = true;
    expect(await run(formOnly, 'person-1')).toEqual({ subject: 'person-1' });
    const post = formOnly.requests.find((r) => r.method === 'POST');
    expect(post?.headers?.authorization).toBeUndefined();
    // and a provider that offers neither is not used at all
    const neither = await new FakeIdp().start();
    neither.discoveryExtra = { token_endpoint_auth_methods_supported: ['private_key_jwt'] };
    await expect(new OidcCache(neither.http).discovery(neither.issuer, Date.now())).rejects.toMatchObject({ reason: 'discovery_invalid' });
  });
});
