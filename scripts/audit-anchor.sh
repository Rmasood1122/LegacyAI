#!/usr/bin/env bash
# Copies every tenant's latest audit-chain head to the write-once-style anchor bucket.
#
# With the heads stored OUTSIDE the database, someone who rewrites the audit log - even
# consistently - can be caught: `npm run audit:verify -- --tenant all --anchors <file>`.
#
# Required environment:
#   ANCHOR_DEST   a local directory, or gs://bucket/path
#   plus the API's normal environment (DATABASE_URL and the secrets), because the command
#   connects exactly as the API does (application role, row-level security on).
set -euo pipefail

: "${ANCHOR_DEST:?ANCHOR_DEST is required}"
here="$(cd "$(dirname "$0")" && pwd)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
file="$work/anchors-$stamp.jsonl"

( cd "$here/../services/api" && node src/cli/anchor-audit-head.ts --out "$file" --uri-prefix "${ANCHOR_DEST%/}" )
[ -f "$file" ] || { echo "audit-anchor: no anchor file was produced" >&2; exit 1; }

case "$ANCHOR_DEST" in
  gs://*)
    command -v gcloud >/dev/null 2>&1 || { echo "audit-anchor: gcloud is required for a gs:// destination" >&2; exit 2; }
    # --no-clobber: an anchor is never overwritten. The bucket's retention policy stops deletion.
    gcloud storage cp --no-clobber "$file" "${ANCHOR_DEST%/}/"
    ;;
  *)
    mkdir -p "$ANCHOR_DEST"
    cp -n "$file" "$ANCHOR_DEST/"
    ;;
esac
echo "audit-anchor: OK file=anchors-$stamp.jsonl lines=$(wc -l < "$file" | tr -d ' ')"
