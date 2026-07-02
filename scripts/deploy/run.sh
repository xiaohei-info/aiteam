#!/usr/bin/env bash
# v1 通用部署脚本：被所有 deploy-*.yml 共用。
#
# 职责：
#   1) 确保当前分支为指定 branch（runner worktree 已包含 upstream 代码）
#   2) 让 scripts/ctl.sh 能找到 .venv（依赖设在主目录的 .venv 中）
#   3) 调用 scripts/ctl.sh restart --env <env>
#   4) 对三端 /healthz 做冒烟
#
# 关键约束：
#   - runner 默认路径 ≈ /root/actions-runner/_work/aiteam/aiteam
#   - 主仓库（含 .venv）在 /root/app/aiteam
#   - ctl.sh 按 ${REPO_ROOT}/.venv/bin/python 探测解释器
#   - 某些 runner 无法访问外网（github.com），所以 run.sh 绝不依赖
#     git fetch/pull，只用 runner checkout 的 worktree（pull_request
#     事件触发的 workflow，runner 默认 HEAD 就是 merge commit，不在任何
#     分支上，所以 fallback 到建分支策略）。

set -euo pipefail

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'main')"
ENV_TARGET="test"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

while (( $# > 0 )); do
  case "$1" in
    --branch)   BRANCH="$BRANCH"; shift ;;
    --branch=*) BRANCH="${1#*=}"; shift ;;
    --branch)
      BRANCH="$2"; shift 2 ;;
    --env)      ENV_TARGET="$2"; shift 2 ;;
    --env=*)    ENV_TARGET="${1#*=}"; shift ;;
    -h|--help)  sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "[deploy-run][ERR] unknown arg: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '[deploy-run][%s][%s] %s\n' "$ENV_TARGET" "$BRANCH" "$*"; }
fail() { printf '[deploy-run][%s][%s][ERR] %s\n' "$ENV_TARGET" "$BRANCH" "$*" >&2; exit 1; }

cd "$REPO_ROOT"

# 尝试切到目标分支；若不可达或分支不存在，fall back 到当前 HEAD（新建本地分支名）。
log "checking out '$BRANCH'"
if ! git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  log "  local ref '$BRANCH' missing (squash-merge HEAD) — branching from current HEAD"
  git checkout -b "$BRANCH" 2>&1 | tail -1 || true
else
  git checkout "$BRANCH" 2>&1 | tail -1 || fail "checkout failed"
fi

HEAD_SHORT="$(git rev-parse --short HEAD)"
log "code ready @ ${HEAD_SHORT}"

# 让主 worktree 的 .venv 在 runner worktree 可见（idempotent）。
MAIN_VENV="/root/app/aiteam/.venv"
if [[ ! -e "${REPO_ROOT}/.venv" && -d "$MAIN_VENV" ]]; then
  log "linking .venv -> $MAIN_VENV so ctl.sh can find Python deps"
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
