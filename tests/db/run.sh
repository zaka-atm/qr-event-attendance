#!/usr/bin/env bash
# Crea una base de datos desechable, aplica la migración y ejecuta las pruebas.
# Requiere un Postgres local (16+). Ejemplo:
#   PGHOST=localhost PGPORT=5432 PGUSER=postgres ./tests/db/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

DB=${TEST_DB:-qr_test}
dropdb --if-exists "$DB"
createdb "$DB"

PSQL="psql -v ON_ERROR_STOP=1 -q -d $DB"
$PSQL -f tests/db/supabase_stub.sql
$PSQL -f supabase/migrations/20260924000000_init.sql
$PSQL -f tests/db/test_flow.sql
PSQL="$PSQL" bash tests/db/test_concurrency.sh
