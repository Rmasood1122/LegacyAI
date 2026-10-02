# 07 — Feature map (all 35 features)

> **Redone in Phase 1.1 (2026-10-03)** against `docs/feature-list-35.md`, which is the source of truth.
> The earlier version of this document mapped a 30-feature list and guessed at "feature 34"; the three
> mismatches it reported are resolved by the new list (35 features; billing features 31–35 are separate;
> phases are now stated by you, not assumed by me).

## In plain language

For each of your 35 features: which phase delivers it and what exists today. For anything Phase 1 built, the exact module, tables, endpoints and tests are in the detail sections further down. "Hook" means a table or column exists so the feature can be added later without rebuilding — there is **no working feature** behind it.

Test file names are real files under `services/api/test/`. Results are in `REPORT.md`.

Phases (from your list): **P1** Foundation · **P2** Core value (capture, AI, verification) · **P3** Frontend · **P4** Revenue · **P5** Production readiness · **LATER** = after the pilot.

## All 35 features

| # | Feature | Delivering phase (your list) | What exists after Phase 1 + 1.1 | Module | Tables | Endpoints | Tests |
|---|---|---|---|---|---|---|---|
| 1 | Unique cards (person + company, check digit, SC) | P1 | **Built** | identity-access | `cards`, `card_directory`, `card_secrets`, `card_auth_state`, `credentials`, `enrollment_tokens`, `people` | `/v1/cards*`, `/v1/auth/*`, `POST /v1/tenants` | `unit/card-number`, `unit/secret-code`, `integration/smoke`, `integration/lockout`, `security/card-sc-alone`, `security/enumeration` |
| 2 | Role-based access (8 roles; 4 enabled for pilot) | P1 | **Built** | identity-access | `roles`, `permissions`, `role_permissions`, `card_roles`, `tenant_settings.enabled_roles` | `/v1/roles`, `/v1/cards/{id}/roles*`, `/v1/internal/policy/check` | `unit/policy`, `integration/resource-filter`, `security/route-policy-coverage` |
| 3 | Card lifecycle: issue, suspend, revoke, expire, replace | P1 | **Built** (API; screens are P3) | identity-access | `cards`, `card_events`, `sessions` | `/v1/cards/{id}/suspend`, `reinstate`, `revoke`, `replace`, `renew`, `unlock`, `enrollment-token`; `PATCH /v1/people/{id}` | `unit/lifecycle`, `integration/lifecycle`, `integration/sessions`, `integration/phase1-1` |
| 4 | Digital, QR and NFC formats | digital: P1/P3 · QR/NFC: LATER | Digital card = the card record and its number (built). **QR/NFC: hook only** | identity-access | `card_tokens` (hook) | — | — |
| 5 | Card-level limits, usage history, anomaly lock | limits + history: P1 · anomaly lock: LATER | Limits and history **built**. Anomaly lock: **hook only** (`card_auth_state.lock_reason = 'anomaly'`) | identity-access | `card_restrictions`, `card_usage_counters`, `card_events` | `/v1/cards/{id}/restrictions`, `/v1/cards/{id}/events` | `unit/policy`, `integration/features`, `integration/lifecycle` |
| 6 | Passive expertise capture (chats, tickets, email) | LATER (needs consent + legal review) | Nothing | — | — | — | — |
| 7 | Adaptive AI voice interviewer | text interviewer: P2 · voice: LATER | Nothing yet. Designed in `docs/phase2/05` | (P2) capture | (P2) `interviews`, `interview_turns` | (P2) | (P2) |
| 8 | Scenario replay mode | LATER | Nothing | — | — | — | — |
| 9 | Shadow mode (offline, frontline) | LATER | Nothing | — | — | — | — |
| 10 | Gap detector | P2 (simple version) | Nothing yet. Designed in `docs/phase2/05` | (P2) capture | (P2) `topics`, `role_topic_maps` | (P2) | (P2) |
| 11 | Retirement radar (24/12/6-month nudges) | LATER (needs reminders from P4) | Nothing | — | — | — | — |
| 12 | Expert verification loop | P2 | Permission `knowledge:verify` seeded; nothing else. Designed in `docs/phase2/06` | (P2) knowledge | (P2) `knowledge_items`, `knowledge_versions` | (P2) | (P2) |
| 13 | Readiness test for successors | P2 | Nothing yet. Designed in `docs/phase2/06` | (P2) knowledge | (P2) `quiz_items`, `quiz_attempts`, `quiz_answers` | (P2) | (P2) |
| 14 | Source-cited answers that say "I don't know" | P2 | Nothing yet. Designed in `docs/phase2/06` | (P2) knowledge | (P2) `chunks`, `citations` | (P2) | (P2) |
| 15 | Ask-the-expert mode | P2 | Nothing yet. Designed in `docs/phase2/06` | (P2) knowledge | (P2) `expert_questions` | (P2) | (P2) |
| 16 | SSO + SCIM provisioning | LATER (hook in P1) | **Hook only** | identity-access | `sso_connections`; `people.external_id`, `people.scim_managed` | — | — |
| 17 | Permission-aware answers (enforced at retrieval) | filter: P1 · retrieval wiring: P2 | Filter **built and tested** on cards and people. Wiring into search is P2 (`docs/phase2/03`) | identity-access | — | `/v1/internal/policy/check`; used by `GET /v1/cards`, `GET /v1/people` | `integration/resource-filter` (11,040 row-by-row comparisons in the last run), `unit/policy` |
| 18 | Sensitive-data redaction | P2 (basic) | Only redaction of **our own logs** (not this feature). Designed in `docs/phase2/05` | (P2) capture | (P2) `redaction_findings` | (P2) | `security/no-secrets` covers logs only |
| 19 | Expert consent and ownership controls | P2 | Nothing yet. Designed in `docs/phase2/05`. **Needs legal review; code cannot settle it.** | (P2) | (P2) `consents` | (P2) | (P2) |
| 20 | Tamper-evident audit log | P1 | **Built** | platform | `audit_log`, `audit_chain_heads`, `audit_anchors` | `/v1/audit/events`, `/v1/audit/verify` | `integration/audit`, `security/no-secrets` |
| 21 | Regional hosting and bring-your-own-key | LATER (hook in P1) | **Hook only** | platform | `tenants.region`, `tenants.encryption_key_ref`; Terraform `var.regions` | — | — |
| 22 | Answer quality monitor | LATER (basic logging in P2) | Nothing yet | (P2) knowledge | (P2) `answer_logs` | — | (P2) |
| 23 | Contradiction and staleness detection | LATER | Nothing. (P2 adds a `stale` item status by age only — not detection.) | — | — | — | — |
| 24 | Human review queue | P2 | Reviewer role and permission seeded; nothing else. Designed in `docs/phase2/06` | (P2) API gateway | (P2) `review_tasks` | (P2) | (P2) |
| 25 | Multi-language and multi-format (OCR, voice, drawings) | text + PDF: P2 · rest: LATER | Nothing yet. Designed in `docs/phase2/05` | (P2) capture | (P2) `sources`, `chunks` | (P2) | (P2) |
| 26 | Department templates | LATER | `departments` table exists (used by access rules), no templates | identity-access | `departments` | `/v1/departments` | `contract/contract` |
| 27 | Outcome analytics | LATER (events table in P1) | **Hook only** | platform | `analytics_events` | — | — |
| 28 | Open API, webhooks, connectors | LATER (outbox hook in P1) | **Hook only** for webhooks/connectors. The OpenAPI contract itself is built (47 operations). | platform | `outbox_events`, `webhook_endpoints` | — | `contract/contract` |
| 29 | Multi-tenant admin console and billing | API: P1 · screens: P3 · billing: P4 | Tenant API **built** (basic). No screens, no billing. | platform, identity-access | `tenants`, `tenant_settings`, `plan_limits` | `/v1/tenants*` | `integration/rls`, `integration/features`, `integration/phase1-1` |
| 30 | Living knowledge graph + open-format export + disaster recovery | export + backup: P1 · graph: LATER | Export and backup/restore skeleton **built**. No graph. | platform + `scripts/` | `export_jobs` | `/v1/exports*` | `integration/features`, `scripts/backup-restore-selftest.sh` |
| 31 | Renewal center | P4 | Nothing | (P4) billing | — | — | — |
| 32 | One company-wide renewal date | P4 | The **company card** carries one expiry date for the whole company and puts the tenant into read-only grace, then export-only. Billing does not drive it yet; since Phase 1.1 only the platform operator can renew it. | identity-access | `cards` (kind `company`) | `POST /v1/tenants/{id}/company-card/renew` | `integration/sessions`, `integration/phase1-1`, `security/review-findings` |
| 33 | Expiry reminders and optional auto-renew | P4 | `cards.renewal_due` and the `card_expiring` notification type exist; **nothing sends reminders** (no email, no scheduler job) | identity-access | `cards.renewal_due` | `GET /v1/tenants/current/usage` (count of cards expiring soon) | `integration/features` |
| 34 | Renewal with SC rotation | identity side: P1 · billing trigger: P4 | Identity side **built**: every renewal replaces the SC and ends the card's sessions. No billing trigger. | identity-access | `card_secrets`, `cards` | `POST /v1/cards/{id}/renew` | `integration/lifecycle` ("renewal rotates the SC") |
| 35 | Upgrade prompts at card limits | P4 | **Hook only**: `plan_limits` table and a billing stub the policy decision point already asks (`DENY_PLAN_LIMIT`); the stub always answers "allowed" | billing (stub) | `plan_limits` | — | `unit/policy` (plan-limit denial) |

