# LegacyAI

Phase 1 — Foundation: identity, access cards, policy decision point, audit log, tenant platform.

**Start with `docs/phase1/REPORT.md`** — what was built, what is proven (with test output), what is not, and the decisions that need the founder.

## Run it on your computer

You need **Docker Desktop** (running), **Node.js 24** and **git**. Nothing here touches the cloud or costs money.

```bash
# 1. Start a throwaway local database (PostgreSQL 18 in Docker)
docker compose up -d --wait

# 2. Install, configure, create the database roles and tables
cd services/api
npm ci
cp .env.example .env          # fake local-only values; fine for your own machine
npm run db:reset

# 3. Create the first operator card (prints card number, code and enrollment token ONCE)
npm run platform:bootstrap

# 4. Start the API
npm run dev
# in another terminal:
curl http://localhost:8080/v1/health     # {"status":"ok","version":"0.1.0"}
curl http://localhost:8080/v1/ready      # database + migrations check
```

## Run the tests

```bash
cd services/api
npm test                      # 480+ tests against the real local database (about 8 minutes)
npm run test:coverage         # same, with a coverage summary
npm run typecheck && npm run lint

# backup -> encrypt -> restore -> verify, with negative controls (run after the tests)
bash ../../scripts/backup-restore-selftest.sh legacyai_test
```

The AI service stub:

```bash
cd services/ai
python -m venv .venv && . .venv/Scripts/activate    # on macOS/Linux: . .venv/bin/activate
pip install -r requirements-dev.txt
python -m pytest -q
```

## Where things are

| Path | What |
|---|---|
| `docs/phase1/` | Design documents (approved at Gate 1), schema diagram, **REPORT.md** |
| `docs/DEPENDENCIES.md` | Every tool and version, with the evidence it was chosen on |
| `docs/decisions.md` | Decision log |
| `db/migrations/`, `db/roles/` | SQL migrations and the database-roles script |
| `services/api/openapi.yaml` | The API contract (source of truth) |
| `services/api/src/modules/identity-access` | Cards, login, sessions, roles, policy decision point |
| `services/api/src/modules/platform` | Config, database, HTTP layer, audit log, tenants, rate limits, export |
| `services/api/src/modules/billing` | Interface stub + TODO list (Phase 4) |
| `services/ai` | Empty FastAPI service with `/health` (Phase 2) |
| `scripts/` | Database setup, backup, restore test, CI helper checks |
| `infra/` | Terraform (plan-only, never applied) and a plain-language guide |
| `.github/workflows/` | CI (and a deploy workflow that is disabled until you enable it) |

## Three rules this codebase is built around

1. **Card number + 3-digit code alone never logs anyone in.** A passkey or authenticator code is always required as well.
2. **One company can never see another's data.** The database itself enforces it.
3. **Every access decision is made in one place and written to a tamper-evident log.**
