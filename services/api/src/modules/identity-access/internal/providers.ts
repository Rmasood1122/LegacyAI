// What differs between the identity providers companies actually use (decision D39; docs/phase4/07-sso-scim.md,
// "Real providers"). Everything else is plain OpenID Connect and the same for all. Pure: no network, no database.
//
// Read from each provider's own documentation on 2026-10-24:
//   Google (https://developers.google.com/identity/openid-connect/openid-connect):
//     - the ID token's `iss` is "https://accounts.google.com" OR "accounts.google.com": both are Google;
//     - `prompt` takes none, consent, select_account - not "login", so a fresh password cannot be demanded;
//     - ANY Google account can sign in. Only the `hd` claim says the account belongs to a company's Google Workspace
//       domain ("You must check this claim when restricting access ... to members of certain domains"); the `hd`
//       request parameter is only a hint to the account chooser. So a Google connection names its domain, and every
//       ID token must carry exactly that `hd`.
//   Microsoft Entra ID (https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc):
//     - the issuer is per tenant: https://login.microsoftonline.com/<tenant id>/v2.0. The shared "common",
//       "organizations" and "consumers" addresses let in accounts of every tenant; they are refused here, and so is a
//       domain name in place of the tenant id (its discovery document names the id, so it could never match);
//     - `prompt=login` is supported.
//   Okta (https://developer.okta.com/docs/api/openapi/okta-oauth/oauth/orgas): the org issuer https://<org>.okta.com
//     or a custom authorization server https://<org>.okta.com/oauth2/<id>; `prompt=login` "always prompt[s] the user for
//     authentication".

export type ProviderKind = 'google' | 'microsoft' | 'okta' | 'other';

export const GOOGLE_ISSUER = 'https://accounts.google.com';
const MICROSOFT_HOSTS = new Set(['login.microsoftonline.com', 'login.microsoftonline.us', 'login.partner.microsoftonline.cn']);
const OKTA_HOST = /\.(okta|oktapreview|okta-emea|okta-gov)\.com$/;
const TENANT_ID_PATH = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/v2\.0\/?$/i;
/** A domain name as a Google Workspace domain is written: lower case, at least one dot, no scheme or path. */
export const DOMAIN = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function providerKind(issuer: string): ProviderKind {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return 'other';
  }
  const host = url.hostname.toLowerCase();
  if (issuer.replace(/\/+$/, '') === GOOGLE_ISSUER) return 'google';
  if (MICROSOFT_HOSTS.has(host)) return 'microsoft';
  if (OKTA_HOST.test(host)) return 'okta';
  return 'other';
}

export interface ProviderRules {
  kind: ProviderKind;
  /** The `iss` values an ID token of this provider may carry. */
  issuers: string[];
  /** What the sign-in page is asked for: a fresh sign-in where the provider supports it. */
  prompt: 'login' | 'select_account';
  /** The connection must name the company's domain, and every ID token must carry it (`hd`). */
  needsDomain: boolean;
}

export function rulesFor(issuer: string): ProviderRules {
  const kind = providerKind(issuer);
  if (kind === 'google') return { kind, issuers: [issuer, 'accounts.google.com'], prompt: 'select_account', needsDomain: true };
  return { kind, issuers: [issuer], prompt: 'login', needsDomain: false };
}

export type IssuerSetupProblem = 'microsoft-needs-tenant-id';

/** What is wrong with an issuer for its provider, beyond the address rules every issuer follows. Null = nothing. */
export function issuerSetupProblem(issuer: string): IssuerSetupProblem | null {
  if (providerKind(issuer) === 'microsoft' && !TENANT_ID_PATH.test(new URL(issuer).pathname)) return 'microsoft-needs-tenant-id';
  return null;
}

/** Whether an ID token's `hd` is the connection's domain (case does not matter). A token without `hd` never is. */
export function domainMatches(hd: unknown, domain: string): boolean {
  return typeof hd === 'string' && hd.toLowerCase() === domain.toLowerCase();
}
