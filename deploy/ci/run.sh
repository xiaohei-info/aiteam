#!/usr/bin/env bash
# v1 部署编排脚本，在 self-hosted runner 的 ta iy 机器上运行。
#
# 默认在当前持久化部署根执行；DEPLOY_ROOT 可由 CI/运维显式指定。
# 该目录应已是一个 git 仓库（origin = git@github.com:...）并具备可用的 .venv。
#
# 与此前"条件性 build / fallback 到默认分支"的行为不同，本脚本
# 严格要求调用方给出明确分支；分支为空即 fail。
#
# 先构建后切换（失败就报错；只有下面写明的两个阶段会自动回滚）：
#   1) 应用仍在运行：在旁路目录 <DEPLOY_ROOT>-stage 拉取目标提交，装依赖、构建前端、
#      跑 Agent 登录检查、准备 Python wheels。这一步失败，线上版本不受影响。
#   1b) 迁移全部向后兼容时，在旧版本运行期间执行迁移；带收缩型迁移
#      （文件含 `-- deploy-compat: contract`）的发布改在第 4 步停机后执行。
#   2) 停止 systemd 管理的 Manager/Operation/Agent application writers
#   3) 停机窗口内只做本地、离线动作：切换代码、离线装运行时依赖、替换前端产物、同步 venv
#   4) 确认 PostgreSQL/NewAPI 依赖运行后备份并执行管理迁移/DDL
#   5) 安装 systemd unit、启动新三端应用栈
#   6) /healthz 冒烟 + GET / 必须是 HTML
#
# 第 3 步和第 5–6 步失败会自动切回上一个版本并启动；第 4 步失败保持停机、人工对账。
# 本流程仍有一次短暂停机（停应用到新栈健康），不是零停机/cgroup cutover；可选的
# S05 systemd probe 只在独立 hosted workflow 验证，不能由本脚本或 deploy-main 调用。

set -euo pipefail

# Git refuses a persistent checkout with a different owner unless it is marked
# safe. Self-hosted runner services may also omit HOME entirely.
export HOME="${HOME:-/root}"
umask 077

BRANCH="${DEPLOY_BRANCH:-}"
ENV_TARGET="${DEPLOY_ENV:-test}"
UNIT_NAME="${UNIT_NAME:-aiteam-v1}"
DEPLOY_ROOT="${DEPLOY_ROOT:-$(pwd)}"
[[ -d "${DEPLOY_ROOT}" ]] || { echo "[deploy-run][ERR] DEPLOY_ROOT does not exist: ${DEPLOY_ROOT}" >&2; exit 2; }
DEPLOY_ROOT="$(cd "${DEPLOY_ROOT}" && pwd -P)"

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
is_placeholder_secret() {
  local value="${1:-}" lower
  lower="$(printf '%s' "${value}" | tr '[:upper:]' '[:lower:]')"
  [[ "${lower}" == *change-me* || "${lower}" == *change_me* || "${lower}" == *change\ me* || "${lower}" == *changeme* || "${lower}" == *app_rw_dev* || "${lower}" == *aiteam_dev* || "${lower}" == *newapi_dev* || "${lower}" == *newapi_test* || "${lower}" == *dev-service-token-placeholder* || "${lower}" == *dev-service-token-changeme* ]]
}

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
    -e 's/(^|[[:space:]])([A-Za-z_][A-Za-z0-9_]*(PASSWORD|TOKEN|SECRET|API_KEY|DB_URL|DSN|URI))=[^[:space:]]+/\1\2=<redacted>/g'
}

dump_dependency_compose_ps() {
  local compose_dir="${DEPLOY_ROOT}/deploy/docker"
  local compose_files=(-f "${compose_dir}/docker-compose.yml")
  if [[ "${AITEAM_ENV:-}" == "production" && -f "${compose_dir}/docker-compose.maintenance.yml" ]]; then
    compose_files+=(-f "${compose_dir}/docker-compose.maintenance.yml")
  fi
  if [[ ! -f "${compose_dir}/docker-compose.yml" ]]; then
    log "dependency compose file missing; skipping docker compose ps"
    return 0
  fi
  log "dependency compose ps --all (names/status only)"
  (
    cd "${compose_dir}"
    docker compose "${compose_files[@]}" --profile newapi ps --all --format '{{.Name}} {{.Service}} {{.Status}}'
  ) 2>&1 | redact_dependency_start_output | head -n 50 || true
}

postgres_container_name_conflict() {
  grep -Eq 'container name "/?aiteam-pg" is already in use' <<<"$1"
}

