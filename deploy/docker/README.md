# AI Team v1 部署

三端部署形态、按端构建产物精简（D15 / 09 §14）、单机模拟三端联调。

> 单一事实源：`docs/v1正式版本/技术设计/概要设计/09-部署分发与入户绑定.md` §14；本目录是落地。

---

## 1. 三端部署形态

AI Team v1 是「云侧双控制面 + 用户本地数据面」架构，三端是可独立部署的部署单元（CLAUDE §1）：

| 端 | 部署位置 | 镜像 | 端口（dev） | 后端模块 | 前端目录 |
|----|----------|------|-------------|----------|----------|
| 运营端 Operation | 平台方部署 | `Dockerfile.operation` | 8001 | `server/operation_service` + `shared` | `web/operation` |
| 企业端 Manager | 平台托管多租户 SaaS | `Dockerfile.manager` | 8002 | `server/manager_service` + `shared` | `web/manager` |
| 用户端 Agent | 每用户本机自部署 | `Dockerfile.agent` | 8003 | Node `server/agent_service` | `web/agent` |

通信面（05 §5.5 窄通信面）：
- Operator ↔ Manager：云侧服务间调用（`MANAGER_URL` / `OPERATOR_URL`）。
- Agent → Manager：用户端主动访问（`MANAGER_URL`）；**Operator/Manager 绝不向用户机器入站**。
- Agent 本地库 + 本地执行：会话与 Pi Session 全在用户本机，**不上传控制面**。

---

## 2. 按端精简产物（D15 红线）

源码单仓共享，但**交付物按端精简**（09 §14.2）—— CI 按端产出独立镜像，各镜像只含本端代码：

- `Dockerfile.operation`：只 COPY `server/{operation_service,shared}` + `server/run.py` + `web/operation` 构建产物。
- `Dockerfile.manager`：只 COPY `server/{manager_service,shared}` + `server/run.py` + `web/manager` 构建产物。
- `Dockerfile.agent`：只 COPY Node `server/agent_service` + `web/agent` 构建产物。

**硬隔离线**：用户端交付物（`Dockerfile.agent`）**绝不打包**：
- 控制面后端：`server/operation_service`、`server/manager_service`，以及任何 Python Agent/Gateway 代码
- 控制面前端：`web/operation`、`web/manager`

理由（隐私 + 最小攻击面）：用户端镜像只会被装到最终用户机器上，不得让控制面 UI 或控制面业务代码随之下发。

**禁止运行时胖产物**：不做"一个含三端全部代码的镜像在运行时切端"（09 §14.2）。`server/run.py --tier=...` 只用于控制面 dev 便利；Node Agent 由自身包独立启动。

### 构建产物隔离闸门

用户端镜像由 `Dockerfile.agent` 显式 COPY Node Agent 与 Agent 前端；不复制 Python `server/` 控制面代码，构建即形成产物隔离。

---

## 3. 单机模拟三端（dev / test）

`docker-compose.yml` 单机起三端 + postgres，模拟完整三端拓扑：

```
operation (:8001) ⇄ manager (:8002) ◀── manager_url ── agent (:8003)
                          │
                       postgres (:5433)
```

端口映射对齐 `docs/部署运维/2026-06-15-AI Team-当前单机部署SOP.md` 的 5433 配置。

### 前端访问

各端后端服务自托管对应前端静态资源（08 §12.3 各端自托管）：

- **运营端前端**：http://localhost:8001 （后端 API：`/api/operation/*`）
- **企业端前端**：http://localhost:8002 （后端 API：`/api/manager/*`）
- **用户端前端**：http://localhost:8003 （后端 API：`/api/agent/*`）

前端 SPA 路由（如 `/chat`、`/workspace` 等）会自动 fallback 到 `index.html`，由前端路由处理。API 请求仍走各自的 `/api/<tier>/*` 路径。

### 快速命令

