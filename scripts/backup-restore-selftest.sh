#!/usr/bin/env bash
# End-to-end proof of the backup path, run locally and in CI:
#
#   backup (encrypted)  ->  restore into a new database  ->  checks  ->  audit-chain verification
#   plus two negative controls: a corrupted backup and a wrong manifest must both FAIL.
#
# Uses the local docker-compose PostgreSQL (container "legacyai-postgres") and a THROWAWAY
# key pair generated for this run. Nothing here touches a real database, bucket or key.
#
# Usage:  scripts/backup-restore-selftest.sh [source database name, default legacyai_test]
set -euo pipefail

SOURCE_DB="${1:-legacyai_test}"
RESTORE_DB="legacyai_restore_selftest"
PG_CONTAINER="legacyai-postgres"
SUPER_PW="${TEST_PG_SUPERUSER_PASSWORD:-local-dev-only-not-a-secret}"
BACKUP_PW="${TEST_PG_BACKUP_PASSWORD:-local-test-backup-password}"
APP_PW="${TEST_PG_APP_PASSWORD:-local-test-app-password}"
# On Windows (Git Bash) keep container paths like /work from being rewritten, and hand Docker a Windows path.
export MSYS_NO_PATHCONV=1
winpath() { (cd "$1" && (pwd -W 2>/dev/null || pwd)); }
here="$(winpath "$(dirname "$0")")"
repo="$(winpath "$(dirname "$0")/..")"

docker inspect "$PG_CONTAINER" >/dev/null 2>&1 || { echo "selftest: start the database first: docker compose up -d" >&2; exit 2; }
network="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$PG_CONTAINER")"

echo "selftest: building the tools image"
docker build -q -f "$here/backup-tools.Dockerfile" -t legacyai-backup-tools "$here" >/dev/null

