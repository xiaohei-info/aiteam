#!/usr/bin/env bash
# v1 部署编排脚本，在 self-hosted runner 的 ta iy 机器上运行。
#
# 假定调用时已在持久化部署根（DEPLOY_ROOT，默认 /root/app/aiteam）执行。
# 该目录应已是一个 git 仓库（origin = git@github.com:...）并具备可用的 .venv。
#
# 与此前"条件性 build / fallback 到默认分支"的行为不同，本脚本
# 严格要求调用方给出明确分支；分支为空即 fail。
#
# TEST 简化维护窗口（失败就报错，无 fallback）：
#   1) 先停止 systemd 管理的 Manager/Operation/Agent application writers
#   2) 保持应用停止，拉取代码并构建前端
#   3) 确认 PostgreSQL/NewAPI 依赖运行后备份并执行管理迁移/DDL
#   4) 安装 systemd unit、启动新三端应用栈
#   5) /healthz 冒烟 + GET / 必须是 HTML
#
# 本流程是完整停机，不是零停机/cgroup cutover；可选的 S05 systemd probe
# 只在独立 hosted workflow 验证，不能由本脚本或 deploy-main 调用。

set -euo pipefail

# Git refuses a persistent checkout with a different owner unless it is marked
# safe. Self-hosted runner services may also omit HOME entirely.
export HOME="${HOME:-/root}"

BRANCH="${DEPLOY_BRANCH:-}"
ENV_TARGET="${DEPLOY_ENV:-test}"
UNIT_NAME="${UNIT_NAME:-aiteam-v1}"
DEPLOY_ROOT="$(pwd)"

while (( $# > 0 )); do
  case "$1" in
    --branch=*) BRANCH="${1#*=}"; shift ;;
    --branch)
      if [[ $# -lt 2 || "$2" == -* || -z "$2" ]]; then
        echo "[deploy-run][ERR] --branch requires a non-empty value" >&2; exit 2
      fi; BRANCH="$2"; shift 2 ;;
    --env=*) ENV_TARGET="${1#*=}"; shift ;;
    --env)
      if [[ $# -lt 2 || "$2" == -* || -z "$2" ]]; then
        echo "[deploy-run][ERR] --env requires a non-empty value" >&2; exit 2
      fi; ENV_TARGET="$2"; shift 2 ;;
    --unit=*) UNIT_NAME="${1#*=}"; shift ;;
    --unit)
      if [[ $# -lt 2 || "$2" == -* || -z "$2" ]]; then
        echo "[deploy-run][ERR] --unit requires a non-empty value" >&2; exit 2
      fi; UNIT_NAME="$2"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *)
      echo "[deploy-run][ERR] unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$BRANCH" ]]; then
  fail() { printf '[deploy-run][][ERR] %s\n' "$*" >&2; exit 2; }
  fail "branch is required: pass --branch <name> or DEPLOY_BRANCH env. Trigger must be via pull_request merge or workflow_dispatch with branch input."
