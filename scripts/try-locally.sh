#!/usr/bin/env bash
# Try LegacyAI on your own computer: the database, the AI service (FAKE AI - no AI company is called, nothing costs
# money), the API and the web application, all on this computer only. Synthetic use only: the keys are the fake
# local-only placeholders from services/api/.env.example, and everything you create is erased when you stop.
#
#   bash scripts/try-locally.sh start    # start everything, then open http://localhost:8080 (first start: 5-15 minutes)
#   bash scripts/try-locally.sh status   # what is running
#   bash scripts/try-locally.sh stop     # stop everything (erases what you made)
#
# Needs: Docker Desktop already running, Node.js 24, Python 3.12 or newer, git. On Windows: run it in Git Bash.
# It never starts, stops or restarts Docker itself, and touches only the container named legacyai-postgres.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.local"
WEB_PORT=8080
AI_PORT=8090
API_DIR="$ROOT/services/api"
AI_DIR="$ROOT/services/ai"
WEB_DIR="$ROOT/web"

say() { printf '%s\n' "$*"; }
stop_here() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }

# The fake, local-only values from services/api/.env.example (not secrets; never used anywhere real), plus what this
# script needs on top: the API serves the web application itself, on one address.
api_env() {
  export NODE_ENV=development PORT=$WEB_PORT LOG_LEVEL=info
  export DATABASE_URL='postgres://legacyai_app:local-dev-app-password@127.0.0.1:55432/legacyai'
  export DATABASE_URL_SUPERUSER='postgres://postgres:local-dev-only-not-a-secret@127.0.0.1:55432/legacyai'
  export DATABASE_URL_ADMIN='postgres://legacyai_migrator:local-dev-migrator-password@127.0.0.1:55432/legacyai'
  export DATABASE_URL_BACKUP='postgres://legacyai_backup:local-dev-backup-password@127.0.0.1:55432/legacyai'
  export DATABASE_URL_AI='postgres://legacyai_ai:local-dev-ai-svc-password@127.0.0.1:55432/legacyai'
  export SC_PEPPER_KEYRING='{"current":"v1","keys":{"v1":"RkFLRS1QRVBQRVItRE8tTk9ULVVTRS1GQUtFLVBFUFBFUi0="}}'
  export CREDENTIAL_ENC_KEYRING='{"current":"k1","keys":{"k1":"RkFLRS1FTkMtS0VZLURPLU5PVC1VU0UtRkFLRS1LRVk="}}'
  export HMAC_INDEX_KEY='RkFLRS1ITUFDLUtFWS1ETy1OT1QtVVNFLUZBS0UtSE1BQy0='
  export SERVICE_TOKEN_KEY='fake-service-token-key-do-not-use-000000'
  export AI_SERVICE_URL="http://127.0.0.1:$AI_PORT"
  export WEBAUTHN_RP_ID=localhost WEBAUTHN_RP_NAME='LegacyAI (on this computer)'
  export ALLOWED_ORIGINS="http://localhost:$WEB_PORT"
  export WEB_DIST_DIR="$WEB_DIR/dist"
}

# The AI service: fake AI provider, fake embedder, content sealed with a local stand-in key (as in production, D41).
ai_env() {
  export ENVIRONMENT=development AI_PROVIDER=fake EMBEDDER=fake
  export DATABASE_URL='postgres://legacyai_ai:local-dev-ai-svc-password@127.0.0.1:55432/legacyai'
  export SERVICE_TOKEN_KEY='fake-service-token-key-do-not-use-000000'
  export KEY_SERVICE=local PLATFORM_CONTENT_KEY=local:platform
  export LOCAL_KEY_SERVICE_KEYS='{"platform":"dGVzdC1vbmx5LWxvY2FsLWtleS1ub3Qtc2VjcmV0ISE="}'
}

python_cmd() {
  for p in python3 python "py -3"; do
    if $p -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)' >/dev/null 2>&1; then echo "$p"; return; fi
  done
}
venv_python() {
  if [ -x "$AI_DIR/.venv/Scripts/python.exe" ]; then echo "$AI_DIR/.venv/Scripts/python.exe"; else echo "$AI_DIR/.venv/bin/python"; fi
}
running() { [ -f "$STATE/$1.pid" ] && kill -0 "$(cat "$STATE/$1.pid")" 2>/dev/null; }
port_answers() { curl -fsS -o /dev/null --max-time 2 "$1" 2>/dev/null; }
wait_for() { # url, seconds, name, log
  for _ in $(seq 1 "$2"); do port_answers "$1" && return 0; sleep 1; done
  say "--- last lines of $4 ---"; tail -n 30 "$4" || true
  stop_here "$3 did not start within $2 seconds (its log is above, and in $4)."
}

check_tools() {
  command -v docker >/dev/null || stop_here "Docker is not installed. Install Docker Desktop, start it, then run this again."
  docker info >/dev/null 2>&1 || stop_here "Docker Desktop is not running (or not ready yet). Start it yourself, wait until it says it is running, then run this again. This script never starts or restarts Docker."
  command -v node >/dev/null || stop_here "Node.js is not installed. Install Node.js 24 (nodejs.org), then run this again."
  [ "$(node -p 'process.versions.node.split(".")[0]')" = "24" ] || stop_here "Node.js 24 is needed; this computer has $(node -v)."
  command -v curl >/dev/null || stop_here "curl is missing (Git Bash includes it)."
  [ -n "$(python_cmd)" ] || stop_here "Python 3.12 or newer is not installed (python.org), or not on the PATH."
  for port in $WEB_PORT $AI_PORT; do
    if port_answers "http://127.0.0.1:$port/" && ! running api && ! running ai; then
      stop_here "Something else already uses port $port on this computer. Close it, then run this again."
    fi
  done
}

