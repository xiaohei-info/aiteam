#!/usr/bin/env bash
# Validate Manager-side LightRAG settings without contacting the service.
# Use --production on taiyi/production; --dry-run is equivalent to a non-mutating check.
set -euo pipefail

usage() {
  printf '%s\n' \
    'Usage: scripts/validate-lightrag-env.sh [--production] [--env-file FILE]' \
    'Required in production: LIGHTRAG_URL LIGHTRAG_API_KEY LIGHTRAG_WORKSPACE LIGHTRAG_IMAGE' \
    'Required for bootstrap: LIGHTRAG_DB_* values are checked by deploy/lightrag/init-db.sh.'
}

PRODUCTION=0
ENV_FILE=""
while (($#)); do
  case "$1" in
    --production) PRODUCTION=1; shift ;;
    --env-file)
      [[ $# -ge 2 ]] || { echo "[lightrag-env][ERR] --env-file needs FILE" >&2; exit 2; }
      ENV_FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[lightrag-env][ERR] unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -n "${ENV_FILE}" ]]; then
  [[ -r "${ENV_FILE}" ]] || { echo "[lightrag-env][ERR] env file is not readable: ${ENV_FILE}" >&2; exit 1; }
  set -a
  # shellcheck source=/dev/null
  source "${ENV_FILE}"
  set +a
fi

error_count=0
required() {
  local name="$1" value="${!1:-}"
  if [[ -z "${value}" ]]; then
    echo "[lightrag-env][ERR] ${name} is required" >&2
    ((error_count += 1))
  fi
}

if (( PRODUCTION )); then
  required LIGHTRAG_URL
  required LIGHTRAG_API_KEY
  required LIGHTRAG_WORKSPACE
  required LIGHTRAG_IMAGE
fi

url="${LIGHTRAG_URL:-}"
if [[ -n "${url}" && ! "${url}" =~ ^https?://[^[:space:]]+$ ]]; then
  echo "[lightrag-env][ERR] LIGHTRAG_URL must be an absolute http(s) URL" >&2
  ((error_count += 1))
fi
if (( PRODUCTION )) && [[ "${url}" =~ ^http://(127\.0\.0\.1|localhost)(:|/) ]]; then
  echo "[lightrag-env][ERR] production LIGHTRAG_URL cannot point at loopback" >&2
  ((error_count += 1))
fi

workspace="${LIGHTRAG_WORKSPACE:-}"
if [[ -n "${workspace}" && ! "${workspace}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "[lightrag-env][ERR] LIGHTRAG_WORKSPACE must be a stable <=128-char namespace" >&2
  ((error_count += 1))
fi

validate_image() {
  local name="$1" image="${!1:-}"
  [[ -n "${image}" ]] || return 0
  if [[ "${image}" == *:latest || "${image}" == */latest ]]; then
    echo "[lightrag-env][ERR] ${name} must not use mutable latest" >&2
    ((error_count += 1))
  fi
  if [[ ! "${image}" =~ (:[[:alnum:]][[:alnum:]._-]*|@sha256:[a-f0-9]{64})$ ]]; then
    echo "[lightrag-env][ERR] ${name} must have a version tag or sha256 digest" >&2
    ((error_count += 1))
  fi
}
validate_image LIGHTRAG_IMAGE
validate_image LIGHTRAG_PG_IMAGE

for name in LIGHTRAG_TIMEOUT_MS LIGHTRAG_PIPELINE_TIMEOUT_MS LIGHTRAG_POLL_INTERVAL_MS; do
  value="${!name:-}"
  if [[ -n "${value}" && ! "${value}" =~ ^[0-9]+$ ]]; then
    echo "[lightrag-env][ERR] ${name} must be an integer in milliseconds" >&2
    ((error_count += 1))
  fi
done

if (( error_count )); then
  echo "[lightrag-env] failed (${error_count} error(s)); no secrets were printed" >&2
  exit 1
fi
printf '%s\n' "[lightrag-env] OK (non-mutating; Manager-side settings only)"
