#!/usr/bin/env bash
# Restore test. A backup that has never been restored is not a backup.
#
# Decrypts a backup, restores it into a NEW, EMPTY database, and checks that what came back
# is what went in. Prints PASS or FAIL and exits non-zero on any problem.
#
# Required environment:
#   BACKUP_FILE            path to legacyai-<time>.dump.age
#   BACKUP_MANIFEST        path to the matching .manifest.json
#   AGE_IDENTITY_FILE      path to the age PRIVATE key file (kept offline; needed only to restore)
#   RESTORE_SUPERUSER_URL  superuser connection to a server that is NOT production, e.g. a
#                          throwaway local PostgreSQL. The three legacyai_* roles must already
#                          exist there (run db/roles/create-roles.sql first).
#   RESTORE_DB_NAME        name of the scratch database to create (letters, digits, _)
# Optional:
#   KEEP_RESTORED_DB=1     leave the restored database in place (to run the audit-chain verifier on it)
set -euo pipefail

: "${BACKUP_FILE:?BACKUP_FILE is required}"
: "${BACKUP_MANIFEST:?BACKUP_MANIFEST is required}"
: "${AGE_IDENTITY_FILE:?AGE_IDENTITY_FILE is required}"
: "${RESTORE_SUPERUSER_URL:?RESTORE_SUPERUSER_URL is required}"
: "${RESTORE_DB_NAME:?RESTORE_DB_NAME is required}"

fail() { echo "restore-test: FAIL - $*" >&2; exit 1; }

echo "$RESTORE_DB_NAME" | grep -Eq '^[a-z][a-z0-9_]{2,40}$' || fail "RESTORE_DB_NAME must be a plain lower-case name"
case "$RESTORE_DB_NAME" in legacyai|postgres|neondb) fail "refusing to restore over a database named $RESTORE_DB_NAME" ;; esac
for f in "$BACKUP_FILE" "$BACKUP_MANIFEST" "$AGE_IDENTITY_FILE"; do [ -s "$f" ] || fail "file missing or empty: $f"; done
for tool in pg_restore psql age sha256sum; do command -v "$tool" >/dev/null 2>&1 || fail "required tool '$tool' is not installed"; done

json() { sed -n "s/.*\"$1\": *\"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}\$/\1/p" "$BACKUP_MANIFEST" | head -1; }
expected_sha="$(json sha256)"
expected_schema="$(json schema_version)"
[ -n "$expected_sha" ] && [ -n "$expected_schema" ] || fail "manifest is missing sha256 or schema_version"

# 1. The file is the one the manifest describes, and it is really encrypted.
actual_sha="$(sha256sum "$BACKUP_FILE" | cut -d' ' -f1)"
[ "$actual_sha" = "$expected_sha" ] || fail "checksum mismatch: the backup file is not the one in the manifest"
head -c 21 "$BACKUP_FILE" | grep -q '^age-encryption.org/v1' || fail "the backup file is not age-encrypted"
[ "$(head -c 5 "$BACKUP_FILE")" != "PGDMP" ] || fail "the backup file is an unencrypted PostgreSQL dump"

admin() { psql "$RESTORE_SUPERUSER_URL" --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 "$@"; }
restored_url="$(echo "$RESTORE_SUPERUSER_URL" | sed -E "s#/[^/?]+(\?.*)?\$#/$RESTORE_DB_NAME\1#")"
in_restored() { psql "$restored_url" --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 "$@"; }

cleanup() {
  if [ "${KEEP_RESTORED_DB:-0}" != "1" ]; then
    admin --command "DROP DATABASE IF EXISTS $RESTORE_DB_NAME WITH (FORCE)" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# 2. Decrypt and restore into a brand-new database.
admin --command "DROP DATABASE IF EXISTS $RESTORE_DB_NAME WITH (FORCE)" >/dev/null
admin --command "CREATE DATABASE $RESTORE_DB_NAME" >/dev/null
age --decrypt --identity "$AGE_IDENTITY_FILE" "$BACKUP_FILE" | pg_restore --dbname "$restored_url" --exit-on-error --no-password \
  || fail "decrypt or pg_restore failed"

# 3. Checks.
schema="$(in_restored --command "SELECT max(version) FROM schema_migrations")"
[ "$schema" = "$expected_schema" ] || fail "schema version is $schema, manifest says $expected_schema"

actual_counts="$(in_restored --command "
  SELECT coalesce(json_object_agg(tablename, n ORDER BY tablename), '{}'::json)
  FROM (
    SELECT tablename,
           (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, tablename), false, true, '')))[1]::text::bigint AS n
    FROM pg_tables WHERE schemaname = 'public'
  ) t")"
expected_counts="$(tr -d '\n' < "$BACKUP_MANIFEST" | sed -E 's/.*"row_counts": *(\{[^}]*\}).*/\1/')"
# (psql only substitutes :'variables' in SQL read from standard input, not in --command)
same="$(echo "SELECT (:'a'::jsonb = :'b'::jsonb)::text" | in_restored --set "a=$actual_counts" --set "b=$expected_counts" 2>/dev/null || true)"
[ "$same" = "true" ] || fail "row counts differ from the manifest. restored=$actual_counts manifest=$expected_counts"

tables="$(in_restored --command "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
[ "$tables" -ge 30 ] || fail "only $tables tables were restored"

# Row-level security must come back FORCED on every tenant table - a restore that lost it would leak across tenants.
unprotected="$(in_restored --command "
  SELECT count(*) FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
     AND c.relname NOT IN ('auth_transactions', 'card_directory', 'login_attempts', 'tenant_usage_counters')  -- global by design
     AND (c.relname = 'tenants' OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped))
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity)")"
[ "$unprotected" = "0" ] || fail "$unprotected tenant tables came back without forced row-level security"

triggers="$(in_restored --command "SELECT count(*) FROM pg_trigger WHERE tgname IN ('audit_log_chain', 'audit_log_append_only', 'audit_log_no_truncate', 'cards_lifecycle', 'cards_directory') AND NOT tgisinternal")"
[ "$triggers" = "5" ] || fail "expected 5 security triggers, found $triggers"

app_can_bypass="$(in_restored --command "SELECT (rolsuper OR rolbypassrls)::text FROM pg_roles WHERE rolname = 'legacyai_app'")"
[ "$app_can_bypass" = "false" ] || fail "legacyai_app is missing or can bypass row-level security on the restore server"

total_rows="$(echo "SELECT coalesce(sum(value::bigint), 0) FROM jsonb_each_text(:'a'::jsonb)" | in_restored --set "a=$actual_counts")"
echo "restore-test: PASS tables=$tables rows=$total_rows schema_version=$schema sha256=$actual_sha"
if [ "${KEEP_RESTORED_DB:-0}" = "1" ]; then
  echo "restore-test: database '$RESTORE_DB_NAME' kept. Next: run the audit-chain verifier against it (npm run audit:verify -- --tenant all)."
fi