fi
if [[ ! "$BRANCH" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || [[ "$BRANCH" == */ || "$BRANCH" == *..* || "$BRANCH" == *'@{'* ]]; then
  fail() { printf '[deploy-run][][ERR] %s\n' "$*" >&2; exit 2; }
  fail "invalid deployment branch: $BRANCH"
fi

log()  { printf '[deploy-run][%s][%s] %s\n' "$ENV_TARGET" "$BRANCH" "$*"; }
fail() { printf '[deploy-run][%s][%s][ERR] %s\n' "$ENV_TARGET" "$BRANCH" "$*" >&2; exit 1; }

# --- persistent venv requirements sync ---
sync_persistent_venv_requirements() {
  local venv_python="${1:-}"
  local req_file="${DEPLOY_ROOT}/server/requirements.txt"
  local venv_dir="${DEPLOY_ROOT}/.venv"
  local marker="${venv_dir}/.aiteam-requirements.sha256"
  local marker_tmp req_hash current

  [[ -n "${venv_python}" && -x "${venv_python}" ]] || fail "persistent .venv Python is required to synchronize server/requirements.txt"
  [[ -d "${venv_dir}" ]] || fail "persistent .venv is required; bootstrap it per deploy/ci/README.md"
  [[ -f "${req_file}" ]] || fail "server/requirements.txt missing after checkout"
  [[ "${venv_python}" == "${venv_dir}/bin/"* && "${venv_python}" != *..* ]] \
    || fail "refusing to install server/requirements.txt outside persistent .venv"

  req_hash="$(AITEAM_REQUIREMENTS_FILE="${req_file}" "${venv_python}" -c "import hashlib, os, pathlib; print(hashlib.sha256(pathlib.Path(os.environ['AITEAM_REQUIREMENTS_FILE']).read_bytes()).hexdigest())")" \
    || fail "cannot hash checked-out server/requirements.txt"
  [[ "${req_hash}" =~ ^[a-f0-9]{64}$ ]] || fail "invalid hash for server/requirements.txt"

  current=""
  if [[ -f "${marker}" ]]; then
    current="$(tr -d '[:space:]' < "${marker}")"
  fi
  if [[ "${current}" == "${req_hash}" ]]; then
    log "persistent venv requirements already match ${req_hash:0:12}"
    return 0
  fi

  log "synchronizing persistent venv from server/requirements.txt"
  "${venv_python}" -m pip install --requirement "${req_file}" \
    || fail "pip install --requirement server/requirements.txt failed; application writers remain stopped"

  marker_tmp="${marker}.tmp.$$"
  printf '%s\n' "${req_hash}" > "${marker_tmp}" || fail "cannot write requirements marker"
  mv -f "${marker_tmp}" "${marker}" || fail "cannot commit requirements marker"
  log "persistent venv requirements marker updated ${req_hash:0:12}"
}
# --- end persistent venv requirements sync ---

# --- dependency start diagnostics ---
# Capture ctl start output instead of hiding it. Redact assignment-like secrets
# and connection URLs; names/status lines pass through unchanged. On failure,
# print a bounded compose ps (no config/env dumps) and exit immediately.
# A fixed-name aiteam-pg conflict may reuse a verified existing container via
# docker start; never remove/rename containers or volumes.
redact_dependency_start_output() {
  sed -E \
    -e 's#postgresql://[^[:space:]]+#postgresql://<redacted>#g' \
    -e 's#redis://:[^@[:space:]]+@#redis://:<redacted>@#g' \
    -e 's#(--requirepass[[:space:]]+)[^[:space:]]+#\1<redacted>#g' \
    -e 's/(^|[[:space:]])((ADMIN_)?DB_URL|(POSTGRES|NEWAPI_DB|NEWAPI_REDIS|APP_RW)_PASSWORD|NEWAPI_(SESSION|CRYPTO)_SECRET|NEWAPI_ADMIN_TOKEN|SERVICE_TOKEN)=[^[:space:]]+/\1\2=<redacted>/g'
}

dump_dependency_compose_ps() {
  local compose_dir="${DEPLOY_ROOT}/deploy/docker"
  if [[ ! -f "${compose_dir}/docker-compose.yml" ]]; then
    log "dependency compose file missing; skipping docker compose ps"
    return 0
  fi
  log "dependency compose ps --all (names/status only)"
  (
    cd "${compose_dir}"
    docker compose --profile newapi ps --all --format '{{.Name}} {{.Service}} {{.Status}}'
  ) 2>&1 | redact_dependency_start_output | head -n 50 || true
}

postgres_container_name_conflict() {
  grep -Eq 'container name "/?aiteam-pg" is already in use' <<<"$1"
}

recover_existing_postgres_container() {
  local inspect_meta inspect_env line
  local name="" image="" status="" volume_name=""
  local pg_user="" pg_db=""
  local expected_image expected_volume
  local start_output="" start_rc=0

  expected_image="${POSTGRES_IMAGE:-pgvector/pgvector:pg16}"
  expected_volume="${POSTGRES_VOLUME:-aiteam_pg_data_${ENV_TARGET}}"

  if ! inspect_meta="$(docker inspect --format '{{.Name}}|{{.Config.Image}}|{{.State.Status}}|{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' aiteam-pg 2>/dev/null)"; then
    log "cannot inspect existing PostgreSQL container aiteam-pg; leaving it untouched"
    return 1
  fi
  IFS='|' read -r name image status volume_name _ <<<"${inspect_meta}"
  name="${name#/}"
  if [[ -z "${name}" || -z "${image}" || -z "${status}" ]]; then
    log "existing PostgreSQL container inspect metadata is incomplete; leaving it untouched"
    return 1
  fi
  if [[ "${name}" != "aiteam-pg" ]]; then
    log "existing container name is not aiteam-pg; leaving it untouched"
    return 1
  fi
  if [[ "${image}" != "${expected_image}" ]]; then
    log "existing PostgreSQL image mismatch (expected ${expected_image}); leaving it untouched"
    return 1
  fi

  if ! inspect_env="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' aiteam-pg 2>/dev/null)"; then
    log "cannot inspect existing PostgreSQL container environment; leaving it untouched"
    return 1
  fi
  while IFS= read -r line || [[ -n "${line}" ]]; do
    case "${line}" in
      POSTGRES_USER=*) pg_user="${line#POSTGRES_USER=}" ;;
      POSTGRES_DB=*) pg_db="${line#POSTGRES_DB=}" ;;
    esac
  done <<<"${inspect_env}"
  inspect_env=""
  unset inspect_env

  if [[ "${pg_user}" != "aiteam" || "${pg_db}" != "aiteam_v1" ]]; then
    log "existing PostgreSQL POSTGRES_USER/POSTGRES_DB mismatch; leaving it untouched"
    return 1
  fi
  if [[ "${volume_name}" != "${expected_volume}" ]]; then
    log "existing PostgreSQL data volume mismatch (expected ${expected_volume}); leaving it untouched"
    return 1
  fi

  case "${status}" in
    running)
      log "reusing verified running PostgreSQL container aiteam-pg"
      return 0
      ;;
    exited|created)
      log "starting verified existing PostgreSQL container aiteam-pg"
      start_output="$(docker start aiteam-pg 2>&1)" || start_rc=$?
      if [[ -n "${start_output}" ]]; then
        printf '%s\n' "${start_output}" | redact_dependency_start_output
      fi
      if (( start_rc != 0 )); then
        log "docker start aiteam-pg failed; leaving it untouched"
        return 1
      fi
      log "started verified existing PostgreSQL container aiteam-pg"
      return 0
      ;;
    *)
      log "existing PostgreSQL container aiteam-pg has unsupported status ${status}; leaving it untouched"
      return 1
      ;;
  esac
}

