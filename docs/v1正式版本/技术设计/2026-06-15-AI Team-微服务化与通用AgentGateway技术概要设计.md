---
created: 2026-06-15
updated: 2026-06-18
status: draft-for-review
tags: [project, aiteam, technical-design, overview-design, microservices, gateway, runtime]
canonical_name: 2026-06-15-AI Team-微服务化与通用AgentGateway技术概要设计
supersedes:
  - docs/mvp版本/技术设计/2026-05-26-AI Team-技术概要设计.md
---

# AI Team 微服务化与通用 Agent Gateway 技术概要设计

> 本文是 AI Team 进入 v1 正式生产阶段的**地基文档**。MVP 阶段的单体实现(单 `server.py` 进程、手写 `_match_prefix` 路由、Team Panel 大一统、Hermes WebUI loopback 执行链)已完成验证使命，本文定型 v1 的微服务架构底座，保留已验证的北向业务契约，推翻内部历史实现。
>
> **产品形态定性**：v1 是**云侧双控制面 + 用户本地数据面**的多 Agent 数字员工平台——运营端 Operator（平台运营 SaaS，企业开通、平台目录、跨企业治理）、企业端 Manager（平台托管的**多租户企业管理 SaaS**，企业账号、成员认证、配置授权、企业级 RAG 与治理）、用户端 Agent（每用户本机自部署，会话与执行全本地、内容不上传）。Operator 与 Manager 处在云侧控制面，可做受控服务间调用；Agent 只主动访问 Manager，用户机器无入站连接。
>
> **本文是概要设计**：定型服务边界、通信方式、数据所有权、认证模型、事件模型、部署形态等**地基级决策**；不下沉到逐接口 schema、逐表 DDL，这些留待详细设计。但凡"彻底定型底层架构"所必需的决策，本文一律给出明确裁决，不留待定。

---

## 0. 核心判断

【核心判断】
✅ 值得做：单体后端、手写 router、Team Panel 大一统模块、Hermes WebUI loopback 执行链路已成为生产阶段的主要复杂度来源。本次同时完成两件事：① 按**真·微服务**重建内部结构（业务北向契约延续，内部实现彻底重做）；② 把系统重构为**Operator 平台运营 SaaS + Manager 多租户企业管理 SaaS + Agent 用户本地数据面**。Manager 不再是每企业自部署的一套服务，而是一套云服务同时服务 N 家企业；每家企业在 Manager 上是独立租户，拥有独立的企业数据空间、RAG workspace、成员认证与授权边界。

> **形态变更说明（再次修订 Manager 形态）**：本文早期版本曾把 Manager 定义为"企业自部署"。现按业务模型修订为**平台托管的多租户企业管理云服务**：Operator 负责平台运营与目录真相，Manager 负责多企业租户的企业管理面与企业级 RAG，Agent 负责用户本地会话与执行。服务名延续（Operation/Manager/Agent Service），但 Manager 的部署、数据隔离、认证与 Operator/Agent 交互均按多租户 SaaS 重写。

【关键洞察】
- 部署形态：这是一套 **控制面 SaaS + 本地数据面**产品。Operator 与 Manager 是云侧控制面；Manager 是多租户企业管理 SaaS；Agent 是每用户本机数据面。**会话内容、运行事件、runtime raw event 绝不上传 Manager/Operator**，跨云侧只流转企业开通、目录、配置、授权与脱敏计量/审计摘要。
- 数据结构：`tenant` / `enterprise_account` 必须是一等对象。Manager 的企业数据不只是业务表加字段，而是统一走 `TenantContext -> TenantDataSession -> TenantRagClient`，DB、RAG、对象存储、缓存、队列、审计日志全部绑定 `tenant_id`。
- 多租户隔离：PostgreSQL 默认采用共享表 + `tenant_id` + RLS + 复合唯一键，保留 schema-per-tenant / db-per-tenant 的 TenantRouter 演进能力；LightRAG 采用 `workspace = tenant_id + knowledge_space_id` 隔离，由 ManagerRagService 封装，禁止前端/Agent 直接传 workspace。
- 跨端通信：Operator ↔ Manager 是云侧服务间调用（企业开通、负责人同步、目录发布、招募/方案详情、企业级汇总）；Agent → Manager 是用户端主动访问（登录、拉授权配置/快照、上报脱敏摘要）。用户机器无入站连接，不存在中心 Edge 收口。
- 运行时抽象：Agent Gateway 与本地 runtime 都在**用户端**，不按 agent 品牌堆 adapter、也不假设所有 runtime 都是 JSON stream；按**协议族抽象 Executor**，再用 **Driver** 收口 runtime 差异。
- 风险点：最大破坏性风险不是删旧实现，而是①让新端继续共享旧库、旧 router、旧事件名、旧 adapter 或桥接旧端点导致双系统并存；②对 **streaming 主链路**做无验证的 big-bang 重写（应逐模块对照冻结契约基线验证）；③误把会话/usage 数据上传破坏"本地优先"隐私承诺。

【技术方案】
1. 第一步定死三端边界：Operation 管平台运营真相，Manager 管多租户企业管理真相，Agent 管用户本地会话与运行态。
2. 第二步先做 Manager 多租户底座：`tenant` 注册、租户路由、DB RLS/schema/db 隔离、LightRAG workspace 隔离、对象/缓存/审计隔离，所有业务能力必须经该底座访问数据。
3. 定死跨服务通信：Operator↔Manager 只流转企业、目录、模板包、租户级治理汇总；Agent→Manager 只流转认证、授权配置、执行快照和脱敏摘要；运行事件与会话内容只在 Agent 本地。
4. 消除 Hermes 特殊情况：用户端 Agent Gateway 统一接入 `AcpExecutor` / `JsonRpcStdioExecutor` / `JsonStreamCliExecutor`，runtime 差异收敛到 Driver。
5. 确保零产品破坏性：保留业务北向接口语义与对话页能力，但不兼容旧内部包、旧 router、旧 adapter；streaming 主链路**全新重建**，逐模块对照冻结契约基线验证 parity（不与旧系统并跑、不切流、不桥接旧端点）。

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

**AI Team 应保留已验证的业务对象与北向业务接口语义，但推翻旧内部实现形态，按真微服务重建，并落定为「Operator 平台运营 SaaS + Manager 多租户企业管理 SaaS + Agent 用户本地数据面」产品形态。**

系统升级为云侧双控制面与用户本地数据面：

```text
+----------------------- Cloud Control Plane -----------------------+
| Operator System                     Manager System                |
| Operation Service                   Manager Service               |
| 平台运营/目录/跨企业治理              多租户企业管理/授权/RAG/治理     |
| oper_db                             manager_control_db            |
|                                     tenant data space + RAG        |
+------------------------+--------------------+----------------------+
                         |                    ^
                         |                    |
     企业开通/负责人同步/目录发布              | 招募详情/方案包/企业级汇总
                         v                    |
+------------------------+--------------------+----------------------+
| Agent System（用户本机）                                          |
| Agent Service -> Agent Gateway -> Runtime                         |
| agent local_db + local RAG/cache                                  |
| 会话 / 群聊 / run / task / loop 全本地，内容不上传                 |
+-------------------------------------------------------------------+
```

云侧 Operator 与 Manager 可通过服务身份做受控双向服务调用；用户端 Agent 只主动访问 Manager，用户机器无入站连接。会话/执行内容只在 Agent 本地，Manager/Operator 只接收脱敏计量与审计摘要。

> **命名消歧（贯穿全文）**：
> - **三个"系统"**：Operator（平台运营云）/ Manager（多租户企业管理云）/ Agent（用户本机）。Operator 与 Manager 属于云侧控制面；Agent 属于本地数据面。
> - **服务名沿用**：Operation Service / Manager Service / Agent Service —— 名字不变，但部署边界从"共址"改为"分端独立部署"。
> - **Agent Gateway / 运行时接入网关**：位于**用户端内部**，负责把运行请求接入不同本地 Agent Runtime 并输出统一运行事件。**不再有中心化的 Edge Gateway**——认证与入口下沉为各端自带的 `shared/auth` 中间件（见 §9）。

---

## 2. 需求分析

### 2.1 要解决什么问题

在不丢失既有业务闭环的前提下，把演示型单体后端升级为：三端可独立部署、可独立伸缩、可多 runtime 接入、可独立治理、可长期维护，且满足"会话本地化、不上传"隐私承诺的生产级架构。

具体问题：
- Operator / Manager / Agent 三个系统的部署边界与服务所有权如何划分。
- Manager 作为多租户企业管理 SaaS，如何隔离 N 家企业的 DB 数据、RAG workspace、对象存储、缓存、审计与服务调用上下文。
- Team Panel 现有能力如何拆分到 Manager（企业端配置）与 Agent（用户端执行）。
- 三端跨网络如何通信，云侧 Operator↔Manager 如何服务间协作，用户端 Agent→Manager 如何保持无入站、本地优先。
- **多租户认证**如何成立：Operator 创建企业和负责人 → Manager 同步 tenant + owner bootstrap → 企业负责人登录 Manager → Manager 创建成员 → Agent 用户首次在线登录 Manager 后本地缓存 token。
- **配置下发与成员级授权**如何成立：企业端招募专家/配方案时指定授权给哪些成员账号，用户端如何主动 pull 装载。
- 数据如何按系统所有权拆分，Manager 租户数据如何隔离，会话/run/raw event 如何留在 Agent 本地，治理摘要如何逐级汇总。
- Agent Gateway 如何在用户端脱离 Hermes WebUI loopback，并以统一抽象接入多 runtime。
- 三端前端如何分离与组织。
- 后端 Web 框架与基础设施如何选型。
- 重构时哪些契约保留、哪些历史实现必须删除、主链路如何全新重建并对照契约基线验证。

### 2.2 解决方式

采用"**Operator 平台运营 SaaS + Manager 多租户企业管理 SaaS + Agent 用户本地数据面 + 用户端通用 Agent Gateway + 协议族 Executor + Runtime Driver + 外部能力域**"的总体结构，并配套"系统所有权分库 + Manager 租户隔离底座 + 云侧服务间调用 + Agent 主动访问 Manager + 用户端内运行时流式通道 + 治理摘要逐级上报"的通信与数据底座。

```text
运营端 Operator（平台运营 SaaS）
  运营端前端 -> Operation Service（企业开通 / 人才市场·行业方案目录 / 平台治理与跨企业汇总）
                    ↕
                    │ 云侧服务间调用：企业开通/负责人同步/目录发布/模板包/跨企业汇总
企业端 Manager（多租户企业管理 SaaS）
  企业端前端 -> Manager Service（tenant context / 成员账号与认证 / 专家·方案配置 / 成员级授权 / 企业 RAG / 企业治理汇总）
                    ▲
                    │ Agent 主动访问：成员登录认证；拉取已授权专家·方案；上报脱敏计量·审计摘要
用户端 Agent（每用户本机自部署）
  用户端前端 -> Agent Service（会话 / 群聊 / run / task / loop —— 全本地）
                  -> Agent Gateway
                        -> AcpExecutor / JsonRpcStdioExecutor / JsonStreamCliExecutor
                              -> Runtime Driver
                                    -> codex / claude / opencode / hermes / openclaw / ...
                  -> External Capability（知识 / MCP / Skills / Relay / Connectors，本地接入）
```

业务主链路按端分流：
- 运营端页面 → Operation Service（企业开通、人才市场/行业方案目录治理、跨企业治理看板）。
- 企业端页面 → Manager Service（企业负责人/管理员登录后只进入本租户数据空间，管理部门、成员、招募专家、应用方案、成员级授权、企业 RAG、企业治理）。
- 用户端工作台 / 私聊 / 群聊 / Loop → 本地 Agent Service（全部本地执行，内容不上传）。
- 用户端 Agent Service 生成运行请求 → 本地 Agent Gateway → Executor + Driver 启动/连接本地 runtime。
- runtime 原始事件统一转换为 Agent Runtime Event，再映射为业务时间线事件回流本地对话页。
- 跨系统只发生：Operator↔Manager 云侧服务间调用（企业开通/目录/模板包/租户级汇总）、Agent→Manager 主动访问（认证 + 拉授权配置 + 上报摘要）。

### 2.3 对既有业务接口的处理原则

区分"业务契约"与"历史实现"：
- **继续保留**：已验证的北向业务语义（员工、会话、Run、Timeline、Loop、知识库、治理等分组）。
- **允许重定路径与 schema**：生产契约可在新 OpenAPI 中重新定稿更清晰的路径、字段、错误模型。
- **不兼容旧内部实现**：不为旧 router、旧 Python 模块、旧 adapter、旧 DTO、旧写法保留兼容层。
- **全新重建，不与旧系统交互**：新服务拥有自己的库与写路径，**全新建库、不迁移旧数据、不与旧系统双写、不桥接/反代旧 `app/` 端点**。但"全新重建"不等于"无验证"——见 §17 重建与验证策略。

一句话：**产品业务口径延续，工程实现全新重建；重建结果必须对照契约基线独立验证。**

### 2.4 术语定义

