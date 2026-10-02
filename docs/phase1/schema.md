# Schema diagram

The database as built by `db/migrations/` (5 migrations, 33 tables). Verified against the live test database: **24 tenant-scoped tables with forced row-level security, 9 global tables** (asserted by `test/integration/rls.test.ts`).

- **T** = tenant-scoped: has `tenant_id`, row-level security enabled **and forced**.
- **G** = global: no tenant; the app role has only the narrow privileges noted.

## Identity and access

```mermaid
erDiagram
  tenants ||--|| tenant_settings : has
  tenants ||--o{ departments : has
  tenants ||--o{ people : has
  tenants ||--o{ cards : has
  departments ||--o{ people : "belongs to"
  people ||--o{ cards : "holds (one live card)"
  cards ||--o{ card_secrets : "SC hash (one current)"
  cards ||--|| card_auth_state : "lockout state"
  cards ||--o{ credentials : "passkeys / TOTP"
  cards ||--o{ enrollment_tokens : "one-time"
  cards ||--o{ sessions : "server-side"
  cards ||--o{ card_events : "usage history (append-only)"
  cards ||--o{ card_restrictions : "feature 5"
  cards ||--o{ card_usage_counters : "feature 5"
  cards ||--o{ card_roles : has
  roles ||--o{ card_roles : "assigned as"
  roles ||--o{ role_permissions : grants
  permissions ||--o{ role_permissions : "granted by"
  cards ||--|| card_directory : "number -> tenant (no app access)"

  tenants {
    uuid id PK
    text name
    text slug UK
    text status
    boolean is_platform
    text plan_code FK
    text region "F21 hook"
    text encryption_key_ref "F21 BYOK hook, nullable"
  }
  tenant_settings {
    uuid tenant_id PK
    int card_validity_days "default 90"
    int grace_days "default 14"
    int sc_lockout_threshold "CHECK 3..5"
    int session_idle_minutes
    int session_absolute_hours
    text_array enabled_roles
    boolean pilot_reviewer_grant
    text_array allowed_factor_types
  }
  people {
    uuid id PK
    uuid tenant_id FK
    text display_name "PII"
    text email "PII, nullable"
    uuid department_id FK
    text status "active | departed"
    text external_id "F16 SCIM hook"
  }
  cards {
    uuid id PK
    uuid tenant_id FK
    text kind "person | company"
    uuid person_id FK
    text card_number UK "16 digits, identifier not secret"
    text state "issued active suspended revoked expired replaced"
    timestamptz expires_at
    timestamptz grace_until
    timestamptz renewal_due
    int renewal_count
    uuid replaced_by_card_id
  }
  card_secrets {
    uuid id PK
    uuid card_id FK
    text sc_hash "Argon2id of HMAC(pepper, SC); NULL when retired"
    text pepper_id
    text status "current | retired"
  }
  card_auth_state {
    uuid card_id PK
    int sc_failed_count
    timestamptz locked_at
    int factor_failed_count
    timestamptz factor_throttled_until
    bigint last_totp_step
  }
  credentials {
    uuid id PK
    uuid card_id FK
    text type "passkey | totp"
    text webauthn_credential_id UK
    bytea webauthn_public_key
    bytea totp_secret_enc "AES-256-GCM"
    text status
  }
  sessions {
    uuid id PK
    uuid card_id FK
    bytea token_hash UK "SHA-256 only"
    timestamptz idle_expires_at
    timestamptz absolute_expires_at
    timestamptz revoked_at
    text revoked_reason
  }
  card_events {
    uuid id PK
    uuid card_id FK
    text event_type
    uuid credential_id
    bytea device_hash
    jsonb metadata
  }
  card_restrictions {
    uuid id PK
    uuid card_id FK
    text type "usage_cap time_window network_allowlist read_only"
    jsonb config
    boolean enabled
  }
  roles {
    text role_key PK
    int rank
    boolean pilot_enabled
  }
  permissions {
    text permission_key PK
    boolean is_write
    boolean platform_only
  }
  role_permissions {
    text role_key PK
    text permission_key PK
    text scope "tenant | department | own"
    smallint max_sensitivity
    text grant_source "base | pilot_reviewer"
  }
  card_roles {
    uuid card_id PK
    text role_key PK
    uuid department_id
  }
  card_directory {
    text card_number PK
    uuid tenant_id
    uuid card_id
  }
```

## Platform

