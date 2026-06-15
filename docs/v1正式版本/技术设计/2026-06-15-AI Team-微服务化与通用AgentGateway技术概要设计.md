---
created: 2026-06-15
updated: 2026-06-15
status: draft-for-review
tags: [project, aiteam, technical-design, overview-design, microservices, gateway, runtime]
canonical_name: 2026-06-15-AI Team-微服务化与通用AgentGateway技术概要设计
supersedes:
  - docs/mvp版本/技术设计/2026-05-26-AI Team-技术概要设计.md
---

# AI Team 微服务化与通用 Agent Gateway 技术概要设计

> 本文是 AI Team 进入 v1 正式生产阶段的**地基文档**。MVP 阶段的单体实现(单 `server.py` 进程、手写 `_match_prefix` 路由、Team Panel 大一统、Hermes WebUI loopback 执行链)已完成验证使命，本文定型 v1 的微服务架构底座，保留已验证的北向业务契约，推翻内部历史实现。
>
> **本文是概要设计**：定型服务边界、通信方式、数据所有权、认证模型、事件模型、部署形态等**地基级决策**；不下沉到逐接口 schema、逐表 DDL，这些留待详细设计。但凡"彻底定型底层架构"所必需的决策，本文一律给出明确裁决，不留待定。

---

## 0. 核心判断

【核心判断】
✅ 值得做：单体后端、手写 router、Team Panel 大一统模块、Hermes WebUI loopback 执行链路已成为生产阶段的主要复杂度来源。本次按**真·微服务**重建内部结构：业务北向契约延续，内部实现彻底重做。

【关键洞察】
- 数据结构：配置态 / 执行态 / 运营态必须按服务拆开所有权，并落实为**库-per-service**。Manager 持有员工与能力配置，Agent 持有会话与运行态，Operation 持有平台运营对象。
- 复杂度：真微服务的成本不在"拆服务"，而在**服务间通信、数据一致性、认证透传、可观测性**。这四项必须在概要阶段先定死，否则会演变成"看似微服务、实则分布式单体"。
- 运行时抽象：Agent Gateway 不按 agent 品牌堆 adapter，也不假设所有 runtime 都是 JSON stream；按**协议族抽象 Executor**，再用 **Driver** 收口 runtime 差异。
- 风险点：最大破坏性风险不是删旧实现，而是让新服务继续共享旧库、旧 router、旧事件名、旧 adapter，导致双系统并存；以及对**存量 streaming 主链路**做无验证的 big-bang 重写，破坏正在演示的产品。

【技术方案】
1. 第一步简化数据与服务边界：Operation / Manager / Agent 三业务服务，各自独立库与写路径。
2. 在三服务前置**北向接入网关(Edge Gateway)**：统一认证、路由、限流、request-id/trace 注入。
3. 定死服务间通信：同步走内网 HTTP/JSON + 共享 client SDK；异步业务事件走消息总线；运行时事件走专用流式通道 + 事件落库。
4. 消除 Hermes 特殊情况：Agent Gateway 统一接入 `AcpExecutor` / `JsonRpcStdioExecutor` / `JsonStreamCliExecutor`，runtime 差异收敛到 Driver。
5. 确保零产品破坏性：保留业务北向接口语义与对话页能力，但不兼容旧内部包、旧 router、旧 adapter；存量 streaming 主链路用绞杀者模式逐模块切换、逐模块验证 parity。

---

## 1. 需求背景

### 1.1 背景

AI Team 第一阶段目标是快速完成可演示闭环，现有实现已覆盖企业前台、企业后台、系统后台、私聊、群聊、Loop、知识库、行业方案与治理后台。该阶段验证了产品方向，但沉淀的是演示型架构，不是长期可维护的生产架构。

随着系统进入正式生产阶段，原有基于单体服务、手写 Python HTTP router、Team Panel 大一统模块、Hermes WebUI loopback 运行链路的形态已不适合作为长期架构。新阶段需要把业务控制面、执行控制面、运行时适配层、运营后台和外部能力接入清晰拆开，并按真微服务独立部署、独立库、独立伸缩，同时保留已验证的业务接口语义与产品闭环。

### 1.2 现状与问题（实证）

| 问题 | 代码实证 | 影响 |
|---|---|---|
| 路由不可持续 | `api/routes.py` 13456 行、`api/streaming.py` 6388 行、`team_panel/api_team/router_team.py` 6069 行，且由手写 `_match_prefix`(router_team.py:970) 分发 | 校验/schema/文档/错误模型全靠手工维护，继续扩写必然失控 |
| 服务边界不清 | `team_panel/` 同时承载 auth / system_admin / enterprise_admin / team / billing 五类 router | 企业管理、前台会话、运行态映射、平台治理混在一个模块，无清晰所有权 |
| Gateway 与 Hermes 耦合 | 执行链路经 Hermes WebUI loopback 复用 `/api/session/new`、`/api/chat/start`、`/api/chat/stream` | 适合 MVP 复用，不适合面向 Codex/Claude Code/OpenCode/Hermes/OpenClaw 等多 runtime 的生产抽象 |
| 运行时抽象不通用 | 单一 `webui_runtime_adapter` | 不同 runtime 协议形态不同（ACP、JSON-RPC stdio、JSON stream CLI、普通 CLI），每个都自造执行器会大量重复进程/日志/超时/取消/事件映射逻辑 |
| 背负历史包袱 | 旧内部包、旧 router、旧 loopback adapter、旧 alias | 这些不是产品价值，应在新架构中删除 |

### 1.3 分析总结

**AI Team 应保留已验证的业务对象与北向业务接口语义，但推翻旧内部实现形态，并按真微服务重建。**

系统升级为：

```text
Frontend
  -> Edge Gateway(北向接入网关：认证 / 路由 / 限流 / trace)
      -> Operation Service / Manager Service / Agent Service
          -> Agent Gateway(运行时接入网关)
              -> Runtime Executor(协议族)
                  -> Runtime Driver(runtime 差异)
                      -> Codex / Claude Code / OpenCode / Hermes / OpenClaw / ...
```

> **命名消歧（贯穿全文）**：本文有两个"网关"，职责完全不同，不可混淆。
> - **Edge Gateway / 北向接入网关**：前端流量入口，负责认证、路由到业务服务、限流、request-id/trace 注入。
> - **Agent Gateway / 运行时接入网关**：Agent Service 之后的运行时抽象层，负责把运行请求接入不同 Agent Runtime 并输出统一运行事件。

---

## 2. 需求分析

### 2.1 要解决什么问题

在不丢失既有业务闭环的前提下，把演示型单体后端升级为：可独立部署、可独立伸缩、可多 runtime 接入、可独立治理、可长期维护的生产级微服务架构。