- **运营端 Operator / 企业端 Manager / 用户端 Agent**：三个系统边界。Operator 是平台运营 SaaS；Manager 是平台托管的**多租户企业管理 SaaS**；Agent 是每用户本机部署的数据面。三者在源码上按 `server/operation_service` / `server/manager_service` / `server/agent_service` 分离，交付上 Operator 与 Manager 为云侧服务，Agent 为用户端本地交付物。
- **Operation Service（运营端）**：平台运营服务，承接**企业注册/开通**、企业负责人初始凭据签发与重置（不保留密码）、人才市场/平台模板/行业方案目录治理、平台级内容发布/下架/审核、企业账号治理、平台审计、**跨企业计量/财务/运营统计汇总**。
- **Manager Service（企业端）**：多租户企业管理服务，承接企业后台、租户数据隔离、组织、成员账号与**成员认证**、员工/专家配置、知识库/RAG workspace、技能、连接器、记忆策略、**招募专家与配置行业方案 + 部门/成员级授权映射**、企业账单治理、企业级计量/审计汇总。**不持有任何会话与运行态。**
- **Agent Service（用户端）**：用户端前台与任务服务，承接工作台、私聊、群聊、办公室动态、Conversation、Message、Run、Task、Loop、事件流、运行快照与协作编排，**全部在用户本机本地执行与落库，不上传内容**；主动访问 Manager 拉取已授权专家/方案并本地装载。
- **Agent Gateway（运行时接入网关）**：位于**用户端内部**的通用运行时接入网关，把运行请求接入不同本地 Agent Runtime，输出统一运行事件。
- **Runtime Executor**：按协议族抽象的执行器，负责进程、stdio、stream、超时、取消、session、日志等通用机制。
- **Runtime Driver**：具体 runtime 适配器，负责命令参数、握手、原始事件解析、session_id 提取、usage 解析与能力声明。
- **Agent Runtime Event**：Gateway 内部统一运行事件，不暴露 runtime 原生事件名。
- **Business Timeline Event（RunTimelineEvent）**：用户端 Agent Service 对本地前端暴露的业务时间线事件，用于对话页、任务树、工具调用与审计回放；沿用现有 `event: timeline` 协议语义。
- **EmployeeExecutionSnapshot**：执行前固化的员工/专家执行快照，由用户端在装载已授权专家时从 Manager 拉取配置并冻结，保证一次 run 使用稳定配置。
- **多租户认证（Tenant-scoped Auth）**：Operator 创建企业和负责人 bootstrap 凭据，Manager 接收并落到对应 tenant，后续企业负责人/成员凭据与 token 签发均由 Manager 按 tenant 持有；Agent 只持本会话 token 与本地缓存。无状态验签/签发为共享库 `shared/auth`，各端自带入口中间件，**无中心 Edge Gateway**（见 §9）。
- **成员级授权（Member-scoped Grant）**：企业端招募专家/配置行业方案时，可指定该专家/方案授权给哪些成员账号；用户端 pull 时只能取到授权给本账号的条目。
- **员工 / 专家 / 模板 / 实例（术语统一，全文一致）**：「员工」与「专家」在本文指**同一概念**——一个可对话、可执行任务的数字员工（Agent）。运营端人才市场存放的是**专家/员工模板**（定义、persona、推荐配置）；企业端从模板**招募**后得到**员工/专家实例**（数据表 `employee`，带企业侧配置与成员级授权）；用户端 pull 已授权实例并本地装载执行。下文出现的「专家」「员工」「员工/专家实例」均指此实例，**不再区分**；模板仅指运营端目录条目。

---

## 3. 设计目标与原则

### 3.1 系统建设目标

1. 三端边界清晰，Operator 平台运营云 / Manager 多租户企业管理云 / Agent 用户本地数据面职责分离，可独立构建、独立发布、独立伸缩。
2. Team Panel 大一统模块被拆解为企业端 Manager Service（配置与授权）与用户端 Agent Service（本地会话与执行）。
3. **本地优先与隐私承诺**：会话/群聊/run、usage 原始事件与明细全部在用户本机执行与落库，内容不上传；跨端只上报脱敏后的计量/审计聚合摘要。
4. **Manager 多租户隔离成立**：企业账号、负责人、成员、部门、专家实例、方案实例、知识/RAG、授权、用量与审计全部在 tenant 边界内隔离；任何查询、检索、缓存、对象存储与审计都不得跨 tenant。
5. **跨端认证成立**：Operator 创建企业与负责人 bootstrap；Manager 接收 tenant 与负责人信息后成为企业负责人/成员身份源；Agent 首次在线访问 Manager 登录，后续本地验签与本地投影继续工作。
6. **配置下发与成员级授权成立**：Manager 在租户内招募专家/配方案并指定部门/成员授权，Agent 主动拉取本成员可见条目并装载到本地。
7. Agent Gateway 不依赖 Hermes WebUI，不依赖任一 runtime SDK；Codex / Claude Code / OpenCode / Hermes / OpenClaw 均可通过统一运行时抽象在用户端本地接入。
8. 对话页能展示文本、思考过程、工具调用、bash/file 操作输入输出、错误、usage 和最终结果。
9. 各端服务 API 具备 schema 校验、OpenAPI 文档、统一错误模型与可测试契约。
10. 端内通信、数据一致性、认证、可观测性有统一底座（共享库），不在每端各自发明。
11. 新架构不保留内部历史包袱，避免兼容层长期污染生产代码。

### 3.2 设计原则

1. **业务契约稳定，内部实现清理**：北向业务语义可继续使用，旧内部实现不作为兼容对象。
2. **按系统拆分业务所有权**：Operation 管平台运营与目录真相，Manager 管多租户企业配置/授权/成员认证/RAG 管理面，Agent 管本地任务/对话/执行/事件。
3. **系统所有权分库，Manager 租户隔离**：每张核心表只有一个写端；Manager 内部所有租户数据必须经 TenantContext 访问，禁止绕过租户底座直连 DB/RAG。
4. **本地优先、内容不出端**：用户端会话/执行内容不离开本机；跨端只流转认证、授权配置、脱敏计量/审计摘要。
5. **通信面尽量窄**：Operator↔Manager 只做云侧控制面服务调用；Agent→Manager 只做用户端主动访问；用户机器无入站连接，不做跨端实时编排。
6. **Gateway 只做运行时接入**：不定义企业、员工、权限、账单等业务对象，不漂移成第二套业务后台。
7. **Executor 按协议族复用，Driver 收口差异**：ACP 走 AcpExecutor，JSON-RPC stdio 走 JsonRpcStdioExecutor，JSON stream CLI 走 JsonStreamCliExecutor。
8. **事件先归一，再产品化**：Driver 把原始事件转为 Agent Runtime Event，用户端再映射为 Business Timeline Event；前端不消费 runtime-native event。
9. **显式删除特殊情况**：不留 alias，不留双写，不把 Hermes 作为默认特例写进上层业务。
10. **底座统一，端内收敛**：认证、错误模型、日志、trace、配置、健康检查由共享库统一，各端不重复造。

---

## 4. 总体架构

### 4.1 整体系统架构

```text
╔════════════════════════════════════ Cloud Control Plane ════════════════════════════════════╗
║                                                                                            ║
║  ┌──────────────────────────── Operator System / Operation Service ─────────────────────┐   ║
║  │ web/operation                                                                         │   ║
║  │ /api/operation/* /api/auth/*                                                          │   ║
║  │                                                                                        │   ║
║  │ Operation Service                                                                      │   ║
║  │   - 企业开通 / 企业账号治理                                                            │   ║
║  │   - 企业负责人 bootstrap / 重置                                                        │   ║
║  │   - 专家模板 / 人才市场目录                                                            │   ║
║  │   - 行业方案模板 / 发布 / 下架 / 可见范围                                               │   ║
║  │   - 平台价格 / 配额 / 账单策略                                                         │   ║
║  │   - 跨企业 usage / audit 汇总                                                          │   ║
║  │                                                                                        │   ║
║  │ oper_db                                                                                │   ║
║  │   system_user / enterprise_account / owner_bootstrap_credential                       │   ║
║  │   expert_template / solution_template / catalog_release                               │   ║
║  │   cross_enterprise_usage_rollup / platform_audit                                      │   ║
║  └───────────────────────────────┬────────────────────────────────────────────────────────┘   ║
║                                  │                                                            ║
║        O1 tenant provision       │        M1 catalog/package pull                              ║
║        O2 owner bootstrap sync   │        M2 enterprise rollup upload                          ║
║        O3 catalog release notify │        M3 quota/billing check                               ║
║                                  │                                                            ║
║  ┌───────────────────────────────▼────────────────────────────────────────────────────────┐   ║
║  │ Manager System / Manager Service（多租户企业管理 SaaS）                                │   ║
║  │ web/manager                                                                            │   ║
║  │ /api/manager/* /api/auth/*                                                             │   ║
║  │                                                                                        │   ║
║  │ Manager Service                                                                         │   ║
║  │   - TenantContext / TenantRouter / TenantDataSession                                   │   ║
║  │   - 企业负责人/成员认证与 token 签发                                                     │   ║
║  │   - 部门 / 成员 / 角色 / 成员级授权                                                     │   ║
║  │   - 专家实例 / 方案实例 / 部门归属 / 授权范围                                            │   ║
║  │   - 企业知识库 / Manager RAG / 知识与专家绑定                                           │   ║
║  │   - 企业 usage / audit 汇总                                                            │   ║
║  │                                                                                        │   ║
║  │ manager_control_db                                                                      │   ║
║  │   tenant_registry / tenant_route / service_identity / isolation_policy                 │   ║
║  │                                                                                        │   ║
║  │ tenant data space（默认 PostgreSQL shared tables + RLS，可演进 schema/db-per-tenant）    │   ║
║  │   tenant A -> enterprise / member / department / employee / solution / grant / usage   │   ║
║  │   tenant B -> enterprise / member / department / employee / solution / grant / usage   │   ║
║  │   tenant N -> enterprise / member / department / employee / solution / grant / usage   │   ║
║  │                                                                                        │   ║
║  │ Manager RAG（LightRAG）                                                                 │   ║
║  │   workspace = tenant_id + knowledge_space_id                                           │   ║
║  │   tenant A / ks_default -> docs / chunks / vectors / graph                             │   ║
║  │   tenant B / ks_default -> docs / chunks / vectors / graph                             │   ║
║  │   tenant N / ks_default -> docs / chunks / vectors / graph                             │   ║
║  └───────────────────────────────▲────────────────────────────────────────────────────────┘   ║
║                                  │                                                            ║
╚══════════════════════════════════│════════════════════════════════════════════════════════════╝
                                   │ A1 login / tenant binding
                                   │ A2 pull authorized experts / solutions / snapshots
                                   │ A3 pull authorized knowledge/capability metadata
                                   │ A4 upload sanitized usage/audit summary
╔══════════════════════════════════▼════════ User Local Data Plane ════════════════════════════╗
║  Agent System / Agent Service（每用户本机，默认 localhost）                                  ║
║  web/agent                                                                                   ║
║  /api/agent/* /api/auth/*                                                                     ║
║                                                                                               ║
║  Agent Service                                                                                ║
║    - 本地 token cache / tenant binding                                                        ║
║    - conversation / message / run / task / loop                                               ║
║    - loaded_expert_projection / loaded_solution_projection                                    ║
║    - EmployeeExecutionSnapshot                                                                ║
║    - timeline event store / usage summary outbox                                              ║
║                                                                                               ║
║  agent local_db                                                                               ║
║    conversation / message / run / task / loop / run_event / raw_runtime_event                 ║
║    loaded projections / local_session_token / local_usage_summary_outbox                      ║
║                                                                                               ║
║  Local RAG / Local Capability Cache                                                           ║
║    authorized knowledge index/cache / MCP config / skills / connectors / provider refs         ║
║                                                                                               ║
║  Agent Gateway -> Runtime Executor + Driver -> Codex / Claude / OpenCode / Hermes / OpenClaw  ║
╚═══════════════════════════════════════════════════════════════════════════════════════════════╝

横向共享库（源码复用，非中心服务）：shared/auth / service_client / error model / config / observability
```

> **关键差异**：不存在中心化 Edge Gateway 与单一 origin。Operator 与 Manager 都在云侧控制面，允许通过服务身份做受控服务间调用；Agent 只主动访问 Manager。Manager 是多租户 SaaS，tenant 隔离是架构底座，不是业务代码里的可选过滤条件。用户机器**无入站连接**，运行事件与会话内容只在本地。

### 4.2 服务职责说明

#### 4.2.1 Operation Service（运营端，中心化 SaaS）

主要职责：**企业注册/开通**，设置并签发企业负责人 bootstrap 凭据（手机号 + 初始密码）、负责人凭据**重置（不保留密码明文/可逆形式）**；向 Manager 同步企业 tenant 与负责人 bootstrap 信息；平台模板、员工/专家模板、行业方案目录治理；平台级内容发布/下架/审核与可见范围；系统账号、系统角色、平台审计；**跨企业计量/财务/配额/成本汇总**与平台运营看板。

禁止事项：不执行 Agent 任务；不维护任何会话；不直接调用 runtime；不持有企业成员密码或会话内容；不向用户机器发起入站连接。

#### 4.2.2 Manager Service（企业端，多租户企业管理 SaaS）

主要职责：接收 Operator 同步的企业 tenant 与负责人 bootstrap 信息；维护 `tenant_registry`、租户数据路由、服务身份与隔离策略；企业负责人/管理员登录后只进入本租户数据空间；企业、成员账号、角色、部门/组织结构；**成员认证**（成员登录凭据校验与 token 签发）；员工/专家实例配置、模型配置、Prompt、能力开关；**模型供应商接入配置（AI Relay 端点/令牌，或直连 provider 凭据，见 §6.7）**；知识库、文档、LightRAG workspace、索引、知识绑定；技能安装与绑定；连接器定义、凭据授权、可见性控制；记忆策略与治理视图；**从 Operator 招募专家/应用行业方案，并指定部门/成员级授权**；企业账单、企业级计量/审计汇总与设置。

禁止事项：不持有/不维护任何会话与 Run/Task 执行状态机；不提交 runtime 执行；不消费 runtime 原始事件；不接收上传的会话内容；不向用户机器发起入站连接。

#### 4.2.3 Agent Service（用户端，每用户本机自部署）

主要职责：工作台、私聊、群聊、办公室动态；Conversation、Message、Run、Task、Loop（**全部本地落库**）；@提及路由、本地多专家协作编排；**主动访问 Manager 拉取已授权专家/方案并本地装载**；执行前从 Manager 拉取并冻结员工/专家执行快照；调用本地 Agent Gateway；运行事件落本地库、任务树构建、SSE/WebSocket 推送（localhost）；运行结果、usage、artifact、错误本地回流；**仅向 Manager 上报脱敏计量与审计摘要，不上传会话内容**。

禁止事项：不直接修改企业端员工配置主数据；不承担运营治理；不直接调用具体 runtime CLI（经 Gateway）；不把 runtime 原始事件暴露给前端；不上传会话/执行明细。

#### 4.2.4 各端入口与认证下沉（取消中心 Edge Gateway）

**形态变更（推翻早期"单一 Edge Gateway / 单 origin"假设）**：三端跨网络独立部署，不存在统一前端入口，因此**不设中心化 Edge Gateway**。每端各自承担自己的接入职责：

