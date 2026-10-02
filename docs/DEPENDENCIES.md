# Dependencies — what we chose, and the evidence

**Checked on:** 2026-10-02. Every version below was read from the package registry or the vendor's own page on that date, then cross-checked with a second source. Nothing here is from memory.

A CI check (`scripts/check-dependencies-doc.mjs`) fails if `services/api/package.json` or `services/ai/requirements*.txt` contains a dependency — or a version — that is not written in this file.

## How to read this file

- **MEASURED** = I ran a command against the official registry (`npm view`, `pip index versions`, GitHub releases API, Docker Hub API) and read the answer.
- **QUOTED** = read from the vendor's own web page.
- **REPORTED** = a third-party page said so; treat with care.
- **ASSUMPTION** = not verified. Listed again in section 7.

## The maturity rule (one rule, applied everywhere)

> Use the newest major version that has been public for **at least 60 days** and that every other tool we depend on supports. Otherwise use the latest patch of the previous major.

Reason: brand-new major versions are where breaking bugs and half-updated plugins live. A solo founder cannot afford to debug an ecosystem. This rule is why several picks below are *not* the newest number.

---

## 1. Runtime and language

| Item | Chosen | Newest available | Evidence | Why this one |
|---|---|---|---|---|
| Node.js | **24 LTS** (image `node:24.21.0-trixie-slim`) | 26.10.0 (2026-09-21) | MEASURED: nodejs.org `dist/index.json`, Docker Hub tags. REPORTED: Node 24 Active LTS since 2025-10-28, maintenance from 2026-10-20, end of life 2028-04-30; Node 26 becomes LTS 2026-10-28 ([nodejs.org release schedule post](https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule), [endoflife.ai](https://endoflife.ai/article-nodejs-eol)) | 24 is the LTS line today and is what is installed on the founder's machine (v24.14.1). Move to 26 in a later phase. |
| TypeScript | **6.0.3** (2026-04-16) | 7.0.2 (2026-07-08) | MEASURED: `npm view typescript`; `npm view typescript-eslint peerDependencies` → `typescript: ">=4.8.4 <6.1.0"` | TypeScript 7 passes the 60-day rule but the linter does not support it yet. Linting is one of our safety nets, so we stay on 6.0.3. |
| Package manager | **npm 11** (ships with Node) | — | MEASURED: `npm --version` → 11.16.0 | Boring, no extra install, lockfile committed. |
| Python (AI stub) | **3.12** (image `python:3.12-slim`) | 3.14.7 | MEASURED: Docker Hub tags; local `python --version` → 3.12.10 | Matches the founder's machine so the stub runs locally without Docker. Revisit when Phase 2 starts. |
| PostgreSQL | **18** (local/CI image `pgvector/pgvector:0.8.6-pg18`) | 18.6; 19 is beta | MEASURED: Docker Hub tags. REPORTED: Neon supports 14–18 ([Neon compatibility docs](https://neon.com/docs/reference/compatibility)) | Out about a year, has built-in `uuidv7()`, and Neon supports it. **No extensions are required by the schema.** |
| pgvector | 0.8.6 (available in the image, **not used in Phase 1**) | 0.8.6 | MEASURED: GitHub tags, Docker Hub | Only "available", as the prompt requires. |

## 2. API service (`services/api`) — runtime dependencies (13)

| Package | Version | Evidence | Why |
|---|---|---|---|
| fastify | **5.12.5** (2026-09-16) | MEASURED: `npm view`. QUOTED: [Fastify LTS page](https://fastify.dev/docs/latest/Reference/LTS/) — v5 released 2024-09-17; each major gets security fixes for 6 months after the next major ships | See "Framework decision" below. |
| @fastify/cookie | **11.1.2** | MEASURED | Official Fastify plugin: cookies. |
| @fastify/helmet | **13.1.1** | MEASURED | Official Fastify plugin: security headers. |
| @fastify/cors | **11.3.0** | MEASURED | Official Fastify plugin: strict CORS allow-list. |
| pg | **8.23.1** | MEASURED | The standard PostgreSQL driver. No ORM: row-level security, grants and triggers need explicit SQL we can read. |
| argon2 | **0.45.1** (node-argon2) | MEASURED: 2.79M downloads/week; wraps the reference C implementation. Local benchmark at the OWASP minimum: 64 ms per hash. | Most-used Argon2 binding. Fallback if native builds fail: `@node-rs/argon2`. |
| @simplewebauthn/server | **13.3.3** (2026-08-26) | MEASURED: 5.9M downloads/week; 14.0.0 was published 2026-09-02 | v14 is 30 days old → maturity rule. |
| otplib | **13.5.0** (2026-08-21) | MEASURED: 4.1M downloads/week; 13.0.0 published 2026-01-10 | TOTP, including built-in replay protection (`afterTimeStep`). |
| ajv | **8.20.0** | MEASURED | Validates requests (and, in tests, responses) directly against `openapi.yaml`. |
| ajv-formats | **3.0.1** | MEASURED | `uuid`, `date-time`, `email` formats for Ajv. |
| yaml | **2.9.1** | MEASURED | Reads `openapi.yaml`. |
| pino | **10.3.1** | MEASURED (10.0.0 published 2025-10-03) | Fastify's logger; structured JSON. |
| @opentelemetry/api | **1.9.1** | MEASURED | Tracing hooks. The API package is stable (1.x) and does nothing until an SDK is registered. No SDK is installed in Phase 1 (the SDK packages are still 0.x). |

`node:crypto` (built in) provides HMAC, SHA-256, AES-256-GCM, random numbers and constant-time comparison. No third-party code implements a cryptographic primitive, and we implement none ourselves.

### Development dependencies (11)

| Package | Version | Evidence | Why |
|---|---|---|---|
| typescript | **6.0.3** | see section 1 | |
| vitest | **4.1.11** (2026-08-18) | MEASURED; 5.0.0 was published 2026-09-03 | v5 is 29 days old → maturity rule. |
| @vitest/coverage-v8 | **4.1.11** | MEASURED | Coverage for vitest. |
| eslint | **10.11.0** | MEASURED | Lint, including three security rules (parameterised SQL only, no `Math.random`, routes only via `defineRoutes`). |
| typescript-eslint | **8.71.0** | MEASURED | TypeScript support for ESLint. |
| dependency-cruiser | **18.5.0** (18.0.0 published 2026-06-25) | MEASURED | Fails the build if one module imports another module's internals. |
| dbmate | **2.36.0** (2026-09-19) | MEASURED: GitHub releases API + `npm view` | Migrations. See section 3. |
| @redocly/cli | **2.57.0** | MEASURED | Lints `openapi.yaml`. |
| @levischuck/tiny-cbor | **0.3.6** | MEASURED (`npm view`); it is the CBOR library `@simplewebauthn/server` itself depends on | Tests only: lets the software passkey in the test suite build real WebAuthn responses. |
| @types/node | **24.19.0** | MEASURED | Types. |
| @types/pg | **8.23.1** | MEASURED | Types. |

**Dropped after Gate 1:** `openapi-typescript` 7.13.0 (requires TypeScript 5; conflicts with 6.0.3). Its job — keeping code and contract in sync — is done more strongly at run time: the server takes its routes and validation from `openapi.yaml` and tests fail on any difference. `@apidevtools/swagger-parser` and `tsx` were not needed (Node 24 runs TypeScript directly).

### Framework decision: Fastify 5, not NestJS

Plain language: NestJS just had a big rewrite five weeks ago. Fastify has been stable for two years and does less magic. For a security-critical service written by an AI and owned by a non-coder, less magic is safer.

- NestJS 12.0.0 was published 2026-08-27 (MEASURED: `npm view @nestjs/core time`). It is centred on a move to ESM packages and a rebuilt CLI (REPORTED, [Trilon blog](https://trilon.io/blog/nestjs-12-is-now-available)). That fails the 60-day rule.
- **I could not find any official NestJS statement of which line is "Active LTS".** `docs.nestjs.com/support` is about sponsorship, not version support (QUOTED: fetched 2026-10-02). The prompt's "UNCONFIRMED" stays unconfirmed. npm labels 11.x (11.2.7) as `legacy`.
- Fastify publishes a written LTS policy, and NestJS itself can run on top of Fastify — so a later move to NestJS would not throw away the HTTP layer.
- Cost of this choice: no built-in module system. We enforce module boundaries ourselves with `dependency-cruiser`.
- Known risk: Fastify 6 is in alpha (6.0.0-alpha.4). When it ships, v5 gets 6 more months of security fixes. One option we use (`disableRequestLogging`) is marked for removal in v6. Budget one upgrade in 2027.

## 3. Database tooling

| Item | Chosen | Evidence | Why |
|---|---|---|---|
| Migrations | **dbmate 2.36.0** file format; run by dbmate where its binary can execute, otherwise by a built-in runner in `scripts/db-setup.mjs` | MEASURED | Plain `.sql` files with "up" and "down" sections. Rejected: `node-pg-migrate` 9.0.0 (JS-first, new major), `graphile-migrate` (no down migrations), Flyway/Atlas (heavier). **Found during the build:** Windows on the founder's machine began refusing to execute the downloaded `dbmate.exe` (EPERM) part-way through. Rather than work around the operating system's protection, a ~60-line runner applies the same files with the same bookkeeping table. CI runs both and compares the resulting schemas. |
| Local / CI database | `pgvector/pgvector:0.8.6-pg18` via `docker compose` | MEASURED | `psql` is not installed on the founder's machine; Docker 29.7.2 is. |
| Backup encryption | **age** (from Alpine 3.24's package repository) | MEASURED: upstream latest is 1.3.2 (2026-08-29, GitHub releases API). The exact Alpine package version is printed by the image build; ASSUMPTION until read from CI. | Small, audited, public-key file encryption: the backup job holds only the *public* key. |
| Backup tools image | `alpine:3.24` + `postgresql18-client` + `age` + `curl` | MEASURED: Docker Hub tags | Small (no database server, no cloud SDK) so it fits the free registry allowance. |

## 4. CI and security tooling

| Item | Chosen | Evidence |
|---|---|---|
| gitleaks | **8.30.1** (2026-03-21), image `ghcr.io/gitleaks/gitleaks:v8.30.1` | MEASURED: GitHub releases API |
| actions/checkout | **v7.0.1** → commit `3d3c42e5aac5ba805825da76410c181273ba90b1` | MEASURED: GitHub API (release 2026-07-20; tag resolved to commit) |
| actions/setup-node | **v7.0.0** → `820762786026740c76f36085b0efc47a31fe5020` | MEASURED (2026-07-14) |
| actions/setup-python | **v7.0.0** → `5fda3b95a4ea91299a34e894583c3862153e4b97` | MEASURED (2026-07-20) |
| hashicorp/setup-terraform | **v4.0.1** → `dfe3c3f87815947d99a8997f908cb6525fc44e9e` | MEASURED (2026-05-12) |
| google-github-actions/auth | **v3** → `7c6bc770dae815cd3e89ee6cdf493a5fab2cc093` | MEASURED (deploy workflow only; disabled) |
| `npm audit` | ships with npm | Result on 2026-10-02: 0 vulnerabilities in runtime dependencies (MEASURED) |

Actions are pinned to full commit hashes, not tags, so a moved tag cannot change what CI runs.

## 5. AI stub (`services/ai`)

| Package | Version | Evidence |
|---|---|---|
| fastapi | **0.142.2** | MEASURED: `pip index versions fastapi`. The Phase 0 figure (0.136.x) was stale. |
| uvicorn | **0.54.0** | MEASURED |
| pytest (dev) | **9.1.1** | MEASURED |
| httpx (dev) | **0.28.1** | MEASURED — needed by FastAPI's test client |
| pip-audit (dev) | **2.10.1** | MEASURED. Result on 2026-10-02: "No known vulnerabilities found". |

## 6. Infrastructure

| Item | Chosen | Newest | Evidence | Why |
|---|---|---|---|---|
| Terraform CLI | **1.16.4** (2026-09-23) | same | MEASURED: GitHub releases API, Docker Hub | Not installed locally; `fmt` and `validate` were run in the official Docker image. Never applied by me. |
| Google provider | **7.46.1** (2026-09-04), pinned `~> 7.46` | 8.5.0 (8.0.0 published 2026-08-26) | MEASURED: GitHub releases API; `terraform init` installed exactly 7.46.1 "signed by HashiCorp". Sources disagreed (a search summary said "8.4.0 latest"); the GitHub API is the more official source. | 8.0 is 37 days old → maturity rule. |

## 7. Platform facts re-verified (Phase 0 facts)

| Fact | Status on 2026-10-02 | Source |
|---|---|---|
| Neon Free: 100 projects, 100 CU-hours per project per month, 10 branches, scale-to-zero after 5 minutes (cannot be disabled), 5 GB egress | Confirmed (QUOTED) | [Neon plans](https://neon.com/docs/introduction/plans) |
| Neon Free storage per project | **Sources disagree: 0.5 GB** ([Neon FAQ](https://neon.com/faqs/free-plan-limits-and-quotas), several third parties) **vs 1 GB** (my automated read of the plans page). We design for **0.5 GB**. | as linked |
| Neon backups | 6-hour restore window capped at 1 GB of change history, 1 manual snapshot. **Not a backup strategy.** We build our own. | [Neon plans](https://neon.com/docs/introduction/plans) |
| Neon commercial use on Free | REPORTED allowed by third parties; Neon's own page does not forbid it but says Free is "for prototypes". **ASSUMPTION** until the founder reads Neon's terms. | [Neon plans](https://neon.com/docs/introduction/plans), [freetiers.com](https://www.freetiers.com/directory/neon) |
| Neon pooled connections use PgBouncer in transaction mode; session-level `SET` is unsupported, transaction-scoped settings work | Confirmed (QUOTED) | [Neon connection pooling](https://neon.com/docs/connect/connection-pooling) |
| Neon console-created roles inherit `neon_superuser`, which includes **BYPASSRLS**; roles created by SQL get only basic privileges | Confirmed (QUOTED). Consequence: the app must **never** connect with the console-created role — and the API refuses to start if it does. | [Neon roles](https://neon.com/docs/manage/roles) |
| Cloud Run request-based free tier: 180,000 vCPU-seconds, 360,000 GiB-seconds, 2M requests per month | Confirmed (QUOTED) | [Google Cloud free features](https://docs.cloud.google.com/free/docs/free-cloud-features) |
| Other Google free allowances: Cloud Storage 5 GB-months (us-east1 / us-west1 / us-central1 only), Secret Manager 6 active secret versions + 10,000 accesses, Artifact Registry 0.5 GB, Cloud Logging 50 GiB | Confirmed (QUOTED) | same page |
| Cloud Scheduler: 3 free jobs per billing account, then $0.10 per job per month | Confirmed (QUOTED via search of Google's pricing page) | [Cloud Scheduler pricing](https://cloud.google.com/scheduler/pricing) |
| Cloud Storage retention policy can be **locked** (irreversible) via Terraform `retention_policy { is_locked }` | Confirmed (QUOTED); the attribute passed `terraform validate` | [Bucket Lock docs](https://docs.cloud.google.com/storage/docs/bucket-lock) |
| OWASP Argon2id minimum: 19 MiB memory, 2 iterations, parallelism 1 | Confirmed (QUOTED) | [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) |
| Check digits: Luhn misses the `09`↔`90` swap; Damm catches all single-digit errors and all adjacent swaps | REPORTED (Wikipedia) **and now proven by test** (`test/unit/card-number.test.ts`) | [Damm algorithm](https://en.wikipedia.org/wiki/Damm_algorithm) |

## 8. Assumptions still open

1. Neon Free permits commercial use (third-party reports only).
2. Neon Free storage is 0.5 GB, not 1 GB (we plan for the smaller number).
3. Whether a role created by SQL on Neon can be given `BYPASSRLS` (needed for the dedicated backup role). If not, backups use the Neon console role; `db/roles/create-roles.sql` stops loudly rather than create a backup role that silently skips rows.
4. NestJS has no published LTS policy (absence of evidence, not proof).
5. The exact `age` and `postgresql18-client` package versions inside Alpine 3.24 (printed at image build time; not pinned).
6. Node 24 / Python 3.12 end-of-life dates are from third-party trackers.
7. Docker base images are pinned by tag, not by digest.
