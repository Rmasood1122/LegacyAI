# 07 — Feature map

## In plain language

For each of your features: which phase delivers it, and — for Phase 1 features — exactly which module, tables, endpoints and tests cover it. Test file names are the planned ones from the design; the Step 7 report will replace "planned" with real test output.

Source: the feature list you sent on 2026-10-02 (30 numbered features, sections A–G).

> ## ⚠ Three mismatches between your feature list and the Phase 1 prompt
>
> 1. **The list has 30 features; the prompt says 35** and refers to a "feature 34" that does not exist in the list. I have mapped the prompt's numbers onto the list as shown in the next table. Please correct me if a newer 35-item list exists.
> 2. **Card number format.** The list shows `LGY-4821-9376-0152` (a prefix + 12 digits) and says "do not make it look like a bank card". The prompt says 15 random digits + 1 check digit in groups of four — which is exactly the shape of a bank card. This needs your decision: see decision 5 in `08-open-decisions.md`.
> 3. **Build order.** The list puts features 16 (SSO/SCIM) and 22 (answer quality monitor) in the first build. The prompt forbids implementing SSO/SCIM and any AI in Phase 1. I follow the prompt: 16 is a schema hook only, 22 waits for the AI phase.

## How the prompt's feature numbers map to your list

| Prompt says | Your list | Note |
|---|---|---|
| 1 unique cards | **1** | same |
| 2 role-based access | **2** | same |
| 3 card lifecycle | **3** | same |
| 4 QR/NFC formats | **4** | same |
| 5 card-level limits and usage history | **5** | same |
| 16 SSO + SCIM | **16** | same |
| 17 retrieval-time filter | **17** | same |
| 20 audit log | **20** | same (the list calls it "tamper-proof"; what we can honestly deliver is tamper-**evident**) |
| 21 regional hosting + BYOK | **21** | same |
| 27 analytics events | **27** | same |
| 28 webhooks/outbox | **28** | same |
| 29 multi-tenant admin console API | **29** | admin console part only; billing/metering is Phase 4 |
| 30 export + backup/DR skeleton | **30** | the "open-format export and disaster recovery" half of feature 30; the knowledge graph half is later |
| 34 renewal with SC rotation | **1** ("codes can be rotated on a schedule") | no feature 34 in the list |

## Phase numbering

| Phase | Content | Source |
|---|---|---|
| 0 | Stack decisions | Prompt (done) |
| 1 | Foundation: identity, cards, access, platform | This phase |
| 2 | Knowledge layer / AI service | **ASSUMPTION** — the prompt says Phase 2 reuses the retrieval filter; your "Next" build group (6, 7, 12, 14) fits here |
| 3 | Frontend | **ASSUMPTION** — the prompt only says "later phase" |
| 4 | Billing | Prompt |
| unscheduled | Everything else | Not assigned to a phase by you yet; I have not invented one |

## All 30 features

| # | Feature | Phase | Phase 1 status |
|---|---|---|---|
| 1 | Unique Access Card for every person and company | **1** | **Build** (SSO and device check as the strong factor: later) |
| 2 | Role-based access attached to the card | **1** | **Build** (4 pilot roles on; all 8 in the matrix) |
| 3 | Card lifecycle management | **1** | **Build** the API. The "one admin screen" is frontend (Phase 3). Automatic revoke from an HR system needs feature 16/28. |
| 4 | Digital, QR and NFC card formats | unscheduled ("Later" group) | Hook only (`card_tokens`) |
| 5 | Card-level permissions and usage history | **1** | **Build** history + per-card restrictions. Unusual-use lock: design only. |
| 6 | Passive Expertise Capture | 2 | — |
| 7 | Adaptive AI Interviewer | 2 | — |
| 8 | Scenario Replay Mode | unscheduled | — |
| 9 | Shadow Mode | unscheduled | — |
| 10 | Gap Detector | unscheduled | — |
| 11 | Retirement Radar | unscheduled | — |
| 12 | Expert Verification Loop | 2 | Permission `knowledge:verify` seeded |
| 13 | Readiness Test | unscheduled ("Later" group) | — |
| 14 | Source-Cited Answers | 2 | — |
| 15 | Ask-the-Expert Mode | unscheduled | — |
| 16 | SSO and automatic provisioning | unscheduled (your list: first group; prompt: not Phase 1) | Hook only (`sso_connections`, `people.external_id`) |
| 17 | Permission-aware answers | 2 | **Hook built and tested** (`buildResourceFilter`) |
| 18 | Sensitive data redaction | unscheduled | Log redaction for our own logs only — not this feature |
| 19 | Expert consent and ownership controls | unscheduled (**must precede any capture — legal risk**) | — |
| 20 | Audit log | **1** | **Build** (tamper-evident) |
| 21 | Regional hosting and bring-your-own-key | unscheduled | Hook only (`tenants.region`, `encryption_key_ref`, Terraform `var.regions`) |
| 22 | Answer quality monitor | with/after Phase 2 | — (needs AI) |
| 23 | Contradiction and staleness detection | unscheduled | — |
| 24 | Human review queue | unscheduled | Reviewer role and permission seeded |
| 25 | Multi-language and multi-format support | unscheduled | — |
| 26 | Department templates | unscheduled ("Later" group) | `departments` table exists |
| 27 | Outcome analytics for executives | unscheduled ("Later" group) | Hook only (`analytics_events`) |
| 28 | Open API, webhooks and connectors | unscheduled | Hook only (`outbox_events`, `webhook_endpoints`). The OpenAPI contract itself is built. |
| 29 | Multi-tenant admin console and billing | **1** (console API) / **4** (billing, metering, invoicing) | **Build** tenant API (basic). Bulk card issuing: not in Phase 1. |
| 30 | Living Knowledge Graph + open export and disaster recovery | **1** (export + backup/restore skeleton) / unscheduled (graph) | **Build** export + backup skeleton only |

