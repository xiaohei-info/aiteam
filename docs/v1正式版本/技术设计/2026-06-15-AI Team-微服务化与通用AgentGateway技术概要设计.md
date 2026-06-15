---
created: 2026-06-15
updated: 2026-06-15
status: draft-for-review
tags: [project, aiteam, technical-design, overview-design, microservices, gateway, runtime]
canonical_name: 2026-06-15-AI Team-微服务化与通用AgentGateway技术概要设计
supersedes:
  - docs/技术设计/2026-05-26-AI Team-技术概要设计.md
  - docs/技术设计/详细设计文档/2026-06-11-AI Team-Gateway执行链路实现口径与设计差异备案.md
---

# AI Team 微服务化与通用 Agent Gateway 技术概要设计

## 0. 核心判断

【核心判断】
✅ 值得做：现有系统已经完成快速演示阶段任务，但单体后端、原生 router、Team Panel 大一统模块和 Hermes WebUI loopback 执行链路已经成为生产阶段的主要复杂度来源。本次重构应保留业务北向契约，推翻内部历史实现。

【关键洞察】
- 数据结构：配置态、执行态、运营态必须拆开。Manager Service 持有员工与能力配置，Agent Service 持有会话与运行态，Operation Service 持有平台运营对象。
- 复杂度：Agent Gateway 不能按 agent 品牌堆 adapter，也不能假设所有 runtime 都是 JSON stream；应按协议族抽象 Executor，再用 Driver 收口 runtime 差异。
- 风险点：最大破坏性风险不是删除旧内部实现，而是让新服务继续共享旧表、旧 router、旧事件名和旧 adapter，导致“看似重构、实际双系统并存”。

【技术方案】
1. 第一步简化数据与服务边界：按 Operation / Manager / Agent 三服务拆分所有权。
2. 消除 Hermes 特殊情况：Gateway 统一接入 `AcpExecutor`、`JsonRpcStdioExecutor`、`JsonStreamCliExecutor`。
3. 用最清晰的方式实现：Executor 管通用执行机制，Driver 管具体 runtime 差异。
4. 确保零产品破坏性：保留业务北向接口语义与对话页展示能力，但不兼容旧内部包、旧 router 和旧 adapter。

## 1. 需求背景

### 1.1 背景

AI Team 的第一阶段目标是快速完成可演示闭环，现有实现已经覆盖企业前台、企业后台、系统后台、私聊、群聊、Loop、知识库、行业方案和治理后台等主要能力面。该阶段的核心价值是验证产品方向，而不是沉淀长期可维护的生产架构。

随着系统进入正式生产阶段，原有实现中基于单体服务、原生 Python HTTP router、Team Panel 大一统模块、Hermes WebUI loopback 运行链路的方式已经不适合作为长期架构。新的阶段需要把业务控制面、执行控制面、运行时适配层、运营后台和外部能力接入清晰拆开，同时保留已经验证过的业务接口语义与产品闭环。

本次重构的目标不是在旧实现上继续修补，而是重建系统内部结构：

- 后端服务微服务化，拆分 Operation Service、Manager Service、Agent Service。
- Agent Gateway 脱离 Hermes WebUI / Hermes Python SDK 的实现耦合，成为可接入多种 Agent Runtime 的通用执行网关。
- 服务端统一使用现代 Web 框架承载 API、校验、文档、依赖注入和可观测能力。
- 北向业务接口继续作为产品业务契约存在；重构过程不为旧内部实现保留兼容层、别名、双写或历史 adapter。

### 1.2 现状与问题

当前系统主要问题集中在五类：

1. **服务边界不清**
- Team Panel 同时承接企业管理、前台会话、运行态映射、系统后台治理等职责。
- 企业后台、企业前台、系统后台在代码与数据访问上没有形成清晰服务所有权。

2. **路由实现不可持续**
- 大量 API 仍由原生 Python HTTP router 和超大文件承载。
- 请求校验、响应 schema、在线文档和错误模型依赖手工维护。
- 随着业务复杂度上升，继续扩写 router 会使维护成本快速失控。

