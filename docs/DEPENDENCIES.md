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
2. Neon Free storage: planned as 0.5 GB. Neon's own plans and pricing pages said **1 GB per project** when re-read on 2026-10-03 (§9.5); the design keeps budgeting for 0.5 GB.
3. Whether a role created by SQL on Neon can be given `BYPASSRLS` (needed for the dedicated backup role). If not, backups use the Neon console role; `db/roles/create-roles.sql` stops loudly rather than create a backup role that silently skips rows.
4. NestJS has no published LTS policy (absence of evidence, not proof).
5. The exact `age` and `postgresql18-client` package versions inside Alpine 3.24 (printed at image build time; not pinned).
6. Node 24 / Python 3.12 end-of-life dates are from third-party trackers.
7. Docker base images are pinned by tag, not by digest.

## 9. Phase 2 candidates (design stage — nothing below is installed yet)

Checked on **2026-10-03**. First check: a research pass that fetched each page listed. Second check (the "re-check once"): versions, dates and licences of every Python and npm package re-read directly from the PyPI / npm JSON APIs, and the pgvector tags from GitHub — all matched. **Prices, model facts and cloud facts were read once only**, from the providers' own pages; they are re-read at Gate 2 before any key is created. OpenAI and Gemini developer pages were read through a page summariser rather than as raw text. Anything marked **UNVERIFIED** was not confirmed.

Maturity rule (D2): a new major version must be at least 60 days old. 60 days before today = 2026-08-04.

### 9.1 Python libraries (planned pins)

| Purpose | Package and version | Released | Licence | Evidence | Notes |
|---|---|---|---|---|---|
| PDF text extraction | pypdf 6.19.0 | 2026-09-16 (6.x since 2025-08-11) | BSD-3-Clause | https://pypi.org/pypi/pypdf/json · limits: https://raw.githubusercontent.com/py-pdf/pypdf/main/pypdf/_configuration.py · advisories: https://api.osv.dev (PyPI/pypdf) | ~50 denial-of-service advisories in 12 months, all fixed by 6.19.0. Runs in a child process with a timeout. |
| File type sniffing | puremagic 2.2.0 | 2026-04-08 (2.x since 2026-02-20) | MIT | https://pypi.org/pypi/puremagic/json | no system library; needs Python ≥ 3.12 |
| PII detection | presidio-analyzer 2.2.364 | 2026-07-22 | MIT | https://pypi.org/pypi/presidio-analyzer/json · entities: https://raw.githubusercontent.com/microsoft/presidio/main/docs/supported_entities.md | no street-address recognizer; memory footprint **UNVERIFIED** |
| PII replacement | presidio-anonymizer 2.2.364 | 2026-07-22 | MIT | https://pypi.org/pypi/presidio-anonymizer/json | requires cryptography >=48.0.1,<49 |
| Language engine | spacy 3.8.16 | 2026-08-24 | MIT | https://pypi.org/pypi/spacy/json | |
| Language model | en_core_web_sm 3.8.0 (12.8 MB) | — | MIT | https://github.com/explosion/spacy-models/releases (compatibility.json) | the default large model is 400.7 MB — not used |
| PostgreSQL driver | psycopg 3.3.6 | 2026-09-18 | **LGPL-3.0-only** | https://pypi.org/pypi/psycopg/json | used unmodified |
| Connection pool | psycopg-pool 3.3.3 | 2026-09-22 | LGPL-3.0-only | https://pypi.org/pypi/psycopg-pool/json | |
| Vector type support | pgvector (Python) 0.5.0 | 2026-07-06 | MIT | https://pypi.org/pypi/pgvector/json | |
| Service tokens | PyJWT 2.15.1 | 2026-09-28 | MIT | https://pypi.org/pypi/PyJWT/json · https://api.osv.dev/v1/vulns/GHSA-gvp8-978c-rx2q | advisory batch 2026-09-29/30 fixed in 2.14.0–2.15.0; none listed against 2.15.1 |
| Local embeddings | fastembed 0.8.1 | 2026-09-22 | Apache-2.0 | https://pypi.org/pypi/fastembed/json · https://github.com/qdrant/fastembed | |
| Embedding runtime | onnxruntime 1.30.0 | 2026-09-10 | MIT | https://pypi.org/pypi/onnxruntime/json | |
| Embedding model | BAAI/bge-small-en-v1.5 (384 dimensions, 0.067 GB) | — | MIT | https://huggingface.co/BAAI/bge-small-en-v1.5 · https://qdrant.github.io/fastembed/examples/Supported_Models/ | English; RAM need **UNVERIFIED** (no first-party figure) |
| Validation | pydantic 2.13.5 | 2026-08-28 | MIT | https://pypi.org/pypi/pydantic/json | |
| Settings | pydantic-settings 2.15.0 | 2026-08-07 | MIT | https://pypi.org/pypi/pydantic-settings/json | CVE-2026-58203 fixed in 2.14.2 |
| Web framework (already used) | fastapi 0.142.2 · uvicorn 0.54.0 · starlette 1.7.0 | 2026-09-30 · 2026-09-25 · 2026-09-23 | MIT · BSD · BSD | PyPI JSON | starlette to be pinned explicitly (6 advisories fixed up to 1.3.1) |
| Lint | ruff 0.16.10 | 2026-10-01 | MIT | https://pypi.org/pypi/ruff/json | |
| Types | mypy 2.4.0 | 2026-10-01 (2.x since 2026-05-06) | MIT | https://pypi.org/pypi/mypy/json | |
| Tests | pytest 9.1.1 · pytest-asyncio 1.4.0 | 2026-06-19 · 2026-05-26 | MIT · Apache-2.0 | PyPI JSON | |
| Audit | pip-audit 2.10.1 | 2026-06-10 | Apache-2.0 | https://pypi.org/pypi/pip-audit/json | already used |

