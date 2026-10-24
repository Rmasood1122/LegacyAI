# Phase 4, Batch B step 3 — SSO and SCIM (feature 16)

Status on 2026-10-21:

| Part | What | State |
|---|---|---|
| A | SSO: sign-in through the company's identity provider (OpenID Connect) as the strong factor | Built against a stand-in provider. Database and browser tests run only in GitHub Actions. |
| B | SCIM: automatic provisioning of people from the company's directory | Built against stand-in requests (no real directory). Database tests run only in GitHub Actions. |

No real identity provider or directory was used. No new library: `jose` (already a dependency since Phase 1) checks the provider's
tokens; requests go through `node:https` with the same address guard as webhooks.

## Part A — SSO

### The rule from Phase 1 holds

A sign-in at the company's identity provider counts as the **strong factor** — like a passkey or an authenticator-app
code. It **never replaces the card or its 3-digit code** (Phase 1, `02-data-model.md` §E). A person who signs in with
their company account still types their card number and their 3-digit code.

### What the Owner does

1. On the "Company sign-in" screen: registers the address shown there (`.../sso/return/<company id>`, the company's own
   return address) at the provider, then enters
   the provider's issuer address, the client id and the client secret, and switches the connection on.
2. In the settings: allows the factor "The company's own sign-in" (off by default).

One connection per company, OpenID Connect only. The client secret is sent once, stored **encrypted** (it has to be
sent to the provider at every sign-in, so a hash would not do), and never shown again. The provider (issuer) of a
connection never changes; another provider is another connection.

### What a person does

- **Setting up the card** (card number, 3-digit code, set-up token as before): chooses "My company's account", signs in
  at the provider, comes back. The provider's identity for this person (its `sub`, which the provider promises never
  to reassign) is now linked to this card. Never by e-mail address: a provider may let people choose their address.
  One identity opens at most one live card of the company.
- **Signing in:** card number, then "Sign in with my company's account" and the company's short name, the provider's
  sign-in page, back to LegacyAI, the 3-digit code. Done.

### Why the person names the company

The provider has to be chosen before anyone is known. If it were chosen by the card, the answer ("this card's company
uses provider X" or "no SSO here") would tell anyone whether a card number exists. So the person names their company
(its short name, which is not secret); the answer depends on the company only. A card number that does not exist, or
belongs to another company, gets the same provider page and fails only at the very end, with the same answer as every
other failure.

### How it fits the existing sign-in steps

Signing in and setting up already work with short-lived, single-use steps (hashed tokens in `auth_transactions`). SSO
adds a detour:

| Step | What happens |
|---|---|
| `POST /v1/auth/sso/start` | names the sign-in or set-up step (and, when signing in, the company); a new step (purpose `sso`, 10 minutes) holds the state, the nonce and the PKCE verifier; answers the provider's address |
| the provider | the person signs in there; the provider sends the browser to the company's own return address `/sso/return/<company id>` with a code and the state |
| `POST /v1/auth/sso/finish` | the web application hands code, state and the company id from the address on at once; only the browser that started can finish (a cookie set at start); the API redeems the code once at the provider, checks the ID token, ends the original step and opens a new one (5 minutes) that carries the identity the provider vouched for |
| `POST /v1/auth/login/verify` with factor `sso` | as always: 3-digit code + strong factor. The factor holds only if the identity is linked to THIS card, through the company's current connection, and was vouched for in THIS step |

The web application uses no browser storage (its lint rule forbids it). The one thing the browser keeps between start
and finish is an HttpOnly cookie the API sets and the page cannot read. Every failure is the same 401. Starting the
detour keeps the original step alive for as long as the detour may take (10 minutes), because a provider sign-in with
a second factor can take longer than the usual 5.

### Two attacks it is built against (found by review, fixed before the first push)

- **"Mix-up".** Every company brings its own provider, and one of them may be hostile. With ONE shared return address,
  a hostile company's provider could pass a person's sign-in code from their real company's provider into a flow of the
  hostile company, so the code would be sent to the hostile provider. That provider could then use it in a flow it
  started for that person's card. Fix: each company has its **own** return address, a provider sends codes only to the
  address registered for it, and the API refuses a code that came back to another company's address than the flow's.
  When the provider names itself on the way back (RFC 9207 `iss`), it must be the flow's provider.
- **Finishing in someone else's browser.** Someone hands a person a link to a provider sign-in that the attacker
  started, so the person's identity would land in the attacker's step (and could be linked to the attacker's card).
  Fix: the cookie above. A browser without it, or with the cookie of another start, is refused, and the flow is not
  spent by such an attempt.

### What is checked about the provider

- Its discovery document comes from the configured issuer and must name exactly that issuer; all endpoints https.
- The issuer and every endpoint must follow the same address rules as a webhook endpoint: https on port 443, a host
  name (no address literal), not an internal name. The provider's sign-in page must be on the issuer's own host, because
  people are sent there from our sign-in screen. The token endpoint and the key set may be on another public host;
  one large provider does that.
- Every request goes through the platform's guarded https client: public addresses only (every address the name
  resolves to), the connection pinned to the checked address, no redirects, 5 seconds, 256 KB. An Owner cannot point
  the server at an internal address, or at another port of someone else's machine.
- The ID token: signature against the provider's published keys (fetched again once if the key is unknown —
  providers rotate keys), asymmetric algorithms only (`none` and shared-secret algorithms refused), issuer, audience =
  our client id (and `azp` when there are several audiences), expiry (2 minutes of tolerance), issued within the last
  10 minutes, the nonce sent in this step.