- 每端各有独立前端 origin 与 HTTPS 入口；服务自带认证中间件（`shared/auth` 本地验签）、限流、CORS/CSP、request-id/trace 注入。
- **登录端点与身份存储按系统持有**：运营端持系统账号与负责人 bootstrap 来源；Manager 按 tenant 持企业负责人/成员账号、认证端点、负责人重置后密码和签名密钥；用户端只持本会话 token，登录请求访问 Manager 校验（见 §9）。
- 跨系统调用方通过 `shared/service_client` 发起带签名身份的 HTTPS 调用，被调端验服务身份 + 租户/用户上下文 + 授权。

禁止事项：任一端不集中代理其它端业务；不在入口层写业务逻辑；用户端不暴露除 localhost 外的入站监听（除非用户显式开启）。

### 4.3 Team Panel 拆分口径

现有 `team_panel/` 的**业务能力**按**端**重新归属，在新服务中**全新实现**。下表「现有载体」列仅用于标识能力来源（供对照旧契约理解范围），**不代表搬迁/拆分旧代码、也不调用旧 router**——新端按 §17 对照契约基线重建：

| 能力来源（旧载体，仅作范围标识） | 归属端 | 能力 |
|---|---|---|
| `router_system_admin.py` | 运营端 Operation | 企业开通 / 平台模板 / 行业方案目录 / 企业账号治理 / 平台审计 / 跨企业统计 |
| `router_enterprise_admin.py`、`router_team_settings_billing.py` | 企业端 Manager | 企业 / 成员 / 角色 / 组织 / 企业账单设置 / 招募专家 / 成员级授权 |
| `router_team.py`（6069 行）中配置态部分 | 企业端 Manager | employee/expert config / prompt / knowledge / skill binding / connector grant / memory governance |
| `router_team.py` 中执行态部分 | 用户端 Agent（本地） | conversation / message / run / task / loop / run event / orchestration / runtime binding / office view / event stream |
| `router_auth.py`（640 行） | 按端联邦 | 运营端：负责人凭据/重置；企业端：成员登录/session/onboarding；用户端：本地 token。passkeys/oauth 按端归位 |

拆分原则：配置态与授权归 Manager 的租户数据空间，执行态归用户端 Agent（本地），企业开通与平台目录治理归 Operation，企业负责人/成员认证归 Manager；外部能力在用户端本地执行，不跨端直接写库。

---

## 5. 通信架构（云侧服务间调用 + Agent 主动访问 + 端内运行事件）

**形态变更（推翻早期"内网三通道 + 业务事件总线"与"全链路单向 pull"假设）**：Operator 与 Manager 同属云侧控制面，可以通过服务身份做受控服务间调用；Agent 是用户本机数据面，只主动访问 Manager，用户机器无入站连接。通信分三层：**云侧控制面服务调用**、**Agent→Manager 主动访问**、**用户端内高频运行事件流**。

### 5.1 跨系统通信（面尽量窄）

| 链路 | 用途 | 形态 | 一致性 |
|---|---|---|---|
| **Operator → Manager**（云侧） | 创建 tenant；同步企业基础信息与负责人 bootstrap；目录发布/下架/可见范围变更通知；配额/账单策略同步 | HTTPS / JSON + `shared/service_client` + 服务身份 | 幂等写入，最终一致 |
| **Manager → Operator**（云侧） | 拉取专家模板详情；拉取行业方案包；校验目录版本；上报企业级用量/审计/账单汇总 | HTTPS / JSON + `shared/service_client` + 服务身份 | 幂等写入，最终一致 |
| **Agent → Manager**（用户端主动访问） | 成员登录认证；拉取已授权专家/方案与执行快照；拉取授权能力元数据；上报脱敏计量/审计摘要 | HTTPS / JSON + `shared/service_client` | 本地优先，最终一致 |

跨端约定：
- **用户机器无入站**：Operator 与 Manager 可以云侧互调；Manager/Operator **绝不**向用户机器发起入站连接或推送。Agent 的配置变更靠主动 sync 感知（见 §6 配置投影）。
- **传输**：HTTPS/JSON；跨端走公网/企业网，必须 TLS + 服务身份签名（服务间认证即 §9.1 平面③，流程见 §9.6）。
- **超时/重试/降级**：所有调用必须设超时；只读调用可幂等重试（request-id 去重）；云侧写调用必须带 `Idempotency-Key`；Manager 短暂不可用时，Agent 已装载配置与已登录 token 在本地继续可用，仅"拉新配置/新登录/上报摘要"受影响。
- **摘要上报**：用户端只上报脱敏计量与审计摘要（见 §6.5），失败可本地缓冲后补传；**绝不上传会话内容**。

### 5.2 端内通信（主要在用户端）

| 通道 | 用途 | 形态 |
|---|---|---|
| **本地同步**（Agent Service ↔ Agent Gateway） | 提交 run、取消 run、查询 runtime capability | 本地 HTTP/JSON 或进程内调用 |
| **运行时流式通道**（Gateway → Agent Service） | 高频运行事件（text_delta 等） | 本地流式 + 事件落本地库 |

> **好品味裁决**：高频 `text_delta` 等运行事件**始终留在用户端本地**——直推本地 Agent Service 并落本地事件库供回放，**永不跨端**。跨端只看到脱敏的计量/审计摘要，看不到逐 token 流。

### 5.3 调用约定（跨端与端内统一）

- **客户端**：提供 `shared/service_client`，统一 base-url 解析、超时、重试、trace 透传、服务身份签名与错误模型解码；各端不手写 httpx 调用。
- **超时与重试**：所有调用必须设超时；只读幂等重试（request-id 去重），写调用默认不自动重试，由调用方依据 `Idempotency-Key` 决定。
- **降级口径**：快照/授权拉取失败时，run 拒绝并回明确错误，**绝不用陈旧或缺失配置硬跑**；但已成功装载的专家/方案在 Manager 离线期内仍可本地使用。

### 5.4 跨端接口清单（不复用前端 API）

| 调用方 → 被调方 | 接口语义 | 通道 |
|---|---|---|
| Operator → Manager | 创建 tenant；同步企业基础信息；同步负责人 bootstrap；同步目录发布/下架/可见范围；同步配额/账单策略 | 云侧服务间调用 |
| Manager → Operator | 拉取人才市场/行业方案目录；拉取专家模板详情；拉取行业方案包；校验模板版本；上报企业级计量/审计汇总 | 云侧服务间调用 |
| Agent → Manager | 成员登录认证；拉取已授权专家/方案列表；拉取 EmployeeExecutionSnapshot；拉取授权知识/技能/连接器/provider 元数据；上报脱敏计量/审计摘要 | 用户端主动访问 |
| Agent Service → Agent Gateway（端内） | 提交 run、取消 run、查询 runtime capability | 本地同步 |
| Agent Gateway → Agent Service（端内） | 运行事件回流、终态回调、usage 回调 | 本地流式 + 本地落库 |

### 5.5 服务发现与配置

- Operator 与 Manager 的云侧地址由平台配置/服务发现注入；Manager 地址通过企业成员入户配置、二维码或安装配置串下发给本企业用户端；用户端默认 localhost。
- 运行时启动配置（各 runtime 的 CLI 路径/默认参数/运行环境）由用户端 **Agent Gateway 的 Driver 层各自声明**（§7.3），按用户端自身配置注入；**不依赖旧 `app/.env`、不复用 `HERMES_WEBUI_*` 等旧 WebUI loopback 环境变量**——该执行链已废弃，Hermes 改由 `AcpExecutor` + `HermesAcpDriver` 经 ACP 接入。

---

## 6. 数据架构（系统所有权 + Manager 多租户隔离 + 配置投影 + 治理摘要上报）

### 6.1 数据所有权原则

每张核心表只能有一个写端。系统所有权分三类：Operator 持平台运营真相；Manager 持多租户企业管理真相；Agent 持用户本地会话与执行真相。Manager 内部不是"每企业一套服务"，而是一套多租户 SaaS 通过租户隔离底座服务 N 家企业。

| 数据域 | 写端 | 库（部署位置） |
|---|---|---|
| system_user / system_role / **enterprise_registration** / **owner_credential**（初始/重置，不存可逆密码）/ platform_template / industry_solution / platform_finance / platform_audit / **cross_enterprise_usage_rollup** | 运营端 Operation | oper（中心） |
| tenant_registry / tenant_route / service_identity / isolation_policy | 企业端 Manager | manager_control_db（中心，平台托管） |
| enterprise / member（成员账号 + 凭据）/ **owner_local_credential**（重置后）/ role / department / employee（专家/员工实例）/ solution_instance / prompt / knowledge（管理面+源文档，见 §6.6）/ skill_binding / connector / **provider_credential**（AI Relay 令牌或直连 provider 凭据，见 §6.7）/ **memory_policy**（记忆策略/种子，见 §6.6）/ **member_grant**（成员级授权）/ billing_setting / enterprise_audit / **enterprise_usage_rollup** | 企业端 Manager | tenant data space（默认 PostgreSQL 共享表+RLS，可演进 schema/db-per-tenant） |
| conversation / message / run / task / loop / runtime_binding / run_event / orchestration / **loaded_expert_projection**（pull 的只读专家/方案投影）/ **local_capability_cache**（本地化的知识索引/技能/连接器/provider 配置，见 §6.6/§6.7）/ **local_memory_store**（mem0 运行时记忆数据，见 §6.6）/ runtime_worker / runtime_capability / runtime_session / raw_runtime_event / **local_session_token** | 用户端 Agent | agent（用户本机） |

跨端读取走 pull API 或本地投影，**禁止跨端/跨库直写**。

> **认证存储归属**：系统账号在 Operator；企业负责人 bootstrap 来源在 Operator；企业负责人重置后凭据与成员凭据按 tenant 存在 Manager；Agent 只持本会话 token 和本地投影。详见 §9。

### 6.1.1 Manager PostgreSQL 租户隔离（可实现裁决）

Manager 默认采用 **PostgreSQL 共享表 + `tenant_id` + Row Level Security (RLS)**，因为这是 PostgreSQL 原生能力，成本最低且适合 SaaS 起步。所有租户业务表强制满足：

1. 表必须有 `tenant_id`；内部主键统一使用 UUID，企业可读账号/slug 另设 `enterprise_code` / `enterprise_slug`，禁止把可读账号当 RLS 主键。
2. 主键/唯一键凡涉及业务唯一性必须带 `tenant_id`，例如 `unique(tenant_id, phone)`、`unique(tenant_id, employee_slug)`。
3. 表必须 `ENABLE ROW LEVEL SECURITY`，关键表必须 `FORCE ROW LEVEL SECURITY`。
4. 应用每个请求进入事务前必须 `SET LOCAL app.tenant_id = '<tenant_id>'`。
5. 应用 DB 用户禁止 superuser 与 `BYPASSRLS`。
6. 连接池必须在事务边界设置 `tenant_id`，禁止跨请求复用残留上下文。

示例：

```sql
ALTER TABLE employee ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_employee_isolation ON employee
USING (tenant_id = current_setting('app.tenant_id')::uuid)
WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
```

应用侧统一入口：

```text
HTTP request
  -> shared/auth 解析 token
  -> TenantContext(tenant_id, user_id, roles)
  -> TenantDataSession.begin()
  -> SET LOCAL app.tenant_id = TenantContext.tenant_id
  -> 业务 repository 查询
```

演进路径：

| 隔离档位 | 方式 | 适用场景 | 代价 |
|---|---|---|---|
| L1 | 共享库共享表 + `tenant_id` + RLS | 默认 SaaS、多数中小企业 | 成本低，必须严控 RLS/连接池 |
| L2 | 共享库 + schema-per-tenant | 中大客户、需按租户备份/迁移 | migration 与连接路由更复杂 |
| L3 | db-per-tenant | 金融/私有化/超大客户 | 运维成本最高 |

业务代码不感知 L1/L2/L3 差异，只通过 `TenantRouter` 与 `TenantDataSession` 访问租户数据。这样后续把某个 tenant 从 L1 升级到 L2/L3，不需要重写业务模块。

### 6.1.2 Manager RAG 租户隔离（LightRAG 可实现裁决）

LightRAG 提供 `workspace` 作为数据隔离维度，并支持 PostgreSQL KV/Vector/DocStatus、图存储、向量存储等后端。本文不把 LightRAG 当成完整多租户权限系统，而是把它作为底层 RAG 引擎，由 Manager 封装租户安全边界。

Manager RAG 的映射规则：

```text
tenant_id = 018f3f8a-7b2f-7c1a-9c2d-2f8d6a9b7c01
enterprise_slug = ent_001   # 仅展示/登录定位使用，不参与隔离主键
knowledge_space_id = ks_default
LightRAG workspace = t018f3f8a7b2f7c1a9c2d2f8d6a9b7c01__ks_default
```

强制规则：

1. 前端、Agent、业务 API 都不得直接传 LightRAG `workspace`。
2. 只能通过 `ManagerRagService` 访问 LightRAG。
3. `ManagerRagService` 从 `TenantContext` 推导 `workspace = tenant_id + knowledge_space_id`。
4. LightRAG 实例按 workspace 建立或从实例池取出；禁止一个共享实例在请求中动态切 workspace。
5. 文档原文、切片、embedding metadata、图节点、向量索引元数据都必须带 `tenant_id` / `knowledge_space_id`。
6. 如 LightRAG 使用 PostgreSQL 存储，SaaS 默认必须把 workspace/tenant 映射落到 AI Team 可审计的数据层，并在可控 PG 表上加 RLS/namespace 作为第二防线；如果某个后端无法做 RLS，必须用独立存储命名空间、实例池隔离或凭据隔离替代，不能只依赖业务代码约定。

```text
HTTP request
  -> TenantContext(tenant_id)
  -> ManagerRagService.get(space_id)
  -> workspace = derive(tenant_id, space_id)
  -> LightRAG(workspace=workspace, storage=PGKV/PGVector/PGDocStatus/...)
```

结论：PostgreSQL 租户隔离是原生成熟能力；LightRAG 的 workspace 能承载数据隔离，但权限、workspace 路由、二级存储隔离与回归验证必须由 AI Team Manager 层实现，不能直接暴露 LightRAG Server 给企业用户或 Agent。