3. **Gateway 与 Hermes WebUI 耦合**
- 当前执行链路通过 Hermes WebUI loopback 复用 `/api/session/new`、`/api/chat/start`、`/api/chat/stream`。
- 该路径适合 MVP 复用，但不适合作为面向 Codex、Claude Code、OpenCode、Hermes、OpenClaw 等多 runtime 的生产抽象。

4. **运行时抽象不够通用**
- 不同 Agent CLI / Runtime 的协议形态不同：ACP、JSON-RPC over stdio、JSON stream CLI、普通 CLI 等。
- 如果每个 runtime 都实现一套完整执行器，会形成大量重复进程管理、日志采集、超时、取消、事件映射逻辑。

5. **重构不能背负内部历史包袱**
- 业务北向接口是产品契约，应继续保留和优化。
- 旧内部包、旧 router、旧 loopback adapter、旧兼容 alias、迁移期双写不是产品价值，应在新架构中删除。

### 1.3 分析总结

本次概要设计的核心判断是：

**AI Team 应保留已经验证过的业务对象与北向业务接口语义，但推翻旧内部实现形态。**

新的系统不再以 `Team Panel -> Agent Gateway -> Hermes Runtime` 的单一 Hermes 执行链为中心，而是升级为：

```text
Frontend
  -> Operation Service / Manager Service / Agent Service
      -> Agent Gateway
          -> Runtime Executor
              -> Runtime Driver
                  -> Codex / Claude Code / OpenCode / Hermes / OpenClaw / ...
```

其中 Agent Gateway 不再是 Hermes 适配器，而是运行时协议抽象层；Executor 负责协议族通用执行机制，Driver 负责具体 runtime 差异。

---

## 2. 需求分析

### 2.1 要解决什么问题

本次重构需要解决的是：如何在不丢失 AI Team 既有业务闭环的前提下，把当前演示型单体后端升级为可长期演进、可多 runtime 接入、可独立治理、可维护的生产级服务架构。

具体问题包括：

- 企业前台、企业后台、系统后台的服务所有权如何划分。
- Team Panel 现有能力如何拆分到 Manager Service 与 Agent Service。
- Agent Gateway 如何脱离 Hermes WebUI loopback。
- Codex、Claude Code、OpenCode、Hermes、OpenClaw 等 runtime 如何通过统一抽象接入。
- 后端 Web 框架如何选型，如何形成在线文档与 schema 约束。
- 重构时哪些契约保留，哪些历史实现必须删除。

### 2.2 解决方式是什么

采用“**三业务服务 + 通用 Agent Gateway + 协议族 Executor + Runtime Driver + 外部能力域**”的新总体结构。

```text
前端页面群组
  -> Operation Service
  -> Manager Service
  -> Agent Service
        -> Agent Gateway
              -> AcpExecutor
              -> JsonRpcStdioExecutor
              -> JsonStreamCliExecutor
                    -> Runtime Driver
                          -> codex / claude / opencode / hermes / openclaw / ...
        -> External Capability
```

业务主链路按场景分流：

- 系统后台页面调用 Operation Service。
- 企业后台页面调用 Manager Service。
- 企业前台工作台、私聊、群聊、Loop 调用 Agent Service。
- Agent Service 生成运行请求并调用 Agent Gateway。
- Agent Gateway 通过 Executor + Driver 启动或连接具体 runtime。
- Runtime 原始事件统一转换为 Agent Runtime Event，再映射为业务时间线事件返回 Agent Service。

### 2.3 对既有业务接口的处理原则

本次重构区分“业务契约”和“历史实现”：

- **继续保留**：已经验证有效的北向业务接口语义，例如员工、会话、Run、Timeline、Loop、知识库、治理等接口分组。
- **允许重定路径与 schema**：如果正式生产契约需要更清晰的路径、字段和错误模型，可以在新 OpenAPI 中重新定稿。
- **不兼容旧内部实现**：不为旧 router、旧 Python 模块、旧 adapter、旧内部 DTO、旧数据库写法保留兼容层。
- **不做迁移期双写**：新服务拥有自己的表所有权和写路径，旧写路径在切换后删除。

换句话说：**产品业务口径可以延续，工程实现必须清理。**

### 2.4 术语定义

