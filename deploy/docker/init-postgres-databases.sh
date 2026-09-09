#!/bin/sh
# Create the Operator database on a fresh shared PostgreSQL volume.
# The control-plane services still use separate databases and DSNs; this file
# is only a first-boot convenience. CI/ctl also runs an idempotent createdb
# maintenance step for existing volumes.
set -eu

operation_db="${POSTGRES_OPERATION_DB:-oper}"
if [ "${operation_db}" = "${POSTGRES_DB}" ]; then
  echo "POSTGRES_OPERATION_DB must be distinct from POSTGRES_DB" >&2
  exit 1
fi
case "${operation_db}" in
  ''|*[!A-Za-z0-9_]*|[0-9]*) echo "invalid POSTGRES_OPERATION_DB" >&2; exit 1 ;;
esac
createdb --username="${POSTGRES_USER}" "${operation_db}"
