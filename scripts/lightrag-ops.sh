#!/usr/bin/env bash
# LightRAG storage operations. No command mutates data unless explicitly asked.
# Production/taiyi callers must use a mode-600 env file and --yes for restore/rollout.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT}/deploy/docker/docker-compose.yml"
ENV_FILE=""
DRY_RUN=0
YES=0

usage() {
  cat <<'EOF'
Usage: scripts/lightrag-ops.sh [--env-file FILE] [--dry-run] COMMAND [options]

Commands:
  backup  [--output FILE]             pg_dump custom-format backup
  restore --input FILE --yes         stop writer, restore, then start it
  upgrade --image IMAGE [--yes]       backup, pull pinned image, restart writer
  rollback --image IMAGE --yes       backup, switch to a pinned prior image, restart

Run --dry-run first. backup/restore use LIGHTRAG_DB_HOST/PORT/NAME/USER/PASSWORD
and do not print the password. IMAGE must use a version tag or sha256 digest; latest is rejected.
EOF
}

while (($#)); do
  case "$1" in
    --env-file)
      [[ $# -ge 2 ]] || { echo "[lightrag-ops][ERR] --env-file needs FILE" >&2; exit 2; }
      ENV_FILE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes) YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) break ;;
  esac
done

if [[ -n "${ENV_FILE}" ]]; then
  [[ -r "${ENV_FILE}" ]] || { echo "[lightrag-ops][ERR] unreadable env file: ${ENV_FILE}" >&2; exit 1; }
  set -a
  # shellcheck source=/dev/null
  source "${ENV_FILE}"
  set +a
fi

COMMAND="${1:-}"
[[ -n "${COMMAND}" ]] || { usage >&2; exit 2; }
shift || true

OUTPUT=""
INPUT=""
IMAGE=""
while (($#)); do
  case "$1" in
    --output) [[ $# -ge 2 ]] || { echo "[lightrag-ops][ERR] --output needs FILE" >&2; exit 2; }; OUTPUT="$2"; shift 2 ;;
    --input) [[ $# -ge 2 ]] || { echo "[lightrag-ops][ERR] --input needs FILE" >&2; exit 2; }; INPUT="$2"; shift 2 ;;
    --image) [[ $# -ge 2 ]] || { echo "[lightrag-ops][ERR] --image needs IMAGE" >&2; exit 2; }; IMAGE="$2"; shift 2 ;;
    --yes) YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "[lightrag-ops][ERR] unknown argument: $1" >&2; exit 2 ;;
  esac
done

: "${LIGHTRAG_DB_HOST:=127.0.0.1}"
: "${LIGHTRAG_DB_PORT:=5432}"
: "${LIGHTRAG_DB_NAME:=lightrag}"
: "${LIGHTRAG_DB_USER:=lightrag}"
: "${LIGHTRAG_DB_PASSWORD:=}"
: "${LIGHTRAG_SERVICE:=lightrag}"
: "${LIGHTRAG_BACKUP_DIR:=/var/backups/aiteam/lightrag}"
: "${LIGHTRAG_PG_CLIENT_CONTAINER:=}"
: "${LIGHTRAG_CLIENT_DB_HOST:=${LIGHTRAG_DB_HOST}}"
: "${LIGHTRAG_CLIENT_DB_PORT:=${LIGHTRAG_DB_PORT}}"

valid_image() {
  local image="$1"
  [[ -n "${image}" && "${image}" != *:latest && "${image}" != */latest && "${image}" != *:dev && "${image}" != *:test && "${image}" != *:edge ]] || return 1
  [[ "${image}" =~ (:[[:alnum:]][[:alnum:]._-]*|@sha256:[a-f0-9]{64})$ ]]
}

require_yes() {
  if (( ! YES && ! DRY_RUN )); then
    echo "[lightrag-ops][ERR] destructive operation requires --yes (or use --dry-run)" >&2
    exit 2
  fi
}

require_secret_env_file() {
  (( DRY_RUN )) && return 0
  [[ -n "${ENV_FILE}" ]] || { echo "[lightrag-ops][ERR] real release operations require --env-file" >&2; exit 2; }
  local mode
  mode="$(stat -c '%a' "${ENV_FILE}" 2>/dev/null || stat -f '%Lp' "${ENV_FILE}")"
  [[ "${mode}" == "600" ]] || { echo "[lightrag-ops][ERR] env file must be mode 600" >&2; exit 1; }
}

compose() {
  docker compose -f "${COMPOSE_FILE}" --profile lightrag "$@"
}

persist_image() {
  [[ -n "${ENV_FILE}" ]] || {
    echo "[lightrag-ops][ERR] real upgrade/rollback requires --env-file so the image pin survives restart" >&2
    exit 2
  }
  python3 - "${ENV_FILE}" "${IMAGE}" <<'PY'
from pathlib import Path
import os
import sys

path = Path(sys.argv[1])
image = sys.argv[2]
lines = path.read_text().splitlines(keepends=True)
replacement = f"LIGHTRAG_IMAGE={image}\\n"
for index, line in enumerate(lines):
    if line.startswith("LIGHTRAG_IMAGE="):
        lines[index] = replacement
        break
else:
    lines.append(replacement)
mode = os.stat(path).st_mode
path.write_text("".join(lines))
os.chmod(path, mode)
PY
}

backup_path() {
  if [[ -n "${OUTPUT}" ]]; then
    printf '%s\n' "${OUTPUT}"
  else
    if (( DRY_RUN )); then
      printf '%s/lightrag-<utc-timestamp>.dump\n' "${LIGHTRAG_BACKUP_DIR}"
    else
      mkdir -p "${LIGHTRAG_BACKUP_DIR}"
      printf '%s/lightrag-%s.dump\n' "${LIGHTRAG_BACKUP_DIR}" "$(date -u +%Y%m%dT%H%M%SZ)"
    fi
  fi
}

run_backup() {
  local output="$1"
  if (( DRY_RUN )); then
    printf '%s\n' "[lightrag-ops][dry-run] pg_dump --format=custom --no-owner --file=${output} ${LIGHTRAG_DB_HOST}:${LIGHTRAG_DB_PORT}/${LIGHTRAG_DB_NAME} (password omitted)"
    return 0
  fi
  [[ -n "${LIGHTRAG_DB_PASSWORD}" ]] || { echo "[lightrag-ops][ERR] LIGHTRAG_DB_PASSWORD is required" >&2; exit 1; }
  mkdir -p "$(dirname "${output}")"
  if command -v pg_dump >/dev/null 2>&1; then
    PGPASSWORD="${LIGHTRAG_DB_PASSWORD}" pg_dump \
      --format=custom --no-owner --no-privileges \
      --host="${LIGHTRAG_DB_HOST}" --port="${LIGHTRAG_DB_PORT}" \
      --username="${LIGHTRAG_DB_USER}" --dbname="${LIGHTRAG_DB_NAME}" \
      --file="${output}"
  elif [[ -n "${LIGHTRAG_PG_CLIENT_CONTAINER}" ]]; then
    docker exec -e "PGPASSWORD=${LIGHTRAG_DB_PASSWORD}" "${LIGHTRAG_PG_CLIENT_CONTAINER}" \
      pg_dump --format=custom --no-owner --no-privileges \
      --host="${LIGHTRAG_CLIENT_DB_HOST}" --port="${LIGHTRAG_CLIENT_DB_PORT}" \
      --username="${LIGHTRAG_DB_USER}" --dbname="${LIGHTRAG_DB_NAME}" >"${output}"
  else
    echo "[lightrag-ops][ERR] pg_dump is not installed; set LIGHTRAG_PG_CLIENT_CONTAINER" >&2
    exit 1
  fi
  chmod 600 "${output}"
  printf '%s\n' "[lightrag-ops] backup written: ${output}"
}

case "${COMMAND}" in
  backup)
    require_secret_env_file
    run_backup "$(backup_path)"
    ;;
  restore)
    [[ -n "${INPUT}" && -f "${INPUT}" ]] || { echo "[lightrag-ops][ERR] --input must name an existing dump" >&2; exit 2; }
    require_yes
    require_secret_env_file
    if (( DRY_RUN )); then
      printf '%s\n' "[lightrag-ops][dry-run] stop ${LIGHTRAG_SERVICE}; pg_restore --clean --if-exists ${INPUT}; start ${LIGHTRAG_SERVICE}"
    else
      [[ -n "${LIGHTRAG_DB_PASSWORD}" ]] || { echo "[lightrag-ops][ERR] LIGHTRAG_DB_PASSWORD is required" >&2; exit 1; }
      compose stop "${LIGHTRAG_SERVICE}"
      if command -v pg_restore >/dev/null 2>&1; then
        PGPASSWORD="${LIGHTRAG_DB_PASSWORD}" pg_restore \
          --clean --if-exists --no-owner --no-privileges --exit-on-error \
          --host="${LIGHTRAG_DB_HOST}" --port="${LIGHTRAG_DB_PORT}" \
          --username="${LIGHTRAG_DB_USER}" --dbname="${LIGHTRAG_DB_NAME}" "${INPUT}"
      elif [[ -n "${LIGHTRAG_PG_CLIENT_CONTAINER}" ]]; then
        docker exec -i -e "PGPASSWORD=${LIGHTRAG_DB_PASSWORD}" "${LIGHTRAG_PG_CLIENT_CONTAINER}" \
          pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error \
          --host="${LIGHTRAG_CLIENT_DB_HOST}" --port="${LIGHTRAG_CLIENT_DB_PORT}" \
          --username="${LIGHTRAG_DB_USER}" --dbname="${LIGHTRAG_DB_NAME}" <"${INPUT}"
      else
        echo "[lightrag-ops][ERR] pg_restore is not installed; set LIGHTRAG_PG_CLIENT_CONTAINER" >&2
        exit 1
      fi
      compose up -d "${LIGHTRAG_SERVICE}"
      echo "[lightrag-ops] restore complete"
    fi
    ;;
  upgrade|rollback)
    valid_image "${IMAGE}" || { echo "[lightrag-ops][ERR] --image must use a fixed version tag or sha256 digest (not latest/dev/test)" >&2; exit 2; }
    require_yes
    require_secret_env_file
    backup="$(backup_path)"
    if (( DRY_RUN )); then
      printf '%s\n' "[lightrag-ops][dry-run] backup -> ${backup}" \
        "[lightrag-ops][dry-run] ${COMMAND}: pull ${IMAGE}; stop ${LIGHTRAG_SERVICE}; start with pinned image under --profile lightrag"
    else
      run_backup "${backup}"
      export LIGHTRAG_IMAGE="${IMAGE}"
      compose pull "${LIGHTRAG_SERVICE}"
      persist_image
      compose up -d --no-deps "${LIGHTRAG_SERVICE}"
      printf '%s\n' "[lightrag-ops] ${COMMAND} complete: ${IMAGE}; backup=${backup}"
    fi
    ;;
  *) echo "[lightrag-ops][ERR] unsupported command: ${COMMAND}" >&2; usage >&2; exit 2 ;;
esac
