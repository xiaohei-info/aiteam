# 天问可信数据空间 · AI Agent 能力概要设计

> 文档版本：v1.0 | 编写人：微贷数据团队 · 隐私计算平台
> 阶段：概要设计 | 对齐标准：《可信数据空间 技术架构》(TC609—6—2025—01)
> 关联文档：《天问可信数据空间技术总结》《天问可信数据空间建设规划》

---

## 一、需求背景与分析

### 1.1 背景

《天问可信数据空间建设规划》v2.0 把 **Agent 智能交互层**列为平台五层架构中 Application（应用层）的能力模块，并在国标映射表中标注为"扩展项"。也就是说，Agent 不是天问平台的附加功能，而是可信数据空间对外交互范式（LUI+GUI 融合）的载体。建设规划里已经规划、但还没有承载主体的 Agent 相关能力有：自然语言驱动的资产查询与授权（3.8.1）、联邦学习 Agent 自动化编排联合建模全流程（3.5）、Agent 驱动的自动化特征评估流水线（3.6）、模型效果与稳定性的智能监控（3.10）。`tianwen-ai` 负责承接这些规划，把「Agent 智能交互层」落成可运行的系统。

天问平台已有完整的隐私计算业务闭环（AMS 数据资产、Workbench 任务编排、Server 节点运维），`tianwen-mcp` 也把 SecretPad OpenAPI 全量桥接成了 MCP 工具，"AI 可操作平台"的技术基础已经具备。但这些目前只停留在工具层，还没有统一的智能体运行时把工具编排成面向真实用户的对话式能力。

### 1.2 平台定位：可信数据空间的智能体能力核心引擎

`tianwen-ai` 的定位不是"聊天窗口加几个工具调用"，而是天问可信数据空间在 Application 层的智能体能力引擎：同一个 Data Agent，按使用者权限开放两个入口，能力由浅到深分三层。

**一个类比：这是 Data Agent，只是数据不出域。** OpenAI 在内部数据智能体实践中提到，分析师的时间大量耗在"找对表、写对 SQL、看懂报错"上，而不是真正的分析判断；他们的数据智能体承接了发现数据、生成查询、执行、诊断异常、汇总结果的完整闭环。`tianwen-ai` 面对的问题与此同构：业务方同样卡在"找对数据集、配对 CCL 权限、编排对 Graph、看懂跨节点报错"上。差别在于，天问的 Agent 不能直接对数据跑 SQL，要驱动 PSI/SCQL 这类隐私计算协议去操作双边或多边、彼此不出域的数据。做的事情仍然是"理解数据、编排计算、诊断异常、解读结果"，只是执行介质从明文 SQL 换成了隐私计算协议。这个类比有两层含义：一是 Agent 的价值不止于"帮忙点按钮"，它应该像数据智能体一样辅助业务方做数据判断；二是 Data Agent 领域验证过的经验（多层上下文喂给模型、记忆机制沉淀隐性知识、用黄金用例做质量回归）同样适用于天问，具体设计见 5.4、5.5、5.8 节。

**两个入口，同一个 Agent，权限不同**（详细设计见 4.1.1 节）：

- **业务用户入口**：只开放"帮我完成业务流程"这类能力，不能触碰平台底层高危操作。
  1. **基础能力**：智能任务执行、排错、取数。把"发起 PSI 任务要经过 Graph 编排 5+ 步骤"收敛成"帮我跟宁银消金跑个 PSI"一句话；把现在完全靠平台 RD 人肉排查的报错定位、数据类型校验、SCQL/CCL 调试，交给 Agent 自主诊断（见 1.3 节）。这一层是 Agent 能力的地基，决定业务方能否脱离 RD 陪同独立使用平台。
  2. **高级能力**：双边联合客群洞察、可信空间内的数据价值发现。基于平台已有的 PSI（隐私求交）、SCQL（联合分析）等技术，Agent 承接建设规划 3.5～3.6 节规划的能力：自动编排联合建模全流程、驱动特征评估流水线、对双方客群做交叉洞察分析、在已授权资产范围内发现有价值的数据组合与特征。这一层是从"帮用户执行任务"走到"帮用户发现价值"。
- **平台 RD 入口**：包含业务用户入口的全部能力，再叠加平台底层运维能力。对应建设规划 3.9～3.10 节的 Control Panel 任务管控与模型监控，Agent 承接节点健康诊断、任务异常根因分析、模型效果与稳定性监控告警的自动处理，以及服务器操作、系统升级等只有 RD 能触碰的高危操作，把 RD 从"人肉巡检 + 逐个任务兜底"里解放出来，让有限的人力聚焦在 Agent 处理不了的深层问题上。

其中业务用户入口的基础能力是当前最紧迫的部分（见 1.3 节），高级能力和 RD 入口的运维能力与基础能力共用同一套 Agent Runtime 与工具治理机制，具体推进节奏不在本设计文档中划分，按后续实际情况另行安排。

### 1.3 核心痛点：业务无法独立跑通隐私计算任务，全程依赖平台 RD 人肉兜底

这是 `tianwen-ai` 立项的直接原因。当前的现状不是"体验差"，而是业务方基本不具备独立完成任务的能力。

**根因是隐私计算的专业门槛和业务方认知水平之间的结构性差距。** 隐私计算的流程与概念（Graph 编排、节点、CCL 权限、SCQL 语法）本身不好理解，对数据内容、类型的定义要求也严格，业务用户只靠一份 SOP 文档，基本不可能一次性独立跑通一个完整任务。更难办的是，流程里任意一个环节都可能因为业务方不熟悉底层机制而出问题，而问题一旦出现，只能由平台 RD 人工排查，业务方自己无法判断问题出在哪一层、该怎么修。具体表现：

- **数据类型定义不严格，反复试错**：数据上传时没严格定义类型，后续会因类型转换失败报错，要对着报错反复调整。典型场景是数据清洗不到位，本该是 `int` 的字段混入大量空字符串，任务跑到类型转换阶段才暴露，业务方既不知道要先查数据质量，也不知道该看哪个环节的报错。
- **报错信息看不懂，只能找 RD 定位**：任务抛出的错误对业务方基本不可读。本方节点报错，要登录服务器翻日志才能定位根因；对方机构节点报错，还要协调对方技术人员提供信息才能继续排查。这两种情况业务方都搞不定，必须由平台 RD 跨节点介入。
- **SCQL 语法与 CCL 权限反复调整**：用 SCQL 做联合分析时，语法错误和 CCL（Column Control List，列级权限控制）配置不当会让任务反复报错，要调很多轮才能跑通。对不熟悉 SCQL 底层机制的业务方，这几乎是过不去的门槛。

**结果**：业务方用平台做任何任务，都要平台 RD 全程跟进、逐环节兜底，否则推不动。平台侧人力本来就紧，"每个任务都要 RD 手把手带"的模式成了规模化推广的瓶颈：业务增长越快、接入机构越多，RD 兜底负担越重，是个负向循环。

`tianwen-ai`（其平台 RD 入口）承接其中可结构化、可自动诊断的排查工作（数据类型校验、报错信息翻译、跨节点日志比对、SCQL 语法与 CCL 权限检查），能直接释放 RD 人力，也让业务方在没有 RD 实时陪同的情况下推进任务、自己处理常见问题。这就是 1.2 节「基础能力」里「智能排错」排在最前面的立项理由。

### 1.4 现状分析

天问平台现有可直接复用的能力：

- **统一身份认证**：`tianwen-common/sso` 已实现完整的 OIDC 能力（授权码模式、TokenExchange 换票、Token Introspection、UserInfo），并在晓笛 A2A 接入中验证了 D1（用户一级权限）/ D2（应用代理访问权限）/ D3（用户运行时同意）三重校验模型。
- **跨节点指令通道**：`tianwen-server` 的 `ConnectionManager`（`server/ws/manager.py`）实现了节点 WebSocket 长连接管理、指令下发与响应关联（`send_instruction` / `resolve_instruction`），节点侧的 `tianwen-agent` 守护进程（Python，与本文档的主体 `tianwen-ai` 是两个不同组件，见 1.6 术语表）对指令执行有严格的白名单限制（镜像前缀、文件路径、脚本路径三个维度）。
- **AI 工具桥接**：`tianwen-mcp` 已把 SecretPad 全部 OpenAPI 接口暴露为 MCP 工具（自动登录维持 User-Token）。
- **数据分级与脱敏**：AMS 的 C1-C4 安全分级和字段级脱敏引擎，已经划定了"哪些数据 Agent 能看、能说"的边界。
- **审计基础设施**：AMS 的 WAL 审计（先写后处理、不可篡改）是平台级基础设施，可直接扩展来记录 Agent 的操作行为。

`tianwen-ai` 需要新建的部分：Agent 运行时（对话状态管理、工具编排）、面向天问业务的工具集（对接 AMS/Workbench/Server 现有 API）、操作确认与风险分级机制、AI 可观测性接入（Langfuse）。

### 1.5 要解决什么问题

本概要设计回答七个问题：

1. Agent 运行时如何在多用户并发、水平扩展的前提下管理会话状态？
2. 工具调用如何继承而非绕过既有权限体系，避免"Agent 拥有超越用户本身的权限"这个根本性的安全风险？
3. 哪些操作允许 Agent 自主执行、哪些必须经用户确认，判定标准是什么？
4. 数据、任务、运维多个业务域的能力怎么组织，才不会变成无所不包、难以维护的巨石 Agent？
5. Agent 的行为如何被观测、审计、持续迭代，而不是黑盒运行、出问题靠猜？
6. 对 1.3 节的三类痛点（数据类型报错、双方节点报错定位、SCQL/CCL 反复调试），Agent 分别用什么机制承接，与 RD 现在的人肉排查动作怎么一一对应？
7. 1.2 节的高级能力（客群洞察、数据价值发现）和 RD 侧运维能力，怎么在不推翻基础能力架构的前提下渐进叠加？

### 1.6 术语定义

| 术语                         | 定义                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| Agent Runtime                | 负责对话状态管理、模型调用、工具编排的核心执行引擎                                      |
| Session（会话）              | 一次连续对话的逻辑单元，对应一个`session_id`；会话内容以 Pi 原生 jsonl 文件持久化于共享文件系统（事实源），MySQL 仅存会话元数据（`user_id`/文件路径/锁等）                          |
| Checkpoint（检查点）         | 本设计**不引入**独立 Checkpoint 持久化层。Pi 原生无 checkpointer 原语，但其 session 文件（append-only entry 树）本身即 checkpoint 等价物——故障恢复时从最后一条 entry 继续，HITL 暂停点 = 被 block 的工具调用 entry 位置（5.1、5.3 节） |
| Tool（工具）                 | Agent 可调用的、对接某个后端 API 的具名函数，是 Agent 与天问既有服务的唯一交互方式      |
| HITL（Human-in-the-loop）    | 人工介入：Agent 执行到风险节点时暂停，等待用户确认后再继续                              |
| 风险分级                     | 对工具调用按影响面（只读 / 可逆写 / 不可逆写 / 跨机构）划分的执行前风险等级             |
| 租户上下文（Tenant Context） | 贯穿一次请求全生命周期的用户身份与权限范围，从入口传递到每一次工具调用                  |
| Pooled 部署模型              | 多租户共享同一批无状态 Agent 实例，与 Siloed（按租户独立实例）相对                      |
| `pi-coding-agent`（Pi）      | `tianwen-ai` Agent Runtime 所基于的开源终端编码 Agent harness，提供 `AgentSession`、内置工具与 Extension 扩展机制（3.1 节） |
| Gondolin                     | Pi 生态官方验证的 microVM 隔离方案，`tianwen-ai` 用它承载文件/命令类内置工具的实际执行（5.4a 节） |
| 隔离执行环境                 | Agent 运行时层的标准组件之一，基于 Gondolin 为每个会话按需提供强隔离的代码执行沙箱（4.1、5.4a 节） |
| `tianwen-ai`                  | 本文档的主体：新建的 AI Agent 服务（Node.js/TypeScript），基于 `pi-coding-agent` 构建，承载 Agent 智能交互层 |
| `tianwen-agent`               | **既有、独立的节点侧守护进程（Python，`tianwen-agent/agent.py`）**，与 `tianwen-ai` 是两个不同组件。它部署在各计算节点上，通过 WebSocket 接 `tianwen-server` 的 `ConnectionManager`，按指令白名单（镜像前缀/文件路径/脚本路径）执行 image_load/docker_run/kubectl_apply 等节点操作。`tianwen-ai` 的运维域工具复用 `ConnectionManager` 间接驱动它，但两者代码库、语言、职责均不同，勿因名称相近混淆 |
| `ConnectionManager`         | `tianwen-server` 的 WebSocket 长连接管理模块（`server/ws/manager.py`），负责节点指令下发与响应关联，`tianwen-ai` 运维域工具复用其 `send_instruction` 能力（节点侧由 `tianwen-agent` 守护进程执行） |

---

## 二、设计目标

### 2.1 功能目标

按 1.2 节的三层划分表述功能目标，架构（第四章）同时容纳三层，详细设计（第五章）目前覆盖第一层，二、三层的详细设计随其推进节奏再展开。

**第一层（业务用户·基础能力）**：

- 自然语言驱动的数据上传、授权、建项目、发起 PSI/FL/SCQL 任务全流程操作。
- 带上下文（错误信息、任务 ID、节点 ID）的异常排查会话，能跨节点取日志、给出结构化的诊断结论。
- 会话可持续、可恢复：网络中断、服务重启后能在原会话继续对话，不丢上下文。
- 高风险操作（授权、跨机构建项目、批量删除）执行前必须经用户显式确认。

**第二层（业务用户·高级能力）**：这一层让 `tianwen-ai` 从"隐私计算任务操作助手"变成数据智能体，推理模式、上下文体系和质量保障的独立设计见 5.5 节：

- 基于已授权的双边数据，支持自然语言驱动的联合客群洞察分析。复用 PSI/SCQL 基础能力，Agent 负责编排查询和解读结果，不重新实现隐私计算逻辑；推理是自主的多轮探索，不是单次工具调用（5.5.1 节）。
- 在用户已有的资产授权范围内，主动发现有价值的特征组合并给出建模/分析建议，而不是被动等用户提出分析诉求（5.5.6 节）。

**第三层（平台 RD·智能运维）**：

- 节点健康、任务异常、模型效果与稳定性指标的智能巡检与根因分析，覆盖建设规划 3.9～3.10 节的 Control Panel 与模型监控场景。**"智能巡检"特指由定时调度/事件总线驱动、脱离具体用户会话的后台任务，与本文档 5.1 节按用户请求驱动的无状态会话模型是两套机制，其调度基础设施不在本文档设计范围内（详见 5.5.6 节边界说明与第七章）**；RD 在会话中主动问"某节点现在健康状况如何"，属于第一层的实时查询能力，走的仍是正常的会话内工具调用。

### 2.2 非功能目标

| 维度         | 目标                                                                                  |
| ------------ | ------------------------------------------------------------------------------------- |
| 并发与扩展性 | Agent 后端无状态，可水平扩展到多实例；单实例故障不影响其他会话                        |
| 安全性       | Agent 工具调用权限严格不超过发起用户本身权限；高风险操作强制人工确认；文件/命令类工具的执行环境与宿主及其他会话强隔离（5.4a 节） |
| 可观测性     | 全部会话接入 Langfuse Trace；核心指标（token 消耗、工具调用成功率、单用户成本）可查询 |
| 可维护性     | System Prompt / 工具描述独立版本化，无需重新发布服务即可迭代                          |
| 性能         | 工具调用超时与既有 API 超时策略一致；不预设首字节延迟的具体数值指标——延迟高度依赖模型推理和工具调用耗时，先上线积累真实数据，再基于线上分布制定有意义的 SLO，而不是拍一个缺乏依据的数字 |

### 2.3 设计原则

**权限不放大**：Agent 不引入任何独立于现有用户权限体系之外的新权限来源。Agent 调工具时携带的身份就是发起对话的用户本人，工具内部的权限校验与用户直接调 API 时完全一致。Agent 只是操作路径的转译层，不是新的信任根。

**最小职责边界**：`tianwen-ai` 不重新实现任何业务逻辑，工具集是对 AMS / Workbench / Server 既有 API 的直接封装。业务规则变了只需要改对应服务，不用同步改 Agent。

**无状态优先**：Agent 后端进程不持有跨请求的会话状态，全部外置到共享文件系统（会话内容，事实源）+ MySQL（会话元数据/锁），靠 `session_id` 重建。这是水平扩展和故障恢复的前提，也省掉了为 Agent 单独搞一套有状态部署运维体系的成本。

**风险分级驱动确认**：不是每个工具调用都要确认，也不是都不要，用一张显式的风险分级规则表驱动，而不是每加一个工具就临时决定一次。

**渐进式建设**：不搞"全部设计完才上线第一个可用能力"，先打通"对话 → 只读工具查询 → 流式返回"的最小闭环、验证 Agent Runtime 与工具编排机制，再叠加写操作工具、HITL 确认机制与异常排查场景。具体如何划分推进节奏，按后续实际情况另行安排，不在本设计文档中限定。

---

## 三、备选方案设计与评估

### 3.1 技术栈：Node.js + TypeScript，由 SDK 形态硬约束决定

`tianwen-ai` 的 Agent Runtime 基于 **`@earendil-works/pi-coding-agent`**（社区代号 Pi，一个开源、可编程扩展的终端编码 Agent harness）构建。这不是众多可选 SDK 里挑出来的一个，而是经调研后确认的事实性约束：Pi 生态（`pi-ai` 统一模型 API、`pi-agent-core` Agent 运行时、`pi-coding-agent` 编码 Agent harness）全部只有 npm 包形态，无 Python 或其他语言实现，`pi-agent-core` README 明确要求 Node.js ≥ 22.19。因此技术栈锁定为 **Node.js + TypeScript**，不是团队偏好，是选定 SDK 后唯一成立的路线。

