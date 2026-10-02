#!/usr/bin/env bash
# "Seen it fire" for secret scanning: plant a fake key in a scratch folder and make sure
# gitleaks finds it. A scanner that reports nothing must be shown to be able to report something.
# The planted value is assembled at run time so this file itself contains no key-shaped string.
set -euo pipefail
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
printf 'aws_secret_access_key = "%s%s"\n' 'wJalrXUtnFEMI/K7MDENG/bPxRfiCY' 'EXAMPLEKEY' > "$scratch/config.txt"
printf -- '-----BEGIN %s PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj\n-----END %s PRIVATE KEY-----\n' RSA RSA > "$scratch/key.pem"
set +e
docker run --rm -v "$scratch:/scan" ghcr.io/gitleaks/gitleaks:v8.30.1 dir /scan --redact --no-banner >/dev/null 2>&1
code=$?
set -e
[ "$code" -ne 0 ] || { echo "gitleaks-selftest: FAIL - the scanner did not flag a planted private key" >&2; exit 1; }
echo "gitleaks-selftest: PASS (planted fake key was detected, exit code $code)"
