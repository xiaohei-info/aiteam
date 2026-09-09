# 开发环境搭建指南

本文档面向新加入的开发者（人类或 AI agent），提供从零开始搭建 AI Team 开发环境的完整步骤。

## 前置软件（需自行安装）

在开始之前，确保本地已安装以下工具：

- **Git** — 版本管理
- **Docker** — 用于本地 PostgreSQL 数据库（集成测试 / E2E 测试必需）
- **Python ≥ 3.12** — 后端运行时
  - macOS: `brew install python@3.12`（系统自带的 `/usr/bin/python3` 通常是 3.9，太老不能用）
  - Ubuntu: `sudo apt install python3.12 python3.12-venv`
- **Node.js ≥ 22** — 前端运行时
  - 推荐使用 nvm: `nvm install 22`
- **pnpm ≥ 9** — 前端包管理器
  - `curl -fsSL https://get.pnpm.io/install.sh | sh -`
  - 安装后需 `source ~/.bashrc` 或 `source ~/.zshrc` 使 PATH 生效

## 快速开始（5 步到能跑测试）

### 1. 克隆仓库并切换到开发分支

```bash
git clone https://github.com/xiaohei-info/aiteam.git
cd aiteam
git checkout main  # 当前主开发分支
```

### 2. 设置 Python 后端环境

```bash
cd server
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
# 测试工具（必需）
.venv/bin/pip install pytest pytest-asyncio pytest-timeout pytest-cov diff-cover
cd ..
```

**验证**：`server/.venv/bin/python --version` 应该显示 ≥ 3.12。

**常见问题**：见 `server/README.md` §1.3 常见坑（如 `ModuleNotFoundError: No module named 'jwt'` 等）。

### 3. 设置前端环境

```bash
cd web
pnpm install
# 安装 Playwright 浏览器（chromium，约 150MB）
pnpm exec playwright install --with-deps chromium
cd ..
```

**说明**：
- `pnpm install` 会根据 `pnpm-lock.yaml` 安装 workspace 下所有包的依赖
- Playwright 浏览器安装到 `~/.cache/ms-playwright/`（用户主目录，不在项目内）
- `--with-deps` 会安装系统依赖（libnss3/libgbm 等），Ubuntu/Debian 上可能需要 sudo

### 4. 启动本地 PostgreSQL（集成测试 / E2E 必需）

```bash
docker run -d --name aiteam-pg -p 5432:5432 \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=manager_control_db \
  postgres:16

# 等待 PostgreSQL 就绪（约 5 秒）
until docker exec aiteam-pg pg_isready -U postgres -d manager_control_db >/dev/null 2>&1; do
  sleep 1
done
echo "PostgreSQL ready"
docker exec aiteam-pg createdb -U postgres operation_control_db
```

**说明**：
- 这是一次性临时容器，用完可以 `docker rm -f aiteam-pg` 删除
- 数据不持久化——每次重启容器会丢失数据，但测试用的迁移会自动重建
- 端口 5432 是 PostgreSQL 默认端口；如果已被占用，改成 `-p 55432:5432` 并对应修改后续的连接 URL

### 5. 设置环境变量（每个终端 session 需要 export 一次）

```bash
export AITEAM_ENV=test
export ADMIN_DB_URL=postgresql://postgres:postgres@localhost:5432/manager_control_db
export DB_URL=postgresql://app_rw:apprwpass@localhost:5432/manager_control_db
export OPERATION_ADMIN_DB_URL=postgresql://postgres:postgres@localhost:5432/operation_control_db
export OPERATION_DB_URL=postgresql://app_rw:apprwpass@localhost:5432/operation_control_db
export APP_RW_PASSWORD=apprwpass
export OPERATION_SYSTEM_USERNAME=sysadmin
export OPERATION_SYSTEM_PASSWORD=changeme-me
```

**提示**：可以把这段加到 `~/.bashrc` 或 `~/.zshrc`，或者写成 `scripts/local-env.sh` 在每次开发前 `source` 一下。

## 验证环境（分层验证，逐步排查）

### 5.1 后端单元测试（无需 PostgreSQL，最快）

```bash
cd server
.venv/bin/pytest -m "not integration" --timeout=300
# 预期：~2300 个用例通过，耗时 ~2 分钟
```

**说明**：单元测试用 fake repository（内存伪实现），不依赖真实数据库，是最快的验证方式。

### 5.2 前端单元测试（无需 PostgreSQL）

```bash
cd web
pnpm -r test
# 预期：
# shared: 64 passed
# operation: 123 passed
# agent: 99 passed
# manager: 138 passed
```

**说明**：前端单测用 vitest + jsdom，不依赖真实后端。

### 5.3 后端集成测试（需要 PostgreSQL）

```bash
cd server
# 确保已 export 环境变量（见步骤 5）
.venv/bin/pytest -m integration --timeout=600
# 预期：~200 个用例通过，耗时 ~1.5 分钟
```

**说明**：集成测试验证真实数据库迁移、RLS 隔离、触发器、跨端业务闭环（Loop A/B/C）。

### 5.4 E2E 测试（需要 PostgreSQL + 三端后端 + 三端前端）

```bash
cd web
# 确保已 export 环境变量（见步骤 5）
pnpm e2e
# 预期：~65 个 spec 通过，耗时 ~几分钟
```

**说明**：
- E2E 测试会启动控制面后端（FastAPI）与 Node Agent + 三端前端（Vite dev server）
- Playwright 配置（`web/playwright.config.ts`）的 `webServer` 会自动拉起它们
- 测试真实的浏览器交互、跨端 HTTP 调用、service token 契约

