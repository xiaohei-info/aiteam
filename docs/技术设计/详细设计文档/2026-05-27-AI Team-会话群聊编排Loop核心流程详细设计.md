---
created: 2026-05-27
updated: 2026-05-28
status: ready-for-development-review
stage: detailed-design
canonical_name: 2026-05-27-AI Team-会话群聊编排Loop核心流程详细设计
parent_docs:
  - /var/lib/syncthing/Obsidian/Guantik/Projects/aiteam/技术设计/2026-05-27-AI Team-Team Panel与Agent Gateway详细设计方案.md
  - /var/lib/syncthing/Obsidian/Guantik/Projects/aiteam/技术设计/2026-05-26-AI Team-技术概要设计.md
  - /var/lib/syncthing/Obsidian/Guantik/Projects/aiteam/技术设计/2026-05-25-AI Team-业务解决方案设计.md
  - /var/lib/syncthing/Obsidian/Guantik/Projects/aiteam/技术设计/2026-05-28-AI Team-共享运行口径定稿版.md
source_runtime:
  - Agent Service / Team Panel / Agent Gateway / Hermes Runtime / Kanban / Cron
---

# AI Team 会话 / 群聊 / 编排 / Loop 核心流程详细设计

## 1. 文档目标

本文是 `详细设计方案` 的子模块文档，专门收口 AI Team 在以下四类运行时主链路上的**流程口径、状态枚举、状态闭环、异常分支与结果回流规则**：

1. 私聊单员工会话。
2. 浏览器原生群聊协作会话。
3. 协作编排 root-task / worker-task 执行链路。
4. Loop / 定时任务 / 自主执行链路。

本文不再讨论业务价值、市场定位、页面原型细节，而是回答四个实现问题：

- 一条消息进入后如何被识别、路由、提交、执行、回流、收口。
- Team Panel、Agent Gateway、Hermes Runtime 各自持有什么状态口径。
- 出现失败、断流、重试、改派、人工介入时，状态如何保持闭环。
- UI 应以什么语义展示运行中的过程，而不是直接暴露 runtime 原始细节。

---

## 2. 设计范围与非目标

### 2.1 范围内

本文覆盖：

- `PrivateConversation` 生命周期。
- `TeamConversation` 生命周期。
- `TeamRun` 生命周期。
- `TeamTask` 生命周期。
- `ScheduledJob` 生命周期。
- `RuntimeHandle` 最小对账句柄。
- 单聊、群聊、编排、Loop 的时序流程。
- Timeline Event 语义。
- 失败/重试/补偿/重连分支。
- 人工介入点与验收标准。

### 2.2 非目标

本文明确不覆盖：

- Prompt 内容设计与角色文案优化。
- LightRAG 检索、切块、向量化实现细节。
- Hermes Runtime 内部推理循环源码级设计。
- 支付、充值、套餐计费策略。
- 第三方连接器 OAuth 协议细节。
- 真实 IM 平台（Telegram/Discord）适配细节的完整展开。

### 2.3 核心约束

1. **业务对象口径在 Team Panel**：会话容器、群成员、TeamRun、TeamTask、ScheduledJob、审计视图由 Team Panel 持有。
2. **执行口径在 Hermes Runtime**：session、kanban task、cron job、memory flush、tool execution 口径由 Runtime 持有。
3. **运行接入口径在 Agent Gateway**：请求提交、事件流映射、断流补拉、句柄维护由 Gateway 持有。
4. **前端不直接调 Runtime**：所有产品入口必须经 Team Panel，再由 Gateway 接入 Runtime。
5. **任何可见执行对象都必须能反查 RuntimeHandle**：否则不允许进入“已启动”状态。
6. **V1 流程承载于同一 Agent Service 进程**：默认请求链路为 `server.py -> api/routes.py / Team Panel handler -> Agent Gateway adapter -> Hermes Runtime`，不额外跨服务跳转。

---

## 3. 参与者列表

### 3.1 人类参与者

- **企业用户**：发起私聊、群聊、Loop 配置、停止/重试操作。
- **企业管理员**：管理成员、员工可见性、连接器授权、故障介入。
- **运营/审计人员**：查看日志、成本、失败记录、人工处理结果。

### 3.2 系统参与者