### 6.1.3 Manager 非 DB 资源租户隔离

多租户隔离不能只停在 PostgreSQL 与 RAG。凡是 Manager 云侧持有或派生的企业资源，都必须绑定 `tenant_id` 并经 TenantContext 访问：

| 资源 | 强制隔离口径 |
|---|---|
| 对象存储 | object key 前缀必须为 `tenant_id/knowledge_space_id/...`；下载/删除必须先验 TenantContext 与资源归属 |
| 缓存 | cache key 必须包含 `tenant_id`，禁止用手机号、employee_slug、solution_slug 等非全局唯一字段裸做 key |
| 队列 / outbox | 消息 payload、幂等键、重试记录必须包含 `tenant_id`；consumer 处理前恢复 TenantContext |
| 审计日志 | enterprise_audit 必须带 `tenant_id`、actor、resource_type、resource_id，不记录会话内容 |
| trace / log | 结构化日志必须带 `tenant_id`；跨租户聚合只允许运营级汇总视图读取 |

强约束：任何 Manager repository、cache client、object client、queue producer/consumer 都不得接受调用方手写 tenant 字符串；只能从 TenantContext 读取。详设必须提供跨租户串线回归测试，不只测 DB RLS。

### 6.2 跨端读取策略（pull + 本地投影）

- **新鲜读**：Agent 按需访问 Manager API（如成员登录认证、执行快照生成）；Manager 按需访问 Operator API（如招募专家模板详情、方案包详情）。
- **配置投影（本地优先）**：用户端**周期/触发式 sync** Manager 中"已授权给本账号的专家/方案"，落 `loaded_expert_projection` 本地只读投影；对话路径只读本地投影，不每次跨端取配置。Manager 离线时用本地投影继续工作。
- **执行固化读**：见 §6.3 快照。
- **变更感知**：Manager 可接收 Operator 云侧目录发布通知，也可定期校验目录版本；Agent sync 时带本地投影版本号/etag，Manager 只回增量，未授权条目自动从投影中失效移除。

### 6.3 员工/专家执行快照（EmployeeExecutionSnapshot）

用户端 Agent Service 发起 run 时，不直接读可变配置，而是固化执行快照：

```text
EmployeeExecutionSnapshot
  employee_id / version / display_name / persona
  model_policy / runtime_policy
  tools / skills / knowledge_refs / connector_refs / memory_policy
```

**所有权裁决（解原 §10-4）**：快照由**用户端 Agent Service 在装载专家/提交 run 时从 Manager 拉取并冻结**，连同 `snapshot_version` 落用户端本地库；run 全程只引用该快照。理由：快照生命周期与 run 绑定，run 归用户端本地所有；Manager 只需提供"按 employee_id+version 生成快照"的接口。这样保证一次 run 配置稳定、避免长任务上下文漂移，且 Manager 离线时本地已冻结快照仍可执行。

### 6.4 全新建库（不迁移旧数据）

系统所有权分库是**全新重建**：Operator、Manager、Agent 各自从零建库，Manager 租户数据从零建 tenant data space，**不迁移 MVP 单库（macmini 测试库）中的任何存量数据**。旧库只在需要时作为字段/口径的只读参照，不作数据源。
- 详设产出"各系统表 → 写端 → 目标库（部署位置）"的 **schema 设计**（按系统定义，非"现有表→新库"的搬迁映射）。
- 各系统 schema migration（DDL 脚本）按系统独立编写，落在该系统的 migrations 目录；沿用"schema migration 在首次 DB 连接时自动应用"的现有机制（这是建表脚本，非数据迁移）。
- 会话/run 等表本就归用户端**本机库**，全新建库后随用户本地使用自然落地；MVP 演示库中的此类数据不导入、不迁移。
- 如需演示数据，由各系统通过正常业务流程（企业开通、招募专家、发起会话）重新产生，不从旧库拷贝。

### 6.5 治理摘要上报（替代跨端 usage 事件）

**形态变更**：会话内容、执行明细、usage 原始事件与逐 token 明细不上传，治理闭环靠**脱敏聚合摘要逐级上报**：
- **上报内容**：计量（token/成本、run 次数/时长、错误率，按员工/专家/时间聚合）、关键审计事件（专家招募装载、登录、授权变更、越权尝试）。**不含**会话文本、文件、工具输入输出明细。
- **上报路径**：Agent → Manager（成员级聚合，落 `enterprise_usage_rollup`）→ Operator（企业级聚合，落 `cross_enterprise_usage_rollup`）。
- **可靠性**：上报失败本地缓冲后补传，按 `summary_id` 幂等去重；上报是尽力而为，不阻塞本地执行。
- **隐私边界**：脱敏在用户端**上报前**完成；详设产出摘要 schema 与脱敏字段清单。

### 6.5.1 配额与账单控制（本地优先下的取舍）

本地优先意味着 Agent 离线期间不能依赖 Manager/Operator 做逐次执行前强校验。v1 默认采用**软配额 + 事后治理**：

- Manager 从 Operator 同步企业配额/账单策略，并在租户内展示预算、告警和停用策略。
- Agent 在线 sync 时拉取本成员/本设备可用策略与本地提示阈值；离线时已装载专家可继续执行。
- Agent 上报脱敏 usage summary 后，Manager 聚合并执行告警、冻结新增招募、禁止新快照下发等治理动作，再上报 Operator。
- 默认不做"每次 run 前向 Manager 领取 quota lease"，否则 Manager 离线会阻断本地执行，破坏 D14。

企业如选择强成本控制，可在详设中增加**可选硬配额模式**：run 前领取短期 quota lease，Manager 不可达时拒绝新 run。该模式必须在产品上显式标记为"牺牲离线可用性换成本控制"，不能作为默认。

### 6.5.2 三端交互流程清单（设计覆盖面）

下列流程是概要设计必须覆盖的三端交互面。详设可拆成接口契约，但不得新增绕过这些边界的隐式链路。

| 编号 | 场景 | 交互链路 | 数据边界 |
|---|---|---|---|
| F01 | 企业开通 | Operator 创建企业账号 → Operator 调 Manager 创建 tenant → Manager 初始化租户数据空间/默认角色/默认知识空间 | Operator 写企业账号；Manager 写 tenant 与企业管理数据 |
| F02 | 负责人 bootstrap | Operator 生成负责人初始/重置凭据 → 同步给 Manager tenant → 负责人登录 Manager 后强制重置 | Manager 成为负责人长期凭据持有端 |
| F03 | 目录发布 | Operator 创建/发布/下架专家模板或行业方案 → 通知 Manager 可见范围或由 Manager 拉取目录版本 | Operator 持模板真相；Manager 可缓存租户可见目录索引 |
| F04 | 负责人登录企业后台 | 负责人访问 Manager → Manager 按 tenant 校验凭据 → token 带 `tenant_id`、`roles` | Manager 只能返回本 tenant 数据 |
| F05 | 部门/成员管理 | Manager 租户内 CRUD 部门、成员、角色 | 所有表走 TenantDataSession/RLS |
| F06 | 招募专家 | Manager 租户内点击招募 → Manager 向 Operator 拉专家模板详情 → 写入本 tenant 的 employee instance，可绑定部门/成员授权 | Operator 不写 Manager 租户库；Manager 不改模板真相 |
| F07 | 应用方案 | Manager 向 Operator 拉方案包 → 在本 tenant 创建 solution instance，展开专家/知识/技能/默认授权 | 方案实例归 Manager tenant |
| F08 | 企业知识/RAG | Manager 上传/导入企业文档 → ManagerRagService 推导 LightRAG workspace → 建索引并绑定专家/方案/部门/成员 | workspace = tenant_id + knowledge_space_id |
| F09 | 用户端入户 | Agent 配置 Manager URL/企业邀请码 → Agent 访问 Manager 登录 → Manager 返回 token、公钥/验签参数、tenant 信息 | Agent 只持本会话 token 与本地投影 |
| F10 | 授权配置同步 | Agent → Manager 拉本成员可见专家/方案/能力元数据 → Agent 写本地 loaded projection | Manager 按 tenant + member_grant 裁剪 |
| F11 | 执行快照 | Agent 提交 run 前向 Manager 拉 EmployeeExecutionSnapshot → Agent 本地冻结 snapshot_version | 快照只含执行配置，不含 Manager 可变主数据写权 |
| F12 | 本地执行 | Agent Service → Agent Gateway → Runtime；Local RAG/MCP/Skills 本地执行 | conversation/message/run/raw event 只落 Agent local_db |
| F13 | 用量回流 | Agent 本地汇总 token/cost/error/run count → 上报脱敏 summary 到 Manager → Manager 聚合后上报 Operator | 不含会话文本、文件内容、工具输入输出明细 |
| F14 | 授权撤销/变更 | Manager 改 member_grant 或 employee version → Agent 下次 sync 失效本地投影；新 run 必须用新快照 | 已冻结 run 不被中途改写 |
| F15 | 模板升级/下架 | Operator 更新/下架模板 → Manager 标记租户实例可升级/不可新增 → Agent sync 感知可见性变化 | 历史实例策略由 Manager 详设决定 |
| F16 | 越权与审计 | Agent 越权拉专家/知识，Manager 返回 403 并记 enterprise_audit；Operator 只看聚合审计 | 审计带 tenant_id，不含会话内容 |

### 6.6 外部能力的归属与本地化（消除"企业端 vs 本地"歧义）

知识/记忆/技能/连接器/MCP 既是**企业资产**（在企业端管理）又要**本地执行**（在用户端运行），二者按"管理面 / 执行面"分开，避免歧义：

| 能力 | 管理面（Manager tenant data space 持有） | 执行面（用户端 Agent 本地） |
|---|---|---|
| 知识库（**LightRAG**） | 文档源、索引构建配置、知识集定义、成员/专家绑定；按 tenant 的 LightRAG workspace 隔离 | pull 已授权知识集的**索引产物/检索配置**到 `local_capability_cache`，**本地检索**经 MCP 注入 runtime；查询与命中内容不上传 Manager |
| 记忆（**mem0 / OpenMemory**） | 记忆策略、种子记忆、保留期、可见性绑定 | 本机运行 mem0/OpenMemory 作为**本地 MCP 记忆服务**，经 MCP 注入 runtime；记忆读写内容不出本机，跨 runtime 可移植 |
| 技能（SkillHub/Hermes skills） | 技能目录、版本、安装与绑定策略 | pull 已授权技能并**本地安装/执行**；无原生技能机制的 runtime 降级为 MCP 工具暴露 |
| 连接器（Connectors） | 连接器定义、可见性、凭据授权（grant，谁能用） | 运行时**最小权限注入**凭据，本地发起对外部 SaaS 的调用 |
| MCP | MCP server 定义与授权 | 本地启动/连接 MCP，本地调用 |

> **复用裁决**：知识库复用 **LightRAG**、记忆复用 **mem0（其 OpenMemory 为本地优先 MCP 记忆服务）**——二者都开源（Apache 2.0 级）、成熟、可本机自部署，且**统一经 MCP 工具注入任意 runtime**（见 §7.5），职责互补不重叠：LightRAG 管文档语料检索，mem0 管 agent 跨交互的 user/session/agent 级记忆。AI Team 只做管理层封装与本地装配，不自造记忆/检索内核。

**裁决与隐私口径**：
- **管理面真相在 Manager tenant data space**，用户端只持 pull 下来的**只读投影/产物**（`local_capability_cache`），随专家快照或独立 pull 一并装载、随授权变更失效。
- **流向单一**：企业资产（知识索引、技能包、连接器凭据）**自上而下流到本机**（企业把自己的资产发给自己员工的机器，不违反隐私承诺）；用户的会话/查询内容**绝不上行**。
- **连接器的对外调用是其本职**：连接器按定义调用外部 SaaS（数据出本机到该 SaaS），这是连接器语义本身，**不属于**"会话内容上传企业端/运营端"的禁止项；凭据按 §11.4 最小注入、用后不留痕。
- **大语料权衡**：知识索引可能较大，本地化采用"按已授权知识集 + 增量"拉取，不整库复制；具体切分与缓存淘汰留详设（§20.2）。

### 6.7 模型供应商凭据与 AI Relay（解决 provider 凭据归属）

runtime CLI 跑起来必须能访问模型 provider（API key / endpoint）。旧架构把 providers 写进 Hermes profile `config.yaml`（`materialize_root_providers`），新架构废弃 profile 直写后，按下表归位：

| 面 | 归属 | 内容 |
|---|---|---|
| 管理面 | Manager tenant data space | provider 接入配置真相：**默认 AI Relay 端点 + 企业级令牌**；或（可选）直连 provider 凭据（API key）；可见性/成员级授权 |
| 执行面 | 用户端 Agent（本地） | pull 已授权的 provider 配置到 `local_capability_cache`；run 时由 **Driver 最小权限注入**到 runtime 的 provider env/配置，用后不留痕（§11.4），**不写共享 profile** |

**裁决**：
- **默认走 AI Relay**（复用既有服务）：用户机器只持 **Relay 端点 + 受限令牌**，真实 provider key 留在 Relay 侧，降低 key 在每台用户机器上的扩散面，契合租户凭据集中管理取向。
- **可选直连 provider**：企业可为特定 runtime/场景配置直连 key（仍 Manager 管理、本地最小注入）。二者经同一 Driver 注入接缝，对上层中立。
- **隐私边界澄清**：**LLM/Relay 调用（把 prompt 发给模型方或 AI Relay）是 agent 的固有行为，不属于"会话内容上传控制面（Manager/Operator）"的禁止项**——与 §6.6 连接器对外调用同理。"内容不出端"约束的是**对 AI Team 控制面的上传**，不是禁止调用模型 API。
- `RunSpec` 以 `provider_ref` 引用该配置（见 §7.5.1），不内联明文凭据。

---

## 7. Agent Gateway 通用运行时设计

> **部署位置**：Agent Gateway 与本地 runtime 都运行在**用户端**进程内/同机，与本地 Agent Service 共址。运行请求与运行事件**全程不跨端**；下文抽象（Executor/Driver/事件归一）与部署边界变更无关，沿用。

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

