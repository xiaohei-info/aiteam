#!/usr/bin/env bash
set -euo pipefail

_split_kv_args() {
  # 同时支持 --key=value 与 --key value 两种传参写法（curl / docker 惯例）。
  OUT=()
  while (( $# > 0 )); do
    case "$1" in
      *=*) OUT+=("${1%%=*}" "${1#*=}") ;;
      *)   OUT+=("$1") ;;
    esac
    shift
  done
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 默认值
DEFAULT_ENV="dev"
DEFAULT_DEPLOY="local"
DEFAULT_SERVER="all"
DEFAULT_DAEMON=0

usage() {
  cat <<'EOF'
Usage: ./scripts/ctl.sh <command> [options]

Commands:
  start    Start AITeam services
  stop     Stop AITeam services
  restart  Restart AITeam services
  status   Show service status
  logs     Show service logs

Options:
  --env <dev|test|prod>      Environment config (default: dev)
                             Loads .env.dev, .env.test, or .env.prod
  --deploy <local|docker>    Deployment mode (default: local)
                             local:  Run Python directly
                             docker: Use docker-compose
  --server <all|manager|operation|agent|postgres>
                             Which server(s) to control (default: all)
  --follow, -f               Follow logs in real-time (for logs command)
  --daemon                   Stay in foreground watching service PIDs (systemd friendly)

Examples:
  ./scripts/ctl.sh start                              # Start dev env, local mode
  ./scripts/ctl.sh start --env prod                   # Start prod env, local mode
  ./scripts/ctl.sh start --env prod --deploy docker   # Start prod env, docker mode
  ./scripts/ctl.sh restart --server manager           # Restart only manager
  ./scripts/ctl.sh status --env test                  # Check test env status
  ./scripts/ctl.sh logs --server operation --follow   # Follow operation logs
  ./scripts/ctl.sh stop --env prod                    # Stop prod env

Environment Setup:
  Before first use, create environment config from example:
    cp .env.example .env.dev
    vim .env.dev  # Edit configuration as needed

  For other environments:
    cp .env.example .env.test
    cp .env.example .env.prod
EOF
}

# 加载环境配置
load_env() {
  ENV_FILE="${REPO_ROOT}/.env.${ENV_CONFIG}"

  if [[ ! -f "${ENV_FILE}" ]]; then
    echo "[ctl] ERROR: ${ENV_FILE} not found" >&2
    echo "" >&2
    echo "[ctl] Please create it from the example file:" >&2
    echo "[ctl]   cp ${REPO_ROOT}/.env.example ${ENV_FILE}" >&2
    echo "[ctl]   vim ${ENV_FILE}  # Edit configuration as needed" >&2
    echo "" >&2
    exit 1
  fi

  # 加载配置
  set -a
  # shellcheck source=/dev/null
  source "${ENV_FILE}"
  set +a

  # 控制面环境名必须由 ctl 的 --env 选择器决定，不能让 .env.prod 缺省值回落为 dev。
  case "${ENV_CONFIG}" in
    prod) export AITEAM_ENV="production" ;;
    test) export AITEAM_ENV="test" ;;
    dev)  export AITEAM_ENV="development" ;;
  esac

  # 构建数据库连接串
  DB_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}/${POSTGRES_DB}"
  # ADMIN_DB_URL：管理连接串，用于 Migration / RLS 启用 / 控制面表直读直写
  # (04 §6.1)。PG16 Alpine 镜像无 `postgres` 系统超管角色（taiyi 实测唯一
  # super 角色是 ${POSTGRES_USER}）；未显式声明 ADMIN_DB_URL 时 fallback 到
  # POSTGRES_SUPER_USER（缺省同 POSTGRES_USER）。单账号承担 DDL+DML 是现状
  # 权宜，独立 manager_admin 角色留 PR TODO。
  ADMIN_DB_URL="${ADMIN_DB_URL:-postgresql://${POSTGRES_SUPER_USER:-${POSTGRES_USER}}:${POSTGRES_SUPER_PASSWORD:-${POSTGRES_PASSWORD}}@${POSTGRES_HOST:-localhost}:${POSTGRES_PORT}/${POSTGRES_DB}}"
  APP_RW_PASSWORD="${APP_RW_PASSWORD:-${POSTGRES_PASSWORD}}"

  # PG/Manager 数据卷名默认带 env 后缀，使 dev/test/prod 各用各卷、互不覆盖；
  # .env 里显式设置时以其为准（可指向共用卷）。显式 export 让 docker compose 子进程插值。
  export POSTGRES_VOLUME="${POSTGRES_VOLUME:-aiteam_pg_data_${ENV_CONFIG}}"
  export MANAGER_DATA_VOLUME="${MANAGER_DATA_VOLUME:-managerdata_${ENV_CONFIG}}"

  # 启动前最小 env 校验：占位分支（routes_member.py:39 等）是正确的安全门；
  # 触发 503 的真正原因是 DB_URL/ADMIN_DB_URL 未注入 .env.*，应在部署侧修，
  # 而不是焊死成 200 空结果。
  if [[ -z "${DB_URL:-}" ]]; then
    echo "[ctl] ERROR: DB_URL empty — check POSTGRES_* in .env.${ENV_CONFIG}" >&2
    exit 1
  fi
  if [[ -z "${ADMIN_DB_URL:-}" ]]; then
    echo "[ctl] ERROR: ADMIN_DB_URL empty — check ADMIN_DB_URL / POSTGRES_SUPER_* in .env.${ENV_CONFIG}" >&2
    exit 1
  fi

  validate_agent_production_env

  # 自动探测 Python 解释器：优先 venv 内的 python（能直接获得 venv 依赖），
  # 否则 fallback 到系统 python3。避免部署必须 source .venv/bin/activate。
  if [[ -x "${REPO_ROOT}/.venv/bin/python" ]]; then
    VENV_PYTHON="${REPO_ROOT}/.venv/bin/python"
  elif command -v python3 >/dev/null 2>&1; then
    VENV_PYTHON="$(command -v python3)"
  else
    echo "[ctl] ERROR: 找不到 Python 解释器（.venv/bin/python 或系统 python3）" >&2
    exit 1
  fi
}