- **Operation Service**：平台运营服务，承接系统后台、平台模板、行业方案、企业账号治理、平台级审计、平台财务与运营统计。
- **Manager Service**：企业管理服务，承接企业后台、组织、成员、员工配置、知识库、技能、连接器、记忆、企业账单治理等管理面能力。
- **Agent Service**：企业前台与任务服务，承接工作台、私聊、群聊、Run、Task、Loop、事件流、运行快照与协作编排。
- **Agent Gateway**：通用运行时接入网关，负责把 Agent Service 的运行请求接入不同 Agent Runtime，并输出统一运行事件。
- **Runtime Executor**：按协议族抽象的执行器，负责进程、stdio、stream、超时、取消、session、日志等通用机制。
- **Runtime Driver**：具体 runtime 的适配器，负责命令参数、握手流程、原始事件解析、session_id 提取、usage 解析和能力声明。
- **Agent Runtime Event**：Gateway 内部统一运行事件，不暴露 runtime 原生事件名。
- **Business Timeline Event**：Agent Service 对前端暴露的业务时间线事件，用于对话页、任务树、工具调用和审计回放。

---

## 3. 设计目标

### 3.1 系统建设目标

本次重构后的 AI Team 应达到以下目标：

1. 后端服务边界清晰，系统后台、企业后台、企业前台职责分离。
2. Team Panel 大一统模块被拆解为 Manager Service 与 Agent Service。
3. Agent Gateway 不依赖 Hermes WebUI，不依赖某一个 runtime SDK。
4. Codex、Claude Code、OpenCode、Hermes、OpenClaw 均可通过统一运行时抽象接入。
5. 对话页面能够展示文本、思考过程、工具调用、bash/file 操作输入输出、错误、usage 和最终结果。
6. 服务 API 具备 schema 校验、OpenAPI 文档、统一错误模型和可测试契约。
7. 新架构不保留内部历史包袱，避免兼容层长期污染生产代码。

### 3.2 设计原则

1. **业务契约稳定，内部实现清理**
- 北向业务语义可继续使用。
- 旧内部实现不作为新架构兼容对象。

2. **服务按业务所有权拆分**
- Operation 管平台运营。
- Manager 管企业配置与治理。
- Agent 管任务、对话、执行与事件。

3. **Gateway 只做运行时接入**
- 不定义企业、员工、权限、账单等业务对象。
- 不漂移成第二套业务后台。

4. **Executor 按协议族复用**
- ACP runtime 走 AcpExecutor。
- JSON-RPC stdio runtime 走 JsonRpcStdioExecutor。
- JSON stream CLI runtime 走 JsonStreamCliExecutor。
- runtime 差异收敛到 Driver。

5. **事件先归一，再产品化**
- Driver 把原始事件转为 Agent Runtime Event。
- Agent Service 再映射成 Business Timeline Event。
- 前端不消费 runtime-native event。

6. **显式删除特殊情况**
- 不保留旧 alias。
- 不保留双写。
- 不把 Hermes 作为默认特例写进上层业务。

### 3.3 功能分层

新系统按六层划分：

1. 前端交互层
2. 业务服务层
3. Agent 执行控制层
4. Runtime Gateway 层
5. Runtime 执行层
6. 外部能力层

### 3.4 功能架构说明

#### 1）前端交互层

承接企业前台、企业后台、系统后台三类页面。前端调用业务服务 API，不直接调用 Agent Gateway，不直接绑定 runtime 原始事件。

#### 2）业务服务层

由 Operation Service、Manager Service、Agent Service 组成。每个服务拥有自己的业务对象、schema、API、权限口径和数据写路径。

#### 3）Agent 执行控制层

位于 Agent Service 内部，负责会话、Run、Task、Loop、编排、运行快照、事件落库和对前端的 SSE/WebSocket 输出。

#### 4）Runtime Gateway 层

负责统一接入 runtime。该层只处理运行请求、runtime capability、执行生命周期、原始事件归一、取消、超时、恢复和 worker 调度。

#### 5）Runtime 执行层

由不同 executor 和 driver 组成。它可以运行本地 CLI、容器 worker、远程 daemon 或未来云端 runtime。

#### 6）外部能力层

承接知识库、向量检索、MCP、技能包、连接器、AI Relay、第三方业务系统等外部能力。

---

## 4. 架构设计

### 4.1 整体系统架构

