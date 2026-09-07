#!/usr/bin/env bash
# Validate Manager-side LightRAG settings without contacting the service.
# Use --production on taiyi/production; --dry-run is equivalent to a non-mutating check.
set -euo pipefail

usage() {
  printf '%s\n' \
    'Usage: scripts/validate-lightrag-env.sh [--production] [--env-file FILE]' \
    'Required in production: LIGHTRAG_AUTH_ACCOUNTS LIGHTRAG_TOKEN_SECRET LIGHTRAG_IMAGE and either LIGHTRAG_URL+LIGHTRAG_API_KEY or LIGHTRAG_INSTANCES' \
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

if [[ -n "${LIGHTRAG_INSTANCES:-}" ]]; then
  if ! python3 - <<'PY'
import json
import os
import sys
from urllib.parse import urlsplit

try:
    values = json.loads(os.environ["LIGHTRAG_INSTANCES"])
    if not isinstance(values, list) or not values or len(values) > 32:
        raise ValueError
    seen = set()
    for item in values:
        if not isinstance(item, dict) or set(item) - {"instance_id", "url", "api_key", "workspace"}:
            raise ValueError
        if not all(isinstance(item.get(key), str) and item[key].strip() for key in ("instance_id", "url", "api_key")):
            raise ValueError
        instance_id = item["instance_id"].strip()
        if instance_id in seen or len(instance_id) > 128 or any(c in instance_id for c in "\r\n,/"):
            raise ValueError
        seen.add(instance_id)
        url = urlsplit(item["url"].strip())
        if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError
        if any(any(c in value for c in "\r\n") for value in item.values() if isinstance(value, str)):
            raise ValueError
except (KeyError, TypeError, ValueError, json.JSONDecodeError, UnicodeError):
    sys.exit(1)
PY
  then
    echo "[lightrag-env][ERR] LIGHTRAG_INSTANCES must be a valid non-empty endpoint pool" >&2
    ((error_count += 1))
  fi
elif (( PRODUCTION )); then
  required LIGHTRAG_URL
  required LIGHTRAG_API_KEY
fi

if (( PRODUCTION )); then
  required LIGHTRAG_AUTH_ACCOUNTS
  required LIGHTRAG_TOKEN_SECRET
  required LIGHTRAG_IMAGE
fi

url="${LIGHTRAG_URL:-}"
# In endpoint-pool mode the URL/key pair is optional for Manager routing; each
# pool entry is validated by RagInstanceRegistry before the service starts.
if [[ -n "${url}" && ! "${url}" =~ ^https?://[^[:space:]]+$ ]]; then
  echo "[lightrag-env][ERR] LIGHTRAG_URL must be an absolute http(s) URL" >&2
  ((error_count += 1))
fi
if (( PRODUCTION )) && [[ "${url}" =~ ^http://(127\.0\.0\.1|localhost)(:|/) ]]; then
  echo "[lightrag-env][ERR] production LIGHTRAG_URL cannot point at loopback" >&2
  ((error_count += 1))
fi

auth_accounts="${LIGHTRAG_AUTH_ACCOUNTS:-}"
if [[ -n "${auth_accounts}" && ! "${auth_accounts}" =~ ^[^:,[:space:]]+:.+([,][^:,[:space:]]+:.+)*$ ]]; then
  echo "[lightrag-env][ERR] LIGHTRAG_AUTH_ACCOUNTS must use comma-separated user:password entries" >&2
  ((error_count += 1))
fi
token_secret="${LIGHTRAG_TOKEN_SECRET:-}"
if (( PRODUCTION )) && (( ${#token_secret} < 32 )); then
  echo "[lightrag-env][ERR] LIGHTRAG_TOKEN_SECRET must be at least 32 characters" >&2
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
