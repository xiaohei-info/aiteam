# deploy/ci — v1 自托管部署

PR merge 触发、self-hosted runner 执行的自动部署流水线。

## 文件

- `aiteam-v1.service` — systemd unit（`Type=simple`）。由 `run.sh` 装到
  `/etc/systemd/system/`，`ctl.sh --daemon` 在前台盯住三端子进程 PID。
- `run.sh` — 部署编排脚本。在 `DEPLOY_ROOT` 指定的部署根（未指定时为当前目录）执行。
  **先构建后切换**：应用仍在运行时，在旁路目录 `<DEPLOY_ROOT>-stage` 完成拉取、装依赖、
  构建、检查，向后兼容的迁移也在这时执行；全部成功后才停应用、切换、启动并做
  healthz + HTML smoke。准备阶段失败不影响线上版本；切换或启动失败自动切回上一个版本。
  详见下文「先构建后切换」与「迁移规则」。
- `.github/workflows/deploy-main.yml` — GitHub Actions workflow。
  PR merge 到 `main` 或 `workflow_dispatch` 手动触发。

## 工作原理

```
PR merge → GitHub Actions → self-hosted runner(taiyi)
  → 校验 DEPLOY_ROOT 上的持久化 git checkout（不依赖 runner workspace checkout）
  → 写 DEPLOY_ROOT/.env.<env>（从 GitHub Secret 注入）
  → 从 origin/<branch> 只刷新 deploy/ci/run.sh（避免首次部署仍执行旧编排脚本）
  → cd DEPLOY_ROOT && bash deploy/ci/run.sh --branch <branch> --env <env>
      → 【应用仍在运行】git fetch，把目标提交检出到旁路目录 <DEPLOY_ROOT>-stage
      → 【应用仍在运行】独立 Node Agent、行业文档生成 worker（`server/solution_authoring_worker`）与 web 各自 pnpm install --frozen-lockfile，跑 Agent 登录检查，pnpm build 前端；requirements 有变化时预先 pip wheel
      → 【应用仍在运行】迁移全部向后兼容时，在线执行 DDL/迁移（带 lock_timeout）
      → 停止应用 writers/Manager/Operation/Agent
      → 切换部署根到目标提交；运行时依赖 pnpm install --offline；整体替换前端 dist
      → 按 checked-out `server/requirements.txt` hash 同步持久化 `.venv`（无 marker、或 hash 与 checked-out 文件不一致时才 pip install；hash 相同则跳过；优先用预先准备的 wheels 离线安装）
      → 启动并确认 PostgreSQL/NewAPI 依赖 → 备份 →（未在线完成时）DDL/迁移
      → 安装/校验新 unit，启动新的三端应用栈
      → /healthz、内部 NewAPI 与 HTML 冒烟；失败则自动切回上一个版本
  → CI success
  → runner 退出
  → systemd (PID 1) 继续托管三端（runner 的 orphan clean-up 波及不到）
```

### 先构建后切换

部署仍有一次短暂停机（从停应用到新栈健康），不是零停机、旧新栈并行或 systemd cgroup
cutover。与此前「先停应用再拉取/构建」的区别是：所有需要联网、可能因自身原因失败的步骤
都挪到了停应用之前。

| 阶段 | 应用状态 | 做什么 | 失败时 |
|---|---|---|---|
| prepare | 运行中 | fetch；旁路目录检出、装依赖、构建前端、Agent 登录检查、准备 Python wheels；向后兼容的迁移 | 直接退出，线上版本不受影响 |
| switch | 已停 | 切换代码、离线装运行时依赖、替换前端 dist、同步 venv | 自动切回上一个版本并启动 |
| data | 已停 | 启动并确认 PostgreSQL/NewAPI、NewAPI 备份、未在线完成的 DDL/迁移 | 保持停机，人工对账，不自动回滚 |
| start | 启动中 | 安装 unit、启动、/healthz、NewAPI、HTML 冒烟 | 自动切回上一个版本并启动；本次发布带收缩型迁移时不回滚、保持停机 |

- 旁路目录是部署根的一个 git worktree（默认 `<DEPLOY_ROOT>-stage`，可用 `DEPLOY_STAGE_DIR`
  改），保留自己的 `node_modules`，从不对外提供服务；会多占一份依赖和构建产物的磁盘。
  目录损坏时手工删除即可，下次部署会重建。
- 自动回滚只恢复代码、运行时依赖和前端产物；**不回退数据库，也不回退 `.venv`**。因此
  回滚是否安全取决于下面的迁移规则。回滚成功后本次部署仍以失败结束。