```text
┌──────────────────────────────────────────────┐
│                  Frontend                    │
│  企业前台 / 企业后台 / 系统后台 / 工作台 / 对话页 │
└───────────────┬───────────────┬──────────────┘
                │               │
      ┌─────────▼──────┐ ┌──────▼────────┐ ┌────────────────┐
      │ Operation       │ │ Manager       │ │ Agent          │
      │ Service         │ │ Service       │ │ Service        │
      └─────────┬──────┘ └──────┬────────┘ └───────┬────────┘
                │               │                  │
                │               │          ┌───────▼────────┐
                │               │          │ Agent Gateway   │
                │               │          └───────┬────────┘
                │               │                  │
                │               │   ┌──────────────▼───────────────┐
                │               │   │ Runtime Executor + Driver     │
                │               │   │ ACP / JSON-RPC / JSON Stream   │
                │               │   └──────────────┬───────────────┘
                │               │                  │
                └───────────────┴──────────────────▼───────────────┐
                                   External Capability              │
                                   Knowledge / MCP / Skills / Relay │
                                   Connectors / Storage / Search    │
                                                                    │
```

### 4.2 服务职责说明

#### 4.2.1 Operation Service

Operation Service 是平台运营服务，对应现有系统后台。

主要职责：
- 平台企业账号管理。
- 平台模板、员工模板、行业方案治理。
- 平台级内容发布、下架、审核。
- 平台财务、充值、配额、成本统计。
- 系统账号、系统角色、平台审计。
- 平台运营看板。

禁止事项：
- 不执行 Agent 任务。
- 不维护企业前台会话。
- 不直接调用 runtime。
- 不修改企业内部运行态。

#### 4.2.2 Manager Service

Manager Service 是企业管理服务，对应现有企业后台。

主要职责：
- 企业、成员、角色、组织结构。
- 员工实例配置、模型配置、Prompt、能力开关。
- 知识库、文档、知识索引、员工知识绑定。
- 技能安装、员工技能绑定。
- 连接器定义、凭据授权、员工可见性控制。
- 记忆管理、人工校正、治理视图。
- 企业账单、用量、审计、设置。

禁止事项：
- 不提交 runtime 执行。
- 不维护 Run/Task 执行状态机。
- 不消费 runtime 原始事件。
- 不把展示态写入业务主状态字段。

#### 4.2.3 Agent Service

Agent Service 是企业前台与任务服务，对应现有企业前台中 agent 任务与执行相关能力。

主要职责：
- 工作台、私聊、群聊、办公室动态。
- Conversation、Message、Run、Task、Loop。
- @提及路由、多员工协作编排。
- 执行前员工快照构建。
- 调用 Agent Gateway。
- 运行事件落库、任务树构建、SSE/WebSocket 推送。
- 运行结果、usage、artifact、错误回流。

禁止事项：
- 不直接修改员工配置主数据。
- 不承担系统后台运营治理。
- 不直接调用具体 runtime CLI。
- 不把 runtime 原始事件暴露给前端。

### 4.3 Team Panel 拆分口径

现有 Team Panel 拆分为两类能力：

1. **Manager Service 归属**
- enterprise
- member / role / organization
- employee config
- prompt config
- knowledge base
- skill binding
- connector grant
- memory governance
- billing settings
- enterprise audit

2. **Agent Service 归属**
- conversation
- conversation message
- team run
- team task
- scheduled job / loop
- run event
- runtime binding
- orchestration
- office runtime view
- event stream

拆分原则：
- 配置态归 Manager。
- 执行态归 Agent。
- 平台治理归 Operation。
- 外部能力接入通过明确 integration client，不跨服务直接写库。

### 4.4 Agent Gateway 总体设计

Agent Gateway 接收 Agent Service 的标准运行请求：

```text
AgentRunRequest
  run_id
  tenant_id / enterprise_id
  conversation_id / task_id / loop_id
  employee_snapshot
  runtime_selection
  input_messages
  attachments
  workspace_policy
  tools / mcp / skills / knowledge refs
  resume_session_id
  timeout / cancellation policy
```

输出统一运行事件：

```text
AgentRuntimeEvent
  event_id
  run_id
  seq
  type
  source
  timestamp
  payload
```

事件类型最小集合：