`pi-coding-agent` 提供 `createAgentSession()` SDK 入口（四种运行模式——交互式、Print、RPC、**SDK**——共用同一个 `AgentSession` 核心），内置 `read`/`write`/`edit`/`bash` 四个工具、`ExtensionAPI`（`registerTool`/`registerCommand`/`on(event, handler)`）扩展机制、Skills 与 Prompt Template 加载体系。这意味着 4.1 节 Agent 运行时层的多数标准组件（Agent Loop、工具生命周期钩子、事件流、Compaction）**由 `pi-coding-agent` 直接提供**，`tianwen-ai` 不需要在其上再造一层独立的编排引擎——这也是下面否决"自建编排层"这条路径的核心原因。

### 3.2 备选方案概述

**方案 A：基于 `pi-coding-agent` 的进程内 SDK 集成（推荐）**。把 `createAgentSession()` 作为 npm 依赖直接集成进 `tianwen-ai` 服务进程。每次请求按 `session_id` 从会话元数据表定位文件路径后 `SessionManager.open(path)` 打开共享文件系统上的会话 jsonl，处理完由 Pi 原生写回文件，进程本身不持有跨请求状态（经核实 SDK 无 DB 后端接口，会话内容以文件为事实源，MySQL 只存元数据，详见 5.1 节）。业务工具（AMS/Workbench/Server 的 HTTP 封装）注册为 `AgentTool` 在宿主进程内执行；`read`/`write`/`edit`/`bash` 四个内置工具及用户 `!` 命令，通过 Extension 机制路由进 Gondolin 隔离环境执行（详见 5.4a 节）。服务可水平扩展到多个副本，通过负载均衡分发请求；同会话并发由 5.7 节 MySQL 会话锁串行化。

**方案 B：有状态长驻进程**。每个会话对应一个常驻内存的 Agent 进程/线程，进程生命周期与会话绑定，会话数据只在内存维护，定期快照持久化。

**方案 C：自建独立编排层 + `pi-agent-core`**。在 `tianwen-ai` 里自行基于 `pi-agent-core`（而非 `pi-coding-agent`）搭建一套编排 Agent Loop，业务工具与文件/执行工具都在这一层管理，隔离环境作为下游被这一层调度。

### 3.3 方案评估

| 评估维度                 | 方案 A（`pi-coding-agent` SDK 集成） | 方案 B（有状态长驻进程） | 方案 C（自建编排层 + `pi-agent-core`） |
| ------------------------ | ------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------ |
| 水平扩展能力             | 高（无状态，任意实例可处理任意会话）                                | 低（会话绑定固定进程，扩容需做会话亲和路由） | 高（架构上不受限，但多一层需要独立维护的编排逻辑）|
| 故障恢复                 | 高（重启后从共享文件 open 同一会话，用户无感）                                 | 低（进程崩溃则内存会话丢失）                 | 中（编排层与执行层状态需要额外对齐协议）           |
| 实现复杂度               | 中（`SessionManager` 走文件+共享存储+MySQL 会话锁串行化，经核实 SDK 无 DB 后端接口、Extension 只读无法重定向到 MySQL；Gondolin 工具路由 extension）| 低（不需要设计持久化协议）                   | 高（编排 Loop 与 `pi-coding-agent` 内部 Loop 职责重叠，需要在两层之间反复搬运上下文） |
| 技术栈一致性             | 高（Node.js/TypeScript，与 `tianwen-web` 前端同生态）| 高                                           | 高（同为 Node.js，但多一层自研框架代码）  |
| 与天问现有基础设施契合度 | 高（可直接复用 SSO、WS 指令通道、审计基础设施）                     | 高                                           | 中（自建编排层需要额外适配 HITL/审计钩子）           |
| 团队现状适配             | 好（渐进演化，风险可控，直接复用官方 harness 与官方 Pi+Gondolin 集成范式）| 中（后期扩容改造成本高）                     | 差（重复造轮子，`pi-coding-agent` 已经是 `pi-agent-core` 之上的成熟编排实现）     |

### 3.4 方案选择

选**方案 A（基于 `pi-coding-agent` 的进程内 SDK 集成）**。

方案 B 的根本问题是会话状态与进程生命周期绑定。这和 AMS/Workbench/Server 一致遵循的无状态水平扩展模式相悖，会让 `tianwen-ai` 成为平台里唯一需要特殊运维手段（会话亲和、状态迁移）的服务，违反最小意外原则。

方案 C 是重复造轮子。`pi-coding-agent` 的 `AgentSession` 本身就是 `pi-agent-core` 之上的成熟编排封装（Agent Loop、工具生命周期钩子、事件流、Compaction、Extension 机制全部具备），如果再在 `tianwen-ai` 里自建一层编排 Loop，会出现两个 Loop 争抢同一个决策权的问题：每次工具调用都要在两层之间来回搬运对话上下文，带来结构性的信息损耗和维护成本，而没有换来任何方案 A 不具备的能力。

方案 A 直接复用官方 harness 的完整能力（含官方已验证的 Pi+Gondolin 隔离集成范式，见 5.4a 节），保持与天问现有服务的技术栈和部署模式一致，还能复用 SSO、WebSocket 指令通道、审计等现成基础设施，是当前团队规模和问题复杂度下投入产出比最高的选择。

---

## 四、功能架构设计

### 4.1 功能分层总览

`tianwen-ai` 自顶向下分五层：交互层、接入层、Agent 运行时层（即通用 Data Agent 底座，含七个标准组件）、工具与风险治理层、基础设施适配层。先说清楚一点：**全局只有一个 Agent**。`tianwen-ai` 不是"业务用户一个 Agent、RD 一个 Agent"两个实例，而是同一套 Agent Runtime、同一套六层上下文体系，按登录入口装载不同的工具子集与 System Prompt（见 4.1.1 节）。先明确这一点，是为了避免把"两个入口"误读成两个平行的 Agent，重复建设本该共用的运行时能力。

**交互层**：`tianwen-web` 承载对话式界面，覆盖两个场景：独立的 AI 助手面板（对话式操作）、平台内异常告警旁的"唤起 Agent 排查"入口（带上下文跳转）。业务用户和平台 RD 登录后看到的是同一个对话框，差别只在能触发哪些工具，不是两个产品入口。

**接入层**：负责请求认证（继承 `tianwen-common/sso` 的用户身份）、角色判定（从用户身份解析出"业务用户"或"平台 RD"，决定本次会话加载哪份工具子集与 System Prompt）、会话路由（识别 `session_id` 归属、新建/续接判定）、SSE 流式响应下发。

**Agent 运行时层（通用 Data Agent 底座）**：核心执行引擎，由七个标准组件构成。任何成熟的企业级数据智能体都需要这七个组件，和使用者是业务用户还是 RD 无关，两类入口完全共用这一层，不按角色做任何差异化：

| 组件 | 职责 | 对应设计章节 |
| --- | --- | --- |
| Agent Runtime | 单轮对话内的推理循环（模型调用 → 工具选择 → 执行 → 结果回填 → 判断是否收敛），由 `pi-coding-agent` 的 `AgentSession` 提供 | 5.5.1 |
| Context Tier（六层上下文） | 结构元数据/语义标注/代码规则派生/组织协作知识/记忆/运行时上下文六层通用上下文供给体系，决定 Agent 判断力的上限 | 5.5.2 |
| HITL 引擎 | 风险分级判定 + 人工确认的暂停/恢复，挂载于工具调用前后的生命周期钩子上 | 5.3 |
| Session Storage | 会话状态持久化与重建，支撑无状态水平扩展与故障恢复 | 5.1 |
| Compaction | 长会话上下文压缩/摘要，避免超出模型上下文窗口 | 5.1 |
| Prompt Caching | 复用内部 LLM 网关的提示词缓存能力，System Prompt、工具描述、语义层上下文等高频不变内容命中缓存，降低重复推理的 token 成本与首字节延迟 | 6.1 |
| Provider 适配层 | 对内部 LLM 网关的模型调用做统一抽象，屏蔽底层模型/版本切换对上层 Agent Loop 的影响 | 4.3 |
| 隔离执行环境 | 承载 `read`/`write`/`edit`/`bash` 内置工具及用户 `!` 命令的实际执行，基于 Gondolin microVM 与宿主环境做强隔离，防止代码执行类操作影响宿主与其他会话 | 5.4a |

和此前版本相比有两处调整：其一，Context Tier（六层上下文）不再只服务"洞察域"，收编为通用底座的标准组件。原因很直接：数据域查数据集语义、运维排查域查历史故障模式，都依赖上下文供给能力，把它限定在某个业务域里是人为制造特殊情况。5.5 节详述这一层的通用设计。其二，新增"隔离执行环境"组件——这是引入 `pi-coding-agent` 后随之而来的新问题：它自带的 `read`/`write`/`edit`/`bash` 工具默认直接在宿主进程所在机器上执行，在多租户共享部署（5.7 节）下必须做隔离，否则一次 `bash` 调用就能影响其他会话或宿主环境，详见 5.4a 节。

**工具与风险治理层**：工具集按天问既有服务边界组织，每个工具声明风险等级和可见范围（业务用户可见 / 仅 RD 可见），HITL 引擎按风险等级决定是否暂停等待用户确认。这是唯一按入口角色差异化配置的一层，见 4.1.1 节。业务工具（数据域/任务域/运维排查域/洞察域/平台域）在宿主进程内直接执行 HTTP 调用；`pi-coding-agent` 内置的文件与命令类工具统一路由进隔离执行环境，两类工具的执行位置不同，但对上层 Agent Loop 和 HITL 引擎透明，见 5.4a 节。

**基础设施适配层**：会话持久化（共享文件系统存会话 jsonl 为事实源 + MySQL 存会话元数据/锁，见 5.1 节）、模型调用（内部 LLM 网关，即 Provider 适配层的落地）、可观测性上报（Langfuse）、跨节点指令下发（复用 `tianwen-server` 的 `ConnectionManager`）、隔离执行环境的 Gondolin microVM 池（新增，见 5.4a 节）。

#### 4.1.1 一个 Agent，两个权限入口：业务用户入口是 RD 入口的能力子集

`tianwen-ai` 不是两个 Agent 实例的组合，是同一个 Agent Runtime，只因使用者身份不同，在"工具与风险治理层"加载不同配置。RD 入口拥有全部工具（含平台底层高危运维操作），业务用户入口是 RD 入口的真子集，两者是包含关系，不是并列关系：

| 维度 | 业务用户入口 | 平台 RD 入口 |
| --- | --- | --- |
| 服务对象 | 1.2 节业务用户侧基础能力 + 高级能力 | 1.2 节业务用户全部能力 **+** 平台 RD 侧智能运维与底层高危操作 |
| 可用工具域 | 数据域、任务域、运维排查域（只读诊断部分）、洞察域 | 数据域、任务域、运维排查域（含跨节点指令下发等高危动作）、洞察域、**平台域**（服务器操作、系统升级、模型/节点巡检等） |
| System Prompt | 面向"如何帮业务方跑通隐私计算任务"定制，Prompt 中不出现底层运维相关的工具描述 | 面向"如何辅助 RD 巡检、根因分析与平台运维"定制，在业务用户 Prompt 基础上追加运维专属指引 |
| Skills / MCP | 面向业务流程的固定分析/排查套路（见第七章） | 在业务用户 Skills 基础上，追加服务器巡检、系统升级、模型监控类 Skills/MCP 挂载 |
| Context Tier 使用重点 | 5.5.2 节六层模型，L1/L2/L4 资产语义为主 | 六层模型全量启用，额外叠加节点/任务运行时指标、历史故障模式作为 L6 兜底查询目标 |

**为什么是子集关系而不是两个 Agent**：业务用户能做的，RD 都能做；RD 能做的（尤其服务器操作、系统升级这类高危底层操作），业务用户不能做。这本质上是同一张工具注册表按风险等级和角色白名单过滤，不是两套独立工具集各自维护。实现上只要给每个工具标注"最低可见角色"（`business_user` / `platform_rd`），接入层装配运行时上下文时按角色过滤工具列表即可，不需要为两类入口分别维护 System Prompt 的核心结构，也不需要另起一套 Agent Runtime 实例。

**工具装载分两层：角色白名单（安全硬边界）+ 动态域激活（在边界内按需加载）。** 经核实 `pi-coding-agent` 的 `allowedToolNames`（5.1a 节）是会话级**硬白名单**——不在白名单内的工具从 `getAllTools()`、`setActiveTools()` 到模型可见性全程被过滤，无法注册、无法激活。因此角色的安全边界由它兜底，动态加载在这个边界内运行，两者不冲突：

- **第一层·角色白名单（`allowedToolNames`，会话创建时定死，两个入口都用）**：业务用户会话传入业务域工具列表，RD 会话传入全量工具列表。这是 4.1.1 节"权限不放大"的落地，是硬安全边界——业务用户即便模型调用了 `activate_domain("平台域")`，白名单里没有这些工具，激活器查不到，无法越权。
- **第二层·动态域激活（两个入口统一采用 Pi 的 `search_tools`/`activate_domain` 模式）**：所有工具都 `registerTool` 注册但初始 inactive，初始 active 集只含内置工具 + 一个 `activate_domain(domain)` 元工具。模型读完工具菜单（各工具的 `description`）后，按本轮意图自主调用 `activate_domain("数据域")`，Extension 用 `pi.setActiveTools([...当前, ...该域工具])` 加载该域完整 schema。这是**模型驱动的意图判断**，不是 Extension 用关键词猜域——可靠性等同于模型平时选工具的过程，不存在同义词/歧义漏判。两个入口都走这套，不区分静态/动态：RD 入口工具多（6 域 + 内置，按 5.4 节全量只读 API 封装可达 60-80+ 工具），动态加载的 token 节省和选错率降低明显；业务用户入口工具子集虽小，但统一机制省去维护两套装载逻辑的成本，且 cache 表现可控（见 6.1 节）。

**跨域追溯的动态加工具**：5.4 节决策"跨域走 Agent 连续调两个域工具、不做组合工具"的落地机制是 `activate_domain` 往返——Agent 调第一个域工具后发现需要跨域（如 AMS 数据集 → `source_flow_id` → Workbench 任务配置），再调一次 `activate_domain("任务域")` 加载目标域工具，然后调用。这个"工具不在列表→表达需要→Extension 加载→下一轮才能调"的往返是 Pi 动态加载的固有开销，已接受。

这种组织方式还有个好处：以后新增第三类角色（比如面向审计/合规的只读入口），只要加一条角色白名单规则和对应的工具可见性标注，不动 Agent Runtime 任何一个组件，第二层动态加载机制也无需改动。这是 2.3 节"最小职责边界"原则在 Agent 自身架构上的体现，也比维护两套并行实例简单，直接消除了"两个实例配置漂移、行为不一致"这个特殊情况。

### 4.2 功能架构图

![tianwen-ai 功能架构图](./diagrams/functional-architecture.png)

> 📐 完整可交互版（支持导出 PNG/PDF）：[`diagrams/functional-architecture.html`](./diagrams/functional-architecture.html)

```
┌───────────────────────────────────────────────────────────────────────────┐
│                              交 互 层（同一个对话框）                       │
│   tianwen-web：AI 助手对话面板  │  异常告警旁「唤起 Agent 排查」入口          │
└───────────────────────────────────────────────────────────────────────────┘
                                    │ SSE / HTTP
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                    接 入 层（tianwen-ai :8088）                             │
│  身份透传(复用SSO)│ 角色判定(业务用户/平台RD) │ 会话路由 │ 会话锁串行化(MySQL,防双写) │ 流式响应下发     │
└───────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│         Agent 运行时层 = 通用 Data Agent 底座（七个标准组件，唯一一套，全量共用）│
│ ┌───────────┐┌───────────┐┌───────────┐┌───────────┐┌───────────┐         │
│ │Agent      ││Context    ││HITL引擎   ││Session    ││Compaction │         │
│ │Runtime    ││Tier       ││tool_call拦截││Storage    ││长会话上下文│         │
│ │推理循环    ││六层上下文  ││block/终止 ││会话持久化/ ││压缩摘要    │         │
│ │(5.5.1节)  ││(5.5.2节)  ││(5.3节)    ││重建(5.1节)││(5.1节)    │         │
│ └───────────┘└───────────┘└───────────┘└───────────┘└───────────┘         │
│ ┌───────────┐┌───────────┐┌───────────┐                                   │
│ │Prompt     ││Provider   ││隔离执行环境│                                   │
│ │Caching    ││适配层      ││Gondolin   │                                   │
│ │高频上下文  ││模型调用统一││microVM隔离│                                   │
│ │缓存(6.1节)││抽象(4.3节)││(5.4a节)   │                                   │
│ └───────────┘└───────────┘└───────────┘                                   │
└───────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  工具与风险治理层：唯一按角色过滤的一层，RD 工具集 ⊇ 业务用户工具集             │
│ ┌─────────────────────────────────────────────────────────────────────┐  │
│ │ 业务用户可见                                                            │  │
│ │ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                          │  │
│ │ │数据域   │ │任务域   │ │运维排查域│ │洞察域   │                          │  │
│ │ │对接AMS  │ │对接WB   │ │只读诊断  │ │客群/价值│                          │  │
│ │ │  +日志检索│ │        │ │(含log_search)│        │                          │  │
│ │ └────────┘ └────────┘ └────────┘ └────────┘                          │  │
│ │  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈仅 RD 可见（在上方基础上追加）┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈    │  │
│ │  ┌────────┐ ┌──────────┐                                             │  │
│ │  │运维排查域│ │平台域     │                                             │  │
│ │  │docker_exec│ │服务器操作/│                                             │  │
│ │  │kubectl等 │ │系统升级/  │                                             │  │
│ │  │高危指令   │ │模型&节点  │                                             │  │
│ │  │(L3)      │ │巡检       │                                             │  │
│ │  └────────┘ └──────────┘                                             │  │
│ │              L6 兜底：AMS/WB/Server 不够时 → tianwen-mcp 调 SecretPad 底层 API        │  │
│ └─────────────────────────────────────────────────────────────────────┘  │
│  业务工具（上方域）→ 宿主进程内直接执行 HTTP 调用                       │
│  内置文件/命令工具（read/write/edit/bash/!command）→ 路由进隔离执行环境       │
│  工具装载两层：① 角色白名单(allowedToolNames,硬边界) → ② 动态域激活(activate_domain,模型按需加载) → 风险分级 → HITL确认    │
└───────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                     基础设施适配层                                          │
│  共享文件存储（会话 jsonl，事实源）│ MySQL（会话元数据/锁）│ 内部 LLM 网关 │ Langfuse │ WS 指令通道(复用)      │
│  Gondolin microVM 池（新增，无状态算力） │ 共享存储同时承载 workspace（5.4a 节）              │
└───────────────────────────────────────────────────────────────────────────┘
```

