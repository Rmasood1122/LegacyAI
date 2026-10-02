# 06 — Infrastructure and cost

> **Updated after the build (2026-10-02).** Approved at Gate 1, then corrected to match what was built.
> Differences are listed in `REPORT.md` under "Deviations".

> ## 🔴 Things that are NOT guaranteed to be $0 — read first
>
> 1. **Google Cloud requires a billing account with a payment card on file** before Cloud Run, Artifact Registry or Secret Manager can be used at all. Expected charge at zero traffic: **$0**. But "free tier" is an allowance, not a hard stop. **A budget alert only sends an email — it does not stop spending.**
> 2. **Artifact Registry: 0.5 GB free.** Three container images (API, AI stub, backup tools; sizes are in `REPORT.md`) with up to three versions each will likely sit close to, or a little over, the allowance. An automatic cleanup rule keeps the 3 newest versions and deletes anything else after a week. If the allowance is exceeded: about **$0.10 per GB per month** — cents, but not zero.
> 3. **Secret Manager: 6 active secret versions free.** The design needs exactly **6**. A 7th, or forgetting to disable an old version after rotating a secret, costs **$0.06 per version per month**.
> 4. **Cloud Scheduler: 3 jobs free per billing account.** We use 2 (nightly backup, audit anchor). A 4th job anywhere on the same billing account costs $0.10 per month.
> 5. **Neon free compute: 100 CU-hours per month** ≈ 400 hours at the smallest size — **less than a full month (about 730 hours)**. The database must be allowed to sleep. Anything that pings it constantly (an uptime monitor hitting `/v1/ready`, a chatty cron job) will exhaust the allowance and **the database stops until next month** — an outage, not a bill.
> 6. **Neon free storage: 0.5 GB** (sources disagree; one says 1 GB — we plan for 0.5). The audit log writes one row per request and can never be deleted, so it is the table most likely to fill it. Estimate: roughly 0.4 KB per row → about 1 million audited requests before storage is the problem (EST, to be measured in Step 5).
> 7. **A custom domain name** (needed eventually so the web app and API share cookies cleanly) costs roughly $10–15 per year. **Not bought in Phase 1.**
>
> 8. **There is no hard ceiling on the bill if the API is attacked.** The instance cap limits CPU and memory charges (about $126/month at 2 instances running flat-out — EST), but Google also charges **per request** beyond the free 2 million a month ($0.40 per million) and for outbound data, and those are **not** capped by the instance limit. Two instances can answer a great many cheap requests (a rejected request still counts). Rate limits inside the API reduce the work done, not the number of requests billed. The only real stops are: you seeing the budget email and switching the service off, or putting a paid protection service in front later.
>
> Everything else below is expected to be $0 at zero traffic.

## In plain language

The code describing the cloud setup is written but **nothing is created**. I never run `terraform apply` and never touch a real account. You get files that `terraform plan` can read, and a plain-language checklist (`infra/README.md`) for doing it yourself when ready.

Both services are set to **switch off completely when idle** (minimum instances = 0) and are **capped** (maximum 2 instances for the API, 1 for the AI stub) so a traffic spike or an attack cannot multiply the bill.

## Terraform resource list (plan-only)

Terraform 1.16.4, provider `hashicorp/google ~> 7.46` (sources and dates in `docs/DEPENDENCIES.md`).

