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

# A stray newline or space (easy to get when pasting into a secret) must not break the connection.
DATABASE_URL_BACKUP="$(printf '%s' "$DATABASE_URL_BACKUP" | tr -d '[:space:]')"
BACKUP_AGE_RECIPIENT="$(printf '%s' "$BACKUP_AGE_RECIPIENT" | tr -d '[:space:]')"

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

# Row counts, schema version and the dump all come from ONE database snapshot, so the manifest
# describes exactly what is in the dump even while the API keeps writing.
# A psql session stays open holding the snapshot; pg_dump is told to use the same one.
coproc SNAP { psql "$DATABASE_URL_BACKUP" --no-psqlrc --quiet --tuples-only --no-align --set ON_ERROR_STOP=1; }
ask() { printf '%s\n' "$1" >&"${SNAP[1]}"; IFS= read -r -t 120 reply <&"${SNAP[0]}" || { echo "backup: the database did not answer" >&2; exit 1; }; printf '%s' "$reply"; }
printf '%s\n' "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;" >&"${SNAP[1]}"
snapshot="$(ask "SELECT pg_export_snapshot();")"
counts="$(ask "SELECT coalesce(json_object_agg(tablename, n ORDER BY tablename), '{}'::json)::text FROM (SELECT tablename, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, tablename), false, true, '')))[1]::text::bigint AS n FROM pg_tables WHERE schemaname = 'public') t;")"
schema_version="$(ask "SELECT max(version) FROM schema_migrations;")"
case "$snapshot" in *-*) ;; *) echo "backup: could not export a database snapshot" >&2; exit 1 ;; esac
case "$counts" in \{*\}) ;; *) echo "backup: could not read row counts" >&2; exit 1 ;; esac
[ -n "$schema_version" ] || { echo "backup: could not read the schema version" >&2; exit 1; }

# pipefail makes a pg_dump failure fail the whole pipeline: no half-written backup is ever uploaded.
pg_dump --format=custom --no-password --snapshot="$snapshot" "$DATABASE_URL_BACKUP" | age --recipient "$BACKUP_AGE_RECIPIENT" --output "$dump"
printf '%s\n' "COMMIT;" '\q' >&"${SNAP[1]}" || true
wait "$SNAP_PID" 2>/dev/null || true

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

# Uploads one file to Cloud Storage with plain curl, using the identity of the Cloud Run job
# (no gcloud needed, which keeps the tools image small). ifGenerationMatch=0 means
# "only if the object does not exist yet": an existing backup is never overwritten.
# NOT PROVEN LOCALLY: this path needs a real Google Cloud job to run. See docs/phase1/REPORT.md.
gcs_put() { # $1 = local file, $2 = gs://bucket/object
  rest="${2#gs://}"; bucket="${rest%%/*}"; object="${rest#*/}"
  token="$(curl --silent --fail --header 'Metadata-Flavor: Google' \
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' \
    | sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p')"
  [ -n "$token" ] || { echo "backup: could not get an access token from the metadata server" >&2; exit 1; }
  encoded="$(printf '%s' "$object" | sed 's#/#%2F#g')"
  # --upload-file streams the file from disk instead of loading it into memory.
  curl --silent --show-error --fail --request POST --upload-file "$1" \
    --header "Authorization: Bearer $token" --header 'Content-Type: application/octet-stream' \
    "https://storage.googleapis.com/upload/storage/v1/b/$bucket/o?uploadType=media&ifGenerationMatch=0&name=$encoded" >/dev/null \
    || { echo "backup: upload of $(basename "$1") failed" >&2; exit 1; }
}

case "$BACKUP_DEST" in
  gs://*)
    command -v curl >/dev/null 2>&1 || { echo "backup: curl is required for a gs:// destination" >&2; exit 2; }
    prefix="${BACKUP_DEST%/}/$(date -u +%Y/%m/%d)"
    gcs_put "$dump" "$prefix/$(basename "$dump")"
    gcs_put "$manifest" "$prefix/$(basename "$manifest")"
    ;;
  *)
    mkdir -p "$BACKUP_DEST"
    cp -n "$dump" "$manifest" "$BACKUP_DEST/"
    ;;
esac

echo "backup: OK file=legacyai-$stamp.dump.age size_bytes=$size sha256=$sha schema_version=$schema_version"
