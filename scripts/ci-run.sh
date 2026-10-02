#!/usr/bin/env bash
# Runs a command in CI and, if it fails, publishes the last lines of its output as a
# GitHub "error" annotation, so the reason is visible on the run's summary page without
# opening the full log.
#   scripts/ci-run.sh "what this step does" command [args...]
set -uo pipefail
title="$1"; shift
log="$(mktemp)"
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ] && [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  # Annotation messages are single-line: newlines become %0A. Anything secret-looking never
  # reaches here - these steps use throwaway values only.
  tail_text="$(tail -n 45 "$log" | sed -e 's/\x1b\[[0-9;]*m//g' -e 's/%/%25/g' | awk 'BEGIN{ORS="%0A"} {print}')"
  echo "::error title=${title} (exit ${status})::${tail_text}"
fi
rm -f "$log"
exit "$status"