> **runtime 启动配置的唯一归属**：runtime（含 Hermes）的可执行路径、参数、运行环境一律由对应 Driver 在用户端自身配置中声明，是 v1 runtime 接入配置的唯一来源。`HermesAcpDriver` 经 ACP 启动/连接 Hermes，**取代旧 WebUI loopback 执行链**；旧 `HERMES_WEBUI_PYTHON`/`HERMES_HOME`/`HERMES_CONFIG_PATH`/`HERMES_WEBUI_AGENT_DIR` 与 `app/.env` 在 v1 一概不再使用。

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

1. **Local Worker**：用户端本机直接运行 runtime CLI。**这是本架构的默认与主形态**——会话/执行本地化、内容不上传，天然落在 Local Worker。
2. **Daemon Worker**：用户本机运行 runtime daemon，向同机 Gateway 上报可用 CLI、版本、模型能力与心跳；适合一机多 runtime 的管理，仍是本地范畴。
3. **Cloud Worker**：平台托管 runtime worker（隔离容器、弹性调度）。**与"本地优先/不上传"取向相悖，仅作为企业显式选择的可选项**，非默认。

**裁决（解原 §10-2）**：首期实现 **Local Worker + 清晰 Worker 接口**，Daemon Worker **接口同步设计、实现后置**，Cloud Worker 列入后续且默认关闭。不一开始把调度系统做复杂。

### 7.5 能力适配：中立 RunSpec + 能力 MCP 注入 + 每 runtime 映射（借鉴 multica）

> **设计借鉴**：本节抽象参考开源项目 **multica**（`github.com/multica-ai/multica`，`server/pkg/agent/`）的运行时适配机制——单一 `Backend.Execute(ctx, prompt, opts)` 接口 + runtime 中立入参 + 归一事件流 + 每 runtime 一个适配文件。我们以 Python 重实现其**设计**（非拷贝代码），落为 Executor/Driver 契约。

**核心裁决**：员工的 persona / 模型 / 技能 / 知识 / 记忆 / 连接器配置，**不再像旧架构那样写进 runtime 原生 profile 文件**（旧 `SOUL.md` / `MEMORY.md` / `skills/` 目录 / `config.yaml` 直写一律废弃）。改为：业务层只产出**中立 `RunSpec`**，由 Driver 翻译注入，**优先级 协议/flag > 文件**，文件 materialize 仅作个别 runtime 的最后兜底（run 作用域临时产物，不碰共享 profile）。

#### 7.5.1 中立 RunSpec（runtime 无关，由 EmployeeExecutionSnapshot 派生）

```text
RunSpec
  system_prompt        # ← persona（中立文本，不写 SOUL.md）
  model                # ← 中立 model id（空=让该 runtime CLI 自解析默认）
  provider_ref         # ← 模型供应商配置引用（AI Relay 或直连，见 §6.7；不内联明文凭据）
  thinking_level       # ← 中立 reasoning/effort 档位
  mcp_config           # ← 能力统一注入通道（见 7.5.2）
  resume_session_id    # ← 续接上次 session
  custom_args          # ← 透传参数（必须过 Driver 的 denylist 安全过滤）
  timeout / cancellation
```

#### 7.5.2 A 类能力：统一经 `mcp_config` 注入（runtime 无关）

知识 / 记忆 / 连接器 / 技能（无原生机制时）本质都是"运行时按需访问的工具"，**一律打包进 `RunSpec.mcp_config`**，对任何支持 MCP 的 runtime 同构注入：

| 能力 | 本地 MCP 提供者 | 说明 |
|---|---|---|
| 知识 | LightRAG 本地检索 MCP | 已授权知识集索引产物，本地检索 |
| 记忆 | **mem0 / OpenMemory** 本地 MCP | 本机记忆库读写，跨 runtime 可移植 |
| 连接器 | 连接器 MCP/tool | 调用时最小权限注入凭据 |
| 技能（降级） | 技能包装为 MCP tool | 仅当 runtime 无原生技能机制 |

#### 7.5.3 B 类能力：中立字段 → Driver 按 runtime 翻译（优先 flag/协议）

| 中立字段 | Claude Code | Hermes(ACP) | Codex/其它 | 兜底 |
|---|---|---|---|---|
| `system_prompt` | `--append-system-prompt` | ACP session 参数 | 各自 inline/flag | 仅个别 runtime 需文件时临时生成 |
| `model` | `--model <id>` | ACP `session/set_model` RPC | flag / `--agent` by id / 空则 CLI 默认 | —— |
| `thinking_level` | `--effort` | 协议字段 | 各自 | —— |
| `mcp_config` | 写临时文件 → `--mcp-config` | 经 ACP 注入 | 各自 MCP 入口 | —— |
| `resume_session_id` | `--resume <sid>` | ACP session | 各自 | 落地校验失败则清空回退 |
| 技能（原生） | 原生 skill 机制 | profile skills（Driver 内封装） | 各自 | 降级见 7.5.2 |

模型目录：**静态目录（稳定阵容如 Claude）+ 动态发现（shell 出 CLI 列模型、短期缓存）**，与 multica 一致。

#### 7.5.4 规则与兼容

1. **配置真相 runtime 中立、存企业端 Manager**；snapshot/RunSpec 不含任何 runtime 原生格式。
2. **Driver 是唯一翻译点**；网关核心与业务层不碰 runtime 原生文件/参数。
3. **能力声明 + 优雅降级**：Driver 声明支持的 materialization（原生技能?原生记忆?persona 注入方式?）；不支持的回落到 7.5.2 的 MCP 投影或明确标 unsupported，**绝不静默丢弃**。
4. **安全**：`custom_args` 必须过 Driver 的参数 denylist（防止破坏协议/越权 flag）。
5. **向后兼容 Hermes**：旧 `profile_capability.py` 的 SOUL/MEMORY/skills/config 写入逻辑**不再需要**（persona 走协议、记忆/知识走 MCP）；如个别能力仍需 Hermes profile 文件，封装在 `HermesAcpDriver` 内、run 作用域临时生成，**不手改 `.hermes/hermes-agent/`**。

### 7.6 本地编排、Loop 与 runtime 选择（用户端 Agent Service 侧）

run 的**触发与编排**是用户端 Agent Service 的职责，统一收敛为"构造 `RunSpec` → 提交 Agent Gateway"，runtime 无关：

- **runtime 选择**：每个 employee 实例在配置中声明默认 runtime（`runtime_binding`）；Agent Service 提交 run 时按 `runtime_selection` 选 Driver，能力不匹配（如所选 runtime 无某协议）则按 §7.5.4 的能力声明降级或明确报错，**不静默切换**。用户可否手动切 runtime 留详设。
- **本地多专家协作编排（群聊 @提及）**：群聊只是**单用户本机多专家协作**（§19 非目标已排除跨机器会话同步）。@提及路由由 Agent Service 解析，被提及的每个专家**各自以其快照构造独立 RunSpec、各起一个 run**，多 run 事件并入**同一会话时间线**（按 run_id 区分来源）；编排为串行/并行的调度策略与防回环（避免互相 @ 触发死循环）留详设。
- **Loop/周期任务**：由用户端**本地调度器**（runtime 无关，**不依赖 `hermes cron`**）持有 cron/触发配置，到点构造 RunSpec 经 Gateway 执行；**仅在用户端运行期执行**（§16.2 取舍），关机即不跑，不做服务端常驻代跑。调度器实现与持久化留详设。

> 以上三者都不引入新的 runtime 耦合：编排/Loop 只负责"何时、以哪个专家快照"发起 run，真正的 runtime 差异仍只活在 Driver（§7.5）。

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

**状态口径继承**：Conversation 持久化主状态固定枚举 `draft | active | paused | muted | archived`；展示态 `idle | routing | waiting_reply | streaming | busy | resolved | reconnecting` **不写入持久化主状态**。会话主状态与运行态**都在用户端本地**，二者冲突时以本地 Runtime 执行口径为准，业务侧通过本地事件回流更新镜像，不伪造 Runtime 已完成。企业端/运营端不持有会话状态，只接收脱敏计量/审计摘要（§6.5）。

---

## 9. 认证与身份（Manager 多租户身份源 + 本地验签）

> 现状是技术债：业务多租户 auth（`router_auth.py` + `auth_service.py`）是**纯进程内存 mock**（全局 dict + RLock、`mock_wechat_guest`、硬编码 `ent_001`、手机验证码写死），且与基座单密码门（`api/auth.py` `check_auth`）两套割裂。本章定型一套**Manager 多租户身份源 + Agent 本地验签**的认证，全部退役旧 mock。
>
> **形态变更（推翻早期"中心 Identity 折叠进单一 Edge"与"企业端自部署身份源"假设）**：不设中心 Edge Gateway；Operator 只持系统账号与负责人 bootstrap 来源；Manager 是企业负责人/成员身份源，按 tenant 持凭据与签名密钥；Agent 只持本会话 token 与本地验签材料。

### 9.1 三个平面（先分清，别混）

| 平面 | 回答 | 谁对谁 | 机制 |
|---|---|---|---|
| ① 用户认证 | "你是哪个人/哪个企业成员/负责人" | 人 → 某端 | 登录 → 签发**用户 JWT** |
| ② 用户授权 | "你这角色能不能做这事、能不能碰这数据" | 已登录用户 → 资源 | 角色 + 资源归属 + 成员级授权校验 |
| ③ 服务间认证 | "这个跨端 pull 是不是可信端发来的" | 端 → 端 | TLS + 签名服务令牌，与用户身份无关 |

边界口径：**用户 JWT 管 ①②；服务身份管 ③；用户上下文在 ③ 的通道里透传**（供上端做审计），不以用户 JWT 替代服务身份。

### 9.2 凭据持有（谁持有谁、谁校验谁）

| 主体 | 凭据来源 | 长期凭据存放 | 谁校验登录 |
|---|---|---|---|
| 企业负责人 | Operator 创建企业时生成 bootstrap，并同步给 Manager tenant | **Manager tenant data space**（首登重置后） | Manager 校验 bootstrap/重置后凭据 |
| 企业成员 | Manager 租户内创建（手机号 + 初始密码/邀请） | **Manager tenant data space** | Agent 访问 Manager 校验 |
| 系统账号 | 运营端创建 | 运营端 | 运营端本地校验 |

**运营端不持企业长期密码**：Operator 只持"初始/重置 bootstrap 凭据"（仅存校验/同步所需的 hash 或一次性材料）；负责人重置后的有效密码只存 Manager 对应 tenant，Operator 永不持有企业负责人/成员长期密码。

### 9.3 核心设计：多样性隔离在一层，token 永远单一路径

登录方式（手机+密码/手机验证码/未来微信/oauth…）的多样性**只活在 Authenticator 一层**；所有方式收敛到同一个 `user`，再走同一个 token 出口。token 签发与校验**不认识你怎么登的**。

```text
手机+密码 / 验证码 / 微信 / ...   ← 多样性只在这层
      │  各自 verify → 外部身份(external_id)
      ▼
   auth_identity 映射表          ← 外部身份 → 内部 user（在凭据持有端）
      │  统一 user_id
      ▼
   issue_token(user_id, ...)     ← 单一出口，与登录方式无关
```

数据结构（在各凭据持有端各有一份，结构同构）：

```text
user                      # 规范账号(principal)，Manager 内必须带 tenant_id
  id / tenant_id / enterprise_id / display_name / status / roles

auth_identity             # 一个 user 可挂 N 行
  id / user_id -> user.id
  tenant_id    # Manager 内必填；Operator 系统账号可为空或使用 system tenant
  provider     ∈ {password, phone, wechat, ...}
  external_id  # phone=手机号 / password=用户名 / wechat=openid
  secret       # password=hash；其它=null 或 provider 侧引用
  unique(tenant_id, provider, external_id)  # 同手机号可属于不同企业，不能跨 tenant 串线
```

**新增一种登录方式 = 多一个 provider 取值 + 一个 Authenticator，`user` 与 token 层零改动。**

### 9.4 三端登录流程

**A. 负责人首登（Manager，凭 Operator 同步的初始凭据 bootstrap）**

```text
企业负责人访问 Manager 企业登录页
  → 负责人输入 手机号 + 初始密码
  → Manager 按企业账号/tenant 定位 owner bootstrap
  → 校验通过 → 强制重置密码 → 新密码 hash 落 Manager tenant 的 owner_local_credential
  → 此后负责人登录由 Manager 本 tenant 本地校验，不再访问 Operator
  → Manager issue_token({tenant_id, user_id, roles}) → 负责人进入本企业管理后台
```

运营端重置：Operator 将该负责人标记为"待重置"并同步新 bootstrap 给 Manager；Manager 使本 tenant 负责人本地凭据进入待重置状态，负责人下次需用新 bootstrap 重新设置密码。

**B. 企业端创建成员账号**

负责人/管理员在 Manager 租户内创建个人账号（手机号 + 初始密码/邀请），写入本 tenant 的 `member`；可指定其角色、部门与可用专家/方案（成员级授权，§9.7/§6）。

**C. 成员在用户端登录（用户端，凭企业端凭据）**

```text
用户本机部署用户端 → 登录页
  → 成员输入 手机号 + 初始密码
  → Agent 访问 Manager 校验凭据（首次必须在线）
  → Manager 按 tenant 校验通过（**首登强制重置**，新密码 hash 存 Manager tenant）
  → Manager issue_token + 下发验签公钥/参数
  → 用户端缓存 token，此后本地验签；token 过期需重新联网登录
```

`Authenticator` 是唯一扩展点：`PasswordAuthenticator`、`PhoneAuthenticator`、`WechatAuthenticator`……新方式实现同一接口、插入注册表，下游流程一行不改。

### 9.5 token 层（最简方案 + 跨端验签）

| 项 | 最简做法 | 演进 |
|---|---|---|
| 签发 | **JWT**，载荷 `{tenant_id, enterprise_id, user_id, roles, exp}`；Manager 签发企业负责人/成员 token，Operator 签发系统账号 token | —— |
| 校验 | 共享库 `shared/auth` 本地验签，不查库、不回调签发端 | —— |
| 跨端验签密钥 | **直接采用非对称签名**：Manager 按 tenant 持私钥签发，Agent 首登时只领取公钥/JWKS 与 `kid`；用户端永不持可签发 token 的密钥 | 后续补 key rotation / JWKS 缓存刷新 |
| 健全（过期/续期） | 短期 access JWT；过期需重新联网登录（符合"首次在线、之后本地"） | 后续补 refresh 轮换 |