- **Team Panel Web**：浏览器工作台、聊天区、群聊区、Loop 面板、任务树 UI。
- **Team Panel API**：业务对象读写、权限校验、路由判断、结果包装。
- **Agent Gateway Adapter**：业务对象转 runtime 请求，承接流式事件、重连、补拉。
- **Hermes Single-Agent Runtime**：承接单员工私聊执行。
- **Hermes Orchestrator Profile**：承接 root-task，动态拆解、续派、汇总。
- **Hermes Worker Profile**：执行子任务并回写结果。
- **Hermes Cron Scheduler**：按 schedule 触发 Loop/周期任务。
- **External Capability**：知识、Skill、MCP、连接器、AI Relay。
- **Event Store / Timeline Assembler（时间线组装器）**：把 runtime 事件转换为 UI 可展示时间线。

### 3.3 运行角色语义

- **Conversation Owner**：会话发起用户。
- **Entry Employee**：本轮 run 的入口员工，负责首响应或 root 入口。
- **Orchestrator**：负责任务拆解、依赖推进、失败收口。
- **Worker**：承担具体子任务的员工 profile。
- **Loop Owner Employee**：绑定 ScheduledJob 的数字员工。

---

## 4. 状态闭环总原则

### 4.1 状态闭环定义

状态闭环指：每个运行对象都必须从“创建前”进入“进行中”，再进入一个明确的终态；任何异常路径也必须落到明确状态，而不是停留在语义不明的中间态。

### 4.2 闭环原则

1. **先落业务记录，再触发 runtime**。
2. **先生成 idempotency_key，再执行副作用动作**。
3. **没有 RuntimeHandle，不得进入 running**。
4. **running 对象必须可恢复**：断流后可通过 `runtime_handle + event_cursor` 补拉。
5. **终态有限且互斥**：成功、失败、取消、归档必须可区分。
6. **UI 展示状态必须来自展示结果组装，不直接拼接 runtime 原始状态**。

### 4.3 对账最小集合

每次执行、每个任务、每个定时任务至少保留下列键值中的一组：

- `profile_name`
- `session_id`
- `task_id`
- `job_id`
- `event_cursor`
- `last_synced_at`

---

## 5. 规范状态枚举

本节按《2026-05-28-AI Team-共享运行口径定稿版》统一收口：**Conversation 只保存持久化主状态；`waiting_reply / streaming / resolved / busy / routing / reconnecting` 等均降为展示态。**

## 5.1 PrivateConversation

### 5.1.1 持久化主状态

- `draft`：业务会话已创建，但尚未产生第一条有效消息。
- `active`：可继续发送消息并产生新 run。
- `paused`：因员工暂停、权限变化或人工冻结而不可发起新 run。
- `archived`：只读历史，不再允许新消息。

### 5.1.2 展示态

- `waiting_reply`：最近一轮用户消息已触发 run，等待员工回复收口。
- `streaming`：本轮 run 正在流式回传。
- `resolved`：最近一轮 run 已收口，可继续追问。
- `reconnecting`：前端流断开，正在通过 cursor 恢复展示。

### 5.1.3 合法迁移

持久化主状态：

`draft -> active -> paused|archived`

并允许：

- `active -> paused -> active`
- `active|paused -> archived`

说明：`waiting_reply / streaming / resolved / reconnecting` 都由 `conversation.status + latest_run.status + latest events` 聚合计算，不直接写入主表。

## 5.2 TeamConversation

### 5.2.1 持久化主状态

- `draft`：群会话已创建，尚无有效消息。
- `active`：可继续收发消息。
- `muted`：保留历史，但默认不推送动态。
- `paused`：管理员冻结，禁止新消息触发 run。
- `archived`：只读历史。

### 5.2.2 展示态

- `routing`：收到一条新消息，正在做路由判断。
- `busy`：存在至少一个未收口 TeamRun。

### 5.2.3 合法迁移

持久化主状态：

`draft -> active -> muted|paused|archived`

并允许：

- `active -> muted -> active`
- `active -> paused -> active`
- `muted|paused|active -> archived`

说明：`TeamConversation` 是容器，不等于某一次执行；一次群聊可连续产生多个 `TeamRun`。

## 5.3 TeamRun

### 5.3.1 持久化主状态

- `queued`：业务记录已创建，尚未提交 Runtime。
- `routing`：正在做单员工/编排判定与入口员工选择。
- `submitting`：Gateway 正在提交 runtime，请求已出站但尚未拿到句柄。
- `running`：Runtime 已接受，正在执行。
- `waiting_human`：等待人工审批、补充信息、手动改派或确认继续。
- `succeeded`：最终成功。
- `failed`：最终失败。
- `cancelled`：被用户或管理员取消。

### 5.3.2 展示态