Rejected: pdfminer.six / pdfplumber (code-execution advisory CVE-2025-64512, no documented guards); PyMuPDF (AGPL); python-magic (needs system libmagic, no release since 2022); scrubadub (unmaintained since 2023); tiktoken (downloads files at run time, vendor-specific); procrastinate / pgqueuer (assume an always-running worker); LangChain / LlamaIndex (not needed); voyageai SDK (pulls langchain-text-splitters).

### 9.2 TypeScript

| Purpose | Package and version | Released | Licence | Evidence |
|---|---|---|---|---|
| Service tokens | jose 6.2.12 | 2026-09-05 (6.x since 2025-02-22) | MIT | https://registry.npmjs.org/jose |

### 9.3 AI provider SDKs (chosen at Gate 2)

| SDK | Latest | Major started | 60-day rule today |
|---|---|---|---|
| anthropic 1.11.0 | 2026-09-30 | 1.0.0 on 2026-08-20 | **fails** until 2026-10-19; previous line 0.125.0 |
| openai 3.24.0 | 2026-10-02 | 3.0.0 on 2026-08-12 | **fails** until 2026-10-11; previous line 2.54.0 |

Evidence: https://pypi.org/pypi/anthropic/json · https://pypi.org/pypi/openai/json

### 9.4 Models and prices (read 2026-10-03; re-read at Gate 2)

| Model | Price per million tokens (in / out) | Released | Evidence |
|---|---|---|---|
| claude-haiku-4-5-20251001 | $1 / $5 | 2025-10-15 | https://platform.claude.com/docs/en/models/haiku-4-5/overview · https://platform.claude.com/docs/en/about-claude/pricing |
| claude-sonnet-5 | $2 / $10 | 2026-06-30 | https://platform.claude.com/docs/en/models/sonnet-5/overview |
| claude-sonnet-5-5 | $2 / $10 | 2026-09-28 (too new) | https://platform.claude.com/docs/en/models/sonnet-5-5/overview |
| gpt-5.6-luna | $0.20 / $1.20 | 2026-07-09 | https://developers.openai.com/api/docs/models/gpt-5.6-luna (read through a summariser — re-read raw at Gate 2) |
| gpt-6-luna | $0.10 / $0.50 | 2026-09-22 (too new) | https://developers.openai.com/api/docs/models/gpt-6-luna |
| gemini-3.1-flash-lite | $0.25 / $1.50 | 2026-05-07 (shutdown announced 2027-05-07) | https://ai.google.dev/gemini-api/docs/pricing · https://ai.google.dev/gemini-api/docs/deprecations |
| gemini-3.5-flash-lite | $0.30 / $2.50 | 2026-07-21 | https://ai.google.dev/gemini-api/docs/pricing · https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite |
| voyage-4-lite (embeddings) | $0.02 | — | https://docs.voyageai.com/docs/pricing |
| text-embedding-3-small | $0.02 | — | https://developers.openai.com/api/docs/pricing |

