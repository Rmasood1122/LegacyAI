# Phase 4, Batch B step 3 — SSO and SCIM (feature 16)

Status on 2026-10-21:

| Part | What | State |
|---|---|---|
| A | SSO: sign-in through the company's identity provider (OpenID Connect) as the strong factor | Built against a stand-in provider. Database and browser tests run only in GitHub Actions. |
| B | SCIM: automatic provisioning of people from the company's directory | Not started yet (next). |

No real identity provider was used. No new library: `jose` (already a dependency since Phase 1) checks the provider's
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

### For the founder to confirm

1. Which providers your customers use first (OpenID Connect covers the common ones; SAML is not built).
2. Owner only for the connection?
3. That a person names their company's short name when signing in with SSO (the price of not revealing which card
   numbers exist).
4. That removing the connection also ends the API keys made by the people who used it (the D30 rule).