图里能看出一个架构特征：交互层、接入层、Agent 运行时层、基础设施适配层只出现一次，是两类角色共用的部分；只有"工具与风险治理层"内部按角色画了一条分界线，且 RD 可见范围完整包含业务用户可见范围。这就是 4.1.1 节"单 Agent、子集关系"的图示，两个角色不是并列对称的两个 Agent 实例。隔离执行环境同样是共用组件，不按角色区分——无论业务用户还是 RD，只要触发了文件/命令类内置工具，都进同一套 Gondolin 隔离机制，区别只在 RD 入口可能触发更高危的命令（仍受 5.3 节风险分级约束）。

### 4.3 与天问现有系统的边界关系

![tianwen-ai 系统架构图](./diagrams/system-architecture.png)

> 📐 完整可交互版（支持导出 PNG/PDF）：[`diagrams/system-architecture.html`](./diagrams/system-architecture.html)

本图以 `tianwen-ai` 为中心，画出它对所有下游系统的依赖与调用边界，是系统部署与依赖的权威视图（区别于 4.2 的功能分层视图）。

```
                              tianwen-web (:80)
                                 │
          ┌──────────────────────┼───────────────────────┐
          │ /api/v1/asset/*      │ /api/v1/task/*   /api/v1/nodes/*   │ /api/v1/ai/chat
          ▼                      ▼                 ▼                 ▼
   tianwen-ams(:8091)   tianwen-workbench(:8092)  tianwen-server(:8090)   ★ tianwen-ai(:8088) ★
   【既有,不变】         【既有,不变】           【既有,不变】            【新增】
                                                          │                 │
                                                          │  WS指令下发     │
                                                          ▼                 │
                                                   tianwen-agent(Python)        │
                                                   节点侧守护进程              │
                                                                              │
                ┌───────────────────── tianwen-ai 工具调用（携带用户身份）─────────────────────┐
                │                                                                     │
                │  ① 业务工具（宿主进程内 HTTP 调用，经动态域激活按需加载）            │
                ├──────────────→ tianwen-ams API        （数据域）
                ├──────────────→ tianwen-workbench API   （任务域）
                ├──────────────→ tianwen-server API      （运维排查/平台域，含 WS 指令下发→tianwen-agent）
                ├──────────────→ tianwen-mcp             （L6 兜底：SecretPad 底层 API）
                │                                                                     │
                │  ② 内置文件/命令工具（路由进隔离执行环境）                            │
                ├──────────────→ Gondolin microVM 池    （read/write/edit/bash/!cmd 执行）
                │                                                                     │
                │  ③ 运行时依赖                                                        │
                ├──────────────→ 内部 LLM 网关          （模型调用，OpenAI 兼容）
                ├──────────────→ Langfuse               （Trace 上报，via pi-telemetry）
                ├──────────────→ MySQL                  （会话元数据/锁；GET_LOCK 串行化）
                ├──────────────→ Hindsight service      （L5 记忆，via hindsight-pi extension）
                └──────────────→ 共享文件存储 EFS        （会话 jsonl 事实源 + Gondolin workspace）
```

**读图要点**：

- **业务调用四条边**：`tianwen-ai` 对 ams/workbench/server 是直接 HTTP 调用（业务工具），对 tianwen-mcp 是 L6 兜底调用（AMS/Workbench/Server 接口无法满足时调 SecretPad 底层 API）。四者同级，都是携带用户身份的内部调用，`tianwen-ai` 不直接访问任何业务数据库。
- **tianwen-server → tianwen-agent 这条链**：`tianwen-ai` 的运维域工具调 tianwen-server HTTP 接口，tianwen-server 内部经 `ConnectionManager.send_instruction` 下发指令到节点侧的 `tianwen-agent`（Python 守护进程）执行。运行时日志检索需 tianwen-server 新增 `runtime-logs` 接口 + tianwen-agent 新增 `log_search` 指令（见 5.6 节）。
- **Gondolin VM 池**：承载内置 `read`/`write`/`edit`/`bash`/`!command` 工具的执行，与业务工具的宿主进程内执行是两条独立路径（见 5.4a 节）。
- **EFS 共享存储**：同时承载会话 jsonl（事实源，tianwen-ai 读写）和 Gondolin workspace（VM 挂载），是 tianwen-ai 与 Gondolin 共同依赖的底层存储。
- **MySQL**：只存会话元数据/锁，不存会话内容（事实源在 EFS）；同时承担同会话请求的 `GET_LOCK` 串行化（见 5.7 节）。长期跨会话知识（L5 记忆）不在此层，见下方 Hindsight service。
- **Hindsight service**：L5 记忆层实现，外置 PostgreSQL+pgvector，经 `@walodayeet/hindsight-pi` extension 接入，tianwen-ai 不写胶水代码（见 5.5.2a 节）。

`tianwen-ai` 不直接访问任何业务数据库，不绕过 AMS/Workbench/Server 直接操作 SecretPad/Kuscia。所有能力都通过调用既有服务的 API 实现，业务规则的单一权威来源因此不被破坏。

---

## 五、关键设计详述

### 5.1 会话状态管理：无状态化与两层持久化

**核心设计**：Agent 后端进程不持有跨请求存活的状态。每次收到用户消息，按 `session_id` 从共享文件系统打开会话文件、重建运行时上下文，处理完写回文件。这样任意请求可以由任意实例处理，是水平扩展的前提。

**与 `AgentSession` 的对接方式（经核实 SDK 后确定的路线）**：`pi-coding-agent` 的 `SessionManager` 是**基于 JSONL 文件的 append-only 树存储实体类**，不是可插拔的存储后端抽象——其构造函数为 `private`，只能通过 `SessionManager.create(cwd, sessionDir?)` / `open(path)` / `inMemory()` 等静态工厂实例化，全部绑定文件路径或纯内存；经核查 Extension 机制，`ExtensionContext.sessionManager` 的类型是 `ReadonlySessionManager`（只读，所有 `append*` 方法被 `Pick` 排除），且 `on()` 事件列表（33 个，闭合）中**没有任何 entry 写入/持久化钩子**。这意味着「实现一个自定义 session backend 把持久化重定向到 MySQL」这条路在 SDK 层面不成立——`AgentSession` 本身确实不需要改造，但也无法通过外挂一层把会话内容灌进 MySQL 当事实源。

因此 `tianwen-ai` 采用**文件为源 + 共享存储 + MySQL 元数据**的路线：让 Pi 用其原生的文件 `SessionManager`，把 `sessionDir` 指向跨宿主机可访问的**共享文件系统**（采用基研团队的 EFS）；会话内容（消息历史、工具调用记录、Compaction、被 block 的工具调用等）全部落在 jsonl 文件里，由 Pi 原生读写，`tianwen-ai` 不碰 Pi 的内部 entry 结构。MySQL 只存**会话元数据**（`user_id` / `session_id` / 会话文件路径 / 会话锁 / 时间戳 / 状态），既是会话索引又是锁载体。审计、按 `user_id` 列会话这类只读查询走 MySQL 元数据定位文件路径后，直接 `SessionManager.open(path)` 读完整 entry 树，不在 MySQL 里重复存一份会话内容（避免双写一致性与 schema 同步两个负担）。

会话数据分两层持久化，职责不同：

|          | 短期会话状态                                   | L5 记忆（长期）                         |
| -------- | ---------------------------------------------- | ------------------------------------ |
| 存储内容 | 当前会话的消息历史、工具调用记录、被 block 的工具调用（即 HITL 暂停点） | 被纠正的判断、用户偏好、常用机构、历史操作模式等跨会话隐性知识（即 5.5.2 节 L5 记忆层） |
| 存储介质 | **共享文件系统 EFS**（jsonl，Pi 原生 `SessionManager` 读写，事实源） | **Hindsight service**（外置 PostgreSQL+pgvector，经 `@walodayeet/hindsight-pi` extension 接入，见 5.5.2a 节） |
| 生命周期 | 单个`session_id` 范围内，超期可截断/摘要压缩（Compaction） | 跨会话持续累积，经 Hindsight 三层 consolidation（observation→experience→world）压缩提炼 |
| 用途     | 支撑本轮对话的连续性、故障恢复                 | 个性化建议、减少重复澄清、沉淀被纠正的隐性规则 |
| 访问方式 | 通过元数据表查 `session_id` → 文件路径 → `SessionManager.open(path)`                        | 通过 `HINDSIGHT_BANK_ID=tianwen_user_{userId}` 按 user_id 隔离，extension 自动 recall/retain |

会话不需要记录任何 Gondolin VM 相关信息（详见 5.4a 节：VM 本身不持有状态，无需定位、无需绑定）。

**「Checkpoint」概念的取舍——Pi 的 session 文件即 checkpoint 等价物**：设计早期曾设想过自造一套「Checkpoint（工具调用前/后的状态快照，存 MySQL）」用于故障恢复与 HITL 暂停/恢复。经核查，**Pi 原生没有 Checkpoint / checkpointer 原语**（文档里 "checkpoint" 仅指 Git stash 与 `setLabel` 书签），但 Pi 的 session 文件本身就是 append-only、可恢复、精确到每条 entry 的持久化状态——它已经扮演了 checkpoint 的角色。业界标杆 LangGraph 的 HITL/持久化确实以 checkpointer 为核心（`interrupt()` 存 checkpoint、`Command(resume)` 重载 checkpoint 从断点继续），但那是 LangGraph 自建编排引擎的前提；我们既然基于 `pi-coding-agent`，就不应在 Pi 已提供等价能力（session 文件）之上再叠一层自造 Checkpoint 持久化。因此本设计**不引入独立的 Checkpoint 持久化层与 Checkpoint 状态机**，改为：

- **故障恢复**：Pi session 文件在共享存储上持久化，实例崩溃后任意实例 `open(path)` 从最后一条 entry 继续，已成功的工具调用不重跑——这正是早期 Checkpoint 想要的「不用重跑已成功工具调用」收益，由 Pi 原生提供，无需 `tianwen-ai` 做快照粒度。
- **HITL 暂停/恢复**：落到 Pi 原生的 `tool_call` 事件拦截（详见 5.3 节），暂停点 = 被 block 的工具调用 entry 在 session 树中的位置，session 文件天然持有该暂停点的全部上下文，不需要额外写快照。
- **与 LangGraph 的权衡（如实标注）**：LangGraph 的恢复是**确定性位置恢复**（从 checkpoint 精确继续执行相同节点），Pi 的恢复是**模型驱动**（下一条 user message 推进 Agent，Agent 重新评估后重发工具调用，靠 System Prompt 引导而非机制保证）。对天问的 HITL 场景（批准 L2/L3 操作后执行该操作、会话连续性、故障恢复）足够——不需要 LangGraph 的「时间旅行调试」或「保证重跑相同节点序列」。且 LangGraph 自身的确定性恢复也有「interrupt resume 重跑中断前代码」的 double-execution 已知问题，并非完美。

**会话生命周期判定**：新会话还是续接，由前端显式传 `session_id` 决定（新对话时为空，Agent 生成后返回；继续对话时前端回传）。不做"自动判断用户是否在说同一件事"这种容易出错的启发式逻辑。

**会话 TTL**：当前不设会话级别的自动过期清理。会话 jsonl 文件在共享文件系统中持久保留，直到后续统一的归档机制落地后再定义 TTL 策略。这意味着待确认的 HITL 暂停点（被 block 的工具调用）也不会因超时自动作废（与 5.3 节"不设 HITL 超时"一致）。归档机制的设计不在本文档范围内。注意：会话文件归档需与 5.4a 节 workspace 目录归档一并设计，避免审计时「文件已被清理」——当前两者都明确不设自动过期。

**并发写入风险（水平扩展下必须解决）**：Pi 的 `SessionManager` 是**单写者假设**——写入路径用 `appendFileSync`/`writeFileSync`，branch/compaction 时会 `_rewriteFile()` 重写整个文件，且**全程无 flock、无 O_EXCL、无任何文件锁**（已核实 `session-manager.js`）。水平扩展下，同一 `session_id` 的两个请求若落到两个实例（多设备、快速连发、HITL 确认与新消息并发），同时 append 或一个 append 一个 rewrite 同一 jsonl 会**损坏文件、丢失 entry**。因此「任意请求由任意实例处理」前面必须加一道串行化：同一 `session_id` 的请求由 5.7 节的 MySQL 会话锁（`GET_LOCK(session_id, timeout)`）串行化，抢到锁的实例才 open 文件操作。这条锁同时承担 5.3 节 HITL 竞态防护（详见 5.3、5.7）。

### 5.1a Agent Runtime 能力配置

4.1 节的七个标准组件中，Agent Runtime、Compaction、Prompt Caching 三个组件的行为直接由 `pi-coding-agent` 的配置参数控制。本节把这些参数集中暴露出来，`tianwen-ai` 通过 `SettingsManager.applyOverrides()` 或 SDK 构造参数注入，无需修改 Pi 源码。

#### Compaction（上下文压缩）

Compaction 由 `pi-coding-agent` 内置，自动在上下文接近模型窗口上限时触发摘要压缩。`tianwen-ai` 通过以下参数控制其行为：

| 参数 | 类型 | 默认值 | 控制效果 |
| --- | --- | --- | --- |
| `compaction.enabled` | `boolean` | `true` | 是否启用自动压缩。关闭后仍可通过 `session.compact()` 手动触发 |
| `compaction.reserveTokens` | `number` | `16384` | 为 LLM 响应预留的 token 空间。**触发条件**：`上下文 token 数 > 模型窗口 - reserveTokens`。调大 → 更早触发压缩；调小 → 更晚触发但可能导致模型响应空间不足 |
| `compaction.keepRecentTokens` | `number` | `20000` | 压缩时保留最新消息的 token 数（不会被摘要覆盖）。调大 → 保留更多近期上下文，减少信息丢失但压缩效果减弱；调小 → 压缩更激进，可能丢失关键近期上下文 |

**压缩行为说明**（不可配置，由 Pi 内置逻辑决定）：
- 切分点只落在 user message、assistant message 或 custom message 处，**永远不会在 tool result 处切割**——保证工具调用的参数与结果不会被拆散。
- 压缩生成结构化 Markdown 摘要（含 Goal / Progress / Key Decisions / Critical Context / read-files / modified-files），跨多次压缩迭代合并。
- 工具结果在序列化时截断为 2000 字符。
- 通过 `session_before_compact` 事件钩子，`tianwen-ai` 可以在压缩前注入自定义逻辑（如保留特定工具调用上下文），或完全取消某次压缩。

**与 HITL/恢复的关系**：Compaction 生成的 `CompactionEntry`（含摘要、截断点 `firstKeptEntryId`、压缩前 token 数）作为一条 Session Entry 持久化在 jsonl 文件中。由于本设计不再设独立的 Checkpoint 持久化层（5.1 节），Compaction 与 HITL 暂停点是**同一条 session 树上的不同 entry**——即使某次被 block 的工具调用所在消息后被压缩进摘要，该工具调用 entry 仍在树中，Agent 在恢复推进时按 `buildSessionContext()` 的 compaction-aware 遍历正常重建上下文，不受压缩影响。

**天问场景的调参方向**（待上线后基于实测数据校准）：PSI → SCQL → 结果解读这类跨多轮的任务执行场景，上下文通常较长。初始建议将 `keepRecentTokens` 调至 30000～40000，确保至少保留最近一轮完整的工具调用链（查询参数 + 结果 + Agent 判断），避免压缩切走正在进行的推理上下文。`reserveTokens` 保持默认 16384 即可，天问使用的模型窗口通常足够。

**会话内 compaction 增强（`pi-observational-memory`）**：底座默认载入 `pi-observational-memory` Extension（见 5.1b 节），经源码核实其机制有二：① **会话进行中持续提炼**——由 consolidation-trigger 在 token 累积到阈值时后台异步运行 observer→reflector→dropper 三步流水线，把对话 chunk 提取为带时间戳与相关度的 observations，再结晶为持久的 reflections，并丢弃已被覆盖/低相关的 observations；② **compaction 时替换默认 summary 生成**——通过 `session_before_compact` 钩子拦截 Pi 原生 compaction，不使用默认 Markdown 摘要，而是用 reflections + active observations 渲染出结构化 summary 注入 compaction entry。两机制合起来解决长会话多次 compaction 后原生摘要逐级失真（"压缩的压缩的压缩"）导致的上下文漂移。所有 observations/reflections 以 custom entry 存在 session jsonl 树内，**不跨会话**（session 结束即止）；与 Hindsight L5 跨会话记忆正交（前者保本会话 compaction 不丢线，后者保跨会话记住教训）。

**触发阈值配置（`observational-memory` settings 段）**：

| 配置项 | 默认值 | 天问设定 | 说明 |
| --- | --- | --- | --- |
| `observeAfterTokens` | 10,000 | **100,000** | 累积到此 token 数触发 observer 提取 observations |
| `reflectAfterTokens` | 20,000 | **200,000** | 累积到此 token 数触发 reflector 结晶 reflections + dropper 清理 |
| `compactAfterTokensMode` | `"calibrated"` | `"ratio"` | Pi 原生 compaction 触发模式：ratio 按模型窗口比例算 |
| `compactAfterTokensRatio` | 0.68 | **0.8** | ratio 模式下 compaction 触发点 = `contextWindow × 0.8` |