原则：**Manager 作为企业身份源集中签发 + Agent 本地无状态验签**。绝不做"每请求回调上端验 token"，也绝不把 HMAC 对称签名密钥下发到用户端；用户机器只能验签，不能伪造签发。

### 9.6 请求流程（公开端点 / 401 vs 403）

```text
登录(无token) → 凭据持有端验凭据(§9.4) → 签发 JWT
后续请求带 Authorization: Bearer <jwt>
各端入口中间件（shared/auth）:
  ├─ 公开端点(login / healthz / 验证码 / 负责人 bootstrap) → 放行，不要 token
  ├─ 受保护端点：无 token / 验签失败 / 过期 → 401（认证失败）
  └─ 有效 → 解出身份，进入业务处理
业务处理:
  └─ 读 roles + 成员级授权做鉴权 → 越权 403（授权失败）
跨端 pull（service_client）:
  └─ 附服务身份签名 → 被调端验服务身份(③) + 透传的用户上下文
```

要点：**受保护端点拒、公开端点放行**；**401（没证明你是谁）与 403（知道你是谁但没权限）分清**；Manager 离线时，已登录用户凭本地 token 继续工作。

### 9.7 角色模型与成员级授权（继承现有枚举）

- 企业侧：`owner | enterprise_admin | finance_admin | member`。
- 平台侧：`system_admin | system_operator`。
- **禁止**使用 `admin/manager/viewer` 等旧角色枚举。
- **成员级授权**：Manager 租户内招募专家/配置行业方案时，记录"专家/方案 → 授权部门/成员账号"映射（`member_grant`）；Agent sync 时只返回授权给本账号的条目，鉴权②在 Agent + Manager 两侧校验。

### 9.8 职责归位与形态裁决（无中心 Edge，Manager 是企业身份源）

把"认证"拆成**无状态**与**有状态**两块，各归其位——**既不设独立 Identity 服务，也不设中心 Edge Gateway**：

| 能力 | 本质 | 归位 |
|---|---|---|
| 验签 + 解身份 | 纯计算 | **共享库 `shared/auth`**，各端直接 import，**不是网络服务、不回调** |
| 鉴权（②） | 纯逻辑 | 共享库提供 helper，**策略留各端**（资源归属/成员授权只有业务自己懂） |
| 签发 token | 纯计算 | 共享库 helper，仅由凭据持有端在校验通过后调用 |
| 凭据校验 + 登录端点 + `user`/`auth_identity` 表 + 签名密钥 | **有状态 + 持密钥** | 系统账号归 Operator；企业负责人/成员归 Manager tenant；Agent 只持本会话 token |

**为什么不设中心 Edge/Identity**：Operator 的系统账号和 Manager 的企业账号是两个信任域；Agent 用户端又必须本地优先。把所有身份再抽成中心 Identity 会制造新的 SPOF 与租户数据耦合。更简单的做法是：Operator 管平台运营身份，Manager 管企业租户身份，Agent 本地验签。

边界与权衡：
- **Manager 身份存储必须带 tenant_id**；身份是租户边界的一部分，不能放在全局无租户表里。
- **密钥权衡**：v1 直接采用非对称签名，Manager 按 tenant 持私钥签发，用户端只持公钥/JWKS 验签；key rotation 与 JWKS 缓存刷新留详设。
- **跨端可用性**：上端短暂离线只影响"拉新配置/新登录"，不影响已登录用户的本地工作（本地 token + 本地投影）。

---

## 10. 北向 API 与路径收口

### 10.1 路径裁决（解原 §10-1）

采纳生产统一命名，**弃用旧 `/api/team/*`、`/api/system/*`、`/api/enterprise/*`，不留 alias、不做兼容**。每端在**自己的 origin** 下暴露自己的前缀（不再有中心 Edge 统一 origin）：

| 端 origin | 新前缀 | 取代 |
|---|---|---|
| 运营端 | `/api/operation/*`、`/api/auth/*`（系统账号 + 负责人凭据/重置） | 旧 `/api/system/*` |
| 企业端 | `/api/manager/*`、`/api/auth/*`（成员认证 + 负责人本地登录） | 旧 `/api/enterprise/*` + `/api/team/*` 配置态 |
| 用户端 | `/api/agent/*`、`/api/auth/*`（本地登录/登出） | 旧 `/api/team/*` 执行态 |

达成**三处同名对齐**：后端模块 `agent_service` ↔ 前端 `web/agent/` ↔ 接口 `/api/agent/*`，三端同构。`/api/auth/*` 语义沿用，但按端实现各自的认证职责（§9）。

### 10.2 API 规范

- 各端服务用 FastAPI `APIRouter` 按业务模块拆分，Pydantic schema 作 API 边界，自动产出 OpenAPI / Swagger UI / ReDoc。
- **每端各自发布自己的 OpenAPI 文档入口**（不做跨端聚合——三端不在同一 origin、且互不信任彼此内部接口）。跨系统服务调用与 Agent 主动访问接口单独成一份"跨端契约"文档。
- 统一错误模型（见 §11.2），统一 numeric cursor 分页，禁止对外暴露 `{timestamp}-{sequence}` 内部游标。

### 10.3 API 文档与接口格式规范（地基裁决）

后端接口不是"实现完再补文档"。v1 三端所有 HTTP API 必须由 schema 驱动并自动产出现代化 API 文档，文档本身进入验收口径：

1. **文档入口固定**：每端服务必须提供 `/openapi.json`、`/docs`（Swagger UI）、`/redoc`（ReDoc）三类入口；`/docs` 与 `/redoc` 是否在生产公网公开由部署配置控制，但 `/openapi.json` 必须能在 CI 与受控运维环境中获取。
2. **OpenAPI 按端发布**：Operation、Manager、Agent 各自发布本端 OpenAPI，不做中心聚合；跨系统契约（Operator↔Manager、Agent→Manager）必须从对应服务的 Pydantic schema 生成或校验，单独导出为 `openapi.cross-system.json` / 契约文档，不能只靠自然语言表格。
3. **schema first**：所有 public endpoint 必须声明 request model、response model、错误响应、鉴权需求、tags、summary 与 operation_id；禁止裸 `dict` / `Any` 作为对外响应边界，内部临时结构必须先收敛为 Pydantic schema。
4. **成功响应统一 envelope**：
   - 单对象：`{ "data": <object>, "meta": { ... }? }`
   - 列表：`{ "data": [ ... ], "page": { "next_cursor": "...", "has_more": true }, "meta": { ... }? }`
   - 空成功：`204 No Content`，或在需要 request trace 时返回 `{ "data": null, "meta": { ... }? }`，不得每个接口自造 `{ ok: true }` / `{ success: true }`。
5. **入参规范**：path 参数只放资源身份，query 参数只放过滤/分页/排序，复杂写入放 JSON body；时间统一 ISO 8601 UTC；ID 统一 UUID 字符串；枚举统一 snake_case；金额、成本、token 用整数最小单位或 decimal string，禁止 float；写接口需要幂等时统一 `Idempotency-Key` header。
6. **出参规范**：字段命名统一 snake_case；nullable 与 optional 必须在 schema 中明确；对外只返回业务必要字段，禁止返回 password hash、provider key、内部 RLS 字段、runtime raw payload、未脱敏内容；版本化资源必须返回 `version` / `etag` / `updated_at` 中至少一种可用于增量同步或并发控制的字段。
7. **分页与排序**：统一 numeric cursor / opaque cursor 语义，对外字段为 `next_cursor` 与 `has_more`；禁止暴露内部 `{timestamp}-{sequence}` 游标；排序字段必须白名单化，默认排序在 OpenAPI description 中声明。
8. **HTTP 语义**：认证失败 401，鉴权失败 403，资源不存在 404，冲突 409，幂等重放按原结果返回，入参校验失败 422，限流 429；所有错误使用 §11.2 的统一 problem+json 模型。
9. **OpenAPI 质量门禁**：CI 必须能生成三端 OpenAPI 与跨系统契约，执行 schema 校验、operation_id 唯一性校验、无裸 `Any`/空 schema 检查、错误响应覆盖检查；接口变更必须能产出 OpenAPI diff，破坏性变更需要显式评审。
10. **版本策略**：v1 首版路径不加 `/v1` 前缀，版本归 OpenAPI 文档版本与资源 schema version 管理；若未来出现外部第三方稳定 API，再单独引入 `/api/public/v1/*`，不污染三端内部产品 API。

---

## 11. 横切关注点（新增）

### 11.1 可观测性

- **日志**：结构化日志，强制携带 `request_id`、`trace_id`、`tenant_id`、`service`。
- **Trace**：OpenTelemetry 分布式追踪；端内 trace 贯穿入口 → 服务 →（用户端）Agent Gateway → Executor/Driver，运行事件携带 `run_id` 关联；跨端 pull 透传 `trace_id` 以串起端间链路（但运行明细不跨端，跨端只见摘要）。
- **Metrics**：各端服务暴露 `/metrics`（请求量/延迟/错误率、run 时长、runtime 成功率、usage）。

### 11.2 统一错误模型

所有端服务返回 `application/problem+json` 风格错误，结构统一为：

```json
{
  "type": "https://docs.aiteam.local/problems/validation_error",
  "title": "Validation error",
  "status": 422,
  "code": "validation_error",
  "detail": "Request body is invalid.",
  "instance": "/api/manager/employees",
  "request_id": "req_...",
  "errors": [
    { "loc": ["body", "display_name"], "message": "Field required", "type": "missing" }
  ]
}
```

- `type/title/status/code/detail/instance/request_id` 为标准字段；`errors` 用于字段级校验错误；`meta` 可用于非敏感诊断信息。
- `message` 不再作为顶层标准字段，避免与 RFC 7807 的 `detail` 并行；前端统一展示 `detail`，调试看 `request_id`。
- 各端入口中间件、FastAPI exception handler 与共享 `service_client` 统一生成/解码该结构，不让各端自定义错误形态。
- 错误响应不得包含密码、token、provider key、会话内容、runtime raw event、工具输入输出明细等敏感信息；详细堆栈只进入受控日志。

### 11.3 配置与健康检查

- 每端服务提供 `/healthz`（存活）、`/readyz`（依赖就绪：本端 DB；跨端依赖以"可降级 pull"对待，上端不可达不致本端 not-ready）、`/docs`。
- 配置经各端自身环境变量/配置中心注入；runtime 启动配置归 Agent Gateway Driver 层（§7.3）。**不复用旧 `app/.env` 与 `HERMES_WEBUI_*` 键。**

### 11.4 安全与隔离

Runtime Worker 必须具备：工作目录隔离；凭据最小注入；环境变量脱敏；工具调用审计；输出脱敏；超时与取消。Agent CLI 可执行 bash/文件/网络/MCP，隔离是硬约束。

---

## 12. 前端架构（按端分离·改写）

### 12.1 裁决：三套独立前端，按端分离，各端自服务自己的前端

**形态变更（推翻早期"单一 SPA 不拆前端"裁决）**：早期裁决基于"三服务共址、单一 origin、用户跨面"的假设而主张不拆。现产品形态变为**三端跨网络独立部署、互不同 origin、互不信任彼此内部接口**，该假设不再成立：

1. **部署形态强制分离**：运营端在平台方、企业端在企业、用户端在每个用户本机——物理上就是三套独立交付物，不可能共用一个 origin/一份产物。
2. **受众与信任域分离**：运营端面向平台运营者、企业端面向企业管理员、用户端面向终端用户；三者不再"同一用户跨面"，跨端只剩登录与 pull，单 SPA 角色路由的 UX 理由消失。
3. **独立部署 + 独立交付 + 信任域分叉**三条当初"才值得拆"的条件，现在**全部满足**。
4. 公共能力（设计系统、i18n、timeline 客户端、api-client 基类）抽为**共享前端包**复用，避免重复——拆工程不等于复制代码。

### 12.2 前端目录结构

```text
web/
├── operation/   # 运营端前端（独立工程/独立构建）— 企业开通 / 模板·方案目录 / 跨企业治理看板
├── manager/     # 企业端前端（独立工程/独立构建）— 成员账号 / 招募专家 / 成员级授权 / 企业治理
├── agent/       # 用户端前端（独立工程/独立构建）— 工作台 / 私聊 / 群聊 / 对话页（本地）
└── shared/      # 共享前端包：page-shell / api-client 基类 / timeline-client / role-state / i18n / 设计系统
```

> `web/`（前端）与 `server/`（后端）层优先对称，各端目录一一对应（详见 §14.1 工程目录目标态）；按端独立构建、按端产物精简（§14.2）。旧 `app/static/aiteam/` 保留为只读参考，各端前端**全新重建**（参考旧实现对齐契约，不搬运、不桥接旧代码），由各端服务自身静态托管，不再由中心 Edge 指向统一产物。

每端 `api-client` 基于 `web/shared` 的基类，只调用**本端服务**的 `/api/<tier>/*`（同 origin）。跨系统访问不能由浏览器直调：Operator↔Manager 只能由云侧服务端 `service_client` 发起，Agent→Manager 只能由本机 Agent Service 发起并封装成本端 API。用户端前端只绑定本地 Agent Service 的产品事件，不直接绑定 runtime 原始事件。

### 12.3 各端前端托管（无中心 BFF）

**无中心 Edge Gateway，也就无中心 BFF**：每端服务自服务自己的前端静态资源 + 认证中间件。需要的"轻 BFF"职责（响应裁剪、页面聚合视图）由**各端自己的服务**提供聚合接口完成，不存在跨端 BFF 拼装。跨系统数据获取一律走 §5 的受控服务调用或 Agent 主动访问。

---

## 13. 技术选型

