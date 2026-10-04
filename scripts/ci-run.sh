#!/usr/bin/env bash
# Runs a command in CI and publishes what happened on the run's summary page:
#   - on failure: the last lines of its output, as an "error" annotation;
#   - on success: the result lines matching $EVIDENCE (a grep -E pattern), as a "notice".
# The annotations make the evidence readable without opening the full log.
#   EVIDENCE='^Tests|PASS' scripts/ci-run.sh "what this step does" command [args...]
set -uo pipefail
title="$1"; shift
log="$(mktemp)"
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  # Annotation messages are single-line: newlines become %0A. These steps use throwaway values only.
  clean() { sed -e 's/\x1b\[[0-9;]*m//g' -e 's/%/%25/g' | awk 'BEGIN{ORS="%0A"} {print}'; }
  if [ "$status" -ne 0 ]; then
    # First the names of what failed and the error lines (a long warnings section can push them out of the tail), then the tail.
    echo "::error title=${title} (exit ${status})::$({ grep -aE '^(FAILED|ERROR) |^E   ' "$log" | cut -c1-400 | head -n 30; echo '--- last lines ---'; tail -n 45 "$log"; } | clean)"
  elif [ -n "${EVIDENCE:-}" ]; then
    echo "::notice title=${title}::$(grep -aE -- "$EVIDENCE" "$log" | tail -n 40 | cut -c1-600 | clean)"
  fi
fi
rm -f "$log"
exit "$status"
