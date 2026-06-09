# AI Team App Host

`app/` 是 AI Team 当前阶段的 **Agent Service 宿主层**。

当前定位是：
- 以既有 Web 宿主能力为代码基座
- 在其上落地 **Team Panel**（业务控制面）
- 在其上落地 **Agent Gateway**（运行时适配层）
- 支撑 AI Team 的私聊、群聊、编排、Loop、治理与审计能力

---

## 1. 当前职责边界

### 1.1 `app/` 负责什么

`app/` 当前负责：
- HTTP 宿主与页面壳
- AI Team 北向 API 挂接点
- Team Panel 业务模块
- Agent Gateway 进程内适配模块
- 可复用的会话、流式传输、上传、工作区、认证等宿主能力

### 1.2 `app/` 不负责什么

`app/` 不负责：
- 作为独立开源 WebUI 产品继续演进
- 维护上游项目的发布、社区、路线图、主题体系、贡献者文档
- 取代 `./.hermes/hermes-agent/` 成为执行真相层

执行真相层仍然是仓库外部依赖的 `./.hermes/hermes-agent/`。

---

## 2. 当前代码结构

```text
app/
├── api/                 # 宿主层 API、挂接点、保留的基础能力
├── agent_gateway/       # AI Team 运行时适配层
├── team_panel/          # AI Team 业务控制面
├── static/              # 浏览器静态资源与 AI Team 页面壳
├── tests/               # 宿主层与 AI Team 自动化测试
├── server.py            # HTTP 服务入口
├── bootstrap.py         # 本地启动探测与引导
├── ctl.sh               # 后台启动/停机/状态/日志
├── start.sh            # 前台启动脚本
├── Dockerfile / compose # 宿主层容器化运行入口
└── requirements*.txt    # 当前 Python 依赖说明
```

### 2.1 目录职责详述