- `status`
- `text_delta`
- `reasoning_delta`
- `tool_call_started`
- `tool_call_completed`
- `command_started`
- `command_output`
- `file_operation`
- `usage`
- `artifact`
- `error`
- `completed`
- `cancelled`

Agent Gateway 的职责是把不同 runtime 的原始事件归一到上述事件集合，不负责把它们渲染成前端 UI。

### 4.5 Executor 与 Driver 抽象

#### 4.5.1 Executor 分层

Executor 按协议族划分，而不是按 agent 品牌划分。

| Executor | 协议形态 | 适用 runtime |
|---|---|---|
| `AcpExecutor` | ACP / JSON-RPC over stdio | Hermes，以及任何兼容 ACP 的 agent |
| `JsonRpcStdioExecutor` | 自定义 JSON-RPC over stdio | Codex app-server，以及未来类似 runtime |
| `JsonStreamCliExecutor` | JSONL / stream-json stdout | Claude Code、OpenCode、OpenClaw JSON 模式，以及兼容 JSON stream 的 CLI |
| `PlainCliExecutor` | 普通 stdout/stderr，非首批重点 | 只能提供降级能力，不作为生产首选 |

Executor 负责通用机制：

- 进程启动与退出。
- stdin/stdout/stderr 管理。
- 超时、取消、idle watchdog。
- session resume 生命周期。
- 原始日志采集。
- 原始事件读取。
- backpressure 与批量 flush。
- 脱敏前置钩子。

#### 4.5.2 Driver 分层

Driver 负责 runtime 差异：

- CLI 路径与默认参数。
- runtime capability 声明。
- 初始化握手。
- prompt / message / tool / MCP 配置注入方式。
- 原始事件 schema 解析。
- session_id / thread_id 提取。
- usage 提取。
- 错误归类。

首批 driver：

| Driver | Executor |
|---|---|
| `HermesAcpDriver` | `AcpExecutor` |
| `CodexJsonRpcDriver` | `JsonRpcStdioExecutor` |
| `ClaudeCodeJsonStreamDriver` | `JsonStreamCliExecutor` |
| `OpenCodeJsonStreamDriver` | `JsonStreamCliExecutor` |
| `OpenClawJsonStreamDriver` | `JsonStreamCliExecutor` |

该结构避免“每个 runtime 一整套 executor”的重复，也避免把 JSON stream、JSON-RPC、ACP 混成一个模糊抽象。

### 4.6 Runtime Worker 与部署形态

Runtime 执行可以支持三种部署形态：

1. **Local Worker**
- 服务进程所在机器直接运行 runtime CLI。
- 适合开发、单机部署和早期验证。

2. **Daemon Worker**
- 参考 multica 模式，用户或企业机器运行 runtime daemon。
- daemon 上报可用 CLI、版本、模型能力与心跳。
- Agent Gateway 分发任务给 daemon，daemon 回传运行事件。

3. **Cloud Worker**
- 平台托管 runtime worker。
- 适合标准化执行、隔离容器、弹性调度。

首期建议先实现 Local Worker + 清晰 worker 接口，再扩展 Daemon / Cloud Worker。不要一开始把调度系统做复杂。

### 4.7 事件流与对话页展示

对话页需要展示：

- Agent 文本输出。
- 思考过程。
- 工具调用开始与完成。
- bash 命令、file 操作的输入输出。
- 错误与重试。
- usage 与成本。
- 最终结果。

事件流分两层：

1. **AgentRuntimeEvent**
- Gateway 内部事件。
- 面向 runtime 归一。
- 不直接暴露给前端。

2. **Business Timeline Event**
- Agent Service 对前端暴露。
- 面向产品展示和审计回放。
- 可继续沿用 `RunTimelineEvent` 的核心语义，但应在新 OpenAPI 中重新定稿字段与 payload 规范。

映射关系：

```text
runtime raw event
  -> Driver parse
  -> AgentRuntimeEvent
  -> Agent Service event mapper
  -> Business Timeline Event
  -> SSE / WebSocket / history query
```

### 4.8 技术选型

后端服务统一采用 FastAPI。

采用原因：
- 原生支持 OpenAPI。
- 默认提供 Swagger UI / ReDoc。
- Pydantic schema 适合作为 API 边界。
- `APIRouter` 适合按业务模块拆分 router。
- 异步接口、SSE、WebSocket、后台任务生态成熟。
- 对当前 Python 代码资产迁移成本最低。

