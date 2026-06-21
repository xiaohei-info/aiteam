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
| 用户端 Agent | 每用户本机自部署 | `Dockerfile.agent` | 8003 | `server/agent_service` + `agent_gateway` + `shared` | `web/agent` |

通信面（05 §5.5 窄通信面）：
- Operator ↔ Manager：云侧服务间调用（`MANAGER_URL` / `OPERATOR_URL`）。
- Agent → Manager：用户端主动访问（`MANAGER_URL`）；**Operator/Manager 绝不向用户机器入站**。
- Agent 本地库 + 本地执行：会话/Run/Task/Loop 全在用户本机，**不上传控制面**。

---

## 2. 按端精简产物（D15 红线）

源码单仓共享，但**交付物按端精简**（09 §14.2）—— CI 按端产出**三个独立镜像**，各镜像只含本端代码：

- `Dockerfile.operation`：只 COPY `server/{operation_service,shared}` + `server/run.py` + `web/operation` 构建产物。
- `Dockerfile.manager`：只 COPY `server/{manager_service,shared}` + `server/run.py` + `web/manager` 构建产物。
- `Dockerfile.agent`：只 COPY `server/{agent_service,agent_gateway,shared}` + `server/run.py` + `web/agent` 构建产物。

**硬隔离线**：用户端交付物（`Dockerfile.agent`）**绝不打包**：
- 控制面后端：`server/operation_service`、`server/manager_service`
- 控制面前端：`web/operation`、`web/manager`

理由（隐私 + 最小攻击面）：用户端镜像只会被装到最终用户机器上，不得让控制面 UI 或控制面业务代码随之下发。

**禁止运行时胖产物**：不做"一个含三端全部代码的镜像在运行时 `APP_TIER` 切端"（09 §14.2）。`server/run.py --tier=...` 只用于 dev 便利与按端构建入口选择，不等于把三端代码塞进同一交付物。

### 构建产物隔离闸门

两层互补（`server/tests/integration/test_verification_matrix.py`）：

| 层 | 测试 | 验什么 |
|----|------|--------|
| 源码层 | `test_source_level_tier_isolation` | AST 扫 import 图，钉死跨端 import 不存在（已转正） |
| 产物层 | `test_user_client_build_excludes_control_plane` | 静态解析 `Dockerfile.<tier>` 的 COPY 指令，钉死用户端产物 COPY 不含控制面路径（本次转正） |

---

## 3. 单机模拟三端（dev / test）

`docker-compose.yml` 单机起三端 + postgres，模拟完整三端拓扑：

```
operation (:8001) ⇄ manager (:8002) ◀── manager_url ── agent (:8003)
                          │
                       postgres (:5433)
```

端口映射对齐 `docs/部署运维/2026-06-15-AI Team-当前单机部署SOP.md` 的 5433 配置。

### 快速命令

```bash
cd deploy
./ctl.sh up          # 构建并起三端 + postgres（后台），等待 /healthz
./ctl.sh ps          # 查看容器状态
./ctl.sh check       # curl 三端 /healthz
./ctl.sh logs agent  # 跟随某端日志
./ctl.sh migrate     # 触发 Manager 迁移（manager_service apply_migrations，#60）
./ctl.sh down        # 停并删容器（保留数据卷）
./ctl.sh clean       # down + 删数据卷（清空 DB，谨慎）
```

或直接用 docker compose：

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

### 单独构建某端镜像（验证按端精简）

```bash
./ctl.sh build agent   # 只建用户端镜像
# 验证镜像内不含控制面：
docker run --rm aiteam-agent:dev sh -c \
  'ls /app/server && ls /app/web'
# 应只见 agent_service agent_gateway shared；只见 web/agent。
```

---

## 4. 关键环境变量

| 变量 | 用于 | 示例 |
|------|------|------|
| `APP_TIER` | 统一启动器选择本端（已由 Dockerfile ENTRYPOINT 固定） | `operation` / `manager` / `agent` |
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
├── Dockerfile.operation   # 运营端产物（只含 operation_service + shared + web/operation）
├── Dockerfile.manager     # 企业端产物（只含 manager_service + shared + web/manager）
├── Dockerfile.agent       # 用户端产物（只含 agent_service + agent_gateway + shared + web/agent）
├── docker-compose.yml     # 单机模拟三端 + postgres
├── ctl.sh                 # 启停便利脚本
└── README.md              # 本文件
```

后端启动入口：`server/run.py`（统一启动器，09 §14.2）；前端各端独立 `vite build` → `dist`，由本端服务同 origin 自托管。

---

## 6. 历史残留（不沿用）

- 旧 `app/docker-compose*.yml` 是 MVP 单体残留（单体、不分端），**不作为本目录的参考风格**，v1 重建完成后随 `app/` 一并删除。
- 旧 `app/.env` / `HERMES_WEBUI_*` 不读取（CLAUDE §3.7）。
