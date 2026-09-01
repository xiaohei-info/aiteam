#!/usr/bin/env bash
# Idempotently append a model to a NewAPI channel using Operator-only credentials.
# The channel key is read and sent only in NewAPI's response/request path; it is
# never printed or persisted by this script.
set -euo pipefail
umask 077

ENV_FILE=""
CHANNEL_ID="${NEWAPI_CHANNEL_ID:-1}"
MODEL="${NEWAPI_CHANNEL_MODEL_APPEND:-XingChenAGI/XingChenASR-V3.2-Ultra}"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: scripts/newapi-channel-models.sh --env-file FILE [options]

Options:
  --env-file FILE       Environment file (must contain Operator-only NewAPI credentials)
  --channel-id ID       NewAPI channel id (default: NEWAPI_CHANNEL_ID or 1)
  --model MODEL         Model id to append (default: XingChenAGI/XingChenASR-V3.2-Ultra)
  --dry-run             Print the target without making a request
EOF
}

while (($#)); do
  case "$1" in
    --env-file) [[ $# -ge 2 ]] || { echo "[newapi-channel][ERR] --env-file needs FILE" >&2; exit 2; }; ENV_FILE="$2"; shift 2 ;;
    --channel-id) [[ $# -ge 2 ]] || { echo "[newapi-channel][ERR] --channel-id needs ID" >&2; exit 2; }; CHANNEL_ID="$2"; shift 2 ;;
    --model) [[ $# -ge 2 ]] || { echo "[newapi-channel][ERR] --model needs MODEL" >&2; exit 2; }; MODEL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[newapi-channel][ERR] unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$CHANNEL_ID" =~ ^[0-9]+$ && "$CHANNEL_ID" -gt 0 ]] || { echo "[newapi-channel][ERR] channel id must be positive" >&2; exit 2; }
[[ "$MODEL" =~ ^[^[:space:],]+$ ]] || { echo "[newapi-channel][ERR] model id cannot contain whitespace or comma" >&2; exit 2; }
[[ -n "$ENV_FILE" && -r "$ENV_FILE" ]] || { echo "[newapi-channel][ERR] --env-file is required and must be readable" >&2; exit 2; }

set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
if [[ -n "${AITEAM_CONSOLE_CREDENTIALS_FILE:-}" && -r "$AITEAM_CONSOLE_CREDENTIALS_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$AITEAM_CONSOLE_CREDENTIALS_FILE"
fi
set +a

base="${NEWAPI_ADMIN_BASE_URL:-${NEWAPI_URL:-http://127.0.0.1:${NEWAPI_PORT:-9300}}}"
base="${base%/}"
if (( DRY_RUN )); then
  echo "[newapi-channel][dry-run] append ${MODEL} to channel ${CHANNEL_ID} at ${base}"
  exit 0
fi

: "${NEWAPI_ADMIN_TOKEN:?NEWAPI_ADMIN_TOKEN is required}"
: "${NEWAPI_ADMIN_USER_ID:?NEWAPI_ADMIN_USER_ID is required}"

python3 - "$base" "$CHANNEL_ID" "$MODEL" "$NEWAPI_ADMIN_USER_ID" <<'PY'
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

base, channel_id, model, user_id = sys.argv[1:]
token = os.environ["NEWAPI_ADMIN_TOKEN"]
headers = {
    "Accept": "application/json",
    "Authorization": f"Bearer {token}",
    "New-Api-User": user_id,
}


def request(method: str, path: str, body: dict | None = None) -> dict:
    payload = json.dumps(body).encode() if body is not None else None
    request_headers = dict(headers)
    if payload is not None:
        request_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{base}{path}", data=payload, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            raw = response.read(2_000_000)
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"[newapi-channel][ERR] NewAPI returned HTTP {exc.code}") from exc
    except OSError as exc:
        raise SystemExit("[newapi-channel][ERR] NewAPI request failed") from exc
    try:
        result = json.loads(raw)
    except ValueError as exc:
        raise SystemExit("[newapi-channel][ERR] NewAPI returned invalid JSON") from exc
    if not isinstance(result, dict) or result.get("success") is not True:
        raise SystemExit("[newapi-channel][ERR] NewAPI channel operation failed")
    return result

result = request("GET", f"/api/channel/{channel_id}")
data = result.get("data")
if not isinstance(data, dict) or not isinstance(data.get("models"), str):
    raise SystemExit("[newapi-channel][ERR] channel response has no configured model list")
models = [item.strip() for item in data["models"].split(",") if item.strip()]
if model in models:
    print(f"[newapi-channel] model already present: channel={channel_id}")
    raise SystemExit(0)
models.append(model)
request("PUT", "/api/channel/", {"id": int(channel_id), "models": ",".join(models)})
print(f"[newapi-channel] model appended: channel={channel_id}")
PY