- `waiting_children`：orchestrator 已拆解子任务，等待子任务回收。
- `partial_success`：部分分支成功，需人工判断是否可收口。
- `reconnecting`：前端流断开，正在通过 cursor 恢复展示。
- `expired`：超过时限未收敛，按超时收口候选展示。

### 5.3.3 合法迁移

主状态主链：

`queued -> routing -> submitting -> running -> succeeded|failed|cancelled`

异常路径：

- `running -> waiting_human -> running|cancelled|failed`

说明：编排路径中的“等待子任务”不再写成 `team_run.status` 主枚举，而由 `execution_mode=kanban_orchestration + open_task_count > 0` 形成展示态。

## 5.4 TeamTask

### 5.4.1 状态枚举

- `planned`：Team Panel 已生成业务任务镜像，但尚未下发或依赖尚未满足。
- `queued`：已绑定 kanban task，等待 dispatcher。
- `running`：worker 正在执行。
- `waiting_deps`：依赖未满足，等待上游输入。
- `succeeded`：任务成功。
- `failed`：任务失败且不再自动重试。
- `cancelled`：被上层取消。

### 5.4.2 合法迁移

`planned -> queued -> running`

后续：

- `planned|queued -> waiting_deps`
- `waiting_deps -> queued|running`
- `running -> succeeded|failed|cancelled`

## 5.5 ScheduledJob

### 5.5.1 状态枚举

- `draft`：业务对象存在，但尚未创建底层 cron。
- `enabled`：已注册，等待下次触发。
- `paused`：保留 job_id，但不触发新轮次。
- `error`：连续失败超过阈值，需人工处理。
- `archived`：停用，仅保留审计。

### 5.5.2 合法迁移

`draft -> enabled -> paused|error|archived`

并允许：

- `enabled -> paused -> enabled`
- `error -> paused|enabled|archived`
- `enabled|paused|error -> archived`

说明：单次 tick 是否正在执行，不通过 `scheduled_job.status=running` 表示，而通过对应 `TeamRun` 与时间线事件表示。

## 5.6 RuntimeHandle

### 5.6.1 状态枚举

- `pending`：业务对象已生成，等待绑定 runtime 句柄。
- `attached`：已拿到 `session_id/task_id/job_id` 之一。
- `syncing`：正在补拉事件或刷新状态。
- `stale`：长时间未同步，需要主动探测。
- `orphan_risk`：业务记录存在，但底层对象探测失败，待补偿。
- `closed`：业务对象已终态收口，句柄只读保留。

### 5.6.2 合法迁移

`pending -> attached -> syncing -> attached`

并允许：

- `attached -> stale -> syncing|orphan_risk|closed`
- `attached -> closed`
- `orphan_risk -> syncing|closed`

---

## 6. Timeline Event 语义

## 6.1 事件模型目标

Timeline 不是 runtime 原始日志复制，而是面向 UI 的**业务事件展示结果**。其目的是让用户看到：谁在做什么、做到哪一步、卡在哪、是否需要介入、最终结果是什么。

## 6.2 统一字段

每个事件至少包含：

- `event_id`
- `run_id`
- `source_type`：`conversation | single_agent | kanban_task | cron_job | system`
- `source_id`
- `employee_id` 或 `system_actor`
- `event_type`
- `preview`
- `ts`
- `attempt`
- `cursor`
- `metadata`

## 6.3 事件类型分层

### A. 会话层事件

- `message_received`
- `message_routed`
- `message_replied`
- `message_merged`
- `conversation_paused`
- `conversation_archived`

### B. TeamRun 层事件

- `run_created`
- `routing_decided`
- `run_started`
- `run_waiting_human`
- `run_succeeded`
- `run_failed`
- `run_cancelled`
- `error`

### C. TeamTask 层事件

- `task_created`
- `task_ready`
- `task_started`
- `task_retry_scheduled`
- `task_reassigned`
- `task_blocked`
- `task_waiting_human`
- `task_completed`
- `task_failed`
- `task_skipped`

### D. Loop 层事件

- `job_enabled`
- `job_triggered`
- `job_tick_started`
- `job_tick_completed`
- `job_tick_failed`
- `job_paused`
- `job_resumed`
- `job_error`
- `job_archived`

### E. 能力层事件

- `tool_called`
- `tool_failed`
- `knowledge_attached`
- `memory_written`
- `connector_auth_failed`
- `usage_recorded`

## 6.4 事件语义规则

