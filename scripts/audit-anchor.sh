#!/usr/bin/env bash
# Copies every tenant's latest audit-chain head to a local directory (for local use and tests).
# In the cloud the scheduled job runs the same command with --gcs-bucket instead.
#
# With the heads stored OUTSIDE the database, someone who rewrites the audit log - even
# consistently - can be caught: `npm run audit:verify -- --tenant all --anchors <file>`.
#
# Required environment:
#   ANCHOR_DIR   a local directory to write the anchor file into
#   plus the API's normal environment (DATABASE_URL and the secrets), because the command
#   connects exactly as the API does (application role, row-level security on).
set -euo pipefail

: "${ANCHOR_DIR:?ANCHOR_DIR is required}"
here="$(cd "$(dirname "$0")" && pwd)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$ANCHOR_DIR"
file="$ANCHOR_DIR/anchors-$stamp.jsonl"

( cd "$here/../services/api" && node src/cli/anchor-audit-head.ts --out "$file" )
[ -s "$file" ] || { echo "audit-anchor: no anchor file was produced, or it is empty" >&2; exit 1; }
echo "audit-anchor: OK file=$file lines=$(wc -l < "$file" | tr -d ' ')"
