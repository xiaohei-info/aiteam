# deploy/ci — v1 自托管部署

PR merge 触发、self-hosted runner 执行的自动部署流水线。

## 文件

- `aiteam-v1.service` — systemd unit（`Type=simple`）。由 `run.sh` 装到
  `/etc/systemd/system/`，`ctl.sh --daemon` 在前台盯住三端子进程 PID。
- `run.sh` — 部署编排脚本。在部署根（默认 `/root/app/aiteam`）执行；完成
  git pull → 条件性前端 build → 装 unit → systemctl restart → healthz + HTML smoke。
- `.github/workflows/deploy-main.yml` — GitHub Actions workflow。
  PR merge 到 `main` 或 `workflow_dispatch` 手动触发。

## 工作原理

```
PR merge → GitHub Actions → self-hosted runner(taiyi)
  → checkout workflow source
  → 写 DEPLOY_ROOT/.env.<env>（从 GitHub Secret 注入）
  → cd DEPLOY_ROOT && bash deploy/ci/run.sh --branch <branch> --env <env>
      → git pull --ff-only 同步部署根
      → 条件：dist 缺失 → pnpm install && pnpm build
      → 装 systemd unit（内容变了才 daemon-reload）
      → systemctl restart aiteam-v1
      → /healthz 三端冒烟 + GET / 必须是 text/html
  → CI success
  → runner 退出
  → systemd (PID 1) 继续托管三端（runner 的 orphan clean-up 波及不到）
```

## 新服务器接入清单（一次性）

在作为 `runs-on` 的机器上完成一次：

```bash
# 1. node >= 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# 2. pnpm >= 11（通过 corepack，随 node 自带）
corepack enable
corepack prepare pnpm@11 --activate
```

然后：

```bash
# 3. 部署根 clone 仓库（SSH 形式，origin 设 git@github.com:...）
#    部署用户需要有 GitHub repo push/pull 权限的 SSH key。
#    并在 GitHub repo 上添加该 key 为 deploy key。
git clone git@github.com:OWNER/REPO.git /root/app/aiteam
cd /root/app/aiteam
git remote set-url origin git@github.com:OWNER/REPO.git

# 4. venv bootstrap（首跑一次，与 .gitignore 里的 .venv 路径一致）
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 5. 首跑前端 build（或触发一次 CI，CI 会条件性 build）
cd web && pnpm install --frozen-lockfile && pnpm build

# 6. 注册 self-hosted runner（见 GitHub repo Settings → Actions → Runners）
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

LightRAG 是 Manager-side 外部组件，不由三端 systemd unit 直接托管。taiyi/生产发布前，按 [`docs/部署运维/LightRAG-PostgreSQL-PGVector-部署运维Runbook.md`](../../docs/部署运维/LightRAG-PostgreSQL-PGVector-部署运维Runbook.md) 在目标 PG 上执行独立 database/role/`vector` extension bootstrap，并将 Manager-only `LIGHTRAG_URL`、API key、固定 workspace 和已验证镜像引用放入部署机的 mode-600 secret env。不要把这些值放入 Agent 配置或 GitHub 日志。

部署前只读检查：

```bash
bash scripts/check-deploy.sh
bash scripts/validate-lightrag-env.sh --production --env-file /etc/aiteam/manager.env
```

`--dry-run` 仅用于演练；数据库初始化、恢复、升级和 rollback 的真实命令只在 taiyi/生产维护窗口执行。CI 的 `deployment-ops-checks` workflow 只运行 shell/Compose/static-secret 闸门和 dry-run，不连接生产 PG、不拉 LightRAG 镜像、不携带真实 secret。

## 调试

```bash
# 部署根内手动跑一次（不触发 CI）
bash deploy/ci/run.sh --branch main --env test

# 看 daemon 日志
journalctl -f -u aiteam-v1

# 看三端业务日志
tail -f logs/{manager,operation,agent}.log

# 强制重新发布（忽略 CI）
cd /root/app/aiteam && git pull --ff-only && bash deploy/ci/run.sh -e test
```

## 常见问题

- **CI 报 `fatal: could not read Username for 'https://github.com'`**
  部署根的 origin 走了 HTTPS，runner job 拿不到凭证。改成 SSH：
  `cd $DEPLOY_ROOT && git remote set-url origin git@github.com:OWNER/REPO.git`

- **CI 报 `dist missing` 并触发现场 build**
  部署根被意外删掉 dist。CI 会自动本地 build；也可以提前 `cd web && pnpm build` 预防。

- **CI 报 `pnpm not found` / `Node版本不兼容`**
  部署根机器没装 node ≥22 或 pnpm ≥11。按清单步骤 1–2 装好。

- **`systemctl status` 显示 `activating (auto-restart) (exit-code 209/STDOUT)`**
  旧 unit 里 `StandardOutput=append:/.../logs/stdout.log` 指向不存在的文件。
  已不再使用；如仍遇到，重新 cp `deploy/ci/aiteam-v1.service` → `/etc/systemd/system/` +
  `systemctl daemon-reload && systemctl restart aiteam-v1`。