- The code exchange uses PKCE (S256) and the client secret over HTTP Basic, and asks the provider for a fresh sign-in
  (`prompt=login`).

### Removing the connection

Switching it OFF stops every sign-in that is already under way (the factor is checked against a switched-on connection
at the last step). Removing it: every SSO factor linked through it is revoked; the sessions opened with them end; and — as for any change of a card's
sign-in (D30) — the API keys those cards made end too. A person whose only factor was SSO has to set up a passkey or
an app code again with a new set-up token.

### Operations (182 in total)

| Operation | Path | Permission |
|---|---|---|
| `ssoStart` | `POST /v1/auth/sso/start` | public (sign-in) |
| `ssoFinish` | `POST /v1/auth/sso/finish` | public (sign-in) |
| `getSsoConnection` | `GET /v1/sso/connection` | `sso:read` |
| `putSsoConnection` | `PUT /v1/sso/connection` | `sso:manage` |
| `removeSsoConnection` | `POST /v1/sso/connection/remove` | `sso:manage` |

Company Owner only. The two public steps have the same per-address and global limits as signing in. The list of
public operations grows from 7 to 9.

### Database

Migration `20261007000100_sso.sql`: the design-only `sso_connections` of Phase 1 is replaced by the real table (guard:
provider and maker never change, removal final); `resolve_sso_company(short name)` answers only whether a company has a
live connection; credentials get the type `sso` (provider identity + connection, one live card per identity); the
settings may allow `sso`; sign-in steps get the purpose `sso`; two permissions for the Owner. **Rollback:** works on a
database where nobody has set up SSO; when SSO credentials exist it stops with a clear message, because the card
history (append-only) refers to them and the rollback will not rewrite history.

### What was tested, and what was not

- **Run locally (no database):** 44 unit tests. They cover:
  - the PKCE challenge, checked against the example in RFC 7636;
  - the sign-in address;
  - a proper sign-in against the stand-in provider;
  - refused ID tokens: a key the provider does not publish, no signature, another nonce, another client, several
    audiences without `azp`, `azp` of another client, another issuer, expired, issued too long ago;
  - a wrong client secret or PKCE verifier;
  - discovery documents that name another issuer, a sign-in page on another host, another port, an address literal,
    an internal name or plain http;
  - what the SSO factor proves: another person, another connection, another company, another card;
  - the issuer and redirect rules.

  Plus 7 screen tests.
