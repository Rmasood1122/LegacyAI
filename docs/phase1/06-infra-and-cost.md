# 06 — Infrastructure and cost

> ## 🔴 Things that are NOT guaranteed to be $0 — read first
>
> 1. **Google Cloud requires a billing account with a payment card on file** before Cloud Run, Artifact Registry or Secret Manager can be used at all. Expected charge at zero traffic: **$0**. But "free tier" is an allowance, not a hard stop. **A budget alert only sends an email — it does not stop spending.**
> 2. **Artifact Registry: 0.5 GB free.** Two container images (API ≈ 150–250 MB, AI stub ≈ 150 MB — ESTIMATES, not measured yet) fit only if old images are deleted. We add an automatic cleanup rule (keep the 2 newest). If it is exceeded: about **$0.10 per GB per month** — cents, but not zero.
> 3. **Secret Manager: 6 active secret versions free.** The design needs exactly **6**. A 7th, or forgetting to disable an old version after rotating a secret, costs **$0.06 per version per month**.
> 4. **Cloud Scheduler: 3 jobs free per billing account.** We use 2 (nightly backup, audit anchor). A 4th job anywhere on the same billing account costs $0.10 per month.
> 5. **Neon free compute: 100 CU-hours per month** ≈ 400 hours at the smallest size — **less than a full month (about 730 hours)**. The database must be allowed to sleep. Anything that pings it constantly (an uptime monitor hitting `/v1/ready`, a chatty cron job) will exhaust the allowance and **the database stops until next month** — an outage, not a bill.
> 6. **Neon free storage: 0.5 GB** (sources disagree; one says 1 GB — we plan for 0.5). The audit log writes one row per request and can never be deleted, so it is the table most likely to fill it. Estimate: roughly 0.4 KB per row → about 1 million audited requests before storage is the problem (EST, to be measured in Step 5).
> 7. **A custom domain name** (needed eventually so the web app and API share cookies cleanly) costs roughly $10–15 per year. **Not bought in Phase 1.**
>
> Everything else below is expected to be $0 at zero traffic.

## In plain language

The code describing the cloud setup is written but **nothing is created**. I never run `terraform apply` and never touch a real account. You get files that `terraform plan` can read, and a plain-language checklist (`infra/README.md`) for doing it yourself when ready.

Both services are set to **switch off completely when idle** (minimum instances = 0) and are **capped** (maximum 2 instances for the API, 1 for the AI stub) so a traffic spike or an attack cannot multiply the bill.

## Terraform resource list (plan-only)

Terraform 1.16.4, provider `hashicorp/google ~> 7.46` (sources and dates in `docs/DEPENDENCIES.md`).