Buying-urgency tools (Risk Calculator, free 7-day gap scan, Clock Dashboard, pricing) are not numbered and are not in Phase 1.

**Phase 1 builds:** 1, 2, 3, 5, 20, and parts of 29 and 30. **Hooks only:** 4, 16, 17, 21, 27, 28.

---

## Phase 1 — detail per built feature

### Feature 1 — Unique Access Card (person + company), including SC rotation on renewal
| | |
|---|---|
| Module | `identity-access` (`cards`, `card-number`, `secret-code`, `auth`, `lifecycle`) |
| Tables | `cards`, `card_directory`, `card_secrets`, `card_auth_state`, `credentials`, `enrollment_tokens`, `people` |
| Endpoints | `POST /v1/cards`, `GET /v1/cards`, `GET /v1/cards/{id}`, `POST /v1/cards/{id}/renew`, `POST /v1/cards/{id}/unlock`, `POST /v1/auth/login/*`, `POST /v1/auth/enrollment/*`, `POST /v1/tenants` (issues the company card and first Owner card) |
| Tests (planned) | `unit/card-number`, `unit/secret-code`, `integration/cards` (global uniqueness, one live card per person, person card linked to its company), `integration/lockout`, `integration/renewal`, `security/card-sc-alone`, `security/enumeration` |
| From your list, covered | unique number with check digit · company card with person cards linked · SC stored only as a salted hash (plus pepper) · never the only login · lock after 3–5 wrong codes with admin alert (via the notification interface; console/log only for now) · rotation on renewal |
| From your list, **not** in Phase 1 | SSO or a device check as the strong factor (Phase 1: passkey or authenticator app). Email delivery of alerts. |

### Feature 2 — Role-based access
| | |
|---|---|
| Module | `identity-access` (`roles`, `policy`) |
| Tables | `roles`, `permissions`, `role_permissions`, `card_roles`, `tenant_settings.enabled_roles`, `departments` |
| Endpoints | `GET /v1/roles`, `GET/POST/PUT /v1/cards/{id}/roles`, `DELETE /v1/cards/{id}/roles/{role_key}`, `POST /v1/internal/policy/check` |
| Tests (planned) | `unit/policy` (table-driven, deny by default, all 8 roles × all permissions), `integration/resource-filter`, `security/route-policy-coverage` |
| Notes | 4 roles on by default; the other 4 exist but are off. Reviewer capability granted to Admin and Expert by `pilot_reviewer` rows. "Contractor: time-limited" is covered by a shorter card validity + restrictions (feature 5). "Owner: billing" has nothing to grant until Phase 4. |

