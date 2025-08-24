#!/usr/bin/env bash
set -euo pipefail

# Reset the PostgreSQL database and install PGroonga, then apply Prisma schema and create indexes.
# WARNING: This script DROPS the target database. Run only if you intend to recreate from scratch.

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set (in environment or .env)." >&2
  exit 1
fi

readarray -t DBINFO < <(node --input-type=module -e '
  const u = new URL(process.env.DATABASE_URL);
  const db = (u.pathname || "/").replace(/^\//, "").split("?")[0] || "postgres";
  const host = u.hostname || "127.0.0.1";
  const port = u.port || "5432";
  const user = decodeURIComponent(u.username || "");
  console.log(db); console.log(host); console.log(port); console.log(user);
')

DB_NAME="${DBINFO[0]}"
PGHOST="${DBINFO[1]}"
PGPORT="${DBINFO[2]}"
DB_USER="${DBINFO[3]}"

echo "Target database: $DB_NAME on $PGHOST:$PGPORT"

echo "Terminating existing connections..."
sudo -u postgres psql -p "$PGPORT" -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB_NAME}' AND pid <> pg_backend_pid();" || true

echo "Dropping database if exists..."
sudo -u postgres psql -p "$PGPORT" -d postgres -v ON_ERROR_STOP=1 -c \
  "DROP DATABASE IF EXISTS \"${DB_NAME}\";"

echo "Creating database..."
sudo -u postgres psql -p "$PGPORT" -d postgres -v ON_ERROR_STOP=1 -c \
  "CREATE DATABASE \"${DB_NAME}\";"

if [ -n "$DB_USER" ]; then
  echo "Transferring ownership of database to role: $DB_USER"
  sudo -u postgres psql -p "$PGPORT" -d postgres -v ON_ERROR_STOP=1 -c \
    "ALTER DATABASE \"${DB_NAME}\" OWNER TO \"${DB_USER}\";" || true
fi

echo "Installing PGroonga extension..."
sudo -u postgres psql -p "$PGPORT" -d "$DB_NAME" -v ON_ERROR_STOP=1 -c \
  "CREATE EXTENSION IF NOT EXISTS pgroonga;"

if [ -n "$DB_USER" ]; then
  echo "Granting privileges on schema public to role: $DB_USER"
  sudo -u postgres psql -p "$PGPORT" -d "$DB_NAME" -v ON_ERROR_STOP=1 -c \
    "REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT ALL ON SCHEMA public TO \"${DB_USER}\"; ALTER SCHEMA public OWNER TO \"${DB_USER}\";"
  sudo -u postgres psql -p "$PGPORT" -d "$DB_NAME" -v ON_ERROR_STOP=1 -c \
    "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO \"${DB_USER}\"; GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO \"${DB_USER}\";"
  sudo -u postgres psql -p "$PGPORT" -d "$DB_NAME" -v ON_ERROR_STOP=1 -c \
    "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO \"${DB_USER}\"; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO \"${DB_USER}\";"
fi

echo "Generating Prisma client..."
npm run --silent db:generate

echo "Applying Prisma migrations (functions, etc.)..."
npx --yes prisma migrate deploy

echo "Syncing Prisma schema (creating tables/columns)..."
npx --yes prisma db push --skip-generate --accept-data-loss

echo "Creating PGroonga and related indexes..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/scripts/create-pgroonga-indexes.sql"

echo "Verifying: extensions and indexes"
sudo -u postgres psql -p "$PGPORT" -d "$DB_NAME" -c \
  "SELECT extname FROM pg_extension WHERE extname IN ('pgroonga');"
psql "$DATABASE_URL" -c \
  "SELECT schemaname, tablename, indexname FROM pg_indexes WHERE tablename IN ('PageVersion','User') ORDER BY 1,2,3;"

echo "All done. You can now run Phase A/B/C syncs to repopulate data."