Terms and limits: Anthropic — no training by default, deletion within 30 days, workspace hard spend limit (https://privacy.claude.com/en/articles/7996868 · https://platform.claude.com/docs/en/manage-claude/workspaces · https://platform.claude.com/docs/en/api/rate-limits). OpenAI — no training unless opted in, 30-day abuse logs, hard spend limits since 2026-07-22 (https://developers.openai.com/api/docs/guides/your-data · https://developers.openai.com/api/docs/guides/spend-limits). Gemini API — paid tier not used for training, **free tier is**, 55-day abuse logs (https://ai.google.dev/gemini-api/terms · https://ai.google.dev/gemini-api/docs/usage-policies). Voyage — stores and may train unless opted out (https://docs.voyageai.com/docs/faq). Anthropic offers no embedding model (https://platform.claude.com/docs/en/build-with-claude/embeddings).

### 9.5 Cloud and database facts (read 2026-10-03)

| Fact | Evidence |
|---|---|
| Cloud Run: requests denied by IAM are not billed; same-region service-to-service traffic is free; free tier 180,000 vCPU-s, 360,000 GiB-s, 2 M requests per month (request-based billing); start-up time is billed | https://cloud.google.com/run/pricing · https://docs.cloud.google.com/run/docs/configuring/billing-settings |
| Cloud Run service-to-service: ID token, audience, `X-Serverless-Authorization` | https://docs.cloud.google.com/run/docs/authenticating/service-to-service |
| "Internal" ingress needs VPC routing; Direct VPC egress has no standing charge but needs Cloud NAT (all traffic) or a Cloud DNS private zone (~$0.20/month, no free tier) for our case | https://docs.cloud.google.com/run/docs/securing/private-networking · https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc · https://cloud.google.com/nat/pricing · https://cloud.google.com/dns/pricing |
| Serverless VPC connector: minimum 2 instances, billed as VMs (~$12/month) | https://docs.cloud.google.com/run/docs/configuring/vpc-connectors · https://cloud.google.com/vpc/pricing |
| Minimum memory 512 MiB for second-generation execution | https://docs.cloud.google.com/run/docs/configuring/services/memory-limits |
| Secret Manager: 6 active versions free, $0.06 per version-month beyond | https://cloud.google.com/secret-manager/pricing |
| Artifact Registry: 0.5 GiB free, ~$0.10 per GiB-month beyond | https://cloud.google.com/artifact-registry/pricing |
| Neon Free: **1 GB per project** (was assumed 0.5 GB), 100 CU-hours per project per month, scale-to-zero after 5 minutes, 6-hour restore window | https://neon.com/docs/introduction/plans · https://neon.com/pricing |
| Neon Launch: usage-based, no minimum, $0.106 per CU-hour, $0.35 per GB-month, "typical spend $15/mo" | https://neon.com/pricing |
| Neon ships pgvector 0.8.6 on PostgreSQL 18 | https://neon.com/docs/extensions/pg-extensions |
| pgvector 0.8.7 released 2026-10-01 (fixes an IVFFlat index-build overflow — we use no IVFFlat index); `halfvec` = 2 bytes per dimension + 8; filtering is applied after approximate index scans; exact search recommended for small filtered sets; hybrid search with reciprocal rank fusion | https://github.com/pgvector/pgvector (README, CHANGELOG) · https://github.com/pgvector/pgvector-python/blob/master/examples/hybrid_search/rrf.py |
| PostgreSQL: on tables with row-level security an index is not used for an operator whose function is not LEAKPROOF | https://www.postgresql.org/docs/current/rules-privileges.html |

### 9.6 Other facts quoted in the Phase 2 design (read once, 2026-10-03)

| Fact as used in `docs/phase2` | Evidence |
|---|---|
| Claude Haiku 4.5: status active; retirement "not sooner than October 15, 2026"; Anthropic gives "at least 60 days' notice before model retirement" | https://platform.claude.com/docs/en/models/haiku-4-5/overview · https://platform.claude.com/docs/en/about-claude/model-deprecations |
| Anthropic entry tier: 1,000 requests/min; prepaid credits; workspace spend limits cannot be set on the default workspace | https://platform.claude.com/docs/en/api/rate-limits · https://platform.claude.com/docs/en/manage-claude/workspaces · https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage |
| OpenAI Tier 1: 500 requests/min for the listed models; prepaid, minimum $5 (the billing page itself returned 403; taken from a search summary — **UNVERIFIED**) | https://developers.openai.com/api/docs/guides/rate-limits · https://help.openai.com/en/articles/8264644-setting-up-and-managing-prepaid-api-billing |
| Gemini API: prepaid by default, minimum $5; project spend caps "Experimental" with about 10 minutes of overrun | https://ai.google.dev/gemini-api/docs/billing |
| Structured outputs generally available on Claude Haiku 4.5 | https://platform.claude.com/docs/en/build-with-claude/structured-outputs |
| Newer Claude models produce "approximately 30% more tokens for the same text"; Haiku 4.5 uses the older tokenizer; minimum cacheable prompt on Haiku 4.5 is 4,096 tokens | https://platform.claude.com/docs/en/about-claude/pricing · https://platform.claude.com/docs/en/build-with-claude/prompt-caching |
| Voyage: first 200 M tokens free per account | https://docs.voyageai.com/docs/pricing |
| bge-small-en-v1.5: MTEB average 62.17, retrieval 51.68; 512-token input | https://huggingface.co/BAAI/bge-small-en-v1.5 |
| Quality by vector size, published by two models: Gemini embedding 768 → 67.99, 512 → 67.55, 256 → 66.19; nomic-embed-text-v1.5 768 → 62.28, 512 → 61.96, 256 → 61.04 (their own benchmarks; not comparable with each other or with our model) | https://ai.google.dev/gemini-api/docs/embeddings · https://huggingface.co/nomic-ai/nomic-embed-text-v1.5 |
| Exact (sequential) vector search "performed reasonably well for tables with 10k rows (~36ms)" on 960-dimension vectors with 4 CU | https://neon.com/docs/ai/ai-vector-search-optimization |
| Direct VPC egress: "connection establishment delays of a minute or more on instance startup" | https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc |
| Neon: the Free plan "should be avoided for production workloads where uninterrupted availability matters" | https://neon.com/docs/get-started/production-checklist |
| Cloud Run request-based price beyond the free tier: $0.000024 per vCPU-second, $0.0000025 per GiB-second | https://cloud.google.com/run/pricing |
| e2-micro on-demand $0.008376428/hour (region shown not confirmed as us-central1) — basis of the "~$12/month" connector figure | https://cloud.google.com/products/compute/pricing/general-purpose |

Not needed after all: a multipart upload library for the API — uploads are sent as the raw request body (`docs/phase2/05`).

### 9.7 Unverified / assumptions added by Phase 2

1. Whether a request rejected by Cloud Run's IAM check can start an instance (only "not billed" is documented).
2. Memory needed by Presidio + spaCy + the embedding model together (planned 1 GiB; measured in CI before Gate 2).
3. Whether PostgreSQL uses the keyword (GIN) index under row-level security (a test reads the plan).
4. Exact-search latency at 5,000 chunks per company (measured in CI).
5. Bytes per chunk (estimate 2.7 KB; measured in CI).
6. Whether Neon's Free plan permits commercial use (still no explicit statement either way).
7. OpenAI and Gemini figures were read through a page summariser, not raw text.
8. Whether anthropic 0.x / openai 2.x still receive fixes.
9. Whether Cloud Run keeps giving CPU to a request whose caller has disconnected (the design does not depend on it).
10. Whether a 50-page text PDF parses, redacts and chunks inside one upload request (measured in CI).
11. Whether Neon's console role can create the `vector` extension and the `legacyai_ai` role as the setup script expects.
12. The price of backup storage beyond the free 5 GB (not re-read).