### Feature 3 — Card lifecycle
| | |
|---|---|
| Module | `identity-access` (`lifecycle`) |
| Tables | `cards` (state, dates), `card_events`, `sessions` (revocation) |
| Endpoints | `POST /v1/cards`, `…/suspend`, `…/reinstate`, `…/revoke`, `…/replace`, `…/enrollment-token`; `PATCH /v1/people/{id}` with `status: departed` revokes that person's card in the same transaction |
| CLI | `sweep-expired-cards` (records expiry; enforcement does not depend on it) |
| Tests (planned) | `unit/lifecycle` (all 36 state pairs), `integration/lifecycle` (DB trigger, replacement kills the old number and code at once, session revocation, grace read-only, last-owner protection, departed → revoked) |
| **Not** in Phase 1 | The admin screen (frontend). Automatic offboarding driven by an HR system (needs SCIM, feature 16). |

### Feature 5 — Card-level permissions and usage history
| | |
|---|---|
| Module | `identity-access` (`cards`, `policy` step 12) |
| Tables | `card_restrictions`, `card_usage_counters`, `card_events`, `card_auth_state` |
| Endpoints | `GET /v1/cards/{id}/events`, `GET/PUT /v1/cards/{id}/restrictions` |
| Tests (planned) | `unit/policy` (each restriction type → deny), `integration/card-restrictions`, `integration/card-events` |
| From your list, covered | what the card did and when, and from which device (the credential used + a fingerprint of the browser, never a raw address in the response) · business-hours-only · read-only · usage caps · "one site only" as a network allow-list |
| Design only | **Unusual-use lock** ("new country at 3 a.m."): hook is `card_auth_state.lock_reason = 'anomaly'`. No detection code, and no location lookup (that needs a paid or third-party data source). |

### Feature 20 — Audit log
| | |
|---|---|
| Module | `platform` (`audit`) |
| Tables | `audit_log`, `audit_chain_heads`, `audit_anchors` |
| Endpoints | `GET /v1/audit/events`, `POST /v1/audit/verify`; audit rows are included in the tenant export |
| CLI | `audit:verify`, `audit:anchor` |
| Tests (planned) | `integration/audit` (append-only by grant and by trigger, chain verification, tamper detection as superuser, anchor mismatch), `security/no-secrets` |
| Honest wording | Your list says "tamper-proof". We deliver **tamper-evident**: changes are detectable, not impossible. Please use that word with buyers. Phase 1 records card events, decisions and exports; capture, edit and question events arrive with the features that create them. |

### Feature 29 — Multi-tenant admin console (API, basic)
| | |
|---|---|
| Module | `platform` (`tenants`) |
| Tables | `tenants`, `tenant_settings`, `plan_limits` |
| Endpoints | `POST /v1/tenants`, `GET /v1/tenants`, `GET /v1/tenants/current`, `GET/PATCH /v1/tenants/current/settings`, `GET /v1/tenants/current/usage` |
| CLI | `bootstrap-platform` (creates the operator tenant once) |
| Tests (planned) | `integration/rls`, `integration/tenants` (settings ranges, platform-only permissions) |
| **Not** in Phase 1 | Billing, metering, invoicing (Phase 4). Bulk card issuing. Workspaces per division inside one company (today: one tenant = one workspace). |

### Feature 30 — Export + backup / disaster-recovery skeleton
| | |
|---|---|
| Module | `platform` (`export`) + `scripts/` |
| Tables | `export_jobs` |
| Endpoints | `POST /v1/exports`, `GET /v1/exports/{id}` |
| Scripts | `scripts/backup.sh`, `scripts/restore-test.sh` |
| Infra | backups bucket, backup job + schedule (Terraform, plan-only) |
| Tests (planned) | `integration/export` (only own tenant's rows, no secrets in export, allowed in grace and after expiry), restore test in CI |
| **Not** in Phase 1 | The Living Knowledge Graph itself. |

## Phase 1 — design-only hooks

| # | Feature | Hook | Design written in |
|---|---|---|---|
| 4 | QR / NFC / wallet formats | `card_tokens` table | `02-data-model.md` §E |
| 16 | SSO + SCIM | `sso_connections`; `people.external_id`, `people.scim_managed` | `02-data-model.md` §E |
| 17 | Permission-aware answers | `buildResourceFilter` — **implemented and tested** on an example resource | `04-policy-decision-point.md` |
| 21 | Regional hosting + BYOK | `tenants.region`, `tenants.encryption_key_ref`; Terraform `var.regions` | `02`, `06` |
| 27 | Outcome analytics | `analytics_events` table | `02-data-model.md` §E |
| 28 | Webhooks / connectors | `outbox_events`, `webhook_endpoints` | `02-data-model.md` §E |
