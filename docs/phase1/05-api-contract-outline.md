# 05 — API contract outline

> **Updated after the build (2026-10-02).** This document was approved at Gate 1 and then corrected to match
> what was actually built. Every difference from the approved version is listed, with the reason, in
> `REPORT.md` under "Deviations". The schema as built is drawn in `schema.md`.

## In plain language

This is the list of things the API can be asked to do, who is allowed to ask, and what goes in and comes out — in words. The exact machine-readable version (`services/api/openapi.yaml`, OpenAPI 3.1) is written in Step 3 and becomes the source of truth: the server validates every request against it, and tests validate every response against it.

## Rules that apply to every endpoint

| Topic | Rule |
|---|---|
| Version | Everything is under `/v1`. |
| Format | JSON in, JSON out. Field names in `snake_case`. Times are ISO-8601 UTC. |
| Auth | Session cookie `__Host-lai_session`, unless marked **public** or **service**. |
| CSRF | Every `POST` / `PUT` / `PATCH` / `DELETE` with a session needs `X-CSRF-Token` and an allowed `Origin`. |
| Idempotency | Endpoints marked **(idem)** require an `Idempotency-Key` header. |
| Errors | Always RFC 9457 `application/problem+json`: `type`, `title`, `status`, `request_id`, and for validation errors a list of field problems. Never internal details. |
| "Not yours" | A resource in another tenant returns **404**, not 403, so its existence is not revealed. |
| Pagination | `?limit=` (1–100, default 25) and `?cursor=`. Response: `{ items: [...], next_cursor: string | null }`. Defined once, reused. |
| Filtering | Simple equality filters as query parameters, listed per endpoint. Defined once as reusable parameters. |
| Card numbers | Accepted with or without the `LGY-` prefix, spaces or dashes; always returned in the one approved display format (decision 5 in `08`). |
| One-time secrets | `sc` and `enrollment_token` appear **only** in the response of the call that created them. No endpoint ever returns them again. |
| Rate limits | 429 with a uniform problem body and `Retry-After`. |

"Required role" below is shorthand. The real check is the permission in brackets, decided by the policy decision point; **Owner** = Company Owner. Roles not enabled for the tenant never pass.

---

## Health (public)

| Method & path | Purpose | Response |
|---|---|---|
| `GET /v1/health` | Liveness. **Never touches the database** (so it cannot wake Neon and burn free compute). | `{ status: "ok", version }` |
| `GET /v1/ready` | Readiness: can we reach the database, are migrations current, is config loaded. | `{ status, checks: { database, migrations, config } }`; 503 when not ready. No details about *why* beyond check names. |

## Authentication (public unless stated)

| Method & path | Purpose | Request | Response |
|---|---|---|---|
| `POST /v1/auth/login/begin` | Start a login. | `card_number` | Always 200: `login_txn`, `webauthn_options` (challenge, empty credential list), `totp_allowed: true`, `expires_in`. Identical shape for unknown cards. |
| `POST /v1/auth/login/verify` | Finish a login. All factors in one request. | `login_txn`, `sc`, `factor` = `{type:"passkey", assertion}` or `{type:"totp", code}` (**required**) | 200: sets the session cookie; body = session info (below). Any failure: the same generic 401. |
| `POST /v1/auth/enrollment/begin` | Start attaching a first (or reset) strong factor. | `card_number`, `sc`, `enrollment_token`, `factor_type` (`passkey` \| `totp`), `label` | Passkey: WebAuthn registration options. TOTP: `otpauth://` URI + secret to show as a QR code (once). Any failure: generic 401. |
| `POST /v1/auth/enrollment/complete` | Confirm the factor works. | `enrollment_txn`, passkey attestation **or** a first TOTP code | 204. Card moves `issued → active`. Does **not** log the user in — they then log in normally. |
| `GET /v1/auth/session` | Who am I? (session) | — | `card_id`, `card_number` (masked: last 4), `tenant_id`, `roles`, `permissions`, `card_state`, `read_only` (true in grace), `expires_at`, `grace_until`, `renewal_due`, `session_idle_expires_at`, `session_absolute_expires_at`, `csrf_token` |
| `POST /v1/auth/logout` | End this session. (session) | — | 204, cookie cleared |
| `GET /v1/auth/credentials` | List my own strong factors. (session) | — | items: `id`, `type`, `label`, `created_at`, `last_used_at` — never key material |
| `DELETE /v1/auth/credentials/{credential_id}` | Remove one of my factors; refused if it is the last one. (session) | — | 204 |

There is deliberately **no** endpoint that accepts only a card number and SC and returns anything useful.

## Cards

