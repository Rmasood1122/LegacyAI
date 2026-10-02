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
  if docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$image" | grep -Eiq '^[^=]*(password|secret|token|pepper|keyring|database_url|_key)[^=]*='; then
    fail "$image has a secret-looking environment variable baked in"
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
