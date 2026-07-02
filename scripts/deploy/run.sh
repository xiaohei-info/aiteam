#!/usr/bin/env bash
# v1 通用部署脚本：被所有 deploy-*.yml 共用。
#
# 语义（简单失败即报错版）：
#   1) fetch + checkout + pull 指定分支最新代码
#   2) 软链主工作目录的 .venv 让 ctl.sh 能找到 Python 依赖
#   3) 调用 scripts/ctl.sh restart --env <env>
#   4) 对三端 /healthz 冒烟
#
# 网络失败就报错退出，不做任何 fallback。ctl.sh 走 runner worktree。

set -euo pipefail

BRANCH="main"
ENV_TARGET="test"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

while (( $# > 0 )); do
  case "$1" in
    --branch) BRANCH="$2"; shift 2 ;;
    --env)    ENV_TARGET="$2"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "[deploy-run][ERR] unknown arg: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '[deploy-run][%s][%s] %s\n' "$ENV_TARGET" "$BRANCH" "$*"; }
fail() { printf '[deploy-run][%s][%s][ERR] %s\n' "$ENV_TARGET" "$BRANCH" "$*" >&2; exit 1; }

cd "$REPO_ROOT"

log "fetching + pulling latest for '$BRANCH'"
git fetch --all --prune 2>&1 || fail "git fetch failed (network egress)"
git checkout "$BRANCH" 2>&1 | tail -1 || fail "checkout '$BRANCH' failed"
git pull --ff-only origin "$BRANCH" 2>&1 || fail "git pull --ff-only failed"

HEAD_SHORT="$(git rev-parse --short HEAD)"
log "code ready @ ${HEAD_SHORT}"

MAIN_VENV="/root/app/aiteam/.venv"
if [[ ! -e "${REPO_ROOT}/.venv" && -d "$MAIN_VENV" ]]; then
  ln -s "$MAIN_VENV" "${REPO_ROOT}/.venv"
fi

log "restarting services (--env ${ENV_TARGET})"
bash scripts/ctl.sh restart --env "$ENV_TARGET"

log "smoking /healthz on 8781/8782/8783"
sleep 3
for port in 8781 8782 8783; do
  for attempt in 1 2 3 4 5; do
    if curl -fsS --max-time 5 "http://127.0.0.1:${port}/healthz" >/dev/null; then
      log "  port ${port} /healthz OK"
      break
    fi
    if [[ $attempt -eq 5 ]]; then
      fail "port ${port} /healthz failed after 5 attempts"
    fi
    sleep 2
  done
done

log "deploy-run done"
