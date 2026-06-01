# AI Team App Host

`app/` 是 AI Team 的主代码目录，承载当前阶段的 **Agent Service 宿主层**。

它不是独立维护的 `Hermes WebUI` 产品仓，也不再按上游开源项目的产品文档口径治理。当前定位是：

- 以既有 Web 宿主能力为代码基座
- 在其上落地 **Team Panel**（业务控制面）
- 在其上落地 **Agent Gateway**（运行时适配层）
- 支撑 AI Team 的私聊、群聊、编排、Loop、治理与审计能力

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
- 维护上游 Hermes WebUI 的发布、社区、路线图、主题体系、贡献者文档
- 取代 `hermes-agent/` 成为执行真相层

执行真相层仍然是仓库外部依赖的 `hermes-agent/`。

## 2. 当前代码结构

```text
app/
├── api/                 # 宿主层 API、挂接点、保留的基础能力
├── agent_gateway/       # AI Team 运行时适配层
├── team_panel/          # AI Team 业务控制面
├── static/              # 浏览器静态资源与 AI Team 页面壳
├── tests/               # 宿主层与 AI Team 自动化测试
├── docs/                # app 子系统局部文档
├── server.py            # HTTP 服务入口
├── bootstrap.py         # 本地启动探测与引导
├── start.sh / start.ps1 # 启动脚本
└── Dockerfile / compose # 宿主层容器化运行入口
```

## 3. 模块映射

按照 AI Team 设计文档中的统一口径：

- `app/` = **Agent Service** 的当前物理落地目录
- `team_panel/` = **Team Panel** 业务控制面
- `agent_gateway/` = **Agent Gateway** 运行时适配层
- `hermes-agent/` = **Agent Runtime / Hermes Runtime**（外部独立仓）

## 4. 开发原则

1. **AI Team 新能力优先进入 `team_panel/`、`agent_gateway/`、`static/aiteam/`**
2. **`api/routes.py`、`server.py` 等基座文件只做挂接性改造**
3. **不要把产品语义重新写成 Hermes WebUI 产品文档**
4. **不要把 AI Team 业务逻辑写进 `hermes-agent/`**

## 5. 当前保留的宿主能力

以下内容虽然来自初始基座，但当前仍然服务 AI Team，所以保留：

- 启动与引导脚本
- 浏览器静态壳与 SSE/流式能力
- 认证、上传、工作区、终端等通用宿主能力
- Dockerfile / compose 等运行封装
- 现有自动化测试中仍覆盖宿主行为的部分

保留它们的理由是 **复用宿主能力**，不是继续维护一个独立的 Hermes WebUI 产品身份。

## 6. 文档入口

优先看这些文档：

- `../README.md`：仓库结构与边界
- `../docs/技术设计/技术设计.md`：AI Team 正式技术设计导航
- `ARCHITECTURE.md`：`app/` 当前代码结构与模块边界
- `docs/README.md`：`app/docs/` 开发者文档总入口与 `app/` 角色说明
- `docs/development-workflow.md`：本地启动、PostgreSQL、pytest 分层联调
- `docs/mvp-acceptance.md`：页面/API 验收、日志查看、问题定位

## 7. 清理口径

本目录已经按 AI Team 主仓口径开始收口：

- 纯上游开源项目的社区/发布/路线图类文件已移除或不再作为权威文档
- AI Team 自己的实现说明、运行说明与开发检查项留在本目录
- 若后续仍发现明显的上游产品残留文案，应继续按“AI Team 主项目”口径清理，而不是继续叠加补丁式说明