1. **一个 run 必须有 `run_created` 和一个终态事件**。
2. **一个 TeamTask 必须有 `task_created` 和一个终态事件**。
3. **事件 cursor 单调递增**，用于断流补拉。
4. **UI 只消费展示事件，不直接消费 Runtime 原始 stdout/log**。
5. **相同 event_id 幂等覆盖**，避免重连后重复插入。
6. **成本、记忆、引用来源等富信息作为 metadata 追加，不单独决定 run 状态**。

---

## 7. 群消息路由规则：单员工 vs 编排

## 7.1 决策目标

群聊里一条消息不必总进入多 Agent 编排；否则成本高、速度慢、UI 也会过于噪声。Team Panel 必须先做路由判断。

## 7.2 路由输入

- 群成员列表。
- `@employee` 提及结果。
- 消息内容语义分类。
- 群默认策略：`single_first | explicit_mention | auto_orchestrate | admin_forced_template`。
- 行业方案自带协作模板。
- 当前是否已有未收口 TeamRun。
- 是否包含多步骤、多角色、交叉验证、产物汇总等特征。

## 7.3 单员工路径命中条件

满足任一组即可优先走单员工：

1. 明确 `@某个员工`，且未 `@多个员工`。
2. 问题明显属于单岗位职责，如“产品顾问回答产品规格”。
3. 群策略为 `single_first`，且未触发复杂任务特征。
4. 当前群内已有一个主负责员工，且消息属于该员工连续追问。

## 7.4 编排路径命中条件

满足任一组进入编排：

1. 同时 `@多个员工`。
2. 文本含明确协作意图：调研、汇总、对比、分工、复盘、方案拆解、报告生成。
3. 命中行业方案中预设的协作模板。
4. 单员工入口员工判断自身能力不足，显式升级为协作。
5. 管理员手动点击“升级为协作执行”。

## 7.5 决策优先级

`管理员强制策略 > 显式 @ 多员工 > 行业模板命中 > 单员工连续上下文 > 自动语义分类`

## 7.6 决策输出

`MessageRouteDecision` 至少包含：

- `mode`: `single_agent | orchestration`
- `entry_employee_id`
- `candidate_employee_ids[]`
- `reason_codes[]`
- `template_id?`
- `confidence`
- `needs_human_confirmation`

---

## 8. 核心时序流程

## 8.1 单聊主流程（PrivateConversation）

### 8.1.1 目标

让用户与单个数字员工完成一次完整消息闭环，并确保会话状态、运行状态、结果回流和异常恢复可追踪。

### 8.1.2 编号时序

1. 用户在工作台选择员工，进入或创建 `PrivateConversation`。
2. Team Panel 校验：员工 `status=active`、用户有访问权限、绑定资源可见。
3. Team Panel 保持 `PrivateConversation.status` 为 `draft/active` 主状态不变，同时为 UI 计算 `waiting_reply` 展示态。
4. Team Panel 创建 `TeamRun(status=queued)`，写入 `idempotency_key`。
5. Team Panel 组装 `RunRequest(mode=single_agent)`，包含：
   - `enterprise_id`
   - `employee_id`
   - `profile_name`
   - `conversation_id`
   - `user_message`
   - `attachment_refs`
   - `knowledge bindings`
   - `connector resolution plan`
6. Gateway 接收请求，将 `TeamRun` 推进到 `submitting`。
7. Gateway 创建或定位底层 `session_id`，写入 `RuntimeHandle(attached)`。
8. Gateway 调用单员工入口，Runtime 以该员工 profile 执行。
9. `TeamRun` 状态转 `running`，`PrivateConversation` 的 UI 展示态转 `streaming`。
10. Runtime 持续输出 token、tool、reasoning、usage、memory 等事件。
11. Gateway 将事件转换为 Timeline Event，并维护 `event_cursor`。
12. Team Panel 将事件重组为 UI 消息流：
    - 文字气泡
    - 工具卡片
    - 引用来源卡
    - 成本角标
    - 记忆沉淀提示
13. 执行完成后：
    - 成功：`TeamRun -> succeeded`，`PrivateConversation.status` 保持 `active`，UI 展示态切换为 `resolved`
    - 失败：`TeamRun -> failed`，`PrivateConversation.status` 保持 `active`
    - 取消：`TeamRun -> cancelled`，`PrivateConversation.status` 保持 `active`
14. Team Panel 生成最终消息摘要、usage 汇总、审计记录。

### 8.1.3 ASCII 图

```text
用户
  | 发送消息
  v
Team Panel ----创建 TeamRun----> Agent Gateway ----session/run----> Hermes Runtime
  ^                                  |                                   |
  |                                  v                                   v
  |<-----SSE / Timeline 展示------ Event Assembler（时间线组装器） <----- runtime events--
  |
  +---- UI 重组：消息 / 工具卡 / 引用 / 成本 / 记忆
```