**天问调参理由**：默认 10k/20k 对天问偏频繁——天问工具调用 token 重（数据集详情含血缘+导入 SQL、任务配置 `config_text`、SCQL 查询结果都是大块结构化数据），一个典型 PSI→SCQL→结果解读流程前 1-2 轮工具调用就突破 1 万 token，但此时"值得提炼的决策"还没积累够，后台 consolidation 大概率空转、白耗主模型 token。调至 100k/200k 后：① 短会话（基础能力：发起 PSI/查数据/排错，通常 3-8 轮、3-5 万 token 收敛）基本不触发后台 consolidation，零负担；② 长会话（洞察域：联合客群分析、跨会话追溯，5-10 轮、8-15 万 token）在累积到 10 万 token 时开始提炼——此时已有数轮工具调用与决策积累，observations 有内容可提取，20 万时结晶 reflection 时机合理。`observeAfterTokens`/`reflectAfterTokens` 只支持固定 token 数（非 ratio），`compactAfterTokensMode: ratio` + `0.8` 保持不变，compaction 触发点不改。该值随线上实测后台 consolidation 频率与 token 消耗校准。

#### 工具集控制

| 参数 | 类型 | 默认值 | 控制效果 |
| --- | --- | --- | --- |
| `initialActiveToolNames` | `string[]` | `["read","bash","edit","write"]` | 初始启用的内置工具名 |
| `allowedToolNames` | `string[]` | - | 工具白名单。提供时只暴露这些工具——**4.1.1 节工具装载第一层（角色硬边界）**：业务用户会话传入业务域工具列表，RD 会话传入全量工具列表。经核实此为会话级硬白名单，`getAllTools()`/`setActiveTools()` 全程受其过滤，是动态加载（第二层）的安全上限 |
| `excludedToolNames` | `string[]` | - | 工具黑名单。在白名单之后应用，用于临时下线某工具 |
| `customTools` | `ToolDefinition[]` | - | SDK 自定义工具定义。`tianwen-ai` 的数据域/任务域/运维排查域/洞察域/平台域工具通过此参数注册（初始 inactive，由 `activate_domain` 元工具按需激活，见 4.1.1 节第二层） |

#### Session 存储与目录

| 参数 | 类型 | 默认值 | 控制效果 |
| --- | --- | --- | --- |
| `sessionDir` | `string` | `~/.pi/agent/sessions/` | Session 文件存储目录。**天问指向共享文件存储路径**（跨宿主机可访问的 EFS），让 Pi 原生的文件 `SessionManager` 在共享存储上读写 jsonl；会话内容即事实源，MySQL 只存元数据（见 5.1 节"与 AgentSession 的对接方式"） |
| `PI_CODING_AGENT_DIR`（环境变量） | `string` | `~/.pi/agent` | 全局配置目录。天问应指向部署目录下的独立路径 |

#### 网络与传输

| 参数 | 类型 | 默认值 | 控制效果 |
| --- | --- | --- | --- |
| `transport` | `string` | `"auto"` | 首选传输方式：`"sse"` / `"websocket"` / `"websocket-cached"` / `"auto"` |
| `httpIdleTimeoutMs` | `number` | `300000`（5 分钟） | HTTP idle 超时（毫秒）。设为 0 禁用 |
| `websocketConnectTimeoutMs` | `number` | `15000`（15 秒） | WebSocket 连接超时（毫秒）。设为 0 禁用 |

天问的调参方向：`httpIdleTimeoutMs` 应与内部 LLM 网关的连接池配置对齐，避免 Pi 侧 idle 超时早于网关侧导致连接重建开销。

#### 配置注入方式

`tianwen-ai` 在 `createAgentSession()` 调用时，通过以下两种方式注入上述参数：

1. **`SettingsManager.applyOverrides()`**：在 SDK 构造前覆盖 settings，适用于 Compaction、Retry、Provider、工具控制等通过 settings 管理的参数。
2. **`CreateAgentSessionOptions` 构造参数**：直接传入 `model`、`thinkingLevel`、`tools`、`excludeTools`、`customTools`、`sessionManager`、`settingsManager` 等构造参数，优先级高于 settings 文件。

两种方式的参数最终汇聚到同一份运行时配置，不存在优先级冲突。`tianwen-ai` 统一通过 `applyOverrides()` 管理可热更新的参数（如 Compaction 阈值、Retry 策略），通过构造参数管理需按会话差异化的参数（如按角色过滤的 `tools` 列表）。

### 5.1b 底座默认 Extension 清单

`tianwen-ai` 底座基于 `pi-coding-agent`，需预装以下 Extension 作为默认载入。这些 Extension 覆盖记忆、可观测性、隔离执行、工具桥接、委托执行、会话连贯六个能力面，是七标准组件之外由 Pi 生态提供的运行时增强。安装方式：npm 包走 `pi install npm:<name>`，本地示例（Gondolin）走 `cp -R examples/extensions/gondolin ~/.pi/agent/extensions/gondolin`。

| Extension | npm 包 / 来源 | 能力面 | 对应设计章节 | 载入说明 |
| --- | --- | --- | --- | --- |
| `@walodayeet/hindsight-pi` | `npm:@walodayeet/hindsight-pi`（v0.4.0，MIT） | L5 跨会话记忆 | 5.1（长期层）、5.5.2a | 经 `HINDSIGHT_BANK_ID=tianwen_user_{userId}` 用户级 bank 隔离，`session_start`/`before_agent_start`/`message_end` 钩子自动 recall/retain，零胶水代码 |
| `@amaster.ai/pi-telemetry` | `npm:@amaster.ai/pi-telemetry`（v0.1.8，Apache-2.0） | 可观测性（Langfuse） | 5.8 | 全生命周期事件映射为 Langfuse Trace；生产环境 `TELEMETRY_INCLUDE_PAYLOADS=false` 关 payload 防敏感数据上传 |
| Gondolin | `examples/extensions/gondolin`（本地） | 隔离执行（第 7 组件） | 5.4a | Extension 拦截 read/write/edit/bash/!command 路由进 microVM；workspace 落 EFS，bind mount 隔离 |
| `pi-mcp-adapter` | `npm:pi-mcp-adapter` | MCP 工具桥接 | 5.4（L6 兜底）、B1 | 用于接入 `tianwen-mcp`（SecretPad OpenAPI 的 MCP server）；proxy 工具模式（~200 token）按需发现，避免全量 MCP 工具定义烧 context，与 4.1.1 动态域激活理念一致 |
| `pi-subagents` | `npm:pi-subagents` | 委托式子 Agent | 4.1.1（澄清）、5.5.4 | 见下方澄清 |
| `pi-observational-memory` | `npm:pi-observational-memory`（v3.0.4，MIT） | 会话内 compaction 增强（替换默认 summary） | 5.1a（Compaction） | 见下方说明 |

**`pi-subagents` 与"单 Agent"原则的澄清**：4.1.1 节"全局只有一个 Agent"否决的是"两个对等 Agent 实例 + Agent 间通信协议"的多 Agent 协商架构（YAGNI）。`pi-subagents` 提供的是**委托式子 Agent**——主 Agent 仍是单点决策者，按需派生聚焦子 Agent 执行 review/scouting/实现等离散任务，子 Agent 不参与决策争抢、不互相协商。两者不矛盾：载入 `pi-subagents` 是为给主 Agent 一个"第二双眼睛"的执行手段（如 5.5.4 节黄金用例评测时可派生子 Agent 做独立 review），不是引入多 Agent 协作。默认载入但**不强制启用**——是否派生子 Agent 由主 Agent 按需决定，未派生时零开销。

**`pi-observational-memory` 与 Compaction / Hindsight 的关系**：三者分属不同层面，可共存：

- `pi-observational-memory`（**会话内**）：会话进行中持续提炼 observations/reflections，并在 compaction 时经 `session_before_compact` 钩子替换 Pi 默认 summary 生成，避免长会话多次 compaction 后原生摘要逐级失真。不跨会话，会话结束即止。
- Hindsight（**跨会话**，L5 记忆）：沉淀被纠正的判断、用户偏好等隐性知识，经向量+图谱检索跨会话 recall（5.5.2a 节）。
- 两者职责正交：前者保"本会话不丢线"，后者保"跨会话记住教训"。同时载入不冲突，`pi-observational-memory` 的 observations 可作为 Hindsight retain 的输入源之一（但默认不联动，各自独立运行）。

**不载入的 Extension**（与本机已装但与底座无关的区分）：`pi-web-access`（无需网页抓取）、`pi-fork`（用 Pi 原生 session 分支）、`remote-pi`/`pi-messenger`（不涉及跨实例 mesh 协作）等本机可能存在的 Extension 不纳入底座默认清单，按需单独评估。

#### tianwen-ai 自研 Extension

除上述预装的现成 Extension 外，`tianwen-ai` 需自研以下三个 Extension，作为底座的业务定制层。它们不是 npm 包，随 `tianwen-ai` 代码库维护，通过 `~/.pi/agent/extensions/<name>/index.ts` 本地载入（或 SDK 构造时 `resourceLoader` 注入）。

| 自研 Extension | 能力面 | 对应设计章节 | 实现要点 |
| --- | --- | --- | --- |
| `tianwen-hitl` | HITL 风险分级拦截 | 5.3 | 监听 `on("tool_call")`，按工具声明的风险等级（L0～L3）判定：L0/L1 放行（L1 回复中告知已执行）；L2/L3 返回 `{ block: true, terminate: true, reason: "<结构化操作计划>" }`，工具不执行、Agent 当轮终止，操作计划经 reason 返回前端。恢复靠 Agent 重发工具调用（模型驱动，非 Checkpoint），见 5.3 节 |
| `tianwen-tool-domains` | 动态域激活 | 4.1.1、5.4 | 注册 `activate_domain(domain)` 元工具，模型按需调用后以 `pi.setActiveTools([...当前, ...该域工具])` 加载域工具完整 schema；初始 active 集只含内置工具 + 该元工具。跨域追溯走连续调两次 `activate_domain`（4.1.1）。需配合 `allowedToolNames`（角色硬白名单，SDK 配置）在边界内运行 |
| `tianwen-gondolin-router` | Gondolin 工具路由（定制） | 5.4a | 基于官方示例 `examples/extensions/gondolin` 改造：拦截 read/write/edit/bash/!command，路由进当前会话现开 VM；bind mount `{共享存储根}/{user_id}/{session_id}/` 到 VM 内 `/workspace`；VM 惰性创建、尽力复用、复用不了重开。官方示例只做"路由进 VM"，本 Extension 追加"workspace 路径按 user_id/session_id 组织、挂载 EFS"的天问定制 |

**自研 Extension 与现成 Extension 的载入顺序**：三个自研 Extension 与六个预装现成 Extension 一同在 `session_start` 前载入。载入顺序不影响正确性（各 Extension 监听不同事件/注册不同工具），但 `tianwen-hitl` 的 `tool_call` 拦截需在 `tianwen-tool-domains` 加载的工具执行前生效——这由 Pi 的 `tool_call` 事件在工具执行前触发保证（见 5.3 节），无需额外排序处理。

### 5.2 身份与权限：Agent 不是新的信任根

**核心原则**：Agent 调用任何工具时，工具函数必须显式接收发起该次对话的用户身份凭证，工具内部转发给 AMS/Workbench/Server 时使用该凭证，而不是 Agent 自身的服务身份。效果是：Agent 能做的事，严格等于用户本人直接调 API 能做的事，不多不少。

具体实现复用 `tianwen-common/sso` 已验证的 TokenExchange 能力（参考 `tianwen-workbench` 接入晓笛 A2A 的实践）：

```
用户浏览器（SSO 登录态）
   │ Cookie: ssoid
   ▼
tianwen-ai 接入层：从请求上下文取出用户 ssoid，作为「租户上下文」贯穿本次会话处理
   │
   ▼
工具执行时：使用该 ssoid（或经 TokenExchange 换取的目标服务 access_token）
   │ 调用 AMS / Workbench / Server API
   ▼
下游服务：按正常用户请求路径校验权限（RBAC/ABAC），与用户直接调用 API 无差异
```

对照晓笛 A2A 接入已验证的三重校验模型，`tianwen-ai` 调用天问内部服务时同样适用：

- **D1（用户一级权限）**：用户本身必须有权限使用被调用的功能（如是否有权操作某个机构的数据）。这一层完全下沉到 AMS/Workbench 现有的 RBAC 校验，Agent 不重复实现。
- **D2（代理访问权限）**：`tianwen-ai` 作为代理调用者的身份要被下游服务识别和授信，走内部服务间调用的既有认证机制（与 AMS/Workbench 之间已有的服务间信任一致），不新增机制。
- **D3（用户运行时同意）**：对应 5.3 节的 HITL 确认机制。

工具调用的失败模式必须是"用户没有权限"，不能是"Agent 的服务账号权限不够"。后者意味着架构里引入了一条脱离用户权限体系的隐藏信任通道，是设计评审阶段就该否决的模式。

### 5.3 风险分级与 Human-in-the-loop

不是每个工具调用都要用户确认，也不能一刀切都不要。按影响面对工具做四级风险分级：

| 风险等级       | 定义                              | 示例                                       | 是否需要确认                                 |
| -------------- | --------------------------------- | ------------------------------------------ | -------------------------------------------- |
| L0 只读        | 不产生任何状态变更                | 查询数据集列表、查询任务状态、查询节点健康 | 否                                           |
| L1 可逆写      | 产生状态变更但可撤销/无副作用扩散 | 创建草稿态任务、上传数据集（未发布）       | 否，但需在回复中明确告知已执行的操作         |
| L2 不可逆写    | 产生不可逆或影响范围较大的变更    | 授权数据给机构、删除数据集、发布任务       | **是**                                 |
| L3 跨机构/高敏 | 涉及跨机构数据流动或敏感操作      | 跨机构建项目、批量授权、修改合约条款       | **是**，且需展示完整操作计划供逐项确认 |

**执行流程（基于 Pi 原生 `tool_call` 拦截）**：`tianwen-ai` 用一个 Extension 监听 `on("tool_call", ...)` 事件。当 Agent 决定调用某个工具时，Extension 先按风险分级判定：L0/L1 直接放行（L1 在回复中明确告知已执行）；L2/L3 则返回 `{ block: true, terminate: true, reason: "<结构化操作计划：工具名、参数、影响面描述>" }`——工具不执行、Agent 当轮终止，操作计划经 reason 返回前端在 `tianwen-web` 上展示。用户点确认后，确认结果作为下一条 user message 推进 Agent，Agent 在 System Prompt 引导下重新发起该工具调用，此时 Extension 放行，工具真正执行。用户拒绝则会话继续，该操作不执行。

这个机制**完全使用 Pi 原生能力**，不需要为 HITL 自造一套暂停/恢复协议或独立的 Checkpoint 持久化层。对照业界标杆 LangGraph：LangGraph 的 `interrupt()`/`Command(resume=...)` 构建在其 checkpointer 之上，恢复是「重载 checkpoint 从断点确定性继续」；Pi 没有 checkpointer 原语，其等价物是 session 文件本身（5.1 节），HITL 暂停点 = 被 block 的工具调用 entry 在 session 树中的位置，session 文件天然持有该点的全部上下文。两者权衡：Pi 的恢复是**模型驱动**（Agent 重发工具调用，靠 System Prompt 引导，非机制保证确定性重发），而非 LangGraph 的确定性位置恢复。对天问的 HITL 场景（批准 L2/L3 后执行该操作）足够——System Prompt 指示「用户已批准你提出的操作，请执行」，Agent 重发是预期行为；且 LangGraph 自身的确定性恢复有「interrupt resume 重跑中断前代码」的 double-execution 已知问题，并非完美。

- **暂停期间的并发**：前端对存在待确认（被 block）工具调用的会话，展示专用的确认/拒绝交互，不依赖模型去猜用户下一条普通消息是不是在回应这个确认。如果用户不走这个专用交互、而是直接发一条普通消息，视为隐式放弃当前待确认操作，会话按新一轮对话正常处理——不阻塞输入框。**但放弃不能静默**：前端在被 block 工具调用转为「已搁置」时，必须给出持久、醒目的用户可见提示（明确写出「你有一条待确认的【授权数据给机构Y】操作因发送新消息被搁置，如需执行请重新发起」），否则 L2/L3 高风险操作的静默放弃是埋雷。此外，用户在确认前常需先问澄清问题（如「这个授权包含字段 d 吗？」），为此在确认/拒绝按钮旁提供第三个显式入口「就这条操作提问/补充」——走该入口的消息**不触发搁置**，而是进入待确认操作上下文，Agent 解答后重新展示（可能微调后的）操作计划；普通输入框的消息仍 = 搁置。对 L3（跨机构/高敏）进一步收窄：会话存在待确认 L3 操作时，普通消息**不触发**搁置，而是被拒并提示「当前有 L3 操作待确认，请先确认或拒绝，或点【补充说明】提问」，与 5.3 风险分级表 L3 比 L2 更严的逻辑自洽。
- **暂停时长**：不设独立的超时机制。待确认的暂停点跟随 5.1 节会话文件本身的生命周期（不设会话 TTL），不为 L2/L3 额外发明一套过期规则。
- **HITL 并发竞态（统一由 5.7 会话锁承接）**：同一用户在多设备/标签页打开同一会话、或对同一被 block 工具调用发起多次确认时，可能出现竞态。本设计**不**像早期方案那样用「Checkpoint 状态机 + MySQL 条件更新（`UPDATE WHERE status='pending'`）」来防竞态——因为独立的 Checkpoint 持久化层已被移除（5.1 节）。竞态防护改为依赖 5.7 节的 MySQL 会话锁（`GET_LOCK(session_id, timeout)`）：同一 `session_id` 的请求任意时刻只有一个实例能抢到锁并推进该会话，因此不存在「两个确认抢同一工具调用」「确认与新消息互踩」的并发场景——锁从源头串行化了同一会话的所有推进。被 block 的工具调用是否重新发起，由 Agent 在抢到锁后的正常 turn 推进中决定。

    这条锁同时承担两件事：① 防 jsonl 双写损坏（Pi `SessionManager` 单写者、无文件锁，见 5.1 节并发写入风险）；② 防 HITL 互踩。锁是 per-session 的请求级短期互斥，不是会话状态驻留，进程本身仍无状态——与 5.1 节「任意请求由任意实例处理」不冲突。用 MySQL `GET_LOCK`（服务端管理、连接断开自动释放、无续期）而非 Redis 分布式锁，避免引入新组件（MySQL 本就在架构里），也规避了锁的超时/续期/死锁新故障面。