validate_agent_production_env() {
  [[ "${ENV_CONFIG}" == "prod" ]] || return 0

  local dev_auth="${AITEAM_AGENT_DEV_AUTH:-false}"
  local faux="${AITEAM_PI_FAKE:-false}"
  dev_auth="$(printf '%s' "${dev_auth}" | tr '[:upper:]' '[:lower:]')"
  faux="$(printf '%s' "${faux}" | tr '[:upper:]' '[:lower:]')"
  [[ "${dev_auth}" != "true" ]] || { echo "[ctl] ERROR: AITEAM_AGENT_DEV_AUTH=true is forbidden for --env prod" >&2; exit 1; }
  [[ "${faux}" != "true" ]] || { echo "[ctl] ERROR: AITEAM_PI_FAKE=true is forbidden for --env prod" >&2; exit 1; }
  [[ "${AITEAM_AGENT_SANDBOX_READY:-false}" == "true" ]] || { echo "[ctl] ERROR: AITEAM_AGENT_SANDBOX_READY=true is required for --env prod" >&2; exit 1; }

  local manager_url="${AITEAM_MANAGER_URL:-${MANAGER_URL:-}}"
  [[ "${manager_url}" =~ ^https?://[^[:space:]]+$ ]] || { echo "[ctl] ERROR: AITEAM_MANAGER_URL (or MANAGER_URL) must be an absolute http(s) URL for --env prod" >&2; exit 1; }
  [[ -n "${AITEAM_AGENT_JWT_ISSUER:-}" && -n "${AITEAM_AGENT_JWT_AUDIENCE:-}" ]] || { echo "[ctl] ERROR: production Agent JWT issuer and audience are required" >&2; exit 1; }
  if [[ -n "${AITEAM_AGENT_JWKS_PATH:-}" ]]; then
    [[ -r "${AITEAM_AGENT_JWKS_PATH}" ]] || { echo "[ctl] ERROR: production Agent JWKS path is not readable" >&2; exit 1; }
  elif [[ -n "${AITEAM_AGENT_JWKS_JSON:-}" ]]; then
    python3 -c 'import json, os; value=json.loads(os.environ["AITEAM_AGENT_JWKS_JSON"]); assert isinstance(value.get("keys"), list) and value["keys"]' || {
      echo "[ctl] ERROR: production AITEAM_AGENT_JWKS_JSON is invalid" >&2; exit 1;
    }
  else
    echo "[ctl] ERROR: production Agent JWKS is required" >&2
    exit 1
  fi
}

# 解析参数
parse_args() {
  # 同时支持 --key=value 与 --key value 两种写法（curl / docker 惯例）。
  _split_kv_args "$@"
  set -- "${OUT[@]}"
  ENV_CONFIG="${DEFAULT_ENV}"
  DEPLOY_MODE="${DEFAULT_DEPLOY}"
  SERVER="${DEFAULT_SERVER}"
  FOLLOW_LOGS=0
  DAEMON="${DEFAULT_DAEMON}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --env)
        shift
        ENV_CONFIG="$1"
        ;;
      --deploy)
        shift
        DEPLOY_MODE="$1"
        ;;
      --server)
        shift
        SERVER="$1"
        ;;
      --follow|-f)
        FOLLOW_LOGS=1
        ;;
      --daemon)
        DAEMON=1
        ;;
      *)
        echo "[ctl] Unknown option: $1" >&2
        usage >&2
        exit 2
        ;;
    esac
    shift
  done

  # 验证参数
  if [[ ! "${ENV_CONFIG}" =~ ^(dev|test|prod)$ ]]; then
    echo "[ctl] Invalid --env: ${ENV_CONFIG} (must be 'dev', 'test', or 'prod')" >&2
    exit 2
  fi

  if [[ ! "${DEPLOY_MODE}" =~ ^(local|docker)$ ]]; then
    echo "[ctl] Invalid --deploy: ${DEPLOY_MODE} (must be 'local' or 'docker')" >&2
    exit 2
  fi

  if [[ ! "${SERVER}" =~ ^(all|manager|operation|agent|postgres)$ ]]; then
    echo "[ctl] Invalid --server: ${SERVER} (must be 'all', 'manager', 'operation', 'agent', or 'postgres')" >&2
    exit 2
  fi
}

