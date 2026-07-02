#!/usr/bin/env bash
# v1 通用部署脚本：被所有 deploy-*.yml 共用。
#
# 职责：
#   1) 切到指定分支 + pull --ff-only
#   2) 调用 scripts/ctl.sh restart --env <env>
#      （. 由上游 workflow 从 GitHub secret 写到 runner 上的 .env.<env> 文件
#        被 ctl.sh 读取后 inject 给子进程）
#   3) 对三端 /healthz 做冒烟
#
# CLI：
#   bash scripts/deploy/run.sh --branch <b> --env <e>
#  例：bash scripts/deploy/run.sh --branch feature/v1.0.0 --env test
#
# <env> 可以是任意名：test / dev / st / prod，
# 对应 ctl.sh --env <env> 与 runner 上的 .env.<env> 文件。

set -euo pipefail

# 默认值（可被 CLI 覆盖）
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'main')"
ENV_TARGET="test"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

while (( $# > 0 )); do
  case "$1" in
    --branch)   BRANCH="$2"; shift 2 ;;
    --env)      ENV_TARGET="$2"; shift 2 ;;
    -h|--help)  sed -n '2,22p' "$0"; exit 0 ;;
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
