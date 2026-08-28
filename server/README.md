# AI Team v1 后端（`server/`）

> v1 后端：运营端 `operation_service` / 企业端 `manager_service` / 用户端 Node 包 `agent_service` + 横向共享库 `shared`。
> 架构口径以 `docs/v1正式版本/技术设计/概要设计/` 为准；通用约束见仓库根 `CLAUDE.md` / `AGENTS.md`。
>
> **与 `app/` 的关系**：`app/` 是冻结的 MVP 单体，**只读契约参考**。`server/` 是 v1 全新重建，不读 `app/.env`、不调旧端点、不与 `app/` 互相 import。旧单机部署见 `docs/部署运维/2026-06-15-AI Team-当前单机部署SOP.md`（那是 `app/` 的，不是本文）。

---

## 1. Python 开发环境（克隆后第一步）

### 版本要求

**Python ≥ 3.12**。`requirements.txt` 不钉死版本，但 3.11 以下不行（pydantic v2 / fastapi 需要）。
> ⚠️ macOS 自带的 `/usr/bin/python3` 通常是 3.9，**太老不能用**。用 `brew install python@3.12`（或更高）。

### venv 策略（多平台开发约定）

**每台机器在仓库根建一个共享 `.venv`，所有 git worktree 共用；跨机器（Oracle / Mac / 新机器）各自重建。**

理由：
- `requirements.txt` 是 Wave 0 冻结的契约，开发期**不允许擅自加包**（共享 infra 改动报编排者统一处理）——依赖不变，各 worktree 各建 venv 是纯浪费（`psycopg[binary]` 是平台 wheel，重装慢、占空间）。
- worktree 隔离的是**代码工作树**，不是 Python 环境；venv 用绝对路径激活，对任何 worktree 通用。
- `.venv` 不可跨机器复制（路径 + 平台二进制 + Python 版本绑定），所以 `.gitignore` 已忽略 `/.venv/` 与 `/server/.venv/`——**不入库，每台机器自建**。

### 标准安装命令（克隆后照做）

```bash
git clone <repo> && cd aiteam && git checkout main

# 仓库根建 venv（用 ≥3.12 的 python）
python3.12 -m venv .venv
source .venv/bin/activate

# 装全运行期依赖（必须装全，见下方「常见坑」）
pip install -r server/requirements.txt

# 测试工具不在运行期 requirements，单独装
pip install pytest pytest-asyncio pytest-timeout pytest-cov
```

> 后续在新 worktree 里干活，**不需要重建 venv**——直接 `source /<仓库根绝对路径>/.venv/bin/activate` 即可共享。

---

## 2. 跑测试

```bash
cd server
pytest -m "not integration"      # 基线：契约 + 边界 + 单元，无外部依赖
```

- 当前基线：`252 passed, 18 deselected`（18 个 `integration` 标记用例需要真实 PG，默认跳过）。
- 集成测试（`-m integration` 或全量）需要 PostgreSQL：见 `tests/integration/` 与各测试模块的环境要求。

### 常见坑

| 现象 | 根因 | 处理 |
|---|---|---|
| `ModuleNotFoundError: No module named 'jwt'` 等一堆 collection error | `.venv` 没装全 `requirements.txt`（漏 `pyjwt`/`psycopg`/`cryptography`/`uvicorn`）| `pip install -r server/requirements.txt` 装全 |
| `No module named pytest` | 没装测试工具 | `pip install pytest pytest-asyncio pytest-timeout pytest-cov` |
| venv 用了系统 3.9 | `/usr/bin/python3` 太老 | 删 `.venv`，用 `python3.12 -m venv .venv` 重建 |
| `StarletteDeprecationWarning: install httpx2` | fastapi 0.138 + httpx 0.28 组合的弃用警告 | **无害，测试照过**；`httpx2` 生态未稳，暂不换 |

---

## 3. 跑服务（dev）

```bash
cd server
python run.py --tier=manager        # 或 operation；用户端用 `pnpm --dir agent_service start`
```

每端暴露 `/healthz` `/readyz` `/docs` `/redoc` `/openapi.json`。

### OpenAPI 文档门禁

Swagger UI 和 ReDoc 都直接消费运行时生成的 OpenAPI。提交前运行下面的命令，它会装配 Operation、Manager、Node Agent 三端真实应用，导出文档并检查描述、参数、schema、鉴权、错误响应和路由清单：

```bash
# 在仓库根目录执行
bash scripts/check-openapi.sh
```

输出目录可作为第一个参数传入；该目录只保存临时生成的 JSON，不是手工维护的契约副本。

---

## 4. 目录结构

```text
server/
├── run.py                  # 控制面启动器：--tier=operation|manager
├── shared/                 # 横向共享库：contracts/（代码契约）auth db errors observability service_client ...
├── operation_service/      # 运营端（企业开通 / 目录 / 跨企业汇总）
├── manager_service/        # 企业端（多租户底座 / 认证 / 业务配置）
├── agent_service/          # 用户端 Node Agent（Pi Session / SQLite）
├── tests/                  # contracts / boundary / shared / 各端 / integration
├── conftest.py             # 把 server/ 加入 sys.path，使 `import shared...` 可用
└── requirements.txt        # 运行期最小依赖（不含测试工具）
```

- **契约即代码**：`shared/contracts/` 是全端唯一口径，下游**只 import、禁重定义**。
- **CI 闸门**：`tests/boundary/`（旧路径 / `HERMES_WEBUI_*` / 旧角色 / `import app` / `app/.env` 守卫）+ `tests/contracts/`（枚举/事件集合漂移守卫）。

---

## 5. 并行编排工具

多 Agent 并行开发的中轴命令在**仓库根** `scripts/orchestrator/orchestrate.py`（非 `server/` 下）：

```bash
python3 scripts/orchestrator/orchestrate.py status -R xiaohei-info/aiteam   # 看全局进度（实时拉 GitHub）
python3 scripts/orchestrator/orchestrate.py tick   -R xiaohei-info/aiteam --timeout 600   # 阻塞推进一拍
```

- 前提：`gh ≥ 2.94`（原生 issue 依赖命令），`gh auth status` 有 `repo` scope。
- 用法/退出码见 `scripts/orchestrator/README.md`；方法论见 `.claude/skills/parallel-dev-orchestration/`。
- `.tick-state.json` 是**本机运行时比对垫片**（跨 tick diff 用），被 `.gitignore` 忽略——**不入库、每机自生**，丢了不丢信息（全局真相在 GitHub issue）。