```mermaid
erDiagram
  tenants ||--o{ audit_log : "one hash chain per tenant"
  tenants ||--|| audit_chain_heads : "head (written by trigger only)"
  tenants ||--o{ audit_anchors : "external anchor records"
  tenants ||--o{ idempotency_keys : has
  tenants ||--o{ export_jobs : has
  plan_limits ||--o{ tenants : "plan (Phase 4 stub)"

  audit_log {
    uuid tenant_id PK
    bigint seq PK "gap-free, set by trigger"
    timestamptz occurred_at "set by trigger"
    uuid actor_card_id
    text actor_kind
    text action
    text resource_type
    text resource_id
    text decision "allow | deny | event"
    text reason_code
    text request_id
    text ip
    text details "canonical JSON, allow-listed keys"
    bytea prev_hash
    bytea row_hash "SHA-256, set by trigger"
  }
  audit_chain_heads {
    uuid tenant_id PK
    bigint last_seq
    bytea last_hash
  }
  audit_anchors {
    uuid id PK
    uuid tenant_id FK
    bigint seq
    bytea row_hash
    text object_uri
  }
  idempotency_keys {
    uuid tenant_id PK
    uuid actor_card_id PK
    text key PK
    bytea request_hash
    jsonb response_body "one-time secrets stripped"
    timestamptz expires_at
  }
  export_jobs {
    uuid id PK
    uuid tenant_id FK
    text status
    jsonb manifest
  }
  plan_limits {
    text plan_code PK
    int max_person_cards
    int max_admin_cards
  }
  rate_limit_buckets {
    bytea bucket_key PK "HMAC, never the raw key"
    timestamptz window_start PK
    int count
  }
  login_attempts {
    uuid id PK
    bytea card_number_hmac
    uuid tenant_id "NULL for unknown cards"
    text outcome
    text real_reason "internal only"
  }
  auth_transactions {
    uuid id PK
    bytea txn_hash UK
    text purpose "login | enroll"
    uuid card_id "NULL for unknown cards"
    text challenge
    timestamptz expires_at
    timestamptz consumed_at
  }
```

## Design-only hooks (tables exist; no code reads or writes them; the app role has no privileges on them)

```mermaid
erDiagram
  tenants ||--o{ outbox_events : "F28"
  tenants ||--o{ webhook_endpoints : "F28"
  tenants ||--o{ analytics_events : "F27"
  tenants ||--o{ sso_connections : "F16"
  cards ||--o{ card_tokens : "F4 QR / NFC / wallet"

  outbox_events {
    uuid id PK
    text topic
    jsonb payload
    timestamptz published_at
  }
  webhook_endpoints {
    uuid id PK
    text url
    text secret_ref "a reference, never the secret"
    boolean enabled
  }
  analytics_events {
    uuid id PK
    text event_name
    jsonb properties
  }
  sso_connections {
    uuid id PK
    text protocol "oidc | saml"
    text issuer
    boolean enabled
  }
  card_tokens {
    uuid id PK
    uuid card_id FK
    text format "qr | nfc | wallet"
    bytea token_hash UK
  }
```

## Scope and privileges, table by table

| Table | Scope | App role may | Notes |
|---|---|---|---|
| tenants | T (by `id`) | SELECT, INSERT, UPDATE | plus a read-only cross-tenant policy used only for the operator's tenant list |
| tenant_settings | T | SELECT, INSERT, UPDATE | ranges enforced by CHECK constraints |
| departments | T | SELECT, INSERT | |
| people | T | SELECT, INSERT, UPDATE | |
| cards | T | SELECT, INSERT, UPDATE | lifecycle trigger rejects illegal state changes |
| card_secrets | T | SELECT, INSERT, UPDATE | hash destroyed (NULL) on rotation |
| card_auth_state | T | SELECT, INSERT, UPDATE | |
| credentials | T | SELECT, INSERT, UPDATE | |
| enrollment_tokens | T | SELECT, INSERT, UPDATE | token stored as SHA-256 only |
| sessions | T | SELECT, INSERT, UPDATE | token stored as SHA-256 only |
| card_events | T | SELECT, **INSERT only** | append-only for the app |
| card_restrictions | T | SELECT, INSERT, UPDATE, DELETE | |
| card_usage_counters | T | SELECT, INSERT, UPDATE, DELETE | |
| card_roles | T | SELECT, INSERT, UPDATE, DELETE | |
| audit_log | T | SELECT, **INSERT only** | plus a trigger that blocks UPDATE / DELETE / TRUNCATE for every role |
| audit_chain_heads | T | SELECT | written only by the audit trigger |
| audit_anchors | T | SELECT, INSERT | |
| idempotency_keys | T | SELECT, INSERT, UPDATE, DELETE | |
| export_jobs | T | SELECT, INSERT, UPDATE | |
| outbox_events, webhook_endpoints, analytics_events, card_tokens, sso_connections | T | **nothing** | design-only |
| roles, permissions, role_permissions, plan_limits | G | SELECT | policy data; changed only by migration |
| card_directory | G | **nothing** | reachable only through `resolve_card()` (exact match) |
| login_attempts | G | **INSERT only** | real failure reasons; never readable by the app |
| auth_transactions | G | SELECT, INSERT, UPDATE, DELETE | global so known and unknown cards look the same |
| rate_limit_buckets | G | SELECT, INSERT, UPDATE, DELETE | keys are HMACs |
| schema_migrations | G | SELECT | readiness check |

## Database roles (created by `db/roles/create-roles.sql`)

| Role | Purpose | Superuser | BYPASSRLS |
|---|---|---|---|
| `legacyai_migrator` | owns the tables, runs migrations | no | no |
| `legacyai_app` | the running API | no | **no** (the API checks this at start-up and refuses to run otherwise) |
| `legacyai_backup` | nightly `pg_dump` (read-only via `pg_read_all_data`) | no | yes — a backup must see every tenant |