不建议继续使用原生 Python HTTP router。Flask 可用但需要额外组合 schema、OpenAPI、异步 stream、依赖注入和校验能力，长期维护收益不如 FastAPI。

---

## 5. 数据与接口边界

### 5.1 数据所有权原则

每张核心表只能有一个写服务。

建议所有权：

| 数据域 | 写服务 |
|---|---|
| system_user / system_role / platform_template / industry_solution | Operation Service |
| enterprise / member / employee / knowledge / skill / connector / memory | Manager Service |
| conversation / message / run / task / loop / runtime_binding / run_event | Agent Service |
| runtime_worker / runtime_capability / runtime_session / raw_runtime_event | Agent Gateway 或 Agent Service 按部署裁决 |

跨服务读取通过 API 或事件投影，不跨服务直接写库。

### 5.2 员工快照

Agent Service 发起 run 时，不直接读取运行中会变化的员工配置，而是使用 Manager Service 提供的员工执行快照：

```text
EmployeeExecutionSnapshot
  employee_id
  version
  display_name
  persona
  model_policy
  runtime_policy
  tools
  skills
  knowledge_refs
  connector_refs
  memory_policy
```

这样可以保证一次 run 使用稳定配置，避免执行过程中 Manager Service 配置变更导致上下文漂移。

### 5.3 北向业务 API 原则

北向 API 继续以业务对象组织：

- `/api/operation/*`
- `/api/manager/*`
- `/api/agent/*`

是否保留现有 `/api/team/*` 路径，需要在接口详细设计中裁决。若继续使用，必须作为正式业务命名存在，而不是为了兼容旧 router。

### 5.4 服务间接口原则

服务间接口不复用前端 API。

建议内部接口：

- Manager Service -> Agent Service：员工配置变更事件、员工快照查询。
- Agent Service -> Manager Service：获取员工执行快照、校验员工可用性。
- Agent Service -> Agent Gateway：提交 run、取消 run、查询 runtime capability。
- Agent Gateway -> Agent Service：运行事件回调、终态回调、usage 回调。
- Operation Service -> Manager Service：平台模板发布、行业方案应用包同步。

---

## 6. 复杂度分析

### 6.1 服务拆分复杂度

微服务化会引入部署、网络调用、数据一致性和调试复杂度。为避免过度设计，首期只按业务所有权拆三类业务服务，不继续拆成大量小服务。

### 6.2 Gateway 抽象复杂度

不同 runtime 的协议并不统一：

- Hermes 可走 ACP。
- Codex 是 JSON-RPC over stdio。
- Claude Code 是 stream-json。
- OpenCode 是 JSON stream CLI。
- OpenClaw 根据模式可能是 JSON CLI 或 gateway 模式。

因此 Gateway 不能只有一个“JSON stream executor”，而应采用 executor 协议族 + driver 的二级结构。

### 6.3 事件一致性复杂度

运行事件需要同时满足：

- 实时推送。
- 历史回放。
- 审计追踪。
- 工具调用详情展示。
- usage 归集。

因此事件必须先落为稳定内部结构，再映射到前端 timeline。不能让前端直接解析 runtime 原始 JSON。

### 6.4 配置一致性复杂度

员工配置、知识、技能、连接器可能在 run 执行期间变化。执行前必须固化 EmployeeExecutionSnapshot，run 只引用 snapshot version，避免长任务上下文漂移。

### 6.5 安全与隔离复杂度

Agent CLI 可能执行 bash、文件读写、网络请求、MCP 工具调用。Runtime Worker 必须具备：

- 工作目录隔离。
- 凭据最小注入。
- 环境变量脱敏。
- 工具调用审计。
- 输出脱敏。
- 超时和取消。

---

## 7. 风险与约束

### 7.1 技术风险

1. **拆服务过细导致复杂度反噬**
- 本轮只拆 Operation / Manager / Agent 三个业务服务，Gateway 作为运行时接入层，不继续细拆。

2. **Gateway 抽象过度泛化**
- 只抽象真实存在的协议族：ACP、JSON-RPC stdio、JSON stream CLI。
- 不为假想 runtime 设计复杂插件系统。

