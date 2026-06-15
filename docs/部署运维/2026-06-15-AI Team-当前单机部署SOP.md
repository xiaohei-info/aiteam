# AI Team 当前单机部署 SOP

## 1. 适用范围

本文只适用于 **当前仓库正在运行的这套单机 / 单服务部署方式**：

- `aiteam` 主仓提供 `app/` 宿主层
- `./.hermes/hermes-agent/` 提供外部 Hermes Runtime 源码
- PostgreSQL 提供 Team Panel 控制面数据库
- 通过 `app/.env` 管理本机运行配置
- 通过 `app/ctl.sh` 启停服务

本文 **不覆盖**：

- 未来微服务拆分部署
- 反向代理 / TLS / 域名接入
- systemd 守护
- Docker Compose 全量容器化部署

---

## 2. 目标结果

完成本文后，目标是让一台新的 Linux 服务器具备以下状态：

1. 已拉取 `aiteam` 主仓
2. 已拉取 `hermes-agent` 外部仓到 `./.hermes/hermes-agent/`
3. 已创建 `app/.venv` 并安装 Python 依赖
4. 已配置 `app/.env`
5. 已启动 PostgreSQL 并完成 migrations
6. 已通过 `app/ctl.sh start` 启动服务
7. 已通过 `/health` 等接口完成健康检查

---

## 3. 标准目录结构

推荐统一使用下面的目录布局：

```text
/home/ubuntu/code/aiteam/
├── app/
├── docs/
├── .hermes/
│   └── hermes-agent/
└── README.md
```

说明：

- `app/` 是 AI Team 当前主服务代码目录
- `./.hermes/hermes-agent/` 是 Hermes Runtime 外部源码仓
- `app/.env` 中的 `HERMES_WEBUI_AGENT_DIR` 必须指向真实的 Hermes Agent 路径

---

## 4. 部署前置条件

建议目标机器至少具备：

- Linux 环境（本文命令按 Ubuntu / bash 写）
- `git`
- `curl`
- `docker`
- 可用的 Python 3.11 构建依赖
- 可访问 GitHub 仓库

如果机器还没有 pyenv，可按本文步骤安装。

---

## 5. 拉取代码

### 5.1 拉取 aiteam 主仓

```bash
mkdir -p /home/ubuntu/code
cd /home/ubuntu/code
git clone git@github.com:xiaohei-info/aiteam.git
cd /home/ubuntu/code/aiteam
```

### 5.2 拉取 Hermes Agent 外部仓

当前这套运行链路中，Hermes Agent 仓库应放到：

```text
/home/ubuntu/code/aiteam/.hermes/hermes-agent
```

拉取命令：

```bash
mkdir -p /home/ubuntu/code/aiteam/.hermes
git clone https://github.com/NousResearch/hermes-agent.git /home/ubuntu/code/aiteam/.hermes/hermes-agent
```

如果你们内部使用的是 Hermes Agent 自己的 fork，替换为实际仓库地址即可，但目录位置建议保持不变。

---

## 6. 安装 Python 运行环境

### 6.1 安装 pyenv

如果机器尚未安装 pyenv：

```bash
curl https://pyenv.run | bash
```

把下面内容加入 `~/.bashrc`：

```bash
export PYENV_ROOT="$HOME/.pyenv"
export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init -)"
```

重新加载 shell：

```bash
exec "$SHELL"
```

### 6.2 安装并固定 Python 版本

项目当前固定版本为 `3.11.14`。

```bash
cd /home/ubuntu/code/aiteam/app
pyenv install 3.11.14 -s
pyenv local 3.11.14
python -V
```

预期看到：

```text
Python 3.11.14
```

### 6.3 创建项目虚拟环境

```bash
cd /home/ubuntu/code/aiteam/app
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip setuptools wheel
```

---

## 7. 安装依赖

### 7.1 安装 app 依赖

```bash
cd /home/ubuntu/code/aiteam/app
source .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
```