start_release_dependency() {
  local server="$1"
  local label="$2"
  local output=""
  local rc=0
  output="$("${DEPLOY_ROOT}/scripts/ctl.sh" start --env "${ENV_TARGET}" --deploy docker --server "${server}" 2>&1)" || rc=$?
  if [[ -n "${output}" ]]; then
    printf '%s\n' "${output}" | redact_dependency_start_output
  fi
  if (( rc == 0 )); then
    return 0
  fi
  if [[ "${server}" == "postgres" ]] && postgres_container_name_conflict "${output}"; then
    if recover_existing_postgres_container; then
      return 0
    fi
  fi
  dump_dependency_compose_ps
  fail "${label} dependency is not available for backup/DDL"
}
# --- end dependency start diagnostics ---

cd "$DEPLOY_ROOT"

# TEST 发布先停止应用 writers。systemd ExecStop 可能同时停止依赖；依赖会
# 在代码同步/备份前由下方受控的 docker start 显式恢复。失败保持停机，避免
# 在旧代码仍写库时 checkout 或备份。
if systemctl is-active --quiet "$UNIT_NAME" 2>/dev/null; then
  log "stopping application writers (unit=${UNIT_NAME}) before code sync"
  systemctl stop "$UNIT_NAME" 2>&1 || fail "failed to stop application writers; release remains stopped"
else
  log "application writers already stopped (unit=${UNIT_NAME})"
fi

