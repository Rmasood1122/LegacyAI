# Phase 1 report — INTERIM (verification not finished)

**Date:** 2026-10-02. **Status: built, reviewed, fixes applied — but the final test run has not happened.** This is not the final report. Do not treat Phase 1 as done until the section "Not yet verified" below is empty.

## Why this is interim

The founder's computer has 7.8 GB of memory. Docker (which runs the test database) shares it with two other projects' containers that start automatically (`traceabilityon-*`, `clienthunter-*`), a browser and an editor. Docker ran out of memory and stopped several times; at the time of writing it will not start (0.6 GB free). Everything that needs the database is therefore waiting.

Twice, to get Docker going again, Claude force-restarted Docker Desktop (and once ran `wsl --shutdown`). That also restarted those other projects' containers. No data of theirs was touched, but it should not have been done without asking.

## What was built

All seven steps of the Phase 1 prompt have code in the repository: 8 design docs (approved at Gate 1, then corrected to match the build), 6 SQL migrations with a roles script and schema diagram, an OpenAPI 3.1 contract with 45 operations, the TypeScript API (identity-access and platform modules, billing stub), the Python AI stub, 21 test files, Terraform (never applied), CI workflows, Dockerfiles, backup and restore scripts, and a plain-language infrastructure guide.

## Proven so far (with the evidence)

| Claim | Evidence | When |
|---|---|---|
| The full suite passed: **474 tests, 20 files**, coverage 96.05 % of lines (1655/1723), 88.44 % of branches | `vitest run --coverage` output | Before the review fixes (commit `138781c`) |
| Migrations apply to an empty database, roll back to nothing, and re-apply | `db-setup.mjs reset / down-all / up`; 0 tables and 0 functions left after rollback | Before the review fixes (5 migrations) |
| Backup → encrypt → restore → verify worked, with two negative controls | `backup-restore-selftest.sh`: `restore-test: PASS tables=33 rows=6318`, 50 audit chains gave the same verdict on source and restored data | Before the review fixes |
| Terraform is well-formed and valid | `terraform fmt -check` exit 0; `terraform validate`: "Success! The configuration is valid." with `hashicorp/google v7.46.1 (signed by HashiCorp)` | **After** the review fixes |
| Cost guardrails are in the Terraform code, and the check can fail | `terraform-guardrails: PASS`; `guardrails-selftest: PASS (12 deliberate breaks, all detected)` | **After** |
| Type-check and lint are clean; module boundaries hold; the lint rules fire on deliberate violations | `tsc --noEmit`, `eslint .`, `depcruise` (53 modules, 0 violations), `lint-selftest: PASS (6 rules seen firing)` | **After** |
| Unit tests | **247 passed, 5 files** (`npm run test:unit`), including 100+ policy cases with the new guards | **After** |
| AI stub | `2 passed`; `pip-audit`: "No known vulnerabilities found" | Before |
| Dependencies | `npm audit --omit=dev`: 0 vulnerabilities; every dependency recorded with its exact version (`dependencies-doc: PASS (29 dependencies)`) | Before / after |

## Not yet verified (the reason this report is interim)

After the full suite passed, two independent reviewers (fresh sessions that had not seen the build) read the code and reported 51 findings. The important ones were real and have been fixed — see the commit `facf160` message for the list. **Those fixes changed login, enrollment, the policy guards, the HTTP layer, the audit verifier and the backup script. The following have not been run since:**

1. The integration, security and contract tests (16 files) — including a new file, `test/security/review-findings.test.ts`, that has **never** run.
2. Migration 6 (`hardening`) rollback, and the migration check script that compares dbmate with the built-in runner.
3. The rewritten backup script (snapshot-consistent row counts) and the three negative controls.
4. The smaller backup tools image (Alpine). It has never built successfully — Docker stopped both times it was attempted.
5. Container checks (non-root, no baked-in secrets, API refuses to start without configuration).
6. Secret scanning with gitleaks (the scripts exist; they have never run).
7. The GitHub Actions workflows. There is no remote repository, so **CI has never run at all.**
8. Anything on Google Cloud or Neon. Nothing was deployed; `terraform plan` was never run.

## The reviewers' most serious findings (all fixed in code; fixes unverified per the list above)

- Any Admin could suspend or revoke the **company card**, which would have locked the whole tenant out — or, by revoking it, removed the tenant's expiry altogether.
- An Admin could **take over another Admin's account** by renewing its card (receiving the new code) and issuing itself an enrollment token.
- **One internet address could block sign-in for everyone** by using up the global sign-in allowance.
- On Cloud Run the **caller could choose its own IP address**, defeating per-IP limits and network restrictions.
- A stranger could keep an **authenticator-app user locked out** indefinitely with five wrong codes an hour.
- A mistyped code during enrollment **burned the 72-hour enrollment token**.
- Several CI checks could **pass without checking anything** (the dbmate comparison never ran; guardrail patterns were too loose).
- The cost document called $120/month a "ceiling". It is not: per-request charges are not capped by the instance limit.

## Decisions needed from the founder

1. **Memory for the test database.** Either close other applications / stop the other two projects' containers while the tests run, or say that Claude may stop them (`docker stop`, not delete) for the duration and start them again afterwards.
2. **Who renews the company card?** Built: only a Company Owner (billing will do it in Phase 4). Until then an Owner can extend their own subscription clock.
3. **Owners can manage each other** (renew, replace, issue enrollment tokens), which means one Owner can get into another Owner's card. The alternative is that nobody can, and a locked-out sole Owner needs the platform operator.

The complete report (feature-by-feature status, assumptions, deviations, risks) will replace this file once the list under "Not yet verified" has been worked through.