### 8.1.4 状态收口规则

- 没拿到 `session_id` 前，`TeamRun` 不得进入 `running`。
- 如果消息落库成功但 runtime 提交失败，`TeamRun=failed`，会话恢复 `active`。
- 如果完成流式输出但最终消息写库失败，必须做结果补写补偿，不允许 UI 只看到中间流没有最终结果。

### 8.1.5 验收标准

- 能创建并复用同一 `PrivateConversation`。
- 一条消息对应一条 `TeamRun`，且 run 有唯一终态。
- 流式回复中断后可重连恢复，不重复插入消息。
- 工具调用、引用来源、成本、记忆写入可在 UI 看见。
- 失败时用户能看到失败结论而不是无限 loading。

---

## 8.2 浏览器原生群聊主流程（TeamConversation）

### 8.2.1 目标

在浏览器工作台实现“原生群聊”语义：成员、@提及、多个员工回复、协作升级、消息聚合、任务时间线全部由 AI Team 业务层承接，而不是直接照搬真实 IM 群。这里的“群聊”是 **业务会话容器与交互语义**；当一次群消息被升级为多人协作时，才进一步进入 `orchestration` 执行策略。

### 8.2.2 编号时序

1. 用户打开 `TeamConversation`。
2. 前端载入：群标题、成员、默认策略、未收口 run、历史消息。
3. 用户输入一条群消息，可包含 `@employee`、附件、指令化文本。
4. Team Panel 写入用户消息并将群状态置为 `routing`。
5. Team Panel 生成 `TeamRun(status=queued)`。
6. Team Panel 执行 `MessageRouteDecision`：
   - 解析提及对象。
   - 判断是否存在运行中的 root run。
   - 结合默认策略、模板、语义分类得出 `single_agent` 或 `orchestration`。
7. 若命中单员工路径：
   - `entry_employee_id` 指向目标员工。
   - 创建或复用该群上下文下的 runtime session key。
   - 提交单员工 run。
8. 若命中编排路径：
   - 选定入口员工或 orchestrator profile。
   - 创建协作请求，提交 root task。
9. 群状态从 `routing -> busy`。
10. 执行事件回流后，Team Panel 按三层语义重组展示：
    - 群消息流：谁回复了什么。
    - 过程流：谁在处理、谁在等待、谁失败了。
    - 汇总流：本轮最终结论是什么。
11. 本轮 run 收口后：
    - 若无未完成 run，群状态回 `active`。
    - 若存在其他未收口 run，群状态维持 `busy`。
12. 群消息索引、run 摘要、未读计数更新。

边界说明：

- `TeamConversation` / 浏览器群聊是 **业务容器**，不等于 Runtime 内部的任务图。
- 一条群消息对应一次 `TeamRun`；该 run 可以命中 `single_agent`，也可以升级为 `orchestration`。
- Agent Gateway 只负责把 `route_decision` 翻译成 session 或 root-task 入口；不负责定义群成员、群消息排序或 UI 聚合语义。

### 8.2.3 UI 合并规则

1. **用户原始消息永远保留为首消息**。
2. **员工中间事件默认折叠为过程流**，避免群里被 token 噪声淹没。
3. **最终答复必须回并成可阅读消息块**。
4. **若多个员工各自答复**，按“时间 + 员工角色优先级 + 汇总关系”排序。
5. **编排最终结论**单独生成“汇总结论卡”，并关联本轮 `TeamRun`。

### 8.2.4 单员工答复与编排答复的 UI 区别

- 单员工答复：显示为一个员工头像 + 一条主回复。
- 编排答复：显示为“过程面板 + 子任务树 + 汇总回复”。

### 8.2.5 验收标准

- 能创建群并管理成员。
- `@某个员工` 可稳定路由到对应员工。
- `@多个员工` 或复杂任务可升级为编排。
- 群聊中能看到过程与结果，但不会展示重复 token 噪声。
- 一轮群消息可追溯到唯一 `TeamRun`。
- 群会话可在刷新后恢复消息、run 状态与任务树视图。

---

## 8.3 协作编排主流程（Orchestrator Root Task）

### 8.3.1 目标

把业务层的协作请求稳定映射为 Hermes Kanban root-task + worker-task 图，并让 Team Panel 能持续解释“任务树发生了什么”。本节描述的是 **群聊/私聊之上的一种执行策略**，不是群聊容器本身。