| # | Resource | Purpose | Guardrail |
|---|---|---|---|
| 1 | `google_project_service` × 9 | Turn on the APIs: Cloud Run, Artifact Registry, Secret Manager, Cloud Storage, IAM, IAM Credentials, Cloud Scheduler, Billing Budgets, Monitoring | Enabling an API is free |
| 2 | `google_artifact_registry_repository` (Docker, `us-central1`) | Holds the container images | `cleanup_policies`: keep the 3 most recent versions; delete anything else older than 7 days (tagged or not) |
| 3 | `google_service_account` × 5 (+1 optional) | `legacyai-api`, `legacyai-ai`, `legacyai-backup`, `legacyai-anchor`, `legacyai-scheduler`; `legacyai-ci-deployer` only if CI deploy is enabled | Each gets only the roles listed in 9 |
| 4 | `google_cloud_run_v2_service` **api** | The API | `min_instance_count = 0`, `max_instance_count = 2`, 1 vCPU, 512 MiB, `cpu_idle = true` (request-based billing — pay only while handling a request), concurrency 40, 30 s timeout. Public ingress (browsers must reach it). |
| 5 | `google_cloud_run_v2_service` **ai** | The AI stub | `min 0`, `max 1`, 1 vCPU, 512 MiB, `cpu_idle = true`. **Internal ingress only**; only `legacyai-api` may invoke it. **As written, nothing can reach it yet**: the API would need its outbound traffic routed through a VPC, which is not set up (it must be costed first). Fine for a stub; a Phase 2 decision. |
| 6 | `google_cloud_run_v2_job` **backup** + `google_cloud_scheduler_job` (nightly) | Encrypted `pg_dump` to the backups bucket | 1 task, 10-minute timeout, no retries beyond 1 |
| 7 | `google_cloud_run_v2_job` **audit-anchor** + `google_cloud_scheduler_job` (daily) | Writes audit chain heads to the anchor bucket (runs the API image's `anchor-audit-head` command) | Same limits |
| 8 | `google_secret_manager_secret` × 6 | **Names only — Terraform never sees a value.** `database-url`, `database-url-admin`, `sc-pepper-keyring`, `credential-enc-keyring`, `hmac-index-key`, `internal-service-token` | You add the values by hand (steps in `infra/README.md`) |
| 9 | `google_secret_manager_secret_iam_member`, `google_storage_bucket_iam_member`, `google_cloud_run_v2_service_iam_member`, `google_cloud_run_v2_job_iam_member` | Least privilege: `legacyai-api` reads 5 secrets (**not** `database-url-admin`); `legacyai-backup` reads `database-url-admin` and can only *create* objects in the backups bucket (cannot read or delete them); `legacyai-anchor` reads the same 5 secrets as the API and can only *create* objects in the anchor bucket; `legacyai-scheduler` may start the two jobs and nothing else | No project-wide roles for any of these accounts |
| 10 | `google_storage_bucket` **backups** (`us-central1`, Standard) | Encrypted database dumps | Uniform access, public access prevention **enforced**, retention policy 7 days (unlocked), lifecycle: delete after 30 days |
| 11 | `google_storage_bucket` **audit-anchors** (`us-central1`, Standard) | Write-once-style record of audit chain heads | Uniform access, public access prevention, retention policy 400 days. **`is_locked` is a variable, default `false`** — locking is permanent and is your decision (see `08`). |
| 12 | `google_billing_budget` + `google_monitoring_notification_channel` (email) | Email alerts at 50%, 90%, 100% of a **$1** monthly budget, and on forecast overspend | Alert only — cannot stop spend |
| 13 | `google_iam_workload_identity_pool` (+ provider) for GitHub Actions | Lets a deploy workflow log in without a stored key | Behind `var.enable_ci_deploy = false` → not created until you switch it on |

**Two-step apply.** `deploy_services` defaults to `false`: the first apply creates only the registry, the six empty secrets, buckets, accounts and the budget. Cloud Run services and jobs are created on a second apply, after the images are pushed and the secrets have values (Cloud Run cannot start without them). Steps are in `infra/README.md`.

**Variables for a second region later:** `var.regions` is a map (`{ us = "us-central1" }` today). **Only the two Cloud Run services** are created per region today (`for_each` over the map). The buckets, the registry, the scheduled jobs and the database stay single and in the US, so adding `eu = "europe-west1"` gives EU compute, **not** EU data residency. A real EU deployment (feature 21) needs a second database and buckets as well. Note honestly: only `us-central1`, `us-east1` and `us-west1` get the Cloud Storage free allowance — **an EU region is not free**.

**Terraform state.** Kept in a local file by default (git-ignored). It contains resource names, not secret values, because we create secrets without versions. A remote state bucket is recommended once more than one person or CI applies; it is a commented-out block, not created.

**What was and was not verified without touching your account:** `terraform fmt -check` and `terraform validate` were run in the official Terraform 1.16.4 Docker image (provider `hashicorp/google` 7.46.1 installed, "signed by HashiCorp") and both pass; they need no credentials and create nothing. `scripts/ci-terraform-guardrails.sh` checks that the cost guardrails are present in the code. A real `terraform plan` needs your project id and credentials, so **it has not been run.** This is listed in the report under "done but not proven".

## Free-tier guardrails

| Service | Free allowance (verified 2026-10-02) | Our use at zero traffic | Guardrail |
|---|---|---|---|
| Cloud Run services | 180,000 vCPU-s, 360,000 GiB-s, 2M requests / month | 0 (scaled to zero) | min 0; max 2 + 1; `cpu_idle`; no health pinger |
| Cloud Run jobs | 240,000 vCPU-s, 450,000 GiB-s / month (REPORTED) | ~2 short runs per day ≈ 60 runs × ~60 s ≈ 3,600 vCPU-s (EST) | timeout 10 min |
| Artifact Registry | 0.5 GB | ~0.3–0.4 GB (EST) | cleanup policy; slim base images |
| Secret Manager | 6 active versions, 10,000 accesses | 6 versions; accesses only at container start | disable old versions when rotating |
| Cloud Storage | 5 GB-months, US regions only; 5,000 writes, 50,000 reads | backups: up to 30 × (compressed DB ≤ ~150 MB, EST) → **worst case close to 5 GB**; anchors: kilobytes | lifecycle delete at 30 days; reduce to 14 if the DB grows |
| Cloud Scheduler | 3 jobs per billing account | 2 | — |
| Cloud Logging | 50 GiB / month | far below | INFO level; no request bodies logged |
| Billing budget, IAM, Monitoring email channel | free | — | — |
| Neon | 100 CU-h, 0.5 GB, 5 GB egress per project per month | sleeps after 5 min idle | liveness never touches DB; small pool (max 5 connections); backup runs once nightly |

**Worst-case exposure if attacked** (EST): with the API capped at 2 instances × 1 vCPU running flat-out all month = 5.2M vCPU-seconds, minus 180,000 free, × $0.000024 ≈ **$120/month** from CPU, plus memory ≈ $6. **That bounds CPU and memory only — it is not a ceiling on the bill** (see 🔴 8: request fees and outbound data are not limited by the instance cap). Setting `max_instance_count = 1` halves the CPU/memory part.

## Estimated monthly cost at zero traffic

| Item | Cost |
|---|---|
| Cloud Run (api, ai) | $0 |
| Cloud Run jobs + Scheduler (2 jobs) | $0 |
| Artifact Registry | $0 if under 0.5 GB (see 🔴 2) |
| Secret Manager | $0 at exactly 6 versions (see 🔴 3) |
| Cloud Storage | $0 under 5 GB in `us-central1` |
| Budget alert, IAM, logging | $0 |
| Neon Free | $0 |
| GitHub Actions | $0 for a private repo within 2,000 minutes/month (**ASSUMPTION** — verify your plan; CI is estimated at 5–8 minutes per run) |
| **Total expected** | **$0** — all figures EST until observed on a real bill |

## Backup and restore plan

**Why we need our own:** Neon Free keeps only a 6-hour restore window and one manual snapshot. That protects against "oops, five minutes ago", not against a deleted project, a bad migration noticed next week, or Neon itself.

**Backup (nightly, `scripts/backup.sh`, run by the Cloud Run job):**
1. `pg_dump --format=custom` using the admin connection (a role that can see all tenants' rows).
2. Pipe straight into `age` encryption with a **public** key. The job never holds the private key, so someone who compromises the job or the bucket cannot read any backup. The tools image is Alpine + PostgreSQL 18 client + age + curl (no cloud SDK, to stay small); the upload uses the job's own identity.
3. Upload as `backups/YYYY/MM/DD/legacyai-<timestamp>.dump.age` plus a small manifest (size, SHA-256, schema version, row counts per table).
4. The job's service account can create objects but not read, overwrite or delete them. The bucket's 7-day retention policy stops a fresh backup being deleted or overwritten — but the policy is **not locked**, so a project owner could remove the policy first and then delete. The manifest is stored unencrypted and shows per-table row counts.
5. Exit non-zero on any failure → visible in Cloud Run job history. **There is no alert on a failed backup yet** — you would have to look. (Gap; listed in the report.)

**Restore test (`scripts/restore-test.sh`) — a backup that has never been restored is not a backup:**
1. Take a backup file, its manifest and the private key.
2. Create a new, empty scratch database on a **non-production** PostgreSQL server you point it at (the three roles must exist there).
3. Check the file against the manifest's checksum, decrypt, `pg_restore`, then check: schema version; row counts equal the manifest; row-level security still forced on every tenant table; the five security triggers present; the app role cannot bypass row-level security.
4. Print PASS/FAIL and drop the scratch database. (The audit-chain verifier is a separate command, run against the restored database by the self-test below.)

`scripts/backup-restore-selftest.sh` runs the whole loop — backup → encrypt → decrypt → restore into a new database → checks → audit-chain verification — against the test database, locally and in CI, with three negative controls, each of which must fail for its expected reason (file does not match its manifest; corrupted file with a forged manifest fails at decryption; wrong row counts). The verifier must give exactly the same verdict, chain by chain, on the restored database as on the source. **It has not been run against a real Neon database or a real bucket**, and the upload-to-bucket step has never executed; that needs your accounts and is listed as "not proven".

**Where the private key lives:** with you, offline (a password manager and a printed copy). If it is lost, **the backups are unrecoverable** — by design. `infra/README.md` walks through generating it.

**Disaster-recovery targets (design intent, not measured):** lose at most 24 hours of data (nightly backup) or 6 hours if Neon's own restore is usable; restore within a few hours, by hand, following a runbook.

**Tenant export (feature 30)** is separate from backup: a company's own data in open formats (JSON Lines + CSV + a manifest with checksums), available to the Company Owner even after the card expires.

## Hard-constraint checklist

| Constraint | How this design meets it |
|---|---|
| $0 spend | Everything inside free allowances; exceptions flagged in red above |
| Never apply, never create resources | Code only. `terraform validate` only. Deploy workflow is manual-trigger and disabled. |
| No secrets in the repo | Secrets are created empty in Terraform; values added by hand; `.env.example` has fake values; gitleaks in CI over full history |
| Min instances 0, max cap | 0 / 2 (api), 0 / 1 (ai) |
| Budget alert | $1 budget, 50 / 90 / 100% + forecast |
