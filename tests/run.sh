#!/usr/bin/env bash
# Runs the integration tests against a real, throwaway local Postgres (no Netlify account needed).
# Needs PostgreSQL server binaries and psql. Set STOP_PG=1 to shut the test server down afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."
PGBIN=$(ls -d /usr/lib/postgresql/*/bin | tail -1)
DIR=${TEST_PG_DIR:-/tmp/tcg-test-pg}; SOCK=/tmp/tcg-test-sock
as_pg() { if [ "$(id -u)" = 0 ]; then su postgres -c "$1"; else bash -c "$1"; fi; }
mkdir -p "$DIR" "$SOCK"; [ "$(id -u)" = 0 ] && chown postgres "$DIR" "$SOCK" || true
[ -f "$DIR/PG_VERSION" ] || as_pg "$PGBIN/initdb -D $DIR -A trust -U postgres >/dev/null"
"$PGBIN/pg_isready" -h "$SOCK" -q || as_pg "$PGBIN/pg_ctl -D $DIR -o \"-k $SOCK -c listen_addresses=''\" -l $DIR/log -w start >/dev/null"
export PGHOST=$SOCK PGUSER=postgres
psql -X -q -d postgres -c "DROP DATABASE IF EXISTS tcgtest" -c "CREATE DATABASE tcgtest"
export PGDATABASE=tcgtest
for f in netlify/database/migrations/*.sql; do psql -X -q -v ON_ERROR_STOP=1 -f "$f"; done
echo "migrations applied"
rc=0; node --experimental-strip-types --no-warnings --import ./tests/register.mjs tests/run.mjs || rc=$?
[ "${STOP_PG:-0}" = 1 ] && as_pg "$PGBIN/pg_ctl -D $DIR stop -m fast >/dev/null" || true
exit $rc
