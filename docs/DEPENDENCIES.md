# Dependencies — what we chose, and the evidence

**Checked on:** 2026-10-02. Every version below was read from the package registry or the vendor's own page on that date, then cross-checked with a second source. Nothing here is from memory.

## How to read this file

- **MEASURED** = I ran a command against the official registry (`npm view`, `pip index versions`, GitHub releases API, Docker Hub API) and read the answer.
- **QUOTED** = read from the vendor's own web page.
- **REPORTED** = a third-party page said so; treat with care.
- **ASSUMPTION** = not verified. Listed again in section 6.

## The maturity rule (one rule, applied everywhere)

> Use the newest major version that has been public for **at least 60 days** and that every other tool we depend on supports. Otherwise use the latest patch of the previous major.

Reason: brand-new major versions are where breaking bugs and half-updated plugins live. A solo founder cannot afford to debug an ecosystem. This rule is why several picks below are *not* the newest number.

---

## 1. Runtime and language

| Item | Chosen | Newest available | Evidence | Why this one |
|---|---|---|---|---|
| Node.js | **24 LTS** (image `node:24.21.0-trixie-slim`) | 26.10.0 (2026-09-21) | MEASURED: nodejs.org `dist/index.json`, Docker Hub tags. REPORTED: Node 24 Active LTS since 2025-10-28, maintenance from 2026-10-20, end of life 2028-04-30; Node 26 becomes LTS 2026-10-28 ([nodejs.org release schedule post](https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule), [endoflife.ai](https://endoflife.ai/article-nodejs-eol)) | 24 is the LTS line today and is what is installed on the founder's machine (v24.14.1). 26 is not LTS until 2026-10-28. Move to 26 in a later phase. |
| TypeScript | **6.0.3** (2026-04-16) | 7.0.2 (2026-07-08) | MEASURED: `npm view typescript`, `npm view typescript-eslint peerDependencies` → `typescript: ">=4.8.4 <6.1.0"` | TypeScript 7 passes the 60-day rule but the linter (`typescript-eslint` 8.71.0) does not support it yet. Linting is one of our safety nets, so we stay on 6.0.3. |
| Package manager | **npm 11** (ships with Node) | — | MEASURED: `npm --version` → 11.16.0 | Boring, no extra install, lockfile committed. |
| Python (AI stub) | **3.12** (image `python:3.12-slim`) | 3.14.7 | MEASURED: Docker Hub tags; local `python --version` → 3.12.10 | Matches the founder's machine so the stub runs locally without Docker. Revisit when Phase 2 starts. |
| PostgreSQL | **18** (local image `pgvector/pgvector:0.8.6-pg18`) | 18.6; 19 is beta | MEASURED: Docker Hub tags. REPORTED: Neon supports 14–18 ([Neon compatibility docs](https://neon.com/docs/reference/compatibility)) | 18 has been out about a year, has built-in `uuidv7()` (time-ordered IDs), and Neon supports it. |
| pgvector | 0.8.6 (available, **not used in Phase 1**) | 0.8.6 | MEASURED: GitHub tags, Docker Hub | Only "available" as the prompt requires. Neon may ship one version behind (REPORTED). |

## 2. API service (`services/api`)

| Item | Chosen | Newest | Evidence | Why |
|---|---|---|---|---|
| Web framework | **Fastify 5.12.5** (2026-09-16) | 6.0.0-alpha.4 | MEASURED: `npm view fastify`. QUOTED: [Fastify LTS page](https://fastify.dev/docs/latest/Reference/LTS/) — v5 released 2024-09-17, end-of-LTS "TBD"; each major gets security fixes for 6 months after the next major ships | See "Framework decision" below. |
| NestJS (rejected) | — | 12.1.2; 11.2.7 on the `legacy` tag | MEASURED: `npm view @nestjs/core dist-tags`, 12.0.0 published 2026-08-27. REPORTED: v12 announced 2026-08-28 ([Trilon blog](https://trilon.io/blog/nestjs-12-is-now-available)) | See below. |
| Fastify plugins | `@fastify/cookie` 11.1.2, `@fastify/helmet` 13.1.1, `@fastify/cors` 11.3.0 | same | MEASURED | Official Fastify-org plugins for cookies, security headers, CORS. |
| PostgreSQL driver | **pg 8.23.1** | same | MEASURED | The standard driver. No ORM: row-level security, grants and triggers need explicit SQL we can read. |
| Argon2id | **argon2 0.45.1** (node-argon2) | 1.0.0-alpha.1 | MEASURED: 2.79M downloads/week; wraps the reference C implementation | Most-used Argon2 binding. Alternative `@node-rs/argon2` 2.2.1 (1.66M/week) is the fallback if native builds fail in the container. |
| HMAC, AES-GCM, random | **Node built-in `node:crypto`** | — | Ships with Node (OpenSSL) | No third-party code for primitives. |
| WebAuthn / passkeys | **@simplewebauthn/server 13.3.3** (2026-08-26) | 14.0.3 (14.0.0 published 2026-09-02) | MEASURED: 5.9M downloads/week | v14 is 30 days old → maturity rule → 13.3.3. Upgrade after 2026-11-01 if no regressions are reported. |
| TOTP | **otplib 13.5.0** (2026-08-21) | same | MEASURED: 4.1M downloads/week; v13.0.0 published 2026-01-10 | Most-used TOTP library. Alternative `otpauth` 9.5.2 (3.2M/week). |
| Request/response validation | **ajv 8.20.0** + `ajv-formats` 3.0.1, driven directly by `openapi.yaml` | same | MEASURED | The OpenAPI file *is* the validation schema, so code cannot drift from the contract. |
| OpenAPI tooling | `openapi-typescript` 7.13.0 (types), `@redocly/cli` 2.57.0 (lint), `yaml` 2.9.1, `@apidevtools/swagger-parser` 13.1.0 | same | MEASURED | Generate TypeScript types from the contract; CI fails if they are out of date. |
| Logging | **pino 10.3.1** | same | MEASURED (10.0.0 published 2025-10-03) | Fastify's built-in logger; structured JSON; built-in redaction paths. |
| Tracing hooks | **@opentelemetry/api 1.9.1** always; `@opentelemetry/sdk-node` 0.222.0 + `@fastify/otel` 0.21.0 loaded only when an exporter endpoint is configured | same | MEASURED | The API package is stable (1.x). The SDK is still 0.x, so it stays optional and off by default. |

### Framework decision: Fastify 5, not NestJS

Plain language: NestJS just had a big rewrite five weeks ago. Fastify has been stable for two years and does less magic. For a security-critical service written by an AI and owned by a non-coder, less magic is safer.

- NestJS 12.0.0 was published 2026-08-27 (MEASURED). It is centred on a move to ESM packages and a rebuilt CLI (REPORTED, Trilon blog). That fails the 60-day rule.
- **I could not find any official NestJS statement of which line is "Active LTS".** The docs page `docs.nestjs.com/support` is about sponsorship, not version support (QUOTED: fetched 2026-10-02). The prompt's "UNCONFIRMED" stays unconfirmed. npm labels 11.x as `legacy`.
- Fastify publishes a written LTS policy (QUOTED above), has a first-party JSON-schema validation pipeline that fits "OpenAPI is the source of truth", and NestJS itself can run on top of Fastify — so a later move to NestJS would not throw away the HTTP layer.
- Cost of this choice: no built-in dependency-injection or module system. We enforce module boundaries ourselves with `dependency-cruiser` (a CI check), which the prompt requires anyway.
- Known risk: Fastify 6 is in alpha. When it ships, v5 gets 6 more months of security fixes. Budget one upgrade in 2027.

## 3. Database tooling

| Item | Chosen | Evidence | Why |
|---|---|---|---|
| Migrations | **dbmate 2.36.0** (2026-09-19) | MEASURED: GitHub releases API + `npm view dbmate` | Plain `.sql` files with an "up" and a "down" section, one small binary, works the same for the TypeScript and the Python service. Rejected: `node-pg-migrate` 9.0.0 (JS-first, new major), `graphile-migrate` (no down migrations by design), Flyway/Atlas (heavier, paid tiers). |
| Local database | Docker image `pgvector/pgvector:0.8.6-pg18` via `docker compose` | MEASURED | `psql` is not installed on the founder's machine; Docker 29.7.2 is. |
| Backup encryption | **age 1.3.2** (2026-08-29) | MEASURED: GitHub releases API | Small, audited, public-key file encryption: the backup job holds only the *public* key, so a compromised job cannot read old backups. |

## 4. Quality and security tooling

| Item | Chosen | Newest | Evidence | Why |
|---|---|---|---|---|
| Test runner | **vitest 4.1.11** (2026-08-18) + `@vitest/coverage-v8` | 5.0.3 (5.0.0 published 2026-09-03) | MEASURED | v5 is 29 days old → maturity rule. |
| Lint | **eslint 10.11.0** + **typescript-eslint 8.71.0** | same | MEASURED | Standard. |
| Module boundaries | **dependency-cruiser 18.5.0** (18.0.0 published 2026-06-25) | same | MEASURED | Fails CI if one module imports another module's internals. |
| Secret scanning | **gitleaks 8.30.1** (2026-03-21) | same | MEASURED: GitHub releases API | Scans files and full git history. |
| Vulnerability audit | `npm audit` and `pip-audit` | — | `pip-audit` version: ASSUMPTION until Step 6 | Built in / PyPA-maintained. |

## 5. AI stub and infrastructure

| Item | Chosen | Newest | Evidence | Why |
|---|---|---|---|---|
| FastAPI | **0.142.2** | same | MEASURED: `pip index versions fastapi`. The Phase 0 figure (0.136.x) was stale. | Stub only. |
| Uvicorn | **0.54.0** | same | MEASURED | ASGI server for the stub. |
| Terraform CLI | **1.16.4** (2026-09-23) | same | MEASURED: GitHub releases API | Not installed locally; validated in CI/Docker only. Never applied by me. |
| Google provider | **7.46.1** (2026-09-04), pinned `~> 7.46` | 8.5.0 (8.0.0 published 2026-08-26) | MEASURED: GitHub releases API. Sources disagreed (a search summary said "8.4.0 latest"); the GitHub API is the more official source. | 8.0 is 37 days old → maturity rule. |

## 6. Platform facts re-verified (Phase 0 facts)

| Fact | Status on 2026-10-02 | Source |
|---|---|---|
| Neon Free: 100 projects, 100 CU-hours per project per month, 10 branches, scale-to-zero after 5 minutes (cannot be disabled), 5 GB egress | Confirmed (QUOTED) | [Neon plans](https://neon.com/docs/introduction/plans) |
| Neon Free storage per project | **Sources disagree: 0.5 GB** ([Neon FAQ](https://neon.com/faqs/free-plan-limits-and-quotas), several third parties) **vs 1 GB** (my automated read of the plans page). We design for **0.5 GB**. | as linked |
| Neon backups | 6-hour restore window capped at 1 GB of change history, 1 manual snapshot. **Not a backup strategy.** We build our own, as Phase 0 assumed. | [Neon plans](https://neon.com/docs/introduction/plans) |
| Neon commercial use on Free | REPORTED allowed by third parties; Neon's own page does not forbid it but says Free is "for prototypes" and should be avoided where uptime matters. **ASSUMPTION** until the founder reads Neon's terms. | [Neon plans](https://neon.com/docs/introduction/plans), [freetiers.com](https://www.freetiers.com/directory/neon) |
| Neon pooled connections use PgBouncer in transaction mode; session-level `SET` is unsupported, transaction-scoped settings work | Confirmed (QUOTED) — this is exactly why the design uses a per-transaction tenant setting | [Neon connection pooling](https://neon.com/docs/connect/connection-pooling) |
| Neon console-created roles inherit `neon_superuser`, which includes **BYPASSRLS**; roles created by SQL get only basic privileges | Confirmed (QUOTED). Consequence: the app must **never** connect with the console-created role. | [Neon roles](https://neon.com/docs/manage/roles) |
| Cloud Run request-based free tier: 180,000 vCPU-seconds, 360,000 GiB-seconds, 2M requests per month; 1 GB egress from North America | Confirmed (QUOTED) | [Google Cloud free features](https://docs.cloud.google.com/free/docs/free-cloud-features) |
| Other Google free allowances: Cloud Storage 5 GB-months (us-east1 / us-west1 / us-central1 only), Secret Manager 6 active secret versions + 10,000 accesses, Artifact Registry 0.5 GB, Cloud Logging 50 GiB | Confirmed (QUOTED) | same page |
| Cloud Scheduler: 3 free jobs per billing account, then $0.10 per job per month | Confirmed (QUOTED via search of Google's pricing page) | [Cloud Scheduler pricing](https://cloud.google.com/scheduler/pricing) |
| Cloud Storage retention policy can be **locked** (irreversible) via Terraform `retention_policy { is_locked }` | Confirmed (QUOTED) | [Bucket Lock docs](https://docs.cloud.google.com/storage/docs/bucket-lock) |
| OWASP Argon2id minimum: 19 MiB memory, 2 iterations, parallelism 1 (equivalents: 46 MiB/1, 12 MiB/3, …) | Confirmed (QUOTED) | [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) |
| Check digits: Luhn misses the `09`↔`90` swap; Damm and Verhoeff catch all single-digit errors and all adjacent swaps | Confirmed (REPORTED, Wikipedia; will be **proven by an exhaustive test** in Step 5) | [Damm algorithm](https://en.wikipedia.org/wiki/Damm_algorithm), [Luhn algorithm](https://en.wikipedia.org/wiki/Luhn_algorithm) |

## 7. Assumptions still open

1. Neon Free permits commercial use (third-party reports only).
2. Neon Free storage is 0.5 GB, not 1 GB (we plan for the smaller number).
3. Neon's installed pgvector version (not needed in Phase 1).
4. NestJS has no published LTS policy (absence of evidence, not proof).
5. `pip-audit` version, GitHub Action versions, and exact Docker base-image digests — to be pinned and recorded here in Steps 4–6.
6. Node 24 / Python 3.12 end-of-life dates are from third-party trackers.

This file is updated whenever a dependency is added or bumped. A CI check (Step 6) fails if `package.json` contains a dependency not listed here.