### 5.4 工具集组织：按现有服务边界划分，单一工具注册表按角色白名单过滤，不做超级 Agent

工具集严格按 AMS / Workbench / Server 三个既有服务的职责边界组织，每个工具是对应服务某个 API 的直接封装，并标注 4.1.1 节定义的"最低可见角色"（业务用户可见 / 仅 RD 可见）：

| 可见范围 | 工具域 | 对接服务 | 典型工具 | 风险等级参考 |
| --- | --- | --- | --- | --- |
| 业务用户 + RD 均可见 | 数据域 | tianwen-ams | 查询数据集、上传数据集、查询授权状态、发起授权 | L0 / L1 / L2 |
| 业务用户 + RD 均可见 | 任务域 | tianwen-workbench | 查询任务列表、创建 PSI/FL/SCQL 任务、查询任务结果 | L0 / L1 / L2 |
| 业务用户 + RD 均可见 | 运维排查域（只读部分） | tianwen-server | 查询节点状态、查询节点心跳日志、运行时日志检索（`log_search` 指令，需 tianwen-server/tianwen-agent 扩展，见 5.6 节） | L0 |
| 业务用户 + RD 均可见 | 洞察域 | tianwen-ams + tianwen-workbench | 联合客群交叉分析（复用 PSI/SCQL 结果）、资产组合价值发现与建模建议 | L0（只读分析）/ L1（生成建议） |
| **仅 RD 可见** | 运维排查域（高危部分） | tianwen-server | 下发 `docker_exec`/`kubectl_apply` 等跨节点高危指令 | L3（跨节点指令） |
| **仅 RD 可见** | 平台域 | tianwen-server + 模型监控服务 + 底层运维系统 | 节点/任务健康巡检、模型效果与稳定性异常的自动根因分析、服务器操作、系统升级 | L0（只读巡检）/ L1（生成处理建议）/ L3（服务器操作、系统升级等底层高危动作） |

数据域、任务域、运维排查域只读部分覆盖 2.1 节第一层目标；洞察域对应第二层，平台域及运维排查域高危部分对应第三层。这里一并列出是为了保持工具分类体系完整，避免以后新增域时推翻现有分类。

**"按角色过滤工具"和"不做超级 Agent"不矛盾**：这不是多 Agent 协作意义上的两个独立 Agent，不需要 Agent 间通信协议、不需要仲裁 Agent、不存在两个实体互相调用或协商的场景。本质就是同一套 Agent Runtime（4.1.1 节）、同一张工具注册表，按当前会话使用者的角色过滤出一份工具子集；路由层的职责仍然只是"识别用户意图 → 分发到当前角色授权范围内的工具"。真正的多 Agent 协作（如未来天问 Agent 与晓笛 Agent 互操作）属于过度设计（YAGNI），等出现真实的跨域协同复杂度再引入，和本节说的"角色可见性过滤"是两个层次的问题。

**工具域与 API 的覆盖原则**：表中"典型工具"为示例而非穷举。数据域、任务域分别是对 `tianwen-ams`、`tianwen-workbench` **全量只读 API 的封装**——AMS / Workbench 后续新增的只读 API 自动进入对应工具域，无需改本设计文档；写操作 API 按风险分级单独标注（L1/L2/L3）走 5.3 节 HITL。原则是：**AMS 能提供的只读数据，都要给 Agent 使用**（用户已确认）。据此，5.5.6 节 L1/L3 直接依赖的能力须在数据域/任务域有对应工具，作为"依赖闭合"的证据点显式列出：

- **数据集详情（含血缘 + 导入 SQL）**：对应 AMS `GET /api/v1/asset/datamgmt/datasets/{dataset_id}`，返回 `DataSetDetailOut`，含 `sql`（导入 SQL，L3）、`source_flow_name`/`source_task_id`/`source_task_type`/`source_project_id`（已 JOIN 解析的血缘名，L1）——经核实 `service.py` 真实用 `source_flow_id` JOIN `ProjectFlow.flow_id`。
- **字段语义（L2）**：对应 AMS 字段查询接口，取 `ams_feature_fields.real_desc`/`alias_desc`。
- **合约用途（L4）**：对应 AMS 合约接口，取 `ams_digital_contracts.purpose`。

**跨域追溯走 Agent 连续调两个域工具，不做组合工具**：5.5.6 节 L3 的追溯链是 `AMS 数据集 → source_flow_id → Workbench 任务配置`，横跨数据域与任务域。这种跨域追溯由 Agent 在单一会话内连续调用两个域的工具完成（数据域查数据集拿 `source_flow_id`/`source_task_id` → 任务域查 `GET /api/v1/workbench/tasks/{task_id}` 拿 `TaskOut.config_text` 任务配置），**不**设专门的"血缘追溯"组合工具。理由：组合工具会在 Agent 层重新实现业务编排，违反 2.3 节"最小职责边界"；且 5.5.1 节明确"单一 Agent Loop 自适应收敛"，跨域追溯正是 Agent Loop 该做的事，组合工具是过早优化。

**L6 兜底通道 tianwen-mcp 的接入方式**：`tianwen-mcp` 本身是 MCP server（基于 `@ivotoby/openapi-mcp-server` 暴露 SecretPad OpenAPI），由底座默认 Extension `pi-mcp-adapter`（见 5.1b 节）接入，而非手写 HTTP 封装为 customTool。`pi-mcp-adapter` 以 proxy 工具模式（约 200 token）按需发现 MCP 工具，Agent 需要某个 SecretPad 底层能力时才加载对应工具定义，与 4.1.1 节动态域激活理念一致，避免全量 MCP 工具定义烧 context。该通道是 L6 兜底（AMS/Workbench/Server 接口无法满足时启用），不与数据域/任务域并列、不新增工具域。

### 5.4a 隔离执行环境：`pi-coding-agent` 内置工具的沙箱化

**问题的来源**：5.4 节的业务工具（数据域/任务域/运维排查域/洞察域/平台域）都是对 AMS/Workbench/Server 既有 API 的直接封装，本质是"发一个带用户身份的 HTTP 请求"，在宿主进程里执行没有额外风险，权限边界由 5.2 节的身份透传机制兜底。但 3.1 节选定的 `pi-coding-agent` 还自带四个通用工具——`read`/`write`/`edit`/`bash`——以及支持用户直接输入 `!<command>` 触发任意 shell 命令。这类工具的执行语义是"在某台机器的文件系统和进程空间里干活"，如果不做任何隔离，默认就是宿主进程所在的那台机器：一次 `bash` 调用理论上就能读到宿主上其他会话的临时文件、耗尽宿主 CPU/内存、甚至触达内网其他服务。5.7 节确定的 Pooled 部署模型（多个用户会话共享同一批无状态实例）放大了这个问题——工具执行环境不隔离就等于租户边界不存在。这是方案 A 引入 `pi-coding-agent` 之后必须解决、而不是可选的问题。

**方案选择：Gondolin microVM，而非容器或不隔离**。`pi-coding-agent` 官方文档（`containerization.md`）本身列出了三种可选的工具执行沙箱模式——Plain Docker 容器、OpenShell（不隔离，直接宿主执行）、Gondolin（microVM）——并给出官方验证过的 Pi + Gondolin 集成范式（`host/examples/pi-gondolin.ts`）。选择依据：

| 方案 | 隔离强度 | 说明 |
| --- | --- | --- |
| 不隔离（OpenShell） | 无 | 直接判死刑：与多租户共享部署模型（5.7 节）矛盾，任何 `bash` 调用都能影响宿主和其他会话 |
| Plain Docker 容器 | 中（namespace + cgroup，共享宿主内核） | 一旦发生容器逃逸类漏洞，影响面是整台宿主机；对"允许用户输入任意 shell 命令"这种高不确定性场景，共享内核的隔离强度不够 |
| **Gondolin（microVM）** | 高（独立内核，硬件级隔离） | 每个会话的代码执行环境跑在独立的 microVM 里，即使 VM 内部命令执行出现意料之外的行为，也不共享宿主内核，爆炸半径被限制在单个 VM 内 |

选 Gondolin，原因不是"更花哨"，是它直接对应问题的严重程度：业务工具已经把风险管住了（身份透传 + HITL 分级），但 `bash`/`!command` 这类工具本质上是把"执行什么"的决定权交给了模型的自由生成内容，在没有先验白名单的前提下，只有内核级隔离才能把"最坏情况"锁定在可接受范围。选它还有一个直接原因：3.1 节已经确定基于 `pi-coding-agent` 构建，而 Gondolin 是 Pi 生态官方验证、有现成集成示例的隔离方案，不需要 `tianwen-ai` 自己摸索一套容器化方案再对接 Pi 的工具执行钩子。

**集成方式**：`pi-coding-agent` 的 `ExtensionAPI` 支持通过 `registerTool` 覆盖/包装内置工具的实际执行逻辑。`tianwen-ai` 用一个 Extension 拦截 `read`/`write`/`edit`/`bash` 四个内置工具与 `!command` 的执行请求，转发到当前请求现开的 Gondolin microVM 内执行，结果回传给 Agent Loop；除了执行位置发生变化，工具的名称、参数签名、返回结果格式对模型和上层 HITL 引擎完全透明——`bash` 该走的风险分级（5.3 节，通常按命令内容归入 L2/L3）不受影响。VM 与会话的绑定关系、生命周期管理见下文。

**VM 是纯粹的无状态计算资源，不持有任何需要跨请求保留的状态**。这是整个隔离执行环境设计的地基，来自对 Gondolin 官方仓库源码与文档的实测核查（`docs/snapshots.md`、`host/src/checkpoint.ts`、官方示例 `host/examples/pi-gondolin.ts`），不是未经验证的假设：

- Gondolin 官方示例（`pi-gondolin.ts`）里 VM 的创建/销毁完全由调用方代码控制（`session_start` 时创建、`session_shutdown` 时 `vm.close()`），Gondolin 本身不提供超时销毁、健康检查等任何"托管"能力。
- Gondolin 确实提供磁盘快照能力（`vm.checkpoint()`），但官方文档明确其为**销毁性、一次性**操作（调用后原 VM 报废，不能重启），且**只快照根磁盘，不包含 VFS 挂载内容、不包含内存/进程状态**——而 Agent 实际读写文件的正是 VFS 挂载点。这个能力天然不适合"会话状态保留并恢复"的场景，因此本设计**不采用** Gondolin 的 checkpoint 机制。

基于以上事实，状态管理改为更简单的方案：**状态从不进入 VM，只经过 VM**。会话产生的全部文件、脚本、中间数据统一写在挂载进 VM 的 `/workspace` 目录（沿用官方示例的 `RealFSProvider` 挂载方式），这个挂载点背后是宿主机侧的**共享存储**（EFS，跨 Gondolin 宿主机可访问），按 `{user_id}/{session_id}` 组织路径，路径本身由这两个 ID 确定性推导得出（如 `{共享存储根}/{user_id}/{session_id}/`），不需要额外落库记录。

**挂载隔离：VM 内只看到当前会话的 workspace 子目录，无法向上逃逸**。Gondolin VM 创建时，`tianwen-ai` 通过 bind mount 将 `{共享存储根}/{user_id}/{session_id}/` 精确挂载到 VM 内的 `/workspace`，而非把整个共享存储根暴露给 VM。这意味着 VM 内部的文件系统视角里 `/workspace` 就是根，`cd /workspace/..` 不会到达共享存储的其他用户或会话目录——bind mount 在操作系统层面限制了挂载源的范围，`bash` 工具无论生成什么命令，都无法突破这个挂载边界访问其他会话的数据。这是 5.2 节"权限不放大"原则在隔离执行环境层面的具体落地：模型可以自由地在 `/workspace` 内读写文件、执行脚本，但它的活动半径被物理限制在当前会话的 workspace 内。

**VM 网络隔离**：当前阶段暂不实施 VM 级别的网络出站限制。理由：① 天问的 `bash`/`!command` 工具主要用于文件操作与脚本执行（如数据预处理、格式校验），不依赖外部网络访问；② Gondolin VM 默认的网络配置已通过 libkrun 的微虚拟化网络栈与宿主网络做了 namespace 级别的隔离，VM 内发起的网络请求走独立的网络命名空间，不存在直接复用宿主网络栈访问内网服务的问题；③ 若后续出现需要 VM 内访问外部网络的场景（如 `pip install` 依赖包），再评估是否引入出站代理或白名单机制，不在当前阶段过度设计。

**VM 的开关粒度：会话内惰性创建、尽力复用，复用不了就重开，两种情况结果一致**。同一会话首次触发文件/命令类工具时创建 VM，之后本会话的连续调用如果仍落在同一个 `tianwen-ai` 实例上，复用该实例内存中持有的 VM 引用，直到空闲超时由该实例自己的定时器关闭；这是进程内的普通对象生命周期管理，不需要跨实例协调。如果同一会话的下一次请求被负载均衡路由到了另一个实例（该实例内存里没有这台 VM 的引用），不需要去"找到"前一个实例创建的 VM——因为找不找得到根本不影响正确性：新实例直接在任意 Gondolin 宿主上现开一台全新 VM，挂载同一个 `{user_id}/{session_id}` workspace 路径，磁盘状态与之前完全一致。唯一的差别是多付出一次冷启动开销（6.1 节），不会有数据不一致或功能异常。这就是"状态不落 VM、只落共享存储"带来的直接收益：VM 复用是纯粹的性能优化，不是正确性前提，因此不需要 5.1 节旧方案里那套"记录 VM 地址、跨实例远程调用"的机制（已同步移除）。


### 5.5 通用数据智能体框架：与业务无关的抽象设计

`tianwen-ai` 本身的定位就是数据智能体（1.2 节），本节是数据智能体的通用能力框架，与具体业务域无关。设计目标有二：① 落到天问洞察域上（5.5.6 节）；② 作为自包含、可独立参考的设计，供后续其他业务域构建数据智能体时直接参考，只需重新做一次"现状覆盖度核实 + 落地映射"，不用重新推导。为达此目标，本节推理模式、协作模式、质量保障、安全模型四节即使与 5.1a/5.2/5.3/5.8 有重叠也保留完整复述——作为独立参考文档。

#### 5.5.1 推理模式：单一 Agent Loop 的自适应收敛，不是两种模式的切换

先纠正一个常见误解：数据智能体不存在"简单问题走指令执行、复杂问题走探索式分析"两套并行模式。无论是一次工具调用就能回答的问题，还是要多轮试探的开放式分析，走的都是同一个 Agent Loop（模型调用 → 工具选择 → 执行 → 结果回填 → 判断是否收敛 → 继续或结束）。区别只在收敛需要的轮数：简单问题 1 轮收敛，复杂问题 5～10 轮。这是问题复杂度的自然结果，不需要单独设计"模式"。

真正决定推理质量的，是 Agent Loop 每一轮里的自我评估能力：不按固定脚本走，而是持续评估当前进展。某一步中间结果异常（查询返回零行、字段类型不匹配、权限校验失败），Agent 主动查异常发生在哪个环节、调整方法后重试，而不是把异常直接抛给用户或机械终止。这个"评估—调整—重试"是 Agent Loop 本身的通用能力，对所有工具域一视同仁，不只在某个特定域启用。

#### 5.5.2 上下文分层：数据智能体判断力的真正来源

模型本身的推理能力通常已经够用，真正限制数据智能体上限的，是喂给模型的上下文是否丰富、准确。把上下文按"来源可靠性和获取成本"组织成六层通用模型（不绑定任何存储技术或业务领域，与 OpenAI 原始实践的六层结构对齐，只剥离其"表格/SQL/Codex"这类自有技术栈表述）：

| 层级 | 通用定义 | 数据来源特征 | 获取时机 |
|---|---|---|---|
| L1 结构元数据 | 数据资产本身的结构性描述——字段名、类型、上下游血缘（含"由哪个任务/流程产生"这类产生关系）、历史访问 / 查询模式 | 系统天然产生，无需额外人工投入 | 可离线批量采集 |
| L2 语义标注 | 业务专家对数据资产补充的语义说明——用途、口径、已知注意事项，是结构元数据无法推断的部分 | 依赖人工维护，或复用已有的资产治理能力 | 离线积累，随资产变更更新 |
| L3 代码 / 规则派生知识 | 从生产该数据的代码逻辑、处理规则中反推出的深层含义——数据来源、粒度、更新频率、边界条件。这一层依赖的"代码"分两种形态：① 平台内部任务的处理逻辑（如 PSI/SCQL/联邦建模组件的执行规则）；② 数据接入平台时执行的取数逻辑（如导入 SQL）及其指向的上游生产口径（如更上游数仓表的 ETL 逻辑） | 需要能访问代码库、任务处理逻辑定义或取数 SQL/ETL 血缘，自动化程度取决于该访问能力覆盖到哪一环——只拿到"引用"（如任务 ID、SQL 文本）是 L1 血缘的延伸，只有进一步反推出引用背后的处理语义才算真正进入 L3 | 可自动化增量刷新（若具备派生能力），否则退化为 L2 人工补充 |
| L4 组织协作知识 | 沉淀在协作工具（文档、IM、工单）中的机构性知识——事件背景、术语解释、指标口径的权威定义 | 分散、非结构化，需要额外的采集和检索机制才能被 Agent 使用 | 按需接入，投入产出比需结合真实使用频次评估 |
| L5 记忆 | Agent 被人工纠正后沉淀的、其他层级无法有效推断的隐性知识（如特定的过滤条件、易错的隐性规则） | 由 Agent 与用户交互过程中产生，范围可分全局 / 个人 | 触发式增量积累，随交互持续增长。**技术实现**：基于 **Hindsight（`vectorize-io/hindsight`）+ `@walodayeet/hindsight-pi`**，提供 LLM 结构化事实提取、向量+图谱 hybrid 检索、三层记忆（observation/experience/world）、跨会话持久化（外置 PostgreSQL + pgvector），零胶水代码接入 pi Extension 生命周期（`pi install npm:@walodayeet/hindsight-pi`），通过环境变量 `HINDSIGHT_BANK_ID=tianwen_user_{userId}` 实现用户级 bank 隔离（详见 5.5.2a 节）|
| L6 运行时上下文 | 当以上任何层级都没有覆盖到某个数据资产、或已有信息过时，Agent 直接对目标系统发起实时查询/交互，用于兜底验证与获取最新状态 | 实时调用，不依赖预先采集 | 按需触发，是最后一道防线，不是主力信息来源。天问落地：AMS/Workbench/Server 接口无法满足时，经 `tianwen-mcp` 调 SecretPad 底层 API 兜底（见 5.5.6 节） |