| 关注点 | 选型 | 理由 |
|---|---|---|
| 后端框架 | **FastAPI**（三端各一服务） | 原生 OpenAPI / Swagger / ReDoc；Pydantic 作 API 边界；APIRouter 按模块拆分；异步 SSE/WebSocket/后台任务成熟；Python 资产复用成本最低 |
| 端入口与认证 | 各端服务自带 `shared/auth` 中间件；Manager 是企业租户身份源 | 无中心 Edge；Agent 本地验签；tenant_id 贯穿鉴权（§9） |
| 跨系统通信 | Operator↔Manager 云侧服务间调用；Agent→Manager 主动访问；共享 `service_client` | 通信面窄、用户机器无入站；TLS + 服务身份签名 |
| 端内通信（用户端） | 本地 HTTP/JSON + 本地运行时流式通道 | 运行事件不跨端；落本地库可回放 |
| 数据库 | PostgreSQL；Manager 默认共享表+RLS，预留 schema/db-per-tenant；用户端可用轻量本地库 | 单写者隔离，Manager 租户隔离，Agent 本地优先 |
| 治理数据回流 | Agent→Manager→Operator 脱敏计量/审计摘要上报（§6.5） | 替代跨端事件总线；不上传会话内容 |
| 可观测 | OpenTelemetry + 结构化日志 + Prometheus | 端内 trace 贯穿，跨端透传 trace_id |
| 运行时 | Executor 协议族 + Driver（用户端） | 见 §7 |

不再使用手写 Python HTTP router / `_match_prefix` 分发器；不引入中心消息总线（云侧服务调用 + Agent 主动访问 + 摘要上报即可）。

---

## 14. 部署与运行形态（新增）

系统是**云侧两个控制面交付物 + 用户端本地交付物**：

- **运营端 Operator（平台方部署）**：Operation Service + 运营端前端 + oper 库，公网可达。一套，平台方运维。
- **企业端 Manager（平台托管多租户 SaaS）**：Manager Service + 企业端前端 + manager_control_db + tenant data space + Manager RAG。平台方运维，一套服务服务 N 家企业；企业负责人登录后只访问本 tenant 数据。
- **用户端 Agent（每用户本机自部署）**：Agent Service + 用户端前端 + Agent Gateway + Local Runtime Worker + 本机库；默认仅 localhost。每用户一套。

部署细节：
- **开发（单机模拟三端）**：docker-compose 起 Operator、Manager、Agent 三服务 + oper_db + manager_control_db + tenant data space + 用户端本地库 + 用户端 Local Runtime Worker；沿用 `ctl.sh` 与 macmini 测试环境（schema migration 首次连接自动应用）。**不再需要中心 Edge 与中心消息总线**。
- **生产**：Operator 与 Manager 由平台方部署与运维；Agent 提供安装包/镜像由用户本机部署；Operator↔Manager 走云侧服务间调用，Agent→Manager 走用户端主动访问（TLS）。
- **运行时接入配置**：runtime（含 Hermes）经 Agent Gateway Executor/Driver 接入，CLI 路径/参数/运行环境由对应 Driver 在用户端配置声明（§7.3）；**不再使用旧 `HERMES_WEBUI_*` 环境变量与 `app/.env`**（旧 WebUI loopback 链已废弃）。

### 14.1 工程落点裁决：单仓「层优先（`server/` 后端 + `web/` 前端）→ 端」，`app/` 降级为只读参考

**裁决**：**单仓库**，顶层按层分——`server/`（后端 Python）+ `web/`（前端 JS/TS），各自再按端分子目录；**不拆前端仓/后端仓双仓**。旧 `app/` 整体冻结为旧架构（单体基座）只读参考实现——**只读不写**，v1 全新重建稳定后再删除。

**理由**：
1. **不拆双仓**：一次端内改动常同时动该端前端 + 同端后端 + 跨端契约（认证/摘要 schema）；双仓会逼出两个 PR、版本对不齐、契约漂移。本团队 trunk-based（master 直推），多仓协调税远大于收益。前后端"各自独立构建/部署"靠目录分层 + 独立流水线即可拿到，**仓库边界 ≠ 部署边界**。
2. **层优先（`server/`+`web/`）而非端优先**：因构建期已按端组装产物（见 §14.2），源码布局不必 1:1 镜像部署单元；层优先让前后端各用各的工具链（`server/` 一套 Python、`web/` 一套 JS），共享代码各归各层（`server/shared`、`web/shared`），更顺手。
3. **不复用 `app/` 作新后端根**：`app/` 是冻结的旧单体契约对照基线（状态机/角色/cursor/timeline 以它为事实参照），v1 重建期作为**只读契约参照**保留（新旧不并跑、不互调，§17）；新后端用 `server/`，待旧 `app/` 删除后若需要可再改名回 `app/`，届时无冲突、成本极低。

> 工程目录目标态（单仓，层优先）：
> ```text
> <repo-root>/
> ├── server/                # 后端（Python）
> │   ├── operation_service/ # 运营端：企业开通 / 目录治理 / 跨企业汇总（含运营端认证面）
> │   ├── manager_service/   # 企业端：配置 / 授权 / 成员认证（含企业端认证面）
> │   ├── agent_service/     # 用户端：本地会话与执行（含用户端本地登录）
> │   ├── agent_gateway/     # 用户端运行时接入网关（Executor+Driver），随 agent_service 部署
> │   ├── shared/            # 共享后端包：service_client / auth(验签·鉴权·签发) / 错误模型 / db / schema base
> │   └── run.py             # 统一启动器：--tier=operation|manager|agent（见 §14.2）
> ├── web/                   # 前端（JS/TS）
> │   ├── operation/         # 运营端前端
> │   ├── manager/           # 企业端前端
> │   ├── agent/             # 用户端前端
> │   └── shared/            # 共享前端包：page-shell / api-client 基类 / timeline-client / role-state / i18n / 设计系统
> ├── deploy/                # 三端 docker-compose / 各端 Dockerfile / 安装包 / ctl.sh
> └── app/                   # 🔒 旧架构单体基座——只读契约参考，v1 重建完成后删除
> ```
>
> **无 `edge_gateway/`**：早期目标态中的 `edge_gateway/` 随"取消中心 Edge"裁决删除；其认证职责下沉为 `server/shared/auth` + 各端服务自带入口中间件。
>
> **命名口径**：后端 Python 包名统一用下划线（`agent_service`），维持"后端模块 ↔ 前端目录 ↔ 接口前缀"三处对齐：`server/agent_service` ↔ `web/agent` ↔ `/api/agent`；口语里的 `agent-service` 即指此目录。
>
> **`app/` 无任何运行期例外**：新服务**不读取 `app/.env`、不调用、不反代、不桥接** `app/` 的任何端点，**不与旧系统并跑或双写**。`app/` 仅作**只读契约对照基线**（状态机/角色/cursor/timeline 口径参照，见 §17），不参与 v1 运行链。runtime 启动配置（含 Hermes，经 `AcpExecutor` + `HermesAcpDriver`）由 Agent Gateway Driver 层在用户端自身配置中声明（§7.3），与旧 `HERMES_WEBUI_*` 口径无关——旧 WebUI loopback 执行链已废弃。

### 14.2 统一启动器 + 构建期分端产物

源码单仓共享，但**交付物按端精简**——既要 dev 便利，又要守住"用户端不含控制面代码"的隐私底线：

- **统一启动器（dev 便利）**：后端一个入口 `server/run.py --tier=operation|manager|agent`（或 `APP_TIER` 环境变量），只挂载该端的 router / DB / migrations；本地一条命令起任意端。前端各端独立 dev server。
- **构建期分端（生产/分发）**：CI 按端产出**三个精简产物**，各产物只含本端代码 + 对应 `shared`，互不含对方后端/前端。
- **用户端是硬隔离线**：用户端交付物**绝不打包**运营端/企业端的后端代码与前端界面（隐私 + 最小攻击面）。
- **禁止运行时胖产物**：不做"一个含三端全部代码的产物在运行时 `APP_TIER` 切端"——尤其前端不做"一个 bundle 运行时切端"（那会把控制面 UI 下发到用户浏览器）。`--tier` 只用于 dev 与按端构建入口选择，不等于把三端代码塞进同一交付物。

### 14.3 部署绑定与入户引导（端之间如何互相找到、如何绑定企业）

Manager 已是云侧多租户 SaaS，不再存在"每企业部署一套 Manager 后向 Operator 绑定"。入户链改为：Operator 开通企业并在 Manager 创建 tenant；用户端 Agent 绑定到 Manager tenant。

1. **运营端开通企业**：Operator 创建企业记录，生成 `enterprise_id` / `tenant_id` + 负责人 bootstrap 凭据（手机号+初始密码）。
2. **Operator 同步 Manager**：Operator 调 Manager 创建 tenant，传企业基础信息、负责人 bootstrap、初始配额/可见目录策略；Manager 初始化租户数据空间、默认角色、默认部门、默认知识空间。
3. **负责人首次登录 Manager**：负责人访问 Manager 企业登录页，使用 bootstrap 登录并强制重置密码；此后负责人长期凭据由 Manager tenant 持有。
4. **用户端首次绑定**：Agent 安装时配置 `MANAGER_URL` + 企业邀请码/租户标识；成员按 §9.4-C 首次在线登录，登录成功即完成 Agent↔Manager tenant 绑定（领取 token + 验签材料）。
5. **地址变更**：Manager 地址变更通过安装包参数/二维码/配置串/企业通知渠道下发；Agent 持久化 Manager 地址，访问失败按 §5 降级（已登录/已装载本地继续可用）。

> `tenant_id` 生成规则、企业邀请码/配置串格式、Operator↔Manager 服务身份密钥建立、Agent 验签材料下发留详设；本节定死的是**"Operator 创建企业并在 Manager 建 tenant → 负责人登录 Manager → Agent 绑定 Manager tenant"**。

---

## 15. 复杂度分析

- **拆分复杂度**：仅按部署边界拆三端（运营端/企业端/用户端）+ 用户端内 Agent Gateway，不继续细拆为大量小服务。
- **Gateway 抽象复杂度**：只抽象真实存在的协议族（ACP / JSON-RPC stdio / JSON stream CLI），不为假想 runtime 设计复杂插件系统。
- **跨端一致性复杂度**：Operator↔Manager 云侧服务调用 + Agent→Manager 主动访问 + 摘要上报，无中心总线、无分布式事务；本地优先 + 幂等，最终一致即可。
- **Manager 多租户复杂度**：所有租户数据访问统一收敛到 TenantContext/TenantDataSession/TenantRagClient，不允许各业务模块手写 tenant 过滤。
- **事件一致性复杂度**：运行事件留本地，先落稳定内部结构再映射 timeline；前端不解析 runtime 原始 JSON；跨端只见脱敏摘要。
- **配置一致性复杂度**：用户端 pull 配置投影 + 执行前固化 EmployeeExecutionSnapshot，run 只引用 snapshot version。
- **认证复杂度**：Manager 多租户身份源 + 共享库本地验签；多样性收敛到 Authenticator 一层。
- **安全隔离复杂度**：见 §11.4。

---

## 16. 风险与约束

### 16.1 技术风险

1. **拆分过细反噬** → 只拆三端 + 用户端内 Agent Gateway。
2. **Gateway 抽象过度泛化** → 只抽象真实协议族。
3. **Driver 泄漏业务语义** → Driver 只解析 runtime 事件，不懂企业/员工/账单/权限。
4. **用户端 Agent 漂移成 Manager** → 只消费拉取的员工快照，不维护配置主数据。
5. **企业端 Manager 漂移成 Runtime** → 只管配置/授权/认证，不提交执行、不处理 runtime 原始事件、不持会话。
6. **事件原始数据泄漏** → raw event 仅本地调试归档（脱敏受控），前端/审计消费脱敏产品事件。
7. **隐私承诺被破坏（会话/内容上传）** → 跨端只准流转认证/授权配置/脱敏摘要；脱敏在用户端上报前完成；评审与测试必须验证"无内容外泄"。
8. **跨端可用性硬依赖** → Manager 离线只影响"拉新配置/新登录/摘要上报"，已登录用户凭本地 token + 本地投影继续工作；快照/授权缺失时拒绝执行而非陈旧硬跑。
9. **租户数据串线** → PostgreSQL RLS + `tenant_id` 复合约束 + TenantDataSession 强制设置 `app.tenant_id`；LightRAG workspace 只能由 ManagerRagService 从 TenantContext 推导。
10. **签名密钥扩散** → 禁止向用户端下发可签发 token 的对称密钥；v1 直接采用 Manager tenant 私钥签发、Agent 公钥/JWKS 验签，企业间天然隔离。
11. **退化成"伪三端共址"** → 禁止跨系统共享业务库、禁止 Manager/Operator 向用户机器入站推送、禁止把会话态外置到 Manager。
12. **streaming 主链路 big-bang 无验证重写破坏演示** → 全新重建，逐模块对照冻结契约基线验证 parity（不与旧系统并跑/切流，见 §17）。

### 16.2 工程约束

- 新服务统一 FastAPI；不再扩写手写 router。
- 不再依赖 Hermes WebUI loopback 作生产执行链路。
- 不为旧内部模块保留兼容层；不与旧系统双写、不桥接/反代旧 `app/` 端点、不迁移旧库数据。
- 北向路径按 §10 统一收口；旧路径切换后删除。
- **Loop / 周期任务仅在用户端运行期间执行**（本地优先的固有取舍）：用户端关机即不跑，不做服务端常驻调度代用户执行；这是产品取舍而非缺陷，前端需对用户明示。
- AI Team 业务逻辑不写进 `./.hermes/hermes-agent/`；必须改 Hermes 时只做最小补丁或可复用增强。
- 详设须补齐：各系统表所有权映射、Manager 租户隔离 DDL/RLS、LightRAG workspace 路由、各端 API schema、跨系统契约、脱敏摘要 schema、executor/driver contract、验证矩阵。

---

## 17. 重建与验证策略（新增）

v1 是**全新重建**：不与旧系统并跑、不切流、不桥接/反代旧 `app/` 端点、不迁移旧库数据。"全新重建"不等于"无验证"——重建结果必须对照**冻结的契约基线**独立验证。

