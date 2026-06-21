#!/usr/bin/env bash
# AI Team v1 单机模拟三端便利脚本（09 §14 / D15）。
#
# 用法：
#   ./ctl.sh up         起三端 + postgres（后台）
#   ./ctl.sh down       停并删容器（保留数据卷 aiteam_pg_data）
#   ./ctl.sh migrate    跑 Manager 迁移（manager_service 内置 apply_migrations，首次连接自动应用）
#   ./ctl.sh logs <tier>  跟随某端日志（operation|manager|agent|postgres）
#   ./ctl.sh build <tier> 单独构建某端镜像（验证按端精简产物）
#   ./ctl.sh ps         列出三端容器状态
#   ./ctl.sh check      检查三端 /healthz

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.yml"
REPO_ROOT="$(cd "${DEPLOY_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

TIERS=(operation manager agent)

log() { printf '\033[1;34m[ctl]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[ctl:err]\033[0m %s\n' "$*" >&2; }

# Docker Compose v2 优先 `docker compose`，回退 `docker-compose`。
compose_cmd() {
    if docker compose version >/dev/null 2>&1; then
        docker compose -f "${COMPOSE_FILE}"
    elif command -v docker-compose >/dev/null 2>&1; then
        docker-compose -f "${COMPOSE_FILE}"
    else
        err "未找到 docker compose / docker-compose，请先安装 Docker。"
        exit 1
    fi
}

usage() {
    cat <<EOF
AI Team v1 ctl.sh —— 单机模拟三端（operation:8001 / manager:8002 / agent:8003 + postgres:5433）

用法:
  ./ctl.sh up                 蕾三端 + postgres（后台）
  ./ctl.sh down               停并删容器（保留数据卷 aiteam_pg_data）
  ./ctl.sh migrate            跑 Manager 迁移（apply_migrations，#60）
  ./ctl.sh logs <tier>        跟随某端日志（operation|manager|agent|postgres）
  ./ctl.sh build [<tier>]     构建镜像（默认三端；指定 tier 只建一端，用于验证按端精简）
  ./ctl.sh ps                 列出容器状态
  ./ctl.sh check              curl 三端 /healthz
  ./ctl.sh clean              down + 删除数据卷（谨慎：清空 DB）

EOF
}

cmd_up() {
    log "构建并启动三端 + postgres..."
    compose_cmd up -d --build
    log "等待三端就绪（各端 /healthz，最长 60s）..."
    local tier
    for tier in "${TIERS[@]}"; do
        _wait_health "http://localhost:$(_host_port "${tier}")/healthz" 60 "aiteam-${tier}"
    done
    log "完成。端口：operation=8001 manager=8002 agent=8003 postgres=5433"
}

cmd_down() {
    log "停止并删除容器（保留数据卷）..."
    compose_cmd down
}

cmd_clean() {
    log "停止并删除容器 + 数据卷 aiteam_pg_data（清空 DB）..."
    compose_cmd down -v
}

cmd_migrate() {
    log "触发 Manager 迁移（manager_service 首次连接自动 apply_migrations，#60）..."
    log "若已起 manager 容器，重启即重跑迁移；否则执行 docker compose up manager 让其自跑。"
    compose_cmd up -d --build manager
    log "Manager 迁移随服务启动自动应用。查看日志：./ctl.sh logs manager"
}

cmd_logs() {
    local tier="${1:-}"
    if [[ -z "${tier}" ]]; then
        err "用法：./ctl.sh logs <operation|manager|agent|postgres>"
        exit 2
    fi
    case "${tier}" in
        operation|manager|agent) compose_cmd logs -f "${tier}" ;;
        postgres|pg) compose_cmd logs -f postgres ;;
        *) err "未知 tier=${tier}；应为 operation|manager|agent|postgres"; exit 2 ;;
    esac
}

cmd_build() {
    local tier="${1:-}"
    if [[ -z "${tier}" ]]; then
        log "构建三端镜像..."
        compose_cmd build
    else
        case "${tier}" in
            operation|manager|agent)
                log "构建 ${tier} 镜像（Dockerfile.${tier}）..."
                compose_cmd build "${tier}" ;;
            *) err "未知 tier=${tier}"; exit 2 ;;
        esac
    fi
}

cmd_ps() {
    compose_cmd ps
}

cmd_check() {
    local tier
    for tier in "${TIERS[@]}"; do
        local port
        port="$(_host_port "${tier}")"
        local url="http://localhost:${port}/healthz"
        if curl -sf "${url}" >/dev/null 2>&1; then
            log "${tier} (:${port}) /healthz OK"
        else
            err "${tier} (:${port}) /healthz FAILED"
        fi
    done
}

_host_port() {
    case "$1" in
        operation) echo 8001 ;;
        manager)   echo 8002 ;;
        agent)     echo 8003 ;;
        *) echo ""; return 2 ;;
    esac
}

_wait_health() {
    local url="$1" max="$2" name="$3" i=0
    while ! curl -sf "${url}" >/dev/null 2>&1; do
        i=$((i + 1))
        if (( i > max )); then
            err "${name} 在 ${max}s 内未就绪（${url}）"
            return 1
        fi
        sleep 1
    done
    log "${name} 就绪"
}

main() {
    case "${1:-}" in
        up)      cmd_up ;;
        down)    cmd_down ;;
        clean)   cmd_clean ;;
        migrate) cmd_migrate ;;
        logs)    shift; cmd_logs "${1:-}" ;;
        build)   shift; cmd_build "${1:-}" ;;
        ps)      cmd_ps ;;
        check)   cmd_check ;;
        -h|--help|help|"") usage ;;
        *) err "未知命令：$1"; usage; exit 2 ;;
    esac
}

main "$@"