### 8.3.2 编号时序

1. Team Panel 从私聊升级、群聊升级或显式“协作执行”按钮进入编排入口。
2. Team Panel 创建 `TeamRun(status=queued, execution_mode=kanban_orchestration)`。
3. Team Panel 组装 `CollaborationRequest`：
   - 任务目标
   - 输入上下文
   - 候选员工 roster
   - 每个员工能力摘要
   - 行业方案协作模板
   - 最大并发/预算/超时限制
4. Team Panel 先生成根业务任务 `TeamTask(root, created)`。
5. Gateway 创建 orchestrator 根 Kanban Task，并写回 `RuntimeHandle.task_id`。
6. `TeamRun -> running`，根 `TeamTask -> queued/ready`。
7. `dispatch_once()` 触发 orchestrator profile 执行。
8. orchestrator 读取输入，决定是否：
   - 直接汇总回答。
   - 拆出多个子任务。
   - 先请求更多信息。
9. 若拆任务：
   - Gateway/Assembler 将运行时子任务转换为 `TeamTask(planned -> queued -> running)`（口径以《共享运行口径定稿版》为准）。
   - TeamRun 主状态保持 `running`；`waiting_children` 仅作为编排展示态（不写入 team_run.status 主枚举）。
10. worker profiles 按依赖关系被调度执行。
11. 每个 worker 输出：开始、工具调用、阶段结果、完成/失败。
12. orchestrator 监听子任务回收结果，进行：
   - 汇总
   - 续派
   - 补充任务
   - 失败降级
13. 所有必要子任务收敛后，orchestrator 输出最终整合结果。
14. Team Panel 将根结果合并回原会话：
   - 私聊则回到 `PrivateConversation`
   - 群聊则回到 `TeamConversation`
15. TeamRun 收口：
   - 全部成功：`succeeded`
   - 可降级汇总但不完整：`partial_success` 或 `succeeded(with_warnings)` 的展示语义
   - 无法继续：`failed`

### 8.3.3 TeamTask 展示规则

- Runtime 每产生一个下游 task，Team Panel 必须产生一个可见 `TeamTask`。
- `TeamTask.parent_ids` 反映依赖，不直接替代 runtime 内部所有字段。
- UI 任务树以 `TeamTask` 为准，不直接读取底层 kanban schema。

### 8.3.4 汇总回会话规则

1. 中间子任务结果先进入过程流，不立即当作最终对用户答复。
2. 只有 orchestrator 的收口结论才能进入“最终回复区”。
3. 若用户打开任务树，则可查看每个 worker 的中间结果与失败原因。
4. 若编排来自群聊，最终回复需要回到原触发消息线程下。

### 8.3.5 验收标准

- 能把协作请求映射为 root-task，并拿到 `task_id`。
- 子任务能被转换为可见任务树。
- 任务状态变化能实时反映到 UI。
- orchestrator 能在子任务失败时重试、改派或降级汇总。
- 最终结论只回写一次，不重复生成多个“最终答案”。
- 编排运行结束后，可完整追溯 root-task、sub-task、usage、日志。

---

## 8.4 Loop / ScheduledJob 生命周期

### 8.4.1 目标

把“员工级周期任务”做成业务可管理对象，而不是直接把 cron job 裸暴露给前端。

### 8.4.2 编号时序

1. 用户进入员工详情页或 Loop 面板。
2. 创建 `ScheduledJob(status=draft)`，填写：goal、schedule、失败阈值、通知策略、产物去向。
3. Team Panel 校验员工可运行、连接器可见、schedule 合法。
4. Team Panel 调用 Gateway 创建底层 cron job，状态 `draft -> enabled`（口径以《共享运行口径定稿版》为准）。
5. 创建成功后写入 `job_id`，状态 `enabled`，RuntimeHandle 进入 `attached`。
6. Scheduler 到点触发，ScheduledJob 状态保持 `enabled`；本次 tick 运行状态由 `TeamRun(trigger_type=scheduled_job)` 表达。
7. 本轮 tick 运行时，Team Panel 额外生成一个 `TeamRun(trigger_type=scheduled_job)`，用于统一结果、费用、记忆和日志回流。
8. 执行完成后：
   - 成功：写 `job_tick_completed`，更新 `last_run_at`、usage、产物摘要；ScheduledJob 状态保持 `enabled`
   - 失败：累计 failure_count，必要时进入 `error`
9. 若管理员暂停：`enabled -> paused`。
10. 若恢复：`paused -> enabled`。
11. 若停用：转 `archived`，保留审计记录。