- **契约基线（验证靶子）**：以只读冻结的旧 `app/` 为业务契约事实参照——其北向路由实现、`app/static/aiteam/` 前端真实调用、`app/tests/aiteam/` 的 L2/L4 契约测试，共同构成新实现要对齐的**业务契约基线**。验证是"新实现 vs 静态契约基线"，**不是"新实现 vs 运行中的旧系统"**。旧测试仅作**行为参照**用于理解期望覆盖面；新服务编写**自己的**契约/集成测试（针对新 OpenAPI 与新库），**不复用旧测试代码、不依赖旧测试运行环境**。
- **DB 写路径**：各端全新建库、各自写路径；不与旧库双写、不导入旧数据（§6.4）。
- **Streaming / Timeline 主链路（高风险）**：**全新重建**。逐模块实现并校验北向 `event: timeline` 事件 parity（事件类型、顺序、cursor、payload 关键字段）是否符合契约基线，逐模块验证通过再推进下一模块。这是有验证的重建，符合 CLAUDE.md §10.4「完成前必须独立验证」。
- **验证环境**：parity 校验在**单机模拟三端的 dev/test 环境**（macmini 共址跑三端新服务）完成，**不在分发到用户机器后才验证**；只有 parity 通过的产物才进入按端分发（§14.2）。
- **推进节奏**：逐模块重建、逐模块对照基线验证、验证通过即定稿；旧 `app/` 全程只读保留作参照，全部模块重建并验证通过后整体删除 `app/`。

---

## 18. 阶段实施建议

### Phase 0：架构冻结
冻结 Operator/Manager/Agent 三系统边界与部署形态、Manager 多租户隔离底座、用户端 Agent Gateway executor/driver 抽象、事件双层模型、数据所有权、跨系统通信面、Manager 租户身份模型、成员级授权、外部能力归属（§6.6）、入户链（§14.3）、治理摘要上报、路径收口、API 文档与接口格式规范（§10.3）。
产物：本概要设计定稿、三系统边界 ADR、Manager 多租户隔离 ADR、Gateway runtime contract 草案、各端 OpenAPI + 跨系统契约草案、统一响应 envelope 与 problem+json 错误模型草案、各系统表所有权与 schema 草案（全新建库，非旧表搬迁）、脱敏摘要 schema 草案、入户流程草案。

### Phase 1：三系统骨架 + Manager 多租户底座 + 入户认证
建立 Operation/Manager/Agent 三端 FastAPI 服务骨架（各自前端壳）；统一错误模型、`shared/auth` 验签中间件、request-id/trace、共享 `service_client`、各端 OpenAPI；**Manager 多租户底座打通**（tenant_registry、TenantContext、TenantDataSession、PostgreSQL RLS、TenantRagClient workspace 路由）；**入户链打通**（Operator 开通企业并创建 Manager tenant → 负责人登录 Manager → Manager 创建成员 → Agent 首次在线登录+本地 token）；用户端 Agent Gateway skeleton + fake runtime。
验收：三端各自 `/healthz` `/readyz` `/openapi.json` `/docs` `/redoc` 可访问；CI 可生成三端 OpenAPI 与跨系统契约并通过 schema/operation_id/错误响应/envelope 质量门禁；Operator 能创建企业并在 Manager 生成 tenant；负责人/成员两类登录全链路可走通；RLS 测试证明跨 tenant 查询被拒；LightRAG workspace 路由测试证明 tenant A/B 检索隔离；Agent 访问 Manager 鉴权成功；fake runtime 产生 text/reasoning/tool/usage/completed 事件并映射为本地 timeline。

### Phase 2：Manager 租户配置授权 + 用户端本地主链
Manager 承接租户内员工/专家配置、知识、技能、连接器、招募专家、应用方案、**部门/成员级授权**；用户端承接本地 conversation/run/task/event/loop；Agent pull 已授权专家/方案 → 本地装载 → EmployeeExecutionSnapshot 冻结。
验收：Manager 租户 A 授权某专家给某成员 → 该成员 Agent pull 装载；租户 B 不可见；本地私聊主链打通、群聊（本地多专家）入口打通、Loop 基础任务打通、事件实时推送 + 历史回放；streaming 主链路逐模块对照契约基线完成首批 parity 验证；验证会话内容不外泄。

### Phase 3：Runtime 接入（用户端）
实现 AcpExecutor + HermesAcpDriver；JsonRpcStdioExecutor + CodexJsonRpcDriver；JsonStreamCliExecutor + ClaudeCode/OpenCode/OpenClaw driver。
验收：每个 driver 有 golden raw event → AgentRuntimeEvent 测试；每个 executor 有取消/超时/stderr/异常退出测试；对话页能展示工具调用输入输出。

### Phase 4：运营端 + 治理闭环（摘要上报）
Operator 承接企业开通、负责人 bootstrap/重置、平台模板/行业方案目录、平台治理；Agent→Manager→Operator **脱敏计量/审计摘要逐级上报**汇总。
验收：Operator 可开通企业并在 Manager 创建 tenant；Manager 可招募专家/应用方案并查成员级用量与审计汇总；Operator 跨企业运营看板可读；全程不含会话内容。

---

## 19. 非目标

- 完整开放平台插件市场。
- 大规模云调度与租户容器编排细节。
- 移动端新架构。
- 真实支付 / 短信 / 企业微信等外部 provider 深度联调。
- 对旧内部 router / adapter / DTO 的兼容迁移方案。
- gRPC 全面铺开（仅按热点剖析按需升级）。
- **跨用户实时协作**（如多个用户机器间共享同一群聊会话）——群聊只是单用户本机多专家协作，不做跨机器会话同步。
- **会话内容/执行明细上云**——本地优先、内容不出端是硬约束，云端 worker 仅作企业显式选择的可选项。
- **中心化 Edge Gateway / 中心 Identity 服务 / 中心消息总线**——已被 Manager 多租户身份源、Agent 本地验签与窄通信面取代，不重新引入。

---

## 20. 已决裁决与待评审

### 20.1 本文已裁决（地基定型）

| 编号 | 议题 | 裁决 |
|---|---|---|
| D1 | 架构形态 | **Operator 平台运营 SaaS + Manager 多租户企业管理 SaaS + Agent 用户本地数据面**；用户端内含 Agent Gateway。〔再次修订早期"Manager 企业自部署"〕 |
| D2 | 北向路径 | 统一 `/api/operation` `/api/manager` `/api/agent`，弃用旧 `/api/team` `/api/system` `/api/enterprise`，不留 alias；每端在自己 origin 下暴露，含各自 `/api/auth/*` |
| D3 | 前端 | **三套独立前端工程，按端分离**（`web/operation` `web/manager` `web/agent` + `web/shared`），各端自托管。〔**推翻**早期"单一 SPA 不拆前端"——部署/受众/信任域已强制分离〕 |
| D4 | 通信 | Operator↔Manager 为云侧受控服务间调用；Agent→Manager 为用户端主动访问；Agent 运行事件只在用户端本地；**无中心消息总线**。〔修订早期"全链路单向 pull"〕 |
| D5 | 员工/专家快照 | 用户端装载专家/提交 run 时从 Manager 拉取并冻结，落用户端本地库 |
| D6 | Raw event 归档 | 保留，**仅用户端本地**脱敏受控归档、设保留期，仅调试，不跨端 |
| D7 | Runtime Worker | 用户端 Local Worker 为默认主形态；Daemon 同步设计后置；Cloud 默认关闭（与"本地优先"相悖） |
| D8 | 认证 | **Manager 多租户身份源 + Agent 本地验签**：Operator 持系统账号与负责人 bootstrap 来源；Manager 按 tenant 持负责人/成员凭据与签名密钥；Agent 只持本会话 token；token 必带 `tenant_id`；`user`+`auth_identity`+`Authenticator` 扩展点 + 单一 token 出口；验签/鉴权/签发为共享库 `shared/auth`。**无中心 Edge**。 |
| D9 | 端入口形态 | **取消中心 Edge Gateway**；认证/限流/CORS 下沉为各端服务自带 `shared/auth` 中间件。〔**推翻**早期"轻量 Edge 反代/单 origin"〕 |
| D10 | 后端框架 | FastAPI，弃用手写 router |
| D11 | 工程落点 | **单仓，层优先**：`server/`（后端，按端分 `*_service/` + `agent_gateway/` + `shared/`）+ `web/`（前端，按端分 + `shared/`）；**无 `edge_gateway/`**；`app/` 冻结只读、v1 重建完成后删除，**仅作只读契约参照、不参与运行链**；新服务不读 `app/.env`、不用 `HERMES_WEBUI_*`、不调用/不桥接/不双写旧 `app/`（§14.1） |
| D12 | 配置下发与授权 | Manager 租户内招募专家/应用方案时指定**部门/成员级授权**；Agent **主动 pull** 已授权条目本地装载；不靠向用户机器推送 |
| D13 | 本地优先与隐私 | 会话/群聊/run/raw runtime event **全本地、内容不上传 Manager/Operator**；跨端只流转认证、授权配置、执行快照、**脱敏计量/审计摘要**逐级汇总 |
| D14 | 跨端可用性 | Manager 短暂离线只影响"拉新配置/新登录/摘要上报"；已登录用户凭本地 token + 本地投影 + 已冻结快照继续工作 |
| D15 | 仓库与构建 | **单仓不拆双仓**；后端统一启动器 `run.py --tier=...`（dev 便利）；**构建期按端产出三个精简产物**，用户端绝不含控制面代码；禁止运行时胖产物/前端运行时切端（§14.2） |
| D16 | 能力适配 | **中立 `RunSpec` + 能力经 `mcp_config` 统一注入 + Driver 按 runtime 翻译（优先 flag/协议、弃用 profile 文件直写）**；借鉴 multica `server/pkg/agent` 设计（Python 重实现）。旧 `SOUL.md`/`MEMORY.md`/`skills/`/`config.yaml` 直写废弃（§7.5） |
| D17 | 记忆组件 | 记忆复用 **mem0（OpenMemory 本地优先 MCP）**，与知识库 **LightRAG** 并列、均经 MCP 注入；二者职责互补（记忆 vs 文档检索），AI Team 只做封装与本地装配（§6.6/§7.5） |
| D18 | 模型供应商凭据 | **默认走 AI Relay**（用户机器只持 Relay 端点+受限令牌，真实 key 留 Relay 侧）、可选直连 provider；Manager 管理、本地最小注入、不写共享 profile；`RunSpec.provider_ref` 引用。**LLM/Relay 调用不属于"会话内容上传控制面"的禁止项**（§6.7） |
| D19 | 编排/Loop 归属 | 触发与编排是**用户端 Agent Service** 职责，统一收敛为"构造 RunSpec → Gateway"；Loop 由**本地调度器**驱动、不依赖 `hermes cron`、仅运行期执行；群聊=单机多专家、多 run 并入同一时间线（§7.6） |
| D20 | Manager 多租户隔离 | Manager 默认 PostgreSQL 共享表 + `tenant_id` + RLS，业务代码只能经 TenantContext/TenantDataSession 访问；预留 schema-per-tenant/db-per-tenant TenantRouter 演进能力（§6.1.1） |
| D21 | Manager RAG 隔离 | LightRAG 以 `workspace = tenant_id + knowledge_space_id` 隔离；只能经 ManagerRagService 从 TenantContext 推导 workspace，禁止前端/Agent 直接传 workspace 或直连 LightRAG Server（§6.1.2） |
| D22 | Manager 非 DB 资源隔离 | 对象存储、缓存、队列/outbox、审计、日志/trace 全部必须带 `tenant_id` 并经 TenantContext 派生，禁止业务模块手写 tenant 字符串（§6.1.3） |
| D23 | Token 签名密钥 | v1 直接采用非对称签名；Manager 按 tenant 持私钥，Agent 只持公钥/JWKS 验签；禁止向用户端下发 HMAC 对称签名密钥（§9.5） |
| D24 | 配额与账单控制 | 默认软配额 + 事后治理，不做每 run 强制 quota lease；可选硬配额模式必须显式牺牲离线可用性（§6.5.1） |

### 20.2 待详设裁决

1. 认证已定：Manager 多租户身份源、Agent 本地验签、无中心 Edge、非对称签名（§9）。详设细化 Operator/Manager/Agent 认证面内部模块边界、refresh 轮换策略、tenant JWKS 分发与 key rotation。
2. Manager PostgreSQL 多租户 DDL/RLS 细节：哪些表 L1 共享表、哪些租户可升级 L2/L3、连接池如何强制 `SET LOCAL app.tenant_id`、RLS 回归测试矩阵。
3. Manager LightRAG workspace 细节：workspace 命名、实例池、PGKV/PGVector/PGDocStatus 表 RLS、知识空间升级/删除/重建策略。
4. 跨系统接口的完整契约（Operator↔Manager 企业/目录/模板包/汇总；Agent→Manager 认证、拉授权配置、摘要上报）与轮询/通知节奏、增量协议；契约必须由 OpenAPI/Pydantic schema 生成或校验，遵守 §10.3 的 envelope、错误模型、分页、幂等与版本规则。
5. 脱敏计量/审计**摘要 schema** 与脱敏字段清单（哪些字段可上报、哪些必须留本地），以及软配额告警、冻结新增招募、禁止新快照下发等治理动作的触发规则。
6. `runtime_session/raw_runtime_event` 在用户端本地库的归属与保留期。
7. Operator→Manager "招募专家/行业方案应用包"的拉取契约、版本与幂等边界。
8. 各系统表 → 写端 → 目标库（部署位置）的 schema 设计（详设产出，全新建库、不迁旧数据）；会话类表在用户端本地全新落地的口径。
9. 外部能力本地化（§6.6）：知识索引按授权集的切分/增量拉取/缓存淘汰策略；技能包与连接器凭据的本地分发与回收。
10. 入户链（§14.3）：企业邀请码/配置串格式、Operator↔Manager 服务身份密钥建立、用户端 `MANAGER_URL` 下发载体（二维码/配置串）格式、Agent 验签材料下发细节。
11. 模型供应商（§6.7）：AI Relay 令牌的签发/作用域/轮换、直连 provider 凭据的本地注入与回收、provider 配置的成员级授权与 pull 契约。
12. 记忆（§6.6/§7.5）：mem0/OpenMemory 本地部署形态、`memory_policy` 与种子记忆 schema、记忆作用域（员工/会话级）与保留期、跨 runtime 迁移口径。
13. 本地编排与 Loop（§7.6）：本地调度器实现/持久化、群聊多专家串并行调度与防回环策略、runtime 手动切换口径。