if [[ ! -d ".git" ]]; then
  fail "${DEPLOY_ROOT} is not a git repository — bootstrap it first (see deploy/ci/README.md)"
fi
if ! git config --global --get-all safe.directory 2>/dev/null | grep -Fxq "$DEPLOY_ROOT"; then
  git config --global --add safe.directory "$DEPLOY_ROOT" || fail "cannot mark ${DEPLOY_ROOT} as a safe git directory"
fi

# 1) 同步目标分支最新代码
log "fetch + checkout + pull '${BRANCH}'"
git fetch --all --prune 2>&1 || fail "git fetch failed (network?)"
if ! git show-ref --verify --quiet "refs/remotes/origin/${BRANCH}"; then
  fail "branch '${BRANCH}' does not exist on origin"
fi
# Reset the local deployment branch to the fetched remote tip before pull. This
# also makes a first deploy of a newly requested branch work without a
# pre-created local branch; ignored env/dist files are preserved.
git checkout -B "$BRANCH" "origin/$BRANCH" 2>&1 | tail -1 || fail "checkout '${BRANCH}' failed"
git pull --ff-only origin "$BRANCH" 2>&1 || fail "git pull --ff-only '${BRANCH}' failed (diverged)"
log "code ready @ $(git rev-parse --short HEAD)"

# 2) 前端产物无条件每次 CI 都重新 build（部署根下需已装 node >=22 + pnpm >=11）。
#    条件性 build 容易因为残留旧的 dist/导致前后端不一致；每次重建代价
#    可控（pnpm install --frozen-lockfile ~10s, pnpm build --parallel ~3s）。
log "building web frontend"
if ! command -v pnpm >/dev/null 2>&1 || ! command -v corepack >/dev/null 2>&1; then
  fail "pnpm and corepack are required — install Node.js >=22 first (see deploy/ci/README.md)"
