# 04 — Policy decision point (PDP)

## In plain language

There is **one gatekeeper** in the whole system. Every request must ask it: "may this card do this action to this thing?" The gatekeeper answers **allow** or **deny**, gives a reason code, and may attach conditions ("allow, but read-only"). If the gatekeeper is unsure, confused, or crashes, the answer is **deny**.

The rules the gatekeeper follows are stored as **data** — a table of which role may do what — not as `if` statements sprinkled through the code. Handlers are not allowed to make access decisions themselves, and a test fails the build if an endpoint forgets to ask.

The same gatekeeper can also answer a broader question — "which rows of this kind may this card see at all?" — as a database filter. Phase 2's knowledge search must use that filter, so nobody can retrieve content they are not allowed to see.

## The two functions

```ts
decide(subject, action, resource, context)
  → { effect: "allow" | "deny", reason_code: string, obligations: Obligation[] }

buildResourceFilter(subject, action, resourceType)
  → { sql: string, params: unknown[] }        // a WHERE-clause fragment; "FALSE" when nothing is allowed
```

### Inputs

| Input | Contents |
|---|---|
| `subject` | `kind` (`card` \| `anonymous` \| `service`), `tenant_id`, `card_id`, `card_kind`, effective card state, `expires_at`, `grace_until`, roles (each with optional department), `person_id`, `department_id`, `is_platform_tenant`. Built **only** by the session layer from the database — never from request input. |
| `action` | A permission key, `resource:action`, e.g. `card:suspend`. Must exist in the `permissions` table; an unknown action is denied. |
| `resource` | `type`, `id`, `tenant_id`, and attributes: `owner_card_id`, `department_id`, `sensitivity` (0–3), `state`. Loaded by the handler's resource loader, inside the tenant transaction. |
| `context` | `now` (injected clock), `request_id`, `ip`, tenant settings, the plan-limit checker (billing interface), usage counters. |

### Output

- `effect` — `allow` or `deny`.
- `reason_code` — stable, machine-readable. Deny codes are internal: the HTTP layer maps them to a generic 403 (or 404 for cross-tenant, so existence is not revealed).
- `obligations` — things the caller **must** do when allowed, for example `{ type: "read_only" }`, `{ type: "export_only" }`, `{ type: "count_usage", limit_key }`, `{ type: "mask_fields", fields }`. The HTTP layer enforces the obligations it knows and **denies if it receives one it does not understand**.

## Evaluation order

Each step can only deny or narrow. Allow is reached only at the end.

| # | Rule | Deny code |
|---|---|---|
| 0 | Any exception, missing input, unknown action or malformed subject | `DENY_PDP_ERROR` / `DENY_UNKNOWN_ACTION` |
| 1 | Subject must be authenticated for a non-public action | `DENY_UNAUTHENTICATED` |
| 2 | **Tenant match:** `resource.tenant_id` must equal `subject.tenant_id` (the only exception: `platform_only` permissions used by the platform tenant) | `DENY_TENANT_MISMATCH` |
| 3 | **Tenant status** must be `active` | `DENY_TENANT_INACTIVE` |
| 4 | **Card state:** `active` continues. `issued`, `suspended`, `revoked`, `replaced` are denied. | `DENY_CARD_STATE` |
| 5 | **Expiry and grace** (the only place this is enforced): before `expires_at` → continue. In grace → continue with obligation `read_only`; any permission with `is_write = true` is denied, except `export:create`. After grace → denied, except `export:create` / `export:read` for a Company Owner (obligation `export_only`). | `DENY_GRACE_READ_ONLY`, `DENY_CARD_EXPIRED` |
| 5b | **Company card (pending decision 1 in `08`):** the same expiry/grace rule is applied to the tenant's company card — if it is in grace the whole tenant is read-only; after grace only Owner export remains | `DENY_TENANT_GRACE_READ_ONLY`, `DENY_TENANT_EXPIRED` |
| 6 | **Role enabled for this tenant:** roles not in `tenant_settings.enabled_roles` are ignored | — (falls through) |
| 7 | **Permission matrix:** at least one of the subject's enabled roles must hold the permission. Rows marked `pilot_reviewer` count only if `pilot_reviewer_grant` is true. | `DENY_DEFAULT` |
| 8 | **Scope** of the matching grant: `tenant` → any resource in the tenant; `department` → resource's department must equal the role's department; `own` → resource must belong to the subject's own card/person | `DENY_SCOPE` |
| 9 | **Sensitivity label:** `resource.sensitivity ≤ grant.max_sensitivity` | `DENY_SENSITIVITY` |
| 10 | **Guard rules** (data-driven list): cannot act on your own card for suspend / revoke / role changes; cannot grant or remove a role ranked above your own highest role; cannot remove the last active Company Owner | `DENY_SELF_ACTION`, `DENY_RANK`, `DENY_LAST_OWNER` |
| 11 | **Plan limits hook:** `billing.checkLimit(tenant, action)` — the Phase 1 stub always answers "within limits" | `DENY_PLAN_LIMIT` |
| 12 | **Card-level usage limits (feature 5):** if a `card_limits` row applies to this action and the counter for the current window is at its maximum | `DENY_CARD_LIMIT` |
| 13 | Otherwise | `ALLOW` (+ obligations collected above) |