- **Run only by GitHub:** the database tests (set-up and sign-in through the stand-in provider; a wrong 3-digit code;
  another person; the right person at another company's provider; an unknown card gets the same answer and fails at
  the end; every step single use; the factor without a provider sign-in; one identity, one card; a company that did
  not allow the factor; finishing in another browser; the mix-up (a code under another company's return address, or
  another provider's `iss`, never reaches the other provider); switching the connection off mid-sign-in; issuers on
  another port, an address literal or an internal name; the client secret stored only encrypted and absent from audit,
  retry records and log; Owner only; the provider of a connection cannot change; removal revokes factors and ends
  sessions) and a browser test of the Owner's screen.
- **Review before the first push** (two read-only reviews, by reading the code, nothing run). They found:
  - the mix-up and the other-browser attack above;
  - endpoints on other ports;
  - the switch-off gap;
  - the original step expiring during a slow provider sign-in;
  - a database lookup of the company that, as first written, could never find a company. Row-level security hid the
    rows from it, so every SSO sign-in would have failed. It now opens exactly the two settings it needs, for its own
    duration;
  - test set-up that gave every card a passkey first.

  All of these are fixed, with tests. Still open and accepted: the retry record of the Owner's "save connection"
  request keeps a SHA-256 of the request body, which includes the client secret. That is a one-way hash of a
  high-entropy value, kept for 24 hours.
- **Not tested:** a real provider (Microsoft Entra ID, Google Workspace, Okta, ...); a whole sign-in in a real browser
  (the browser would have to reach the provider); SAML (not built).

### Confirmed by the founder (2026-10-22: the recommended defaults)

1. Owner only for the connection.
2. A person names their company's short name when signing in with SSO (the price of not revealing which card numbers
   exist).
3. Removing the connection also ends the API keys made by the people who used it (the D30 rule).

Still open, because it needs a customer: which providers the customers use first (OpenID Connect covers the common
ones; SAML is not built).

### Real providers: Microsoft Entra ID, Google, Okta (decision D39, 2026-10-24)

