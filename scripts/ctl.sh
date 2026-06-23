#!/usr/bin/env bash
set -euo pipefail

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

Environment Files:
  .env.dev   - Development environment (default)
  .env.test  - Testing environment
  .env.prod  - Production environment (⚠️  edit sensitive values first)
EOF
}

# 加载环境配置
load_env() {
  ENV_FILE="${REPO_ROOT}/.env.${ENV_CONFIG}"

  if [[ ! -f "${ENV_FILE}" ]]; then
    echo "[ctl] Creating default ${ENV_FILE} file..."

    case "${ENV_CONFIG}" in
      dev)
        cat > "${ENV_FILE}" <<'ENVEOF'
# AITeam 开发环境配置
# 本文件由 scripts/ctl.sh 自动生成，可手动编辑

# 服务端口（local 和 docker 统一使用）
OPERATION_PORT=8781
MANAGER_PORT=8782
AGENT_PORT=8783
POSTGRES_PORT=5433

# 数据库配置
POSTGRES_USER=aiteam
POSTGRES_PASSWORD=aiteam_test
POSTGRES_DB=aiteam_v1

# 服务间认证
SERVICE_TOKEN=dev-service-token-placeholder

# 日志级别
LOG_LEVEL=INFO

# 公开文档（开发环境）
EXPOSE_PUBLIC_DOCS=1
ENVEOF
        ;;
      test)
        cat > "${ENV_FILE}" <<'ENVEOF'
# AITeam 测试环境配置
# 本文件由 scripts/ctl.sh 自动生成，可手动编辑

# 服务端口
OPERATION_PORT=8781
MANAGER_PORT=8782
AGENT_PORT=8783
POSTGRES_PORT=5433

# 数据库配置
POSTGRES_USER=aiteam
POSTGRES_PASSWORD=aiteam_test_env
POSTGRES_DB=aiteam_test

# 服务间认证（测试环境应使用不同的密钥）
SERVICE_TOKEN=test-service-token-placeholder

# 日志级别
LOG_LEVEL=DEBUG

# 公开文档（测试环境）
EXPOSE_PUBLIC_DOCS=1
ENVEOF
        ;;
      prod)
        cat > "${ENV_FILE}" <<'ENVEOF'
# AITeam 生产环境配置
# 本文件由 scripts/ctl.sh 自动生成，请手动编辑敏感信息

# 服务端口
OPERATION_PORT=8781
MANAGER_PORT=8782
AGENT_PORT=8783
POSTGRES_PORT=5433

# 数据库配置（生产环境必须修改）
POSTGRES_USER=aiteam
POSTGRES_PASSWORD=CHANGE_ME_PRODUCTION_PASSWORD
POSTGRES_DB=aiteam_prod

# 服务间认证（生产环境必须使用强密钥）
# 生成方式：openssl rand -hex 32
SERVICE_TOKEN=CHANGE_ME_USE_OPENSSL_RAND_HEX_32

# 日志级别
LOG_LEVEL=INFO

# 公开文档（生产环境应关闭）
EXPOSE_PUBLIC_DOCS=0
ENVEOF
        echo "[ctl] ⚠️  WARNING: Production config created. Please update sensitive values in ${ENV_FILE}"
        ;;
      *)
        echo "[ctl] ERROR: Unknown environment: ${ENV_CONFIG}" >&2
        echo "[ctl] Supported environments: dev, test, prod" >&2
        exit 1
        ;;
    esac

    echo "[ctl] Created ${ENV_FILE}"
  fi

  # 加载配置
  set -a
  # shellcheck source=/dev/null
  source "${ENV_FILE}"
  set +a

  # 构建数据库连接串
  DB_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}/${POSTGRES_DB}"
  ADMIN_DB_URL="${DB_URL}"
  APP_RW_PASSWORD="${POSTGRES_PASSWORD}"
}

# 解析参数
parse_args() {
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
        DB_URL="${DB_URL}" \
        ADMIN_DB_URL="${ADMIN_DB_URL}" \
        APP_RW_PASSWORD="${APP_RW_PASSWORD}" \
        SERVICE_TOKEN="${SERVICE_TOKEN}" \
        OPERATOR_URL="http://127.0.0.1:${OPERATION_PORT}" \
        LOG_LEVEL="${LOG_LEVEL}" \
        EXPOSE_PUBLIC_DOCS="${EXPOSE_PUBLIC_DOCS}" \
        python "${REPO_ROOT}/server/run.py" --tier=manager --port="${MANAGER_PORT}" \
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
        ADMIN_DB_URL="${ADMIN_DB_URL}" \
        APP_RW_PASSWORD="${APP_RW_PASSWORD}" \
        MANAGER_URL="http://127.0.0.1:${MANAGER_PORT}" \
        SERVICE_TOKEN="${SERVICE_TOKEN}" \
        LOG_LEVEL="${LOG_LEVEL}" \
        EXPOSE_PUBLIC_DOCS="${EXPOSE_PUBLIC_DOCS}" \
        python "${REPO_ROOT}/server/run.py" --tier=operation --port="${OPERATION_PORT}" \
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
        DB_URL="${DB_URL}" \
        MANAGER_URL="http://127.0.0.1:${MANAGER_PORT}" \
        SERVICE_TOKEN="${SERVICE_TOKEN}" \
        LOG_LEVEL="${LOG_LEVEL}" \
        EXPOSE_PUBLIC_DOCS="${EXPOSE_PUBLIC_DOCS}" \
        python "${REPO_ROOT}/server/run.py" --tier=agent --port="${AGENT_PORT}" \
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
