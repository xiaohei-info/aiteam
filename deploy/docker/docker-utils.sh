#!/usr/bin/env bash
# AI Team v1 Docker 构建与清理工具（D15 按端精简产物）
#
# 用法：
#   ./docker-utils.sh build [tier]    构建镜像（默认三端；指定 operation|manager|agent 只建一端）
#   ./docker-utils.sh clean           停止容器并删除数据卷（清空 DB，谨慎！）

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.yml"
REPO_ROOT="$(cd "${DEPLOY_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

log() { printf '\033[1;34m[docker-utils]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[docker-utils:err]\033[0m %s\n' "$*" >&2; }

# Docker Compose v2 优先 `docker compose`，回退 `docker-compose`
compose_cmd() {
    if docker compose version >/dev/null 2>&1; then
        docker compose -f "${COMPOSE_FILE}" "$@"
    elif command -v docker-compose >/dev/null 2>&1; then
        docker-compose -f "${COMPOSE_FILE}" "$@"
    else
        err "未找到 docker compose / docker-compose，请先安装 Docker"
        exit 1
    fi
}

usage() {
    cat <<EOF
AI Team v1 Docker 构建与清理工具

用法:
  ./docker-utils.sh build [tier]    构建镜像
                                    - 无参数：构建 operation、manager、agent 三端
                                    - 指定 tier：只构建该端（验证按端精简产物）
                                    tier 可选: operation | manager | agent

  ./docker-utils.sh clean           停止所有容器并删除数据卷
                                    ⚠️  警告：会清空数据库，谨慎使用！

示例:
  ./docker-utils.sh build           # 构建三端
  ./docker-utils.sh build agent     # 只构建用户端（验证产物隔离）
  ./docker-utils.sh clean           # 清理所有容器和数据

注意:
  - 日常启停请使用: ../../scripts/ctl.sh start/stop/restart
  - 本脚本仅用于 Docker 镜像构建和彻底清理
EOF
}

cmd_build() {
    local tier="${1:-}"

    if [[ -z "${tier}" ]]; then
        log "构建三端镜像（operation、manager、agent）..."
        compose_cmd build operation manager agent
        log "✓ 三端镜像构建完成"
    else
        case "${tier}" in
            operation|manager|agent)
                log "构建 ${tier} 镜像（Dockerfile.${tier}）..."
                compose_cmd build "${tier}"
                log "✓ ${tier} 镜像构建完成"

                # 提示验证产物隔离
                if [[ "${tier}" == "agent" ]]; then
                    log ""
                    log "验证用户端产物隔离（D15 红线）："
                    log "  docker run --rm aiteam-agent:dev sh -c 'ls /app/server && echo --- && ls /app/web'"
                    log "  应只见: agent_service | agent"
                fi
                ;;
            *)
                err "未知 tier: ${tier}"
                err "可选值: operation | manager | agent"
                exit 2
                ;;
        esac
    fi
}

cmd_clean() {
    log "⚠️  即将停止所有容器并删除数据卷（包括数据库）"
    read -p "确认继续？(yes/no): " confirm

    if [[ "${confirm}" != "yes" ]]; then
        log "已取消"
        exit 0
    fi

    log "停止并删除容器 + 数据卷..."
    compose_cmd down -v
    log "✓ 清理完成（数据卷 aiteam_pg_data 已删除）"
}

main() {
    case "${1:-}" in
        build)
            shift
            cmd_build "${1:-}"
            ;;
        clean)
            cmd_clean
            ;;
        -h|--help|help|"")
            usage
            ;;
        *)
            err "未知命令: $1"
            usage
            exit 2
            ;;
    esac
}

main "$@"