**关键原则（对所有落地场景通用）**：L1 是任何数据智能体的前置条件，没有基本的结构元数据，Agent 无从下手；L2 通常是投入产出比最高的下一步，大多数组织已有某种形式的资产治理沉淀可以复用；L3 的门槛不是"有没有代码"，而是"能不能把代码/规则反推成模型可用的语义"，很多场景已有血缘引用（属于 L1 延伸），但反推语义这一步值不值得单独建设，取决于真实需求频次；L4 建不建取决于协作知识的沉淀密度，不应为了对齐框架完整性不顾成本全部建设；L5 任何场景都该有，但可以最后建，它依赖前几轮真实交互才能开始积累；L6 是通用能力，只要 Agent 具备对目标系统的只读工具就自然具备。

#### 5.5.3 协作模式：像同事一样交互，而非一问一答

数据智能体面对的问题很少能一次性说清楚，交互上应具备：

- **跨轮次保留完整上下文**：用户可以追问、修正方向、补充条件，不用每轮重新陈述背景。
- **指令不清楚时主动澄清，没人应答时给合理默认值**：既不阻塞流程，也不在模糊指令下贸然给出可能偏离意图的结果。比如时间范围未指定时默认最近一个周期，同时明确告知这个假设。
- **允许中途打断和重定向**：Agent 走错方向，用户可以直接叫停调整，不用等一整轮分析跑完。
- **高频重复分析沉淀为可复用工作流**：观察到用户反复执行同一套分析动作后，封装成一键触发的固定流程，省掉 Agent 每次重新现场编排的开销。

#### 5.5.4 质量保障：黄金用例回归，而非只看线上表现

数据智能体的开放性分析会带来"看似合理但站不住脚"的结论风险（把相关性误读为因果、样本量不足却给出确定性结论）。质量保障两条腿走路：

- **结论可回溯**：Agent 输出的每条判断都必须能关联到依据的具体查询与样本范围，接受核验，而不是给一段无来源的自然语言总结。
- **黄金用例评测（Evals）**：为高频、重要的分析场景各积累一批"输入 → 预期查询 / 预期结论范围"的黄金用例，每次 Prompt 或工具描述变更后回归比对，防止能力退化在上线前无人察觉。这类回归只能靠离线评测，线上监控指标发现不了。

#### 5.5.5 安全模型：Agent 是权限的纯粹透传层

数据智能体要访问和解读大量数据资产，安全模型上有一条铁律：Agent 的所有数据访问严格 **pass-through**，用户只能通过 Agent 查自己本来就有权访问的数据，没权限时明确提示，不静默拒绝、不试图绕行。Agent 的推理过程也必须透明，每个结论附带假设与执行步骤摘要，允许用户直接核验原始数据和每一步中间结果。这条原则和 2.3/5.2 节"权限不放大"完全一致，数据智能体只是让它在"数据访问"这个具体场景下落得更实。

#### 5.5.6 框架实例化：洞察域如何落地这套框架

洞察域（联合客群分析、数据价值发现，对应 2.1 节第二层）是上述通用框架在天问场景下的具体实例。5.4 节回答"工具怎么按域组织"，本节回答"洞察域怎么把 5.5.1～5.5.5 的通用框架接到天问已有系统上"，逐条对照天问现状，而不是假设从零建设：

**5.5.1 推理模式的落地**：洞察域不新增编排引擎，直接复用 5.1a 节已有的 Agent Loop，与数据域、任务域、运维排查域共享同一套"评估—调整—重试"机制，区别只在洞察类问题通常需要更多轮次收敛。举个例子：用户问"美团与某消金机构的客群，在联合分析后有什么值得关注的特征差异"，Agent 的推理路径是：① 先确认双方已完成 PSI 交集、SCQL 授权范围覆盖哪些字段；② 基于授权范围生成初版 SCQL 统计查询；③ 若查询因 CCL 未覆盖列而报错，回退重新生成不含该列的查询，或提示用户该维度需要先补充授权；④ 判断样本量是否有统计意义，不足就调整分析粒度重新查询；⑤ 收敛后输出结论。每一步都依赖上一步的实际结果，不是预先写死的固定序列。

**5.5.2 上下文分层的天问现状核实**（这是此前版本估计有误、经重新核实的部分）：

| 通用框架层级 | 天问现状核实结果 | 落地方式 |
|---|---|---|
| L1 结构元数据 | **已具备**。AMS `ams_dataset_column` 已有字段名、类型、注释；`ams_feature_fields` 已有 IV 值、覆盖率等使用统计 | 洞察域直接复用数据域既有只读工具查询，不新增通道 |
| L2 语义标注 | **已具备，此前判断有误**。AMS `ams_feature_fields.real_desc`/`alias_desc` 已承载业务专家撰写的字段业务含义；`ams_dataset_column.comment` 承载数据集字段级注释；`ams_digital_contracts.purpose` 承载合约用途说明 | 洞察域直接查询这些既有字段拼入上下文，**不需要新建字段说明能力** |
| L3 代码 / 规则派生知识 | **血缘引用已具备，语义反推暂不建设**（此前"完全不具备"的判断过于绝对，已重新核实）。天问的数据资产分两类来源，均可追溯"代码"这一端：① **任务产生的资产**——AMS/Wefe 数据集在完成 PSI/SCQL/联邦建模任务后落库时，写入了 `sourceFlowId`/`sourceJobId`/`sourceTaskId` 等字段（`Tracker.java`），可反查该任务具体的 Job/Flow/Task 配置与执行组件，从而定位"这份数据是被哪个任务、按什么处理规则产生的"；② **用户导入的表**——`ams_dataset_warehouse_import.sql` / Wefe `data_set.sql` 完整保存了导入时执行的取数 SQL，是这类数据集"代码级定义"的直接来源，进一步还可解析该 SQL 引用的上游数仓表、关联其 ETL 生产逻辑。但这两类目前都只到"**保留可追溯的引用**"（任务 ID、SQL 文本）为止，还没有一层自动化流水线把这些引用**反推成模型可直接使用的语义**（如 OpenAI Codex 增强那样自动生成"这张表的粒度/口径/与相似表的差异"），这一步加工能力暂不建设——真实收益取决于业务方对"表间细微差异"类问题的真实提问频次，先观察再评估是否值得建设反推流水线 | 洞察域可复用现有引用字段做浅层展示（如"该数据来自 PSI 任务 XXX"、"该数据导入 SQL 为 XXX"），但不建设自动反推语义的流水线；Agent 需要更深层解释时，退化为 L6 运行时兜底（现场追溯任务配置或原表 ETL）或 L2 人工标注 |
| L4 组织协作知识 | **已具备结构化形式，但非自由文本知识库**。AMS `ams_institutions`（机构档案）、`ams_digital_contracts`（合约与用途）、`ams_usage_records`（历史使用记录）、`bank_member_mapping`；`tianwen-web` 已有独立的"合作方管理"模块（合作方档案 / 合同管理 / 节点管理）；SecretPad 侧按"机构对"长期复用 Project | 洞察域直接查询这些既有结构化数据作为机构背景上下文，不需要建设 Slack/Wiki 式的自由文本知识库；仅当未来出现"结构化字段无法覆盖的协作细节"（如某次跨机构分歧的非结构化记录）有真实沉淀诉求时，再评估是否需要补充 |
| L5 记忆 | **由 5.1 节 L5 记忆层承接**（Hindsight，见 5.5.2a 节） | 基于 Hindsight + `@walodayeet/hindsight-pi` 实现：`session_start` 时 extension 自动按 `bankId=tianwen_user_{userId}` 连接用户专属 bank，每个用户 turn 前自动 recall 注入历史记忆，`hindsight_retain` 工具提供主动写入，`message_end` 钩子异步批量 retain 本轮内容。通过 `HINDSIGHT_BANK_ID` 环境变量实现 bank 级用户隔离，无需 config 文件。写入触发点：用户明确纠正 Agent 的分析结论时，调用 `hindsight_retain` 直存原文；会话过程内容由 extension 后台异步 retain |
| L6 运行时上下文 | **已具备**（5.4 节工具集 + `tianwen-mcp` 兜底） | 洞察域复用数据域、任务域既有只读工具做实时查询兜底，包括现场查询 L3 未覆盖的任务配置或原表 ETL 细节；当 AMS/Workbench/Server 接口无法满足时，经 `tianwen-mcp`（基于 `@ivotoby/openapi-mcp-server`，全量暴露 SecretPad OpenAPI 为 MCP 工具）调 SecretPad 底层 API 兜底。`tianwen-mcp` 与 AMS/Workbench/Server 同级，是 L6 底层通道，不新增工具域、不破坏 5.4 节服务边界划分 |

重新核实后的结论和此前版本有实质差别：天问在 L1/L2/L4/L6 四层已有基础，L3 有血缘引用但不建语义反推流水线，真正要新建的只有 L5 记忆写入触发点这一项，而不是此前误判的"资产语义层要新建字段说明"或"L3 完全不具备"。这个结论也印证了 2.3 节"渐进式建设"：先盘点已有能力再决定建不建，而不是照搬参考框架的完整性生搬硬套。L3 的"引用可查、语义不自动反推"是当前投入产出比最合理的取舍点，不是终态结论，等真实需求密度验证后可再升级。

#### 5.5.2a L5 记忆层技术选型：候选方案对比与落地决策

记忆不是 KV 存储，它涉及：去重（同一事实不同表述）、可信度权重（Agent 推断 vs 用户明确指正）、遗忘（过时信息降权）、语义检索（不能只靠关键词）、生命周期压缩（工作记忆→长期记忆）。本节是在对 Pi 生态与主流开源 memory 方案实际调研后的选型结论，不是设想。

**候选方案调研摘要**：

| 方案 | 本质 | TypeScript 原生 | 存储后端 | 与 Pi Extension 集成复杂度 | 记忆质量 |
| --- | --- | --- | --- | --- | --- |
| **Hindsight + `@walodayeet/hindsight-pi`** ✅ 选用 | 独立记忆服务（REST API + PostgreSQL），官方维护 pi Extension | ✅ TypeScript Extension | 外置 PostgreSQL 14+（pgvector）；内置 pg0 仅供开发 | 🟢 **零**：`pi install npm:@walodayeet/hindsight-pi`，通过 `HINDSIGHT_BASE_URL` / `HINDSIGHT_BANK_ID` 环境变量注入，不需要写一行胶水代码，不需要 config 文件 | ⭐⭐⭐⭐⭐：LLM 事实提取、向量+图谱 hybrid 检索（semantic/temporal/entity/causal 四类链路）、三层记忆（observation→experience→world consolidation）、跨会话持久化、auto-retain + recall 全生命周期管理 |
| **oh-my-pi `@oh-my-pi/pi-mnemopi`** ❌ 不可用 | pi 的功能增强 fork，内含 Mnemosyne 记忆引擎 | ✅ Bun/TypeScript | SQLite WAL + FTS5 + ONNX 本地向量（BGESmallEN-v1.5，384维） | 🟢 **零**：内置生命周期挂载，不需要写一行胶水代码 | ⭐⭐⭐⭐⭐：双层记忆、5维混合评分、MMR 重排去重、veracity 权重。**硬限制**：存储层写死 `bun:sqlite`，天问 ai Node.js 运行时下 `Cannot find module 'bun:sqlite'`，无法运行 |
| **mem0 OSS (`mem0ai/mem0`)** | 通用 AI memory 库，与 Agent 框架解耦 | ✅ TypeScript SDK v3.1.6 | SQLite embedded（`better-sqlite3`）+ fastembed 本地 ONNX | 🟡 低（~50 行胶水代码） | ⭐⭐⭐⭐：LLM 提取结构化事实、向量检索、去重；无内置遗忘/衰减；跨会话持久化需自行管理；无原生 pi Extension |
| **TencentDB-Agent-Memory** | 重量级 AI Agent memory 框架，为 OpenClaw 定制 | ✅ TypeScript，以 OpenClaw/Hermes 插件发布 | SQLite 本地；需独立 Gateway 进程 | 🔴 高：OpenClaw 专有 hook，Pi 无对等钩子 | ⭐⭐⭐⭐⭐：强项依赖 OpenClaw 专有机制，Pi 生态无法复用 |

**选型决策：以 Hindsight（`vectorize-io/hindsight`）+ `@walodayeet/hindsight-pi`  为 L5 记忆层的实现基础。**

理由：
1. **原生 pi Extension，零胶水代码**。`@walodayeet/hindsight-pi` 是专为 pi 开发的官方 Extension，`pi install npm:@walodayeet/hindsight-pi` 一条命令完成安装，全部 recall/retain 生命周期钩子（`session_start` → `before_agent_start` → `context` → `message_end`）由 Extension 内置实现，不需要写一行胶水代码。
2. **配置无文件依赖，SDK 集成友好**。所有配置通过环境变量注入：`HINDSIGHT_BASE_URL` 指向统一 Hindsight 服务，`HINDSIGHT_BANK_ID=tianwen_user_{userId}` 在 agent server 启动时按用户动态注入，多台 agent server 横向扩容时零配置，不需要在每台机器上维护 `~/.hindsight/config.json`。
3. **记忆核心能力远超 mem0**。向量+图谱四维 hybrid 检索（semantic/temporal/entity/causal）、三层 consolidation（observation→experience→world）、跨会话持久化——这些是 FTS5 或纯向量检索无法覆盖的能力，对"某机构 XYZ 字段总是 null"这类跨会话隐性规则的召回尤其关键。
4. **存储接入公司现有 PostgreSQL，统一 DB 管控**。`HINDSIGHT_API_DATABASE_URL=postgresql://...` 直连外置 PG（需 pgvector 扩展），嵌入式 pg0 仅供本地开发，生产环境统一走公司 PG 集群，不引入新的存储基础设施。读写分离也支持：`HINDSIGHT_API_READ_DATABASE_URL` 可将 recall 查询路由到只读副本。

---

**Hindsight 内部设计展开**（不依赖开源文档的完整设计说明）：

##### 记忆分层模型

Hindsight 将记忆按抽象层级分为三层，自动在层间进行 consolidation（压缩提炼）：

```
observation（观察）
  ├─ 原始颗粒：每次 retain 后 LLM 从会话内容提取的具体事实
  ├─ 与 document 绑定（stable document_id），支持 append 追加
  └─ 标注 tags / entities / timestamp，可按 tag 过滤召回

     ↓ consolidation（后台定期运行，LLM 归纳）

experience（经验）
  ├─ 由多条 observation 归纳而来的持久模式
  ├─ 示例："用户 A 的 PSI 任务每次都需要先检查 id 字段编码一致性"
  └─ consolidation 过程会更新/合并已有 experience，避免重复积累

     ↓ 更高层归纳（world consolidation）

world（世界知识）
  ├─ 跨用户共性事实，与特定用户无关
  ├─ 示例："建设银行信用卡数据集的 card_no 字段为 SHA256 哈希值"
  └─ 天问场景中存入 tianwen_global bank，全平台共享
```

recall 时可按需指定 `types: ["observation", "experience"]`（用户级个性化记忆）或 `types: ["world"]`（平台级共性知识），也可组合。

##### 知识图谱与 entity 链接

每次 retain 时，Hindsight 同步提取记忆中涉及的实体（entity）并建立关联：

- **实体类型**：PERSON、DATASET、INSTITUTION、TASK、CONCEPT 等，可自动识别或手动注入
- **链接类型**：`entity`（记忆与实体的归属关系）/ `semantic`（语义相似链路）/ `temporal`（时序因果链路）/ `caused_by`（显式因果关系）
- **图谱作用**：recall 时除向量相似度外，还走图谱遍历路径（graph recall），能找到"虽然语义距离较远但通过实体关联可达"的记忆——例如召回"card_no 字段问题"时，能关联到"建设银行机构档案"和"上次 PSI 任务失败"

这是纯向量 recall（如 mem0）无法覆盖的能力，对天问跨机构协作场景下"某机构的特定数据问题"这类关联检索尤其有价值。

##### retain 流水线（写入路径）

每次调用 `POST /v1/default/banks/{bank_id}/memories` 时，后台执行：

```
1. 内容预处理
   └─ 对输入 content 按 maxMessageLength 切片（默认 25000 字符），分片并行处理

2. 事实提取（LLM 调用 retain_extract_facts）
   └─ 使用 HINDSIGHT_API_LLM_MODEL 提取结构化事实列表
   └─ 每条事实标注 timestamp、relevance、entity 引用
   └─ 支持 structured JSON output（需模型兼容 json_object 格式）

3. 实体识别与归一化
   └─ 提取 content 中的实体并与已有实体去重合并
   └─ 写入 entities 表，建立 entity 链路

4. observation 写库
   └─ 按 document_id + update_mode(append/replace) 管理 document
   └─ 写入 observations 表，关联 entity 链路和 tags

5. 异步 consolidation 触发（可配置频率）
   └─ 后台 worker 将新增 observation 归纳为 experience
   └─ 更新 world 层跨 bank 共性知识
```