# 解析 docker compose 命令：优先 v2 插件（docker compose），回退 v1（docker-compose）。
# 探测一次并缓存，兼容两种安装形态。
COMPOSE_CMD=()
resolve_compose_cmd() {
  if (( ${#COMPOSE_CMD[@]} )); then
    return 0
  fi
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD=(docker-compose)
  else
    echo "[ctl] Neither 'docker compose' (v2) nor 'docker-compose' (v1) is available" >&2
    exit 127
  fi
}

# 统一的 compose 调用入口，替代硬编码的 docker-compose。
dc() {
  resolve_compose_cmd
  "${COMPOSE_CMD[@]}" "$@"
}

# Docker Compose 操作
docker_compose_cmd() {
  local action="$1"
  shift

  cd "${REPO_ROOT}/deploy/docker"

  case "${action}" in
    start)
      if [[ "${SERVER}" == "all" ]]; then
        dc up -d
        echo "[ctl] Started all services (docker)"
      elif [[ "${SERVER}" == "postgres" ]]; then
        dc up -d postgres
        echo "[ctl] Started postgres (docker)"
      else
        dc up -d postgres "${SERVER}"
        echo "[ctl] Started ${SERVER} (docker)"
      fi
      ;;
    stop)
      if [[ "${SERVER}" == "all" ]]; then
        dc down
        echo "[ctl] Stopped all services (docker)"
      else
        dc stop "${SERVER}"
        echo "[ctl] Stopped ${SERVER} (docker)"
      fi
      ;;
    status)
      dc ps
      ;;
    logs)
      if [[ "${SERVER}" == "all" ]]; then
        if (( FOLLOW_LOGS )); then
          dc logs -f
        else
          dc logs --tail=100
        fi
      else
        if (( FOLLOW_LOGS )); then
          dc logs -f "${SERVER}"
        else
          dc logs --tail=100 "${SERVER}"
        fi
      fi
      ;;
  esac
}

# Local 模式 - PID 和日志文件路径
get_service_paths() {
  local service="$1"
  local state_dir="${REPO_ROOT}/.state"
  mkdir -p "${state_dir}" "${REPO_ROOT}/logs"

  case "${service}" in
    manager)
      PID_FILE="${state_dir}/manager.pid"
      LOG_FILE="${REPO_ROOT}/logs/manager.log"
      ;;
    operation)
      PID_FILE="${state_dir}/operation.pid"
      LOG_FILE="${REPO_ROOT}/logs/operation.log"
      ;;
    agent)
      PID_FILE="${state_dir}/agent.pid"
      LOG_FILE="${REPO_ROOT}/logs/agent.log"
      ;;
    postgres)
      PID_FILE="${state_dir}/postgres.pid"
      LOG_FILE="${REPO_ROOT}/logs/postgres.log"
      ;;
  esac
}

