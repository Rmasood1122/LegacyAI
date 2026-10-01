# 07 — Feature map

> ## ⚠ This document is incomplete, and I will not guess
>
> The Phase 1 prompt names **14 of your 35 features** by number. I do not have the other 21 — their names and numbers were not in the prompt or anywhere in this folder. Inventing them would be exactly the kind of made-up claim you told me never to make.
>
> **To finish this file I need your 35-feature list** (numbers and one-line names). Until then, rows marked **NOT PROVIDED** are placeholders. Nothing in Phase 1's build depends on the missing rows.

## In plain language

For each feature: which phase delivers it, and — for Phase 1 features — exactly which module, tables, endpoints and tests cover it. Test file names are the planned ones from the design; the Step 7 report will replace "planned" with the real test output.

## Phase numbering

| Phase | Content | Source |
|---|---|---|
| 0 | Stack decisions | Stated in the prompt (done) |
| 1 | Foundation: identity, cards, access, platform | This phase |
| 2 | Knowledge layer / AI service (backend Parts 2 and 3) | **ASSUMPTION** — the prompt says "Phase 2 will reuse" the retrieval filter |
| 3 | Frontend | **ASSUMPTION** — the prompt only says "later phase" |
| 4 | Billing (backend Part 4) | Stated in the prompt |
| later | Everything else | Unknown until you provide the list |

## Phase 1 — built features

### Feature 1 — Unique cards (person + company)
| | |
|---|---|
| Module | `identity-access` (`cards`, `card-number`, `secret-code`) |
| Tables | `cards`, `card_directory`, `card_secrets`, `people` |
| Endpoints | `POST /v1/cards`, `GET /v1/cards`, `GET /v1/cards/{id}`, `POST /v1/tenants` (issues the company card and first Owner card) |
| Tests (planned) | `unit/card-number.test.ts`, `unit/secret-code.test.ts`, `integration/cards.test.ts` (global uniqueness, one live card per person, one company card per tenant) |

### Feature 2 — Role-based access
| | |
|---|---|
| Module | `identity-access` (`roles`, `policy`) |
| Tables | `roles`, `permissions`, `role_permissions`, `card_roles`, `tenant_settings.enabled_roles`, `departments` |
| Endpoints | `GET /v1/roles`, `GET/POST/PUT /v1/cards/{id}/roles`, `DELETE /v1/cards/{id}/roles/{role_key}`, `POST /v1/internal/policy/check` |
| Tests (planned) | `unit/policy.test.ts` (table-driven, deny by default, all 8 roles × all permissions), `integration/resource-filter.test.ts`, `security/route-policy-coverage.test.ts` |
| Pilot note | 4 roles enabled by default; the other 4 exist but are off. Reviewer capability granted to Admin and Expert by `pilot_reviewer` rows. |

### Feature 3 — Card lifecycle (issue, suspend, revoke, expire, replace)
| | |
|---|---|
| Module | `identity-access` (`lifecycle`) |
| Tables | `cards` (state, dates), `card_events`, `sessions` (revocation) |
| Endpoints | `POST /v1/cards`, `…/suspend`, `…/reinstate`, `…/revoke`, `…/replace`, `…/unlock`, `…/enrollment-token` |
| CLI | `sweep-expired-cards` (records expiry; enforcement does not depend on it) |
| Tests (planned) | `unit/lifecycle.test.ts` (all 36 state pairs), `integration/lifecycle.test.ts` (DB trigger, session revocation, grace read-only, last-owner protection) |

### Feature 5 — Card-level limits and usage history
| | |
|---|---|
| Module | `identity-access` (`cards`, `policy` step 12) |
| Tables | `card_limits`, `card_usage_counters`, `card_events`, `card_auth_state` |
| Endpoints | `GET /v1/cards/{id}/events`, `GET/PUT /v1/cards/{id}/limits` |
| Tests (planned) | `unit/policy.test.ts` (limit reached → deny), `integration/card-limits.test.ts`, `integration/card-events.test.ts` |
| Design only | **Anomaly lock**: hook is `card_auth_state.lock_reason = 'anomaly'`; no detection code. |

### Feature 20 — Audit log
| | |
|---|---|
| Module | `platform` (`audit`) |
| Tables | `audit_log`, `audit_chain_heads`, `audit_anchors` |
| Endpoints | `GET /v1/audit/events`, `POST /v1/audit/verify` |
| CLI | `audit:verify`, `audit:anchor` |
| Tests (planned) | `integration/audit.test.ts` (append-only by grant and by trigger, chain verification, tamper detection as superuser, anchor mismatch), `security/no-secrets.test.ts` |