**Built in Phase 1 + 1.1:** 1, 2, 3, 5 (limits + history), 20, the identity side of 34, and the Phase 1 parts of 4, 17, 29, 30, 32. **Hooks only:** 4 (QR/NFC), 5 (anomaly lock), 16, 21, 27, 28, 33, 35. **Phase 2 (designed, not built):** 7, 10, 12, 13, 14, 15, 17 (wiring), 18, 19, 22 (logging), 24, 25. **Nothing:** 6, 8, 9, 11, 23, 26, 31.

Buying-urgency tools (Risk Calculator, free gap scan, Clock Dashboard, pricing) are not in the 35 and are not built.

---

## Phase 1 — detail per built feature

### Feature 1 — Unique Access Card (person + company), including SC rotation on renewal
| | |
|---|---|
| Module | `identity-access` (`cards`, `card-number`, `secret-code`, `auth`, `lifecycle`) |
| Tables | `cards`, `card_directory`, `card_secrets`, `card_auth_state`, `credentials`, `enrollment_tokens`, `people` |
| Endpoints | `POST /v1/cards`, `GET /v1/cards`, `GET /v1/cards/{id}`, `POST /v1/cards/{id}/renew`, `POST /v1/cards/{id}/unlock`, `POST /v1/auth/login/*`, `POST /v1/auth/enrollment/*`, `POST /v1/tenants` (issues the company card and first Owner card) |
| Tests | `unit/card-number`, `unit/secret-code`, `integration/smoke`, `integration/lifecycle` (one live card per person, renewal with SC rotation — feature 34), `integration/lockout`, `integration/features` (pepper rotation, bootstrap), `security/card-sc-alone`, `security/enumeration` |
| From your list, covered | unique number with check digit · company card with person cards linked · SC stored only as a salted hash (plus pepper) · never the only login · lock after 3–5 wrong codes with admin alert (via the notification interface; console/log only for now) · rotation on renewal |
| From your list, **not** in Phase 1 | SSO or a device check as the strong factor (Phase 1: passkey or authenticator app). Email delivery of alerts. |

