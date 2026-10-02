# 03 — Security model

> **Updated after the build (2026-10-02).** This document was approved at Gate 1 and then corrected to match
> what was actually built. Every difference from the approved version is listed, with the reason, in
> `REPORT.md` under "Deviations". The schema as built is drawn in `schema.md`.

## In plain language

- The card number is like a username: it identifies you, it is not secret.
- The 3-digit code (SC) is a weak extra check. It can never open the door by itself.
- The thing that actually proves who you are is a **passkey** (your phone/laptop's fingerprint or face unlock) or an **authenticator app code**.
- All three are sent **together in one step**. The server checks the strong proof first.
- Whatever goes wrong, the outside world sees the same boring answer: "could not sign in". The real reason is written only in our internal log.
- Each company's data is walled off by the database itself.
- Every decision is written to a log that cannot be quietly edited: any edit breaks a chain of fingerprints, and a checker finds the broken link. That makes the log **tamper-evident**. It is **not tamper-proof**: someone with full database control could still destroy it — we would just be able to tell.

**Honesty note.** This document describes a design. Nothing in it is "secure" until the test named in the "Tested by" column exists and passes. Step 7's report will say which tests ran and what they printed.

---

## 1. Login = card number + SC + strong factor

### The flow

```
POST /v1/auth/login/begin   { card_number }
   → always 200 { login_txn, webauthn_options, totp_allowed: true }     (same shape for unknown cards)

POST /v1/auth/login/verify  { login_txn, sc, factor: { type: "passkey", assertion } | { type: "totp", code } }
   → 200 + session cookie      or      401 generic problem (identical in every failure case)
```

### Why "card + SC only" is impossible by construction

1. **One function creates sessions**, `sessions.create(proof)`, and its only parameter is a `VerifiedLogin` object.
2. A `VerifiedLogin` can only be built by `completeLogin()`, which requires **both** a `StrongFactorProof` and an `ScProof`. These are "branded" types: the only code able to produce a `StrongFactorProof` is the passkey verifier and the TOTP verifier. There is no constructor, no cast helper, no test back door in production code.
3. The `verify` request schema makes `factor` **required**. A request without it is rejected by validation before any login code runs.
4. There is no "remember this device", no magic link, no SMS, no API key, no password-reset-by-SC. Recovery from a lost factor goes through an administrator issuing a one-time enrollment token (256 bits of randomness — itself a strong secret).
5. Lint rule: `sessions.create` may be imported only by the login module (dependency-cruiser), and a test greps the codebase for any other `INSERT INTO sessions`.

**Tested by** (`test/security/card-sc-alone.test.ts`): (a) for every operation in `openapi.yaml`, send valid card + valid SC and no factor / empty factor / malformed factor / a factor belonging to a different card → never a session cookie, never a 2xx on a protected route; (b) a compile-time test proving `sessions.create` does not accept anything but `VerifiedLogin`; (c) the "only one INSERT INTO sessions" grep test.

### Enrollment (how the first strong factor gets attached)

When a card is issued, the administrator receives — **once** — the card number, the SC, and a one-time **enrollment token** (expires in 72 hours). The new cardholder presents card number + SC + enrollment token and registers a passkey or an authenticator app. The card moves from `issued` to `active`. Until then the card cannot log in at all.

The enrollment token is the strong factor for that one step, so even enrollment is never "card + SC alone".

---

## 2. Card number

- **Format:** 16 digits = 15 random digits + 1 check digit, in groups of four, as the Phase 1 prompt specifies. Stored as text (leading zeros matter). **Display format is pending decision 5 in `08`:** your feature list asks that the card not look like a bank card and shows an `LGY-` prefix, so the recommendation is to always display `LGY-1234-5678-9012-3456` and accept input with or without the prefix, spaces or dashes.
- **Randomness:** each digit from Node's `crypto.randomInt` (a CSPRNG). Never sequential, never derived from time or tenant. 10¹⁵ possibilities.
- **Uniqueness:** enforced globally by the `card_directory` primary key; on the rare collision we generate again.
- **Check digit: Damm.** Justification:
  | | Luhn | Verhoeff | **Damm** |
  |---|---|---|---|
  | Catches every single wrong digit | yes | yes | yes |
  | Catches every swap of two neighbouring digits | **no** (misses 09↔90) | yes | yes |
  | Complexity | simple | three tables | **one 10×10 table** |
  | Looks like a payment card number | **yes** (16 digits + Luhn = same shape as a credit card) | no | no |

  Damm matches Verhoeff's error detection with a third of the moving parts. Luhn is rejected for two reasons: it misses a real typing mistake, and a 16-digit Luhn-valid number is indistinguishable from a payment card number, which would set off data-loss-prevention scanners and confuse customers. As an extra guard we **regenerate any number that happens to also be Luhn-valid** (about 1 in 10), so no LegacyAI card number ever passes as a credit card.
- **What the check digit is not:** it only catches typing mistakes. It is **not a security control**. Anyone can compute a valid check digit.
- The card number is an **identifier, not a secret**. Nothing in the design relies on it being hidden — though we still avoid leaking the full list (see `card_directory`).

**Tested by** (`test/unit/card-number.test.ts`): exhaustive proof over a sample space that every single-digit error and every adjacent transposition is detected; format; no Luhn-valid output in 100,000 generations; the generator calls the CSPRNG (`Math.random` is banned by lint).

---

## 3. SC storage

```
stored = Argon2id( HMAC-SHA-256( pepper[pepper_id], card_id ‖ ":" ‖ SC ),  salt = 16 random bytes per hash )
```

- **Argon2id parameters:** memory 19,456 KiB (19 MiB), 2 iterations, parallelism 1 — the OWASP minimum — as a **floor enforced in code** (start-up fails if configuration asks for less). Tuned upward in Step 4 by a benchmark on a 512 MiB / 1 vCPU container, target 100–250 ms per hash. A semaphore caps concurrent hashes (default 4 → at most ~80 MiB) so a login burst cannot exhaust container memory. The parameters are stored inside each hash (PHC format), so they can be raised later and old hashes still verify.
- **Why the pepper matters (plain language).** There are only 1,000 possible codes. If a thief steals the database and the hash depended only on things *in* the database, they would try all 1,000 codes against each card. Even at a quarter of a second per try that is about four minutes per card — the slow hash buys almost nothing. The pepper is a long random key that lives in **Secret Manager, never in the database**. Without it, the thief cannot even start: every guess needs the pepper. So the database alone is not enough; they would have to steal the database **and** break into the secret store.
- **Honest limit:** if an attacker gets *both* the database and the pepper, every SC falls in minutes. That is inherent in a 3-digit code and is exactly why the SC is never more than a second factor.
- **Pepper rotation:** peppers are a small keyring `{ "v1": "...", "v2": "..." }` with one marked current. Every hash row records its `pepper_id`. Because the SC cannot be recovered from the hash, old hashes cannot be re-peppered in bulk; they are upgraded (a) on the next successful login, when we briefly hold the SC and can re-hash under the current pepper, and (b) at the latest at the next renewal — every SC is replaced within the 90-day card life anyway. An old pepper can be deleted once no row references it (a CLI reports the count). If a pepper is believed stolen: rotate, and force-renew all cards still on the old id.
- Binding the `card_id` into the HMAC input means a hash copied from one card's row to another's will not verify.
- **SC generation:** `crypto.randomInt(0, 1000)`, zero-padded to 3 digits. Shown **once** in the API response at issue/renew/unlock; never logged, never stored, never retrievable.

**Tested by** (`test/unit/secret-code.test.ts`): correct SC verifies; wrong SC fails; same SC on two cards gives different hashes; hash made under `v1` verifies while `v2` is current and is upgraded on success; unknown `pepper_id` fails closed; parameters below the floor refuse to start; hash moved to another card fails.

---

## 4. Lockout — and how we stop it being a weapon

### The problem

"Lock after 5 wrong codes" normally means anyone who knows your card number can type five wrong codes and lock you out, forever, on repeat. Card numbers are not secret, so that would be a free denial-of-service button.

### The design: the strong factor is checked first; only then do SC failures count

Order of checks inside `verify` (one request carries everything):

| # | Check | If it fails |
|---|---|---|
| 1 | IP and global rate limits | generic 429 (same for everyone) |
| 2 | Login transaction valid, unexpired, unused | generic 401 |
| 3 | **Strong factor** (passkey signature or TOTP code) | generic 401. Counts toward the per-card *factor throttle*. **Does not touch the SC counter.** |
| 4 | SC (Argon2id) — **always computed**, real or dummy, so timing is the same | if step 3 passed and SC is wrong: `sc_failed_count + 1`; at the threshold the card becomes **SC-locked** |
| 5 | Card state, expiry, lock | generic 401 |
| 6 | All good | reset counters, create session |

Consequences:

- **An attacker who only knows the card number can never move the SC counter**, because they cannot pass step 3. They cannot lock anyone out.
- An attacker who *has* the victim's passkey device or authenticator seed gets at most 5 guesses out of 1,000 (0.5%) before the card locks — and at that point locking the card is exactly what we want.
- **Passkey users cannot be throttled by strangers at all:** a passkey signature cannot be guessed, so we never need to slow it down.
- **TOTP users:** a 6-digit code *can* be guessed, so failed TOTP attempts must be limited. After 5 failed TOTP attempts for a card in 15 minutes, TOTP for that card is paused for 15 minutes (doubling on repeat, capped at 1 hour, auto-expiring). **Changed after the independent review:** during a pause a code is examined *only when the SC in the same request is correct*. A stranger (who does not know the SC) therefore learns nothing while the pause lasts, but the real cardholder — who does know the SC — can still sign in with a correct code, so a stranger can no longer keep a TOTP user out. Someone who knows the SC and guesses codes during a pause is counted toward the hard lock (3–5 tries). A code is also spent the moment it verifies, even if the SC was wrong, so one observed code cannot be reused to try several SCs. **Residual risk:** TOTP codes can still be phished in real time; passkey remains the recommended default (see `08-open-decisions.md`).

### Threshold

Tenant setting, default 5, database `CHECK` between 3 and 5.

### Unlock flow

- An Owner or Admin calls `POST /v1/cards/{id}/unlock`. Unlock **always issues a new SC** (shown once): the old one was either forgotten or under attack. Audited; the cardholder's sessions are revoked; the cardholder is notified.
- Nobody can unlock their own card.
- If the *only* Company Owner is locked out, recovery is a manual, audited platform-operator procedure (see `08-open-decisions.md`).
- A successful login resets `sc_failed_count` to 0.

**Tested by** (`test/integration/lockout.test.ts`): 100 wrong-SC attempts with no valid factor → card not locked, real user still logs in; valid factor + 5 wrong SCs → locked; correct SC while locked → still generic failure; unlock rotates SC, old SC dead; threshold 2 or 6 rejected by the database; TOTP pause expires by itself; passkey works during a TOTP pause.

---

## 5. No enumeration

The five cases — **unknown card, wrong SC, locked card, expired card, wrong factor** — return:

- the same HTTP status (401),
- the same body, byte for byte apart from the request id (`type: …/auth-failed`, `title: "Sign-in failed"`),
- the same headers (including `Set-Cookie` absence),
- approximately the same time.

How:

- `login/begin` returns a real-looking transaction and WebAuthn options for **any** 16-digit input. We always send an empty credential list (passkeys are "discoverable"), so the response cannot reveal whether a card exists or which factors it has. `totp_allowed` is always `true`.
- `login/verify` always performs **exactly one** Argon2id computation — against the real hash or against a fixed dummy hash with the same parameters — and exactly one factor verification (real or dummy).
- Rate limits answer with the same 429 regardless of whether the card exists.
- The **real reason** goes to `login_attempts.real_reason` and the audit log only.

**Honest limit:** "approximately the same time" means we remove the large, obvious differences (skipping the hash, skipping database work). We do not claim resistance to an attacker measuring microsecond differences across thousands of samples; that needs a dedicated timing study (listed as a gap).

**Rate limits** (Postgres-backed, fixed windows; all three apply before any hashing):

| Limit | Default | Purpose |
|---|---|---|
| per IP, login endpoints | 20 / 5 min | slow down one attacker |
| per card number, failed factor attempts | 5 / 15 min for TOTP (see §4) | stop TOTP guessing |
| global, login endpoints | 300 / min | cap total Argon2 work so a flood cannot run up CPU cost |
| per IP, all endpoints | 300 / min | general abuse |

**Tested by** (`test/security/enumeration.test.ts`): the five cases produce identical status, identical body after removing the request id, identical header names; median timing of each case within a tolerance of the others (reported, with the measured numbers); `login/begin` identical for known and unknown cards. `test/security/rate-limit.test.ts`: each limit fires and returns the uniform 429.

---

## 6. Sessions

| Property | Design |
|---|---|
| Storage | Server-side, `sessions` table in PostgreSQL, behind a `SessionStore` interface (Redis can replace it later) |
| Session id | `v1.<tenant id>.<32 random bytes, base64url>`. Opaque: carries no rights. Only its SHA-256 is stored, so a database leak does not leak usable sessions. The tenant part only tells the server which tenant's rows to look in; forging it finds nothing. |
| Cookie | `__Host-lai_session`; `HttpOnly; Secure; SameSite=Strict; Path=/`; no `Domain` |
| Idle timeout | 30 minutes (tenant setting) |
| Absolute timeout | 12 hours (tenant setting) |
| Rotation | New id (old one revoked) on any privilege change to the session's own card. A role change made *to another card* revokes that card's sessions. |
| CSRF | Three layers: `SameSite=Strict`; an `Origin` header allow-list on every state-changing request; a per-session CSRF token (returned by `GET /v1/auth/session`, sent back in `X-CSRF-Token`, derived from the session token with HMAC so it is never stored in usable form, compared in constant time). After a session rotation the client must re-read `/v1/auth/session` to get the new token. |
| Instant revocation | Two mechanisms, so neither is a single point of failure: (1) suspend / revoke / replace / unlock / renew **explicitly revoke** the card's sessions in the same transaction; (2) **every request re-reads the card's state** — a session is honoured only if the card's *effective* state allows it. Expiry needs no background job: it is a comparison with the clock on every request. |

No session data is cached in memory, so revocation takes effect on the very next request.

**Design note for the later frontend:** `*.run.app` addresses are treated by browsers as different sites, so `SameSite=Strict` cookies only work if the web app and the API share one origin. The plan is for the web container to proxy `/v1/*` to the API. No Phase 1 impact.

**Tested by** (`test/integration/sessions.test.ts`): cookie flags; DB stores hash not token; idle and absolute expiry (fake clock); suspend → next request 401; revoke → 401; expiry passing → 401 (or read-only in grace); role change rotates/revokes; state-changing request without CSRF token or with wrong Origin → 403.

---

## 7. Card lifecycle state machine

States: `issued`, `active`, `suspended`, `revoked`, `expired`, `replaced`. Terminal: `revoked`, `replaced`.

| From → To | Trigger | Who | Notes |
|---|---|---|---|
| (none) → issued | issue | Owner, Admin | SC + enrollment token shown once |
| issued → active | first strong factor enrolled | cardholder | |
| issued → revoked | cancel | Owner, Admin | |
| issued → expired | clock | system | never activated in time |
| active → suspended | suspend | Owner, Admin | sessions revoked |
| suspended → active | reinstate | Owner, Admin | |
| active → revoked | revoke | Owner, Admin | sessions revoked; terminal |
| suspended → revoked | revoke | Owner, Admin | terminal |
| active → expired | clock (`expires_at` passed) | system | |
| expired → active | renew | Owner, Admin | new SC, new dates |
| expired → revoked | revoke | Owner, Admin | e.g. offboarding someone whose card has already expired |
| active → active | renew (not a state change) | Owner, Admin | new SC, new dates |
| active / expired → replaced | replace | Owner, Admin | new card number + new SC issued; old card terminal; `replaced_by_card_id` set |

**Everything not in this table is illegal** — for example `revoked → active`, `replaced → anything`, `issued → suspended`, `expired → suspended`, `suspended → expired`, `suspended → replaced`. *(12 legal transitions. Changed from the approved table: `suspended → expired` was removed — a suspended card stays suspended, the stricter state, so expiry can never turn a suspension into read-only grace access; `suspended → replaced` was removed after the independent review, because replacing a suspended card would hand out a new, active card and so undo the suspension; `expired → revoked` was added.)*

**The company card** is not a login and is protected separately: nobody can suspend, revoke, replace or restrict it (that would switch the whole tenant off, or — if it were revoked — remove the tenant's expiry clock). Only a Company Owner can renew it. A customer tenant with no live company card is treated as lapsed.

**No peer takeover.** Renew, unlock, replace and "issue enrollment token" all hand the person doing them a way into the target card (a new SC, a new token, a new card). So the actor must rank strictly above the target: an Admin cannot do them to another Admin or to itself. Company Owners, as the top rank, can do them to each other. Whenever a sign-in factor is added to a card by token, the cardholder is notified and the card's sessions end. Illegal transitions are rejected by the state machine in code *and* by a database trigger.

**Effective state.** `expired` is decided by the clock, not by whether a background job has run: `effectiveState(card, now)` returns `expired` as soon as `now ≥ expires_at` (for a card that is `issued` or `active`). A sweeper job later writes the state and the `expired` event for the record, but enforcement never waits for it.

**Expiry and grace are enforced in exactly one place — the policy decision point** (`04`):
- `now < expires_at` → normal.
- `expires_at ≤ now < grace_until` → **read-only**: reads allowed, writes denied (`DENY_GRACE_READ_ONLY`), except data export.
- `now ≥ grace_until` → everything denied, except that a Company Owner may still sign in to **export data** ("export is always free") — nothing else.

**Renewal with SC rotation** ("feature 34" in the Phase 1 prompt; part of feature 1 in the feature list). In one transaction: retire the current `card_secrets` row (hash set to NULL — the old SC is dead immediately), store the new hash, move `expires_at` / `grace_until` / `renewal_due` forward, revoke the card's sessions, write the event and audit row. The new SC is in the response once.

**Rules that protect the tenant from itself:** nobody can suspend, revoke or change roles on their own card; the last active Company Owner card cannot be suspended, revoked or have the owner role removed.

**Tested by** (`test/unit/lifecycle.test.ts`): a table of **all 36 from/to pairs** (12 legal, 24 illegal) — each asserted legal or illegal; (`test/integration/lifecycle.test.ts`): the database trigger rejects an illegal transition even when the code is bypassed; renewal kills the old SC and sessions; grace is read-only; last-owner protection.

---

## 8. Tenant isolation in the database

- Every tenant-scoped table has row-level security **enabled and forced** (forced = even the table owner is filtered).
- The policy compares each row's `tenant_id` with a per-transaction setting. If the setting is absent, the comparison is against NULL and **no rows match** — fail closed.
- The tenant is set with `SELECT set_config('app.tenant_id', $1, true)` at the start of each transaction. This is the parameter-safe form of `SET LOCAL` (which cannot take a bound parameter): identical effect, reset automatically at commit or rollback, and safe with Neon's transaction-mode connection pooling (verified, see `DEPENDENCIES.md`).
- The API connects as `legacyai_app`: not a superuser, no `BYPASSRLS`, cannot create roles or databases, with per-table grants. Migrations run as `legacyai_migrator`. **The API checks its own role at start-up and refuses to run** if it is a superuser or can bypass RLS — so a misconfigured connection string fails loudly instead of silently disabling isolation.
- Composite foreign keys `(tenant_id, id)` stop a row in one tenant referencing a row in another.
- The few cross-tenant operations (resolve a card number at login, list tenants for the platform operator) are `SECURITY DEFINER` functions with a pinned `search_path`, each doing one narrow thing, each audited.

**Honest limit:** RLS protects against *bugs in our code* (a forgotten filter, an injection that reads the wrong rows). It does **not** protect against an attacker who fully controls the API process, because that process is allowed to choose which tenant it is working for. Defence against that is BYOK / per-tenant keys (feature 21, later).

**Tested by** (`test/integration/rls.test.ts`), connected as the real app role: with tenant A set — SELECT of tenant B rows returns nothing; INSERT with tenant B's id fails; UPDATE/DELETE of B's rows affects 0 rows; a foreign key pointing into B fails; with **no** tenant set every table returns 0 rows; the catalogue test fails if any `tenant_id` table lacks forced RLS; the app role really has `rolsuper = false` and `rolbypassrls = false`; the API refuses to start when given a superuser connection.

---

## 9. Audit log

- **Append-only, two independent locks:** (1) grants — the app role has INSERT and SELECT only; (2) a trigger that raises an error on UPDATE, DELETE or TRUNCATE for any role.
- **Hash chain per tenant.** A `BEFORE INSERT` trigger assigns the next sequence number and computes
  `row_hash = SHA-256(prev_hash ‖ length-prefixed fields in fixed order)`.
  The trigger locks the tenant's head row, so two simultaneous inserts cannot fork the chain. The app cannot supply its own hashes.
- **Verifier.** `npm run audit:verify -- --tenant <id|all>` re-computes every hash **independently in TypeScript** (not by calling the same database function) and reports the first row whose stored hash, previous-hash link or sequence number is wrong. Also exposed as `POST /v1/audit/verify`.
- **External anchor.** `npm run audit:anchor` writes each tenant's latest `(seq, row_hash, time)` to a Cloud Storage bucket that has a retention policy (objects cannot be changed or deleted until the period ends). The verifier can compare the database against the anchors. Without an anchor, someone with full database control could rewrite the whole chain consistently; with it, they would also have to defeat the bucket. Locking the bucket's policy permanently is the founder's choice (`08`).
- **What is logged:** who (card id — never a name or email), what action, which resource, decision, reason code, request id, IP, time.
- **What is never logged:** SC, session tokens, CSRF tokens, enrollment tokens, TOTP codes or seeds, passkey assertions, peppers, connection strings, full card numbers of *unknown* cards, names, emails. `details` accepts only whitelisted keys.
- **Every policy decision, allow and deny, is written.**

**This is tamper-evident, not tamper-proof.** A database superuser can disable the trigger and edit or delete rows. What we provide is *detection*: an edit breaks the chain; a truncation or full rewrite disagrees with the external anchor. Detection is only as fresh as the last anchor.

**Tested by** (`test/integration/audit.test.ts`): UPDATE and DELETE as the app role fail (grant); as the owner fail (trigger); TRUNCATE fails; chain verifies after 1,000 concurrent inserts; **as superuser, disable the trigger and change one row → verifier names exactly that row**; delete the last row → mismatch with the anchor is reported; two tenants' chains are independent. `test/security/no-secrets.test.ts`: plant known secret values, drive the whole API, assert none appears in any log line, audit row or response body.

---

## 10. Secrets and configuration

- All secrets come from environment variables, which Cloud Run fills from Secret Manager. Nothing secret is in the repo; `.env.example` holds obviously fake values.
- The config loader validates everything at start-up against a schema. **Missing, empty, too-short or wrong-type secret → the process exits with a non-zero code before listening.** Test fixtures cover: missing, empty string, whitespace, too short, wrong type, unknown pepper id.
- Config values are wrapped in a `Secret` type whose string/JSON conversion prints `[redacted]`, so an accidental `console.log(config)` leaks nothing.
- Logger redaction: a path list (`sc`, `password`, `token`, `cookie`, `authorization`, `set-cookie`, `secret`, `pepper`, `assertion`, `code`, `email`, `display_name`, …) plus a pattern scrub for 16-digit numbers. Error responses never include stack traces or internal messages.

Secrets needed (6 — exactly the Secret Manager free allowance):
`DATABASE_URL` (app role), `DATABASE_URL_ADMIN` (migrations/backup; **not** mounted into the API service), `SC_PEPPER_KEYRING`, `CREDENTIAL_ENC_KEYRING` (encrypts TOTP seeds), `HMAC_INDEX_KEY` (hashes IPs / card numbers for rate-limit keys and the attempts log), `INTERNAL_SERVICE_TOKEN`.

**Tested by** (`test/unit/config.test.ts`, `test/security/no-secrets.test.ts`).

---

## 11. Input handling

| Control | How |
|---|---|
| Schema validation on every endpoint | Request bodies, query strings and path parameters are validated against `openapi.yaml` by Ajv before the handler runs. Unknown properties are rejected. A test fails if any operation lacks a schema. |
| SQL | Parameterised queries only. A lint rule bans string concatenation and template interpolation into SQL; dynamic identifiers come only from fixed allow-lists. |
| CORS | Allow-list from config (default: none). Credentials allowed only for listed origins. No wildcards. |
| Security headers | `@fastify/helmet`: HSTS, `X-Content-Type-Options: nosniff`, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, a restrictive CSP for an API, `Cache-Control: no-store` on all authenticated responses. |
| Size limits | 64 KiB default body limit; smaller on auth routes. Request timeout. |
| Errors | One format everywhere: RFC 9457 `application/problem+json` with `type`, `title`, `status`, `request_id`. No internal detail. |

## 12. Idempotency keys

State-changing admin endpoints (issue, suspend, reinstate, revoke, replace, renew, unlock, role changes, tenant create) **require** an `Idempotency-Key` header.

- First request: a row is reserved (`in_progress`), the work runs, the response is stored — all in the same transaction as the change.
- Same key + same request again: the stored response is replayed; nothing happens twice.
- Same key + **different** request: `409` problem.
- Keys are scoped to tenant + acting card and expire after 24 hours.
- **One-time secrets are never stored for replay.** If the original response contained an SC or enrollment token, the replay returns the same resource with the secret fields omitted and `secret_already_shown: true`. If the admin never saw the first response (network failure), the safe fix is to renew again. We accept that small inconvenience rather than store a readable SC.

**Tested by** (`test/integration/idempotency.test.ts`): replay returns the same body and creates no second card; concurrent duplicates create exactly one; different body → 409; replay of an issue response contains no SC; missing key → 400.

---

## 13. Service-to-service (the internal policy endpoint)

`POST /v1/internal/policy/check` is for the AI service (Phase 2). Phase 1: it requires a bearer token equal to `INTERNAL_SERVICE_TOKEN` (constant-time comparison; fail closed if unset) and is additionally restricted at the Cloud Run level. Phase 2 should upgrade this to Google-signed identity tokens between services. The endpoint returns only the decision and obligations.

---

## Threat model

Likelihood / impact: L = low, M = medium, H = high. "Tested by" names the planned test; a threat with no automated test says so.

| # | Threat | Likelihood | Impact | Mitigation | Tested by |
|---|---|---|---|---|---|
| T1 | Attacker logs in with card number + SC only | H (will be tried) | H | §1: session creation requires a strong-factor proof by construction | `security/card-sc-alone` |
| T2 | Brute-force the 1,000 SCs online | H | M | SC only counted after strong factor; 3–5 attempt lock | `integration/lockout` |
| T3 | Stolen database → offline SC cracking | M | H | Pepper outside the database + Argon2id | `unit/secret-code` (pepper needed to verify). **Not testable:** secrecy of the real pepper |
| T4 | Stolen database **and** pepper | L | H | None for the SC (inherent in 3 digits). Strong factor still required: passkey public keys are useless to an attacker; TOTP seeds are encrypted with a separate key | Documented limit |
| T5 | Lock a victim out by guessing | H | M | Strong-factor-first ordering; TOTP pause is temporary; passkeys immune | `integration/lockout` |
| T6 | Discover which card numbers exist | M | L–M | Uniform responses, dummy work, no direct access to `card_directory` | `security/enumeration` |
| T7 | Timing side channel on login | L | L | One hash + one factor check on every path | `security/enumeration` (coarse only). Fine-grained timing: **not tested** |
| T8 | Tenant A reads or writes tenant B's data through a code bug or injection | M | H | Forced RLS, non-bypass app role, composite foreign keys | `integration/rls` |
| T9 | App accidentally runs as a superuser / RLS-bypassing role | M (Neon's default role bypasses RLS) | H | Start-up self-check refuses to run | `integration/rls` (startup case) |
| T10 | SQL injection | M | H | Parameterised SQL only; lint rule; schema validation | lint + `security/injection` |
| T11 | Session theft / fixation | M | H | HttpOnly, Secure, SameSite=Strict, hashed at rest, rotation, timeouts | `integration/sessions` |
| T12 | Cross-site request forgery | M | M | SameSite=Strict + Origin check + CSRF token | `integration/sessions` |
| T13 | Suspended / revoked / expired card keeps working | M | H | Per-request state check + explicit revocation | `integration/sessions` |
| T14 | Insider edits or deletes audit rows | L | H | Grants + trigger; hash chain; external anchor. **Tamper-evident only** | `integration/audit` |
| T15 | Whole audit chain rewritten by a database superuser | L | H | External anchor comparison; detection limited to anchor frequency | `integration/audit` (anchor mismatch) |
| T16 | Secret leaks through logs or error messages | M | H | Redaction, `Secret` wrapper, generic errors | `security/no-secrets` |
| T17 | Service starts with missing or weak configuration | M | H | Fail-closed loader | `unit/config` |
| T18 | Privilege escalation (Admin makes self Owner; handler forgets a check) | M | H | Central policy point, deny by default, rank rule, no self-service role change, route-coverage test | `unit/policy`, `security/route-policy-coverage` |
| T19 | Double execution of issue / renew (retry, double click) | M | M | Idempotency keys | `integration/idempotency` |
| T20 | Login flood runs up CPU cost or exhausts memory (Argon2) | M | M ($) | IP + global limits before hashing; hash concurrency cap; max-instances cap | `security/rate-limit` |
| T21 | Stolen or lost passkey device / authenticator | M | H | SC is the second factor (0.5% guess chance before lock); admin can revoke credentials and replace the card | `integration/lockout`, lifecycle tests |
| T22 | Malicious or careless administrator | L | H | Everything audited; no self-service privilege change; last-owner protection. **No technical control stops a legitimate Owner misusing their rights** | Partly (`unit/policy`) |
| T23 | Vulnerable or malicious dependency | M | H | Pinned lockfile, `npm audit` / `pip-audit` in CI, few dependencies, maturity rule | CI job. **Does not catch unknown (zero-day) flaws** |
| T24 | Backup stolen | L | H | Backups encrypted with a public key before upload; private key offline | `scripts/restore-test.sh` (proves decrypt + restore) |
| T25 | Phishing a user's TOTP code + SC in real time | M | H | Passkeys are phishing-resistant; TOTP is not. Recommend passkey default | **Not mitigated for TOTP.** Documented |

## What this design does not cover (to keep visible)

No penetration test, no load test, no formal timing analysis, no legal review of consent for employee data, no SOC 2 / ISO 27001 controls mapping, no DDoS protection beyond rate limits and the instance cap, no protection against a fully compromised API process. These are carried into the Step 7 report under "Risks and gaps".