recover_existing_postgres_container() {
  local inspect_meta inspect_env port_bindings network_mode line
  local name="" image="" status="" volume_name=""
  local pg_user="" pg_db=""
  local expected_image expected_volume expected_pg_user expected_pg_db
  local start_output="" start_rc=0

  expected_image="${POSTGRES_IMAGE:-pgvector/pgvector:pg16}"
  expected_volume="${POSTGRES_VOLUME:-aiteam_pg_data_${ENV_TARGET}}"
  expected_pg_user="${POSTGRES_SUPER_USER:-aiteam}"
  expected_pg_db="${MANAGER_DB_NAME:-${POSTGRES_DB:-manager_control_db}}"

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

  if ! network_mode="$(docker inspect --format '{{.HostConfig.NetworkMode}}' aiteam-pg 2>/dev/null)"; then
    log "cannot inspect existing PostgreSQL network mode; leaving it untouched"
    return 1
  fi
  case "${network_mode}" in
    host|container:*)
      log "existing PostgreSQL network mode is not isolated (${network_mode}); leaving it untouched"
      return 1
      ;;
  esac
  if ! port_bindings="$(docker inspect --format '{{json .HostConfig.PortBindings}}' aiteam-pg 2>/dev/null)"; then
    log "cannot inspect existing PostgreSQL host bindings; leaving it untouched"
    return 1
  fi
  if ! PORT_BINDINGS_CHECK="${port_bindings}" python3 - <<'PY'
import json
import os

try:
    bindings = json.loads(os.environ["PORT_BINDINGS_CHECK"] or "{}")
    if bindings is None:
        bindings = {}
    if not isinstance(bindings, dict):
        raise ValueError
    for entries in bindings.values():
        if entries is None:
            continue
        if not isinstance(entries, list):
            raise ValueError
        for entry in entries:
            if not isinstance(entry, dict) or entry.get("HostIp") not in {"127.0.0.1", "::1", "localhost"}:
                raise ValueError
except (KeyError, TypeError, ValueError, json.JSONDecodeError):
    raise SystemExit(1)
PY
  then
    log "existing PostgreSQL host binding is not loopback-only; leaving it untouched"
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

  if [[ "${pg_user}" != "${expected_pg_user}" || "${pg_db}" != "${expected_pg_db}" || "${expected_pg_user}" == "app_rw" ]]; then
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

# --- release prepare and cutover ---
# 先构建后切换：新版本的拉取、依赖安装、构建与检查都在旁路目录完成，此时旧版本
# 仍在运行；全部成功后才停应用。停机窗口内只做本地、离线的动作。
#
#   prepare  应用运行中。任何失败都直接退出，线上版本不受影响。
#   switch   应用已停。切换代码、离线装依赖、换前端产物、同步 venv。失败自动回滚。
#   data     依赖启动、备份、（未在线完成时的）DDL/迁移。失败保持停机并人工对账（沿用既有约定）。
#   start    迁移已完成。启动与冒烟失败时自动回滚，除非本次发布带有收缩型迁移。
#   stopping 正在停应用；失败时状态未知，不自动处理。
#   done     发布完成。
STAGE_DIR="${DEPLOY_STAGE_DIR:-${DEPLOY_ROOT}-stage}"
STAGE_CACHE_DIR="${STAGE_DIR}/.deploy-cache"
WEB_TIERS=(operation manager agent)
NODE_PACKAGES=(server/agent_service server/solution_authoring_worker)
CONTRACT_MIGRATION_MARKER='-- deploy-compat: contract'
DEPLOY_PHASE="prepare"
TARGET_SHA=""
PREVIOUS_SHA=""
WAS_ACTIVE=0
MIGRATED_ONLINE=0
PIP_WHEELHOUSE=""
PNPM_SHIM_DIR=""