具体问题：
- 企业前台 / 企业后台 / 系统后台的服务所有权如何划分。
- Team Panel 现有能力如何拆分到 Manager Service 与 Agent Service。
- 真微服务下，服务间如何通信、如何保证一致性、如何透传认证与 trace。
- 数据如何按库-per-service 拆分，存量表如何归属与迁移。
- Agent Gateway 如何脱离 Hermes WebUI loopback，并以统一抽象接入多 runtime。
- 前端是否随服务拆分，如何组织。
- 后端 Web 框架与基础设施如何选型。
- 重构时哪些契约保留、哪些历史实现必须删除、存量主链路如何安全切换。

### 2.2 解决方式

采用"**北向接入网关 + 三业务服务 + 通用 Agent Gateway + 协议族 Executor + Runtime Driver + 外部能力域**"的总体结构，并配套"库-per-service + 内网同步调用 + 业务事件总线 + 运行时流式通道"的通信与数据底座。

```text
前端页面群组（单一 SPA，按模块分目录）
  -> Edge Gateway（认证/路由/限流/trace）
      -> Operation Service   （系统后台 / 平台运营）
      -> Manager Service      （企业后台 / 配置与治理）
      -> Agent Service        （企业前台 / 会话与执行）
            -> Agent Gateway
                  -> AcpExecutor / JsonRpcStdioExecutor / JsonStreamCliExecutor
                        -> Runtime Driver
                              -> codex / claude / opencode / hermes / openclaw / ...
            -> External Capability（知识 / MCP / Skills / Relay / Connectors）
```

业务主链路按场景分流：
- 系统后台页面 → Operation Service。
- 企业后台页面 → Manager Service。
- 企业前台工作台 / 私聊 / 群聊 / Loop → Agent Service。
- Agent Service 生成运行请求 → Agent Gateway → Executor + Driver 启动/连接具体 runtime。
- runtime 原始事件统一转换为 Agent Runtime Event，再映射为业务时间线事件回流 Agent Service。

### 2.3 对既有业务接口的处理原则

区分"业务契约"与"历史实现"：
- **继续保留**：已验证的北向业务语义（员工、会话、Run、Timeline、Loop、知识库、治理等分组）。
- **允许重定路径与 schema**：生产契约可在新 OpenAPI 中重新定稿更清晰的路径、字段、错误模型。
- **不兼容旧内部实现**：不为旧 router、旧 Python 模块、旧 adapter、旧 DTO、旧写法保留兼容层。
- **不做迁移期双写**：新服务拥有自己的库与写路径，旧写路径切换后删除。但"无兼容层 / 无双写"不等于"无验证切换"——见 §17 迁移与切换策略。

一句话：**产品业务口径延续，工程实现必须清理；清理过程必须可验证。**

### 2.4 术语定义

- **Edge Gateway（北向接入网关）**：前端唯一入口，负责认证校验、按路径路由到业务服务、限流、request-id/trace 注入、统一 CORS/CSP。承担轻量 BFF 职责与**有状态认证面**（登录端点 + `user`/`auth_identity` 身份表 + 签名密钥，见 §9.8），不承载业务对象。
- **Operation Service**：平台运营服务，承接系统后台、平台模板、行业方案、企业账号治理、平台审计、平台财务与运营统计。
- **Manager Service**：企业管理服务，承接企业后台、组织、成员、员工配置、知识库、技能、连接器、记忆、企业账单治理等管理面。
- **Agent Service**：企业前台与任务服务，承接工作台、私聊、群聊、Run、Task、Loop、事件流、运行快照与协作编排。
- **Agent Gateway（运行时接入网关）**：通用运行时接入网关，把运行请求接入不同 Agent Runtime，输出统一运行事件。
- **Runtime Executor**：按协议族抽象的执行器，负责进程、stdio、stream、超时、取消、session、日志等通用机制。
- **Runtime Driver**：具体 runtime 适配器，负责命令参数、握手、原始事件解析、session_id 提取、usage 解析与能力声明。
- **Agent Runtime Event**：Gateway 内部统一运行事件，不暴露 runtime 原生事件名。
- **Business Timeline Event（RunTimelineEvent）**：Agent Service 对前端暴露的业务时间线事件，用于对话页、任务树、工具调用与审计回放；沿用现有 `event: timeline` 协议语义。
- **EmployeeExecutionSnapshot**：执行前固化的员工执行快照，保证一次 run 使用稳定配置。
- **Identity 能力域**：认证、登录、企业入户能力的逻辑统称，**非独立服务**——无状态部分(验签/鉴权/签发)为共享库 `shared/auth`，有状态部分(登录端点+身份表+密钥)折叠进 Edge Gateway；principal 主数据按所有者联邦（系统账号归 Operation、企业成员归 Manager）。

---

## 3. 设计目标与原则

### 3.1 系统建设目标

1. 后端服务边界清晰，系统后台 / 企业后台 / 企业前台职责分离，可独立部署、独立伸缩。
2. Team Panel 大一统模块被拆解为 Manager Service 与 Agent Service。
3. Agent Gateway 不依赖 Hermes WebUI，不依赖任一 runtime SDK。
4. Codex / Claude Code / OpenCode / Hermes / OpenClaw 均可通过统一运行时抽象接入。
5. 对话页能展示文本、思考过程、工具调用、bash/file 操作输入输出、错误、usage 和最终结果。
6. 服务 API 具备 schema 校验、OpenAPI 文档、统一错误模型与可测试契约。
7. 服务间通信、数据一致性、认证透传、可观测性有统一底座，不在每个服务各自发明。
8. 新架构不保留内部历史包袱，避免兼容层长期污染生产代码。

### 3.2 设计原则

1. **业务契约稳定，内部实现清理**：北向业务语义可继续使用，旧内部实现不作为兼容对象。
2. **服务按业务所有权拆分**：Operation 管平台运营，Manager 管企业配置与治理，Agent 管任务/对话/执行/事件。
3. **库-per-service，单写者**：每张核心表只能有一个写服务；跨服务读取走 API 或事件投影，禁止跨库直写。
4. **Gateway 只做运行时接入**：不定义企业、员工、权限、账单等业务对象，不漂移成第二套业务后台。
5. **Executor 按协议族复用，Driver 收口差异**：ACP 走 AcpExecutor，JSON-RPC stdio 走 JsonRpcStdioExecutor，JSON stream CLI 走 JsonStreamCliExecutor。
6. **事件先归一，再产品化**：Driver 把原始事件转为 Agent Runtime Event，Agent Service 再映射为 Business Timeline Event；前端不消费 runtime-native event。
7. **显式删除特殊情况**：不留 alias，不留双写，不把 Hermes 作为默认特例写进上层业务。
8. **底座统一，服务收敛**：认证、错误模型、日志、trace、配置、健康检查由共享基础设施统一，服务内不重复造。