**api/**
- 宿主层保留能力：HTTP 路由入口、静态资源与 SSE 输出、认证、上传、工作区、终端等通用能力
- 约束：`api/routes.py` 不应继续承载大块 AI Team 业务逻辑；新业务语义优先下沉到 `team_panel/` 或 `agent_gateway/`

**team_panel/**
- AI Team 业务控制面
- 当前已形成的子层包括：`api_team/`、`application/`、`domain/`、`repositories/`、`transactions/`、`integration/`、`views/`、`migrations/`

**agent_gateway/**
- AI Team 运行时适配层
- 包括 RuntimeHandle 创建与更新、单聊/群聊/编排/定时任务路径的运行时提交适配、事件水合与补拉、凭据解析、Profile 供应、对账与恢复

**static/**
- 浏览器端页面壳与交互脚本
- 分两部分：原宿主静态能力（通用会话、流式、设置、终端等）和 `static/aiteam/`（AI Team 页面壳、页面模块、状态辅助与 timeline 客户端）
- 约束：前端主路径优先消费 Team Panel 北向接口，不把 Runtime 原始对象直接暴露为主产品语义

**tests/**
- 测试目录当前是混合态：一部分覆盖宿主层保留能力，一部分已明确覆盖 AI Team 分层实现（`tests/aiteam/`）

---

## 3. 模块映射

按照 AI Team 设计文档中的统一口径：
- `app/` = **Agent Service** 的当前物理落地目录
- `team_panel/` = **Team Panel** 业务控制面
- `agent_gateway/` = **Agent Gateway** 运行时适配层
- `./.hermes/hermes-agent/` = **Agent Runtime / Hermes Runtime**（外部独立仓）

---

## 4. 开发原则

1. **AI Team 新能力优先进入 `team_panel/`、`agent_gateway/`、`static/aiteam/`**
2. **`api/routes.py`、`server.py` 等基座文件只做挂接性改造**
3. **不要把产品语义重新写成上游 WebUI 产品文档**
4. **不要把 AI Team 业务逻辑写进 `./.hermes/hermes-agent/`**
5. **凡涉及 Python 解释器、Hermes CLI、Hermes Home 或 config 的运行入口，必须优先复用 `app/.env` 中的 `HERMES_WEBUI_PYTHON`、`HERMES_HOME`、`HERMES_CONFIG_PATH`、`HERMES_WEBUI_AGENT_DIR`，禁止裸用其他 Python/Hermes 环境作为主路径。**

---

## 5. 新机器开发环境配置

## 5.1 推荐方式：使用独立 pyenv + 项目本地 `.venv`

推荐方案：
- 用 `pyenv` 管理 Python 版本
- 在 `app/` 目录下创建项目自己的 `.venv`
- 把 `app/` 自身依赖和 `./.hermes/hermes-agent/` 的 Python 包都装进这个项目 venv
- 运行时仍然依赖仓库内的 `./.hermes/hermes-agent/` 源码仓或显式的 `HERMES_WEBUI_AGENT_DIR`

### 5.1.1 目录建议

```text
/home/ubuntu/code/aiteam/
├── app/
└── .hermes/
    └── hermes-agent/
```

如果实际目录不是 `./.hermes/hermes-agent/`，直接改 `app/.env` 里的：

```dotenv
HERMES_WEBUI_AGENT_DIR=/absolute/path/to/hermes-agent
```

### 5.1.2 安装 pyenv（Linux）

如果机器上还没有 pyenv，可按官方方式安装：

```bash
curl https://pyenv.run | bash
```

添加到 shell 配置里（如 `~/.bashrc`）：

```bash
export PYENV_ROOT="$HOME/.pyenv"
export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init -)"
```

重新加载 shell：

```bash
exec "$SHELL"
```

### 5.1.3 安装并固定 Python 版本

当前项目已经写入：
- `app/.python-version = 3.11.14`

在 `app/` 下执行：

```bash
cd /home/ubuntu/code/aiteam/app
pyenv install 3.11.14 -s
pyenv local 3.11.14
python -V
```

### 5.1.4 创建并维护 `app/.env`

仓库现在同时提供两份文件：
- `app/.env.example`：可提交的安全模板
- `app/.env`：本机真实运行值

使用时先执行：

```bash
cd /home/ubuntu/code/aiteam/app
cp .env.example .env
```

`./start.sh`、`./ctl.sh`、`python bootstrap.py` 会自动读取 `app/.env`。

#### 环境变量分组说明

当前 `app/.env.example` / `app/.env` 已按用途分组：

1. **必须优先改的本地开发变量**
   - `HERMES_WEBUI_PYTHON`
   - `HERMES_WEBUI_AGENT_DIR`
   - `DATABASE_URL`
   - `TEST_DATABASE_URL`
   - 以及必要时的 `HERMES_WEBUI_HOST` / `HERMES_WEBUI_PORT`

2. **通常按默认值即可的宿主层变量**
   - `HERMES_WEBUI_STATE_DIR`
   - `HERMES_WEBUI_DEFAULT_WORKSPACE`
   - `HERMES_WEBUI_PID_FILE`
   - `HERMES_WEBUI_LOG_FILE`
   - `HERMES_WEBUI_CTL_STATE_FILE`

3. **按需开启的能力开关**
   - `HERMES_WEBUI_PASSWORD`
   - `HERMES_WEBUI_SESSION_TTL`
   - `HERMES_WEBUI_PASSKEY`
   - `HERMES_WEBUI_SKIP_ONBOARDING`
   - `HERMES_WEBUI_ONBOARDING_OPEN`
   - `HERMES_WEBUI_DEFAULT_MODEL`

4. **集成 / 调试类变量**
   - `HERMES_WEBUI_PREFILL_MESSAGES_SCRIPT`
   - `HERMES_PREFILL_MESSAGES_FILE`
   - `HERMES_WEBUI_EXTERNAL_NOTES_SOURCES`
   - `WIKI_PATH`
   - `JOPLIN_URL` / `JOPLIN_TOKEN`
   - `MEDIA_ALLOWED_ROOTS`
   - `HERMES_WEBUI_SLOW_REQUEST_SECONDS`
   - `HERMES_DEBUG_SLOW`

5. **容器 / WSL 专用变量**
   - `UID` / `GID`
   - `HERMES_WORKSPACE`
   - `WANTED_UID` / `WANTED_GID`
   - `HERMES_UID` / `HERMES_GID`
   - `HERMES_SKIP_CHMOD`
   - `HERMES_HOME_MODE`
   - `HERMES_WEBUI_REPO`
   - `HERMES_WEBUI_LOG_DIR`
   - `HERMES_WEBUI_HEALTH_HOST`
   - `HERMES_WEBUI_HEALTH_URL`

日常本地开发时，通常只需要关心第 1 组；其余保持注释状态即可。

### 5.1.5 创建项目本地虚拟环境

```bash
cd /home/ubuntu/code/aiteam/app
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip setuptools wheel
```

如果你在仓库根目录执行，同一套步骤等价写法是：

```bash
cd /home/ubuntu/code/aiteam
python -m venv app/.venv
source app/.venv/bin/activate
python -m pip install --upgrade pip setuptools wheel
```

### 5.1.6 安装 app 依赖 + 测试依赖

```bash
cd /home/ubuntu/code/aiteam/app
source .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
```

如果你在仓库根目录执行，也可以直接使用：

```bash
pip install -r app/requirements-dev.txt
```

当前新增的 `requirements-dev.txt` 用于补齐本地开发/测试最小依赖，包括：
- `pytest`
- `pytest-timeout`
- `psycopg2-binary`

### 5.1.7 安装 hermes-agent 到同一个项目 venv

因为 `app/` 会直接导入 `run_agent` 与一部分 `hermes-agent` 模块，所以如果要本机共享 Hermes venv，把 `./.hermes/hermes-agent/` 也装进当前项目 venv：

```bash
cd /home/ubuntu/code/aiteam/app
source .venv/bin/activate
pip install -e "../.hermes/hermes-agent[dev]"
```

### 5.1.8 最小验证

```bash
cd /home/ubuntu/code/aiteam/app
source .venv/bin/activate
python -V
python -m pytest --version
python - <<'PY'
import yaml, pytest, psycopg2
from run_agent import AIAgent
print('env ok')
PY
```

### 5.1.9 AI Team pytest 后端前置条件

在跑 `app/tests/aiteam/` 的后端验证前，先确认以下事实：

- 已执行 `pip install -r app/requirements-dev.txt`
- 当前解释器里可导入 `psycopg2`，也就是 `requirements-dev.txt` 里的 `psycopg2-binary` 已装好
- `docker` 可用，因为 `app/tests/aiteam/layer1_data/fixtures.py` 在本机 `127.0.0.1:5433` 没有 PostgreSQL 时，会回退到 ephemeral postgres 容器
- `TEST_DATABASE_URL=postgresql://aiteam:aiteam_test@127.0.0.1:5433/aiteam_test`

最小检查命令：

```bash
cd /home/ubuntu/code/aiteam
python -m venv app/.venv
source app/.venv/bin/activate
pip install -r app/requirements-dev.txt
python - <<'PY'
import psycopg2
print("psycopg2 ok")
PY
pytest app/tests/aiteam/layer2_team_panel/test_auth_northbound_routes.py -q
```

如果 pytest 在导入 `app/tests/aiteam/conftest.py` 时就报 `ModuleNotFoundError: No module named 'psycopg2'`，说明阻塞点是本地验证环境没装好，而不是 Auth 北向业务逻辑回归。

---

## 6. 外部服务依赖

当前至少要明确两类外部依赖：
- `./.hermes/hermes-agent/` 源码仓（运行时依赖）
- PostgreSQL（Team Panel 控制面数据库）

## 6.1 hermes-agent 依赖

如果是标准开发布局：

```text
/home/ubuntu/code/aiteam/
├── app/
└── .hermes/
    └── hermes-agent/
```

一般不需要额外指定路径，但仍建议以 `app/.env` 中的 `HERMES_WEBUI_AGENT_DIR` 作为最终真相源。

如果不是这个默认目录，直接修改 `app/.env` 的 `HERMES_WEBUI_AGENT_DIR`。

## 6.2 PostgreSQL 启动

Team Panel 的企业后台、员工列表、计费视图、Layer1/Layer2/Layer5 测试，都依赖 PostgreSQL。

推荐本地开发统一使用 5433：

```bash
docker run -d \
  --name aiteam-l1-pg \
  -e POSTGRES_USER=aiteam \
  -e POSTGRES_PASSWORD=aiteam_test \
  -e POSTGRES_DB=aiteam_test \
  -p 5433:5432 \
  -v aiteam_pg_data:/var/lib/postgresql/data \
  postgres:16-alpine
```

### 6.2.1 应用连接串

修改 `app/.env`：

```dotenv
DATABASE_URL=postgresql://aiteam:aiteam_test@127.0.0.1:5433/aiteam_test
```

### 6.2.2 测试连接串（可选，显式指定时用）

修改 `app/.env`：

```dotenv
TEST_DATABASE_URL=postgresql://aiteam:aiteam_test@127.0.0.1:5433/aiteam_test
```

### 6.2.3 运行 migrations

```bash
cd /home/ubuntu/code/aiteam/app
set -a
source .env
set +a
source .venv/bin/activate
python - <<'PY'
import os
import psycopg2
from team_panel.migrations.runner import apply_migrations

conn = psycopg2.connect(os.environ['DATABASE_URL'])
apply_migrations(conn)
conn.close()
print('migrations applied')
PY
```

### 6.2.4 最小验证

```bash
set -a
source .env
set +a
python - <<'PY'
import os
import psycopg2
conn = psycopg2.connect(os.environ['DATABASE_URL'])
cur = conn.cursor()
cur.execute('select 1')
print(cur.fetchone())
conn.close()
PY
```

---

## 7. 启动服务

用项目本地 `.venv`。`./ctl.sh` / `./start.sh` 会自动读取 `app/.env`：

```bash
cd /home/ubuntu/code/aiteam/app
source .venv/bin/activate
./ctl.sh start
./ctl.sh status
```

默认绑定：
- host: `127.0.0.1`
- port: `8787`

前台看错误，自动读取 `app/.env` 的入口：

```bash
cd /home/ubuntu/code/aiteam/app
source .venv/bin/activate
./start.sh
```

直接运行 `python server.py`，需要先把 `app/.env` source 进当前 shell：

```bash
cd /home/ubuntu/code/aiteam/app
set -a
source .env
set +a
source .venv/bin/activate
python server.py
```

启动后验证：

```bash
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/api/system-admin/health
curl -s http://127.0.0.1:8787/api/enterprise-admin/employees
```

---

## 8. 页面访问方式

当前已接真实页面模块的路径
- `http://127.0.0.1:8787/admin/employees`
- `http://127.0.0.1:8787/admin/billing/usage`
- `http://127.0.0.1:8787/system/health`

---

## 9. 运行测试

顺序跑：

```bash
cd /home/ubuntu/code/aiteam/app
source .venv/bin/activate
python -m pytest tests/aiteam/layer0_contracts -v
python -m pytest tests/aiteam/layer1_data -v
python -m pytest tests/aiteam/layer2_team_panel -v
python -m pytest tests/aiteam/layer3_gateway -v
python -m pytest tests/aiteam/layer4_frontend_bff -v
python -m pytest tests/aiteam/layer5_flows -v
```

分层含义：
- `layer0`：host seam、事件协议、SSE 北向口径
- `layer1`：数据模型、仓储、数据库约束
- `layer2`：Team Panel API
- `layer3`：Gateway 适配
- `layer4`：页面/BFF 边界
- `layer5`：业务流程闭环

---

## 10. 常见排查点

| 现象 | 先看哪里 |
|------|----------|
| `./ctl.sh start` 失败 | `./ctl.sh logs --lines 200` |
| `/health` 不通 | `./ctl.sh status`、宿主层日志 |
| `/api/enterprise-admin/employees` 返回 `database_unavailable` | `DATABASE_URL`、PG 容器、migrations |
| 根路径还是原生 Hermes UI | 这是当前正常行为，请访问 `/app`、`/admin`、`/system` 前缀 |
| `/app/...` 页面像壳 | 当前前台业务页尚未全部落地，只是部分 shell/占位页 |
| run 已创建但没有事件 | `/api/team/runs/{run_id}/events`、gateway 日志 |
| 事件有了但 UI 不更新 | SSE stream、`static/aiteam/` 页面脚本 |

日志查看：

```bash
# 宿主层日志
./ctl.sh logs --follow

# Runtime 日志
curl -s "http://127.0.0.1:8787/api/logs?file=agent&tail=200"
curl -s "http://127.0.0.1:8787/api/logs?file=gateway&tail=200"
curl -s "http://127.0.0.1:8787/api/logs?file=errors&tail=200"
```

---

## 11. 文档入口

优先看这些文档：
- `../README.md`：仓库结构与边界
- `../AGENTS.md`：全局约束与开发检查点
- `../docs/技术设计/技术设计.md`：AI Team 正式技术设计导航
- `../docs/技术设计/详细设计文档/2026-05-28-AI Team-共享运行口径定稿版.md`：跨模块契约唯一裁决
- `tests/aiteam/README.md`：测试分层说明

---

## 12. 清理口径

本目录已经按 AI Team 主仓口径开始收口：
- 纯上游开源项目的社区/发布/路线图类文件已移除或不再作为权威文档
- AI Team 自己的实现说明、运行说明与开发检查项留在本目录
- 若后续仍发现明显的上游产品残留文案，应继续按“AI Team 主项目”口径清理
