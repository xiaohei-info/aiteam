#!/usr/bin/env bash
# v1 部署编排脚本，在 self-hosted runner 的 ta iy 机器上运行。
#
# 假定调用时已在持久化部署根（DEPLOY_ROOT，默认 /root/app/aiteam）执行。
# 该目录应已是一个 git 仓库（origin = git@github.com:...）并具备可用的 .venv。
#
# 与此前"条件性 build / fallback 到默认分支"的行为不同，本脚本
# 严格要求调用方给出明确分支；分支为空即 fail。
#
# 流程（失败就报错，无 fallback）：
#   1) git pull --ff-only <branch>
#   2) 无条件 pnpm install && pnpm build（前端产物每次强制重建，
#      避免前后端代码不一致）
#   3) 装 systemd unit → daemon-reload → restart
#   4) /healthz 冒烟 + GET / 必须是 HTML

set -euo pipefail

BRANCH="${DEPLOY_BRANCH:-}"
ENV_TARGET="${DEPLOY_ENV:-test}"
UNIT_NAME="${UNIT_NAME:-aiteam-v1}"
DEPLOY_ROOT="$(pwd)"

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
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *)
      echo "[deploy-run][ERR] unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$BRANCH" ]]; then
  fail() { printf '[deploy-run][][ERR] %s\n' "$*" >&2; exit 2; }
  fail "branch is required: pass --branch <name> or DEPLOY_BRANCH env. Trigger must be via pull_request merge or workflow_dispatch with branch input."
fi

log()  { printf '[deploy-run][%s][%s] %s\n' "$ENV_TARGET" "$BRANCH" "$*"; }
fail() { printf '[deploy-run][%s][%s][ERR] %s\n' "$ENV_TARGET" "$BRANCH" "$*" >&2; exit 1; }

cd "$DEPLOY_ROOT"

if [[ ! -d ".git" ]]; then
  fail "${DEPLOY_ROOT} is not a git repository — bootstrap it first (see deploy/ci/README.md)"
fi

# 1) 同步目标分支最新代码
log "fetch + checkout + pull '${BRANCH}'"
git fetch --all --prune 2>&1 || fail "git fetch failed (network?)"
git checkout "$BRANCH" 2>&1 | tail -1 || fail "checkout '${BRANCH}' failed (branch does not exist on remote)"
git pull --ff-only origin "$BRANCH" 2>&1 || fail "git pull --ff-only '${BRANCH}' failed (diverged)"
log "code ready @ $(git rev-parse --short HEAD)"

# 2) 前端产物无条件每次 CI 都重新 build（部署根下需已装 node >=22 + pnpm >=11）。
#    条件性 build 容易因为残留旧的 dist/ 导致前后端不一致；每次重建代价
#    可控（pnpm install --frozen-lockfile ~10s, pnpm build --parallel ~3s）。
log "building web frontend"
if ! command -v pnpm >/dev/null 2>&1; then
  fail "pnpm not found on PATH — install pnpm first (see deploy/ci/README.md)"
fi
(cd web && pnpm install --frozen-lockfile 2>&1 || fail "pnpm install failed: check network / registry")
(cd web && pnpm build 2>&1 || fail "pnpm build failed: see build errors above")

# 3) NewAPI 数据在服务重启/升级前先做可恢复备份（首次部署无容器时跳过）。
ENV_FILE="${DEPLOY_ROOT}/.env.${ENV_TARGET}"
[[ -f "${ENV_FILE}" ]] || fail "environment file missing: ${ENV_FILE}"
chmod 600 "${ENV_FILE}"
set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a
if docker ps --format '{{.Names}}' | grep -qx 'aiteam-newapi-pg'; then
  log "backing up internal NewAPI before restart"
  scripts/newapi-ops.sh --env-file "${ENV_FILE}" backup || fail "NewAPI backup failed"
else
  log "NewAPI database container not present yet; skipping pre-restart backup"
fi

# 4) 装 systemd unit（内容变了才 daemon-reload）
UNIT_SRC="${DEPLOY_ROOT}/deploy/ci/${UNIT_NAME}.service"
UNIT_DST="/etc/systemd/system/${UNIT_NAME}.service"
[[ -f "$UNIT_SRC" ]] || fail "unit file not found: ${UNIT_SRC}"
mkdir -p /etc/systemd/system
if ! cmp -s "$UNIT_SRC" "$UNIT_DST" 2>/dev/null; then
  cp "$UNIT_SRC" "$UNIT_DST"
  log "installed ${UNIT_DST} (content changed)"
  systemctl daemon-reload >/dev/null 2>&1 || fail "systemctl daemon-reload failed"
else
  log "${UNIT_DST} content unchanged"
fi

# 5) 启动 / 重启 daemon
log "restarting ${UNIT_NAME}"
systemctl enable "$UNIT_NAME" >/dev/null 2>&1 || true
if ! systemctl restart "$UNIT_NAME" 2>&1; then
  systemctl status "$UNIT_NAME" --no-pager >&2 || true
  fail "systemctl restart ${UNIT_NAME} failed — see status above"
fi

# 6) /healthz + internal NewAPI 冒烟；GET / 必须是 HTML
log "smoking /healthz"
sleep 5
for port in 8781 8782 8783; do
  ok=0
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS --max-time 3 "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
      log "  port ${port} /healthz OK"; ok=1; break
    fi
    sleep 2
  done
  (( ok )) || fail "port ${port} /healthz failed after 10 attempts"
done

newapi_ok=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 3 "http://127.0.0.1:${NEWAPI_PORT:-9300}/api/status" 2>/dev/null | grep -Eq '"success"[[:space:]]*:[[:space:]]*true'; then
    newapi_ok=1; break
  fi
  sleep 2
done
(( newapi_ok )) || fail "internal NewAPI /api/status failed after 10 attempts"
for container in aiteam-newapi-pg aiteam-newapi-redis aiteam-newapi; do
  state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${container}" 2>/dev/null || true)"
  [[ "${state}" == "healthy" || "${state}" == "running" ]] || fail "${container} is not healthy (state=${state:-missing})"
done
log "  internal NewAPI + PostgreSQL + Redis OK"

log "smoking GET / (front-end SPA entry must be HTML, not 404 Problem JSON)"
for port in 8781 8782 8783; do
  root_ct="$(curl -fsS -o /dev/null -w '%{content_type}' --max-time 5 "http://127.0.0.1:${port}/" 2>/dev/null || true)"
  if [[ "${root_ct}" != text/html* ]]; then
    fail "port ${port} GET / expected text/html, got '${root_ct:-no-response}' — front-end dist not mounted"
  fi
  log "  port ${port} / -> ${root_ct}"
done

log "deploy-run done (unit=${UNIT_NAME}, env=${ENV_TARGET}, branch=${BRANCH})"
