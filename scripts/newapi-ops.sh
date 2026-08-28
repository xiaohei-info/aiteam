#!/usr/bin/env bash
# Internal NewAPI backup/restore and pinned-image rollout. Secrets are never printed.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT}/deploy/docker/docker-compose.yml"
ENV_FILE=""
DRY_RUN=0
YES=0

usage() {
  cat <<'EOF'
Usage: scripts/newapi-ops.sh [--env-file FILE] [--dry-run] COMMAND [options]

Commands:
  backup  [--output FILE]
  restore --input FILE --yes
  upgrade --image PINNED_IMAGE --yes
  rollback --image PINNED_IMAGE --yes
EOF
}

while (($#)); do
  case "$1" in
    --env-file) [[ $# -ge 2 ]] || exit 2; ENV_FILE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes) YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) break ;;
  esac
done

if [[ -n "${ENV_FILE}" ]]; then
  [[ -r "${ENV_FILE}" ]] || { echo "[newapi-ops][ERR] unreadable env file" >&2; exit 1; }
  set -a
  # shellcheck source=/dev/null
  source "${ENV_FILE}"
  set +a
fi

COMMAND="${1:-}"
[[ -n "${COMMAND}" ]] || { usage >&2; exit 2; }
shift || true
OUTPUT="" INPUT="" IMAGE=""
while (($#)); do
  case "$1" in
    --output) [[ $# -ge 2 ]] || exit 2; OUTPUT="$2"; shift 2 ;;
    --input) [[ $# -ge 2 ]] || exit 2; INPUT="$2"; shift 2 ;;
    --image) [[ $# -ge 2 ]] || exit 2; IMAGE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes) YES=1; shift ;;
    *) echo "[newapi-ops][ERR] unknown argument: $1" >&2; exit 2 ;;
  esac
done

: "${NEWAPI_DB_USER:=newapi}"
: "${NEWAPI_DB_PASSWORD:=}"
: "${NEWAPI_DB_NAME:=newapi}"
: "${NEWAPI_PG_CONTAINER:=aiteam-newapi-pg}"
: "${NEWAPI_SERVICE:=newapi}"
: "${NEWAPI_BACKUP_DIR:=/var/backups/aiteam/newapi}"

compose() { docker compose -f "${COMPOSE_FILE}" --profile newapi "$@"; }
valid_image() {
  [[ -n "$1" && "$1" != *:latest && "$1" != *:dev && "$1" != *:test && "$1" != *:edge ]] || return 1
  [[ "$1" =~ (:[[:alnum:]][[:alnum:]._-]*|@sha256:[a-f0-9]{64})$ ]]
}
require_real_env() {
  (( DRY_RUN )) && return 0
  [[ -n "${ENV_FILE}" ]] || { echo "[newapi-ops][ERR] real operations require --env-file" >&2; exit 2; }
  mode="$(stat -c '%a' "${ENV_FILE}" 2>/dev/null || stat -f '%Lp' "${ENV_FILE}")"
  [[ "${mode}" == "600" ]] || { echo "[newapi-ops][ERR] env file must be mode 600" >&2; exit 1; }
  [[ -n "${NEWAPI_DB_PASSWORD}" ]] || { echo "[newapi-ops][ERR] NEWAPI_DB_PASSWORD is required" >&2; exit 1; }
}
require_yes() {
  (( YES || DRY_RUN )) || { echo "[newapi-ops][ERR] destructive operation requires --yes" >&2; exit 2; }
}
backup_path() {
  if [[ -n "${OUTPUT}" ]]; then printf '%s\n' "${OUTPUT}"
  elif (( DRY_RUN )); then printf '%s/newapi-<utc-timestamp>.dump\n' "${NEWAPI_BACKUP_DIR}"
  else mkdir -p "${NEWAPI_BACKUP_DIR}"; printf '%s/newapi-%s.dump\n' "${NEWAPI_BACKUP_DIR}" "$(date -u +%Y%m%dT%H%M%SZ)"
  fi
}
run_backup() {
  local output="$1"
  if (( DRY_RUN )); then
    echo "[newapi-ops][dry-run] docker exec ${NEWAPI_PG_CONTAINER} pg_dump --format=custom --no-owner --file=${output} (password omitted)"
    return
  fi
  mkdir -p "$(dirname "${output}")"
  docker exec -e "PGPASSWORD=${NEWAPI_DB_PASSWORD}" "${NEWAPI_PG_CONTAINER}" \
    pg_dump --format=custom --no-owner --no-privileges --username="${NEWAPI_DB_USER}" --dbname="${NEWAPI_DB_NAME}" >"${output}"
  chmod 600 "${output}"
  echo "[newapi-ops] backup written: ${output}"
}
persist_image() {
  python3 - "${ENV_FILE}" "${IMAGE}" <<'PY'
from pathlib import Path
import os, sys
path, image = Path(sys.argv[1]), sys.argv[2]
lines = path.read_text().splitlines(keepends=True)
replacement = f"NEWAPI_IMAGE={image}\n"
for index, line in enumerate(lines):
    if line.startswith("NEWAPI_IMAGE="):
        lines[index] = replacement
        break
else:
    lines.append(replacement)
mode = os.stat(path).st_mode
path.write_text("".join(lines))
os.chmod(path, mode)
PY
}

case "${COMMAND}" in
  backup)
    require_real_env
    run_backup "$(backup_path)"
    ;;
  restore)
    [[ -n "${INPUT}" && ( ${DRY_RUN} -eq 1 || -f "${INPUT}" ) ]] || { echo "[newapi-ops][ERR] --input must name a dump" >&2; exit 2; }
    require_yes; require_real_env
    if (( DRY_RUN )); then
      echo "[newapi-ops][dry-run] stop ${NEWAPI_SERVICE}; pg_restore --clean --if-exists ${INPUT}; start ${NEWAPI_SERVICE}"
    else
      compose stop "${NEWAPI_SERVICE}"
      docker exec -i -e "PGPASSWORD=${NEWAPI_DB_PASSWORD}" "${NEWAPI_PG_CONTAINER}" \
        pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error \
        --username="${NEWAPI_DB_USER}" --dbname="${NEWAPI_DB_NAME}" <"${INPUT}"
      compose up -d "${NEWAPI_SERVICE}"
      echo "[newapi-ops] restore complete"
    fi
    ;;
  upgrade|rollback)
    valid_image "${IMAGE}" || { echo "[newapi-ops][ERR] --image must use a fixed tag or sha256 digest" >&2; exit 2; }
    require_yes; require_real_env
    backup="$(backup_path)"
    if (( DRY_RUN )); then
      printf '%s\n' "[newapi-ops][dry-run] backup -> ${backup}" "[newapi-ops][dry-run] ${COMMAND}: pull ${IMAGE}; restart ${NEWAPI_SERVICE}"
    else
      run_backup "${backup}"
      export NEWAPI_IMAGE="${IMAGE}"
      compose pull "${NEWAPI_SERVICE}"
      persist_image
      compose up -d --no-deps "${NEWAPI_SERVICE}"
      echo "[newapi-ops] ${COMMAND} complete: ${IMAGE}; backup=${backup}"
    fi
    ;;
  *) echo "[newapi-ops][ERR] unsupported command: ${COMMAND}" >&2; exit 2 ;;
esac
