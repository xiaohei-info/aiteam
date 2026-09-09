#!/usr/bin/env bash
# Validate Manager-side LightRAG settings without contacting the service.
# Use --production on taiyi/production; --dry-run is equivalent to a non-mutating check.
set -euo pipefail

usage() {
  printf '%s\n' \
    'Usage: scripts/validate-lightrag-env.sh [--production] [--env-file FILE]' \
    'Production local profile: LIGHTRAG_IMAGE + URL/API/auth/runtime DB; remote legacy: HTTPS URL+API key; remote pool: LIGHTRAG_INSTANCES; all component fields unset means disabled' \
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

is_placeholder_secret() {
  local value="${1:-}" lower
  lower="$(printf '%s' "${value}" | tr '[:upper:]' '[:lower:]')"
  [[ "${lower}" == *change-me* || "${lower}" == *change_me* || "${lower}" == *change\ me* || "${lower}" == *changeme* || "${lower}" == *lightrag_dev* || "${lower}" == *lightrag_test* || "${lower}" == *newapi_dev* || "${lower}" == *newapi_test* ]]
}

reject_production_placeholder() {
  local name="$1" value="${!1:-}" minimum="$2"
  if [[ -n "${value}" ]] && { [[ ${#value} -lt ${minimum} ]] || is_placeholder_secret "${value}"; }; then
    echo "[lightrag-env][ERR] ${name} must be a non-placeholder secret of at least ${minimum} characters" >&2
    ((error_count += 1))
  fi
}

if (( PRODUCTION )); then
  if ! LIGHTRAG_BIND_HOST_CHECK="${LIGHTRAG_BIND_HOST:-127.0.0.1}" python3 - <<'PY'
import ipaddress
import os

value = os.environ["LIGHTRAG_BIND_HOST_CHECK"].strip()
try:
    if value != "localhost" and not ipaddress.ip_address(value.strip("[]")).is_loopback:
        raise ValueError
except ValueError:
    raise SystemExit(1)
PY
  then
    echo "[lightrag-env][ERR] production LIGHTRAG_BIND_HOST must be loopback" >&2
    ((error_count += 1))
  fi
fi

local_profile=0
if (( PRODUCTION )) && [[ -n "${LIGHTRAG_IMAGE:-}" ]]; then
  local_profile=1
fi
local_component_markers=0
for name in LIGHTRAG_IMAGE LIGHTRAG_AUTH_ACCOUNTS LIGHTRAG_TOKEN_SECRET LIGHTRAG_JWT_ALGORITHM LIGHTRAG_BIND_HOST LIGHTRAG_PORT LIGHTRAG_PG_PORT LIGHTRAG_PG_IMAGE LIGHTRAG_EMBEDDING_DIM LIGHTRAG_DB_HOST LIGHTRAG_DB_PORT LIGHTRAG_DB_NAME LIGHTRAG_DB_USER LIGHTRAG_DB_PASSWORD; do
  [[ -n "${!name:-}" ]] && { local_component_markers=1; break; }
done

if [[ -n "${LIGHTRAG_INSTANCES:-}" ]]; then
  if ! VALIDATE_PRODUCTION="${PRODUCTION}" python3 - <<'PY'
import json
import os
import socket
import sys
from ipaddress import ip_address
from urllib.parse import urlsplit

try:
    raw = os.environ["LIGHTRAG_INSTANCES"]
    if len(raw.encode("utf-8")) > 64 * 1024:
        raise ValueError
    values = json.loads(raw)
    if not isinstance(values, list) or not values or len(values) > 32:
        raise ValueError
    seen = set()
    for item in values:
        if not isinstance(item, dict) or set(item) - {"instance_id", "url", "api_key", "workspace"}:
            raise ValueError
        if "workspace" in item and item["workspace"] is not None and not isinstance(item["workspace"], str):
            raise ValueError
        if not all(isinstance(item.get(key), str) and item[key].strip() for key in ("instance_id", "url", "api_key")):
            raise ValueError
        instance_id = item["instance_id"].strip()
        if instance_id in seen or len(instance_id) > 128 or any(c in instance_id for c in "\r\n,/"):
            raise ValueError
        seen.add(instance_id)
        url_value = item["url"]
        api_key = item["api_key"]
        if any(c.isspace() for c in url_value) or any(c.isspace() for c in api_key):
            raise ValueError
        url_value = url_value.rstrip("/")
        if len(url_value) > 2_048 or len(api_key) > 4_096:
            raise ValueError
        url = urlsplit(url_value)
        try:
            url.port
        except ValueError:
            raise ValueError
        if os.environ.get("VALIDATE_PRODUCTION") == "1":
            if url.scheme != "https" or not url.hostname:
                raise ValueError
            host = url.hostname.rstrip(".").lower()
            if host == "localhost" or host.endswith(".localhost") or host.endswith(".local") or host.endswith(".localdomain") or host.endswith(".internal") or host.endswith(".intranet"):
                raise ValueError
            try:
                address = ip_address(host.strip("[]"))
            except ValueError:
                address = None
            if address is not None and (address.is_loopback or address.is_private or address.is_link_local or address.is_unspecified or address.is_multicast):
                raise ValueError
            try:
                resolved = {ip_address(info[4][0]) for info in socket.getaddrinfo(host, url.port or 443, type=socket.SOCK_STREAM) if info[4] and info[4][0]}
            except (OSError, ValueError):
                raise ValueError
            if not resolved or any(not item.is_global for item in resolved):
                raise ValueError
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
elif (( PRODUCTION && !local_profile )) && { [[ -n "${LIGHTRAG_URL:-}" ]] || [[ -n "${LIGHTRAG_API_KEY:-}" ]]; }; then
  # URL/key without LIGHTRAG_IMAGE is the supported remote legacy mode.
  required LIGHTRAG_URL
  required LIGHTRAG_API_KEY
fi

# An explicitly configured local profile requires runtime DB credentials in this
# Manager-side env; bootstrap admin credentials are validated separately by
# deploy/lightrag/init-db.sh and never enter Manager. Pool-only and remote
# legacy modes do not require local component settings.
if (( PRODUCTION )) && [[ -n "${LIGHTRAG_INSTANCES:-}" ]] && { [[ -n "${LIGHTRAG_URL:-}" ]] || [[ -n "${LIGHTRAG_API_KEY:-}" ]]; }; then
  echo "[lightrag-env][ERR] remote pool mode cannot include legacy URL/key settings" >&2
  ((error_count += 1))
elif (( PRODUCTION && local_profile )) && [[ -n "${LIGHTRAG_INSTANCES:-}" ]]; then
  echo "[lightrag-env][ERR] local LightRAG profile and remote pool are mutually exclusive" >&2
  ((error_count += 1))
elif (( PRODUCTION && local_profile )); then
  for name in LIGHTRAG_URL LIGHTRAG_API_KEY LIGHTRAG_AUTH_ACCOUNTS LIGHTRAG_TOKEN_SECRET LIGHTRAG_IMAGE LIGHTRAG_DB_HOST LIGHTRAG_DB_PORT LIGHTRAG_DB_NAME LIGHTRAG_DB_USER LIGHTRAG_DB_PASSWORD; do
    required "${name}"
  done
elif (( PRODUCTION && !local_profile )) && [[ -z "${LIGHTRAG_INSTANCES:-}" ]] && (( local_component_markers )); then
  echo "[lightrag-env][ERR] partial local LightRAG settings require LIGHTRAG_IMAGE" >&2
  ((error_count += 1))
elif (( PRODUCTION )) && [[ -n "${LIGHTRAG_INSTANCES:-}" ]] && (( local_component_markers )); then
  echo "[lightrag-env][ERR] remote pool mode cannot include local LightRAG settings" >&2
  ((error_count += 1))
fi

url="${LIGHTRAG_URL:-}"
# In endpoint-pool mode the URL/key pair is optional for Manager routing; when
# legacy values are present, use the same URL/key bounds as RagInstanceRegistry.
if [[ -n "${url}" || -n "${LIGHTRAG_API_KEY:-}" ]]; then
  if ! VALIDATE_PRODUCTION="${PRODUCTION}" LIGHTRAG_URL="${url}" LIGHTRAG_API_KEY="${LIGHTRAG_API_KEY:-}" python3 - <<'PY'
import os
import socket
import sys
from ipaddress import ip_address
from urllib.parse import urlsplit

try:
    raw_url = os.environ["LIGHTRAG_URL"]
    api_key = os.environ["LIGHTRAG_API_KEY"]
    if any(c.isspace() for c in raw_url) or any(c.isspace() for c in api_key):
        raise ValueError
    raw_url = raw_url.rstrip("/")
    if len(raw_url) > 2048 or len(api_key) > 4096 or not api_key or any(c in api_key for c in "\r\n"):
        raise ValueError
    parsed = urlsplit(raw_url)
    try:
        parsed.port
    except ValueError:
        raise ValueError
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError
    if os.environ.get("VALIDATE_PRODUCTION") == "1":
        if parsed.scheme != "https" or not parsed.hostname:
            raise ValueError
        host = parsed.hostname.rstrip(".").lower()
        if host == "localhost" or host.endswith(".localhost") or host.endswith(".local") or host.endswith(".localdomain") or host.endswith(".internal") or host.endswith(".intranet"):
            raise ValueError
        try:
            address = ip_address(host.strip("[]"))
        except ValueError:
            address = None
        if address is not None and (address.is_loopback or address.is_private or address.is_link_local or address.is_unspecified or address.is_multicast):
            raise ValueError
        try:
            resolved = {ip_address(info[4][0]) for info in socket.getaddrinfo(host, parsed.port or 443, type=socket.SOCK_STREAM) if info[4] and info[4][0]}
        except (OSError, ValueError):
            raise ValueError
        if not resolved or any(not item.is_global for item in resolved):
            raise ValueError
except (KeyError, TypeError, ValueError, UnicodeError, OSError):
    sys.exit(1)
PY
  then
    echo "[lightrag-env][ERR] LIGHTRAG_URL/API_KEY must match the bounded HTTP(S) endpoint contract" >&2
    ((error_count += 1))
  fi
fi

auth_accounts="${LIGHTRAG_AUTH_ACCOUNTS:-}"
if [[ -n "${auth_accounts}" && ! "${auth_accounts}" =~ ^[^:,[:space:]]+:.+([,][^:,[:space:]]+:.+)*$ ]]; then
  echo "[lightrag-env][ERR] LIGHTRAG_AUTH_ACCOUNTS must use comma-separated user:password entries" >&2
  ((error_count += 1))
fi
token_secret="${LIGHTRAG_TOKEN_SECRET:-}"
if (( PRODUCTION && local_profile )); then
  reject_production_placeholder LIGHTRAG_TOKEN_SECRET 32
  for name in LIGHTRAG_API_KEY LIGHTRAG_DB_PASSWORD LIGHTRAG_DB_ADMIN_PASSWORD; do
    reject_production_placeholder "${name}" 24
  done
  if [[ -n "${auth_accounts}" ]] && ! LIGHTRAG_AUTH_ACCOUNTS_CHECK="${auth_accounts}" python3 - <<'PY'
import os
for item in os.environ["LIGHTRAG_AUTH_ACCOUNTS_CHECK"].split(","):
    try:
        _, password = item.split(":", 1)
    except ValueError:
        raise SystemExit(1)
    value = password.strip().lower()
    if any(token in value for token in ("change-me", "change_me", "change me", "changeme", "lightrag_dev", "lightrag_test")):
        raise SystemExit(1)
PY
  then
    echo "[lightrag-env][ERR] LIGHTRAG_AUTH_ACCOUNTS contains a placeholder password" >&2
    ((error_count += 1))
  fi
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