volume="legacyai-selftest-$$"
docker volume create "$volume" >/dev/null
cleanup() {
  docker run --rm --network "$network" legacyai-backup-tools \
    psql "postgres://postgres:$SUPER_PW@$PG_CONTAINER:5432/postgres" -q -c "DROP DATABASE IF EXISTS $RESTORE_DB WITH (FORCE)" >/dev/null 2>&1 || true
  docker volume rm -f "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

tools() { docker run --rm --network "$network" -v "$volume:/work" --user 0:0 "$@"; }

echo "selftest: generating a throwaway age key pair"
tools legacyai-backup-tools sh -c 'age-keygen -o /work/key.txt 2>/dev/null && age-keygen -y /work/key.txt > /work/key.pub && chmod 0644 /work/key.txt'
recipient="$(tools legacyai-backup-tools cat /work/key.pub)"

echo "selftest: 1/6 backup"
tools -e DATABASE_URL_BACKUP="postgres://legacyai_backup:$BACKUP_PW@$PG_CONTAINER:5432/$SOURCE_DB" \
      -e BACKUP_AGE_RECIPIENT="$recipient" -e BACKUP_DEST=/work/out legacyai-backup-tools backup.sh

restore() { # $1 = backup file inside /work, $2 = manifest inside /work, $3 = KEEP flag
  tools -e BACKUP_FILE="$1" -e BACKUP_MANIFEST="$2" -e AGE_IDENTITY_FILE=/work/key.txt -e KEEP_RESTORED_DB="$3" \
        -e RESTORE_SUPERUSER_URL="postgres://postgres:$SUPER_PW@$PG_CONTAINER:5432/postgres" -e RESTORE_DB_NAME="$RESTORE_DB" \
        legacyai-backup-tools sh -c 'BACKUP_FILE=$(ls $BACKUP_FILE) BACKUP_MANIFEST=$(ls $BACKUP_MANIFEST) restore-test.sh'
}

echo "selftest: 2/6 restore + checks"
restore '/work/out/*.dump.age' '/work/out/*.manifest.json' 1

echo "selftest: 3/6 audit-chain verification on the RESTORED database"
# The verifier starts the API's normal (fail-closed) configuration, so it needs well-formed keys.
# These are random, generated for this run only, and protect nothing.
k() { node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"; }
verify() { # $1 = database name, $2 = output file. Exit code 3 means "ran fine, found a broken chain"; anything else non-zero is a crash.
  ( cd "$repo/services/api" &&     NODE_ENV=test LOG_LEVEL=silent     DATABASE_URL="postgres://legacyai_app:$APP_PW@${TEST_PG_HOST:-127.0.0.1}:${TEST_PG_PORT:-55432}/$1"     SC_PEPPER_KEYRING="{\"current\":\"v1\",\"keys\":{\"v1\":\"$(k)\"}}"     CREDENTIAL_ENC_KEYRING="{\"current\":\"k1\",\"keys\":{\"k1\":\"$(k)\"}}"     HMAC_INDEX_KEY="$(k)" INTERNAL_SERVICE_TOKEN="$(k)"     WEBAUTHN_RP_ID=localhost ALLOWED_ORIGINS=http://localhost:3000     node src/cli/verify-audit-chain.ts --tenant all > "$2" 2>/dev/null ) || [ $? -eq 3 ]
}
out="${TMPDIR:-/tmp}"
verify "$SOURCE_DB" "$out/legacyai-selftest-source.jsonl"
verify "$RESTORE_DB" "$out/legacyai-selftest-restored.jsonl"
chains="$(wc -l < "$out/legacyai-selftest-restored.jsonl" | tr -d ' ')"
intact="$(grep -c '"ok":true' "$out/legacyai-selftest-restored.jsonl" || true)"
broken="$(grep -c '"ok":false' "$out/legacyai-selftest-restored.jsonl" || true)"
echo "selftest: audit chains on restored data: chains=$chains intact=$intact broken=$broken"
[ "$chains" -ge 1 ] && [ "$intact" -ge 1 ] || { echo "selftest: FAIL - no intact audit chain was verified on the restored database" >&2; exit 1; }
# The restored database must give EXACTLY the same verdict, chain by chain and hash by hash, as the source.
# (After the test suite the source contains chains that tests tampered with on purpose: those must still be
# reported as broken after a restore - a backup must preserve evidence, not launder it.)
if ! diff -q "$out/legacyai-selftest-source.jsonl" "$out/legacyai-selftest-restored.jsonl" >/dev/null; then
  echo "selftest: FAIL - audit verification differs between the source and the restored database" >&2; exit 1
fi
echo "selftest: restored audit chains match the source exactly"

# A negative control only counts if the restore test fails FOR THE EXPECTED REASON.
must_fail() { # $1 = text that must appear in the failure message; the rest = restore arguments
  expected="$1"; shift
  set +e
  output="$(restore "$@" 2>&1)"; status=$?
  set -e
  [ "$status" -ne 0 ] || { echo "selftest: FAIL - the restore test accepted a bad backup" >&2; exit 1; }
  printf '%s' "$output" | grep -q "restore-test: FAIL - .*$expected" \
    || { echo "selftest: FAIL - the restore test failed, but not for the expected reason. Output: $output" >&2; exit 1; }
}

echo "selftest: 4/6 negative control - a backup that does not match its manifest must FAIL (checksum)"
tools legacyai-backup-tools sh -c 'f=$(ls /work/out/*.dump.age); cp "$f" /work/corrupt.dump.age; printf "XXXX" | dd of=/work/corrupt.dump.age bs=1 seek=400 conv=notrunc 2>/dev/null; cp /work/out/*.manifest.json /work/corrupt.manifest.json'
must_fail "checksum mismatch" /work/corrupt.dump.age /work/corrupt.manifest.json 0
echo "selftest: rejected (checksum mismatch)"

echo "selftest: 5/6 negative control - a corrupted backup whose manifest was ALSO forged must FAIL at decryption"
tools legacyai-backup-tools sh -c 'sha=$(sha256sum /work/corrupt.dump.age | cut -d" " -f1); sed -E "s/\"sha256\": \"[0-9a-f]+\"/\"sha256\": \"$sha\"/" /work/corrupt.manifest.json > /work/forged.manifest.json'
must_fail "decrypt or pg_restore failed" /work/corrupt.dump.age /work/forged.manifest.json 0
echo "selftest: rejected (decryption failed)"

echo "selftest: 6/6 negative control - a manifest with a wrong row count must FAIL"
tools legacyai-backup-tools sh -c 'sed -E "s/\"cards\" *: *([0-9]+)/\"cards\": 999999/" /work/out/*.manifest.json > /work/wrong.manifest.json'
must_fail "row counts differ" '/work/out/*.dump.age' /work/wrong.manifest.json 0
echo "selftest: rejected (row counts differ)"

echo "selftest: PASS"