---

## 4. 总体架构

### 4.1 整体系统架构

```text
┌──────────────────────────────────────────────────────────┐
│                        Frontend                           │
│  单一 SPA：企业前台 / 企业后台 / 系统后台 / 工作台 / 对话页    │
│  static/aiteam/pages/{agent, manager, operation, shared}  │
└───────────────────────────┬──────────────────────────────┘
                            │ HTTPS（单一 origin）
                  ┌─────────▼──────────┐
                  │   Edge Gateway      │  认证 / 路由 / 限流 / request-id / trace
                  └───┬─────┬─────┬─────┘
        /api/operation │     │/api/manager   │/api/agent
          ┌────────────▼┐ ┌──▼──────────┐ ┌─▼─────────────┐
          │ Operation    │ │ Manager     │ │ Agent          │
          │ Service      │ │ Service     │ │ Service        │
          │ (DB: oper)   │ │ (DB: mgr)   │ │ (DB: agent)    │
          └──────┬───────┘ └─────┬───────┘ └──────┬─────────┘
                 │   内网同步 HTTP/JSON + 业务事件总线  │
                 └───────────┬───────────────────────┘
                             │（Agent Service 提交 run）
                   ┌─────────▼──────────┐
                   │   Agent Gateway     │  运行时接入 / 事件归一 / 取消超时恢复
                   └─────────┬──────────┘
              ┌──────────────▼───────────────┐
              │ Runtime Executor + Driver     │  ACP / JSON-RPC stdio / JSON stream CLI
              └──────────────┬───────────────┘
                  Local / Daemon / Cloud Worker
                             │
                   Codex / Claude / OpenCode / Hermes / OpenClaw

────────────── 横向：External Capability ──────────────
 Knowledge(LightRAG) / MCP / Skills(SkillHub) / AI Relay / Connectors / Storage / Search

────────────── 横向：基础设施底座 ──────────────
 业务事件总线 / 可观测(日志·trace·metrics) / 配置中心 / Identity
```

### 4.2 服务职责说明

#### 4.2.1 Operation Service（平台运营，对应系统后台）

主要职责：平台企业账号管理；平台模板、员工模板、行业方案治理；平台级内容发布/下架/审核；平台财务、充值、配额、成本统计；系统账号、系统角色、平台审计；平台运营看板。

禁止事项：不执行 Agent 任务；不维护企业前台会话；不直接调用 runtime；不修改企业内部运行态。

#### 4.2.2 Manager Service（企业管理，对应企业后台）

主要职责：企业、成员、角色、组织结构；员工实例配置、模型配置、Prompt、能力开关；知识库、文档、索引、员工知识绑定；技能安装与员工绑定；连接器定义、凭据授权、可见性控制；记忆管理、人工校正、治理视图；企业账单、用量、审计、设置。

禁止事项：不提交 runtime 执行；不维护 Run/Task 执行状态机；不消费 runtime 原始事件；不把展示态写入业务主状态字段。

#### 4.2.3 Agent Service（企业前台与任务，对应企业前台执行能力）

主要职责：工作台、私聊、群聊、办公室动态；Conversation、Message、Run、Task、Loop；@提及路由、多员工协作编排；执行前员工快照构建；调用 Agent Gateway；运行事件落库、任务树构建、SSE/WebSocket 推送；运行结果、usage、artifact、错误回流。

禁止事项：不直接修改员工配置主数据；不承担系统后台运营治理；不直接调用具体 runtime CLI；不把 runtime 原始事件暴露给前端。

#### 4.2.4 Edge Gateway（北向接入网关）

主要职责：作为前端唯一 origin；校验用户会话/令牌并注入内部身份上下文；按路径前缀路由到三业务服务；统一限流、CORS/CSP、request-id 与 trace 注入；聚合三服务的 OpenAPI 为统一在线文档入口。**兼任有状态认证面 owner**：承载登录端点、`user`/`auth_identity` 身份表与签名密钥（见 §9.8），但无状态验签/鉴权由共享库 `shared/auth` 提供，不集中为服务调用。

禁止事项：不承载业务对象与业务规则；不直接访问业务库（自持的窄身份存储除外）；不解析 runtime 事件；不集中管授权（授权留各业务服务）。

> **形态裁决**：Edge Gateway 首期采用**轻量 FastAPI 反向代理/BFF**（统一鉴权中间件 + httpx 转发），不引入重型 API 网关产品；待规模增长再评估 Envoy/Kong。这样兼顾"单一 origin + 统一认证"与"最小复杂度"。

### 4.3 Team Panel 拆分口径

现有 `team_panel/` 解散，按所有权重分：

| 现有载体 | 归属服务 | 能力 |
|---|---|---|
| `router_system_admin.py` | Operation | 平台模板 / 行业方案 / 企业账号治理 / 平台审计 / 财务统计 |
| `router_enterprise_admin.py`、`router_team_settings_billing.py` | Manager | 企业 / 成员 / 角色 / 组织 / 企业账单设置 |
| `router_team.py`（6069 行）中配置态部分 | Manager | employee config / prompt / knowledge / skill binding / connector grant / memory governance |
| `router_team.py` 中执行态部分 | Agent | conversation / message / run / task / loop / run event / orchestration / runtime binding / office view / event stream |
| `router_auth.py`（640 行） | Identity（Edge + 联邦 principal） | login / session / passkeys / oauth / onboarding；principal 主数据按 Operation/Manager 联邦 |

拆分原则：配置态归 Manager，执行态归 Agent，平台治理归 Operation，认证归 Identity 域；外部能力接入通过明确 integration client，不跨服务直接写库。

---

## 5. 服务间通信架构（真微服务地基·新增）

真微服务的成本主要在这一章。三类通信通道各司其职，不混用。

### 5.1 三类通信通道

| 通道 | 用途 | 形态 | 一致性 |
|---|---|---|---|
| **北向同步**（前端→Edge→服务） | 用户请求/响应 | HTTPS / JSON | 强一致（请求内） |
| **内网同步**（服务↔服务） | 即时查询/命令，如取员工快照、提交 run、校验可用性 | 内网 HTTP/JSON + 共享 client SDK | 调用内强一致，跨服务最终一致 |
| **业务事件总线**（异步） | 配置变更广播、usage 结算、审计回流、行业方案应用包同步 | 消息总线（at-least-once） | 最终一致 |
| **运行时流式通道**（Gateway→Agent） | 高频运行事件（text_delta 等） | 专用流式（gRPC stream / 内网 SSE）+ 事件落库 | 实时 + 可回放 |