### Feature 2 — Role-based access
| | |
|---|---|
| Module | `identity-access` (`roles`, `policy`) |
| Tables | `roles`, `permissions`, `role_permissions`, `card_roles`, `tenant_settings.enabled_roles`, `departments` |
| Endpoints | `GET /v1/roles`, `GET/POST/PUT /v1/cards/{id}/roles`, `DELETE /v1/cards/{id}/roles/{role_key}`, `POST /v1/internal/policy/check` |
| Tests | `unit/policy` (84 table-driven cases plus garbage-input checks, deny by default), `integration/resource-filter` (all 8 roles, filter == decide on every row), `security/route-policy-coverage` |
| Notes | 4 roles on by default; the other 4 exist but are off. Reviewer capability granted to Admin and Expert by `pilot_reviewer` rows. "Contractor: time-limited" is covered by a shorter card validity + restrictions (feature 5). "Owner: billing" has nothing to grant until Phase 4. |

### Feature 3 — Card lifecycle
| | |
|---|---|
| Module | `identity-access` (`lifecycle`) |
| Tables | `cards` (state, dates), `card_events`, `sessions` (revocation) |
| Endpoints | `POST /v1/cards`, `…/suspend`, `…/reinstate`, `…/revoke`, `…/replace`, `…/enrollment-token`; `PATCH /v1/people/{id}` with `status: departed` revokes that person's card in the same transaction |
| CLI | `sweep-expired-cards` (records expiry; enforcement does not depend on it) |
| Tests | `unit/lifecycle` (all 36 state pairs), `integration/lifecycle` (DB trigger on all 36 pairs, replacement kills the old number and code at once, offboarding, rank and self-action guards, expiry sweep), `integration/sessions` (revocation, grace read-only) |
| **Not** in Phase 1 | The admin screen (frontend). Automatic offboarding driven by an HR system (needs SCIM, feature 16). |

