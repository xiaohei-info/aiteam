#!/usr/bin/env bash
# v1 通用部署编排脚本，由 deploy-*.yml workflow 在 self-hosted runner 上调用。
#
# 目标：PR merge → 三端常驻部署，runner job 退出不杀服务。
#
# 机制：
#   1) workflow 的 actions/checkout 把最新代码 clone 到 $DEPLOY_ROOT；
#   2) 本脚本在当前目录（$DEPLOY_ROOT）里：
#      a. git pull 最新目标分支（失败就报错，无 fallback，分支不存在让 git 报）
#      b. 装 systemd unit 到 /etc/systemd/system/（内容未变则跳过 daemon-reload）
#      c. systemctl enable --now 引用的 unit
#      d. /healthz 冒烟（8781/8782/8783）
#   3) systemd (PID 1) fork 出 ctl.sh → ctl.sh --daemon 盯三端，runner 杀不到。
#
# 所有"底层执行入口"统一走 scripts/ctl.sh；本脚本只做编排（pull + cp +
# systemctl + 冒烟），不重复 ctl.sh 的实现。
#
# 环境变量（可由 workflow env: 注入）：
#   DEPLOY_BRANCH  目标分支（默认 feature/v1.0.0）
#   DEPLOY_ENV     环境（默认 test，对应 .env.<env>）
#   DEPLOY_ROOT    部署落地（默认 /root/app/aiteam；workflow checkout path 应对齐）

set -euo pipefail

BRANCH="${DEPLOY_BRANCH:-feature/v1.0.0}"
ENV_TARGET="${DEPLOY_ENV:-test}"
UNIT_NAME="${UNIT_NAME:-aiteam-v1}"
DEPLOY_ROOT="${DEPLOY_ROOT:-/root/app/aiteam}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UNIT_SRC="${REPO_ROOT}/deploy/ci/${UNIT_NAME}.service"

log()  { printf '[deploy-run][%s][%s] %s\n' "$ENV_TARGET" "$BRANCH" "$*"; }
fail() { printf '[deploy-run][%s][%s][ERR] %s\n' "$ENV_TARGET" "$BRANCH" "$*" >&2; exit 1; }

while (( $# > 0 )); do
  case "$1" in
    --branch=*) BRANCH="${1#*=}"; shift ;;
    --branch)
      if [[ $# -lt 2 || "$2" == -* || -z "$2" ]]; then
        echo "[deploy-run][ERR] --branch requires a non-empty value" >&2; exit 2
      fi; BRANCH="$2"; shift 2 ;;
    --env=*) ENV_TARGET="${1#*=}"; shift ;;
    --env)
      if [[ $# -lt 2 || "$2" == -* || -z "$2" ]]; then
        echo "[deploy-run][ERR] --env requires a non-empty value" >&2; exit 2
      fi; ENV_TARGET="$2"; shift 2 ;;
    --unit=*) UNIT_NAME="${1#*=}"; shift ;;
    --unit)
      if [[ $# -lt 2 || "$2" == -* || -z "$2" ]]; then
        echo "[deploy-run][ERR] --unit requires a non-empty value" >&2; exit 2
      fi; UNIT_NAME="$2"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "[deploy-run][ERR] unknown arg: $1" >&2; exit 2 ;;
  esac
done

log "using unit ${UNIT_NAME} (src=${UNIT_SRC})"
[[ -f "$UNIT_SRC" ]] || fail "unit file not found: ${UNIT_SRC}"

# 1) 同步目标分支最新代码
#    actions/checkout path: $DEPLOY_ROOT 已经把代码拉到这里。
#    但 workflow 是从 workflow_dispatch 触发时分支可能不是最新；
#    稳妥起见在部署根做一次 fetch + checkout + pull --ff-only。
log "fetch + checkout + pull '${BRANCH}' at ${DEPLOY_ROOT}"
if [[ ! -d "${DEPLOY_ROOT}/.git" ]]; then
  fail "${DEPLOY_ROOT} is not a git repository — bootstrap it first (see deploy/ci/README.md)"
fi
git -C "$DEPLOY_ROOT" fetch --all --prune 2>&1 || fail "git fetch failed (network?)"
git -C "$DEPLOY_ROOT" checkout "$BRANCH" 2>&1 | tail -1 || fail "checkout '${BRANCH}' failed (branch does not exist on remote)"
git -C "$DEPLOY_ROOT" pull --ff-only origin "$BRANCH" 2>&1 || fail "git pull --ff-only '${BRANCH}' failed (diverged)"
HEAD_SHORT="$(git -C "$DEPLOY_ROOT" rev-parse --short HEAD)"
log "code ready @ ${HEAD_SHORT}"

# 2) 确保部署根下的 .venv 可用（ctl.sh 用 ${REPO_ROOT}/.venv 找 python）
#    actions/checkout 默认只拉工作树，不拉 .venv；.venv 在持久化部署根里原地，
#    所以只要检查存在即可。
if [[ ! -e "${DEPLOY_ROOT}/.venv" ]]; then
  fail ".venv missing at ${DEPLOY_ROOT}/.venv — run the venv bootstrap once (see deploy/ci/README.md)"
fi
log ".venv present at ${DEPLOY_ROOT}/.venv"

# 3) 部署 systemd unit（内容变了才 daemon-reload）
UNIT_DST="/etc/systemd/system/${UNIT_NAME}.service"
mkdir -p /etc/systemd/system
if ! cmp -s "$UNIT_SRC" "$UNIT_DST" 2>/dev/null; then
  cp "$UNIT_SRC" "$UNIT_DST"
  log "installed ${UNIT_DST} (content changed)"
  systemctl daemon-reload >/dev/null 2>&1 || fail "systemctl daemon-reload failed"
else
  log "${UNIT_DST} content unchanged"
fi

# 4) 启动 / 重启 daemon（systemd 接管，runner 退出处置不到它）
log "restarting ${UNIT_NAME}"
systemctl enable "$UNIT_NAME" >/dev/null 2>&1 || true
if ! systemctl restart "$UNIT_NAME" 2>&1; then
  systemctl status "$UNIT_NAME" --no-pager >&2 || true
  fail "systemctl restart ${UNIT_NAME} failed (see status above)"
fi

# 5) /healthz 冒烟（三端）
log "smoking /healthz"
sleep 5
for port in 8781 8782 8783; do
  ok=0
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if curl -fsS --max-time 3 "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
      log "  port ${port} /healthz OK"; ok=1; break
    fi
    sleep 2
  done
  (( ok )) || fail "port ${port} /healthz failed after 12 attempts"
done

log "deploy-run done (unit=${UNIT_NAME}, env=${ENV_TARGET}, branch=${BRANCH})"
