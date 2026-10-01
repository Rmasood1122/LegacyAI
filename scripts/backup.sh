#!/usr/bin/env bash
# Nightly encrypted database backup.
#
#   pg_dump (all tenants) -> age public-key encryption -> destination
#
# The backup is encrypted with a PUBLIC key. This job never holds the private key, so a
# compromised job or bucket cannot read any backup. The private key stays offline with the
# founder; without it the backups cannot be restored - by design.
#
# Required environment (nothing has a default; a missing value stops the script):
#   DATABASE_URL_BACKUP   connection string of a role that can read every tenant's rows
#   BACKUP_AGE_RECIPIENT  age PUBLIC key (starts with "age1...")
#   BACKUP_DEST           a local directory, or gs://bucket/path
#
# Writes two files:  legacyai-<UTC time>.dump.age   and   legacyai-<UTC time>.manifest.json
set -euo pipefail

: "${DATABASE_URL_BACKUP:?DATABASE_URL_BACKUP is required}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is required}"
: "${BACKUP_DEST:?BACKUP_DEST is required}"

case "$BACKUP_AGE_RECIPIENT" in
  age1*) ;;
  *) echo "backup: BACKUP_AGE_RECIPIENT must be an age PUBLIC key (age1...). Never put a private key here." >&2; exit 2 ;;
esac

for tool in pg_dump psql age sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "backup: required tool '$tool' is not installed" >&2; exit 2; }
done

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
dump="$work/legacyai-$stamp.dump.age"
manifest="$work/legacyai-$stamp.manifest.json"

# Row counts and schema version, taken in the same moment as far as practical. Used by the restore test.
counts="$(psql "$DATABASE_URL_BACKUP" --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 --command "
  SELECT coalesce(json_object_agg(tablename, n ORDER BY tablename), '{}'::json)
  FROM (
    SELECT tablename,
           (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, tablename), false, true, '')))[1]::text::bigint AS n
    FROM pg_tables WHERE schemaname = 'public'
  ) t")"
schema_version="$(psql "$DATABASE_URL_BACKUP" --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 --command "SELECT max(version) FROM schema_migrations")"
[ -n "$counts" ] && [ -n "$schema_version" ] || { echo "backup: could not read row counts or schema version" >&2; exit 1; }

# pipefail makes a pg_dump failure fail the whole pipeline: no half-written backup is ever uploaded.
pg_dump --format=custom --no-password "$DATABASE_URL_BACKUP" | age --recipient "$BACKUP_AGE_RECIPIENT" --output "$dump"

size="$(wc -c < "$dump" | tr -d ' ')"
[ "$size" -gt 1000 ] || { echo "backup: the encrypted dump is suspiciously small ($size bytes)" >&2; exit 1; }
head -c 21 "$dump" | grep -q '^age-encryption.org/v1' || { echo "backup: output is not an age file" >&2; exit 1; }
sha="$(sha256sum "$dump" | cut -d' ' -f1)"

cat > "$manifest" <<EOF
{
  "created_at": "$stamp",
  "file": "legacyai-$stamp.dump.age",
  "size_bytes": $size,
  "sha256": "$sha",
  "schema_version": "$schema_version",
  "encryption": "age (public key)",
  "row_counts": $counts
}
EOF

case "$BACKUP_DEST" in
  gs://*)
    command -v gcloud >/dev/null 2>&1 || { echo "backup: gcloud is required for a gs:// destination" >&2; exit 2; }
    prefix="${BACKUP_DEST%/}/$(date -u +%Y/%m/%d)"
    # --no-clobber: never overwrite an existing backup.
    gcloud storage cp --no-clobber "$dump" "$prefix/"
    gcloud storage cp --no-clobber "$manifest" "$prefix/"
    ;;
  *)
    mkdir -p "$BACKUP_DEST"
    cp -n "$dump" "$manifest" "$BACKUP_DEST/"
    ;;
esac

echo "backup: OK file=legacyai-$stamp.dump.age size_bytes=$size sha256=$sha schema_version=$schema_version"