| Method & path | Required role [permission] | Request | Response |
|---|---|---|---|
| `POST /v1/cards` **(idem)** | Owner, Admin [`card:issue`] | `person_id`, `roles` (at least one; each may carry a `department_id`). Person cards only: the company card is issued with the tenant. | 201: card + **`card_number`, `sc`, `enrollment_token` shown once** |
| `GET /v1/cards` | Owner, Admin: all · others: own [`card:list`] | filters: `state`, `kind`, `person_id`, `expiring_before` | Page of cards. Result set narrowed by `buildResourceFilter`. |
| `GET /v1/cards/{card_id}` | Owner, Admin · own card [`card:read`] | — | Card: `id`, `kind`, `card_number`, `state` (effective), `person_id`, `issued_at`, `activated_at`, `expires_at`, `grace_until`, `renewal_due`, `renewal_count`, `locked`, `roles`. Never the SC or its hash. |
| `POST /v1/cards/{card_id}/suspend` **(idem)** | Owner, Admin [`card:suspend`] | `reason` | 200: card. Sessions revoked. |
| `POST /v1/cards/{card_id}/reinstate` **(idem)** | Owner, Admin [`card:reinstate`] | — | 200: card |
| `POST /v1/cards/{card_id}/revoke` **(idem)** | Owner, Admin [`card:revoke`] | `reason` | 200: card. Permanent. |
| `POST /v1/cards/{card_id}/replace` **(idem)** | Owner, Admin [`card:replace`] | `reason` (`lost` \| `damaged` \| `compromised`), `reset_credentials` (default true when `compromised`) | 201: the **new** card with new `card_number`, new `sc` (once), and an `enrollment_token` if credentials were reset. Old card → `replaced`. |
| `POST /v1/cards/{card_id}/renew` **(idem)** | Owner, Admin, for a card ranked below them; an Owner for their own card. Never the company card. [`card:renew`] | optional `validity_days` (cannot exceed the tenant setting) | 200: card with new dates + **new `sc` shown once**. Old SC dead immediately; sessions revoked. |
| `POST /v1/cards/{card_id}/unlock` **(idem)** | Owner, Admin [`card:unlock`] | — | 200: card + new `sc` (once) |
| `POST /v1/cards/{card_id}/enrollment-token` **(idem)** | Owner, Admin [`card:reset_credentials`] | `revoke_existing` (bool) | 201: `enrollment_token` (once), `expires_at` |
| `GET /v1/cards/{card_id}/events` | Owner, Admin · own card [`card_events:read`] | filters: `event_type`, `from`, `to` | Page of usage-history events: what, when, and which device (credential label + device fingerprint) |
| `GET /v1/cards/{card_id}/restrictions` | Owner, Admin [`card_restrictions:read`] | — | List of restrictions and current usage counters |
| `PUT /v1/cards/{card_id}/restrictions` **(idem)** | Owner, Admin [`card_restrictions:update`] | list of `{type, config, enabled}`; types: usage cap, allowed hours, network allow-list, read-only | 200: restrictions |

Illegal lifecycle transitions return `409` with problem type `…/illegal-transition`.

## Roles

| Method & path | Required role [permission] | Request | Response |
|---|---|---|---|
| `GET /v1/roles` | any signed-in card [`role:read`] | — | The 8 roles: `role_key`, `display_name`, `enabled_for_tenant`, `permissions` |
| `GET /v1/cards/{card_id}/roles` | Owner, Admin · own card [`card_roles:read`] | — | List of assignments |
| `POST /v1/cards/{card_id}/roles` **(idem)** | Owner, Admin [`card_roles:assign`] | `role_key`, optional `department_id` | 201: assignment. Target card's sessions revoked. |
| `PUT /v1/cards/{card_id}/roles` **(idem)** | Owner, Admin [`card_roles:assign`] | full list of assignments ("change") | 200: new list |
| `DELETE /v1/cards/{card_id}/roles/{role_key}` **(idem)** | Owner, Admin [`card_roles:remove`] | — | 204 |

Guard rules: not on your own card; not a role ranked above your own; not a role the tenant has disabled; never remove the last Owner.

## People and departments

| Method & path | Required role [permission] | Request | Response |
|---|---|---|---|
| `POST /v1/people` **(idem)** | Owner, Admin [`person:create`] | `display_name`, optional `email`, optional `department_id` | 201: person |
| `GET /v1/people` | Owner, Admin · others: self [`person:read`] | filters: `department_id`, `status` | Page of people |
| `GET /v1/people/{person_id}` | as above | — | Person |
| `PATCH /v1/people/{person_id}` **(idem)** | Owner, Admin [`person:update`] | any of `display_name`, `email`, `department_id`, `status`. Setting `status: departed` (offboarding) also revokes the person's card and sessions. | Person |
| `POST /v1/departments` **(idem)** | Owner, Admin [`department:create`] | `name` | 201: department |
| `GET /v1/departments` | any signed-in card [`department:read`] | — | List |