> **好品味裁决**：高频 `text_delta` 等运行事件**不进**业务事件总线（durable broker 扛不住逐 token 写入，也无必要）。运行事件走专用流式通道直推 Agent Service，同时落 Agent 事件库供回放；只有**业务语义事件**（run 终态、usage 结算、审计、配置变更）才上业务事件总线。

### 5.2 同步调用约定

- **传输**：内网 HTTP/JSON 优先（FastAPI 原生、迁移成本最低、可观测成熟）。仅当性能剖析证明某热点路径必要时，才将其升级为 gRPC，并在详设备案；不预先为假想性能上 gRPC。
- **客户端**：提供 `shared/service_client`，统一 base-url 解析、超时、重试、熔断、trace 透传、错误模型解码。各服务不手写 httpx 调用。
- **超时与重试**：所有同步调用必须设超时；只读调用可幂等重试（带 request-id 去重），写调用默认不自动重试，由调用方依据 `Idempotency-Key` 决定。
- **熔断与降级**：被调服务不可用时，调用方按业务定义降级（如快照拉取失败则 run 拒绝并回明确错误，绝不用陈旧配置硬跑）。

### 5.3 异步事件约定

- **投递语义**：at-least-once；消费者必须幂等（按 `event_id` 去重）。
- **事件信封**：统一 `{ event_id, type, source_service, tenant_id, occurred_at, version, payload }`。
- **典型事件**：
  - Manager → Agent：`employee.config.changed`（触发 Agent 侧只读员工投影刷新/快照失效）。
  - Agent/Gateway → Manager/Operation：`run.usage.settled`、`run.completed`、`audit.event.recorded`。
  - Operation → Manager：`industry_solution.published`、`platform_template.published`（应用包同步）。
- **选型**：消息总线首选 **Redis Streams**（若已在栈内，最低引入成本，支持消费组与回放）或 **NATS JetStream**；高吞吐期再评估 Kafka。本文定 Redis Streams 为默认，详设确认。

### 5.4 服务间接口清单（不复用前端 API）

| 调用方 → 被调方 | 接口语义 | 通道 |
|---|---|---|
| Agent → Manager | 拉取 EmployeeExecutionSnapshot、校验员工可用性 | 内网同步 |
| Manager → Agent | 员工配置变更广播 | 事件总线 |
| Agent → Agent Gateway | 提交 run、取消 run、查询 runtime capability | 内网同步 |
| Agent Gateway → Agent | 运行事件回流、终态回调、usage 回调 | 流式通道 + 事件总线（终态/usage） |
| Operation → Manager | 平台模板发布、行业方案应用包同步 | 事件总线 |
| Edge → 各服务 | 透传带身份上下文的用户请求 | 北向同步 |

### 5.5 服务发现与配置

- 各服务地址通过环境变量/配置中心注入（dev 用 compose service name，prod 用平台 DNS/服务注册）。
- 沿用现有 `app/.env` 统一运行口径：Python 解释器、Hermes Home、Hermes config 等运行入口继续复用 `HERMES_WEBUI_PYTHON`、`HERMES_HOME`、`HERMES_CONFIG_PATH`、`HERMES_WEBUI_AGENT_DIR`，不裸用其他环境作为主路径。

---

## 6. 数据架构（库-per-service·新增/扩展）

### 6.1 数据所有权原则

每张核心表只能有一个写服务。库-per-service：三业务服务各自独立数据库（dev 可同实例不同 database/schema，prod 独立实例）。Gateway 运行态数据归 Agent 库或独立 Gateway 库，按部署裁决。

| 数据域 | 写服务 | 库 |
|---|---|---|
| system_user / system_role / platform_template / industry_solution / platform_finance / platform_audit | Operation | oper |
| enterprise / member / role / org / employee / prompt / knowledge / skill_binding / connector / memory / billing_setting / enterprise_audit | Manager | mgr |
| conversation / message / run / task / loop / runtime_binding / run_event / orchestration | Agent | agent |
| runtime_worker / runtime_capability / runtime_session / raw_runtime_event | Agent Gateway（或 Agent 库） | agent/gw |
| user / auth_identity（provider→user 映射）/ refresh_token / onboarding_state | Edge Gateway（认证面，窄身份存储） | identity |

跨服务读取走 API 组合或事件投影，**禁止跨库直写**。

### 6.2 跨服务读取策略

- **新鲜读**：调用所有者服务 API（API 组合）。
- **热点读**：所有者通过事件总线广播变更，消费者维护**本地只读投影**（CQRS-lite）。典型：Agent Service 维护只读员工投影，由 Manager 的 `employee.config.changed` 驱动刷新，避免对话路径每次跨服务取配置。
- **执行固化读**：见 §6.3 快照。

### 6.3 员工执行快照（EmployeeExecutionSnapshot）

Agent Service 发起 run 时，不直接读运行中可变的员工配置，而是固化执行快照：

```text
EmployeeExecutionSnapshot
  employee_id / version / display_name / persona
  model_policy / runtime_policy
  tools / skills / knowledge_refs / connector_refs / memory_policy
```

**所有权裁决（解原 §10-4）**：快照由 **Agent Service 在提交 run 时从 Manager Service 拉取并冻结**，连同 `snapshot_version` 落 Agent 库；run 全程只引用该快照。理由：快照生命周期与 run 绑定，run 归 Agent 所有；Manager 只需提供"按 employee_id+version 生成快照"的内网接口。这样保证一次 run 配置稳定，避免长任务上下文漂移。

### 6.4 存量数据迁移映射

存量为单库（macmini 测试库已有数据）。库-per-service 是目标态，迁移采用**逻辑归属先行、物理分库随切**：
- 详设须产出"现有表 → 写服务 → 目标库"完整映射表。
- 迁移随服务切换分批进行：某模块切到新服务时，其表归入新服务库，旧写路径删除（不双写）。
- 现有 `team_panel/migrations` 按归属拆分到各服务的 migrations 目录；沿用"迁移在首次 DB 连接时自动应用"的现有机制。

---

## 7. Agent Gateway 通用运行时设计

### 7.1 运行请求与运行事件

Agent Gateway 接收标准运行请求：

```text
AgentRunRequest
  run_id / tenant_id / enterprise_id
  conversation_id / task_id / loop_id
  employee_snapshot / runtime_selection
  input_messages / attachments / workspace_policy
  tools / mcp / skills / knowledge refs
  resume_session_id / timeout / cancellation policy
```

输出统一运行事件：

```text
AgentRuntimeEvent
  event_id / run_id / seq / type / source / timestamp / payload
```