**Deny by default** is structural: the function starts with `effect = deny, reason = DENY_DEFAULT` and only step 13 can change it.

## Policy is data

| What | Where | Editable by |
|---|---|---|
| Roles, permissions, role→permission matrix with scope and sensitivity | Tables `roles`, `permissions`, `role_permissions` (seeded by migration) | A migration (reviewed, versioned). Not by tenants in Phase 1. |
| Which roles a tenant uses; the pilot reviewer grant; lockout threshold; validity and grace days | `tenant_settings` | Company Owner |
| Per-card role assignments | `card_roles` | Owner / Admin (subject to the rank rule) |
| Per-card usage limits | `card_limits` | Owner / Admin |
| State, grace and guard rules | One declarative table in code: `policy/rules.ts` — an array of rule objects evaluated by a generic engine, with a unit-test row per rule | A code change (reviewed, tested) |

The matrix is loaded from the database and cached in memory for 60 seconds; the seed's checksum is logged at start-up.

## The pilot matrix (summary)

✔ = tenant-wide, D = own department only, O = own card/person only, — = no. Disabled roles are in *italics*: they exist in the matrix but a tenant must enable them.

| Permission | Owner | Admin | *Dept Mgr* | Expert | Successor | *Reviewer* | *Auditor* | *Contractor* |
|---|---|---|---|---|---|---|---|---|
| `tenant_settings:read` | ✔ | ✔ | — | — | — | — | ✔ | — |
| `tenant_settings:update` | ✔ | — | — | — | — | — | — | — |
| `tenant_usage:read` | ✔ | ✔ | — | — | — | — | ✔ | — |
| `person:create` / `update` | ✔ | ✔ | — | — | — | — | — | — |
| `person:read` | ✔ | ✔ | D | O | O | O | ✔ | O |
| `department:create` | ✔ | ✔ | — | — | — | — | — | — |
| `department:read` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `card:issue` | ✔ | ✔ | — | — | — | — | — | — |
| `card:read` / `card:list` | ✔ | ✔ | D | O | O | O | ✔ | O |
| `card:suspend` / `reinstate` / `revoke` / `replace` / `renew` / `unlock` / `reset_credentials` | ✔ | ✔ | — | — | — | — | — | — |
| `card_events:read` | ✔ | ✔ | D | O | O | O | ✔ | O |
| `card_limits:read` / `update` | ✔ | ✔ | — | — | — | — | read | — |
| `role:read` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `card_roles:read` | ✔ | ✔ | D | O | O | O | ✔ | O |
| `card_roles:assign` / `remove` | ✔ | ✔ (not Owner — rank rule) | — | — | — | — | — | — |
| `audit:read` / `audit:verify` | ✔ | ✔ | — | — | — | — | ✔ | — |
| `export:create` / `export:read` | ✔ | — | — | — | — | — | — | — |
| `knowledge:read` *(Phase 2 placeholder)* | ✔ | ✔ | D | ✔ | ✔ | ✔ | — | O |
| `knowledge:contribute` *(placeholder)* | — | — | — | ✔ | — | — | — | — |
| `knowledge:verify` *(Reviewer capability)* | — | ✔ pilot | — | ✔ pilot | — | ✔ | — | — |
| `tenant:create` / `tenant:list` *(platform only)* | platform tenant only | — | — | — | — | — | — | — |