retain 操作支持 `async: true`（立即返回，后台处理）和 `async: false`（同步等待完成）。天问场景中 `message_end` 自动 retain 走 `async: true` 不阻塞响应；用户主动确认写入记忆时走 `async: false` 确保落库。

##### recall 流水线（检索路径）

每次调用 `POST /v1/default/banks/{bank_id}/memories/recall` 时，后台执行：

```
1. query 理解
   └─ 对 query 文本做向量化（embedding）
   └─ 可选：LLM 扩写 query（reflect 模式）

2. 四维并行检索
   ├─ semantic recall：向量余弦相似度（pgvector ANN 索引）
   ├─ temporal recall：基于 query_timestamp 的时序邻近检索
   ├─ entity recall：从 query 提取实体后走图谱遍历
   └─ BM25 recall：全文关键词匹配（PostgreSQL tsvector）

3. 跨维度 fusion 与重排
   └─ RRF（Reciprocal Rank Fusion）合并四路结果
   └─ cross-encoder reranker 对 Top-N 候选做精排（slim 版可外置 TEI 服务）

4. budget 控制输出
   └─ low/mid/high 对应不同的 max_tokens 预算（默认 mid = 4096 token）
   └─ 超出 budget 时截断，保留最相关结果

5. reflect（可选，hybrid/context 模式触发）
   └─ 用 LLM 对 recall 结果做综合归纳，生成一段语境化记忆摘要
   └─ 直接作为 <hindsight_memories>...</hindsight_memories> 注入 system context
```

##### pi Extension 接入点（`@walodayeet/hindsight-pi`）

Extension 挂载在以下 pi 生命周期钩子上，天问 agent server 无需写任何代码：

| 钩子 | 时机 | Extension 行为 |
|---|---|---|
| `session_start` | pi 会话启动 | 读取环境变量配置，连接 Hindsight service，自动创建不存在的 bank（`autoCreateBank: true`） |
| `before_agent_start` | 每次用户 turn 开始前 | 从 user input 派生 recall query，跳过空 query / slash 命令 / 超长 query（可配置 `recallLongQueryBehavior`）|
| `context`（provider context hook） | 模型调用前构建 context | 执行 recall，将结果封装为 `<hindsight_memories>...</hindsight_memories>` 注入 context（ephemeral，不写 session history），过滤旧的 `hindsight-recall` 消息防污染 |
| `message_end` | 每条消息处理完成后 | 序列化当前消息（user/assistant/toolResult），加入本地队列（`.hindsight/queue/`），按 `writeFrequency` 批量 retain（默认 `async`）|
| `session_before_compact` | pi compaction 前 | 将队列中未 retain 的记录先 flush，确保 compaction 不丢记忆 |

Extension 还注册三个 LLM 工具，Agent 可主动调用：

| 工具 | 功能 | 参数 |
|---|---|---|
| `hindsight_search` | 原始 recall，返回原始记忆片段列表 | `query`, `budget?` |
| `hindsight_context` | reflect 模式，LLM 综合归纳后返回一段语境化答案 | `query`, `context?`, `budget?` |
| `hindsight_retain` | 显式写入记忆（用户纠正/重要决策） | `content`, `context?` |

##### 关键配置项（天问场景关注点）

通过环境变量注入，无需 config 文件：

| 环境变量 | 天问场景设定 | 说明 |
|---|---|---|
| `HINDSIGHT_BASE_URL` | `http://hindsight-svc:9290` | Hindsight service 地址，所有 agent server 共用一个实例 |
| `HINDSIGHT_BANK_ID` | `tianwen_user_{userId}` | 每次启动 pi 时按当前用户动态注入，实现 bank 级隔离 |
| `HINDSIGHT_BANK_STRATEGY` | `manual` | 使用显式指定的 bank_id，不做路径推导 |
| `HINDSIGHT_RECALL_MODE` | `hybrid` | recall 后用 reflect 做综合归纳，注入 context |
| `HINDSIGHT_RECALL_TYPES` | `observation,experience` | 用户级个性化记忆；global bank 另行配置 world 层 |
| `HINDSIGHT_CONTEXT_TOKENS` | `1500` | 注入 context 的记忆 token 预算（视 LLM context window 调整）|
| `HINDSIGHT_WRITE_FREQUENCY` | `async` | 异步批量 retain，不阻塞响应 |
| `HINDSIGHT_SAVE_MESSAGES` | `true` | 自动 retain 每轮对话内容 |
| `HINDSIGHT_AUTO_CREATE_BANK` | `true` | 首次遇到新用户时自动创建 bank |
| `HINDSIGHT_API_DATABASE_URL` | `postgresql://host/tianwen_hindsight` | Hindsight service 侧配置，指向公司 PG 集群 |
| `HINDSIGHT_API_LLM_MODEL` | 与 tianwen-ai 主模型一致 | 用于事实提取和 consolidation，走公司内网 LLM 网关 |
| `HINDSIGHT_API_RETAIN_LLM_PROVIDER` | `lmstudio`（或 `openai`） | retain 阶段 structured JSON output 的 provider 标签（关系到 json_object 是否发送，见下方注意事项）|

**注意事项**：Hindsight 的 `retain_extract_facts` 和 `consolidation` 阶段需要 LLM 返回结构化 JSON。当 LLM 网关不支持 `response_format: {type: "json_object"}` 时，需将 provider 标签设为 `lmstudio` 或 `volcano`（这两个标签在 Hindsight 中会跳过 json_object 参数，改为 schema-in-prompt 方式）。天问 ai 接入内部 LLM 网关时需提前验证该网关对 json_object 的支持情况，并选择对应的 provider 标签。

---

**部署架构**：

```
tianwen-ai agent server 集群（n 台，无状态）
  每台以 SDK 集成方式启动 pi，注入：
    HINDSIGHT_BASE_URL=http://hindsight:9290
    HINDSIGHT_BANK_ID=tianwen_user_{userId}   ← 每个用户动态设置
    HINDSIGHT_BANK_STRATEGY=manual
         │
         ▼
  Hindsight service（独立部署，1 个实例）
    HINDSIGHT_API_DATABASE_URL=postgresql://pg-host:5432/tianwen_hindsight
         │
         ▼
  共享 PostgreSQL（pgvector 扩展）
```

**记忆隔离与 scope**：每用户一个独立 bank（`tianwen_user_{userId}`），bank 之间数据完全隔离。平台级隐性规则（如"某机构数据类型扫描总是报 false positive"，对所有用户生效）通过单独的 `tianwen_global` bank 存储，agent server 启动时同时配置 `globalBankId=tianwen_global`，recall 时 Extension 自动合并两个 bank 的结果。

**写入触发点**：与 5.3 节 HITL 机制对齐。`hindsight_retain` 工具写入记忆是 L1 操作（影响后续会话行为），需用户知情同意：Agent 在用户明确纠正其分析结论时调用该工具生成记忆草稿，展示给用户确认后落库（Extension 直接 retain，内置 LLM 事实提取）。会话过程内容由 Extension 后台在 `message_end` 时异步 retain，不阻塞响应。

**Hindsight 不具备 mnemopi 的部分能力**（差距如实列出）：Hindsight 没有 mnemopi 的 veracity 权重（`stated`/`inferred`/`tool` 三级）、没有 MMR 重排去重（Hindsight 靠图谱 diversity 替代）、没有三级时间衰减降级（Hindsight 靠 consolidation + world 层归纳替代）。这些差距在天问当前场景下均有替代路径，不影响核心需求。

**TencentDB-Agent-Memory 为何不选**：它的强项是短期 token 压缩（Mermaid canvas offloading，WideSearch 节省 61% token）和团队级共享记忆，这两个能力依赖 OpenClaw 专有的 `after-tool-call-messages` 拦截钩子，在 Pi 无对等机制；同时它的核心访问入口需要独立 Gateway 进程，与 5.1 节"进程内 SDK 集成"的架构决策相悖。若天问未来迁移到 OpenClaw 框架，可再评估。

**5.5.3 协作模式的落地**：复用 5.1a 节 Agent Loop 天然具备的多轮对话能力，洞察域不需要额外设计跨轮次上下文保留机制；"高频分析沉淀为工作流"作为后续方向（见第七章），等观察到真实的重复分析套路后再评估。

**5.5.4 质量保障的落地**：接入 5.8 节的黄金用例回归机制，为洞察域积累"给定双方数据特征 → 预期分析方向与结论范围"的黄金用例，从洞察域上线第一天就开始积累。结论必须可回溯到具体 SCQL 查询与样本量，用户或 RD 可直接核验。

**5.5.5 安全模型的落地**：洞察域的所有分析类工具维持 5.3 节定义的 L0（只读分析）/L1（生成建议）风险等级不变，分析结论本身不触发任何写操作；任何基于洞察结论的后续动作（如据此发起新任务、调整授权）仍需回到基础域走正常的风险分级与 HITL 确认流程，洞察域不能成为绕过既有风险控制的捷径。

**主动发现价值的触发方式**：2.1 节第二层目标要求"主动发现有价值的特征组合并给出建模/分析建议"，落地方式不是让 Agent 无节制地后台跑分析，而是绑定到两类确定性触发点：任务完成后的伴随分析（复用任务域已有的任务状态事件，在授权字段范围内自动跑一轮轻量级描述性统计，附在完成通知里）；用户主动请求的开放式探索（用户明确说"帮我看看这批数据有没有价值"时，才进入完整的多轮分析闭环，允许更深的推理和更高的 token 消耗）。刻意不做"Agent 全自动无边界主动分析全平台数据"这种方案，因为在真实需求密度验证之前，那就是过度设计。

这条"触发点必须确定性、不做无边界后台自动化"的原则是本文档对**业务侧**（数据域扫描、洞察域分析）主动能力的通用约束，同样适用于 5.6 节数据类型扫描这类看似"主动"的诊断：它们都挂在用户已发起的会话/请求链路上（上传前扫描挂在"用户发起上传"这个动作上，任务失败诊断挂在"报错发生"这个事件上），本质仍是 5.1 节无状态会话模型下、由某次用户请求触发的一次工具调用，不是脱离会话的后台任务，因此 5.4 节 L0/L1 风险分级"不需要确认"的判定语境依然成立。

这条约束**不覆盖平台侧**（2.1 节第三层"节点健康、任务异常、模型效果与稳定性指标的智能巡检"）。平台侧巡检的本质是脱离具体用户会话、由定时调度或独立事件总线驱动的后台任务，不是"某次用户请求触发的工具调用"，因此不落在 5.1 节无状态会话模型的覆盖范围内，也不是本设计要解决的问题——它依赖的定时调度器/事件驱动能力当前并不存在，属于超出本文档范围的独立系统，留待后续单独设计（详见第七章）。本文档在此明确边界，避免读者把"平台巡检"误解为"5.1 节会话模型的一种特例"。

### 5.6 异常排查场景：对应 1.3 节三类核心痛点的具体承接机制

本节直接回应 1.3 节"业务无法独立跑通任务、全程依赖 RD 人肉兜底"的痛点，也是 1.2 节「基础能力」中「智能排错」的具体落地。三类痛点与 Agent 承接机制的对应关系：

| 1.3 节痛点                                                   | RD 当前的人肉排查动作                                        | Agent 承接机制                                                                                                                                                           | 对应工具/风险等级                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| 数据类型定义不严格，类型转换反复报错                         | 人工查看报错栈定位到具体字段，反馈业务方检查数据             | 数据上传/接入前主动做类型与空值扫描，在报错发生前就提示"该字段疑似存在类型不一致风险"；报错发生后自动关联到具体字段和样例脏数据                                          | 数据域工具，L0（只读扫描与诊断，不改数据）                   |
| 报错信息业务方看不懂，本方需查服务器日志、对方需协调人员定位 | 本方：登录服务器人工翻查日志；对方：IM/邮件协调对方技术人员  | 本方节点：通过 WS 指令通道下发**运行时日志检索指令**，自动拉取并将原始日志翻译为业务可读的根因说明；对方节点：结构化整理"需要对方提供的排查信息清单"，降低跨机构沟通的来回轮次 | 运维域工具，L0（只读日志检索，需 tianwen-server/tianwen-agent 扩展，见下） |
| SCQL 语法与 CCL 权限反复调整报错                             | 人工审查 SQL 语法、逐条核对 CCL 授权范围是否覆盖查询涉及的列 | 任务提交前静态校验 SCQL 语法；报错后比对报错列与当前 CCL 授权范围，直接指出"缺失哪些列的授权"而非让业务方自己猜                                                          | 任务域工具，L0（只读校验）/ L1（生成修复建议，不直接改权限） |

**技术实现**：核心诉求是跨节点取运行时业务日志、诊断根因。`tianwen-server` 的 `ConnectionManager.send_instruction` 已具备"向指定节点下发指令并等待响应"的传输能力（含 300 秒超时、断线异常处理，已核实 `ws/manager.py:91`），但**当前不存在"运行时日志检索"这一指令类型**——已核实：tianwen-server 侧 `send_instruction` 只下发过 `health_check`/`bundle_install`/`docker_exec`/`kubectl_delete` 四种指令，Python `tianwen-agent` 的 `INSTRUCTION_TYPES` 白名单也无 `log_search`；现有的 `GET /nodes/{node_id}/logs` 只查 tianwen-server 本地 `InstallLog` 表（安装/升级历史），不查节点运行时日志。因此这是**需扩展的跨组件工作项**，不是"直接复用既有能力"：

- **tianwen-agent 扩展**：新增专用只读指令类型 `log_search`（参数：日志路径/关键词/时间范围/行数上限），纳入 `INSTRUCTION_TYPES` 白名单，实现上限定只能检索预设日志路径、不能执行任意命令——以此维持 **L0 只读** 风险分级，不走 `docker_exec`（那会在容器内执行任意命令，属 L2/L3 高危）。
- **tianwen-server 扩展**：新增一个 HTTP 接口（如 `GET /api/v1/nodes/{node_id}/runtime-logs`），内部走 `ConnectionManager.send_instruction` 下发 `log_search` 指令并等待响应。`tianwen-ai` 运维域工具调用这个 HTTP 接口，携带用户身份（5.2 节透传），下沉到 tianwen-server 现有鉴权。

```typescript
// 运维域工具示例：查询节点运行时日志（伪代码，调用 tianwen-server 扩展后的接口）
// 注册为 pi-coding-agent 的 customTool，在宿主进程内执行 HTTP 调用
async function getNodeLogs(args: { node_id: string; keyword: string }, ctx: ToolContext): Promise<string> {
  // 权限校验：用户是否有权限查看该节点（下沉到 tianwen-server 现有鉴权，ctx.userCtx 透传 ssoid）
  // 指令下发：tianwen-server 内部走 ConnectionManager.send_instruction → tianwen-agent 执行 log_search（只读、白名单限定检索路径）
  const result = await tianwenServerClient.getRuntimeLogs({
    nodeId: args.node_id,
    keyword: args.keyword,
    userCtx: ctx.userCtx, // 携带发起用户身份，见 5.2 节
  });
  return result;
}
```

**不新增 SSH 通道，不新增独立的日志采集机制**。这是此前方案讨论中明确的安全边界：跨节点访问只能走既有的、经过指令白名单校验的 WebSocket 通道，任何新增直连能力都会扩大攻击面。对方机构节点不在美团侧管控范围内，Agent 不能也不应跨过信任边界取对方日志，只能做到"结构化整理需要对方提供什么信息"。这是隐私计算跨机构协作必须尊重的边界，不能为了排查方便破坏它。

多节点并发排查时，要在 `ConnectionManager` 层面新增按用户维度的并发限制（见 5.7 节），防止单个排查任务占满指令通道、影响其他用户的正常操作。

### 5.7 多租户与限流

`tianwen-ai` 采用 **Pooled 部署模型**：所有用户共享同一批无状态 Agent 实例，租户边界靠每次工具调用携带的用户身份实现，而不是靠独立进程/实例隔离。天问当前没有强合规隔离诉求（不像金融监管场景要求物理隔离），这个模型与现状匹配；以后若出现必须物理隔离的机构（如监管要求独立部署），在 Pooled 模型上叠加针对特定租户的 Siloed 实例即可，不用推翻整体架构。

限流与串行化分三层，都基于既有基础设施，不引入新组件：

- **入口层**：按用户维度做请求 QPS/并发限制，复用现有网关/中间件能力（Nginx 限流模块或应用层计数），不用为此引入 Redis 这类新依赖。
- **会话串行化层（防 jsonl 双写损坏 + 防 HITL 互踩）**：同一 `session_id` 的请求由 MySQL 会话锁（`GET_LOCK(session_id, timeout)`）串行化，抢到锁的实例才 open 会话文件操作。这是 5.1 节「Pi `SessionManager` 单写者、无文件锁」这一核实事实的必然要求——水平扩展下同会话两请求落两实例会损坏 jsonl。锁同时承担 5.3 节 HITL 竞态防护（同会话任意时刻只有一个实例推进，被 block 的工具调用不会被两个确认/消息互踩）。锁是 per-session 请求级短期互斥，连接断开自动释放，进程仍无状态，不引入 Redis。不同 `session_id` 间不互斥，不影响跨会话并发。
- **跨节点指令层**：在 `ConnectionManager.send_instruction` 之上加按用户维度的并发指令数上限，防止单用户的批量排查请求打满某个节点的指令通道。

**会话 TTL**：当前不设会话级别的自动过期清理，会话 jsonl 文件在共享文件系统中持久保留。后续会与 5.4a 节 workspace 目录的归档清理一起，设计统一的会话归档机制，不在本文档范围内。

### 5.8 可观测性与生命周期治理

**Trace 接入**：全部会话通过 `@amaster.ai/pi-telemetry` 接入内部 Langfuse，记录完整推理链路：每次模型调用的输入输出、每次工具调用的参数与结果、每次 HITL 暂停与恢复。这是排查"Agent 为什么做了这个操作"的权威数据源。