## 运行服务（本地开发）

### 启动后端服务

```bash
cd server
# 启动控制面单端（operation / manager 二选一）
python run.py --tier=operation  # 运营端，默认 http://localhost:8000
python run.py --tier=manager    # 企业端，默认 http://localhost:8000

# 用户端 Node Agent（独立于 Python 控制面）
pnpm --dir server/agent_service install
pnpm --dir server/agent_service start

# 每端暴露：
# - /healthz — 健康检查
# - /docs — Swagger UI
# - /redoc — ReDoc API 文档
# - /openapi.json — OpenAPI schema
```

**说明**：三端是独立进程，端口冲突时用 `--port 8001` 等参数指定。

### 启动前端 dev server

```bash
cd web
# 启动单个前端（operation / manager / agent 三选一）
pnpm -C operation dev  # 运营端，默认 http://localhost:5173
pnpm -C manager dev    # 企业端，默认 http://localhost:5173
pnpm -C agent dev      # 用户端，默认 http://localhost:5173

# Vite 会自动代理 /api/* 到对应后端（配置在各包的 vite.config.ts）
```

## 提交前检查清单

在提交 PR 前，确保以下检查全部通过：

- [ ] 后端单元测试通过：`cd server && .venv/bin/pytest -m "not integration"`
- [ ] 后端集成测试通过：`cd server && .venv/bin/pytest -m integration`
- [ ] 前端单测通过：`cd web && pnpm -r test`
- [ ] 类型检查通过：`cd web && pnpm -r typecheck`
- [ ] 构建成功：`cd web && pnpm -r build`
- [ ] E2E 冒烟通过：`cd web && pnpm e2e`（可选，本地跑全量 E2E 较慢）
- [ ] 代码格式化：`cd server && .venv/bin/ruff format .`（Python）/ `cd web && pnpm -r format`（前端，如有配置）

**CI 会自动跑这些检查**，本地提前验证可以更快发现问题。

## 文档导航

- **架构设计**：`docs/v1正式版本/技术设计/概要设计/00-架构总纲与裁决索引.md`（入口）
- **后端开发**：`server/README.md`（目录结构、运行服务、测试、常见坑）
- **前端开发**：`web/{operation,manager,agent}/README.md`（各端边界、路由、开发命令）
- **AI 协作指令**：`CLAUDE.md` / `AGENTS.md`（架构约束、技术决策、编码规范）

## 常见问题（FAQ）

### Q1: `ModuleNotFoundError: No module named 'jwt'`（或其他模块）

**根因**：`.venv` 没装全 `requirements.txt`。

**处理**：
```bash
cd server
.venv/bin/pip install -r requirements.txt
```

### Q2: pytest 显示 "0 ran / 全部 skip"

**根因**：集成测试需要 PostgreSQL，但环境变量未设置或 PG 未启动。

**处理**：
1. 确认 PG 容器运行：`docker ps | grep aiteam-pg`
2. 确认环境变量已 export：`echo $ADMIN_DB_URL` 与 `echo $OPERATION_DB_URL`（两者数据库名必须不同）
3. 重新 export 环境变量（见步骤 5）

### Q3: Playwright 报 "Executable doesn't exist"

**根因**：Playwright 浏览器未安装。

**处理**：
```bash
cd web
pnpm exec playwright install --with-deps chromium
```

### Q4: E2E 测试启动失败 "port already in use"

**根因**：本地已有服务占用了 8000 或 5173 端口。

**处理**：
1. 找到占用进程：`lsof -i :8000`（或 `:5173`）
2. 停掉该进程或更改 E2E 配置的端口

### Q5: macOS 上 Python 版本是 3.9

**根因**：macOS 系统自带的 `/usr/bin/python3` 通常是 3.9，太老。

**处理**：
```bash
brew install python@3.12
# 删除旧 venv 重建
rm -rf server/.venv
cd server
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt pytest pytest-timeout pytest-cov
```

### Q6: 集成测试失败 "password authentication failed for user app_rw"

**根因**：PostgreSQL 容器是新启动的，但测试代码期望的 `app_rw` 用户和权限还未创建。

**处理**：
- 这是**正常现象**——首次运行集成测试时，迁移脚本会自动创建 `app_rw` 用户和授权
- 如果持续失败，删除容器重来：`docker rm -f aiteam-pg`，然后重新执行步骤 4

## 清理环境（可选）

开发完成后，如果需要完全清理环境：

```bash
# 删除 Python venv
rm -rf server/.venv

# 删除前端依赖
rm -rf web/node_modules web/*/node_modules

# 删除 Playwright 浏览器缓存
rm -rf ~/.cache/ms-playwright

# 删除 PostgreSQL 容器
docker rm -f aiteam-pg

# 删除 pnpm 全局 store（可选，其他项目可能也在用）
rm -rf ~/.local/share/pnpm/store
```

## 贡献代码

1. 从 `main` 创建你的功能分支：`git checkout -b feat/your-feature`
2. 提交时遵循约定式提交：`feat(scope): 描述` / `fix(scope): 描述`
3. 确保所有测试通过（见"提交前检查清单"）
4. 推送分支并创建 Pull Request
5. **PR 合并前必须 CI 全绿**（当前私有仓 Free 计划无 branch protection，需人工/编排器确认 `gh pr checks` 全绿）。

---

**最后更新**：2026-07-02  
**维护者**：参见仓库 Contributors
