# AI Team App Host

`app/` 是 AI Team 的主代码目录，承载当前阶段的 **Agent Service 宿主层**。

前定位是：

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
- 维护上游的发布、社区、路线图、主题体系、贡献者文档
- 取代 `hermes-agent/` 成为执行真相层

执行真相层仍然是仓库外部依赖的 `hermes-agent/`。

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
├── start.sh / start.ps1 # 启动脚本
└── Dockerfile / compose # 宿主层容器化运行入口
```

### 2.1 目录职责详述

**api/** - 保留宿主基座能力：HTTP 路由入口、静态资源与 SSE 输出、认证、上传、工作区、终端等通用能力。约束：routes.py 不应继续承载大块 AI Team 业务逻辑，新业务语义优先下沉到 team_panel/ 或 agent_gateway/。

**team_panel/** - AI Team 业务控制面，已形成的子层：
- api_team/：北向业务路由
- application/：命令服务、查询服务、策略
- domain/：领域对象、枚举、值对象
- repositories/：持久化访问
- transactions/：连接与 UoW
- integration/：与 Gateway 的内部接入
- views/：聚合视图与 schema
- migrations/：控制面数据迁移

**agent_gateway/** - AI Team 运行时适配层：RuntimeHandle 创建与更新、单聊/群聊/编排/定时任务等路径的运行时提交适配、事件水合与补拉、凭据解析、Profile 供应、对账与恢复。

**static/** - 浏览器端页面壳与交互脚本，分两部分：原宿主静态能力（通用会话、流式、设置、终端等）和 static/aiteam/（AI Team 页面壳、页面模块、状态辅助与 timeline 客户端）。约束：前端主路径应优先消费 Team Panel 北向接口，不把 Runtime 原始对象直接暴露为主产品语义。

**tests/** - 测试目录当前是混合态：一部分覆盖宿主层保留能力，一部分已明确覆盖 AI Team 分层实现（tests/aiteam/）。后续治理方向：保留对当前仍被 AI Team 使用的宿主能力的回归覆盖，优先增强 tests/aiteam/ 的分层验证。

---

## 3. 模块映射

按照 AI Team 设计文档中的统一口径：

- `app/` = **Agent Service** 的当前物理落地目录
- `team_panel/` = **Team Panel** 业务控制面
- `agent_gateway/` = **Agent Gateway** 运行时适配层
- `hermes-agent/` = **Agent Runtime / Hermes Runtime**（外部独立仓）

---

## 4. 开发原则

1. **AI Team 新能力优先进入 `team_panel/`、`agent_gateway/`、`static/aiteam/`**
2. **`api/routes.py`、`server.py` 等基座文件只做挂接性改造**
3. **不要把产品语义重新写成 WebUI 产品文档**
4. **不要把 AI Team 业务逻辑写进 `hermes-agent/`**

---

## 5. 快速开始

### 5.1 启动服务

```bash
cd aiteam/app
./ctl.sh start
./ctl.sh status
```

默认绑定 `127.0.0.1:8787`。

启动后验什么：

```bash
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/api/system-admin/health
curl -s http://127.0.0.1:8787/api/enterprise-admin/employees
```

### 5.2 运行测试

按层顺序跑：

```bash
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

### 5.3 MVP 验收

当前现实边界：
- **已落地页面**：`/admin/employees`、`/admin/billing/usage`、`/system/health`
- **仍是导航壳**：`/app/workbench`、`/app/chat`、`/app/group`、`/app/office`

验收策略：
- **管理后台类**：走"页面 + API"
- **私聊/群聊/方案应用类**：走"API + 事件 + 日志 + 流程测试"

私聊链路验收步骤：

```bash
# 1. 看员工列表
curl -s http://127.0.0.1:8787/api/team/employees

# 2. 发起 run
curl -s -X POST http://127.0.0.1:8787/api/team/runs \
  -H 'Content-Type: application/json' \
  -d '{"employee_id":"<employee_id>"}'

# 3. 看事件回放
curl -s "http://127.0.0.1:8787/api/team/runs/<run_id>/events?cursor=0"

# 4. 看流式事件
curl -N "http://127.0.0.1:8787/api/team/runs/<run_id>/stream?cursor=0"
```

要记的关键 id：
- `conversation_id`、`employee_id`、`run_id`
- `runtime_handle.kind`、`stream_url`、`events_url`

### 5.4 分层排查

问题分层定位：

| 现象 | 先看哪里 |
|------|----------|
| `./ctl.sh start` 失败 | `./ctl.sh logs --lines 200` |
| `/health` 不通 | `./ctl.sh status`、日志文件 `logs/aiteam.log` |
| 企业后台接口返回 503 | PostgreSQL 连接、表结构 |
| run 已创建但没有事件 | `/api/team/runs/{run_id}/events`、gateway 日志 |
| 事件有了但 UI 不更新 | SSE stream、页面脚本 |

日志查看：

```bash
# 宿主层日志
./ctl.sh logs --follow

# Runtime 日志
curl -s "http://127.0.0.1:8787/api/logs?file=agent&tail=200"
curl -s "http://127.0.0.1:8787/api/logs?file=gateway&tail=200"
```

---

## 6. 设计背景与验证标准

### 6.1 为什么保留部分原宿主代码

当前不采用“推倒重写”的原因：

1. **启动快**：已有宿主能力可直接支撑 MVP 展示版
2. **边界清晰**：AI Team 的新增业务模块已经可以在 team_panel/ 和 agent_gateway/ 内独立演进
3. **风险可控**：只要把产品语义从旧文档与旧治理口径中剥离，就不会被“它看起来像上游产品”继续牵着走

当前策略：**代码层选择性复用**、**文档层去上游产品化**、**业务层按 AI Team 主项目治理**。

### 6.2 收口验证标准

判断 app/ 是否已经从“中间态”向 AI Team 主项目收口：

1. 看到 app/ 文档时，读者首先理解的是 **AI Team 的宿主层职责**，而不是 WebUI 产品介绍
2. 看到目录结构时，读者能清楚区分 team_panel、agent_gateway、hermes-agent 的边界
3. 新增的开发说明、部署说明、联调说明是否落在 AI Team 自有文档，而不是继续补在上游产品文档里
4. CI / 测试 / 文档资产中，是否还保留明显只服务于上游开源项目身份的残留

---

## 7. 文档入口

优先看这些文档：

- `../README.md`：仓库结构与边界
- `../AGENTS.md`：全局约束与开发检查点
- `../docs/技术设计/技术设计.md`：AI Team 正式技术设计导航
- `../docs/技术设计/详细设计文档/2026-05-28-AI Team-共享运行口径定稿版.md`：跨模块契约唯一裁决
- `tests/aiteam/README.md`：测试分层说明

---

## 7. 清理口径

本目录已经按 AI Team 主仓口径开始收口：

- 纯上游开源项目的社区/发布/路线图类文件已移除或不再作为权威文档
- AI Team 自己的实现说明、运行说明与开发检查项留在本目录
- 若后续仍发现明显的上游产品残留文案，应继续按"AI Team 主项目"口径清理