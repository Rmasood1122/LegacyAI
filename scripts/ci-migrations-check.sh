#!/usr/bin/env bash
# Migration check, run in CI (and locally):
#   1. empty database -> apply all -> roll back all (nothing left) -> apply all, with dbmate
#   2. the same with the built-in runner
#   3. the two resulting schemas must be identical
# Run from services/api. Needs the docker-compose database and the DATABASE_URL_* variables.
set -euo pipefail

setup="node ../../scripts/db-setup.mjs"
pg="docker exec legacyai-postgres"
db="$(node -e "console.log(new URL(process.env.DATABASE_URL_ADMIN).pathname.slice(1))")"

leftovers() {
  $pg psql -U postgres -d "$db" -At -c "
    SELECT (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations')
         + (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
              AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e'))  -- extension functions (pgvector) are not ours
         + (SELECT count(*) FROM schema_migrations)"
}
schema() { $pg pg_dump -U postgres -d "$db" --schema-only --no-owner --no-comments | grep -v '^\\\(un\)\{0,1\}restrict' ; }

cycle() { # $1 = engine
  echo "migrations: [$1] reset (roles + apply all)"
  MIGRATION_ENGINE="$1" $setup reset
  applied="$($pg psql -U postgres -d "$db" -At -c 'SELECT count(*) FROM schema_migrations')"
  files="$(ls ../../db/migrations/*.sql | wc -l | tr -d ' ')"
  [ "$applied" = "$files" ] || { echo "migrations: FAIL [$1] applied $applied of $files migrations" >&2; exit 1; }
  echo "migrations: [$1] roll back all"
  MIGRATION_ENGINE="$1" $setup down-all
  left="$(leftovers)"
  [ "$left" = "0" ] || { echo "migrations: FAIL [$1] rollback left $left objects behind" >&2; exit 1; }
  echo "migrations: [$1] re-apply"
  MIGRATION_ENGINE="$1" $setup up
  schema > "${TMPDIR:-/tmp}/legacyai-schema-$1.sql"
  echo "migrations: [$1] OK applied=$files rolled_back=$files leftover_objects=0"
}

# Which engines can run here? REQUIRE_DBMATE=1 (set in CI) makes a missing dbmate a failure,
# so the comparison below can never be skipped silently.
engines="builtin"
if [ "$($setup engine)" = "dbmate" ]; then
  engines="dbmate builtin"
elif [ "${REQUIRE_DBMATE:-0}" = "1" ]; then
  echo "migrations: FAIL dbmate is required here but its binary cannot be executed" >&2
  exit 1
fi
for e in $engines; do cycle "$e"; done

if [ "$engines" = "dbmate builtin" ]; then
  if ! diff -q "${TMPDIR:-/tmp}/legacyai-schema-dbmate.sql" "${TMPDIR:-/tmp}/legacyai-schema-builtin.sql" >/dev/null; then
    echo "migrations: FAIL the built-in runner and dbmate produce different schemas" >&2
    diff "${TMPDIR:-/tmp}/legacyai-schema-dbmate.sql" "${TMPDIR:-/tmp}/legacyai-schema-builtin.sql" | head -40 >&2
    exit 1
  fi
  echo "migrations: dbmate and the built-in runner produce identical schemas"
else
  echo "migrations: NOTE dbmate could not be executed on this machine; only the built-in runner was checked"
fi
echo "migrations: PASS"
