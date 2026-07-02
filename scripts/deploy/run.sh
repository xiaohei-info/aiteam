#!/usr/bin/env bash
# v1 通用部署脚本：被所有 deploy-*.yml 共用。
#
# 职责：
#   1) 切到指定分支 + pull --ff-only
#   2) 让 scripts/ctl.sh 能找到 .venv（依赖设在主目录的 .venv 中）
#   3) 调用 scripts/ctl.sh restart --env <env>
#   4) 对三端 /healthz 做冒烟
#
# runner 实际工作目录 ≈ /root/actions-runner/_work/aiteam/aiteam，
# 但主仓库（含 .venv）在 /root/app/aiteam。ctl.sh 按 ${REPO_ROOT}/.venv/bin/python
# 探测解释器，所以我们在 REPO_ROOT 中创建 .venv 符号链接（若缺失）。
#
# CLI：
#   bash scripts/deploy/run.sh --branch <b> --env <e>

set -euo pipefail

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'main')"
ENV_TARGET="test"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

while (( $# > 0 )); do
  case "$1" in
    --branch)   BRANCH="$2"; shift 2 ;;
    --env)      ENV_TARGET="$2"; shift 2 ;;
    -h|--help)  sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "[deploy-run][ERR] unknown arg: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '[deploy-run][%s][%s] %s\n' "$ENV_TARGET" "$BRANCH" "$*"; }
fail() { printf '[deploy-run][%s][%s][ERR] %s\n' "$ENV_TARGET" "$BRANCH" "$*" >&2; exit 1; }

cd "$REPO_ROOT"

log "syncing origin + checkout '$BRANCH'"
git fetch --all --prune
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH" || fail "non-fast-forward — resolve locally first"

HEAD_SHORT="$(git rev-parse --short HEAD)"
log "code ready @ ${HEAD_SHORT}"

# 让 main worktree 的 .venv 在 runner worktree 可见；缺失才软链（幂等）。
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
