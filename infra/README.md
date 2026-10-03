# Infrastructure — plain-language guide

**Nothing in this folder has been applied.** Claude wrote the files and checked that they are well-formed (`terraform fmt`, `terraform validate`). Claude never ran `terraform plan` or `terraform apply`, never created a cloud resource and never touched a real account. Everything below is for **you** to do, by hand, when you decide to.

**Expected cost at zero traffic: $0.** The things that can make it non-zero are listed at the top of `docs/phase1/06-infra-and-cost.md`. Read that list first.

You do **not** need any of this to run or test the product on your own computer. For that, see the top-level `README.md`.

---

## What you will end up with

| Thing | What it is for | Cost guard |
|---|---|---|
| A Neon database | Stores everything | Free plan; sleeps when idle |
| An image registry | Holds the program images | Old images deleted automatically |
| 5 empty "secrets" | Safe storage for keys and passwords | Inside the free allowance of 6 |
| 2 storage buckets | Encrypted backups; audit anchors | Private; old backups deleted automatically |
| A budget alert | Emails you at 50 %, 90 %, 100 % of $1 | **An email only — it does not stop spending** |
| *(second step)* 2 services + 2 nightly jobs | The API, the AI stub, backup, audit anchor | Off when idle; capped at 2 + 1 instances |

---

## Part A — Create the database (Neon)

1. Go to <https://neon.com>, sign up, and create a **project**. Choose PostgreSQL **18** and a US region (for example *AWS US East*). Name the database `legacyai`.
2. Neon shows a **connection string** for a role it created for you (often called `neondb_owner`). This role is powerful: it can bypass the tenant walls. **It is for setup, migrations and backups only. The running API must never use it** — the API checks and refuses to start if you give it this role.
3. Make three long random passwords (at least 20 characters each). On your computer, in a terminal:
   ```
   node -e "for(let i=0;i<3;i++)console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```
   Call them *migrator password*, *app password*, *backup password*. Keep them in your password manager.
4. Open **Git Bash** (it comes with Git for Windows; the commands in this guide are written for it, not for PowerShell). In the `services/api` folder, set four variables **for this terminal window only** (replace the parts in capitals; use the *direct*, not the *pooled*, host except where noted). **Type a space before each `export`** — Git Bash then keeps the line, and the password in it, out of its history file:
   ```
    export DATABASE_URL_SUPERUSER='postgresql://neondb_owner:NEON_PASSWORD@NEON_HOST/legacyai?sslmode=require'
    export DATABASE_URL_ADMIN='postgresql://legacyai_migrator:MIGRATOR_PASSWORD@NEON_HOST/legacyai?sslmode=require'
    export DATABASE_URL='postgresql://legacyai_app:APP_PASSWORD@NEON_POOLED_HOST/legacyai?sslmode=require'
    export DATABASE_URL_BACKUP='postgresql://legacyai_backup:BACKUP_PASSWORD@NEON_HOST/legacyai?sslmode=require'
   ```
5. Create the three database roles, then the tables:
   ```
   npm ci
   npm run db:roles
   npm run db:up
   ```
   - `db:roles` creates `legacyai_migrator`, `legacyai_app` and `legacyai_backup` with the passwords you chose.
   - `db:roles` ends by checking the roles and stops if any has more power than intended.
   - **If `db:roles` stops with a "permission denied" error:** this step has never been run against Neon (it needs your account), so an error here is possible. Send Claude the exact message.
   - **If it stops with an error about `BYPASSRLS`:** Neon did not let the setup role hand that right to the backup role (this is the one thing I could not verify without your account). In that case use the Neon setup role's connection string for backups (as `database-url-admin` in Part C), and tell Claude so the script can skip the backup role.
   - `db:up` creates all 33 tables (7 migrations).
6. **Where the connection strings go later:** the *app* one (`DATABASE_URL`, pooled host) goes into the secret `legacyai-database-url`. The *backup/admin* one goes into `legacyai-database-url-admin`. Never paste either into a file in this repository.

> Neon's free database **sleeps after 5 minutes** and has about 400 hours of awake time per month. Do not point an uptime monitor at `/v1/ready` — it would keep the database awake until the allowance runs out, and then the database stops until next month. `/v1/health` is safe to monitor (it never touches the database).

---

## Part B — Google Cloud, first step (no services yet)

1. Create a Google Cloud **project** at <https://console.cloud.google.com>. Note its **project id**.
2. Attach a **billing account** (Google requires a payment card even for free usage). Note the billing account id (looks like `000000-AAAAAA-BBBBBB`).
3. Install two tools on your computer: the **Google Cloud CLI** (`gcloud`) and **Terraform 1.16**.
4. Log in: `gcloud auth login` then `gcloud auth application-default login`.
5. In `infra/terraform`, copy `example.tfvars` to `terraform.tfvars` and fill in the three values at the top. Leave `deploy_services = false`.
6. Look before you leap:
   ```
   terraform init
   terraform plan
   ```
   Read the plan. It should list about **40 things to add** and **nothing to change or destroy**: 11 enabled APIs, 1 registry, 5 service accounts, 5 secrets, about 13 access rules, 2 buckets, 1 email channel, 1 budget. **No Cloud Run service, no job.**
7. If the plan looks right: `terraform apply`. (This is the step Claude will never do for you.)

---

## Part C — Fill in the five secrets (by hand)

Terraform created the secrets **empty**. Give each one a value. For the keys, generate fresh random values — do not reuse the fake ones from `.env.example`:

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