"✔ pilot" = granted through a `pilot_reviewer` row: this is how "Reviewer capabilities are temporarily granted to Admin and Expert" is implemented, and turning off one tenant setting removes it. The `knowledge:*` rows have no endpoints in Phase 1; they exist so Phase 2 needs no matrix redesign. The full matrix is the seed file; this table is a summary and Gate 1 is the moment to correct it.

## The retrieval-time hook: `buildResourceFilter`

**Problem it solves (feature 17).** In Phase 2 the AI will search a company's knowledge. If we fetched results first and filtered afterwards, a forbidden document could still influence an answer or leak through counts and ranking. The filter must be part of the database query itself.

**How it works.** Each resource type registers a small descriptor — which columns hold its tenant, department, owner and sensitivity:

```ts
registerResourceType("card", {
  table: "cards", tenantColumn: "tenant_id",
  ownerColumn: "id", departmentColumn: null /* via people */, sensitivityColumn: null })
```

`buildResourceFilter(subject, action, type)` runs the *same* rules as `decide` but, instead of testing one resource, emits a predicate over those columns:

- subject fails steps 1–6 → `FALSE`
- grant with scope `tenant` → `tenant_id = $1 AND sensitivity <= $2`
- scope `department` → `… AND department_id = $3`
- scope `own` → `… AND owner_id = $3`
- several grants → joined with `OR`

Column names come only from the registered descriptor (a fixed allow-list); all values are bound parameters. The fragment is **in addition to** row-level security, not instead of it.

**Phase 1 uses it for real** on the list endpoints (`GET /v1/cards`, `/v1/people`, `/v1/cards/{id}/events`) and tests it on a test-only example table with department and sensitivity columns — the shape Phase 2's knowledge items will have.

**Consistency guarantee (tested):** for randomly generated subjects and rows, a row is returned by the filter **if and only if** `decide` allows that subject to read that row. If the two ever disagree the test fails.

## Every decision is audited

`decide` returns a decision; the caller's wrapper `authorize()` writes it to the audit log **before** the handler runs (deny) or in the same transaction as the handler's work (allow). There is no way to call `decide` from a handler without going through `authorize()`. `buildResourceFilter` writes one audit row per query, recording the action, the resource type and the scope applied — not one row per returned item.

## Handlers cannot decide for themselves

Four independent checks:

1. **Route definition requires policy metadata.** Routes are registered only through `defineRoute({ operationId, policy })`, where `policy` is either `{ action, resource: loader }` or `{ public: true, reason: "…" }`. The type system rejects a route without it. A lint rule bans calling Fastify's `app.get/post/…` directly.
2. **Runtime guard.** For every non-public route, the HTTP layer checks, just before sending the response, that an allow decision was recorded for this request. If not → 500 and an alarm-level log. Fail closed.
3. **Coverage test** (`test/security/route-policy-coverage.test.ts`): lists every registered route, fails if any lacks policy metadata, and compares the public list against a fixed snapshot (health, readiness, login begin/verify, enrollment begin/complete). Adding a public route requires changing that snapshot deliberately.
4. **Lint rule:** inside `handlers/`, reading `subject.roles` or comparing role names is forbidden. Only the policy module may.

"Seen it fire": the test suite includes a deliberately unprotected test route and asserts that checks 2 and 3 catch it.

## Tests

`test/unit/policy.test.ts` is table-driven — one row per (role × permission × scope × card state × grace × tenant match) combination of interest, including:

- no roles → deny; unknown action → deny; exception inside a rule → deny;
- every role against every permission in the matrix, generated from the seed (so matrix and tests cannot drift);
- disabled role is ignored; pilot reviewer grant on / off;
- cross-tenant → deny; department scope; own scope; sensitivity above the grant → deny;
- grace → reads allowed, writes denied, export allowed; after grace → deny, Owner export only;
- self-suspend, rank escalation, last-owner removal → deny;
- card usage limit reached → deny;
- unknown obligation → the HTTP layer denies.

`test/integration/resource-filter.test.ts` — the if-and-only-if property against real PostgreSQL.

## Honest limits

- The department and sensitivity attributes are implemented and tested, but Phase 1 has little real data that uses them. Their first real exercise is Phase 2.
- The plan-limit hook is a stub; it proves the wiring, not billing.
- Writing every allow decision to the audit log costs one extra row per request. At pilot scale that is fine; at scale it will need batching or sampling of low-risk reads (see `06`, storage).