# PID/进程组清理：ctl 用 setsid 启动服务，PID 同时是服务进程组 leader。
# 只向「PGID == PID」的组发信号，避免 stale PID 被系统复用时误杀无关进程。
process_group_alive() {
  local pid="$1"
  [[ "${pid}" =~ ^[0-9]+$ && "${pid}" -gt 1 ]] || return 1
  kill -0 -- "-${pid}" 2>/dev/null
}

terminate_process_group() {
  local pid="$1"
  [[ "${pid}" =~ ^[0-9]+$ && "${pid}" -gt 1 ]] || return 0
  local pgid=""
  pgid="$(ps -o pgid= -p "${pid}" 2>/dev/null | tr -d ' ' || true)"
  if [[ "${pgid}" == "${pid}" ]]; then
    kill -TERM -- "-${pid}" 2>/dev/null || true
    return 0
  fi
  # The leader may already be gone while a stale child remains; the PID file
  # is the only ownership record, so use the group id only in that case.
  if process_group_alive "${pid}"; then
    kill -TERM -- "-${pid}" 2>/dev/null || true
  fi
}

reap_stale_process_group() {
  local pid="$1"
  terminate_process_group "${pid}"
  for _ in {1..10}; do
    process_group_alive "${pid}" || return 0
    sleep 0.1
  done
  if process_group_alive "${pid}"; then kill -KILL -- "-${pid}" 2>/dev/null || true; fi
}

# 获取服务 PID
get_pid() {
  local service="$1"
  get_service_paths "${service}"

  # postgres 特殊处理：检查 docker 容器状态
  if [[ "${service}" == "postgres" ]]; then
    if docker ps --format '{{.Names}}' | grep -q "aiteam-pg"; then
      echo "docker"
      return 0
    fi
    return 1
  fi

  if [[ -f "${PID_FILE}" ]]; then
    local pid
    pid="$(cat "${PID_FILE}")"
    if process_group_alive "${pid}"; then
      echo "${pid}"
      return 0
    fi
    # PID 文件存在但 leader 已死 (或内容损坏)：先清理残留进程组，
    # 再删除文件，避免下一次 start 继承旧 Agent 子进程。
    reap_stale_process_group "${pid}" || true
    rm -f "${PID_FILE}"
  fi
  return 1
}