| Secret name | What to put in it |
|---|---|
| `legacyai-database-url` | The **app** connection string from Part A (pooled host) |
| `legacyai-database-url-admin` | The **backup** connection string from Part A (`legacyai_backup`, direct host). Despite the name it is used only by the backup job. Not the migrator's. |
| `legacyai-api-keyrings` | One JSON value with the API's three keys: `{"SC_PEPPER_KEYRING":{"current":"v1","keys":{"v1":"<random key>"}},"CREDENTIAL_ENC_KEYRING":{"current":"k1","keys":{"k1":"<another random key>"}},"HMAC_INDEX_KEY":"<another random key>"}` |
| `legacyai-service-token-key` | `<another random key>` (the API and the AI service both read it) |
| `legacyai-ai-service-config` | `{"DATABASE_URL":"<the AI service's connection string (legacyai_ai login)>"}`. After Gate 2, and only then, the AI provider key is added here as `"AI_PROVIDER_KEY"`. |

To add a value without it landing in your terminal history, put it in a temporary file and run:
```
gcloud secrets versions add legacyai-api-keyrings --project=YOUR_PROJECT_ID --data-file=TEMP_FILE
```
then delete the temporary file. Create the temporary file **outside this repository folder** (for example on your Desktop), with no blank line at the end.

**Write the pepper and the encryption key down somewhere safe (password manager).** If the pepper is lost, nobody can log in until every card is renewed. If the encryption key is lost, every authenticator-app enrollment must be redone.

**When you rotate a secret later:** add the new version, then *disable* the old version. Six active versions are free (five are in use, so one rotation at a time fits); a seventh costs $0.06 per month.

---

## Part D — The backup key

Backups are encrypted so that the backup job itself cannot read them.

1. Install `age` (<https://age-encryption.org>) on your computer. **Leave the repository folder first** (for example `cd ~/Desktop`) so the key file can never be committed by accident, then run `age-keygen -o legacyai-backup-key.txt`.
2. The file contains a **private** key. Store it **offline**: password manager plus a printed copy. **If you lose it, the backups cannot be restored by anyone.** Never upload it, never put it in a secret, never commit it.
3. The command prints a **public** key starting with `age1…`. Put that in `terraform.tfvars` as `backup_age_recipient`. A public key is not a secret.

---

## Part E — Second step: the services

1. Build and push the three images (replace PROJECT with your project id):
   ```
   gcloud auth configure-docker us-central1-docker.pkg.dev
   R=us-central1-docker.pkg.dev/PROJECT/legacyai
   docker build -t $R/api:v1 services/api && docker push $R/api:v1
   docker build -t $R/ai:v1 services/ai && docker push $R/ai:v1
   docker build -f scripts/backup-tools.Dockerfile -t $R/backup-tools:v1 scripts && docker push $R/backup-tools:v1
   ```
2. In `terraform.tfvars` set:
   ```
   deploy_services = true
   api_image_tag   = "v1"
   ai_image_tag    = "v1"
   tools_image_tag = "v1"
   allowed_origins = "https://the-address-of-your-web-app"
   webauthn_rp_id  = "the-host-name-of-your-web-app"
   ```
   (There is no web app yet. Until Phase 3 you can leave the two placeholder values; the API will run, but nobody can log in from a browser.)
3. `terraform plan` — it should add 2 services, 2 jobs, 2 schedules and a few access rules. Then `terraform apply`.
4. Create the first operator card. In `services/api`, with `DATABASE_URL`, `API_KEYRINGS`, `SERVICE_TOKEN_KEY` and `AI_SERVICE_URL` (the AI service address Terraform printed) set in your terminal to the **same values as the secrets**:
   ```
   npm run platform:bootstrap
   ```
   It prints a card number, a 3-digit code and a one-time token **once**. Write them down.
5. Check: open the API address that Terraform printed, followed by `/v1/health`. You should see `{"status":"ok",…}`.

**Known limits of this step (Phase 1):** tenant exports are written to the container's temporary disk, which disappears when the service scales down — fine for a skeleton, not for real use. Only the API can reach the AI service (Google checks the API's identity, and the AI service checks the API's own short-lived token). Until Gate 2 the AI service uses a fake AI provider: nothing is sent to an AI company. The budget is in US dollars and will be refused if your billing account uses another currency. If your Google organisation forbids public services, the step that makes the API reachable will fail.

---

## Things that are irreversible or cost money — stop and think

| Action | Why to pause |
|---|---|
| `lock_audit_anchor_retention = true` | **Permanent.** Nobody can ever shorten or remove the retention rule on that bucket. Leave `false` during the pilot. |
| Raising `api_max_instances` above 2 | The cap bounds CPU and memory charges (about $126/month at 2 instances flat-out — an estimate). It does **not** cap per-request or data charges: there is no hard ceiling on the bill under attack. |
| Adding an `eu` region | EU regions have **no** Cloud Storage free allowance. |
| Adding a 7th secret, or a 4th scheduled job | Small monthly charges begin. |
| `terraform destroy` | Buckets with retention refuse to be deleted until every object has aged out. The services and jobs have deletion protection switched on, so destroying or replacing them fails until you turn it off deliberately. |

## What has and has not been proven

| Claim | Status |
|---|---|
| Terraform files are well-formed and valid for Google provider 7.46.1 | **Proven**: `terraform fmt -check` and `terraform validate` pass (run in Docker, no credentials) |
| The guardrails are in the code (min 0, max caps, request-based billing, budget, 5 empty secrets, private buckets, AI service invokable only by the API, fake AI provider by default) | **Proven** by `scripts/ci-terraform-guardrails.sh` |
| `terraform plan` succeeds against a real project | **Not proven** — needs your account |
| Anything works on Google Cloud or Neon | **Not proven** — nothing was deployed |
| Backup → encrypt → restore → verify works | **Proven locally** against the Docker database; **not proven** against Neon or a real bucket (the upload-to-bucket step in particular has never run) |
| Monthly cost is $0 | **Estimate.** Only a real bill proves it. |
