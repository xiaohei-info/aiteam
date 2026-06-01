# app/docs

这里放的是 **给开发者直接拿来用的文档**，目标只有三件事：

1. 知道这个 `app/` 现在负责什么、不负责什么
2. 知道怎么把项目跑起来、联调、跑测试
3. 知道怎么做 MVP 验收、看日志、排查问题

如果你要看的是“为什么这么设计”“跨模块契约怎么定稿”，请去仓库根目录的 `docs/技术设计/`。`app/docs/` 不再承担设计过程文档的职责。

## 这个目录先看什么

### 1. 先建立心智模型
先读当前这份 `README.md`。

它回答的是：
- `app/` 在整个 AI Team 里到底是什么角色
- 新代码应该优先落在哪些目录
- 哪些文件只允许做挂接性改造
- 现在有哪些页面/API 已经能用，哪些还只是壳
- 出现问题时应该回到哪类正式设计文档查口径

### 2. 要把项目跑起来、联调、跑测试
看：[`development-workflow.md`](./development-workflow.md)

适合回答：
- 本地启动命令是什么
- `ctl.sh`、`start.sh`、`python server.py` 怎么选
- PostgreSQL 怎么准备
- AI Team 分层测试按什么顺序跑
- Docker 什么时候用，什么时候先别用

### 3. 要做 MVP 功能验收、看日志、排障
看：[`mvp-acceptance.md`](./mvp-acceptance.md)

适合回答：
- 页面从哪里进
- 现在哪些页面是真实页面，哪些只是导航壳
- 私聊 / 群聊 / 方案应用 / 管理后台怎么验
- 每一步要记哪些 id
- 去哪里看 `webui.log`、Runtime 日志和 `/api/logs`

## `app/` 当前是什么

`app/` 不是独立维护的 Hermes WebUI 产品仓。

它现在的角色是：
- AI Team 的 **Agent Service 宿主层**
- Team Panel 的物理落地目录
- Agent Gateway 的物理落地目录
- 浏览器页面壳、HTTP 入口、SSE/日志/会话等复用宿主能力的承载层

对应关系：
- `app/` = Agent Service 当前代码目录
- `app/team_panel/` = Team Panel 业务控制面
- `app/agent_gateway/` = Agent Gateway 运行时适配层
- `hermes-agent/` = Agent Runtime / Hermes Runtime

## 主边界

主链路固定是：

```text
前端页面 → Team Panel 北向 API → Agent Gateway → Hermes Runtime
```

边界要求：
- 前端不能直接绕过 Team Panel 去调用 Runtime
- Team Panel 负责业务对象、权限、审计、治理
- Gateway 负责业务对象到 Runtime 的翻译、事件回流和运行句柄
- Runtime 才是执行真相层

## 新代码应该放哪里

### 优先放这些目录
- `team_panel/`
- `agent_gateway/`
- `static/aiteam/`
- `tests/aiteam/`

### 这些文件只允许做挂接性改造
- `server.py`
- `api/routes.py`
- `api/streaming.py`
- 现有宿主层启动/引导文件

原则：**不要把新业务继续堆回宿主大文件。**

## 当前目录结构怎么理解

```text
app/
├── api/                 # 宿主层 API、保留能力、挂接点
├── agent_gateway/       # AI Team 运行时适配层
├── team_panel/          # AI Team 业务控制面
├── static/              # 浏览器静态资源；static/aiteam/ 为 AI Team 页面壳
├── tests/               # 宿主层与 AI Team 自动化测试
├── docs/                # 开发者使用文档（本目录）
├── server.py            # HTTP 服务入口
├── bootstrap.py         # 启动探测与引导
├── ctl.sh               # 后台守护启动/停机/查状态/看日志
└── start.sh             # 前台启动脚本
```

## 当前有哪些页面入口

以下入口是代码里已经存在的路径：

### AI Team 页面分区入口
- `/app/workbench`
- `/app/chat`
- `/app/group`
- `/app/office`
- `/admin/employees`
- `/admin/connectors`
- `/admin/billing/usage`
- `/system/accounts`
- `/system/health`

### 当前已确认接了真实页面模块的路径
- `/admin/employees`
- `/admin/billing/usage`
- `/system/health`

### 当前仍主要是导航壳/占位区域的路径
- `/app/workbench`
- `/app/chat`
- `/app/group`
- `/app/office`
- `/admin/connectors`
- `/system/accounts`

所以做验收时，不要默认所有 AI Team 页面都已完成；先按“已接真实模块”和“页面壳占位”区分。

## 当前有哪些北向 API 可以直接验

代码里已经明确挂接了三组 namespace：
- `/api/team/*`
- `/api/enterprise-admin/*`
- `/api/system-admin/*`

### 现在最适合先验的接口

#### Team Panel
- `GET /api/team/workbench`
- `GET /api/team/talent-market/templates`
- `POST /api/team/recruitments`
- `GET /api/team/conversations/{id}`
- `POST /api/team/runs`
- `GET /api/team/runs/{run_id}/stream`
- `GET /api/team/runs/{run_id}/events`
- `POST /api/team/uploads`
- `GET /api/team/employees`
- `GET /api/team/employees/{id}`
- `PATCH /api/team/employees/{id}`
- `POST /api/team/group-conversations/{id}/messages`
- `POST /api/team/solutions/{id}/apply`

#### Enterprise Admin
- `GET /api/enterprise-admin/employees`
- `GET /api/enterprise-admin/billing/usage`

#### System Admin
- `GET /api/system-admin/health`

## 当前最有用的测试分层

`tests/aiteam/` 已经按实现层分开：
- `layer0_contracts/`
- `layer1_data/`
- `layer2_team_panel/`
- `layer3_gateway/`
- `layer4_frontend_bff/`
- `layer5_flows/`

如果你要知道某个 API 的最小可用请求体，**优先去看对应测试文件**，它们比口头说明更可靠。

## 顶层设计文档怎么配合看

`app/docs/` 只讲“怎么用”。下面这些顶层文档仍然是正式设计口径，开发时按需回看：

- `../docs/技术设计/技术设计.md`
  - 文档总导航
- `../docs/技术设计/详细设计文档/2026-05-28-AI Team-共享运行口径定稿版.md`
  - 共享契约唯一裁决
- `../docs/技术设计/详细设计文档/2026-05-27-AI Team-Team Panel领域模型与数据架构详细设计.md`
  - 数据模型、状态、表结构
- `../docs/技术设计/详细设计文档/2026-05-28-AI Team-Team Panel内部服务与聚合视图详细设计.md`
  - Team Panel 内部服务与聚合视图
- `../docs/技术设计/详细设计文档/2026-05-27-AI Team-Agent Gateway运行时适配与事件流详细设计.md`
  - Gateway 适配、事件回流、运行句柄
- `../docs/技术设计/详细设计文档/2026-05-27-AI Team-前端页面与接口契约详细设计.md`
  - 页面/API 契约
- `../docs/技术设计/详细设计文档/2026-05-27-AI Team-会话群聊编排Loop核心流程详细设计.md`
  - 私聊、群聊、编排、Loop 主流程

## 历史设计草稿放哪里了

原来 `app/docs/rfcs/` 里的过程性 RFC 已迁到仓库根目录：
- `../docs/design-notes/app-rfcs/`

它们属于设计过程记录，不再和开发者使用文档混放。