- 回滚后的旧版本是在新版本的 Python 依赖上运行的；requirements 有不兼容升级时旧版本可能
  起不来，此时脚本报 `ROLLBACK FAILED` 并保持停机。
- `DEPLOY_ONLINE_MIGRATIONS=0` 可关闭在线迁移，全部留到停机窗口内执行。

TEST 数据库约束：Manager 使用 `MANAGER_DB_NAME`（默认 `manager_control_db`），Operation 使用独立 `OPERATION_DB_NAME`（默认 `oper`）；两端的业务/管理 DSN 不得指向同一个数据库。`run.sh` 会在迁移前幂等创建 Operation database。若 `ctl` 因固定名 `aiteam-pg` 已存在而无法 `compose up`，只在镜像、容器内的迁移角色（对应 `.env` 的 `POSTGRES_SUPER_USER`）/`POSTGRES_DB` 与数据卷都与当前 TEST 期望一致时 `docker start` 复用该容器，不删除容器或卷；业务配置中的 `POSTGRES_USER` 必须是 `app_rw`。

`stop_legacy_unit.py` 和 `s05_systemd_cutover_probe.py` 只是独立候选/hosted 实验，不属于
上述过程，也不接入 `deploy-main.yml`。

### 迁移规则（向后兼容，先扩展后收缩）

迁移脚本没有版本表：每次部署都会按文件名顺序把 `migrations/*.sql` 全部重新执行一遍，所以
每个脚本必须幂等。在此之上，新增迁移还要满足：

1. **默认只扩展**：新增表、新增可空列或带默认值的列、新增索引、放宽约束。上一个版本的
   代码必须能在迁移后的表结构上继续运行。这样的迁移会在旧版本运行期间执行，出问题时
   旧版本不受影响，回滚也安全。
2. **收缩分两次发布**：删除或重命名表/列、改列类型、加 `NOT NULL`、清空数据，必须先发布
   一个不再使用该对象的版本，下一次发布再收缩。
3. **收缩型迁移要标记**：文件里加一行 `-- deploy-compat: contract`。带标记的发布，迁移
   留到停应用之后执行，并且启动失败时不自动回滚（旧代码不能在收缩后的结构上运行）。
4. 在线迁移带 `lock_timeout`（默认 5000 毫秒，`DEPLOY_MIGRATION_LOCK_TIMEOUT_MS` 可调）：
   拿不到锁就失败并中止部署，线上版本不受影响，重新触发部署即可。长时间的回填、大表建
   索引不要写进迁移脚本。

`server/tests/app/test_deployment_workflow_contract.py` 会检查新增迁移（Operation 0018、
Manager 0050 之后）：出现收缩型语句而没有标记时测试失败。这只是关键字检查，「旧代码能否
在新结构上运行」仍要靠评审判断。

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

LightRAG 是 Manager-side 外部组件，不由三端 systemd unit 直接托管。taiyi/生产发布前，按 [`docs/部署运维/LightRAG-PostgreSQL-PGVector-部署运维Runbook.md`](../../docs/部署运维/LightRAG-PostgreSQL-PGVector-部署运维Runbook.md) 在目标 PG 上执行独立 database/role/`vector` extension bootstrap；Manager-only 配置使用本机 profile 的 URL/API key/认证/运行时 DB 字段，或使用受边界校验的 HTTPS `LIGHTRAG_INSTANCES` endpoint pool。Manager 按 tenant 生成并持久化 workspace；不要将这些值放入 Agent 配置或 GitHub 日志。Remote pool-only 模式不启动本机 lightrag Compose profile；disabled 模式不设置上述组件变量。

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
  现有同名容器不是自动删除对象。`run.sh` 会检查该容器的镜像、容器内迁移角色（默认 `aiteam`，由 `.env` 的 `POSTGRES_SUPER_USER` 决定）、Manager 数据库（默认 `manager_control_db`，由 `MANAGER_DB_NAME` 决定） 以及 `/var/lib/postgresql/data` 是否挂在 `POSTGRES_VOLUME` 或 `aiteam_pg_data_<env>` 上；匹配则复用（已运行则接受，已停止则 `docker start`）。不匹配或非同名冲突仍 fail-closed。不要手工 `docker rm` / `volume rm`。

- **`systemctl status` 显示 `activating (auto-restart) (exit-code 209/STDOUT)`**
  旧 unit 里 `StandardOutput=append:/.../logs/stdout.log` 指向不存在的文件。
  已不再使用；如仍遇到，重新运行 `deploy/ci/run.sh --branch <branch> --env test`，由脚本按目标环境渲染并安装 unit，再执行 `systemctl daemon-reload`。