事件类型最小集合：`status` / `text_delta` / `reasoning_delta` / `tool_call_started` / `tool_call_completed` / `command_started` / `command_output` / `file_operation` / `usage` / `artifact` / `error` / `completed` / `cancelled`。

Gateway 职责是把不同 runtime 原始事件归一到该集合，**不负责渲染前端 UI**。

### 7.2 Executor 分层（按协议族）

| Executor | 协议形态 | 适用 runtime |
|---|---|---|
| `AcpExecutor` | ACP / JSON-RPC over stdio | Hermes，及任何兼容 ACP 的 agent |
| `JsonRpcStdioExecutor` | 自定义 JSON-RPC over stdio | Codex app-server，及未来类似 runtime |
| `JsonStreamCliExecutor` | JSONL / stream-json stdout | Claude Code、OpenCode、OpenClaw JSON 模式，及兼容 JSON stream 的 CLI |
| `PlainCliExecutor` | 普通 stdout/stderr（非首批重点） | 仅降级能力，不作生产首选 |

Executor 负责通用机制：进程启动/退出；stdin/stdout/stderr 管理；超时、取消、idle watchdog；session resume 生命周期；原始日志采集；原始事件读取；backpressure 与批量 flush；脱敏前置钩子。

### 7.3 Driver 分层（按 runtime 差异）

Driver 负责：CLI 路径与默认参数；runtime capability 声明；初始化握手；prompt/message/tool/MCP 配置注入方式；原始事件 schema 解析；session_id/thread_id 提取；usage 提取；错误归类。

首批 driver：

| Driver | Executor |
|---|---|
| `HermesAcpDriver` | `AcpExecutor` |
| `CodexJsonRpcDriver` | `JsonRpcStdioExecutor` |
| `ClaudeCodeJsonStreamDriver` | `JsonStreamCliExecutor` |
| `OpenCodeJsonStreamDriver` | `JsonStreamCliExecutor` |
| `OpenClawJsonStreamDriver` | `JsonStreamCliExecutor` |

该结构避免"每个 runtime 一整套 executor"的重复，也避免把 JSON stream / JSON-RPC / ACP 混成一个模糊抽象。

### 7.4 Runtime Worker 与部署形态

1. **Local Worker**：服务进程所在机器直接运行 runtime CLI。适合开发、单机、早期验证。
2. **Daemon Worker**：参考 multica 模式，用户/企业机器运行 runtime daemon，上报可用 CLI、版本、模型能力与心跳；Gateway 分发任务，daemon 回传事件。
3. **Cloud Worker**：平台托管 runtime worker，隔离容器、弹性调度。

**裁决（解原 §10-2）**：首期实现 **Local Worker + 清晰 Worker 接口**，Daemon Worker **接口同步设计、实现后置**，Cloud Worker 列入后续。不一开始把调度系统做复杂。

---

## 8. 事件流与对话页展示

对话页需展示：Agent 文本输出、思考过程、工具调用开始/完成、bash/file 操作输入输出、错误与重试、usage 与成本、最终结果。

事件流分两层：

1. **AgentRuntimeEvent**：Gateway 内部事件，面向 runtime 归一，不直接暴露前端。
2. **Business Timeline Event（RunTimelineEvent）**：Agent Service 对前端暴露，面向产品展示与审计回放，沿用现有 `event: timeline` 协议与 numeric cursor，字段/payload 在新 OpenAPI 重新定稿。

映射链路：

```text
runtime raw event
  -> Driver parse        -> AgentRuntimeEvent
  -> Agent event mapper  -> Business Timeline Event
  -> SSE / WebSocket / history query
```

**Raw event 归档裁决（解原 §10-3）**：**保留** raw runtime event 归档表（`raw_runtime_event`），**脱敏后落库、受控访问、设保留期**，仅供调试与 Driver 回归。前端与审计查询只消费脱敏后的产品事件。理由：多 runtime 调试期，Driver 解析出错时没有原始流就无法定位根因，这是廉价保险。

**状态口径继承**：Conversation 持久化主状态固定枚举 `draft | active | paused | muted | archived`；展示态 `idle | routing | waiting_reply | streaming | busy | resolved | reconnecting` **不写入持久化主状态**。Team Panel/Manager 业务镜像状态与 Runtime 执行状态冲突时，以 Runtime 执行口径为准，业务侧通过事件回流更新镜像，不伪造 Runtime 已完成。

---

## 9. 认证与身份（Identity·新增）

> 现状是技术债：业务多租户 auth（`router_auth.py` + `auth_service.py`）是**纯进程内存 mock**（全局 dict + RLock、`mock_wechat_guest`、硬编码 `ent_001`、手机验证码写死），且与基座单密码门（`api/auth.py` `check_auth`）两套割裂。内存 token 在微服务多进程下无法共享，是迁移的硬阻塞。本章定型一套**最简但可扩展**的认证，全部退役旧 mock。

### 9.1 三个平面（先分清，别混）

| 平面 | 回答 | 谁对谁 | 机制 |
|---|---|---|---|
| ① 用户认证 | "你是哪个人/哪个企业成员" | 人 → 系统 | 登录 → 签发**用户 JWT** |
| ② 用户授权 | "你这角色能不能做这事、能不能碰这租户数据" | 已登录用户 → 资源 | 租户隔离 + 角色 + 资源归属校验 |
| ③ 服务间认证 | "这个内网调用是不是可信服务发来的" | 服务 → 服务 | mTLS / 签名服务令牌，与用户身份无关 |

边界口径：**用户 JWT 管 ①②；服务身份管 ③；用户上下文在 ③ 的通道里透传**（供下游做 ② 与审计），不以用户 JWT 替代服务身份。

### 9.2 核心设计：多样性隔离在一层，token 永远单一路径

登录方式（微信/手机/账密/未来 oauth…）的多样性**只活在 Authenticator 一层**；所有方式收敛到同一个 `user`，再走同一个 token 出口。token 签发与校验**不认识你怎么登的**。

```text
微信 / 手机 / 账密 / ...        ← 多样性只在这层
      │  各自 verify → 外部身份(external_id)
      ▼
   auth_identity 映射表          ← 外部身份 → 内部 user
      │  统一 user_id
      ▼
   issue_token(user_id, ...)     ← 单一出口，与登录方式无关
```

### 9.3 数据结构（关键，token 反而最简单）

```text
user                      # 规范账号(principal)
  id / enterprise_id / display_name / status / roles

auth_identity             # "映射"就是这张表；一个 user 可挂 N 行
  id
  user_id      -> user.id
  provider     ∈ {password, phone, wechat, ...}
  external_id  # password=用户名 / phone=手机号 / wechat=openid|unionid
  secret       # password=hash；其它=null 或 provider 侧引用
  unique(provider, external_id)
```