### 7.2 安装 Hermes Agent 到同一个 venv

`app/` 当前会直接导入 `run_agent` 和一部分 `hermes-agent` 模块，所以要把外部仓也装进同一个 venv：

```bash
cd /home/ubuntu/code/aiteam/app
source .venv/bin/activate
pip install -e "../.hermes/hermes-agent[dev]"
```

### 7.3 最小依赖验证

```bash
cd /home/ubuntu/code/aiteam/app
source .venv/bin/activate
python - <<'PY'
import yaml, pytest, psycopg2
from run_agent import AIAgent
print("python deps ok")
PY
```

如果这里失败，先不要继续启动服务，先把 Python 环境修好。

---

## 8. 配置 `app/.env`

### 8.1 从模板生成

```bash
cd /home/ubuntu/code/aiteam/app
cp .env.example .env
```

### 8.2 必改项

至少修改下面这些变量：

```dotenv
HERMES_WEBUI_HOST=127.0.0.1
HERMES_WEBUI_PORT=8787
HERMES_WEBUI_PYTHON=/home/ubuntu/code/aiteam/app/.venv/bin/python
HERMES_WEBUI_AGENT_DIR=/home/ubuntu/code/aiteam/.hermes/hermes-agent
DATABASE_URL=postgresql://aiteam:aiteam_test@127.0.0.1:5433/aiteam_test
TEST_DATABASE_URL=postgresql://aiteam:aiteam_test@127.0.0.1:5433/aiteam_test
HERMES_WEBUI_STATE_DIR=/home/ubuntu/code/aiteam/app/.state
HERMES_WEBUI_DEFAULT_WORKSPACE=/home/ubuntu/code/aiteam/app/workspace
```

说明：

- `HERMES_WEBUI_PYTHON` 必须指向 `app/.venv/bin/python`
- `HERMES_WEBUI_AGENT_DIR` 必须指向真实的 Hermes Agent 源码目录
- `DATABASE_URL` / `TEST_DATABASE_URL` 默认都按本 SOP 的 PostgreSQL 5433 配置

### 8.3 可选项

如果你希望把 Hermes Home 也隔离在项目目录，可以在 `app/.env` 中显式设置：

```dotenv
HERMES_HOME=/home/ubuntu/code/aiteam/app/.hermes
HERMES_CONFIG_PATH=/home/ubuntu/code/aiteam/app/.hermes/config.yaml
```

如果没有这类隔离需求，可以先不启用，沿用默认 `~/.hermes`。

---

## 9. 启动 PostgreSQL

当前推荐直接起一个本地 PostgreSQL 容器，统一用 `5433`：

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

检查容器是否启动成功：

```bash
docker ps --filter name=aiteam-l1-pg
```

如果容器已经存在但是停止状态，可以执行：

```bash
docker start aiteam-l1-pg
```

---

## 10. 执行数据库 migrations

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

conn = psycopg2.connect(os.environ["DATABASE_URL"])
apply_migrations(conn)
conn.close()
print("migrations applied")
PY
```

### 10.1 数据库最小连通性验证

```bash
cd /home/ubuntu/code/aiteam/app
set -a
source .env
set +a
source .venv/bin/activate
python - <<'PY'
import os
import psycopg2