### Feature 29 — Multi-tenant admin console API (basic)
| | |
|---|---|
| Module | `platform` (`tenants`) |
| Tables | `tenants`, `tenant_settings`, `plan_limits` |
| Endpoints | `POST /v1/tenants`, `GET /v1/tenants`, `GET /v1/tenants/current`, `GET/PATCH /v1/tenants/current/settings`, `GET /v1/tenants/current/usage` |
| CLI | `bootstrap-platform` (creates the operator tenant once) |
| Tests (planned) | `integration/rls.test.ts`, `integration/tenants.test.ts` (settings ranges, platform-only permissions) |

### Feature 30 — Export + backup / disaster-recovery skeleton
| | |
|---|---|
| Module | `platform` (`export`) + `scripts/` |
| Tables | `export_jobs` |
| Endpoints | `POST /v1/exports`, `GET /v1/exports/{id}` |
| Scripts | `scripts/backup.sh`, `scripts/restore-test.sh` |
| Infra | backups bucket, backup job + schedule (Terraform, plan-only) |
| Tests (planned) | `integration/export.test.ts` (only own tenant's rows, no secrets in export, allowed in grace and after expiry), restore test in CI |

### Feature 34 — Renewal with SC rotation (identity side)
| | |
|---|---|
| Module | `identity-access` (`lifecycle`, `secret-code`) |
| Tables | `cards` (`expires_at`, `grace_until`, `renewal_due`, `renewal_count`), `card_secrets` |
| Endpoints | `POST /v1/cards/{id}/renew` |
| Tests (planned) | `integration/renewal.test.ts` (old SC fails immediately, new SC works, dates move, sessions revoked, new SC absent from idempotent replay) |
| Not in Phase 1 | The billing trigger that calls renewal (Phase 4). |

## Phase 1 — design-only hooks (tables/columns + written design, no feature code)

| # | Feature | Hook | Design written in | Delivered in |
|---|---|---|---|---|
| 4 | QR / NFC formats | `card_tokens` table | `02-data-model.md` §E | later phase (unknown) |
| 16 | SSO + SCIM | `sso_connections`; `people.external_id`, `people.scim_managed` | `02-data-model.md` §E | later phase (unknown) |
| 21 | Regional hosting + bring-your-own-key | `tenants.region`, `tenants.encryption_key_ref`; Terraform `var.regions` | `02`, `06` | later phase (unknown) |
| 27 | Analytics events | `analytics_events` table | `02-data-model.md` §E | later phase (unknown) |
| 28 | Webhooks / outbox | `outbox_events`, `webhook_endpoints` | `02-data-model.md` §E | later phase (unknown) |

## Referenced by the prompt, delivered later

| # | Feature | What Phase 1 provides | Delivered in |
|---|---|---|---|
| 17 | Retrieval-time permission filtering | `buildResourceFilter` implemented and tested on an example resource | Phase 2 (stated in the prompt) |

## All 35 features

| # | Feature | Phase | Status |
|---|---|---|---|
| 1 | Unique cards (person + company) | 1 | Build |
| 2 | Role-based access | 1 | Build |
| 3 | Card lifecycle | 1 | Build |
| 4 | QR / NFC formats | later | Hook only in Phase 1 |
| 5 | Card-level limits and usage history | 1 | Build (anomaly lock: design only) |
| 6–15 | **NOT PROVIDED** | ? | Need the founder's list |
| 16 | SSO + SCIM | later | Hook only in Phase 1 |
| 17 | Retrieval-time permission filtering | 2 | Hook built and tested in Phase 1 |
| 18–19 | **NOT PROVIDED** | ? | Need the founder's list |
| 20 | Audit log | 1 | Build |
| 21 | Regional hosting + BYOK | later | Hook only in Phase 1 |
| 22–26 | **NOT PROVIDED** | ? | Need the founder's list |
| 27 | Analytics events | later | Hook only in Phase 1 |
| 28 | Webhooks / outbox | later | Hook only in Phase 1 |
| 29 | Multi-tenant admin console API (basic) | 1 | Build |
| 30 | Export + backup / DR skeleton | 1 | Build |
| 31–33 | **NOT PROVIDED** | ? | Need the founder's list |
| 34 | Renewal with SC rotation | 1 (identity side) / 4 (billing trigger) | Build |
| 35 | **NOT PROVIDED** | ? | Need the founder's list |

Known: 14 of 35. Missing: 21 (numbers 6–15, 18–19, 22–26, 31–33, 35).