**日常开发（启停服务）**：
```bash
# 推荐使用统一管理脚本（支持 local 和 docker 模式）
./scripts/ctl.sh start --env dev --deploy docker   # 启动三端 + postgres
./scripts/ctl.sh status --env dev                   # 查看服务状态
./scripts/ctl.sh logs --server agent --follow       # 跟随 agent 日志
./scripts/ctl.sh stop --env dev                     # 停止服务
```

**Docker 构建与清理**：
```bash
./deploy/docker/docker-utils.sh build         # 构建三端镜像
./deploy/docker/docker-utils.sh build agent   # 只构建用户端（验证按端精简）
./deploy/docker/docker-utils.sh clean         # 清理容器 + 数据卷（谨慎！）
```

**直接使用 docker compose**（高级用户）：
```bash
docker compose -f deploy/docker/docker-compose.yml up -d --build   # 构建并启动
docker compose -f deploy/docker/docker-compose.yml ps              # 查看状态
docker compose -f deploy/docker/docker-compose.yml logs -f agent   # 查看日志
docker compose -f deploy/docker/docker-compose.yml down            # 停止（保留数据）
```

### 验证按端精简产物（D15 红线）

```bash
cd deploy
./docker-utils.sh build agent   # 构建用户端镜像

# 验证镜像内不含控制面代码：
docker run --rm aiteam-agent:dev sh -c \
  'ls /app/server && echo --- && ls /app/web'

# 预期输出：
#   agent_service
#   ---
#   agent
# 
# ✓ 应只见 agent_service（无 Python operation_service、manager_service、agent_gateway）
# ✓ web 目录应只见 agent（无 operation、manager）
```

---

## 4. 关键环境变量

| 变量 | 用于 | 示例 |
|------|------|------|
| `AITEAM_AGENT_DATA_DIR` | Node Agent 本地数据目录 | `/app/data` |
| `DB_URL` | 业务连接串（受约束 `app_rw` 角色 + RLS） | `postgresql://...` |
| `ADMIN_DB_URL` | 管理连接串（超管/DDL owner，仅供迁移/DDL） | `postgresql://...` |
| `APP_RW_PASSWORD` | 迁移时为 `app_rw` 下发的 LOGIN 口令 | `aiteam_test` |
| `MANAGER_URL` | 用户端 / 运营端访问企业端 | `http://manager:8000` |
| `OPERATOR_URL` | 企业端访问运营端 | `http://operation:8000` |

> 变量名以 `server/shared/config.py` 为准（**不读旧 `app/.env`、不用 `HERMES_WEBUI_*`**）。

---

## 5. 目录约定

```
deploy/
├── docker/
│   ├── Dockerfile.operation   # 运营端产物（只含 operation_service + shared + web/operation）
│   ├── Dockerfile.manager     # 企业端产物（只含 manager_service + shared + web/manager）
│   ├── Dockerfile.agent       # 用户端 Node 产物（只含 agent_service + web/agent）
│   ├── docker-compose.yml     # 单机模拟三端 + postgres
│   ├── docker-utils.sh        # Docker 构建与清理工具（build/clean）
│   └── README.md              # 本文件
└── ci/                         # CI / 自动部署脚本
```

**脚本职责划分**：
- `scripts/ctl.sh` - 日常开发启停（支持 local 和 docker 模式）
- `deploy/docker/docker-utils.sh` - Docker 专用（镜像构建、彻底清理）

后端启动入口：`server/run.py`（统一启动器，09 §14.2）；前端各端独立 `vite build` → `dist`，由本端服务同 origin 自托管。

---

## 6. 历史残留（不沿用）

- 旧 `app/docker-compose*.yml` 是 MVP 单体残留（单体、不分端），**不作为本目录的参考风格**，v1 重建完成后随 `app/` 一并删除。
- 旧 `app/.env` / `HERMES_WEBUI_*` 不读取（CLAUDE §3.7）。