# 启动单个服务（local 模式）
start_service_local() {
  local service="$1"
  get_service_paths "${service}"
  cd "${REPO_ROOT}"

  # 检查是否已运行
  if get_pid "${service}" >/dev/null 2>&1; then
    echo "[ctl] ${service} is already running (PID $(cat "${PID_FILE}"))"
    return 0
  fi

  case "${service}" in
    postgres)
      # 检查容器是否已运行
      if docker ps --format '{{.Names}}' | grep -q "aiteam-pg"; then
        echo "[ctl] postgres is already running (docker)"
        return 0
      fi

      echo "[ctl] Starting postgres (docker container)..."
      cd "${REPO_ROOT}/deploy/docker"
      dc up -d postgres
      # 等待 postgres 就绪
      echo "[ctl] Waiting for postgres to be ready..."
      for i in {1..30}; do
        if dc exec -T postgres pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" >/dev/null 2>&1; then
          echo "[ctl] Postgres is ready"
          break
        fi
        sleep 1
      done
      ;;
    manager)
      echo "[ctl] Starting manager on port ${MANAGER_PORT}..."
      nohup setsid env \
        APP_TIER=manager \
        AITEAM_ENV="${AITEAM_ENV:-dev}" \
        DB_URL="${DB_URL}" \
        ADMIN_DB_URL="${ADMIN_DB_URL}" \
        APP_RW_PASSWORD="${APP_RW_PASSWORD}" \
        MANAGER_CREDENTIAL_KEY="${MANAGER_CREDENTIAL_KEY:-}" \
        HINDSIGHT_URL="${HINDSIGHT_URL:-}" \
        HINDSIGHT_SERVICE_TOKEN="${HINDSIGHT_SERVICE_TOKEN:-}" \
        HINDSIGHT_RECALL_PATH="${HINDSIGHT_RECALL_PATH:-}" \
        HINDSIGHT_RETAIN_PATH="${HINDSIGHT_RETAIN_PATH:-}" \
        HINDSIGHT_DELETE_PATH="${HINDSIGHT_DELETE_PATH:-}" \
        LIGHTRAG_URL="${LIGHTRAG_URL:-}" \
        LIGHTRAG_API_KEY="${LIGHTRAG_API_KEY:-}" \
        LIGHTRAG_WORKSPACE="${LIGHTRAG_WORKSPACE:-}" \
        LIGHTRAG_TIMEOUT_MS="${LIGHTRAG_TIMEOUT_MS:-5000}" \
        LIGHTRAG_PIPELINE_TIMEOUT_MS="${LIGHTRAG_PIPELINE_TIMEOUT_MS:-120000}" \
        LIGHTRAG_POLL_INTERVAL_MS="${LIGHTRAG_POLL_INTERVAL_MS:-250}" \
        LIGHTRAG_QUERY_MODE="${LIGHTRAG_QUERY_MODE:-naive}" \
        SERVICE_TOKEN="${SERVICE_TOKEN}" \
        SERVICE_CLIENT_TIMEOUT_MS="${SERVICE_CLIENT_TIMEOUT_MS:-30000}" \
        AITEAM_SKILL_SIGNING_PRIVATE_KEY="${AITEAM_SKILL_SIGNING_PRIVATE_KEY:-}" \
        AITEAM_SKILL_SIGNING_CURRENT_PRIVATE_KEY="${AITEAM_SKILL_SIGNING_CURRENT_PRIVATE_KEY:-}" \
        AITEAM_SKILL_SIGNING_CURRENT_KEY_ID="${AITEAM_SKILL_SIGNING_CURRENT_KEY_ID:-}" \
        AITEAM_SKILL_SIGNING_PUBLIC_KEY="" \
        AITEAM_SKILL_SIGNING_KEY_ID="${AITEAM_SKILL_SIGNING_KEY_ID:-skills-dev-current}" \
        AITEAM_SKILL_SIGNING_NEXT_PRIVATE_KEY="${AITEAM_SKILL_SIGNING_NEXT_PRIVATE_KEY:-}" \
        AITEAM_SKILL_SIGNING_NEXT_KEY_ID="${AITEAM_SKILL_SIGNING_NEXT_KEY_ID:-}" \
        AITEAM_SKILL_SIGNING_CURRENT_NOT_BEFORE="${AITEAM_SKILL_SIGNING_CURRENT_NOT_BEFORE:-}" \
        AITEAM_SKILL_SIGNING_CURRENT_EXPIRES_AT="${AITEAM_SKILL_SIGNING_CURRENT_EXPIRES_AT:-}" \
        AITEAM_SKILL_SIGNING_NEXT_NOT_BEFORE="${AITEAM_SKILL_SIGNING_NEXT_NOT_BEFORE:-}" \
        AITEAM_SKILL_SIGNING_NEXT_EXPIRES_AT="${AITEAM_SKILL_SIGNING_NEXT_EXPIRES_AT:-}" \
        AITEAM_SKILL_SIGNING_REVOKED_KEY_IDS="${AITEAM_SKILL_SIGNING_REVOKED_KEY_IDS:-}" \
        AITEAM_SKILL_SIGNING_REVOKED_KEYS_JSON="${AITEAM_SKILL_SIGNING_REVOKED_KEYS_JSON:-}" \
        AITEAM_MANAGER_DATA_ROOT="${AITEAM_MANAGER_DATA_ROOT:-${REPO_ROOT}/.data/manager}" \
        OPERATOR_URL="${OPERATOR_URL:-http://${OPERATOR_HOST:-127.0.0.1}:${OPERATION_PORT}}" \
        LOG_LEVEL="${LOG_LEVEL}" \
        EXPOSE_PUBLIC_DOCS="${EXPOSE_PUBLIC_DOCS}" \
        "${VENV_PYTHON}" "${REPO_ROOT}/server/run.py" --tier=manager \
          --host="${MANAGER_HOST:-127.0.0.1}" --port="${MANAGER_PORT}" \
        >> "${LOG_FILE}" 2>&1 &
      disown
      echo $! > "${PID_FILE}"
      sleep 1
      if get_pid "${service}" >/dev/null 2>&1; then
        echo "[ctl] Started ${service} (PID $(cat "${PID_FILE}"))"
      else
        echo "[ctl] Failed to start ${service}. Check logs: ${LOG_FILE}" >&2
        return 1
      fi
      ;;
    operation)
      echo "[ctl] Starting operation on port ${OPERATION_PORT}..."
      nohup setsid env \
        APP_TIER=operation \
        AITEAM_ENV="${AITEAM_ENV:-dev}" \
        ADMIN_DB_URL="${ADMIN_DB_URL}" \
        APP_RW_PASSWORD="${APP_RW_PASSWORD}" \
        MANAGER_URL="${MANAGER_URL:-http://${MANAGER_HOST:-127.0.0.1}:${MANAGER_PORT}}" \
        SERVICE_TOKEN="${SERVICE_TOKEN}" \
        SERVICE_CLIENT_TIMEOUT_MS="${SERVICE_CLIENT_TIMEOUT_MS:-30000}" \
        AITEAM_SKILL_SIGNING_PRIVATE_KEY="" \
        AITEAM_SKILL_SIGNING_CURRENT_PRIVATE_KEY="" \
        AITEAM_SKILL_SIGNING_PUBLIC_KEY="" \
        AITEAM_SKILL_SIGNING_PUBLIC_KEYS="" \
        AITEAM_SKILL_SIGNING_NEXT_PRIVATE_KEY="" \
        LOG_LEVEL="${LOG_LEVEL}" \
        EXPOSE_PUBLIC_DOCS="${EXPOSE_PUBLIC_DOCS}" \
        "${VENV_PYTHON}" "${REPO_ROOT}/server/run.py" --tier=operation \
          --host="${OPERATION_HOST:-127.0.0.1}" --port="${OPERATION_PORT}" \
        >> "${LOG_FILE}" 2>&1 &
      disown
      echo $! > "${PID_FILE}"
      sleep 1
      if get_pid "${service}" >/dev/null 2>&1; then
        echo "[ctl] Started ${service} (PID $(cat "${PID_FILE}"))"
      else
        echo "[ctl] Failed to start ${service}. Check logs: ${LOG_FILE}" >&2
        return 1
      fi
      ;;
    agent)
      echo "[ctl] Starting Node agent on port ${AGENT_PORT}..."
      local agent_env="${AITEAM_ENV:-dev}"
      local agent_dev_auth="${AITEAM_AGENT_DEV_AUTH:-true}"
      local agent_fake="${AITEAM_PI_FAKE:-true}"
      local agent_manager_url="${AITEAM_MANAGER_URL:-${MANAGER_URL:-http://${MANAGER_HOST:-127.0.0.1}:${MANAGER_PORT}}}"
      if [[ "${agent_env}" == "production" ]]; then
        [[ -n "${AITEAM_AGENT_DEV_AUTH:-}" ]] || agent_dev_auth=false
        [[ -n "${AITEAM_PI_FAKE:-}" ]] || agent_fake=false
      fi
      # ctl sources the whole .env.* file; explicitly remove Manager-only
      # credentials before starting Agent so they cannot leak through inheritance.
      nohup setsid env \
        -u DB_URL -u ADMIN_DB_URL -u APP_RW_PASSWORD -u POSTGRES_PASSWORD -u SERVICE_TOKEN -u MANAGER_CREDENTIAL_KEY \
        -u OPERATION_SYSTEM_PASSWORD -u OPERATION_SIGNING_PRIVATE_KEY \
        -u LIGHTRAG_URL -u LIGHTRAG_API_KEY -u LIGHTRAG_WORKSPACE -u LIGHTRAG_TIMEOUT_MS -u LIGHTRAG_PIPELINE_TIMEOUT_MS -u LIGHTRAG_POLL_INTERVAL_MS -u LIGHTRAG_QUERY_MODE \
        -u LIGHTRAG_DB_HOST -u LIGHTRAG_DB_PORT -u LIGHTRAG_DB_NAME -u LIGHTRAG_DB_USER -u LIGHTRAG_DB_PASSWORD -u LIGHTRAG_DB_ADMIN_USER -u LIGHTRAG_DB_ADMIN_PASSWORD -u LIGHTRAG_IMAGE -u LIGHTRAG_PG_IMAGE \
        -u AITEAM_HINDSIGHT_URL -u HINDSIGHT_URL -u HINDSIGHT_SERVICE_TOKEN -u HINDSIGHT_RECALL_PATH -u HINDSIGHT_RETAIN_PATH -u HINDSIGHT_DELETE_PATH -u HINDSIGHT_API_TOKEN -u HINDSIGHT_API_KEY -u HINDSIGHT_API_KEY_REF \
        -u AITEAM_SKILL_SIGNING_PRIVATE_KEY -u AITEAM_SKILL_SIGNING_CURRENT_PRIVATE_KEY -u AITEAM_SKILL_SIGNING_NEXT_PRIVATE_KEY \
        PORT="${AGENT_PORT}" \
        HOST="${AGENT_HOST:-127.0.0.1}" \
        AITEAM_AGENT_DATA_DIR="${AGENT_DATA_DIR:-${REPO_ROOT}/.state/agent}" \
        AITEAM_ENV="${agent_env}" \
        AITEAM_AGENT_DEV_AUTH="${agent_dev_auth}" \
        AITEAM_PI_FAKE="${agent_fake}" \
        AITEAM_MANAGER_URL="${agent_manager_url}" \
        AITEAM_RAG_MCP_URL="${AITEAM_RAG_MCP_URL:-http://${MANAGER_HOST:-127.0.0.1}:${MANAGER_PORT}/api/manager/rag/mcp}" \
        AITEAM_SKILL_SIGNING_PUBLIC_KEYS="${AITEAM_SKILL_SIGNING_PUBLIC_KEYS:-}" \
        AITEAM_SKILL_SIGNING_PUBLIC_KEY="${AITEAM_SKILL_SIGNING_PUBLIC_KEY:-}" \
        AITEAM_SKILL_SIGNING_KEY_ID="${AITEAM_SKILL_SIGNING_KEY_ID:-skills-dev-current}" \
        AITEAM_SKILL_SIGNING_OFFLINE_TTL_SECONDS="${AITEAM_SKILL_SIGNING_OFFLINE_TTL_SECONDS:-86400}" \
        AITEAM_AGENT_JWKS_JSON="${AITEAM_AGENT_JWKS_JSON:-}" \
        AITEAM_AGENT_JWKS_PATH="${AITEAM_AGENT_JWKS_PATH:-}" \
        AITEAM_AGENT_JWT_ISSUER="${AITEAM_AGENT_JWT_ISSUER:-}" \
        AITEAM_AGENT_JWT_AUDIENCE="${AITEAM_AGENT_JWT_AUDIENCE:-}" \
        AITEAM_AGENT_SANDBOX_READY="${AITEAM_AGENT_SANDBOX_READY:-false}" \
        AITEAM_AGENT_SPA_ROOT="${AITEAM_AGENT_SPA_ROOT:-${REPO_ROOT}/web/agent/dist}" \
        pnpm --dir "${REPO_ROOT}/server/agent_service" start \
        >> "${LOG_FILE}" 2>&1 &
      disown
      echo $! > "${PID_FILE}"
      sleep 1
      if get_pid "${service}" >/dev/null 2>&1; then
        echo "[ctl] Started ${service} (PID $(cat "${PID_FILE}"))"
      else
        echo "[ctl] Failed to start ${service}. Check logs: ${LOG_FILE}" >&2
        return 1
      fi
      ;;
  esac
}