conn = psycopg2.connect(os.environ["DATABASE_URL"])
cur = conn.cursor()
cur.execute("select 1")
print(cur.fetchone())
conn.close()
PY
```

预期输出类似：

```text
(1,)
```

---

## 11. 启动服务

### 11.1 后台启动

```bash
cd /home/ubuntu/code/aiteam/app
source .venv/bin/activate
./ctl.sh start
./ctl.sh status
```

默认监听：

- host: `127.0.0.1`
- port: `8787`

### 11.2 前台启动（用于排错）

如果你想直接看前台报错：

```bash
cd /home/ubuntu/code/aiteam/app
source .venv/bin/activate
./start.sh
```

### 11.3 直接用 Python 启动

只有在你明确需要绕过脚本时才这样做：

```bash
cd /home/ubuntu/code/aiteam/app
set -a
source .env
set +a
source .venv/bin/activate
python server.py
```

---

## 12. 启动后健康检查

### 12.1 基础健康检查

```bash
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/api/system-admin/health
curl -s http://127.0.0.1:8787/api/enterprise-admin/employees
```

说明：

- `/health` 用来判断宿主服务是否起来
- `/api/system-admin/health` 用来判断系统后台健康接口是否可达
- `/api/enterprise-admin/employees` 能较早暴露数据库配置和 Team Panel 初始化问题

### 12.2 页面访问

当前可直接访问的页面入口包括：

- `http://127.0.0.1:8787/admin/employees`
- `http://127.0.0.1:8787/admin/billing/usage`
- `http://127.0.0.1:8787/system/health`

---

## 13. 常用运维命令

```bash
cd /home/ubuntu/code/aiteam/app

# 查看状态
./ctl.sh status

# 停止服务
./ctl.sh stop

# 重启服务
./ctl.sh restart

# 查看最近 200 行日志
./ctl.sh logs --lines 200

# 持续跟日志
./ctl.sh logs --follow
```

---

## 14. 常见故障排查

### 14.1 `./ctl.sh start` 失败

先看：

```bash
cd /home/ubuntu/code/aiteam/app
./ctl.sh logs --lines 200
```

重点检查：

- `app/.env` 是否存在
- `HERMES_WEBUI_PYTHON` 是否指向真实的 `app/.venv/bin/python`
- `HERMES_WEBUI_AGENT_DIR` 是否存在且指向 `./.hermes/hermes-agent`

### 14.2 启动时报 `ModuleNotFoundError: run_agent`

说明 `hermes-agent` 没有正确装进当前 venv。

重新执行：

```bash
cd /home/ubuntu/code/aiteam/app
source .venv/bin/activate
pip install -e "../.hermes/hermes-agent[dev]"
```

### 14.3 启动时报 `No module named psycopg2`

说明当前 venv 没装好开发依赖。

重新执行：

```bash
cd /home/ubuntu/code/aiteam/app
source .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
```

### 14.4 `/api/enterprise-admin/employees` 返回 `database_unavailable`

优先检查：

1. PostgreSQL 容器是否在运行
2. `DATABASE_URL` 是否和本文一致
3. migrations 是否已执行

建议命令：

```bash
docker ps --filter name=aiteam-l1-pg
cd /home/ubuntu/code/aiteam/app
./ctl.sh logs --lines 200
```

### 14.5 `/health` 不通

优先检查：

```bash
cd /home/ubuntu/code/aiteam/app
./ctl.sh status
./ctl.sh logs --lines 200
```

如果 `status` 显示进程不存在，先回到前台启动模式看直接报错。

### 14.6 根路径还是原生 Hermes UI

这是当前口径下的正常现象。业务页面入口不在根路径，优先访问：

- `/admin/employees`
- `/admin/billing/usage`
- `/system/health`

---

## 15. 推荐验收顺序

完成部署后，按下面顺序验收最稳：

1. `python -V` 确认是 `3.11.14`
2. Python 最小导入校验通过
3. PostgreSQL 容器正常运行
4. migrations 执行成功
5. `./ctl.sh start` 成功
6. `/health` 可访问
7. `/api/system-admin/health` 可访问
8. `/api/enterprise-admin/employees` 不再报 `database_unavailable`

---

## 16. 相关文档

- `README.md`：仓库结构与边界说明
- `app/README.md`：当前代码宿主、开发环境、启动与测试说明
- `app/.env.example`：本机运行变量模板
- `app/ctl.sh`：后台启动、停止、状态、日志脚本

本文是把上述分散信息按“新服务器从零到启动”的顺序收口后的单独 SOP。