## Tenants (multi-tenant admin console API — basic)

| Method & path | Required role [permission] | Request | Response |
|---|---|---|---|
| `POST /v1/tenants` **(idem)** | Platform operator only [`tenant:create`] | `name`, `slug`, first owner's `display_name` and optional `email` | 201: tenant + company card (`card_number`, `sc` once) + first Owner card (`card_number`, `sc`, `enrollment_token` once). One database transaction since Phase 1.1: a failure leaves nothing behind. |
| `POST /v1/tenants/{tenant_id}/company-card/renew` **(idem)** *(Phase 1.1)* | Platform operator only [`tenant:renew_company_card`] | optional `validity_days` | 200: the company card with new dates + new `sc` (once). Audited in both tenants. |
| `POST /v1/tenants/{tenant_id}/owner-recovery` **(idem)** *(Phase 1.1)* | Platform operator only [`tenant:recover_owner`] | `card_id` **or** `card_number` (a Company Owner's card, exactly one of the two), `verification_reference` (case id of the out-of-band identity check; identifier characters only) | 201: card + new `sc` + `enrollment_token` (once) + `notified_owner_count`. Old factors, sessions and SC are dead. See `docs/runbooks/owner-recovery.md`. |
| `GET /v1/tenants` | Platform operator only [`tenant:list`] | pagination | Page of tenants: `id`, `name`, `slug`, `status`, `created_at` — no customer data |
| `GET /v1/tenants/current` | Owner, Admin [`tenant_settings:read`] | — | Tenant: `id`, `name`, `slug`, `status`, `plan_code`, `region` |
| `GET /v1/tenants/current/settings` | Owner, Admin [`tenant_settings:read`] | — | All settings in `tenant_settings` |
| `PATCH /v1/tenants/current/settings` **(idem)** | Owner [`tenant_settings:update`] | any setting; out-of-range values (e.g. lockout threshold 6) → 422 | Settings |
| `GET /v1/tenants/current/usage` | Owner, Admin [`tenant_usage:read`] | — | Counts: cards by state, people, active sessions, cards expiring in 14 days, audit rows, logins in the last 30 days; plan limits beside them |

## Audit

| Method & path | Required role [permission] | Request | Response |
|---|---|---|---|
| `GET /v1/audit/events` | Owner, Admin [`audit:read`] | filters: `actor_card_id`, `action`, `resource_type`, `resource_id`, `decision`, `from`, `to` | Page of audit rows incl. `seq` and `row_hash` (hex) |
| `POST /v1/audit/verify` | Owner, Admin [`audit:verify`] | optional `from_seq`, `to_seq` | `{ ok, rows_checked, head_seq, head_hash, first_broken_seq, broken_reason, last_anchor: { seq, anchored_at, matches } }` |

## Export (feature 30 — skeleton)

| Method & path | Required role [permission] | Request | Response |
|---|---|---|---|
| `POST /v1/exports` **(idem)** | Owner [`export:create`] — allowed even in grace and after expiry | — | 202: export job |
| `GET /v1/exports/{export_id}` | Owner [`export:read`] | — | Job status + manifest (tables, row counts, checksums). Phase 1 produces JSON Lines + CSV files on local disk / the backups bucket; a signed download link is a later phase. |

The export contains the tenant's own rows from every tenant-scoped table **except secrets** (no SC hashes, no credential key material, no session or token hashes).

## Internal (service-to-service)

| Method & path | Auth | Request | Response |
|---|---|---|---|
| `POST /v1/internal/policy/check` | **Service:** bearer `INTERNAL_SERVICE_TOKEN`; not reachable with a session cookie | `session_token` **or** `card_id` + `tenant_id` (subject is re-loaded from the database, never trusted from the caller), `action`, `resource` | `{ effect, reason_code, obligations }`. Also audited. |

Phase 2 adds `POST /v1/internal/policy/filter` (returns the `buildResourceFilter` predicate) when the AI service needs it.

## Not in Phase 1 (no endpoints)

Billing, payments, webhooks, analytics, QR/NFC, SSO/SCIM, knowledge capture, AI. Their tables exist as hooks only.

## Endpoint count

47 operations (45 in Phase 1, 2 added in Phase 1.1): 2 health, 8 auth, 13 cards, 5 roles, 6 people/departments, 8 tenants, 2 audit, 2 export, 1 internal. The contract test (Step 5) asserts that the set of routes registered in the server equals the set of operations in `openapi.yaml` — no more, no fewer.