3. **Driver 泄漏业务语义**
- Driver 只解析 runtime 事件，不理解企业、员工、账单、权限。

4. **Agent Service 漂移成 Manager**
- Agent Service 只能消费员工快照，不维护员工配置主数据。

5. **Manager Service 漂移成 Runtime**
- Manager Service 只管配置和治理，不提交执行，不处理 runtime 原始事件。

6. **事件原始数据泄漏**
- runtime raw event 可以用于调试归档，但前端与审计查询必须消费脱敏后的产品事件。

### 7.2 工程约束

- 新服务统一使用 FastAPI。
- 不再继续扩写原生 Python HTTP router。
- 不再依赖 Hermes WebUI loopback 作为生产执行链路。
- 不为旧内部模块保留兼容层。
- 不做迁移期双写。
- 北向业务接口是否沿用旧路径，应在新 OpenAPI 中作为正式契约重新确认。
- 详细设计必须补齐服务表所有权、API schema、事件 schema、executor driver contract 和验证矩阵。

---

## 8. 阶段实施建议

### 8.1 Phase 0：架构冻结

目标：
- 冻结三服务边界。
- 冻结 Gateway executor / driver 抽象。
- 冻结事件双层模型。
- 冻结数据所有权。

产物：
- 新技术概要设计定稿。
- 服务边界 ADR。
- Gateway runtime contract 草案。
- 新 OpenAPI 分组草案。

### 8.2 Phase 1：服务骨架与契约

目标：
- 建立 Operation / Manager / Agent 三个 FastAPI 服务骨架。
- 建立统一错误模型、鉴权中间件、request id、OpenAPI。
- 建立 Agent Gateway skeleton 和 fake runtime。

验收：
- 三服务 `/healthz`、`/readyz`、`/docs` 可访问。
- fake runtime 可产生 text / reasoning / tool / usage / completed 事件。
- Agent Service 可把 fake runtime 事件映射为 timeline。

### 8.3 Phase 2：Manager 与 Agent 主链

目标：
- Manager Service 承接员工配置、知识、技能、连接器主对象。
- Agent Service 承接 conversation / run / task / event / loop。
- EmployeeExecutionSnapshot 打通。

验收：
- 私聊主链打通。
- 群聊入口打通。
- Loop 基础任务打通。
- 事件可实时推送和历史回放。

### 8.4 Phase 3：Runtime 接入

目标：
- 实现 AcpExecutor + HermesAcpDriver。
- 实现 JsonRpcStdioExecutor + CodexJsonRpcDriver。
- 实现 JsonStreamCliExecutor + ClaudeCode / OpenCode / OpenClaw driver。

验收：
- 每个 driver 有 golden raw event -> AgentRuntimeEvent 测试。
- 每个 executor 有进程取消、超时、stderr、异常退出测试。
- 对话页能展示工具调用输入输出。

### 8.5 Phase 4：Operation 与治理闭环

目标：
- Operation Service 承接系统后台。
- 平台模板、行业方案、企业治理、财务统计接入新服务。
- usage 与审计从 Agent Service / Gateway 回流。

验收：
- 系统后台可管理平台模板和行业方案。
- 企业后台可查看员工用量和审计。
- 平台运营看板可读。

---

## 9. 非目标

本轮概要设计不包含：

- 完整开放平台插件市场。
- 大规模云调度和多租户容器编排细节。
- 移动端新架构。
- 真实支付、真实短信、真实企业微信等外部 provider 深度联调。
- 对旧内部 router、旧 adapter、旧 DTO 的兼容迁移方案。

---

## 10. 待评审问题

1. 北向路径是否继续沿用 `/api/team/*`，还是在生产版统一调整为 `/api/agent/*`、`/api/manager/*`、`/api/operation/*`。
2. Runtime Worker 首期是否只做 Local Worker，还是同步设计 Daemon Worker。
3. Agent Gateway 事件是否需要同时保留 raw event 调试归档表。
4. EmployeeExecutionSnapshot 是由 Manager Service 主动生成，还是 Agent Service 发起 run 时拉取并固化。
5. Operation Service 与 Manager Service 在行业方案“一键应用”上的同步边界如何裁决。
