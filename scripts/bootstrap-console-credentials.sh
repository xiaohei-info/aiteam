#!/usr/bin/env bash
# Generate once and reuse per-deployment native console credentials.
# Secrets are written only to a caller-selected mode-600 file and its paired
# mode-600 Markdown record; neither file belongs in Git or a frontend bundle.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE=""
CREDENTIALS_FILE=""
DOCUMENT_FILE=""
NEWAPI_URL=""
NEWAPI_DISPLAY_URL="${NEWAPI_DISPLAY_URL:-http://127.0.0.1:9300/}"
LIGHTRAG_DISPLAY_URL="${LIGHTRAG_DISPLAY_URL:-http://127.0.0.1:9621/webui/}"
HINDSIGHT_DISPLAY_URL="${HINDSIGHT_DISPLAY_URL:-http://127.0.0.1:9999/dashboard}"
LIGHTRAG_HASH_IMAGE="${LIGHTRAG_HASH_IMAGE:-ghcr.io/hkuds/lightrag:1.5.6}"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap-console-credentials.sh [options]

Create or reuse one local credential set for a deployment. The first run
creates random credentials; later runs keep them unchanged.

Options:
  --env-file FILE             Environment file to add the credentials pointer to
  --credentials-file FILE    mode-600 shell env file (default: /etc/aiteam/aiteam-console.env)
  --document-file FILE       mode-600 Markdown record (default: sibling .md file)
  --newapi-url URL            NewAPI URL; provision/setup and persist its admin token
  --newapi-display-url URL    URL written to the local login record (default: http://127.0.0.1:9300/)
  --lightrag-display-url URL  URL written to the local login record (default: http://127.0.0.1:9621/webui/)
  --hindsight-display-url URL URL written to the local login record (default: http://127.0.0.1:9999/dashboard)
  --lightrag-image IMAGE     Image used only to generate a bcrypt hash
  --dry-run                  Validate and print the plan without writing or provisioning
  -h, --help                 Show this help

Typical first deployment:
  ./scripts/ctl.sh start --env prod --deploy docker --server newapi
  scripts/bootstrap-console-credentials.sh \
    --env-file .env.prod --newapi-url http://127.0.0.1:9300
  ./scripts/ctl.sh start --env prod --deploy docker --server manager
  ./scripts/ctl.sh start --env prod --deploy docker --server operation

The generated credential file is sourced by ctl.sh when
AITEAM_CONSOLE_CREDENTIALS_FILE is present in the selected env file.
EOF
}

python3_clean() {
  # Helpers receive only non-secret process metadata; credentials travel via
  # protected file descriptors/files and never through inherited environment.
  env -i PATH="${PATH:-/usr/bin:/bin}" HOME="${HOME:-}" python3 "$@"
}

quote_env() {
  # Generated values and paths are validated to contain no single quote.
  local value="$1"
  [[ "$value" != *"'"* ]] || { echo "[console-creds][ERR] value contains a single quote" >&2; exit 1; }
  printf "'%s'" "$value"
}

random_value() {
  local length="$1"
  python3_clean - "$length" <<'PY'
import secrets
import string
import sys
length = int(sys.argv[1])
alphabet = string.ascii_letters + string.digits
print("".join(secrets.choice(alphabet) for _ in range(length)))
PY
}

set_env_value() {
  local path="$1" key="$2" value="$3"
  # The value travels over a dedicated pipe file descriptor, never as a Python
  # argv or inherited env item. The script itself remains on stdin.
  python3_clean - "$path" "$key" 3<<<"$value" <<'PY'
from pathlib import Path
import os
import sys
path, key = Path(sys.argv[1]), sys.argv[2]
value = os.fdopen(3, "r", encoding="utf-8").read().rstrip("\n")
if "'" in value:
    raise SystemExit("credential value cannot contain a single quote")
lines = path.read_text().splitlines()
replacement = f"{key}='{value}'"
for index, line in enumerate(lines):
    if line.startswith(f"{key}="):
        lines[index] = replacement
        break
else:
    lines.append(replacement)
tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
tmp.write_text("\n".join(lines) + "\n")
os.chmod(tmp, 0o600)
os.replace(tmp, path)
os.chmod(path, 0o600)
PY
}

set_env_pointer() {
  local path="$1" pointer="$2"
  python3_clean - "$path" "$pointer" <<'PY'
from pathlib import Path
import os
import shlex
import sys
path, pointer = Path(sys.argv[1]), sys.argv[2]
if "'" in pointer:
    raise SystemExit("credential file path cannot contain a single quote")
lines = path.read_text().splitlines()
replacement = f"AITEAM_CONSOLE_CREDENTIALS_FILE={shlex.quote(pointer)}"
for index, line in enumerate(lines):
    if line.startswith("AITEAM_CONSOLE_CREDENTIALS_FILE="):
        lines[index] = replacement
        break
else:
    lines.append(replacement)
tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
tmp.write_text("\n".join(lines) + "\n")
os.chmod(tmp, 0o600)
os.replace(tmp, path)
os.chmod(path, 0o600)
PY
}

hash_lightrag_password() {
  local password="$1"
  command -v docker >/dev/null 2>&1 || {
    echo "[console-creds][ERR] docker is required to generate the LightRAG bcrypt hash" >&2
    exit 1
  }
  # Feed the password over stdin so it is not present in docker argv.
  printf '%s' "$password" | env -i PATH="${PATH:-/usr/bin:/bin}" docker run --rm -i --entrypoint python "$LIGHTRAG_HASH_IMAGE" -c '
import sys
from lightrag.api.passwords import hash_password
print(hash_password(sys.stdin.read()))
'
}

provision_newapi() {
  local base_url="$1" credentials_file="$2" token_file="$3"
  python3_clean - "$base_url" "$credentials_file" "$token_file" <<'PY'
from __future__ import annotations

import json
import os
import shlex
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request

base = sys.argv[1].rstrip("/")
credentials_file = Path(sys.argv[2])
token_file = Path(sys.argv[3])

def read_credentials(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, raw_value = line.split("=", 1)
        parsed = shlex.split(raw_value, comments=False)
        values[key] = parsed[0] if parsed else ""
    return values

credentials = read_credentials(credentials_file)
username = credentials.get("NEWAPI_ADMIN_USERNAME", "")
password = credentials.get("NEWAPI_ADMIN_PASSWORD", "")
user_id = credentials.get("NEWAPI_ADMIN_USER_ID", "")
existing_token = credentials.get("NEWAPI_ADMIN_TOKEN", "")
if not username or not password or not user_id:
    raise RuntimeError("console credential file is missing NewAPI bootstrap fields")


def request(method: str, path: str, body: dict | None = None, headers: dict[str, str] | None = None) -> tuple[int, dict]:
    payload = json.dumps(body).encode() if body is not None else None
    request_headers = {"Accept": "application/json"}
    if payload is not None:
        request_headers["Content-Type"] = "application/json"
    request_headers.update(headers or {})
    req = urllib.request.Request(f"{base}{path}", data=payload, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            raw = response.read(2_000_000)
            return response.status, json.loads(raw)
    except urllib.error.HTTPError as exc:
        raw = exc.read(200_000)
        try:
            detail = json.loads(raw)
        except Exception:
            detail = {}
        raise RuntimeError(f"NewAPI {method} {path} returned HTTP {exc.code}: {detail.get('message', 'request failed')}") from exc

# Wait for the service before touching setup/login state.
for _ in range(30):
    try:
        status, setup = request("GET", "/api/setup")
        if 200 <= status < 300:
            break
    except Exception:
        import time
        time.sleep(2)
else:
    raise RuntimeError("NewAPI did not become reachable")

setup_data = setup.get("data") if isinstance(setup, dict) else None
if isinstance(setup_data, dict) and setup_data.get("status") is False and setup_data.get("root_init") is False:
    request("POST", "/api/setup", {
        "username": username,
        "password": password,
        "confirmPassword": password,
        "SelfUseModeEnabled": False,
        "DemoSiteEnabled": False,
    })

def login_as(login_username: str, login_password: str) -> tuple[str, str]:
    _, result = request("POST", "/api/user/login", {"username": login_username, "password": login_password})
    result_data = result.get("data") if isinstance(result, dict) else None
    if not isinstance(result_data, dict):
        raise RuntimeError("NewAPI login returned no data")
    result_token = result_data.get("access_token")
    result_user = result_data.get("user") or {}
    result_id = str(result_user.get("id") or user_id)
    if not isinstance(result_token, str) or not result_token:
        raise RuntimeError("NewAPI login returned no access token")
    return result_token, result_id

try:
    dashboard_token, resolved_id = login_as(username, password)
except RuntimeError as desired_login_error:
    # NewAPI auto-creates root/123456 on a completely empty database before
    # exposing the setup endpoint. Convert that one-time bootstrap account to
    # the stable credentials generated by this script.
    if not (isinstance(setup_data, dict) and setup_data.get("root_init") is True):
        raise
    try:
        bootstrap_token, bootstrap_id = login_as("root", "123456")
        request("PUT", "/api/user/", {
            "id": int(bootstrap_id),
            "username": username,
            "password": password,
            "display_name": "Root User",
            "role": 100,
            "status": 1,
        }, headers={"Authorization": f"Bearer {bootstrap_token}", "New-Api-User": bootstrap_id})
        dashboard_token, resolved_id = login_as(username, password)
    except RuntimeError:
        raise desired_login_error

# Keep a previously generated management token stable across redeploys.
if existing_token:
    token = existing_token
else:
    _, generated = request(
        "GET",
        "/api/user/token",
        headers={"Authorization": f"Bearer {dashboard_token}", "New-Api-User": resolved_id},
    )
    token = generated.get("data") if isinstance(generated, dict) else None
    if not isinstance(token, str) or not token:
        raise RuntimeError("NewAPI did not return a management token")

tmp = token_file.with_name(f".{token_file.name}.tmp-{os.getpid()}")
tmp.write_text(token)
os.chmod(tmp, 0o600)
os.replace(tmp, token_file)
os.chmod(token_file, 0o600)
PY
  printf '%s\n' "[console-creds] NewAPI login/provision OK"
}

while (($#)); do
  case "$1" in
    --env-file) [[ $# -ge 2 ]] || { echo "[console-creds][ERR] --env-file needs FILE" >&2; exit 2; }; ENV_FILE="$2"; shift 2 ;;
    --credentials-file) [[ $# -ge 2 ]] || { echo "[console-creds][ERR] --credentials-file needs FILE" >&2; exit 2; }; CREDENTIALS_FILE="$2"; shift 2 ;;
    --document-file) [[ $# -ge 2 ]] || { echo "[console-creds][ERR] --document-file needs FILE" >&2; exit 2; }; DOCUMENT_FILE="$2"; shift 2 ;;
    --newapi-url) [[ $# -ge 2 ]] || { echo "[console-creds][ERR] --newapi-url needs URL" >&2; exit 2; }; NEWAPI_URL="$2"; shift 2 ;;
    --newapi-display-url) [[ $# -ge 2 ]] || { echo "[console-creds][ERR] --newapi-display-url needs URL" >&2; exit 2; }; NEWAPI_DISPLAY_URL="$2"; shift 2 ;;
    --lightrag-display-url) [[ $# -ge 2 ]] || { echo "[console-creds][ERR] --lightrag-display-url needs URL" >&2; exit 2; }; LIGHTRAG_DISPLAY_URL="$2"; shift 2 ;;
    --hindsight-display-url) [[ $# -ge 2 ]] || { echo "[console-creds][ERR] --hindsight-display-url needs URL" >&2; exit 2; }; HINDSIGHT_DISPLAY_URL="$2"; shift 2 ;;
    --lightrag-image) [[ $# -ge 2 ]] || { echo "[console-creds][ERR] --lightrag-image needs IMAGE" >&2; exit 2; }; LIGHTRAG_HASH_IMAGE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[console-creds][ERR] unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -n "$ENV_FILE" ]]; then
  [[ -f "$ENV_FILE" ]] || { echo "[console-creds][ERR] env file not found: $ENV_FILE" >&2; exit 1; }
  [[ -r "$ENV_FILE" && -w "$ENV_FILE" ]] || { echo "[console-creds][ERR] env file must be readable and writable: $ENV_FILE" >&2; exit 1; }
  chmod 600 "$ENV_FILE"
fi

if [[ -z "$CREDENTIALS_FILE" ]]; then
  CREDENTIALS_FILE="${AITEAM_CONSOLE_CREDENTIALS_FILE:-/etc/aiteam/aiteam-console.env}"
fi
if [[ -z "$DOCUMENT_FILE" ]]; then
  DOCUMENT_FILE="${CREDENTIALS_FILE%.env}.md"
fi

[[ "$CREDENTIALS_FILE" != *"'"* && "$DOCUMENT_FILE" != *"'"* ]] || {
  echo "[console-creds][ERR] paths cannot contain a single quote" >&2; exit 1;
}

if (( DRY_RUN )); then
  echo "[console-creds][dry-run] credentials file: $CREDENTIALS_FILE"
  echo "[console-creds][dry-run] login record: $DOCUMENT_FILE"
  [[ -n "$ENV_FILE" ]] && echo "[console-creds][dry-run] update pointer: $ENV_FILE"
  [[ -n "$NEWAPI_URL" ]] && echo "[console-creds][dry-run] provision NewAPI: $NEWAPI_URL"
  echo "[console-creds][dry-run] first run generates; later runs reuse existing values"
  exit 0
fi

mkdir -p "$(dirname "$CREDENTIALS_FILE")" "$(dirname "$DOCUMENT_FILE")"
if [[ -e "$CREDENTIALS_FILE" ]]; then
  [[ -f "$CREDENTIALS_FILE" && -r "$CREDENTIALS_FILE" ]] || { echo "[console-creds][ERR] credentials file is not a readable regular file" >&2; exit 1; }
  mode="$(stat -c '%a' "$CREDENTIALS_FILE" 2>/dev/null || stat -f '%Lp' "$CREDENTIALS_FILE")"
  [[ "$mode" == "600" ]] || { echo "[console-creds][ERR] credentials file must remain mode 600 (got $mode)" >&2; exit 1; }
  # shellcheck source=/dev/null
  set -a; source "$CREDENTIALS_FILE"; set +a
  : "${NEWAPI_ADMIN_USERNAME:?credentials file missing NEWAPI_ADMIN_USERNAME}"
  : "${NEWAPI_ADMIN_PASSWORD:?credentials file missing NEWAPI_ADMIN_PASSWORD}"
  : "${NEWAPI_ADMIN_USER_ID:?credentials file missing NEWAPI_ADMIN_USER_ID}"
  : "${LIGHTRAG_ADMIN_USERNAME:?credentials file missing LIGHTRAG_ADMIN_USERNAME}"
  : "${LIGHTRAG_ADMIN_PASSWORD:?credentials file missing LIGHTRAG_ADMIN_PASSWORD}"
  : "${LIGHTRAG_AUTH_ACCOUNTS:?credentials file missing LIGHTRAG_AUTH_ACCOUNTS}"
  : "${LIGHTRAG_TOKEN_SECRET:?credentials file missing LIGHTRAG_TOKEN_SECRET}"
  : "${HINDSIGHT_CP_ACCESS_KEY:?credentials file missing HINDSIGHT_CP_ACCESS_KEY}"
  NEWAPI_ADMIN_TOKEN="${NEWAPI_ADMIN_TOKEN:-}"
  # Standalone LightRAG consumes its native names; Compose maps the prefixed
  # names below. Add aliases when upgrading an older credential file.
  AUTH_ACCOUNTS="${AUTH_ACCOUNTS:-$LIGHTRAG_AUTH_ACCOUNTS}"
  TOKEN_SECRET="${TOKEN_SECRET:-$LIGHTRAG_TOKEN_SECRET}"
  set_env_value "$CREDENTIALS_FILE" "AUTH_ACCOUNTS" "$AUTH_ACCOUNTS"
  set_env_value "$CREDENTIALS_FILE" "TOKEN_SECRET" "$TOKEN_SECRET"
  echo "[console-creds] reusing $CREDENTIALS_FILE"
else
  NEWAPI_ADMIN_USERNAME="aiteamroot"
  NEWAPI_ADMIN_PASSWORD="AtN-$(random_value 16)"
  NEWAPI_ADMIN_USER_ID="1"
  NEWAPI_ADMIN_TOKEN=""
  LIGHTRAG_ADMIN_USERNAME="aiteam-admin"
  LIGHTRAG_ADMIN_PASSWORD="Aiteam-LightRAG-$(random_value 24)"
  LIGHTRAG_TOKEN_SECRET="Aiteam-LightRAG-Signing-$(random_value 48)"
  HINDSIGHT_CP_ACCESS_KEY="Aiteam-Hindsight-$(random_value 40)"
  lightrag_hash="$(hash_lightrag_password "$LIGHTRAG_ADMIN_PASSWORD")"
  LIGHTRAG_AUTH_ACCOUNTS="${LIGHTRAG_ADMIN_USERNAME}:${lightrag_hash}"
  tmp="${CREDENTIALS_FILE}.tmp-$$"
  {
    printf 'AITEAM_CONSOLE_CREDENTIALS_VERSION=1\n'
    printf 'NEWAPI_ADMIN_USERNAME=%s\n' "$(quote_env "$NEWAPI_ADMIN_USERNAME")"
    printf 'NEWAPI_ADMIN_PASSWORD=%s\n' "$(quote_env "$NEWAPI_ADMIN_PASSWORD")"
    printf 'NEWAPI_ADMIN_USER_ID=%s\n' "$(quote_env "$NEWAPI_ADMIN_USER_ID")"
    printf 'NEWAPI_ADMIN_TOKEN=%s\n' "$(quote_env "$NEWAPI_ADMIN_TOKEN")"
    printf 'LIGHTRAG_ADMIN_USERNAME=%s\n' "$(quote_env "$LIGHTRAG_ADMIN_USERNAME")"
    printf 'LIGHTRAG_ADMIN_PASSWORD=%s\n' "$(quote_env "$LIGHTRAG_ADMIN_PASSWORD")"
    printf 'LIGHTRAG_AUTH_ACCOUNTS=%s\n' "$(quote_env "$LIGHTRAG_AUTH_ACCOUNTS")"
    printf 'LIGHTRAG_TOKEN_SECRET=%s\n' "$(quote_env "$LIGHTRAG_TOKEN_SECRET")"
    printf 'AUTH_ACCOUNTS=%s\n' "$(quote_env "$LIGHTRAG_AUTH_ACCOUNTS")"
    printf 'TOKEN_SECRET=%s\n' "$(quote_env "$LIGHTRAG_TOKEN_SECRET")"
    printf 'HINDSIGHT_CP_ACCESS_KEY=%s\n' "$(quote_env "$HINDSIGHT_CP_ACCESS_KEY")"
  } > "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$CREDENTIALS_FILE"
  chmod 600 "$CREDENTIALS_FILE"
  echo "[console-creds] generated $CREDENTIALS_FILE"
fi

if [[ -n "$NEWAPI_URL" && -z "$NEWAPI_ADMIN_TOKEN" ]]; then
  token_tmp="${CREDENTIALS_FILE}.token.tmp-$$"
  rm -f "$token_tmp"
  provision_newapi "$NEWAPI_URL" "$CREDENTIALS_FILE" "$token_tmp"
  NEWAPI_ADMIN_TOKEN="$(cat "$token_tmp")"
  rm -f "$token_tmp"
  set_env_value "$CREDENTIALS_FILE" "NEWAPI_ADMIN_TOKEN" "$NEWAPI_ADMIN_TOKEN"
fi

if [[ -n "$ENV_FILE" ]]; then
  set_env_pointer "$ENV_FILE" "$CREDENTIALS_FILE"
  echo "[console-creds] linked $ENV_FILE -> $CREDENTIALS_FILE"
fi

cat > "${DOCUMENT_FILE}.tmp-$$" <<EOF
# AI Team 组件管理员登录凭据

> 生成脚本：scripts/bootstrap-console-credentials.sh
> 权限必须保持 0600；不要提交 Git、不要放入前端 bundle、不要截图或复制到普通日志。

## NewAPI

- 地址：${NEWAPI_DISPLAY_URL}
- 账号：${NEWAPI_ADMIN_USERNAME}
- 密码：${NEWAPI_ADMIN_PASSWORD}

## LightRAG

- 地址：${LIGHTRAG_DISPLAY_URL}
- 账号：${LIGHTRAG_ADMIN_USERNAME}
- 密码：${LIGHTRAG_ADMIN_PASSWORD}

## Hindsight Control Plane

- 地址：${HINDSIGHT_DISPLAY_URL}
- 登录方式：Access Key
- Token：${HINDSIGHT_CP_ACCESS_KEY}

## 轮换与部署记录

- 凭据文件：${CREDENTIALS_FILE}
- NewAPI 管理 Token 已写入环境文件后才由 Operation 使用。
- LightRAG 环境使用 bcrypt 账号哈希；本文件保留原始密码供管理员登录。
- Hindsight 控制台使用 Access Key，不需要用户名。
EOF
chmod 600 "${DOCUMENT_FILE}.tmp-$$"
mv -f "${DOCUMENT_FILE}.tmp-$$" "$DOCUMENT_FILE"
chmod 600 "$DOCUMENT_FILE"
echo "[console-creds] login record: $DOCUMENT_FILE"