# 停止单个服务（local 模式）
stop_service_local() {
  local service="$1"
  get_service_paths "${service}"

  if [[ "${service}" == "postgres" ]]; then
    echo "[ctl] Stopping postgres (docker container)..."
    cd "${REPO_ROOT}/deploy/docker"
    dc stop postgres
    return 0
  fi

  local pid
  if ! pid="$(get_pid "${service}" 2>/dev/null)"; then
    echo "[ctl] ${service} is not running"
    return 0
  fi

  echo "[ctl] Stopping ${service} (PID ${pid}, process-group aware)..."
  terminate_process_group "${pid}"

  # 等待 leader 与其 process-group 一起结束。
  for i in {1..50}; do
    if ! process_group_alive "${pid}"; then
      rm -f "${PID_FILE}"
      echo "[ctl] Stopped ${service}"
      return 0
    fi
    sleep 0.1
  done

  # 强制结束整个服务组，而不是只杀 pnpm/setsid leader。
  echo "[ctl] Process group did not exit after SIGTERM; sending SIGKILL" >&2
  if process_group_alive "${pid}"; then kill -KILL -- "-${pid}" 2>/dev/null || true; fi
  rm -f "${PID_FILE}"
  echo "[ctl] Stopped ${service} (forced)"
}

# Local 模式启动
start_local() {
  if [[ "${SERVER}" == "all" ]]; then
    start_service_local postgres
    sleep 2
    start_service_local manager
    sleep 1
    start_service_local operation
    sleep 1
    start_service_local agent
  else
    if [[ "${SERVER}" != "postgres" ]]; then
      # 确保 postgres 在运行
      if ! get_pid postgres >/dev/null 2>&1; then
        echo "[ctl] Starting postgres first..."
        start_service_local postgres
        sleep 2
      fi
    fi
    start_service_local "${SERVER}"
  fi
}

