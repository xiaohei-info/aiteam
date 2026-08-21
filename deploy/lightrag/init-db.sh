#!/usr/bin/env bash
# Idempotently provision the LightRAG-only database, role, and pgvector.
# Production/taiyi: run with the admin connection and secrets supplied by the
# environment or a mode-600 env file. Dry-run prints no credentials and makes no changes.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: deploy/lightrag/init-db.sh [--dry-run]

Required (production/taiyi): LIGHTRAG_DB_ADMIN_HOST, LIGHTRAG_DB_ADMIN_PORT,
LIGHTRAG_DB_ADMIN_USER, LIGHTRAG_DB_ADMIN_PASSWORD, LIGHTRAG_DB_NAME,
LIGHTRAG_DB_USER, LIGHTRAG_DB_PASSWORD.
Optional: LIGHTRAG_DB_ADMIN_DATABASE (default postgres).
EOF
}

DRY_RUN=0
while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[lightrag-db][ERR] unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

: "${LIGHTRAG_DB_ADMIN_HOST:=127.0.0.1}"
: "${LIGHTRAG_DB_ADMIN_PORT:=5432}"
: "${LIGHTRAG_DB_ADMIN_DATABASE:=postgres}"
: "${LIGHTRAG_DB_NAME:=lightrag}"
: "${LIGHTRAG_DB_USER:=lightrag}"
: "${LIGHTRAG_DB_ADMIN_USER:=lightrag_admin}"
if (( ! DRY_RUN )); then
  : "${LIGHTRAG_DB_PASSWORD:?LIGHTRAG_DB_PASSWORD is required}"
  : "${LIGHTRAG_DB_ADMIN_PASSWORD:?LIGHTRAG_DB_ADMIN_PASSWORD is required}"
fi

for value_name in LIGHTRAG_DB_NAME LIGHTRAG_DB_USER LIGHTRAG_DB_ADMIN_USER; do
  value="${!value_name}"
  [[ "${value}" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || {
    echo "[lightrag-db][ERR] ${value_name} must be a lower-case PostgreSQL identifier" >&2
    exit 2
  }
done

if (( DRY_RUN )); then
  printf '%s\n' \
    "[lightrag-db][dry-run] would connect to ${LIGHTRAG_DB_ADMIN_HOST}:${LIGHTRAG_DB_ADMIN_PORT}/${LIGHTRAG_DB_ADMIN_DATABASE}" \
    "[lightrag-db][dry-run] would create role ${LIGHTRAG_DB_USER} (password omitted)" \
    "[lightrag-db][dry-run] would create database ${LIGHTRAG_DB_NAME} owned by ${LIGHTRAG_DB_USER}" \
    "[lightrag-db][dry-run] would enable extension vector in ${LIGHTRAG_DB_NAME}"
  exit 0
fi

export PGPASSWORD="${LIGHTRAG_DB_ADMIN_PASSWORD}"
trap 'unset PGPASSWORD' EXIT
psql_admin=(psql -X -v ON_ERROR_STOP=1 -h "${LIGHTRAG_DB_ADMIN_HOST}" -p "${LIGHTRAG_DB_ADMIN_PORT}" -U "${LIGHTRAG_DB_ADMIN_USER}")

# psql variables keep identifiers and passwords out of shell SQL interpolation.
"${psql_admin[@]}" -d "${LIGHTRAG_DB_ADMIN_DATABASE}" \
  -v role_name="${LIGHTRAG_DB_USER}" -v role_password="${LIGHTRAG_DB_PASSWORD}" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role_name', :'role_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'role_name')\gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'role_name', :'role_password')\gexec
SQL

"${psql_admin[@]}" -d "${LIGHTRAG_DB_ADMIN_DATABASE}" \
  -v db_name="${LIGHTRAG_DB_NAME}" -v role_name="${LIGHTRAG_DB_USER}" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I', :'db_name', :'role_name')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db_name')\gexec
SQL

"${psql_admin[@]}" -d "${LIGHTRAG_DB_NAME}" \
  -v db_name="${LIGHTRAG_DB_NAME}" -v role_name="${LIGHTRAG_DB_USER}" <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db_name', :'role_name')\gexec
SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'role_name')\gexec
SQL

unset PGPASSWORD
printf '%s\n' "[lightrag-db] ready: database=${LIGHTRAG_DB_NAME}, role=${LIGHTRAG_DB_USER}, extension=vector"
