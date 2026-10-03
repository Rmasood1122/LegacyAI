#!/usr/bin/env bash
# Checks on the built images: non-root user, no secrets baked in, API fails closed.
set -euo pipefail
fail() { echo "container-checks: FAIL - $*" >&2; exit 1; }

for image in legacyai-api legacyai-ai legacyai-backup-tools; do
  user="$(docker inspect -f '{{.Config.User}}' "$image")"
  case "$user" in ""|0|root|0:0) fail "$image runs as root (User='$user')" ;; esac
  uid="$(docker run --rm --entrypoint id "$image" -u)"
  [ "$uid" != "0" ] || fail "$image runs with uid 0"
  # No environment variable in the image may look like a credential.
  # GPG_KEY is set by the official Python base image: it is the PUBLIC id of the key that signed that Python release.
  suspicious="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$image" | grep -Ei '^[^=]*(password|secret|token|pepper|keyring|database_url|_key)[^=]*=' | grep -v '^GPG_KEY=' | cut -d= -f1 || true)"
  if [ -n "$suspicious" ]; then
    fail "$image has a secret-looking environment variable baked in: $suspicious"
  fi
  echo "container-checks: $image user=$user uid=$uid size=$(docker image inspect -f '{{.Size}}' "$image" | awk '{printf "%.0f MB", $1/1000000}')"
done

# The API must refuse to start without configuration (fail closed), naming variables but no values.
set +e
out="$(docker run --rm legacyai-api 2>&1)"; code=$?
set -e
[ "$code" -ne 0 ] || fail "the API started without any configuration"
echo "$out" | grep -q "Invalid configuration" || fail "the API did not report invalid configuration: $out"
echo "container-checks: API without configuration exits $code with 'Invalid configuration' (fail closed)"

# The API image holds the screens, and the API's own loader accepts them (scripts/ci-image-web-check.mjs).
here="$(cd "$(dirname "$0")" && pwd)"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' legacyai-api | grep -qx 'WEB_DIST_DIR=/app/web' || fail "the API image does not set WEB_DIST_DIR=/app/web"
set +e
web="$(docker run --rm -i --entrypoint node legacyai-api --input-type=module - < "$here/ci-image-web-check.mjs" 2>&1)"; code=$?
set -e
[ "$code" -eq 0 ] || fail "the screens in the API image cannot be loaded: $web"
case "$web" in "ok "*) ;; *) fail "unexpected answer from the image check: $web" ;; esac
leftovers="$(docker run --rm --entrypoint sh legacyai-api -c 'find /app/web /app/dist -type f -name "*.tsx"; find /app/web -type f -name "*.map"; find /app/web -type f -name "*.ts"; ls -d /app/test /app/web/e2e /app/web/src 2>/dev/null; true')"
[ -z "$leftovers" ] || fail "the API image contains files that should not be shipped: $leftovers"
echo "container-checks: API image holds the screens (${web#ok } files); the page and a deep link are served, /v1 is not shadowed; no web sources, source maps or tests inside"

# The AI stub answers /health and nothing else.
cid="$(docker run -d --rm -p 127.0.0.1:18080:8080 legacyai-ai)"
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
ok=0
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:18080/health 2>/dev/null | grep -q '"status":"ok"'; then ok=1; break; fi
  sleep 1
done
[ "$ok" = "1" ] || fail "the AI stub did not answer /health"
for path in / /docs /redoc /openapi.json /v1/ask; do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:18080$path")" = "404" ] || fail "the AI stub answers $path"
done
echo "container-checks: AI stub /health ok; /, /docs, /redoc, /openapi.json, /v1/ask all 404"
echo "container-checks: PASS"