# Local 模式停止
stop_local() {
  if [[ "${SERVER}" == "all" ]]; then
    stop_service_local agent
    stop_service_local operation
    stop_service_local manager
    stop_service_local postgres
  else
    stop_service_local "${SERVER}"
  fi
}

# Local 模式状态
status_local() {
  local services=("postgres" "manager" "operation" "agent")

  if [[ "${SERVER}" != "all" ]]; then
    services=("${SERVER}")
  fi

  echo "AITeam Services Status (local mode)"
  echo "===================================="

  for service in "${services[@]}"; do
    get_service_paths "${service}"

    if [[ "${service}" == "postgres" ]]; then
      # 检查 docker postgres
      if docker ps --format '{{.Names}}' | grep -q "aiteam-pg"; then
        echo "● ${service} — running (docker)"
        echo "  Port:    ${POSTGRES_PORT}"
      else
        echo "● ${service} — stopped"
      fi
    else
      local pid
      if pid="$(get_pid "${service}" 2>/dev/null)"; then
        local uptime port
        uptime="$(ps -p "${pid}" -o etime= 2>/dev/null | sed 's/^ *//' || echo 'unknown')"
        case "${service}" in
          manager) port="${MANAGER_PORT}" ;;
          operation) port="${OPERATION_PORT}" ;;
          agent) port="${AGENT_PORT}" ;;
        esac
        echo "● ${service} — running"
        echo "  PID:     ${pid}"
        echo "  Uptime:  ${uptime}"
        echo "  Port:    ${port}"
        echo "  Log:     ${LOG_FILE}"
      else
        echo "● ${service} — stopped"
        echo "  Log:     ${LOG_FILE}"
      fi
    fi
    echo ""
  done
}