一个用户多行 auth_identity（微信与账密登进同一账号 = 同 user_id 挂两行）。**新增一种登录方式 = 多一个 provider 取值 + 一个 Authenticator，`user` 与 token 层零改动。**

### 9.4 统一登录流程

```text
登录(provider, credential)
  → Authenticator[provider].verify(credential) → external_id   # 各方式只负责这步
  → 查 auth_identity(provider, external_id) → user_id          # 查不到按策略注册/绑定
  → issue_token(user_id, enterprise_id, roles)                 # 单一出口
  → 返回 token
```

`Authenticator` 是唯一扩展点：`PasswordAuthenticator`（用户名+密码 hash）、`PhoneAuthenticator`（手机号+验证码）、`WechatAuthenticator`（code 换 openid）……新方式实现同一接口、插入注册表，下游流程一行不改。

### 9.5 token 层（先用最简方案）

| 项 | 最简做法 | 演进 |
|---|---|---|
| 签发 | **HMAC 对称签名 JWT**，单一密钥，载荷 `{user_id, enterprise_id, roles, exp}` | 待"服务各自独立验签、不共享密钥"时换非对称，不影响业务结构 |
| 校验 | 共享库 `shared/auth` 本地验签，不查库、不回调签发方 | —— |
| 映射 | token 内只放 `user_id`，登录方式细节留在 `auth_identity` | —— |
| 健全（过期/续期） | 短期 access JWT + 一行 refresh 记录；可先只发较长期 JWT、到期重登 | 后续补完整 refresh 轮换 |

原则：**集中签发 + 分布式无状态校验**。绝不做"每请求回调 Identity 验 token"。

### 9.6 请求流程（公开端点 / 401 vs 403）

```text
登录(无token) → Identity 验凭据(§9.4) → 签发 JWT
后续请求带 Authorization: Bearer <jwt>
Edge Gateway:
  ├─ 公开端点(login / healthz / oauth 回调 / 验证码) → 放行，不要 token
  ├─ 受保护端点：无 token / 验签失败 / 过期 → 401（认证失败，Edge 拒）
  └─ 有效 → 解出身份，以签名内部头透传
业务服务(Operation/Manager/Agent):
  ├─ 共享库本地再验签一次（纵深防御，非对称下近乎零成本）→ 失败 401
  └─ 读 roles/tenant 做授权 → 越权 403（授权失败，服务拒）
```

要点：**不是"所有端点没 token 就拒"**，而是受保护端点拒、一小撮公开端点放行；**401（你没证明你是谁，Edge）与 403（你是谁我知道但没权限，服务）分清**。

### 9.7 角色模型（继承现有枚举）

- 企业侧：`owner | enterprise_admin | finance_admin | member`。
- 平台侧：`system_admin | system_operator`。
- **禁止**使用 `admin/manager/viewer` 等旧角色枚举。

### 9.8 职责归位与形态裁决（不设独立 Identity 服务）

把"认证"拆成**无状态**与**有状态**两块，各归其位——**不新增独立 Identity 微服务**：

| 能力 | 本质 | 归位 |
|---|---|---|
| 验签 + 解身份 | 纯计算 | **共享库 `shared/auth`**，Edge 与各服务直接 import，**不是网络服务、不回调** |
| 鉴权（②） | 纯逻辑 | 共享库提供 helper，**策略留各业务服务**（资源归属/角色只有业务自己懂） |
| 签发 token | 纯计算 | 共享库 helper，仅由认证面 owner 在凭据校验通过后调用 |
| 凭据校验 + 登录端点 + `user`/`auth_identity`/`refresh` 表 + 签名密钥 | **有状态 + 外部集成 + 持密钥** | **折叠进 Edge Gateway**（认证面 owner，唯一写者） |

**为什么不做独立服务**：验签/鉴权天然是库（人人一份、零网络跳、无 SPOF），无需服务化；只有"写身份表 + 承载登录入口 + 持签名密钥"这一小块有状态、需唯一 owner。该 owner 折叠进 **Edge Gateway**——它本就是认证咽喉与单一 origin，且身份跨企业成员(Manager)与系统账号(Operation)、塞进任一业务服务都别扭，Edge 是中立基础设施位。如此拓扑保持"**3 业务服务 + 2 网关**"，不增第 4 服务。

边界与权衡：
- **Edge 拥有一个很窄的 identity 存储，但不碰任何业务对象**（employee/conversation/billing 一概不沾）；身份是接入层基础设施，不是业务域，不违反"Edge 不承载业务对象"。
- **principal 联邦**：企业成员主数据归 Manager、系统账号归 Operation；Edge 认证面通过内网接口查询，不复制业务主数据，仅自持 `user`/`auth_identity` 映射与凭据。
- **密钥权衡**：HMAC 对称下验签方共享同一密钥（key sprawl），MVP 可接受；将来换**非对称**——私钥只留 Edge（签发）、公钥分发各服务（验签），不影响任何业务结构。

---

## 10. 北向 API 与路径收口

### 10.1 路径裁决（解原 §10-1）

采纳生产统一命名，**弃用旧 `/api/team/*`、`/api/system/*`、`/api/enterprise/*`，不留 alias、不做兼容**：

| 新前缀 | 服务 | 取代 |
|---|---|---|
| `/api/operation/*` | Operation | 旧 `/api/system/*` |
| `/api/manager/*` | Manager | 旧 `/api/enterprise/*` + `/api/team/*` 配置态 |
| `/api/agent/*` | Agent | 旧 `/api/team/*` 执行态 |
| `/api/auth/*` | Edge 认证面 | 沿用 `/api/auth/*` 语义，实现重做 |

达成**三处同名对齐**：后端模块 `agent_service` ↔ 前端 `pages/agent/` ↔ 接口 `/api/agent/*`，结构自解释。

### 10.2 API 规范

- 各服务用 FastAPI `APIRouter` 按业务模块拆分，Pydantic schema 作 API 边界，自动产出 OpenAPI / Swagger UI / ReDoc。
- Edge Gateway 聚合三服务 OpenAPI 为统一文档入口。
- 统一错误模型（见 §11.2），统一 numeric cursor 分页，禁止对外暴露 `{timestamp}-{sequence}` 内部游标。

---

## 11. 横切关注点（新增）

### 11.1 可观测性

- **日志**：结构化日志，强制携带 `request_id`、`trace_id`、`tenant_id`、`service`。
- **Trace**：OpenTelemetry 分布式追踪，trace 贯穿 Edge → 服务 → Agent Gateway → Executor/Driver，运行事件携带 `run_id` 关联。
- **Metrics**：各服务暴露 `/metrics`（请求量/延迟/错误率、run 时长、runtime 成功率、usage）。

