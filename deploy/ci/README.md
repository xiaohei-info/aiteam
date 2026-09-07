# deploy/ci — v1 自托管部署

PR merge 触发、self-hosted runner 执行的自动部署流水线。

## 文件

- `aiteam-v1.service` — systemd unit（`Type=simple`）。由 `run.sh` 装到
  `/etc/systemd/system/`，`ctl.sh --daemon` 在前台盯住三端子进程 PID。
- `run.sh` — 部署编排脚本。在部署根（默认 `/root/app/aiteam`）执行；TEST
  维护窗口先停止应用 writers，再保持应用停止拉取/构建代码，显式启动并确认
  PostgreSQL/NewAPI 依赖后备份、执行 DDL/迁移，最后启动新栈并做 healthz/readyz +
  HTML smoke。失败时保持应用停机，不回退到旧 writer 并行运行。
- `.github/workflows/deploy-main.yml` — GitHub Actions workflow。
  PR merge 到 `main` 或 `workflow_dispatch` 手动触发。

## 工作原理

```
PR merge → GitHub Actions → self-hosted runner(taiyi)
  → 校验 DEPLOY_ROOT 上的持久化 git checkout（不依赖 runner workspace checkout）
  → 写 DEPLOY_ROOT/.env.<env>（从 GitHub Secret 注入）
  → 从 origin/<branch> 只刷新 deploy/ci/run.sh（避免首次部署仍执行旧编排脚本）
  → cd DEPLOY_ROOT && bash deploy/ci/run.sh --branch <branch> --env <env>
      → TEST 维护窗口：先停止应用 writers/Manager/Operation/Agent，确认已退出
      → 保持应用停止，git pull --ff-only 同步部署根
      → pnpm install && pnpm build（每次部署重建，避免前后端产物不一致）
      → 按 checked-out `server/requirements.txt` hash 同步持久化 `.venv`（无 marker、或 hash 与 checked-out 文件不一致时才 pip install；hash 相同则跳过）
      → 启动并确认 PostgreSQL/NewAPI 依赖（应用仍停止）→ 备份 → DDL/迁移
      → 安装/校验新 unit，启动新的三端应用栈
      → /healthz、Manager /readyz、内部 NewAPI 与 HTML 冒烟
  → CI success
  → runner 退出
  → systemd (PID 1) 继续托管三端（runner 的 orphan clean-up 波及不到）
```

### taiyi TEST 版本与维护窗口口径

本轮允许的是**完整应用停机**，不是零停机、旧新栈并行或可选的复杂 systemd
cgroup cutover。任务给定的已部署基线是 `5483218e`（PR56）；当前工作树为未提交的
`e5a29890`，不能在发布记录中把两者写成同一个已部署版本。只有主控完成审查、CI 和
TEST 维护窗口后，当前工作树才可成为新的 release checkout。

TEST 顺序固定为：

1. 暂停新的应用写入/知识导入，停止 Manager、Operation、Agent writers，并确认旧进程已退出；
2. 保留数据卷；若依赖曾随旧栈停止，先在应用保持停止时启动并确认 PostgreSQL/NewAPI 可用。若 `ctl` 因固定名 `aiteam-pg` 已存在而无法 `compose up`，只在镜像、非秘密 `POSTGRES_USER`/`POSTGRES_DB` 与数据卷都与当前 TEST 期望一致时 `docker start` 复用该容器，不删除容器或卷；
3. 依赖可用后执行数据库备份；
4. 切换已批准 checkout；`run.sh` 按 `server/requirements.txt` 内容 hash 同步持久化 `.venv`（失败保持停机），再在应用保持停止时执行 0039 及其它已批准 DDL/迁移；
5. 迁移成功后启动新应用栈，再检查 healthz/readyz/OpenAPI 与 HTML 入口。

任何备份/DDL/迁移失败都保持应用停止并按 backout 合同人工对账。`stop_legacy_unit.py`
和 `s05_systemd_cutover_probe.py` 只是独立候选/hosted 实验，不属于上述 TEST 过程，
也不接入 `deploy-main.yml`。

## 新服务器接入清单（一次性）

在作为 `runs-on` 的机器上完成一次：

```bash
# 1. node >= 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# 2. pnpm >= 11（通过 corepack，随 node 自带）
corepack enable
corepack prepare pnpm@11 --activate

# 3. Docker Engine + Compose v2（PG/NewAPI 由 ctl.sh 通过 Docker 管理）
docker info
docker compose version
```

然后：

```bash
# 4. 部署根 clone 仓库（SSH 形式，origin 设 git@github.com:...）
#    部署用户需要有 GitHub repo push/pull 权限的 SSH key。
#    并在 GitHub repo 上添加该 key 为 deploy key。
git clone git@github.com:OWNER/REPO.git /root/app/aiteam
cd /root/app/aiteam
git remote set-url origin git@github.com:OWNER/REPO.git

# 5. venv bootstrap（首跑一次，与 .gitignore 里的 .venv 路径一致）。
#    之后每次 TEST 部署会按 server/requirements.txt 的内容 hash 再同步，不必手工重装；
#    首次更新也由 deploy-main.yml 先刷新 run.sh，避免继续执行旧编排脚本。
python3 -m venv .venv
.venv/bin/python -m pip install --requirement server/requirements.txt

# 6. 首跑前端 build（或触发一次 CI，CI 会在部署时重建）
cd web && pnpm install --frozen-lockfile && pnpm build

# 7. 注册 self-hosted runner（见 GitHub repo Settings → Actions → Runners）
#    runner 用户在部署根所在机器执行 workflow 步骤，应有不少于部署根的可写权限。
```