### 8.4.3 Loop 与普通 TeamRun 的关系

- `ScheduledJob` 是长期配置对象。
- 每次 tick 产生一个短生命周期 `TeamRun`。
- 因此：
  - `ScheduledJob` 看“长期状态”。
  - `TeamRun` 看“单次执行状态”。

### 8.4.4 PDAR 展示建议

如果 Loop 场景采用 Plan-Do-Act-Reflect 语义，UI 展示可统一成四段：

- `plan_generated`
- `action_executed`
- `result_checked`
- `reflection_recorded`

但其底层仍归属于同一 `TeamRun` 时间线，不单独创造第二套状态机。

### 8.4.5 验收标准

- 用户能创建、暂停、恢复、归档 ScheduledJob。
- 每次 tick 可追溯到一个 `TeamRun`。
- 连续失败达到阈值会自动进入 `error`。
- 结果、成本、记忆、通知都能随 tick 回流。
- 页面刷新后仍能看到长期任务状态和最近执行记录。

---

## 9. 失败 / 重试 / 补偿 / 重连分支

## 9.1 提交前失败

### 场景

业务记录已创建，但 runtime 尚未接受请求。

### 处理

1. `TeamRun` 保持在 `queued/submitting`。
2. Gateway 返回明确失败原因。
3. Team Panel 将其收口为 `failed` 或 `queued_for_retry` 展示结果，不再引入新的持久化主状态。
4. 不得生成伪 `session_id/task_id/job_id`。

### 补偿

- 允许用户点击“重试提交”。
- 重试必须复用同一 `idempotency_key` 或建立关联 retry chain。

## 9.2 运行中失败

### 单员工

1. Runtime 返回失败事件。
2. `TeamRun -> failed`。
3. `PrivateConversation` 回到 `active`。
4. UI 展示错误摘要、重试按钮、日志入口。

### 编排

1. 某个 `TeamTask` 失败。
2. orchestrator 判断：
   - 自动重试。
   - 改派给其他员工。
   - 跳过该分支并降级汇总。
   - 整体失败。
3. Team Panel 只展示 orchestrator 决策，不自己越权改任务图。

## 9.3 连接器/鉴权失败

1. 工具或连接器报鉴权错误。
2. 写入 `connector_auth_failed` 事件。
3. 当前 run 可失败，也可降级到无连接器路径。
4. 不清空 `credential_ref`，仅标记 `rotation_version` 过期风险。
5. 管理员修复后重新提交 run 或恢复 job。

## 9.4 前端断流 / 刷新 / 重连

### 场景

浏览器关闭、SSE 断开、网络抖动。

### 处理

1. UI 保存 `run_id + event_cursor`。
2. 重新连接时请求 `GET /api/team/runs/{run_id}/events?cursor=...`（口径以《共享运行口径定稿版》为准）。
3. Gateway 通过 RuntimeHandle 做增量补拉。
4. `reconnecting` 仅作为前端/BFF 展示态；TeamRun 主状态保持 `running` 或已进入终态。
5. UI 对已存在 event_id 做幂等覆盖，不重复插入消息卡。

## 9.5 幽灵对象补偿

### 场景

业务记录存在，但底层 runtime 对象失联。

### 处理

1. RuntimeHandle 标记为 `orphan_risk`。
2. 启动探测：按 `profile_name + session_id/task_id/job_id` 查询底层对象。
3. 若底层存在，则回补 cursor 与终态。
4. 若底层不存在，则按业务策略：
   - 直接失败收口。
   - 自动重新提交。
   - 升级人工处理。

## 9.6 ScheduledJob 连续失败

1. 每次 tick 失败增加 `failure_count`。
2. 达到阈值后：`ScheduledJob -> error`。
3. 触发企业通知。
4. 默认暂停后续调度，等待人工恢复。

---

## 10. 人工介入点

## 10.1 会话层

- 手动重试失败 run。
- 手动停止流式输出。
- 将单员工 run 升级为协作编排。
- 将群消息强制指定给某个员工。

## 10.2 编排层

- 审批是否继续。
- 对 `waiting_human` 的任务补充资料。
- 手动改派 `TeamTask` 给其他员工。
- 手动跳过某个任务分支。
- 人工确认 `partial_success` 是否可视为可交付结果。

## 10.3 Loop 层

- 暂停/恢复 ScheduledJob。
- 修改 schedule、阈值、通知策略。
- 修复连接器后手动重放最近失败 tick。
- 将 `error` 状态恢复为 `enabled`。

## 10.4 审计要求

