#!/usr/bin/env bash
# v1 通用部署脚本：被所有 deploy-*.yml 共用。
#
# 简单语义（失败就报错，没有 fallback）：
#   1) fetch + checkout + pull 指定分支最新代码
#   2) soft-link 主工作树的 .venv 让 ctl.sh 能找到 Python 依赖
#   3) 调用 scripts/ctl.sh restart --env <env>
#   4) 对三端 /healthz 冒烟
#
# 参数路径：主仓库路径 = deploy/ci/ 往上两级 (aiteam/)，ctl.sh
# 在 aiteam/scripts/ctl.sh。.venv 用 $VENV_BASE 环境变量（绝对路径）
# 定位；默认假设 ~/app/aiteam 主部署。
#
# CLI: bash deploy/ci/run.sh [--branch X] [--env Y]

set -euo pipefail

BRANCH="${DEPLOY_BRANCH:-feature/v1.0.0}"
ENV_TARGET="${DEPLOY_ENV:-test}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENV_BASE="${VENV_BASE:-/root/app/aiteam}"

while (( $# > 0 )); do
  case "$1" in
    --branch=*)
      BRANCH="${1#*=}"; shift ;;
    --branch)
      if [[ $# -lt 2 || "$2" == -* || -z "$2" ]]; then
        echo "[deploy-run][ERR] --branch requires a non-empty value" >&2; exit 2
      fi
      BRANCH="$2"; shift 2 ;;
    --env=*)
      ENV_TARGET="${1#*=}"; shift ;;
    --env)
      if [[ $# -lt 2 || "$2" == -* || -z "$2" ]]; then
        echo "[deploy-run][ERR] --env requires a non-empty value" >&2; exit 2
      fi
      ENV_TARGET="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,18p' "$0"; exit 0 ;;
    *)
      echo "[deploy-run][ERR] unknown arg: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '[deploy-run][%s][%s] %s\n' "$ENV_TARGET" "$BRANCH" "$*"; }
fail() { printf '[deploy-run][%s][%s][ERR] %s\n' "$ENV_TARGET" "$BRANCH" "$*" >&2; exit 1; }

cd "$REPO_ROOT"

log "fetch + checkout + pull '$BRANCH'"
git fetch --all --prune 2>&1 || fail "git fetch failed"
git checkout "$BRANCH" 2>&1 | tail -1 || fail "checkout '$BRANCH' failed"
git pull --ff-only origin "$BRANCH" 2>&1 || fail "git pull --ff-only '$BRANCH' failed"

HEAD_SHORT="$(git rev-parse --short HEAD)"
log "code ready @ ${HEAD_SHORT}"

# 把主工作树的 .venv 软链到当前工作树仓库根，让 ctl.sh 能找到。
# 默认读 VENV_BASE 环境变量（来自 workflow yaml），不写死。
MAIN_VENV="${VENV_BASE}/.venv"
if [[ ! -e "${REPO_ROOT}/.venv" && -d "$MAIN_VENV" ]]; then
  ln -s "$MAIN_VENV" "${REPO_ROOT}/.venv"
elif [[ ! -e "${REPO_ROOT}/.venv" ]]; then
  log "WARN: no .venv at ${MAIN_VENV} and none in worktree  --  ctl.sh will use system python"
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