fi
# The host may have a newer global pnpm than the repository pin.  Direct
# recursive scripts invoke `pnpm` again, so merely wrapping the top-level
# command with corepack is not enough; put the pinned Corepack binary first on
# PATH for both the build command and its child scripts.
PNPM_VERSION="$(node -p "require('./web/package.json').packageManager.replace(/^pnpm@/, '')" 2>/dev/null || true)"
[[ "${PNPM_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "web/package.json has no pinned pnpm version"
corepack "pnpm@${PNPM_VERSION}" --version >/dev/null 2>&1 || fail "pnpm ${PNPM_VERSION} is unavailable"
PNPM_MJS="$(find "${COREPACK_HOME:-${HOME}/.cache/node/corepack}" -path "*/pnpm/${PNPM_VERSION}/bin/pnpm.mjs" -print -quit 2>/dev/null || true)"
[[ -f "${PNPM_MJS}" ]] || fail "Corepack pnpm ${PNPM_VERSION} binary was not cached"
PNPM_SHIM_DIR="$(mktemp -d)"
ln -s "${PNPM_MJS}" "${PNPM_SHIM_DIR}/pnpm"
export PATH="${PNPM_SHIM_DIR}:${PATH}"
hash -r 2>/dev/null || true
[[ "$(pnpm --version)" == "${PNPM_VERSION}" ]] || fail "pnpm version mismatch after Corepack setup"
(cd web && pnpm install --frozen-lockfile 2>&1 || fail "pnpm install failed: check network / registry")
(cd web && pnpm build 2>&1 || fail "pnpm build failed: see build errors above")
rm -rf "${PNPM_SHIM_DIR}"

# Hash-gated install of the checked-out pin file. Never use system Python, and
# never source TEST secrets into pip / install hooks.
if [[ ! -x "${DEPLOY_ROOT}/.venv/bin/python" ]]; then
  fail "persistent .venv/bin/python is required; bootstrap it per deploy/ci/README.md"
fi
VENV_PYTHON="${DEPLOY_ROOT}/.venv/bin/python"
sync_persistent_venv_requirements "${VENV_PYTHON}"

# 3) NewAPI 数据在服务重启/升级前先做可恢复备份（首次部署无容器时跳过）。
ENV_FILE="${DEPLOY_ROOT}/.env.${ENV_TARGET}"
[[ -f "${ENV_FILE}" ]] || fail "environment file missing: ${ENV_FILE}"
chmod 600 "${ENV_FILE}"
set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a

# systemd's simple stop also stops the local dependency containers.  Bring the
# migration/backup dependencies back while application writers remain stopped;
# never run backup or DDL against a stopped/unknown database.
log "starting PostgreSQL/NewAPI dependencies while applications remain stopped"
start_release_dependency postgres PostgreSQL
start_release_dependency newapi NewAPI

persist_env_value() {
  local name="$1" value="$2"
  [[ -n "$value" ]] || return 0
  # The GitHub secret is the normal source of truth. Only recover a missing
  # component value from an already-running container, then persist it locally
  # so a later reboot does not silently fall back to a different default.
  if ! grep -Eq "^${name}=.+" "${ENV_FILE}"; then
    printf '%s=%q\n' "$name" "$value" >>"${ENV_FILE}"
  fi
  export "${name}=${value}"
}

hydrate_existing_newapi_env() {
  local pg_env app_env line name value redis_url
  pg_env="$(docker inspect aiteam-newapi-pg --format '{{range .Config.Env}}{{println .}}{{end}}')" \
    || fail "cannot inspect running NewAPI PostgreSQL container"
  while IFS= read -r line; do
    name="${line%%=*}"
    value="${line#*=}"
    case "$name" in
      POSTGRES_USER) persist_env_value NEWAPI_DB_USER "$value" ;;
      POSTGRES_PASSWORD) persist_env_value NEWAPI_DB_PASSWORD "$value" ;;
      POSTGRES_DB) persist_env_value NEWAPI_DB_NAME "$value" ;;
    esac
  done <<<"${pg_env}"

  app_env="$(docker inspect aiteam-newapi --format '{{range .Config.Env}}{{println .}}{{end}}')" \
    || fail "cannot inspect running NewAPI container"
  while IFS= read -r line; do
    name="${line%%=*}"
    value="${line#*=}"
    case "$name" in
      SESSION_SECRET) persist_env_value NEWAPI_SESSION_SECRET "$value" ;;
      CRYPTO_SECRET) persist_env_value NEWAPI_CRYPTO_SECRET "$value" ;;
      REDIS_CONN_STRING)
        redis_url="$value"
        if [[ "$redis_url" == redis://:*@* ]]; then
          redis_url="${redis_url#redis://:}"
          redis_url="${redis_url%@*}"
          persist_env_value NEWAPI_REDIS_PASSWORD "$redis_url"
        fi
        ;;
    esac
  done <<<"${app_env}"
  persist_env_value NEWAPI_IMAGE "$(docker inspect aiteam-newapi --format '{{.Config.Image}}')"
}

if docker ps --format '{{.Names}}' | grep -qx 'aiteam-newapi-pg'; then
  hydrate_existing_newapi_env
  log "backing up internal NewAPI before restart"
  scripts/newapi-ops.sh --env-file "${ENV_FILE}" backup || fail "NewAPI backup failed"
else
  log "NewAPI database container not present yet; skipping pre-restart backup"
fi

# 4) 应用迁移/DDL。此时应用 writers 仍停止、PostgreSQL 已由上面显式启动；
#    只用管理 DSN 执行 Manager/Operation migration，绝不让 app_rw 承担 DDL。
DB_URL_FOR_MIGRATION="${DB_URL:-postgresql://${POSTGRES_USER:-app_rw}:${POSTGRES_PASSWORD:-}@${POSTGRES_HOST:-localhost}:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-aiteam_v1}}"
ADMIN_DB_URL_FOR_MIGRATION="${ADMIN_DB_URL:-postgresql://${POSTGRES_SUPER_USER:-${POSTGRES_USER:-app_rw}}:${POSTGRES_SUPER_PASSWORD:-${POSTGRES_PASSWORD:-}}@${POSTGRES_HOST:-localhost}:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-aiteam_v1}}"
APP_RW_PASSWORD_FOR_MIGRATION="${APP_RW_PASSWORD:-${POSTGRES_PASSWORD:-}}"
if ! DB_URL="${DB_URL_FOR_MIGRATION}" ADMIN_DB_URL="${ADMIN_DB_URL_FOR_MIGRATION}" APP_RW_PASSWORD="${APP_RW_PASSWORD_FOR_MIGRATION}" \
  PYTHONPATH="${DEPLOY_ROOT}/server" "${VENV_PYTHON}" - <<'PY'
import os

from shared.db import apply_migrations as apply_manager_migrations
from operation_service.repository import apply_migrations as apply_operation_migrations

admin_url = os.environ["ADMIN_DB_URL"]
password = os.environ.get("APP_RW_PASSWORD")
apply_manager_migrations(admin_url, password)
apply_operation_migrations(admin_url, password)
PY
then
  fail "Manager/Operation DDL or migration failed; application writers remain stopped"
fi
log "Manager/Operation migrations complete while applications remain stopped"

# 5) 装 systemd unit（内容变了才 daemon-reload）
UNIT_SRC="${DEPLOY_ROOT}/deploy/ci/${UNIT_NAME}.service"
UNIT_DST="/etc/systemd/system/${UNIT_NAME}.service"
[[ -f "$UNIT_SRC" ]] || fail "unit file not found: ${UNIT_SRC}"
mkdir -p /etc/systemd/system
if ! cmp -s "$UNIT_SRC" "$UNIT_DST" 2>/dev/null; then
  cp "$UNIT_SRC" "$UNIT_DST"
  log "installed ${UNIT_DST} (content changed)"
  systemctl daemon-reload >/dev/null 2>&1 || fail "systemctl daemon-reload failed"
else
  log "${UNIT_DST} content unchanged"
fi

# 6) 启动 / 重启 daemon
log "restarting ${UNIT_NAME}"
systemctl enable "$UNIT_NAME" >/dev/null 2>&1 || fail "systemctl enable ${UNIT_NAME} failed — deployment would not survive reboot"
if ! systemctl restart "$UNIT_NAME" 2>&1; then
  systemctl status "$UNIT_NAME" --no-pager >&2 || true
  fail "systemctl restart ${UNIT_NAME} failed — see status above"
fi

# 7) /healthz + internal NewAPI 冒烟；GET / 必须是 HTML
log "smoking /healthz"
sleep 5
for port in 8781 8782 8783; do
  ok=0
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS --max-time 3 "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
      log "  port ${port} /healthz OK"; ok=1; break
    fi
    sleep 2
  done
  (( ok )) || fail "port ${port} /healthz failed after 10 attempts"
done

newapi_admin_url="${NEWAPI_ADMIN_BASE_URL:-${NEWAPI_URL:-http://127.0.0.1:${NEWAPI_PORT:-9300}}}"
newapi_ok=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 3 "${newapi_admin_url%/}/api/status" 2>/dev/null | grep -Eq '"success"[[:space:]]*:[[:space:]]*true'; then
    newapi_ok=1; break
  fi
  sleep 2
done
(( newapi_ok )) || fail "internal NewAPI /api/status failed after 10 attempts"
for container in aiteam-newapi-pg aiteam-newapi-redis aiteam-newapi; do
  state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${container}" 2>/dev/null || true)"
  [[ "${state}" == "healthy" || "${state}" == "running" ]] || fail "${container} is not healthy (state=${state:-missing})"
done
log "  internal NewAPI + PostgreSQL + Redis OK"

log "smoking GET / (front-end SPA entry must be HTML, not 404 Problem JSON)"
for port in 8781 8782 8783; do
  root_ct="$(curl -fsS -o /dev/null -w '%{content_type}' --max-time 5 "http://127.0.0.1:${port}/" 2>/dev/null || true)"
  if [[ "${root_ct}" != text/html* ]]; then
    fail "port ${port} GET / expected text/html, got '${root_ct:-no-response}' — front-end dist not mounted"
  fi
  log "  port ${port} / -> ${root_ct}"
done

log "deploy-run done (unit=${UNIT_NAME}, env=${ENV_TARGET}, branch=${BRANCH})"