所有人工介入必须产生日志：

- `actor_user_id`
- `action_type`
- `target_object_type`
- `target_object_id`
- `before_state`
- `after_state`
- `reason`
- `ts`

---

## 11. 结果如何合并回 UI

## 11.1 展示层原则

UI 不直接显示 runtime 原始日志，而是消费三类展示结果：

1. **消息视图**：用户消息、员工回复、最终汇总。
2. **过程视图**：任务树、步骤进度、等待状态、失败分支。
3. **治理视图**：成本、记忆沉淀、引用来源、连接器状态。

## 11.2 私聊 UI 合并规则

- 主回复显示在消息气泡。
- tool/reasoning 默认折叠为“过程详情”。
- 引用来源、成本、记忆作为附属卡片插在本轮 run 下。

## 11.3 群聊 UI 合并规则

- 用户原消息为主锚点。
- 单员工路径：在锚点下显示一条员工回复。
- 编排路径：在锚点下显示：
  - 协作进行中状态
  - 子任务树卡片
  - 最终汇总结论卡
- 中间 worker 输出不默认刷满聊天区，而沉淀到“展开过程”。

## 11.4 Loop UI 合并规则

- 长期对象页展示 `ScheduledJob` 当前状态。
- 列表项显示最近一次 tick 结果摘要。
- 点开后展示最近 N 次 `TeamRun` 时间线。

---

## 12. 接口与展示约束建议

## 12.1 Team Panel 北向对象

- `PrivateConversation`
- `TeamConversation`
- `TeamRun`
- `TeamTask`
- `ScheduledJob`
- `RunTimelineEvent`

## 12.2 Gateway 南向最小动作

- `start_single_agent_run(run_request)`
- `start_orchestration_run(collaboration_request)`
- `create_scheduled_job(job_request)`
- `pause_scheduled_job(job_id)`
- `resume_scheduled_job(job_id)`
- `cancel_run(runtime_handle)`
- `replay_timeline(run_id, after_cursor)`
- `inspect_runtime_handle(handle)`

## 12.3 展示一致性规则

1. 一个 `TeamRun` 只能有一个“最终结果展示”。
2. 一个 `RunTimelineEvent` 只能归属一个 `run_id`。
3. 一个 `TeamTask` 只能绑定一个当前有效 assignee；改派通过状态迁移表达。
4. 一个 `ScheduledJob` 可关联多个历史 `TeamRun`，但同一时刻只允许一个进行中的 tick run。

---

## 13. 核心流程验收总表

### 13.1 私聊

- 能创建/复用私聊容器。
- 消息触发后能稳定生成 TeamRun。
- 有流式过程、有终态、有成本与引用回流。
- 断流可恢复，失败可重试。

### 13.2 浏览器群聊

- 群会话、成员、@提及可用。
- 能判断单员工路径与编排路径。
- 过程流与最终结果可分层展示。
- 刷新后可恢复未收口 run。

### 13.3 编排

- root task 能成功创建并追踪。
- 子任务树能动态展示。
- 失败分支能被重试、改派或降级收口。
- 最终结果只汇总一次并回写原会话。

### 13.4 Loop

- 能创建、启停、归档 ScheduledJob。
- 每次触发都有独立 TeamRun。
- 连续失败有阈值与通知。
- 历史执行可审计可回看。

### 13.5 状态闭环

- 所有对象都有合法状态迁移。
- 没有“running 但无句柄”的脏状态。
- 没有“完成但无终态事件”的脏 run。
- 没有“UI 展示成功但业务对象仍在进行中”的不一致状态。

---

## 14. 实现结论

1. **会话容器、执行实例、任务树、定时任务必须分层建模**，不能用一个 session 概念包打天下。
2. **群聊消息并不天然等于协作编排**；必须先做业务路由，再决定进入单员工还是 root-task 编排。
3. **Loop 是长期配置对象，TeamRun 是单次执行对象**；两者必须关联但不能混用。
4. **Timeline Event 是 UI 口径展示层**，其设计质量直接决定产品是否“可解释、可回放、可审计”。
5. **状态闭环优先于页面炫技**；没有闭环的流式体验会迅速演化为不可治理的演示系统。

以上规则定稿后，可继续分别拆解：

- `/api/team/conversations/*` 接口设计
- `/api/team/runs/*` 与 timeline SSE 设计
- `/api/team/tasks/*` 任务树展示设计
- `/api/team/scheduled-jobs/*` 生命周期接口设计
- 前端消息区 / 群聊区 / 任务树 / Loop 面板交互细节