# Local 模式日志
logs_local() {
  get_service_paths "${SERVER}"

  if [[ ! -f "${LOG_FILE}" ]]; then
    echo "[ctl] Log file does not exist: ${LOG_FILE}" >&2
    return 1
  fi

  if (( FOLLOW_LOGS )); then
    tail -n 100 -f "${LOG_FILE}"
  else
    tail -n 100 "${LOG_FILE}"
  fi
}

# 主命令分发
# Daemon mode (systemd Type=simple 用)：启完后 shell 不退，进入 wait-loop
# 盯三个子进程 PID；任意一个挂了 → stop_local 整体退出；收到 SIGTERM/INT
# → stop_local 清理后 exit 0，让 systemd 正确感知停止。
_daemon_wait_loop() {
  trap 'stop_local 2>/dev/null || true; exit 0' SIGTERM SIGINT
  while true; do
    for _svc in manager operation agent; do
      if ! get_pid "${_svc}" >/dev/null 2>&1; then
        echo "[ctl][daemon] ${_svc} exited unexpectedly (leader/process-group missing) — tearing down" >&2
        stop_local 2>/dev/null || true
        exit 1
      fi
    done
    sleep 2
  done
}

main() {
  local cmd="${1:-}"
  if [[ $# -gt 0 ]]; then
    shift
  fi

  case "${cmd}" in
    start|stop|restart|status|logs)
      ;;
    -h|--help|help|"")
      usage
      exit 0
      ;;
    *)
      echo "[ctl] Unknown command: ${cmd}" >&2
      usage >&2
      exit 2
      ;;
  esac

  parse_args "$@"
  load_env

  case "${cmd}" in
    start)
      if [[ "${DEPLOY_MODE}" == "docker" ]]; then
        docker_compose_cmd start
      else
        start_local
      fi
      if (( DAEMON )); then _daemon_wait_loop; fi
      ;;
    stop)
      if [[ "${DEPLOY_MODE}" == "docker" ]]; then
        docker_compose_cmd stop
      else
        stop_local
      fi
      ;;
    restart)
      if [[ "${DEPLOY_MODE}" == "docker" ]]; then
        docker_compose_cmd stop
        sleep 1
        docker_compose_cmd start
      else
        stop_local
        sleep 1
        start_local
      fi
      if (( DAEMON )); then _daemon_wait_loop; fi
      ;;
    status)
      if [[ "${DEPLOY_MODE}" == "docker" ]]; then
        docker_compose_cmd status
      else
        status_local
      fi
      ;;
    logs)
      if [[ "${DEPLOY_MODE}" == "docker" ]]; then
        docker_compose_cmd logs
      else
        if [[ "${SERVER}" == "all" ]]; then
          echo "[ctl] --server all is not supported for logs in local mode. Specify a service." >&2
          exit 2
        fi
        logs_local
      fi
      ;;
  esac
}

main "$@"