## 扩展更多环境/机器

复制 workflow yaml，改三处：

1. `on.pull_request.branches: [st-xxx/xxx]`
2. `jobs.deploy.runs-on: <新机器的 label>`
3. `env.DEPLOY_ROOT: /path/on/new/machine`

每个环境对应的 `<env>` 需要有：

- 部署根机器装好 node 22 + pnpm 11 + systemd
- `~/.ssh/` 下有 GitHub repo 的 SSH key（git pull 走 SSH，HTTPS 不缓存凭证）
- GitHub Secret `ENV_CONTENTS_<ENV>` = 该环境的完整 `.env.<env>` 内容

## LightRAG 生产部署前置

LightRAG 是 Manager-side 外部组件，不由三端 systemd unit 直接托管。taiyi/生产发布前，按 [`docs/部署运维/LightRAG-PostgreSQL-PGVector-部署运维Runbook.md`](../../docs/部署运维/LightRAG-PostgreSQL-PGVector-部署运维Runbook.md) 在目标 PG 上执行独立 database/role/`vector` extension bootstrap，并将 Manager-only `LIGHTRAG_URL`、API key 和已验证镜像引用放入部署机的 mode-600 secret env。Manager 按 tenant 生成并持久化 workspace；不要将这些值放入 Agent 配置或 GitHub 日志。

部署前只读检查：

```bash
bash scripts/check-deploy.sh
bash scripts/check-agent-sandbox.sh --dry-run
bash scripts/validate-lightrag-env.sh --production --env-file /etc/aiteam/manager.env
```

在目标 Linux 主机的发布维护窗口，再执行 `bash scripts/check-agent-sandbox.sh --linux-matrix`；该命令只运行短命 bwrap/Landlock 正负向测试，不重启 Agent。`--dry-run` 仅用于演练；数据库初始化、恢复、升级和 rollback 的真实命令只在 taiyi/生产维护窗口执行。CI 的 `deployment-ops-checks` workflow 只运行 shell/Compose/static-secret 闸门和 dry-run，不连接生产 PG、不拉 LightRAG 镜像、不携带真实 secret。完整 Agent/P2 清单见 [`docs/部署运维/Agent-Sandbox-生产发布Runbook.md`](../../docs/部署运维/Agent-Sandbox-生产发布Runbook.md)。

## 调试

```bash
# 部署根内手动跑一次（不触发 CI）
bash deploy/ci/run.sh --branch main --env test

# 看 daemon 日志
journalctl -f -u aiteam-v1

# 看三端业务日志
tail -f logs/{manager,operation,agent}.log

# 强制重新发布（忽略 CI）
cd /root/app/aiteam && git pull --ff-only && bash deploy/ci/run.sh --branch main --env test
```

## 常见问题

- **CI 报部署根不是 git 仓库 / 缺少 `deploy/ci/run.sh`**
  这是一次性初始化问题；按上面的新服务器清单 clone 到 `$DEPLOY_ROOT`，并确认
  origin 为 SSH。自动部署不再依赖 runner workspace 的 GitHub checkout。

- **CI 报 `fatal: could not read Username for 'https://github.com'`**
  部署根的 origin 走了 HTTPS，runner job 拿不到凭证。改成 SSH：
  `cd $DEPLOY_ROOT && git remote set-url origin git@github.com:OWNER/REPO.git`

- **CI 报 `dist missing` 并触发现场 build**
  部署根被意外删掉 dist。CI 会自动本地 build；也可以提前 `cd web && pnpm build` 预防。

- **CI 报 `pnpm not found` / `Node版本不兼容`**
  部署根机器没装 node ≥22 或 pnpm ≥11。按清单步骤 1–2 装好。

- **Manager 启动报 `ModuleNotFoundError`（例如 `yaml`）**
  持久化 `.venv` 落后于当前 `server/requirements.txt`。新的 `run.sh` 会在 checkout 后、迁移/启动前按 hash 自动 `pip install --requirement`；pip 失败则保持应用停机。也可按清单步骤 5 手工重建 venv。

- **CI 报 PostgreSQL `container name "/aiteam-pg" is already in use`**
  现有同名容器不是自动删除对象。`run.sh` 会检查该容器的镜像、`POSTGRES_USER=aiteam`、`POSTGRES_DB=aiteam_v1` 以及 `/var/lib/postgresql/data` 是否挂在 `POSTGRES_VOLUME` 或 `aiteam_pg_data_<env>` 上；匹配则复用（已运行则接受，已停止则 `docker start`）。不匹配或非同名冲突仍 fail-closed。不要手工 `docker rm` / `volume rm`。

- **`systemctl status` 显示 `activating (auto-restart) (exit-code 209/STDOUT)`**
  旧 unit 里 `StandardOutput=append:/.../logs/stdout.log` 指向不存在的文件。
  已不再使用；如仍遇到，重新 cp `deploy/ci/aiteam-v1.service` → `/etc/systemd/system/` +
  `systemctl daemon-reload && systemctl restart aiteam-v1`。
