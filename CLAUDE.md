# Rules for Claude Code in this repository

The founder is solo and does not read code. Explain in plain language, prove with tests, and say
plainly what is not proven. These rules come from the founder and are not negotiable.

## Never do these

- **Never restart, stop or reconfigure Docker Desktop or WSL** (no `wsl --shutdown`, no killing
  Docker processes). The founder's computer has 7.8 GB of memory and other projects depend on Docker.
- **Never stop, remove or otherwise touch another project's containers, images or volumes**
  (for example `traceabilityon-*`, `clienthunter-*`). Only containers named `legacyai-*` are ours.
- **Never force-push** and never rewrite published git history.
- **Never run `terraform apply`** (or `destroy`, or `import`). Terraform here is plan-only; the
  founder applies it by hand.
- **Never create a cloud resource or touch a real account** (Google Cloud, Neon, an AI provider,
  DNS, email). Nothing that can cost money.
- **Never put a real API key, password or token in a file**, a commit, a log line or a test.
  `.env.example` holds fake values only; real values live in Secret Manager or the local shell.
- **Never use real personal data** in tests, seeds, fixtures or logs. Synthetic data only.
- **No paid AI call before the founder says so** ("Gate 2"). Automated tests use the fake provider.

## How testing works here

- The database tests cannot run on the founder's computer (Docker does not start reliably).
  **GitHub Actions is the test environment.** Locally, run only what needs no database:
  `npm run typecheck`, `npm run lint`, `npm run test:unit` in `services/api`.
- Do not start background jobs or long-running processes on this computer without asking.

## How to report

- Never write "secure", "accurate", "no gaps" or "production-ready". Say what a test measured,
  on what sample, and what it did not cover. Say "tamper-evident", never "tamper-proof".
- Every claim in a report is backed by test output or labelled ASSUMPTION.
- Before choosing any library, tool, model or version: check it on the web, record the source
  and date in `docs/DEPENDENCIES.md`, and apply the 60-day maturity rule (`docs/decisions.md`, D2).

## Where things are

- `docs/phase1/REPORT.md` — what Phase 1 delivered and proved. `docs/decisions.md` — why.
- `docs/runbooks/` — step-by-step procedures for the platform operator.
- `services/api` — TypeScript API (the only public entry point). `services/ai` — Python service.
- `db/migrations` — SQL migrations (dbmate format; every migration has a working rollback).