Read from each provider's own documentation on 2026-10-24:
[Google](https://developers.google.com/identity/openid-connect/openid-connect),
[Microsoft](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc),
[Okta](https://developer.okta.com/docs/api/openapi/okta-oauth/oauth/orgas). The code is
`services/api/src/modules/identity-access/internal/providers.ts`; the API recognises the provider from the issuer and
shows it (`provider`: google, microsoft, okta, other).

What differs, and what the API does about it:

| | Google | Microsoft Entra ID | Okta |
|---|---|---|---|
| Issuer to enter | `https://accounts.google.com` | `https://login.microsoftonline.com/<tenant ID>/v2.0` | `https://<org>.okta.com` or `https://<org>.okta.com/oauth2/<server id>` |
| Who could sign in | **any Google account in the world** | only the tenant's accounts (with a tenant-specific issuer) | only the org's accounts |
| What the API adds | the connection must name the company's **Google Workspace domain**; every ID token must carry exactly that domain (`hd`), or it is refused | refuses `common`, `organizations`, `consumers` and a domain name instead of the tenant ID (those would let other tenants in, or never match) | nothing special |
| "Sign in again" | Google has no `prompt=login`: the API asks for the **account chooser** (`select_account`); Google may not ask for the password again | `prompt=login` | `prompt=login` |
| Issuer in the ID token | `https://accounts.google.com` **or** `accounts.google.com` (both accepted, for Google only) | as entered | as entered |

Also new for every provider: the client secret is sent the way the provider says it takes it (HTTP Basic, or the form
body when the provider offers only that); a provider that offers neither is not used.

**What the Owner does at each provider (not done by me - it needs the company's admin account):**

*Microsoft Entra ID*
1. Entra admin center → App registrations → New registration. Account type: **this organizational directory only**.
   Redirect URI (Web): the address shown on our "Company sign-in" screen (`.../sso/return/<company id>`).
2. Copy the **Directory (tenant) ID** and the **Application (client) ID**. Certificates & secrets → new client secret;
   copy its value.
3. On our screen: issuer `https://login.microsoftonline.com/<tenant ID>/v2.0`, client id, secret. Switch on.

*Google Workspace*
1. Google Cloud console → APIs & Services → OAuth consent screen: user type **Internal** (only the Workspace's users).
2. Credentials → Create OAuth client ID → Web application; authorised redirect URI: the address on our screen.
3. On our screen: issuer `https://accounts.google.com`, client id, secret, and **your Workspace domain**
   (e.g. `example.com`). Switch on. (Both the "Internal" consent screen and our domain check keep other Google
   accounts out; the domain check is the one we enforce.)

*Okta*
1. Okta admin console → Applications → Create App Integration → OIDC, **Web Application**; grant type
   Authorization Code; sign-in redirect URI: the address on our screen. Assign the people or groups.
2. Copy the client ID and secret. Issuer: `https://<your org>.okta.com` (or your custom authorization server's).
3. On our screen: issuer, client id, secret. Switch on.

**Tested:** against the test stand-in provider playing each provider's address and quirks - 10 unit tests (which
provider an issuer is, look-alikes refused, Google's two issuer forms, the domain check, Microsoft's refused addresses,
the prompt, secret in Basic or body) and 1 screen test; the database test (`test/integration/sso-providers.test.ts`,
on GitHub) covers the connection rules and a Google set-up with the right, a missing and another company's domain.
**Not tested:** any real provider. Whether each provider behaves exactly as its documentation says is an ASSUMPTION
until the first company connects one.

## Part B — SCIM (people from the company's directory)

### What it is for

A company keeps its people in a directory (Microsoft Entra ID, Okta, Google, ...). With SCIM 2.0 the directory tells
LegacyAI by itself when someone joins, changes name or address, or **leaves**. Leaving matters most: the person's cards
are revoked at once, as if an administrator had recorded it.

### The directory key

The directory calls the API with a **directory key**. This is an API key (feature 28, D30) made on the API keys screen
with the choice "Company directory (SCIM)". It carries exactly one permission, `person:scim`, and nothing else. The API
and the database both refuse a key that mixes it with anything else. So a directory key reads no knowledge, and a
reading key changes no people.

`person:scim` is held by the Owner's role only so that an Owner can MAKE such a key. The Owner signed in cannot use it:
the policy refuses it to every signed-in card (`DENY_KEY_ONLY`), and the session does not list it. Everything else
about keys holds: the key never outlives a change of its maker's sign-in or rights, it expires, it can be revoked, and
its maker's card state decides on every request.

### What the directory can and cannot do

| Can | Cannot |
|---|---|
| add a person (with no card, so with no way in) | issue a card, give a role, or touch knowledge |
| change the person's name, e-mail address, directory user name, directory id | see or change anyone it did not add (an administrator's people are "not found" to it) |
| record that a person left (`active: false`): their cards are revoked, their sessions and API keys end | reach anyone whose card holds the **Owner** role: not to read, change or remove (`DENY_DIRECTORY_OWNER`) |
| remove a person (DELETE): they are recorded as left, their history stays, and the directory gets 404 for them from then on | erase anyone's history |

Why Owners are out of reach: a mistake or an attack in the directory must never lock the company out of itself. An
Admin who leaves IS de-provisioned by the directory. The directory can also change an Admin's e-mail address, so the
notices about that Admin's card would go to the new address. The notices carry no secret.

Reading a person's rank and changing the person happen under the company's role lock, the same lock that issuing a
card and changing roles take. A directory removal cannot catch an Owner card being issued at the same moment.

Groups are not supported. Roles are given by an administrator, never by the directory.

### Operations (189 in total)

Base address for the directory: `https://<api>/v1/scim/v2`. Authentication: `Authorization: Bearer <directory key>`.

| Operation | Path | |
|---|---|---|
| `scimServiceProviderConfig` | `GET /v1/scim/v2/ServiceProviderConfig` | what is supported |
| `scimListUsers` | `GET /v1/scim/v2/Users?filter=userName eq "..."&startIndex=&count=` | find (userName or externalId), page |
| `scimCreateUser` | `POST /v1/scim/v2/Users` | add |
| `scimGetUser` | `GET /v1/scim/v2/Users/{id}` | read one |
| `scimReplaceUser` | `PUT /v1/scim/v2/Users/{id}` | replace |
| `scimPatchUser` | `PATCH /v1/scim/v2/Users/{id}` | change attributes (`active`, names, `userName`, `externalId`, `emails`) |
| `scimDeleteUser` | `DELETE /v1/scim/v2/Users/{id}` | left, and out of the directory's reach |

`userName` is unique in the company, without regard to case. So are `externalId` and the e-mail address.

### Where it differs from the standard (written down so nobody is surprised)

- Errors are this API's problem details (RFC 9457), not SCIM error messages. The status codes are the SCIM ones (400,
  401, 403, 404, 409).
- Answers are `application/json`. Requests may be `application/json` or `application/scim+json`.
- Only the filters `userName eq "..."` and `externalId eq "..."`. No sorting, no bulk, no ETags, no groups.
  `attributes` and `excludedAttributes` are accepted and ignored.
- Attributes that are not stored here (title, phone numbers, the enterprise extension, ...) are ignored by POST, PUT
  and PATCH alike. A directory's usual update carries them and must not fail because of them. Groups, roles,
  entitlements, certificates and passwords are refused (400), so the directory learns that it was not done.
- A PUT without `active` means active (replace semantics). A PUT can bring back a person who had left; their cards
  stay revoked.
- `active` also accepts the strings "True" and "False", because one large directory sends those.
- While the company is in its read-only grace period, the directory is refused too: provisioning writes.

### Database

Migration `20261007000200_scim.sql`:
- the permission `person:scim` for the Owner;
- the constraint `api_keys_directory_key_alone`;
- `people.scim_user_name`, unique per company without regard to case.

`external_id` and `scim_managed` were laid down for this in Phase 1.

**Rollback:** the people the directory added stay and become ordinary people that an administrator manages. Directory
keys stay as rows, but without the permission they can do nothing (`DENY_UNKNOWN_ACTION`).

### What was tested, and what was not

- **Review before the first push** (a read-only review). It found:
  - JSON sent as `application/scim+json` was treated as a file upload;
  - a test expectation that could not hold;
  - the race with card issuing;
  - PATCH refusing the attributes that real directories send;
  - names and control characters the database would refuse with a 500.

  All are fixed.
- **Run locally (no database):**
  - unit tests of what a directory sends: user names, display-name fallbacks, the primary e-mail address, "True" and
    "False", control characters;
  - the PATCH forms directories use, and what PATCH refuses;
  - the filter;
  - what is shown;
  - the policy: a key only; Owners out of reach; a person without a rank refused; the key stops with its maker;
  - the key rule;
  - two screen tests.
- **Run only by GitHub:** the database tests. They cover:
  - the directory key carries person:scim alone (API and database);
  - the Owner signed in is refused;
  - a reading key cannot provision, and a directory key reads no knowledge;
  - the whole lifecycle through `application/scim+json`;
  - uniqueness without regard to case;
  - an administrator's people are not found;
  - `active: false` revokes the card;
  - DELETE then 404;
  - an Owner out of reach;
  - the audit trail names the key and holds no names or addresses;
  - a revoked key stops;
  - another company sees nothing.
- **Not tested:** a real directory (Entra ID, Okta, Google). Each has its own habits, and the first customer's
  directory has to be tried against a test company before it is switched on.

### Confirmed by the founder (2026-10-22: the recommended defaults)

1. Owners are outside the directory's reach: an Owner who leaves is recorded by hand.
2. The directory never gives roles or issues cards: an administrator still does.
3. A person the directory removes keeps their history as a departed person.

Still open, because it needs a customer: which directory the first customer uses, so it can be tried first.