start() {
  check_tools
  mkdir -p "$STATE/logs"
  if running api; then say "LegacyAI is already running: http://localhost:$WEB_PORT"; exit 0; fi

  say "1/6  Database (Docker container legacyai-postgres)..."
  (cd "$ROOT" && docker compose up -d --wait) >/dev/null || stop_here "The database container did not start; Docker's own message is just above. (The first start downloads the database image, about 150 MB: it needs the internet.)"

  say "2/6  API: installing its packages (first time only)..."
  (cd "$API_DIR" && { [ -d node_modules ] || npm ci --no-audit --no-fund >"$STATE/logs/npm-api.log" 2>&1; }) || stop_here "npm ci failed for the API (see $STATE/logs/npm-api.log)."

  local fresh
  fresh="$(docker exec legacyai-postgres psql -U postgres -d legacyai -tAc "SELECT to_regclass('public.tenants') IS NULL" 2>/dev/null | tr -d '[:space:]')"
  if [ "$fresh" != "f" ]; then
    say "3/6  Database: creating the roles and every table (fresh start)..."
    (cd "$API_DIR" && api_env && node ../../scripts/db-setup.mjs reset >"$STATE/logs/db-setup.log" 2>&1) || stop_here "Creating the tables failed (see $STATE/logs/db-setup.log)."
  else
    say "3/6  Database: already set up, kept as it is."
  fi

  say "4/6  AI service (FAKE AI): installing its packages (first time: several minutes, about 1 GB)..."
  if [ ! -e "$(venv_python)" ]; then $(python_cmd) -m venv "$AI_DIR/.venv"; fi
  (cd "$AI_DIR" && "$(venv_python)" -m pip install -q -r requirements.txt >"$STATE/logs/pip-ai.log" 2>&1) || stop_here "Installing the AI service failed (see $STATE/logs/pip-ai.log)."
  # the settings first, then ONLY the service in the background, so that $! is the service itself (stop kills it)
  (cd "$AI_DIR"; ai_env; nohup "$(venv_python)" -m uvicorn app.main:app --host 127.0.0.1 --port $AI_PORT >"$STATE/logs/ai.log" 2>&1 & echo $! >"$STATE/ai.pid")
  wait_for "http://127.0.0.1:$AI_PORT/health" 120 "The AI service" "$STATE/logs/ai.log"

  say "5/6  Web application: building the screens..."
  (cd "$WEB_DIR" && { [ -d node_modules ] || npm ci --no-audit --no-fund >"$STATE/logs/npm-web.log" 2>&1; } && npm run build >"$STATE/logs/web-build.log" 2>&1) || stop_here "Building the screens failed (see $STATE/logs/web-build.log)."

  say "6/6  API, serving the screens on http://localhost:$WEB_PORT ..."
  (cd "$API_DIR"; api_env; nohup node src/main.ts >"$STATE/logs/api.log" 2>&1 & echo $! >"$STATE/api.pid")
  wait_for "http://127.0.0.1:$WEB_PORT/v1/ready" 90 "The API" "$STATE/logs/api.log"

  if [ "$fresh" != "f" ]; then
    say ""
    say "Your first card - the LegacyAI operator (you). It is shown ONCE: write it down now."
    (cd "$API_DIR" && api_env && LOG_LEVEL=error NODE_NO_WARNINGS=1 node src/cli/bootstrap-platform.ts) || stop_here "Creating your first card failed."
  fi
  say ""
  say "LegacyAI is running on this computer: open  http://localhost:$WEB_PORT  in Chrome or Edge."
  say "  First time: click 'Set it up' under the card number box, type the card number, the 3-digit code and the set-up"
  say "  token (printed above as 'Enrollment token'), then add a passkey (Windows Hello) or an authenticator app on your"
  say "  phone. Then sign in, and as the operator create a company: its"
  say "  owner's card is shown once, and you sign in with it to use the product."
  say "  The AI is a stand-in: its answers come from your own documents but are not written by a real AI model."
  say "  Stop with:  bash scripts/try-locally.sh stop   (this erases everything you made)"
}

stop() {
  for name in api ai; do
    if running "$name"; then
      local pid; pid="$(cat "$STATE/$name.pid")"
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 15); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true   # it did not stop by itself within 15 seconds
    fi
    rm -f "$STATE/$name.pid"
  done
  for port in $WEB_PORT $AI_PORT; do
    port_answers "http://127.0.0.1:$port/" && say "Note: something still answers on port $port; it was not started by this script." || true
  done
  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    (cd "$ROOT" && docker compose down >/dev/null 2>&1) || true
  fi
  say "Stopped. The database container legacyai-postgres is removed; what you made is erased."
}

status() {
  running api && say "API and screens: running (http://localhost:$WEB_PORT)" || say "API and screens: not running"
  running ai && say "AI service (fake AI): running" || say "AI service: not running"
  if command -v docker >/dev/null && docker info >/dev/null 2>&1 && [ -n "$(docker ps -q -f name=^legacyai-postgres$)" ]; then
    say "Database: running"
  else
    say "Database: not running"
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) say "Usage: bash scripts/try-locally.sh start | status | stop"; exit 2 ;;
esac