| # | Resource | Purpose | Guardrail |
|---|---|---|---|
| 1 | `google_project_service` × 8 | Turn on the APIs: Cloud Run, Artifact Registry, Secret Manager, Cloud Storage, IAM, Cloud Scheduler, Billing Budgets, Monitoring | Enabling an API is free |
| 2 | `google_artifact_registry_repository` (Docker, `us-central1`) | Holds the container images | `cleanup_policies`: keep 2 most recent versions, delete untagged after 1 day |
| 3 | `google_service_account` × 4 | `api-runtime`, `ai-runtime`, `backup-job`, `ci-deployer` | Each gets only the roles listed in 9 |
| 4 | `google_cloud_run_v2_service` **api** | The API | `min_instance_count = 0`, `max_instance_count = 2`, 1 vCPU, 512 MiB, `cpu_idle = true` (request-based billing — pay only while handling a request), concurrency 40, 30 s timeout. Public ingress (browsers must reach it). |
| 5 | `google_cloud_run_v2_service` **ai** | The AI stub | `min 0`, `max 1`, 1 vCPU, 512 MiB, `cpu_idle = true`. **Internal ingress only**; only `api-runtime` may invoke it. |
| 6 | `google_cloud_run_v2_job` **backup** + `google_cloud_scheduler_job` (nightly) | Encrypted `pg_dump` to the backups bucket | 1 task, 10-minute timeout, no retries beyond 1 |
| 7 | `google_cloud_run_v2_job` **audit-anchor** + `google_cloud_scheduler_job` (daily) | Writes audit chain heads to the anchor bucket | Same limits |
| 8 | `google_secret_manager_secret` × 6 | **Names only — Terraform never sees a value.** `database-url`, `database-url-admin`, `sc-pepper-keyring`, `credential-enc-keyring`, `hmac-index-key`, `internal-service-token` | You add the values by hand (steps in `infra/README.md`) |
| 9 | `google_secret_manager_secret_iam_member`, `google_storage_bucket_iam_member`, `google_cloud_run_v2_service_iam_member` | Least privilege: `api-runtime` reads 5 secrets (**not** `database-url-admin`); `backup-job` reads `database-url-admin` and can only *create* objects in the backups bucket (cannot read or delete them); anchor job can only *create* objects in the anchor bucket | No project-wide roles for runtime accounts |
| 10 | `google_storage_bucket` **backups** (`us-central1`, Standard) | Encrypted database dumps | Uniform access, public access prevention **enforced**, retention policy 7 days (unlocked), lifecycle: delete after 30 days |
| 11 | `google_storage_bucket` **audit-anchors** (`us-central1`, Standard) | Write-once-style record of audit chain heads | Uniform access, public access prevention, retention policy 400 days. **`is_locked` is a variable, default `false`** — locking is permanent and is your decision (see `08`). |
| 12 | `google_billing_budget` + `google_monitoring_notification_channel` (email) | Email alerts at 50%, 90%, 100% of a **$1** monthly budget, and on forecast overspend | Alert only — cannot stop spend |
| 13 | `google_iam_workload_identity_pool` (+ provider) for GitHub Actions | Lets a deploy workflow log in without a stored key | Behind `var.enable_ci_deploy = false` → not created until you switch it on |

**Variables for a second region later:** `var.regions` is a map (`{ us = "us-central1" }` today). Region-specific resources (Cloud Run services, buckets, repository) are created with `for_each` over it, so adding `eu = "europe-west1"` creates a parallel EU stack without restructuring. Note honestly: only `us-central1`, `us-east1` and `us-west1` get the Cloud Storage free allowance — **an EU region is not free**.

**Terraform state.** Kept in a local file by default (git-ignored). It contains resource names, not secret values, because we create secrets without versions. A remote state bucket is recommended once more than one person or CI applies; it is a commented-out block, not created.

**What I can and cannot verify without touching your account:** `terraform fmt -check` and `terraform validate` run in CI and in a local Docker container; they need no credentials and create nothing. A real `terraform plan` needs your project id and credentials, so **I will not have run it.** That will be stated in the final report as "done but not proven".

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

**Worst-case exposure if attacked** (EST): with the API capped at 2 instances × 1 vCPU running flat-out all month = 5.2M vCPU-seconds, minus 180,000 free, × $0.000024 ≈ **$120/month ceiling** from CPU, plus memory ≈ $6. That is the designed maximum, reached only under sustained attack; rate limits make it unlikely. Setting `max_instance_count = 1` halves it. This number is why the cap exists.

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
2. Pipe straight into `age` encryption with a **public** key. The job never holds the private key, so someone who compromises the job or the bucket cannot read any backup.
3. Upload as `backups/YYYY/MM/DD/legacyai-<timestamp>.dump.age` plus a small manifest (size, SHA-256, schema version, row counts per table).
4. The job's service account can create objects but not read, overwrite or delete them. The bucket's 7-day retention policy means even an administrator cannot delete a fresh backup.
5. Exit non-zero on any failure → visible in Cloud Run job history → (later) an alert.

**Restore test (`scripts/restore-test.sh`) — a backup that has never been restored is not a backup:**
1. Take a backup file (the newest, or one you name) and the private key.
2. Start a **throwaway local PostgreSQL** in Docker.
3. Decrypt, `pg_restore`, then run checks: all tables present; row counts match the manifest; row-level security still forced on every tenant table; **the audit chain verifier passes on the restored data**.
4. Print PASS/FAIL and destroy the container.

In Phase 1 this script runs in CI against a backup of the CI test database, so the whole backup → encrypt → decrypt → restore → verify loop is exercised on every change. **It will not have been run against a real Neon database or a real bucket** — that needs your accounts, and will be listed as "not proven".

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