### Feature 5 — Card-level permissions and usage history
| | |
|---|---|
| Module | `identity-access` (`cards`, `policy` step 12) |
| Tables | `card_restrictions`, `card_usage_counters`, `card_events`, `card_auth_state` |
| Endpoints | `GET /v1/cards/{id}/events`, `GET/PUT /v1/cards/{id}/restrictions` |
| Tests | `unit/policy` (each restriction type → deny), `integration/features` (read-only, usage cap, network, hours through the API), `integration/lifecycle` (usage history with device) |
| From your list, covered | what the card did and when, and from which device (the credential used + a fingerprint of the browser, never a raw address in the response) · business-hours-only · read-only · usage caps · "one site only" as a network allow-list |
| Design only | **Unusual-use lock** ("new country at 3 a.m."): hook is `card_auth_state.lock_reason = 'anomaly'`. No detection code, and no location lookup (that needs a paid or third-party data source). |

### Feature 20 — Audit log
| | |
|---|---|
| Module | `platform` (`audit`) |
| Tables | `audit_log`, `audit_chain_heads`, `audit_anchors` |
| Endpoints | `GET /v1/audit/events`, `POST /v1/audit/verify`; audit rows are included in the tenant export |
| CLI | `audit:verify`, `audit:anchor` |
| Tests | `integration/audit` (append-only by grant and by trigger, chain verification, tamper detection as superuser, anchor mismatch), `security/no-secrets` |
| Honest wording | Your list says "tamper-proof". We deliver **tamper-evident**: changes are detectable, not impossible. Please use that word with buyers. Phase 1 records card events, decisions and exports; capture, edit and question events arrive with the features that create them. |

### Feature 29 — Multi-tenant admin console (API, basic)
| | |
|---|---|
| Module | `platform` (`tenants`) |
| Tables | `tenants`, `tenant_settings`, `plan_limits` |
| Endpoints | `POST /v1/tenants`, `GET /v1/tenants`, `GET /v1/tenants/current`, `GET/PATCH /v1/tenants/current/settings`, `GET /v1/tenants/current/usage`; Phase 1.1 (operator only): `POST /v1/tenants/{id}/company-card/renew`, `POST /v1/tenants/{id}/owner-recovery` |
| CLI | `bootstrap-platform` (creates the operator tenant once) |
| Tests | `integration/rls` (isolation, platform-only permissions), `integration/features` (settings ranges, usage), `integration/lockout` (threshold range) |
| **Not** in Phase 1 | Billing, metering, invoicing (Phase 4). Bulk card issuing. Workspaces per division inside one company (today: one tenant = one workspace). |

### Feature 30 — Export + backup / disaster-recovery skeleton
| | |
|---|---|
| Module | `platform` (`export`) + `scripts/` |
| Tables | `export_jobs` |
| Endpoints | `POST /v1/exports`, `GET /v1/exports/{id}` |
| Scripts | `scripts/backup.sh`, `scripts/restore-test.sh` |
| Infra | backups bucket, backup job + schedule (Terraform, plan-only) |
| Tests | `integration/features` (own tenant's rows only, checksummed manifest), `security/no-secrets` (no secret columns), `integration/sessions` (export allowed after expiry), `scripts/backup-restore-selftest.sh` |
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