# The host may have a newer global pnpm than the repository pin.  Direct
# recursive scripts invoke `pnpm` again, so merely wrapping the top-level
# command with corepack is not enough; put the pinned Corepack binary first on
# PATH for both the build command and its child scripts.
setup_pinned_pnpm() {
  local tree="$1" pnpm_version pnpm_mjs
  if ! command -v pnpm >/dev/null 2>&1 || ! command -v corepack >/dev/null 2>&1; then
    fail "pnpm and corepack are required — install Node.js >=22 first (see deploy/ci/README.md)"
  fi
  pnpm_version="$(AITEAM_WEB_PACKAGE_JSON="${tree}/web/package.json" node -p "require(process.env.AITEAM_WEB_PACKAGE_JSON).packageManager.replace(/^pnpm@/, '')" 2>/dev/null || true)"
  [[ "${pnpm_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "web/package.json has no pinned pnpm version"
  corepack "pnpm@${pnpm_version}" --version >/dev/null 2>&1 || fail "pnpm ${pnpm_version} is unavailable"
  pnpm_mjs="$(find "${COREPACK_HOME:-${HOME}/.cache/node/corepack}" -path "*/pnpm/${pnpm_version}/bin/pnpm.mjs" -print -quit 2>/dev/null || true)"
  [[ -f "${pnpm_mjs}" ]] || fail "Corepack pnpm ${pnpm_version} binary was not cached"
  PNPM_SHIM_DIR="$(mktemp -d)"
  ln -s "${pnpm_mjs}" "${PNPM_SHIM_DIR}/pnpm"
  export PATH="${PNPM_SHIM_DIR}:${PATH}"
  hash -r 2>/dev/null || true
  [[ "$(pnpm --version)" == "${pnpm_version}" ]] || fail "pnpm version mismatch after Corepack setup"
}

# The stage is a detached git worktree of the deployment checkout: it shares the
# object store, keeps its own node_modules between deploys, and is never served.
prepare_stage_checkout() {
  local sha="$1" stage_common live_common
  if [[ -e "${STAGE_DIR}" ]]; then
    stage_common="$(cd "${STAGE_DIR}" 2>/dev/null && cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P || true)"
    live_common="$(cd "${DEPLOY_ROOT}" && cd "$(git rev-parse --git-common-dir)" && pwd -P)"
    if [[ -z "${stage_common}" || "${stage_common}" != "${live_common}" ]]; then
      fail "stage directory ${STAGE_DIR} is not a worktree of ${DEPLOY_ROOT}; remove it manually and redeploy"
    fi
    git -C "${STAGE_DIR}" checkout --force --detach "${sha}" 2>&1 | tail -1 \
      || fail "cannot refresh stage worktree at ${sha:0:8}"
  else
    git -C "${DEPLOY_ROOT}" worktree prune 2>&1 || true
    git -C "${DEPLOY_ROOT}" worktree add --force --detach "${STAGE_DIR}" "${sha}" 2>&1 | tail -1 \
      || fail "cannot create stage worktree ${STAGE_DIR}"
  fi
  [[ "$(git -C "${STAGE_DIR}" rev-parse HEAD)" == "${sha}" ]] || fail "stage worktree is not at ${sha:0:8}"
}

# Build wheels for the target requirements while the old release still runs, so
# the venv sync inside the stop window needs no network. Skipped when unchanged.
prepare_python_wheelhouse() {
  local venv_python="${DEPLOY_ROOT}/.venv/bin/python"
  local req_file="${STAGE_DIR}/server/requirements.txt"
  local marker="${DEPLOY_ROOT}/.venv/.aiteam-requirements.sha256"
  local wheelhouse="${STAGE_CACHE_DIR}/wheelhouse"
  local req_hash current=""

  PIP_WHEELHOUSE=""
  [[ -x "${venv_python}" ]] || fail "persistent .venv/bin/python is required; bootstrap it per deploy/ci/README.md"
  [[ -f "${req_file}" ]] || fail "server/requirements.txt missing in stage worktree"
  req_hash="$(AITEAM_REQUIREMENTS_FILE="${req_file}" "${venv_python}" -c "import hashlib, os, pathlib; print(hashlib.sha256(pathlib.Path(os.environ['AITEAM_REQUIREMENTS_FILE']).read_bytes()).hexdigest())")" \
    || fail "cannot hash staged server/requirements.txt"
  if [[ -f "${marker}" ]]; then
    current="$(tr -d '[:space:]' < "${marker}")"
  fi
  if [[ "${current}" == "${req_hash}" ]]; then
    log "python requirements unchanged; no wheels to prepare"
    return 0
  fi
  log "preparing python wheels for changed requirements ${req_hash:0:12}"
  rm -rf "${wheelhouse}"
  mkdir -p "${wheelhouse}"
  "${venv_python}" -m pip wheel --requirement "${req_file}" --wheel-dir "${wheelhouse}" \
    || fail "pip wheel for server/requirements.txt failed; running release untouched"
  PIP_WHEELHOUSE="${wheelhouse}"
}

# Everything that needs the network or can fail on its own merits happens here,
# before the running release is touched.
prepare_release() {
  local pkg tier
  log "fetch '${BRANCH}' (running release untouched)"
  git fetch --all --prune 2>&1 || fail "git fetch failed (network?); running release untouched"
  if ! git show-ref --verify --quiet "refs/remotes/origin/${BRANCH}"; then
    fail "branch '${BRANCH}' does not exist on origin"
  fi
  TARGET_SHA="$(git rev-parse --verify "refs/remotes/origin/${BRANCH}^{commit}")" || fail "cannot resolve origin/${BRANCH}"
  PREVIOUS_SHA="$(git rev-parse --verify 'HEAD^{commit}' 2>/dev/null || true)"
  log "preparing ${TARGET_SHA:0:8} in ${STAGE_DIR} (running ${PREVIOUS_SHA:0:8})"
  prepare_stage_checkout "${TARGET_SHA}"
  setup_pinned_pnpm "${STAGE_DIR}"

  # Agent and the solution-authoring worker are independent packages (own lockfiles,
  # outside web/pnpm-workspace.yaml) and run from source. Installing them here fills
  # the shared pnpm store, so the live tree can be installed offline after the stop.
  for pkg in "${NODE_PACKAGES[@]}"; do
    (cd "${STAGE_DIR}/${pkg}" && pnpm install --frozen-lockfile 2>&1) \
      || fail "${pkg} pnpm install failed: check network / registry; running release untouched"
  done
  # Verify the secure login seam against a local synthetic Manager before any cutover.
  (cd "${STAGE_DIR}/server/agent_service" && pnpm check && pnpm exec tsx --test --test-concurrency=1 src/http/auth.test.ts src/http/manager-jwks.test.ts) \
    || fail "Agent authentication checks failed; running release untouched"

  # 前端产物每次部署都在旁路目录重新 build，切换时整体替换，避免前后端不一致。
  log "building web frontend in stage"
  (cd "${STAGE_DIR}/web" && pnpm install --frozen-lockfile 2>&1) \
    || fail "web pnpm install failed: check network / registry; running release untouched"
  (cd "${STAGE_DIR}/web" && pnpm build 2>&1) \
    || fail "pnpm build failed: see build errors above; running release untouched"
  for tier in "${WEB_TIERS[@]}"; do
    [[ -f "${STAGE_DIR}/web/${tier}/dist/index.html" ]] \
      || fail "staged web/${tier}/dist/index.html missing after build; running release untouched"
  done

  prepare_python_wheelhouse
  log "release ${TARGET_SHA:0:8} prepared"
}

install_live_node_package() {
  local pkg="$1"
  if (cd "${DEPLOY_ROOT}/${pkg}" && pnpm install --frozen-lockfile --offline 2>&1); then
    return 0
  fi
  log "${pkg} offline install failed; retrying with the registry"
  (cd "${DEPLOY_ROOT}/${pkg}" && pnpm install --frozen-lockfile 2>&1) \
    || fail "${pkg} pnpm install failed: check network / registry"
}

# Replace each served dist with the staged build. The replaced dist is kept in
# the stage cache so a rollback can put it back.
publish_web_dist() {
  local tier src dst keep
  for tier in "${WEB_TIERS[@]}"; do
    src="${STAGE_DIR}/web/${tier}/dist"
    dst="${DEPLOY_ROOT}/web/${tier}/dist"
    keep="${STAGE_CACHE_DIR}/previous-dist/${tier}"
    rm -rf "${dst}.incoming"
    cp -R "${src}" "${dst}.incoming" || fail "cannot copy staged web/${tier}/dist"
    rm -rf "${keep}"
    mkdir -p "$(dirname "${keep}")"
    if [[ -d "${dst}" ]]; then
      mv "${dst}" "${keep}" || fail "cannot set aside current web/${tier}/dist"
    fi
    mv "${dst}.incoming" "${dst}" || fail "cannot publish web/${tier}/dist"
  done
}

# Runs inside the stop window: local and offline only.
activate_release() {
  local pkg
  # Anything kept from an earlier deploy is stale; a rollback must only restore
  # what this deploy replaces.
  rm -rf "${STAGE_CACHE_DIR}/previous-dist"
  log "checkout '${BRANCH}' @ ${TARGET_SHA:0:8}"
  # Reset the local deployment branch to the fetched remote tip. This also makes
  # a first deploy of a newly requested branch work without a pre-created local
  # branch; ignored env/dist files are preserved. No second fetch: the stop
  # window must not depend on the network.
  git checkout -B "$BRANCH" "origin/$BRANCH" 2>&1 | tail -1 || fail "checkout '${BRANCH}' failed"
  [[ "$(git rev-parse HEAD)" == "${TARGET_SHA}" ]] \
    || fail "origin/${BRANCH} moved after prepare; expected ${TARGET_SHA:0:8}"
  log "code ready @ $(git rev-parse --short HEAD)"
  for pkg in "${NODE_PACKAGES[@]}"; do
    install_live_node_package "${pkg}"
  done
  publish_web_dist
}

# Venv sync inside the stop window. Uses the prepared wheels (no network); falls
# back to the index only if the offline install fails.
sync_venv_for_release() {
  local venv_python="$1"
  if [[ -n "${PIP_WHEELHOUSE}" ]]; then
    if (export PIP_NO_INDEX=1 PIP_FIND_LINKS="${PIP_WHEELHOUSE}"; sync_persistent_venv_requirements "${venv_python}"); then
      return 0
    fi
    log "offline venv sync failed; retrying with the index"
  fi
  sync_persistent_venv_requirements "${venv_python}"
}

smoke_healthz() {
  local port ok attempt
  sleep "${DEPLOY_HEALTHZ_WARMUP_SECONDS:-5}"
  for port in 8781 8782 8783; do
    ok=0
    # shellcheck disable=SC2034  # attempt 只用来计数
    for attempt in 1 2 3 4 5 6 7 8 9 10; do
      if curl -fsS --max-time 3 "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
        log "  port ${port} /healthz OK"; ok=1; break
      fi
      sleep "${DEPLOY_HEALTHZ_RETRY_SECONDS:-2}"
    done
    (( ok )) || { log "port ${port} /healthz failed after 10 attempts"; return 1; }
  done
}

# A contract migration removes or narrows something the previous release still
# uses, so the previous release must not be started against the migrated schema.
release_has_contract_migration() {
  local files file
  files="$(git diff --name-only --diff-filter=AM "${PREVIOUS_SHA}" "${TARGET_SHA}" -- 'server/*/migrations/*.sql' 2>/dev/null)" || return 0
  while IFS= read -r file; do
    [[ -n "${file}" ]] || continue
    if git show "${TARGET_SHA}:${file}" 2>/dev/null | grep -Fq -- "${CONTRACT_MIGRATION_MARKER}"; then
      return 0
    fi
  done <<<"${files}"
  return 1
}

rollback_allowed() {
  (( WAS_ACTIVE == 1 )) || { log "no rollback: the application was not running before this deploy"; return 1; }
  [[ -n "${PREVIOUS_SHA}" && -n "${TARGET_SHA}" && "${PREVIOUS_SHA}" != "${TARGET_SHA}" ]] \
    || { log "no rollback: there is no different previous release"; return 1; }
  if [[ "${DEPLOY_PHASE}" == "start" ]] && release_has_contract_migration; then
    log "no rollback: this release applied a contract migration (${CONTRACT_MIGRATION_MARKER})"
    return 1
  fi
  return 0
}

# Put the previous release back and start it. Local and offline only; the venv
# and the database are left as they are (migrations must be backward compatible).
rollback_release() {
  local pkg tier dst keep
  log "ROLLBACK to previous release ${PREVIOUS_SHA:0:8}"
  cd "${DEPLOY_ROOT}" || return 1
  git checkout -B "$BRANCH" "${PREVIOUS_SHA}" 2>&1 | tail -1 || return 1
  for pkg in "${NODE_PACKAGES[@]}"; do
    [[ -d "${DEPLOY_ROOT}/${pkg}" ]] || continue
    (cd "${DEPLOY_ROOT}/${pkg}" && pnpm install --frozen-lockfile --offline 2>&1) || return 1
  done
  for tier in "${WEB_TIERS[@]}"; do
    dst="${DEPLOY_ROOT}/web/${tier}/dist"
    keep="${STAGE_CACHE_DIR}/previous-dist/${tier}"
    [[ -d "${keep}" ]] || continue
    rm -rf "${dst}.incoming" "${dst}"
    mv "${keep}" "${dst}" || return 1
  done
  systemctl restart "${UNIT_NAME}" 2>&1 || return 1
  smoke_healthz || return 1
  log "ROLLBACK complete: previous release ${PREVIOUS_SHA:0:8} is running; this deploy still failed"
}

on_deploy_exit() {
  local rc=$?
  trap - EXIT
  set +e
  if (( rc != 0 )); then
    case "${DEPLOY_PHASE}" in
      prepare)
        log "deploy aborted before cutover; the running release was not touched" ;;
      stopping)
        log "stopping the application failed; its state is unknown — check systemctl status" ;;
      switch|start)
        if rollback_allowed; then
          rollback_release || log "ROLLBACK FAILED; application remains stopped — recover manually"
        else
          log "application remains stopped — recover manually"
        fi ;;
      data)
        log "dependency/backup/DDL step failed; application remains stopped — reconcile manually, no automatic rollback" ;;
    esac
  fi
  [[ -z "${UNIT_RENDERED:-}" ]] || rm -f -- "${UNIT_RENDERED}"
  [[ -z "${migration_env_file:-}" ]] || rm -f -- "${migration_env_file}"
  [[ -z "${PNPM_SHIM_DIR:-}" ]] || rm -rf -- "${PNPM_SHIM_DIR}"
  exit "${rc}"
}
# Load the selected environment file. Call only after every pnpm/pip step that
# must not see TEST secrets, or inside a subshell.
load_release_env() {
ENV_FILE="${DEPLOY_ROOT}/.env.${ENV_TARGET}"
[[ -f "${ENV_FILE}" ]] || fail "environment file missing: ${ENV_FILE}"
chmod 600 "${ENV_FILE}"
set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a
# The deployment target is the authoritative Compose environment marker when
# the persisted env file predates this requirement; normalize ctl's prod/dev
# aliases to the values accepted by Settings and Compose.
case "${ENV_TARGET}" in
  prod) _default_aiteam_env=production ;;
  dev) _default_aiteam_env=development ;;
  test) _default_aiteam_env=test ;;
  *) _default_aiteam_env="" ;;
