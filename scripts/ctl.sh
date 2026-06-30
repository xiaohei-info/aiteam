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

  # 构建数据库连接串
  DB_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}/${POSTGRES_DB}"
  # ADMIN_DB_URL：管理连接串，用于 Migration / RLS 启用 / 控制面表直读直写
  # (04 §6.1)。PG16 Alpine 镜像无 `postgres` 系统超管角色（taiyi 实测唯一
  # super 角色是 ${POSTGRES_USER}）；未显式声明 ADMIN_DB_URL 时 fallback 到
  # POSTGRES_SUPER_USER（缺省同 POSTGRES_USER）。单账号承担 DDL+DML 是现状
  # 权宜，独立 manager_admin 角色留 PR TODO。
  ADMIN_DB_URL="${ADMIN_DB_URL:-postgresql://${POSTGRES_SUPER_USER:-${POSTGRES_USER}}:${POSTGRES_SUPER_PASSWORD:-${POSTGRES_PASSWORD}}@${POSTGRES_HOST:-localhost}:${POSTGRES_PORT}/${POSTGRES_DB}}"
  APP_RW_PASSWORD="${APP_RW_PASSWORD:-${POSTGRES_PASSWORD}}"

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

# 解析参数
parse_args() {
  # 同时支持 --key=value 与 --key value 两种写法（curl / docker 惯例）。
  _split_kv_args "$@"
  set -- "${OUT[@]}"
  ENV_CONFIG="${DEFAULT_ENV}"
  DEPLOY_MODE="${DEFAULT_DEPLOY}"
  SERVER="${DEFAULT_SERVER}"
  FOLLOW_LOGS=0

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

# Docker Compose 操作
docker_compose_cmd() {
  local action="$1"
  shift

  cd "${REPO_ROOT}/deploy"

  case "${action}" in
    start)
      if [[ "${SERVER}" == "all" ]]; then
        docker-compose up -d
        echo "[ctl] Started all services (docker)"
      elif [[ "${SERVER}" == "postgres" ]]; then
        docker-compose up -d postgres
        echo "[ctl] Started postgres (docker)"
      else
        docker-compose up -d postgres "${SERVER}"
        echo "[ctl] Started ${SERVER} (docker)"
      fi
      ;;
    stop)
      if [[ "${SERVER}" == "all" ]]; then
        docker-compose down
        echo "[ctl] Stopped all services (docker)"
      else
        docker-compose stop "${SERVER}"
        echo "[ctl] Stopped ${SERVER} (docker)"
      fi
      ;;
    status)
      docker-compose ps
      ;;
    logs)
      if [[ "${SERVER}" == "all" ]]; then
        if (( FOLLOW_LOGS )); then
          docker-compose logs -f
        else
          docker-compose logs --tail=100
        fi
      else
        if (( FOLLOW_LOGS )); then
          docker-compose logs -f "${SERVER}"
        else
          docker-compose logs --tail=100 "${SERVER}"
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
    if kill -0 "${pid}" 2>/dev/null; then
      echo "${pid}"
      return 0
    else
      # PID 文件存在但进程已死
      rm -f "${PID_FILE}"
    fi
  fi
  return 1
}

# 启动单个服务（local 模式）
start_service_local() {
  local service="$1"
  get_service_paths "${service}"

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
      cd "${REPO_ROOT}/deploy"
      docker-compose up -d postgres
      # 等待 postgres 就绪
      echo "[ctl] Waiting for postgres to be ready..."
      for i in {1..30}; do
        if docker-compose exec -T postgres pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" >/dev/null 2>&1; then
          echo "[ctl] Postgres is ready"
          break
        fi
        sleep 1
      done
      ;;
    manager)
      echo "[ctl] Starting manager on port ${MANAGER_PORT}..."
      env \
        APP_TIER=manager \
        DB_URL="${DB_URL}" \
        ADMIN_DB_URL="${ADMIN_DB_URL}" \
        APP_RW_PASSWORD="${APP_RW_PASSWORD}" \
        SERVICE_TOKEN="${SERVICE_TOKEN}" \
        OPERATOR_URL="${OPERATOR_URL:-http://${OPERATOR_HOST:-127.0.0.1}:${OPERATION_PORT}}" \
        LOG_LEVEL="${LOG_LEVEL}" \
        EXPOSE_PUBLIC_DOCS="${EXPOSE_PUBLIC_DOCS}" \
        "${VENV_PYTHON}" "${REPO_ROOT}/server/run.py" --tier=manager \
          --host="${MANAGER_HOST:-127.0.0.1}" --port="${MANAGER_PORT}" \
        > "${LOG_FILE}" 2>&1 &
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
      env \
        APP_TIER=operation \
        ADMIN_DB_URL="${ADMIN_DB_URL}" \
        APP_RW_PASSWORD="${APP_RW_PASSWORD}" \
        MANAGER_URL="${MANAGER_URL:-http://${MANAGER_HOST:-127.0.0.1}:${MANAGER_PORT}}" \
        SERVICE_TOKEN="${SERVICE_TOKEN}" \
        LOG_LEVEL="${LOG_LEVEL}" \
        EXPOSE_PUBLIC_DOCS="${EXPOSE_PUBLIC_DOCS}" \
        "${VENV_PYTHON}" "${REPO_ROOT}/server/run.py" --tier=operation \
          --host="${OPERATION_HOST:-127.0.0.1}" --port="${OPERATION_PORT}" \
        > "${LOG_FILE}" 2>&1 &
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
      echo "[ctl] Starting agent on port ${AGENT_PORT}..."
      env \
        APP_TIER=agent \
        DB_URL="${DB_URL}" \
        MANAGER_URL="${MANAGER_URL:-http://${MANAGER_HOST:-127.0.0.1}:${MANAGER_PORT}}" \
        AGENT_DB_PATH="${AGENT_DB_PATH:-${REPO_ROOT}/.state/agent.sqlite}" \
        AGENT_RUNTIME="${AGENT_RUNTIME:-fake}" \
        AGENT_RUNS_ROOT="${AGENT_RUNS_ROOT:-${REPO_ROOT}/.state/runs}" \
        AGENT_LOOP_AUTOSTART="${AGENT_LOOP_AUTOSTART:-false}" \
        AGENT_RUNTIME_ENV_PASSTHROUGH="${AGENT_RUNTIME_ENV_PASSTHROUGH:-}" \
        SERVICE_TOKEN="${SERVICE_TOKEN}" \
        LOG_LEVEL="${LOG_LEVEL}" \
        EXPOSE_PUBLIC_DOCS="${EXPOSE_PUBLIC_DOCS}" \
        "${VENV_PYTHON}" "${REPO_ROOT}/server/run.py" --tier=agent \
          --host="${AGENT_HOST:-127.0.0.1}" --port="${AGENT_PORT}" \
        > "${LOG_FILE}" 2>&1 &
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
    cd "${REPO_ROOT}/deploy"
    docker-compose stop postgres
    return 0
  fi

  local pid
  if ! pid="$(get_pid "${service}" 2>/dev/null)"; then
    echo "[ctl] ${service} is not running"
    return 0
  fi

  echo "[ctl] Stopping ${service} (PID ${pid})..."
  kill "${pid}" 2>/dev/null || true

  # 等待进程结束
  for i in {1..50}; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      rm -f "${PID_FILE}"
      echo "[ctl] Stopped ${service}"
      return 0
    fi
    sleep 0.1
  done

  # 强制结束
  echo "[ctl] Process did not exit after SIGTERM; sending SIGKILL" >&2
  kill -KILL "${pid}" 2>/dev/null || true
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