**`@amaster.ai/pi-telemetry` 内部设计展开**（不依赖开源文档的完整设计说明）：

`@amaster.ai/pi-telemetry`（`v0.1.8`，Apache-2.0）是专为 `pi-coding-agent` 生态开发的官方可观测性 Extension，通过 `pi install npm:@amaster.ai/pi-telemetry` 安装后自动激活，无需写任何胶水代码。底层依赖 `langfuse@^3.38.20` SDK，同时支持 OpenTelemetry OTLP Exporter。

**Extension 钩子与事件映射**：Extension 挂载在 `pi-coding-agent` 的全部运行时生命周期事件上，每类事件直接映射为 Langfuse 中对应的 Observation 类型：

| Pi 生命周期事件 | 触发时机 | Langfuse 映射 |
|---|---|---|
| `session_start` | 会话初始化完成 | 读取配置，初始化 Langfuse/OTel Exporter |
| `input` | 用户输入到达 | 为本轮 turn 生成新 `traceId`，注入 `PI_TELEMETRY_TRACE_ID` 等环境变量 |
| `turn_start` | Agent Loop 开始本轮推理 | 创建 `chat_turn_started` Trace + 根 Span（`chat-turn`） |
| `before_provider_request` | 每次向 LLM 发请求前 | 创建 `llm-generation [main]` Generation（`status=started`），记录完整入参 |
| `message_end` | LLM 响应完整收到 | 更新 Generation（`status=completed`），记录 token 用量（input/output/cacheRead/cacheWrite/totalTokens）及响应内容 |
| `after_provider_response` | Provider 返回 HTTP 4xx/5xx | 更新 Generation（`status=failed`），记录 HTTP 错误码 |
| `tool_execution_start` | 工具调用开始执行 | 创建子 Span（`status=started`），记录工具名和参数 |
| `tool_execution_end` | 工具执行完成/出错 | 更新子 Span（`status=completed` 或 `failed`），记录工具输出摘要 |
| `model_select` | Agent 切换模型 | 创建 `chat_turn_steered` 事件，记录 from/to model |
| `session_compact` | 上下文压缩触发 | 创建 `chat_turn_steered` 事件，记录 `eventType=session_compact` |
| `turn_end` | Agent Loop 本轮结束 | 关闭根 Span，记录最终输出和耗时 |
| `session_shutdown` | 会话销毁 | 调用 `exporter.flush()` + `exporter.close()`，确保所有待发数据上传 |

**Trace 层次结构**：每个用户 turn 对应 Langfuse 中一个独立 Trace（`traceId` 按 turn 轮换），Trace 内部的 Span 层次如下：

```
chat-turn (根 Span)
├── llm-generation [main] [continuation/request]  (Generation)
│   └── （多次模型调用均挂在此 trace 下，按 llmGenerationId 区分）
├── bash [命令摘要]          (工具 Span)
├── read [文件路径摘要]       (工具 Span)
├── ams_query_dataset [...]  (工具 Span)
└── subagent [子 agent 名]   (Subagent Span，若有子 agent 则嵌套)
```

**Subagent Trace 传播**：当 pi 通过 `sessions_spawn` 工具派生子 Agent 时，Extension 通过环境变量 `PI_TELEMETRY_TRACE_ID`/`PI_TELEMETRY_SESSION_ID`/`PI_TELEMETRY_OWNER_PID` 将 traceId 传递给子进程。子 Agent 内的 `pi-telemetry` Extension 检测到这些变量后，将自己产生的所有 Span 挂在父 Trace 下，而非创建新 Trace——天问目前不使用子 Agent，但这个机制对未来扩展保留了透明支持。

**双 Exporter 架构**：Extension 在 `session_start` 时根据配置同时初始化 Langfuse SDK Exporter 和 OpenTelemetry OTLP Exporter，两个 Exporter 都激活时用 `CompositeRuntimeEventExporter` 串联，不激活时降级为 `NoopRuntimeEventExporter`（零开销）。天问只需要 Langfuse，不使用 OTel Exporter，保持 OTel 配置为空即可。

**关键配置项**（通过环境变量注入，无需 config 文件）：

| 环境变量 | 含义 | 天问配置建议 |
|---|---|---|
| `LANGFUSE_ENABLED` | `true`/`1` 启用 Langfuse Exporter | 生产环境设为 `true` |
| `LANGFUSE_PUBLIC_KEY` | Langfuse 项目 Public Key | 指向内部 Langfuse 实例的 Key |
| `LANGFUSE_SECRET_KEY` | Langfuse 项目 Secret Key | 同上 |
| `LANGFUSE_BASE_URL` | Langfuse 实例地址 | 指向内部部署的 Langfuse（`https://langfuse.internal.meituan.com`） |
| `TELEMETRY_SERVICE_NAME` | Trace 中的 `serviceName` 标签，用于跨项目区分 | 设为 `tianwen-ai` |
| `TELEMETRY_INCLUDE_PAYLOADS` | `true` 时记录完整 LLM 入参/出参和工具调用参数；`false`（默认）时只记录元数据，不记录内容 | **生产环境保持默认 `false`**（含明文 SQL、机构数据等敏感内容，不应全量上传）；排查问题时临时设为 `true` |
| `LANGFUSE_FLUSH_AT` | 攒多少条事件后批量上传（默认 `20`） | 保持默认 |
| `LANGFUSE_FLUSH_INTERVAL_MS` | 定时批量上传间隔（默认 `5000ms`） | 保持默认 |

**Payload 裁剪规则**：`TELEMETRY_INCLUDE_PAYLOADS=false` 时，Extension 自动 strip 掉所有 LLM Generation 的 `input`/`output`/`error` 字段，以及 Tool Event 的 `args`/`details`/`error` 字段，只上传 traceId、sessionId、toolName、toolCallId、model、token 用量、时间戳等元数据。天问的工具调用参数中可能包含机构名称、SQL 查询内容、字段名等业务敏感信息，因此**生产环境强制关闭 payload 上传**，排查时在本地或受控环境临时开启。

**`tianwen-ai` 与 Langfuse 的连接**：Extension 通过内部 Langfuse 实例（不走公网 `cloud.langfuse.com`）上传 Trace 数据。`tianwen-ai` 在 Langfuse 中独占一个项目（按 `TELEMETRY_SERVICE_NAME=tianwen-ai` 标签区分），每个用户 turn 一条 Trace，Trace 中完整记录该 turn 内所有模型调用（含 token 用量）和工具调用（含工具名、执行状态），是成本分析和行为审查的一手数据源。

**核心监控指标**：

- 单会话/单用户的 token 消耗。这是成本可观测性的一等指标，用来防"吵闹邻居"和成本失控（AWS 多份 Agent 实践文档都强调这一点）。
- 各工具的调用频率与失败率，用来发现哪些工具描述不清晰导致模型误用、哪些下游服务不稳定。
- HITL 确认率与拒绝率，用来校准风险分级是否合理。某个 L1 工具如果频繁被用户手动纠正，可能要升到 L2。

**Prompt 与工具描述版本化**：System Prompt 和工具描述不硬编码为代码里的字符串常量，而是独立的配置文件（含版本号），支持脱离服务发布独立迭代和回滚，改个措辞不用走一次完整部署。

**质量回归靠黄金用例评测（Evals），不只看线上指标**。Trace 和监控指标能发现"运行时出了什么问题"，回答不了"这次 Prompt/工具改动有没有让原本能处理好的场景变差"，后者只能靠离线评测覆盖。做法是：为 1.3 节的高频结构化场景（发起 PSI/SCQL 任务、数据类型报错诊断、CCL 权限缺失诊断）各积累一批"输入 → 预期工具调用序列 / 预期诊断结论"的黄金用例，每次 Prompt 或工具描述变更后跑一遍，比对实际工具调用与预期是否一致、诊断结论是否命中。不需要引入新评测框架，用现有内部评测工具或简单脚本比对就够；黄金用例集随能力落地同步积累，避免上线后 Prompt 反复调整却没有量化依据判断好坏。

---

## 六、非功能性设计

### 6.1 性能

工具调用超时策略与被调用服务本身的 SLA 一致（查询类接口沿用 AMS 现有超时配置，不额外收紧或放宽）；跨节点指令下发沿用 `ConnectionManager.send_instruction` 现有的 300 秒超时上限。

**隔离执行环境的冷启动开销**：5.4a 节引入的 Gondolin microVM 相比宿主进程内直接执行，会带来 VM 创建的冷启动延迟。这部分开销在会话首次触发文件/命令类工具时必然发生；同一会话的后续调用如果仍由创建该 VM 的那个实例处理，可以复用内存中的 VM 引用免掉冷启动，但如果被负载均衡路由到其他实例，会重新付出一次冷启动（详见 5.4a 节"VM 的开关粒度"）——这只影响性能，不影响正确性，因为 workspace 状态在共享存储上，与具体是哪台 VM 无关。纯业务工具调用（5.4 节四/六个域）完全不经过 Gondolin，不受影响。具体冷启动耗时数值同 6.1 节其他性能指标一样不预设，待接入后基于实测数据判断是否需要预热池等优化手段。

**Prompt Caching**：System Prompt、工具描述、语义层上下文（5.5.2 节 L1/L2）这类每轮对话都重复拼入、内容基本不变的部分，通过内部 LLM 网关的提示词缓存命中缓存，只有会话历史与本轮新增内容需要重新推理。这是省 token 成本、降首字节延迟最直接的手段，属于 Agent Runtime 通用组件，业务域不用自己处理。

**与动态工具加载（4.1.1 节第二层）的权衡**：动态加载模式下，工具 schema 不是全量常驻，而是由模型按需调 `activate_domain` 加载。这看似会破坏 cache 前缀（工具定义是缓存前缀的一部分），但经核实 Pi 官方文档，在**支持原生 deferred loading 的模型**上并非如此：Anthropic（Sonnet/Opus/Fable ≥4.5）用 `defer_loading`+`tool_reference`，OpenAI（gpt-5.4+）用 `tool_search_call`——新增工具定义**锚定在 tool-result 位置加载，不改变初始 tool-schema 前缀，cache 保留**。其他模型走 fallback（完整 active 列表）会失数 cache 前缀。因此天问的模型选型要求：**走内部 LLM 网关时，优先选用支持原生 deferred loading 的模型**（≥4.5 的 Sonnet 或 gpt-5.4+），需与网关团队对齐可用模型。按 Pi 官方缓存建议落实三条：① loader（`activate_domain` 元工具）常驻整个会话、只加工具不换（`setActiveTools` 保持 additive）；② 懒加载工具只用 `description`，不带 `promptSnippet`/`promptGuidelines`（避免重建 system prompt）；③ 内置工具与 `activate_domain` 作为稳定小前缀。这样稳定前缀命中好，域 schema 仅在切域那一轮 miss、同域后续轮次 re-hit——比静态全量（60-80 工具常留）token 省得多，cache 表现也可控。

### 6.2 安全

- Agent 与下游服务之间的所有调用必须携带可追溯的用户身份，禁止使用共享的、脱离具体用户的服务账号调用任何写操作 API。
- 高风险操作的确认动作本身需要留痕（谁在什么时间确认了什么操作），作为审计记录的一部分。
- 会话 jsonl 文件中不持久化敏感凭证（如 access_token）的明文，仅持久化可用于重新获取凭证的引用；MySQL 元数据表同样不存凭证明文。
- 文件/命令类内置工具（`read`/`write`/`edit`/`bash`/`!command`）必须经过 5.4a 节的 Gondolin 隔离执行环境，禁止在宿主进程所在机器直接执行；VM 与宿主之间、VM 与 VM 之间不共享文件系统和网络命名空间。

### 6.3 可用性

Agent 服务本身无状态，遵循与 AMS/Workbench 一致的多副本部署与健康检查机制；单个会话处理失败不影响其他会话，失败的会话可基于会话文件最后一条 entry 恢复重试（Pi 原生 append-only session，5.1 节）。

### 6.4 可运维性

工具集新增/下线不需要变更 Agent 运行时核心代码，只需要在工具注册表中增删条目并声明风险等级；System Prompt 迭代通过独立配置发布，不触发服务重新部署。

---

## 七、后续方向

- 若出现天问 Agent 与外部机构 Agent（如晓笛）互操作的真实需求，在工具层之上引入标准协议（如 A2A），现在不预先设计。
- L5 记忆（5.1 节，由 Hindsight 承接）随交互累积后，向量+图谱检索质量可随 PG 规模线性扩展，无需更换存储后端；后续评估是否在 observation/experience/world 三层 consolidation 之上引入面向个性化推荐的检索增强能力。
- 风险分级规则（5.3 节）随线上 HITL 确认率/拒绝率数据积累，建立定期校准机制。
- 观察到业务方对某类排查/分析反复发起同一套路的操作后（如"数据类型扫描 + SCQL 语法校验"组合），评估是否封装成一键触发的固定诊断流程，减少 Agent 每次现场编排的开销。值不值得做取决于实际重复频率，不提前假设。
- 等 5.5.2 节的机构协作知识层出现真实积累需求（如某几家机构合作频次显著高于其他、RD 排查经验频繁重复），再评估是否引入结构化的知识沉淀机制，业务量未验证前不预先建设。
- 洞察域（5.5 节）从"任务完成后的伴随分析"验证跑通后，评估是否放开更主动的探索边界（如定期巡检已授权资产、跨会话对比发现趋势变化），扩大 5.5.3 节当前刻意收窄的主动分析触发范围。注意这里的"定期巡检"和 2.1 节第三层"平台巡检"不是一回事——前者若要落地，需要先解决"由谁触发、状态如何落"这个和平台巡检共通的调度基础设施问题（当前均不存在），是同一个后续方向，不是本文档遗漏的两套不同机制。

---

## 附录 A：上下文六层模型 —— OpenAI 原文与天问现状逐层对照

本附录合并了 5.5.2 节的通用框架和 5.5.6 节的天问现状核实，作为速查表，用来快速比对"OpenAI 原文该层指什么"和"天问现状落在哪些系统/字段上"，免得读者跨章节拼信息。

| 层级 | OpenAI 原文对应 | 可信数据空间（天问）现状对应 |
|---|---|---|
| L1 结构元数据 | **表格使用情况**：模式元数据（列名、类型）+ 表格血缘（上下游关系）+ 历史查询模式，用于指导 SQL 编写 | **已具备**：AMS `ams_dataset_column`（字段名、类型、注释）+ `ams_feature_fields`（IV 值、覆盖率等使用统计）+ 数据资产血缘（`sourceFlowId`/`sourceJobId`/`sourceTaskId` 记录"由哪个任务产生"） |
| L2 语义标注 | **人工注释**：领域专家精心整理的表格/列描述，记录意图、语义、业务含义和已知注意事项 | **已具备**：`ams_feature_fields.real_desc`/`alias_desc`（字段业务含义）+ `ams_dataset_column.comment`（字段级注释）+ `ams_digital_contracts.purpose`（合约用途说明） |
| L3 代码 / 规则派生知识 | **Codex 增强**：通过 Codex 自动分析代码库，反推表的用途、粒度、主键、下游使用模式、数据新鲜度等，自动刷新无需人工维护 | **血缘引用已具备，语义反推暂不建设**：① 任务产生的资产可反查 `sourceFlowId`/`sourceJobId`/`sourceTaskId` 对应的 Job/Flow/Task 配置（`Tracker.java`）；② 用户导入表可查 `ams_dataset_warehouse_import.sql`/`data_set.sql` 导入 SQL 及其上游 ETL。但没有自动化流水线把这些引用反推成"这张表的粒度/口径/与相似表差异"这类语义结论 |
| L4 组织协作知识 | **机构知识**：接入 Slack、Google Docs、Notion 等协作工具，采集产品发布、事故背景、内部代号、指标口径等机构性知识，嵌入后按需检索 | **已具备结构化形式，非自由文本知识库**：`ams_institutions`（机构档案）、`ams_digital_contracts`（合约用途）、`ams_usage_records`（历史使用记录）、`bank_member_mapping`；`tianwen-web` 独立的"合作方管理"模块 |
| L5 记忆 | **记忆**：Agent 被纠正或发现细微差异后保存学习结果，范围分全局/个人，供后续交互复用 | **由 5.1 节 L5 记忆层承接**：Hindsight（外置 PostgreSQL+pgvector，见 5.5.2a 节），extension 自动 recall/retain，按 `HINDSIGHT_BANK_ID` 用户隔离 |
| L6 运行时上下文 | **运行时上下文**：以上层级未覆盖或信息过时时，直接向数据仓库/Airflow/Spark 等系统发起实时查询，兜底验证 | **已具备**（5.4 节工具集 + `tianwen-mcp` 兜底）：洞察域复用数据域、任务域既有只读工具做实时查询兜底；当 AMS/Workbench/Server 接口无法满足时，经 `tianwen-mcp` 调 SecretPad 底层 API 兜底 |

**几点差异**：

1. L1/L2 天问已有基础，且比 OpenAI 语境下更现成：OpenAI 要自建采集管道，天问直接复用 AMS/合约系统已有字段，零新增存储。
2. L3 是两边差距最大的一层：OpenAI 有 Codex 对内部代码库做自动化反推，天问目前只到"引用可追溯"（血缘 ID、SQL 文本），还没有反推语义的自动化能力。这是当前唯一存在真实能力差距、但暂缓建设的层级（取舍理由见 5.5.6 节）。
3. L4 形态不同但都具备：OpenAI 是非结构化知识库（Slack/Docs/Notion + embedding 检索），天问是结构化数据库表，殊途同归，天问反而不需要建 RAG 检索这类额外设施。
4. L5 两边都要从零建：OpenAI 也是在实践中逐步加上的能力，天问同样处于待建状态，是唯一明确要新增开发的一层。
5. L6 两边都是通用兜底能力：只要 Agent 具备目标系统的只读工具调用能力就自然具备，不用专门设计。