esac
if [[ -n "${AITEAM_ENV:-}" && "${AITEAM_ENV}" != "${_default_aiteam_env}" ]]; then
  fail "${ENV_FILE} AITEAM_ENV=${AITEAM_ENV} does not match selected deployment environment ${ENV_TARGET}"
fi
export AITEAM_ENV="${_default_aiteam_env}"
MANAGER_DB_NAME="${MANAGER_DB_NAME:-${POSTGRES_DB:-manager_control_db}}"
OPERATION_DB_NAME="${OPERATION_DB_NAME:-oper}"
export MANAGER_DB_NAME OPERATION_DB_NAME
for database_name in "${MANAGER_DB_NAME}" "${OPERATION_DB_NAME}"; do
  [[ "${database_name}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail "invalid control-plane database name: ${database_name}"
done
[[ "${MANAGER_DB_NAME}" != "${OPERATION_DB_NAME}" ]] || fail "Manager and Operation database names must be distinct"
}

ensure_operation_database() {
  local password="${POSTGRES_SUPER_PASSWORD:-${POSTGRES_PASSWORD:-}}"
  local username="${POSTGRES_SUPER_USER:-${POSTGRES_USER:-aiteam}}"
  local ready=0 exists
  for _ in {1..60}; do
    if docker exec aiteam-pg pg_isready -U "${username}" -d "${MANAGER_DB_NAME}" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  (( ready == 1 )) || return 1
  [[ "${MANAGER_DB_NAME}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ && "${OPERATION_DB_NAME}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
  exists="$(printf '%s\n' "${password}" | docker exec -i aiteam-pg sh -c 'IFS= read -r PGPASSWORD; export PGPASSWORD; psql -XAtq --username="$1" --dbname="$3" -c "SELECT 1 FROM pg_database WHERE datname = '\''$2'\''"' sh "${username}" "${OPERATION_DB_NAME}" "${MANAGER_DB_NAME}")" || return 1
  [[ "${exists}" == "1" ]] && return 0
  printf '%s\n' "${password}" | docker exec -i aiteam-pg sh -c 'IFS= read -r PGPASSWORD; export PGPASSWORD; createdb --username="$1" "$2"' sh "${username}" "${OPERATION_DB_NAME}"
}

# 应用迁移/DDL：只用管理 DSN 执行 Manager/Operation migration，绝不让 app_rw 承担 DDL。
# $1 = 提供迁移脚本的 server 根目录；$2 = 失败时的现场说明。
apply_control_plane_migrations() {
  local server_root="$1" on_failure="$2"
if [[ "${ENV_TARGET}" == "prod" || "${AITEAM_ENV}" == "production" ]]; then
  [[ "${POSTGRES_USER:-}" == "app_rw" ]] || fail "POSTGRES_USER must be app_rw for production control-plane business access"
  [[ -n "${POSTGRES_SUPER_USER:-}" && "${POSTGRES_SUPER_USER}" != "app_rw" ]] && ! is_placeholder_secret "${POSTGRES_SUPER_USER}" || fail "POSTGRES_SUPER_USER must be a distinct production migration role"
fi
APP_RW_PASSWORD_FOR_MIGRATION="${APP_RW_PASSWORD:-${POSTGRES_PASSWORD:-}}"
if [[ "${ENV_TARGET}" == "prod" || "${AITEAM_ENV}" == "production" ]]; then
  [[ ${#APP_RW_PASSWORD_FOR_MIGRATION} -ge 24 ]] && ! is_placeholder_secret "${APP_RW_PASSWORD_FOR_MIGRATION}" || fail "APP_RW_PASSWORD must be a non-placeholder secret of at least 24 characters"
else
  [[ -n "${APP_RW_PASSWORD_FOR_MIGRATION}" ]] || fail "APP_RW_PASSWORD is required for control-plane migrations"
fi
DB_URL_FOR_MIGRATION="postgresql://app_rw:${APP_RW_PASSWORD_FOR_MIGRATION}@${POSTGRES_HOST:-localhost}:${POSTGRES_PORT:-5432}/${MANAGER_DB_NAME}"
ADMIN_DB_URL_FOR_MIGRATION="${ADMIN_DB_URL:-postgresql://${POSTGRES_SUPER_USER:-${POSTGRES_USER:-aiteam}}:${POSTGRES_SUPER_PASSWORD:-${POSTGRES_PASSWORD:-}}@${POSTGRES_HOST:-localhost}:${POSTGRES_PORT:-5432}/${MANAGER_DB_NAME}}"
OPERATION_DB_URL_FOR_MIGRATION="postgresql://app_rw:${APP_RW_PASSWORD_FOR_MIGRATION}@${POSTGRES_HOST:-localhost}:${POSTGRES_PORT:-5432}/${OPERATION_DB_NAME}"
OPERATION_ADMIN_DB_URL_FOR_MIGRATION="${OPERATION_ADMIN_DB_URL:-postgresql://${POSTGRES_SUPER_USER:-${POSTGRES_USER:-aiteam}}:${POSTGRES_SUPER_PASSWORD:-${POSTGRES_PASSWORD:-}}@${POSTGRES_HOST:-localhost}:${POSTGRES_PORT:-5432}/${OPERATION_DB_NAME}}"
migration_env_file="$(mktemp "${DEPLOY_ROOT}/.aiteam-migration-env.XXXXXX")" || fail "cannot create protected migration environment file"
chmod 600 "${migration_env_file}"
{
  printf 'DB_URL=%s\n' "${DB_URL_FOR_MIGRATION}"
  printf 'ADMIN_DB_URL=%s\n' "${ADMIN_DB_URL_FOR_MIGRATION}"
  printf 'OPERATION_DB_URL=%s\n' "${OPERATION_DB_URL_FOR_MIGRATION}"
  printf 'OPERATION_ADMIN_DB_URL=%s\n' "${OPERATION_ADMIN_DB_URL_FOR_MIGRATION}"
  printf 'APP_RW_PASSWORD=%s\n' "${APP_RW_PASSWORD_FOR_MIGRATION}"
} >"${migration_env_file}"
if ! env -i \
  PATH="${PATH}" \
  PYTHONPATH="${server_root}" \
  AITEAM_MIGRATION_ENV_FILE="${migration_env_file}" \
  PGOPTIONS="${MIGRATION_PGOPTIONS:-}" \
  "${DEPLOY_ROOT}/.venv/bin/python" - <<'PY'
import os
from pathlib import Path

for line in Path(os.environ["AITEAM_MIGRATION_ENV_FILE"]).read_text(encoding="utf-8").splitlines():
    key, value = line.split("=", 1)
    os.environ[key] = value

from shared.db import apply_migrations as apply_manager_migrations
from operation_service.repository import apply_migrations as apply_operation_migrations

manager_admin_url = os.environ["ADMIN_DB_URL"]
operation_admin_url = os.environ["OPERATION_ADMIN_DB_URL"]
password = os.environ.get("APP_RW_PASSWORD")
apply_manager_migrations(manager_admin_url, password)
apply_operation_migrations(operation_admin_url, password)
PY
then
  rm -f -- "${migration_env_file}"
  fail "Manager/Operation DDL or migration failed; ${on_failure}"
fi
rm -f -- "${migration_env_file}"
migration_env_file=""
}

# Layer 2: a release whose migrations are all backward compatible (expand-only) is
# migrated while the previous release keeps serving; only a release that carries a
# contract migration, or cannot be migrated with the current venv, is migrated
# inside the stop window.
online_migration_eligible() {
  if [[ "${DEPLOY_ONLINE_MIGRATIONS:-1}" != "1" ]]; then
    log "online migrations disabled (DEPLOY_ONLINE_MIGRATIONS); migrating during the cutover"
    return 1
  fi
  if (( WAS_ACTIVE != 1 )); then
    log "application is not running; migrating during the cutover"
    return 1
  fi
  if [[ -z "${PREVIOUS_SHA}" || "${PREVIOUS_SHA}" == "${TARGET_SHA}" ]]; then
    log "no different previous release; migrating during the cutover"
    return 1
  fi
  if release_has_contract_migration; then
    log "release carries a contract migration (${CONTRACT_MIGRATION_MARKER}); migrating while the application is stopped"
    return 1
  fi
  if ! env -i PATH="${PATH}" PYTHONPATH="${STAGE_DIR}/server" "${DEPLOY_ROOT}/.venv/bin/python" \
      -c 'import shared.db, operation_service.repository' >/dev/null 2>&1; then
    log "staged migration code does not import with the current venv; migrating during the cutover"
    return 1
  fi
  return 0
}

# Runs in a subshell so the environment file never reaches later install steps.
# lock_timeout keeps a blocked DDL from queueing live queries behind it.
migrate_online() {
  local rc=0
  log "applying backward-compatible migrations while the previous release keeps running"
  set +e
  (
    set -e
    load_release_env
    ensure_operation_database || fail "Operation database bootstrap failed"
    MIGRATION_PGOPTIONS="-c lock_timeout=${DEPLOY_MIGRATION_LOCK_TIMEOUT_MS:-5000}"
    apply_control_plane_migrations "${STAGE_DIR}/server" "previous release keeps running on a backward-compatible schema"
  )
  rc=$?
  set -e
  (( rc == 0 )) || fail "online migration failed before cutover; running release untouched"
  MIGRATED_ONLINE=1
  log "Manager/Operation migrations complete while the previous release keeps running"
}

# --- end release prepare and cutover ---

cd "$DEPLOY_ROOT"

if [[ ! -d ".git" ]]; then
  fail "${DEPLOY_ROOT} is not a git repository — bootstrap it first (see deploy/ci/README.md)"
fi
if ! git config --global --get-all safe.directory 2>/dev/null | grep -Fxq "$DEPLOY_ROOT"; then
  git config --global --add safe.directory "$DEPLOY_ROOT" || fail "cannot mark ${DEPLOY_ROOT} as a safe git directory"
fi
trap on_deploy_exit EXIT

# 1) 应用仍在运行：在旁路目录准备新版本（拉取、装依赖、构建、检查、Python wheels）。
#    这一步失败直接退出，线上版本不受影响。
prepare_release

# 1b) 向后兼容的迁移在旧版本运行期间执行；带收缩型迁移的发布留到停机窗口内执行。
if systemctl is-active --quiet "$UNIT_NAME" 2>/dev/null; then
  WAS_ACTIVE=1
fi
if online_migration_eligible; then
  migrate_online
fi

# 2) 停止应用 writers。systemd ExecStop 可能同时停止依赖；依赖会在备份/DDL 前由
#    下方受控的 docker start 显式恢复，避免在旧代码仍写库时切换代码或备份。
if systemctl is-active --quiet "$UNIT_NAME" 2>/dev/null; then
  WAS_ACTIVE=1
  DEPLOY_PHASE="stopping"
  log "stopping application writers (unit=${UNIT_NAME}) before cutover"
  systemctl stop "$UNIT_NAME" 2>&1 || fail "failed to stop application writers; release remains stopped"
else
  log "application writers already stopped (unit=${UNIT_NAME})"
fi
DEPLOY_PHASE="switch"

# 3) 停机窗口：切换代码、离线装运行时依赖、替换前端产物。
activate_release

# Hash-gated install of the checked-out pin file. Never use system Python, and
# never source TEST secrets into pip / install hooks.
if [[ ! -x "${DEPLOY_ROOT}/.venv/bin/python" ]]; then
  fail "persistent .venv/bin/python is required; bootstrap it per deploy/ci/README.md"
fi
VENV_PYTHON="${DEPLOY_ROOT}/.venv/bin/python"
sync_venv_for_release "${VENV_PYTHON}"

# 3) NewAPI 数据在服务重启/升级前先做可恢复备份（首次部署无容器时跳过）。
load_release_env



# systemd's simple stop also stops the local dependency containers.  Bring the
# migration/backup dependencies back while application writers remain stopped;
# never run backup or DDL against a stopped/unknown database.
DEPLOY_PHASE="data"
log "starting PostgreSQL/NewAPI dependencies while applications remain stopped"
start_release_dependency postgres PostgreSQL
ensure_operation_database || fail "Operation database bootstrap failed"
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

# 4) 应用迁移/DDL。已在停机前在线完成的不再重复；否则此时应用 writers 仍停止、
#    PostgreSQL 已由上面显式启动。
if (( MIGRATED_ONLINE == 1 )); then
  log "migrations already applied before the stop; nothing to migrate while applications remain stopped"
else
  apply_control_plane_migrations "${DEPLOY_ROOT}/server" "application writers remain stopped"
  log "Manager/Operation migrations complete while applications remain stopped"
fi
DEPLOY_PHASE="start"

# 5) 装 systemd unit（内容变了才 daemon-reload）
UNIT_SRC="${DEPLOY_ROOT}/deploy/ci/${UNIT_NAME}.service"
UNIT_DIR="${DEPLOY_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
UNIT_DST="${UNIT_DIR}/${UNIT_NAME}.service"
[[ -f "$UNIT_SRC" ]] || fail "unit file not found: ${UNIT_SRC}"
[[ "${ENV_TARGET}" =~ ^(dev|test|prod)$ ]] || fail "unsupported deployment environment: ${ENV_TARGET}"
UNIT_RENDERED="$(mktemp)" || fail "cannot create rendered systemd unit"
[[ "${DEPLOY_ROOT}" != *'|'* && "${DEPLOY_ROOT}" != *'&'* && "${DEPLOY_ROOT}" != *'\\'* ]] || fail "DEPLOY_ROOT contains characters unsafe for unit rendering"
escaped_deploy_root="${DEPLOY_ROOT//\\/\\\\}"
escaped_deploy_root="${escaped_deploy_root//&/\\&}"
escaped_deploy_root="${escaped_deploy_root//|/\\|}"
sed -e "s|@ENV_TARGET@|${ENV_TARGET}|g" -e "s|@DEPLOY_ROOT@|${escaped_deploy_root}|g" "${UNIT_SRC}" >"${UNIT_RENDERED}"
if grep -Eq '@(ENV_TARGET|DEPLOY_ROOT)@' "${UNIT_RENDERED}"; then fail "systemd unit placeholder was not rendered"; fi
mkdir -p "${UNIT_DIR}"
if ! cmp -s "$UNIT_RENDERED" "$UNIT_DST" 2>/dev/null; then
  cp "$UNIT_RENDERED" "$UNIT_DST"
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
smoke_healthz || fail "/healthz smoke failed for the new release"

newapi_admin_url="${NEWAPI_ADMIN_BASE_URL:-${NEWAPI_URL:-http://127.0.0.1:${NEWAPI_PORT:-9300}}}"
newapi_ok=0
# shellcheck disable=SC2034  # attempt 只用来计数
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 3 "${newapi_admin_url%/}/api/status" 2>/dev/null | grep -Eq '"success"[[:space:]]*:[[:space:]]*true'; then
    newapi_ok=1; break
  fi
  sleep 2
done
(( newapi_ok )) || fail "internal NewAPI /api/status failed after 30 attempts"
for container in aiteam-newapi-pg aiteam-newapi-redis aiteam-newapi; do
  state=""
  # shellcheck disable=SC2034  # attempt 只用来计数
  for attempt in $(seq 1 30); do
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${container}" 2>/dev/null || true)"
    [[ "${state}" == "healthy" ]] && break
    sleep 2
  done
  [[ "${state}" == "healthy" ]] || fail "${container} is not healthy (state=${state:-missing})"
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

DEPLOY_PHASE="done"
log "deploy-run done (unit=${UNIT_NAME}, env=${ENV_TARGET}, branch=${BRANCH})"