### 11.2 统一错误模型

- 所有服务返回统一错误结构（problem+json 风格）：`{ code, message, request_id, details? }`。
- Edge 与共享 client SDK 统一解码错误，不让各服务自定义错误形态。

### 11.3 配置与健康检查

- 每服务提供 `/healthz`（存活）、`/readyz`（依赖就绪：DB、事件总线、被依赖服务）、`/docs`。
- 配置经环境变量/配置中心注入，运行入口统一复用 `app/.env` 口径。

### 11.4 安全与隔离

Runtime Worker 必须具备：工作目录隔离；凭据最小注入；环境变量脱敏；工具调用审计；输出脱敏；超时与取消。Agent CLI 可执行 bash/文件/网络/MCP，隔离是硬约束。

---

## 12. 前端架构（新增·明确裁决）

### 12.1 裁决：单一前端代码库，按模块分目录，不拆独立前端工程

**理由（基于实证）**：
1. 现有前端是**单一 SPA 单壳**：`boot.js` / `page-shell.js` / 单 `index.html` / 共享 `api-client.js`、`i18n.js`、`role-state.js`、`timeline-client.js`。拆三个前端工程 = 把外壳、登录、i18n、设计系统、SSE timeline 客户端复制三份，纯亏。
2. pages 已按 `admin-*`(12) / `app-*`(6) / `system-*`(5) 天然分簇，与 manager/agent/operation 1:1。改为子目录即得模块化收益，零架构成本。
3. 用户跨面（企业管理员既配员工也进对话），单 SPA + 角色路由才是对的 UX；三独立 app 会逼用户跨应用跳转/重复登录。
4. 仅当未来服务真独立部署 + 独立团队 + 技术栈分叉时，才值得拆独立前端工程；现在不满足任何一条。

### 12.2 前端目录结构

```text
static/aiteam/pages/
├── agent/      ← app-chat / app-group / app-workbench / app-org / office...
├── manager/    ← admin-employees / admin-knowledge / admin-skills / admin-connectors / admin-billing...
├── operation/  ← system-accounts / system-finance / system-templates / system-solutions...
└── shared/     ← page-shell / api-client / timeline-client / role-state / i18n
```

`api-client.js` 按 `agent / manager / operation` 三段组织，镜像后端 router 与前端目录。前端只调用 Edge Gateway（单一 origin），不直接调用业务服务，不直接绑定 runtime 原始事件。

### 12.3 BFF 边界

Edge Gateway 承担轻量 BFF：认证、路由、聚合文档、必要的响应裁剪。不在 Edge 写业务逻辑；需要跨服务聚合的页面数据，由前端并行调用或由所有者服务提供聚合视图接口，而非在 Edge 拼装业务。

---

## 13. 技术选型

| 关注点 | 选型 | 理由 |
|---|---|---|
| 后端框架 | **FastAPI** | 原生 OpenAPI / Swagger / ReDoc；Pydantic 作 API 边界；APIRouter 按模块拆分；异步 SSE/WebSocket/后台任务成熟；Python 资产迁移成本最低 |
| Edge Gateway | 轻量 FastAPI + httpx 反向代理 | 单一 origin + 统一认证，最小复杂度；规模增长再评估 Envoy/Kong |
| 服务间同步 | 内网 HTTP/JSON + 共享 client SDK | 迁移成本最低、可观测成熟；gRPC 仅按剖析升级热点 |
| 业务事件总线 | Redis Streams（默认）/ NATS JetStream | 轻量、消费组、可回放；高吞吐期再评估 Kafka |
| 数据库 | 库-per-service（PostgreSQL） | 单写者隔离；dev 同实例分库，prod 独立实例 |
| 可观测 | OpenTelemetry + 结构化日志 + Prometheus | trace 贯穿全链路 |
| 运行时 | Executor 协议族 + Driver | 见 §7 |

不再使用手写 Python HTTP router / `_match_prefix` 分发器。

---

## 14. 部署与运行形态（新增）

- **开发（单机）**：docker-compose 起 Edge + 三服务 + Agent Gateway + Postgres + Redis + Local Runtime Worker；沿用 `ctl.sh` 与 macmini 测试环境（pull + `ctl.sh restart` 部署，迁移首次连接自动应用）。
- **生产**：每服务独立容器、独立部署/伸缩；Edge Gateway 前置；业务事件总线、per-service DB、Runtime Worker（Local/Daemon/Cloud）。
- **运行入口统一**：凡涉及 Python 解释器、Hermes CLI、Hermes Home、config，复用 `HERMES_WEBUI_PYTHON`、`HERMES_HOME`、`HERMES_CONFIG_PATH`、`HERMES_WEBUI_AGENT_DIR`。

> 工程目录目标态：
> ```text
> app/
> ├── edge_gateway/      # 北向接入网关
> ├── operation_service/ # 系统后台 / 平台运营
> ├── manager_service/   # 企业后台 / 配置与治理
> ├── agent_service/     # 企业前台 / 会话与执行
> ├── agent_gateway/     # 运行时接入网关（已存在，升级 Executor+Driver）
> ├── shared/            # service_client / 认证中间件 / 错误模型 / 事件信封 / db / schema base
> └── api/               # 基座挂接收缩（server.py 仅做 app 组装）
> ```

---

## 15. 复杂度分析

- **服务拆分复杂度**：仅按业务所有权拆三业务服务 + 两网关，不继续细拆为大量小服务。
- **Gateway 抽象复杂度**：只抽象真实存在的协议族（ACP / JSON-RPC stdio / JSON stream CLI），不为假想 runtime 设计复杂插件系统。
- **服务间一致性复杂度**：同步走内网 HTTP、异步走事件总线、运行事件走流式通道，三通道分明；写操作最终一致 + 幂等，避免分布式事务。
- **事件一致性复杂度**：事件先落稳定内部结构，再映射 timeline；前端不解析 runtime 原始 JSON。
- **配置一致性复杂度**：执行前固化 EmployeeExecutionSnapshot，run 只引用 snapshot version。
- **安全隔离复杂度**：见 §11.4。

---

## 16. 风险与约束

### 16.1 技术风险

1. **拆服务过细反噬** → 只拆三业务服务 + 两网关。
2. **Gateway 抽象过度泛化** → 只抽象真实协议族。
3. **Driver 泄漏业务语义** → Driver 只解析 runtime 事件，不懂企业/员工/账单/权限。
4. **Agent Service 漂移成 Manager** → 只消费员工快照，不维护配置主数据。
5. **Manager Service 漂移成 Runtime** → 只管配置治理，不提交执行、不处理 runtime 原始事件。
6. **事件原始数据泄漏** → raw event 仅调试归档（脱敏受控），前端/审计消费脱敏产品事件。
7. **分布式单体陷阱** → 服务间禁止跨库直写、禁止共享旧库、禁止同步链路串联过长；热点读用本地投影。
8. **存量 streaming 主链路 big-bang 重写破坏演示** → 用绞杀者模式逐模块切换验证（见 §17）。

