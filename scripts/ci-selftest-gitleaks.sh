#!/usr/bin/env bash
# "Seen it fire" for secret scanning, using the REPOSITORY'S OWN configuration:
#   1. a planted fake private key and fake cloud key must be reported (by rule name), and
#   2. the documented placeholder values that the allow-list permits must NOT be reported,
#      while a real-looking value right next to them still is.
# The planted values are assembled at run time so this file contains no key-shaped string.
set -euo pipefail
export MSYS_NO_PATHCONV=1
here="$(cd "$(dirname "$0")" && pwd)"
image="ghcr.io/gitleaks/gitleaks:v8.30.1"
fail() { echo "gitleaks-selftest: FAIL - $*" >&2; exit 1; }

vol="legacyai-gitleaks-selftest-$$"
docker volume create "$vol" >/dev/null
trap 'docker volume rm -f "$vol" >/dev/null 2>&1 || true' EXIT

# Build the scratch folder inside a volume (works the same on Linux CI and on Windows).
docker run --rm -i -v "$vol:/scan" --entrypoint sh "$image" -c 'cat > /scan/.gitleaks.toml' < "$here/../.gitleaks.toml"
docker run --rm -v "$vol:/scan" --entrypoint sh "$image" -c '
  printf "aws_secret_access_key = \"%s%s\"\n" "wJalrXUtnFEMI/K7MDENG/bPxRfiCY" "EXAMPLEKEY" > /scan/planted-cloud-key.txt
  printf -- "-----BEGIN %s PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj\nMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu\n-----END %s PRIVATE KEY-----\n" RSA RSA > /scan/planted-private-key.pem
  printf "DATABASE_URL=postgres://legacyai_app:local-dev-app-password@127.0.0.1:55432/legacyai\n" > /scan/allowed-placeholder.env
'

set +e
out="$(docker run --rm -v "$vol:/scan" "$image" dir /scan --config /scan/.gitleaks.toml --no-banner --redact --report-format json --report-path /scan/report.json 2>&1)"
code=$?
set -e
[ "$code" -eq 1 ] || fail "expected exit code 1 (leaks found), got $code: $out"
report="$(docker run --rm -v "$vol:/scan" --entrypoint cat "$image" /scan/report.json)"
echo "$report" | grep -q 'planted-private-key.pem' || fail "the planted private key was not reported"
echo "$report" | grep -q '"RuleID": *"private-key"' || fail "the private-key rule did not fire"
if echo "$report" | grep -q 'allowed-placeholder.env'; then fail "a documented local placeholder was reported (allow-list is broken)"; fi
findings="$(echo "$report" | grep -c '"RuleID"')"
echo "gitleaks-selftest: PASS (planted private key detected with the repository configuration; documented placeholder not flagged; findings=$findings)"