### 16.2 工程约束

- 新服务统一 FastAPI；不再扩写手写 router。
- 不再依赖 Hermes WebUI loopback 作生产执行链路。
- 不为旧内部模块保留兼容层；不做迁移期双写。
- 北向路径按 §10 统一收口；旧路径切换后删除。
- AI Team 业务逻辑不写进 `./.hermes/hermes-agent/`；必须改 Hermes 时只做最小补丁或可复用增强。
- 详设须补齐：服务表所有权映射、各服务 API schema、事件 schema、executor/driver contract、验证矩阵。

---

## 17. 迁移与切换策略（新增）

"无兼容层 / 无双写"针对**最终态**，切换过程必须可验证。

- **DB 写路径**：一刀切——某模块切到新服务时表归新库、旧写路径删除，不双写。
- **Streaming / Timeline 主链路（高风险）**：用**绞杀者模式逐模块切换**。新 FastAPI 服务起来后按模块灰度切流，每切一个模块先校验北向 `event: timeline` 事件 parity（事件类型、顺序、cursor、payload 关键字段），验证通过再删旧路径。这不是兼容层，是有验证的迁移，符合 CLAUDE.md §10.4「完成前必须独立验证」。
- **存量数据**：按 §6.4 逻辑归属先行、物理分库随切；现有 migrations 按归属拆分到各服务。
- **回退**：每个切换批次保留可回退点（旧路径在 parity 验证期内不立即物理删除，验证期满再删）。

---

## 18. 阶段实施建议

### Phase 0：架构冻结
冻结三服务边界、两网关职责、Gateway executor/driver 抽象、事件双层模型、库-per-service 所有权、服务间通信三通道、认证模型、路径收口。
产物：本概要设计定稿、服务边界 ADR、Gateway runtime contract 草案、新 OpenAPI 分组草案、存量表所有权映射草案。

### Phase 1：底座与骨架
建立 Edge Gateway + Operation/Manager/Agent 三 FastAPI 服务骨架；统一错误模型、认证中间件、request-id/trace、共享 service_client、事件信封、OpenAPI；Agent Gateway skeleton + fake runtime。
验收：Edge + 三服务 `/healthz` `/readyz` `/docs` 可访问；服务间同步调用与事件总线打通；fake runtime 产生 text/reasoning/tool/usage/completed 事件；Agent 把 fake 事件映射为 timeline。

### Phase 2：Manager 与 Agent 主链
Manager 承接员工配置/知识/技能/连接器主对象；Agent 承接 conversation/run/task/event/loop；EmployeeExecutionSnapshot 打通；员工配置变更事件 → Agent 投影刷新。
验收：私聊主链打通、群聊入口打通、Loop 基础任务打通、事件实时推送 + 历史回放、streaming 主链路按绞杀者完成首批模块 parity 验证。

### Phase 3：Runtime 接入
实现 AcpExecutor + HermesAcpDriver；JsonRpcStdioExecutor + CodexJsonRpcDriver；JsonStreamCliExecutor + ClaudeCode/OpenCode/OpenClaw driver。
验收：每个 driver 有 golden raw event → AgentRuntimeEvent 测试；每个 executor 有取消/超时/stderr/异常退出测试；对话页能展示工具调用输入输出。

### Phase 4：Operation 与治理闭环
Operation 承接系统后台；平台模板/行业方案/企业治理/财务统计接入；usage 与审计经事件总线回流。
验收：系统后台可管理模板与行业方案；企业后台可查员工用量与审计；平台运营看板可读。

---

## 19. 非目标

- 完整开放平台插件市场。
- 大规模云调度与多租户容器编排细节。
- 移动端新架构。
- 真实支付 / 短信 / 企业微信等外部 provider 深度联调。
- 对旧内部 router / adapter / DTO 的兼容迁移方案。
- gRPC 全面铺开（仅按热点剖析按需升级）。

---

## 20. 已决裁决与待评审

### 20.1 本文已裁决（地基定型）

| 编号 | 议题 | 裁决 |
|---|---|---|
| D1 | 架构形态 | 真·微服务：三业务服务 + Edge Gateway + Agent Gateway，库-per-service |
| D2 | 北向路径 | 统一 `/api/operation` `/api/manager` `/api/agent`，弃用旧 `/api/team` `/api/system` `/api/enterprise`，不留 alias |
| D3 | 前端 | 单一前端代码库，按 `agent/manager/operation/shared` 分目录，不拆独立前端工程 |
| D4 | 服务间通信 | 同步内网 HTTP/JSON + 共享 SDK；异步业务事件走 Redis Streams；运行事件走流式通道 + 落库 |
| D5 | 员工快照 | Agent 提交 run 时从 Manager 拉取并冻结，落 Agent 库 |
| D6 | Raw event 归档 | 保留，脱敏受控、设保留期，仅调试 |
| D7 | Runtime Worker | 首期 Local Worker，Daemon 接口同步设计、实现后置 |
| D8 | 认证 | 最简可扩展：`user` + `auth_identity`(provider→user 映射) + `Authenticator` 扩展点 + **单一 token 出口**；token 先用 HMAC JWT、refresh 最小化。**不设独立 Identity 服务**：验签/鉴权/签发为共享库 `shared/auth`，有状态认证面(登录端点+身份表+密钥)折叠进 Edge Gateway，授权留各服务；退役全部旧 mock。三平面边界见 §9.1，职责归位见 §9.8 |
| D9 | Edge Gateway 形态 | 轻量 FastAPI 反向代理/BFF，不引入重型网关产品 |
| D10 | 后端框架 | FastAPI，弃用手写 router |

### 20.2 待详设裁决

1. 认证已定：不设独立 Identity 服务（§9.8）。详设细化的是 Edge 认证面内部模块边界、refresh 轮换策略、HMAC→非对称切换时机。
2. 库-per-service 在 prod 是独立实例还是同实例分库的具体边界。
3. 业务事件总线最终选型确认（Redis Streams vs NATS JetStream）与各事件 schema。
4. `runtime_session/raw_runtime_event` 归 Agent 库还是独立 Gateway 库。
5. Operation 与 Manager 在行业方案"一键应用"上的应用包同步事件 schema 与幂等边界。
6. 存量表 → 写服务 → 目标库的完整映射表（详设产出）。
