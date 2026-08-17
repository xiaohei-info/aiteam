---
created: 2026-08-17
status: draft-for-review
canonical: false
impacts_if_approved:
  - docs/v1正式版本/技术设计/概要设计/00-架构总纲与裁决索引.md
  - docs/v1正式版本/技术设计/概要设计/03-认证与身份设计.md
  - docs/v1正式版本/技术设计/概要设计/04-数据架构与多租户隔离.md
  - docs/v1正式版本/技术设计/概要设计/05-通信架构与跨端契约.md
  - docs/v1正式版本/技术设计/概要设计/06-AgentGateway与运行时接入.md
  - docs/v1正式版本/技术设计/概要设计/07-事件流与对话页.md
  - docs/v1正式版本/技术设计/概要设计/09-部署分发与入户绑定.md
  - docs/v1正式版本/技术设计/概要设计/10-重建验证与阶段实施.md
  - docs/v1正式版本/技术设计/概要设计/11-开发实施与并行编排.md
related_decisions: [D1, D2, D3, D4, D5, D6, D7, D8, D9, D10, D11, D13, D15, D16, D17, D18, D19]
tags: [project, aiteam, pi-coding-agent, sdk, agent-runtime, refactor]
---

# AI Team 基于 pi-coding-agent SDK 的 Agent 架构重构设计

> **文档性质**：本文件是重构提案，不直接修改当前 frozen v1 基线。评审通过后，才更新 `00–11`、共享契约和代码。
>
> **实施配套**：文件级迁移、删除、API/SQLite/前端/测试映射见 [`docs/superpowers/plans/2026-08-17-pi-coding-agent-sdk-agent代码迁移与删除计划.md`](../plans/2026-08-17-pi-coding-agent-sdk-agent代码迁移与删除计划.md)。
>
> **业务锚点**：`docs/需求文档/AI-Team-Demo.html` 所表达的数字员工、私聊、群聊、Loop、任务、办公室、知识、记忆、技能、人才市场等业务意图，以及 v1 的 Operator / Manager / Agent 三端能力与本地优先边界。
>
> **术语映射**：用户所称“server 端”在本文映射为当前 v1 的 **Manager 企业管理云服务**；为避免与本地 `Agent Service` 混淆，正文继续使用正式名称 **Manager**。

---

## 1. 结论先行

本次不把 Pi 当成第六个 Runtime Driver，而是**取消多 runtime 架构，由用户本机 Agent Service 直接进程内嵌入 `pi-coding-agent` SDK**。

核心裁决：

1. **唯一 Agent Runtime 是 `pi-coding-agent`**；不再直接接 Hermes、Codex app-server、Claude Code CLI、OpenCode、OpenClaw。
2. **保留多模型/多 provider**，但由 Pi 的 `ModelRuntime`、内置 provider 和 provider extension 处理；“多模型”不再等价于“多 runtime”。
3. **删除 `Agent Gateway → Executor → Driver → RunSpec` 翻译链**；业务快照直接组装 `AgentSession`。
4. **用户端 Agent Service 改为 Node.js/TypeScript 服务**，与 Pi SDK 同进程；Operator、Manager 继续使用现有 Python/FastAPI。
5. **数字员工不是进程或 runtime**，而是一份受授权、可版本化的 Pi 会话配置：
   `persona + model + thinking + skills + tool grants + knowledge + memory + workspace policy`。
6. **Pi Session JSONL 成为本地会话内容事实源**；Conversation 直接映射一个 Pi Session，Pi entry 直接表示消息和工具记录。Agent SQLite 只保留会话索引、授权投影、审批、附件、计划配置、幂等收据和治理 outbox，不再建立 Run/Task/Loop/Timeline 第二套执行模型。
7. **Pi SDK 公开事件直接作为实时契约**，经安全薄封装后通过 SSE 给前端；前端消费固定版本的 Pi event schema，不再维护 AITeamTimelineEvent 或产品执行事件枚举。
8. **Skills 承载可复用专业流程，Extensions 承载工具、安全、记忆、知识、审计和协作能力**；不再自建通用 capability/MCP/Driver 框架。
9. **群聊用一个协调者 Pi Session + `delegate_employee` 工具**；Pi 默认并行工具调用完成多专家 fan-out，删除手写 planner/subtask/aggregate 状态机和 child Run。
10. **计划配置只附着在 Conversation 上**；到点直接调用对应 Pi Session 的 `prompt()`，不建立 Loop、Run 或任务调度状态机。

目标结构：

```text
Operator（Python/FastAPI，云）
  企业开通 / 模板与方案目录 / 跨企业治理
                ⇅
Manager（Python/FastAPI，云，多租户）
  成员认证 / 员工实例 / 授权 / 企业知识 / Hindsight 记忆 / provider 与模型策略
                ▲ Agent 主动 pull / 脱敏摘要上报
                │
Agent（Node.js/TypeScript，本机）
  HTTP/SSE + 本地业务服务 + SQLite
                │
                ▼
  PiSessionHost（进程内 SDK）
    createAgentSession()
    SessionManager
    ModelRuntime
    controlled ResourceLoader
    Skills + Extensions + Custom Tools
                │
                ▼
  模型 Provider / AI Relay + 本地工具与能力
```

---

## 2. 为什么当前架构应当删除，而不是继续修补

当前用户端约有：

- `server/agent_gateway` 生产代码约 3,173 行；
- `server/agent_service` Python 代码约 12,320 行；
- Gateway + Agent 测试约 15,621 行；
- 至少 140 个文件直接出现 `RunSpec`、`AgentRunRequest`、`AgentRuntimeEvent`、`runtime_binding`、`AGENT_RUNTIME` 或 `mcp_config`。

主要复杂度不是 AI Team 业务，而是自建 runtime harness：

- 多套 subprocess/stdio/JSONL/JSON-RPC/ACP 生命周期；
- 每 runtime 的命令、握手、事件和 usage 解析；
- RunSpec 到品牌参数的翻译；
- capability registry、MCP config、skill materialize；
- runtime readiness、provider env 注入、raw event 回归；
- Agent Service 和 Gateway 之间重复的状态、事件与终态收敛。

`pi-coding-agent` 已经提供：

- Agent loop；
- 模型/provider 统一层；
- `AgentSession` 与流式事件；
- Session JSONL、树与 compaction；
- retry、abort、steer、follow-up；
- read/write/edit/bash/grep/find/ls；
- Skills、Prompt Templates、Extensions、Pi Packages；
- 自定义工具、动态工具启用、生命周期钩子；
- provider 扩展与企业代理接入。

继续保留 Gateway，再在其下加一个 Pi Driver，只会形成：

```text
AI Team orchestration loop
  → RunSpec translator
    → Pi adapter
      → Pi agent loop
```

这仍然是两层 loop 和两层 session/event 生命周期，不符合本次“整体简化”的目标。

---

## 3. 输入依据与适配结论

### 3.1 Pi SDK 适配原则

本设计只复用 Pi 已经提供的公开能力，不再为 Agent Loop、工具生命周期、事件、Session 和 Extension 另造编排层：

- `createAgentSession()` 进程内嵌入；
- Pi Session 文件作为会话恢复基础；
- 业务工具通过 custom tools/extensions 注册；
- `tool_call` 做执行前策略拦截；
- `context` / `before_agent_start` 做上下文注入；
- `agent_settled` 之后只释放 AgentSession 资源，不收敛第二套产品执行状态；
- 显式资源加载，不扫描用户全局 Pi 配置；
- Session 单写者。

这些能力必须服从 AI Team 的部署边界：AI Team 是单用户本机 Agent，只需进程内 keyed mutex，不为云端多副本场景引入 EFS/MySQL 锁；会话正文继续只保存在本地 Pi Session，跨会话记忆作为用户/企业明确授权的能力通过 Manager HTTP 访问；代码员工必须使用真正的外部 sandbox，不能把 tool allowlist、project trust 或 prompt 约束当成隔离边界。任何未在本机固定 Pi 版本公开 API、Manager memory HTTP 契约或事件语义中的内容，都不能直接作为生产契约，必须先经 Phase 0 验证。

### 3.2 Pi v0.84.2 能力兼容表（Phase 0 前置）

本设计只允许使用固定版本 `@earendil-works/pi-coding-agent` 的 `.d.ts`、源码 commit 和官方文档能够证明的公开面。以下名称是当前设计候选，**在生成兼容表前不得视为已冻结的生产契约**：

| 能力 | 当前候选公开面 | Phase 0 必须锁定 |
|---|---|---|
| Session 宿主 | `createAgentSession()`、`AgentSession`、`SessionManager` | create/open/inMemory、prompt、abort、dispose 的真实签名 |
| 资源 | `DefaultResourceLoader`、`SettingsManager` | `no*`、显式 skill/extension 路径、reload 和 ambient 拒绝 |
| 模型 | `ModelRuntime`、provider 注册/API key | 构造、provider 注册位置、并发作用域和 credential 注入 |
| 事件 | `message_update`、`message_end`、`tool_execution_*`、agent 生命周期 | 真实 discriminated event 名称、字段、settled/结束语义、重连游标 |
| Extensions | `registerTool`、`tool_call`、`tool_result`、context/lifecycle hooks | block 返回值、参数修改后的 schema 校验、session start/shutdown |
| Session 文件 | JSONL、entry tree、compaction | 半写恢复、entry id 稳定性、compaction 后历史和 usage |
| Skills | Agent Skills 渐进披露 | `additionalSkillPaths` 或实际替代参数及加载边界 |
| 安全事实 | Pi 没有内置 sandbox | project trust/tool allowlist 不能替代外部 sandbox |

Phase 0 产物必须为 `experiments/pi-sdk-spike/pi-api-compatibility.md`，记录精确 package version、源码 commit、导出符号、事件 schema 和最小示例。正文中的 `agent_settled`、`compaction_*`、`tool_call` 返回值等均以该兼容表为准；若实际 SDK 使用其他名称，必须在 Phase 0 结论中统一替换，不能同时保留猜测名称。

不依赖：

- TUI、editor、theme、keybinding、InteractiveMode；
- CLI slash-command selector 行为；
- `dist/modes/interactive/*` 等内部路径；
- 手写修改 Session JSONL；
- RPC framing（本方案同进程 SDK，不需要 RPC）；
- 用户 `~/.pi/agent` 中的全局 extensions/skills/settings。

---

## 4. 三端职责：保留 v1 地基，只替换用户端执行内核

### 4.1 Operator：基本不变

继续负责：

- 企业开通与 owner bootstrap；
- 数字员工模板目录；
- 行业方案模板目录；
- 平台审核、发布、下架；
- “发布需求/个人上架智能体”仍是 Demo Toast，占用独立供应方、审核、定价工作流，本次后置；
- 跨企业脱敏计量/审计汇总。

新增或调整：

- 员工模板不再包含 `runtime_binding`；
- 模板推荐配置改为 `provider/model/thinking/skill_refs/tool_policy`；
- 方案模板可引用一组 Skills、员工模板和协作规则；
- 若未来分发 Pi Extension，只能发布平台审核、签名和固定版本的包。

Operator 仍然：不持会话、不执行 Pi、不接收对话内容。

### 4.2 Manager（用户口中的 server 端）：控制面不执行 Pi

继续负责：

- tenant、成员、部门、角色与认证；
- 数字员工实例及成员级授权；
- 企业知识、Skills、连接器、Manager 端 Hindsight 和 provider 管理；
- 行业方案实例；
- 人才市场浏览和招募页面（Operator 持模板真相，Manager 创建 tenant employee 并授权）；
- 员工授权快照生成；
- Hindsight memory HTTP facade（按 tenant/member/employee 路由和策略校验）；
- 企业级脱敏治理汇总。

员工实例改为：

```text
EmployeeSnapshot v2
  employee_id / version / snapshot_version / display_name
  persona
  model_policy
    provider_id / model_id / thinking_level
  skill_refs[]
  tool_policy
    allowed_tools[] / approval_policy
  knowledge_refs[]
  connector_refs[]
  memory_policy
  workspace_policy
  execution_policy
    timeout_seconds / max_turns? / max_cost?
```

删除：

- `runtime_binding`；
- runtime brand、Driver capability、CLI 参数；
- MCP materialization 细节；
- `custom_args`；
- 任何能够让 Manager 下发任意 TypeScript Extension 代码的字段。

Manager 的授权仍是安全真相；Pi 的 tool list 只是本地执行时的第二道收窄。

### 4.3 Agent：Node/TypeScript 本地数据面

Agent Service 同时承担：

- 本地 HTTP/SSE API；
- 登录 token 与 Manager client；
- Conversation → Pi Session 索引和快照冻结；
- Pi SDK SessionHost（只做资源装配，不重建 Agent Loop）；
- 审批记录、附件、产物和计划配置等本地元数据；
- 本地 Skills/知识/连接器工具装载；
- Manager Hindsight HTTP memory client；
- 脱敏 usage outbox；
- React `web/agent` 静态资源托管。

不再存在独立 `agent_gateway` 包，也不建立 Run/Task/Loop/Timeline 执行模型。Agent 前端的人才页改为“已授权员工/我的数字员工”，只读本地投影，不提供“雇用”写操作或跨端直调。

### 4.4 Node Agent 认证契约

D8/D9 的**安全语义保留、Python 共享库实现方式修订**：Manager 仍是唯一签发方，Agent 仍本地无状态验签、绝不每请求回调 Manager。

- 用语言中立 JSON Schema 冻结 JWT claims：`iss/aud/kid/tenant_id/enterprise_id/user_id/roles/exp/iat`；
- Node 端使用成熟 JOSE 库验 JWT/JWKS，不手写密码学；
- JWKS 缓存、`kid` 轮换、issuer/audience/expiry、角色和 tenant claim 全部 fail-closed；
- 固定 Python 签发 → Node 验签 test vectors，覆盖正常、过期、错误 tenant/audience、非法签名和 key rotation；
- 公开端点与受保护端点明确分开；认证失败 401、授权失败 403；
- request identity、request_id、trace_id 的 wire contract 与控制面一致。

---

## 5. 核心对象重新定义

### 5.1 数字员工 Employee

数字员工不再表示“选择哪个 runtime”，而表示“以什么身份、模型和能力运行一个 Pi Session”。

```text
Employee
  = Persona
  + Provider/Model/Thinking
  + Skills
  + Allowed Tools
  + Knowledge grants
  + Memory policy
  + Connector grants
  + Workspace / Approval policy
```

私聊时：一个 Conversation 绑定一个 Employee。

群聊时：一个 coordinator Conversation 绑定一个协调者配置和一组 Employee roster。

### 5.2 Conversation 与 Pi Session

一条 AI Team Conversation 对应一个主 Pi Session：

```text
conversation_id
  ├─ pi_session_id
  ├─ pi_session_file（仅本地内部字段，不经 API 暴露）
  ├─ workspace_path（仅本地内部字段）
  ├─ entry_employee_id / group roster / solution_instance_id
  └─ product metadata
```

Pi Session JSONL 保存：

- 用户与 assistant 消息；
- thinking/tool call/tool result；
- model/thinking change；
- compaction；
- Pi Extension 自身产生的 custom entry（仅按 SDK 语义保存，不用于 AI Team 业务状态标记）。

Agent SQLite 不再重复保存完整 Message 内容。它只保留 Conversation 索引、授权快照和无法由 Pi Session 承担的本地元数据；读取历史时通过公开 `SessionManager` 映射为产品 DTO，禁止前端直接读取 JSONL。

### 5.3 AI Team 概念到 Pi 原生概念的映射

执行层不再定义 Run、Turn 或 Timeline 状态机，直接使用 Pi 的对象和方法：

| AI Team 业务语义 | Pi 原生对应 | Agent 额外保存的最小元数据 |
|---|---|---|
| 会话/私聊/任务会话 | 一个 `SessionManager` 管理的 Pi Session | `conversation_id → pi_session_id/file`、员工快照 |
| 用户发送消息 | `session.prompt(input)` | HTTP `Idempotency-Key` 收据 |
| 助手消息/工具调用 | Pi Session 的 message/tool entry | 不重复保存正文 |
| 思考、工具、流式输出 | `AgentSessionEvent` | 仅 live SSE，不建 timeline 表 |
| 取消当前执行 | `session.abort()` | 无独立 cancel 状态 |
| 继续/引导当前执行 | `session.steer()` / `session.followUp()` | 仅在 SDK 能力验证后开放 |
| 上下文压缩 | Pi compaction | Session 自己保存 compaction entry |
| 重试 | 对同一 Session 再次 `prompt()` | 新 Idempotency-Key，必要时记录来源 entry |
| 多专家委托 | `delegate_employee` custom tool + 内存子 Pi Session | 首期禁止持久化 child Session 或目录索引 |
| 计划任务 | Conversation 上的 schedule 配置 + 定时调用 `prompt()` | cron/timezone/enabled |
| 任务看板/办公室 | Session entries、实时事件、附件和 schedule 的查询视图 | 不建 Task/Office 状态源 |

因此：

- `agent_start` / `agent_end` / `agent_settled` 直接表示一次 Pi prompt 的生命周期；
- tool error、provider error、abort 等保留在 Pi 事件和 Session entry 中，不转换成第二套 Run 枚举；
- 只有授权、审批、附件、计划配置、会话索引和治理摘要等产品必须的数据才落 SQLite；
- “任务”是带有 `kind=task` 或标签的 Conversation/Session，而不是独立 Task 对象。

### 5.4 业务视图而非执行抽象

- Office 是读取 Conversation/Session、Pi 事件、附件和 schedule 的页面，不写回状态；
- 任务看板是带筛选条件的 Conversation/Session 查询，不维护任务状态机；
- 计划任务只保存 schedule 配置，触发时直接调用 Pi `prompt()`；
- 群聊协作只通过 coordinator Session 的 `delegate_employee` 工具完成，不创建 parent/child Run。

---

## 6. 一条私聊消息的完整链路

```text
1. Web 打开 Conversation 对应的 SSE
2. POST /api/agent/conversations/{id}/prompt
3. Agent Service 校验本地 token、Conversation 和 employee grant
4. 按 employee/version 向 Manager 拉快照；仅网络错误可回退本地冻结快照
5. 获取 conversation keyed mutex，记录 HTTP Idempotency-Key 收据
6. SessionHost：
   - SessionManager.create/open
   - 构造受控 ResourceLoader
   - 从 ModelRuntime 选择 provider/model
   - 注入 persona、skills、tools 和 extensions
   - createAgentSession()
7. 订阅 Pi AgentSessionEvent
8. 直接调用 `session.prompt(user text/images)`
9. Pi 自行完成 model → tool → model loop
10. 将 Pi 原生事件薄封装为 SSE，不建立 AITeamTimelineEvent
11. `agent_settled` 后更新幂等收据、usage 摘要并 dispose Session
12. Pi JSONL 和 Session entry 保留为唯一会话事实源
13. usage 脱敏聚合进入 outbox，之后主动上报 Manager
```

### 6.1 直接映射 `session.prompt()` 的 API

当前前端先 `POST /messages` 再 `POST /runs`，会产生重复的业务执行入口。改为一个直接映射 Pi `session.prompt()` 的 HTTP 入口：

```http
POST /api/agent/conversations/{conversation_id}/prompt
Idempotency-Key: <client-generated-key>
Content-Type: application/json

{
  "text": "...",
  "attachments": []
}
```

响应只表达 HTTP 接收结果，不创造 Run/Turn 对象：

```http
202 Accepted
{
  "data": {
    "conversation_id": "conv_...",
    "accepted": true,
    "idempotency_key": "..."
  }
}
```

处理规则：

1. SQLite 事务只创建唯一 `idempotency_receipt`（`accepted | completed | unknown`），绑定 `conversation_id + caller_id + request_fingerprint`，记录 `claimed_at + lease_expires_at + owner_instance`；不保存 prompt 正文、不写 custom entry、不建立 phase 状态机；
2. SessionHost 打开 Conversation 对应的 Pi Session，直接调用 `session.prompt()`；Pi 自己负责追加 user/assistant/tool entries；
3. `agent_settled` 后可将收据标记 `completed`，并记录 SDK 返回的最后 entry id（如果公开 API 提供）；正文和执行过程仍只从 Pi Session 读取；
4. 进程在 prompt 前后崩溃都只把 `accepted` 收据标为 `unknown`，不自动重放、不推断“是否已经执行”；用户先查看 Session，再使用新的 Idempotency-Key 重新提交；
5. 同一 Idempotency-Key 且 request fingerprint 相同，在 `accepted/completed` 时返回原接收结果；fingerprint 不同直接 409；`unknown` 时返回 409，要求客户端显式确认后创建新 key；
6. Agent 启动时扫描 `accepted` 且 `lease_expires_at` 已过期的收据，原子标记为 `unknown`；单进程正常退出也先释放 lease。scheduler 和人工重试都复用这条规则；
7. 不宣称 SQLite 与 Pi JSONL 的跨存储原子性，也不宣称模型调用或外部副作用 exactly-once；外部工具仍必须使用自己的幂等键/结果查询或进入 `uncertain`。

这是有意选择的最小故障语义：不增加加密 staged input、custom entry、active-branch、prompt phase 或自动 retry 状态机。Phase 0/1 只验证“崩溃后不自动重复 prompt、Session 可重开、unknown 能被用户识别”。

执行在本地后台 Promise 中进行，前端通过已建立的 SSE 接收 Pi 事件，不等待整个 prompt 完成后补拉。

### 6.2 Pi 原生控制方法

首期只允许一个 Conversation 同时运行一个 Pi prompt；执行中再次调用 `prompt` 返回 409。需要交互式控制时，直接映射 Pi 原生方法，不增加 queued-message 或 Run 状态：

```text
POST /api/agent/conversations/{id}/steer      → session.steer()
POST /api/agent/conversations/{id}/follow-up  → session.followUp()
POST /api/agent/conversations/{id}/abort      → session.abort()
```

`steer/followUp` 是否在首期开放由 Phase 0 的 SDK 生命周期和 SSE 事件验证决定；若暂缓，仍不新增替代状态机。所谓“重试”就是客户端查看 Session 后再次调用普通 `prompt`，不提供 `/retry` API；批准后的继续执行也使用同一 Session 的普通 `prompt`，不创建 approval-resume Run。取消群聊时，SessionHost 递归调用被委托子 Session 的 `abort()`。

---

## 7. Pi SDK 宿主设计

### 7.1 生命周期

本地服务只缓存进程级重资源：

- 一个 `ModelRuntime`；
- 本地数据库连接；
- Manager client；
- Skills/能力包索引。

每次需要处理一个 prompt 时，SessionHost 打开或创建 Pi Session，直接调用公开的 `createAgentSession()`，订阅其事件，在 `agent_settled` 后释放本次 AgentSession。SessionHost 只是生命周期装配函数，不定义 `AgentSessionRuntime`、Run 或其他产品执行对象。

```ts
const sessionManager = existing
  ? SessionManager.open(sessionFile)
  : SessionManager.create(workspace, sessionDir)

const resourceLoader = buildControlledResourceLoader(snapshot)
await resourceLoader.reload()

const { session } = await createAgentSession({
  cwd: workspace,
  agentDir: aiteamPiDir,
  sessionManager,
  resourceLoader,
  modelRuntime,
})

const unsubscribe = session.subscribe(event => sse.send(event))
await session.prompt(input)
await session.dispose()
unsubscribe()
```

上面的参数名和 Extension 绑定细节以固定 Pi 版本 `.d.ts` 与 Phase 0 为准；设计原则是不在 SDK 外再包一层 runtime。进程级只缓存 `ModelRuntime`、Manager client、数据库连接和已验证资源索引，不重复创建 provider catalog。

运行期只维护必要的进程句柄：

```text
activeSessions[conversation_id] = { session, unsubscribe, abortController }
```

`agent_settled` / error / abort 后统一取消订阅、释放 AgentSession、删除句柄。人工审批等待期间也释放资源；批准后重新打开同一 Pi Session，调用普通 `session.prompt()` 继续，不常驻等待，不创建 approval-resume 子 Run。

暂不提供：

- 常驻每会话进程；
- Session LRU 池；
- new/switch/fork/import 产品能力；
- 跨进程 RPC。

若未来需要树内导航，直接使用 Pi `AgentSession.navigateTree()`、`newSession` 或 `switchSession`，不在产品层复制 Session 树。

### 7.2 单写者

同一 Conversation 的 prompt/compaction/session append 必须串行。

AI Team 用户端是单用户本地进程，因此使用：

```text
KeyedMutex<conversation_id>
```

AI Team 是单用户本机 Agent，不引入 EFS + MySQL `GET_LOCK`。如果未来支持多进程共享同一 Session 文件，再升级为 OS file lock；现在不为假想并发建分布式锁。

### 7.3 受控 ResourceLoader

生产不能直接使用用户全局 `~/.pi/agent` 发现结果。

每次会话显式构造资源：

```ts
new DefaultResourceLoader({
  cwd: workspace,
  agentDir: aiteamPiDir,
  settingsManager: SettingsManager.inMemory(settings),
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  extensionFactories: productOwnedExtensions,
  additionalSkillPaths: verifiedGrantedSkillPaths,
  additionalPromptTemplatePaths: verifiedPromptPaths,
  agentsFilesOverride: () => ({ agentsFiles: generatedAiteamContext }),
})
```

随后必须显式 `await resourceLoader.reload()`，再创建 runtime/session。

- 独立 `agentDir = <aiteam-data>/pi`；
- `SettingsManager.inMemory()`；
- product-owned inline `extensionFactories`；
- 只添加已验证、已授权的本地 Skill/Prompt 路径；
- 禁止 ambient project/global extension/package/context 自动发现；
- 不加载用户项目中的 `.pi/extensions`、`.pi/settings.json` 或全局 Pi auth。

Phase 0 在 workspace 和用户目录放入会抛错的伪 `.pi/extensions`、Skill、settings 和 package，断言全部未加载。这既保证可复现，也防止本机其他 Pi 配置改变 AI Team 行为。

### 7.4 ModelRuntime 与 AI Relay

- Manager 管理 provider/model/成员授权；
- Agent 本地 secure store 必须是 OS keychain/credential vault，或由 OS keystore 保护的加密 vault；禁止明文 fallback；
- `ModelRuntime.create()` 显式使用产品专属 `authPath/modelsPath/modelsStorePath` 或内存 credential store，绝不读取用户全局 `auth.json/models.json`；
- snapshot 只带 `provider_id/model_id`，不带 secret；
- OpenAI/Anthropic 兼容 Relay 优先使用产品专属 models 配置；需要自定义 provider 时在进程级 `ModelRuntime` 初始化阶段注册一次，不做每 Session provider Extension，具体公开 API 由 Phase 0 固定版本验证；
- catalog/auth/refresh 显式传 `AbortSignal.timeout(...)`；普通 `prompt()` 由受控 Settings timeout + Session abort 收口，provider extension 必须传播收到的 signal；
- 凭据按 `tenant_id/member_id/provider_id/model_id` 作用域解析，不通过全局 `process.env` 给 tools/sandbox；
- secret 不得进入 Pi Session、SSE、problem+json、trace、outbox 或 crash report；
- 定义 expiry/rotation/revocation/offline TTL；优先 Relay 受限 token，直连 key 需管理员显式开启并提示扩散风险。

---

## 8. Skills、Extensions、Tools、Packages 的业务映射

### 8.1 Skills：专业流程，不是数字员工本身

适合 Skill 的内容：

- 市场调研方法；
- 代码审查流程；
- 财务建模步骤；
- 合同审查清单；
- 数据分析规范；
- 报告输出格式；
- 企业行业方案中的可复用流程。

目录示例：

```text
skills/
  market-research/
    SKILL.md
    references/
    scripts/
  code-review/
    SKILL.md
  solution-ai-training/
    SKILL.md
    references/
```

规则：

- Manager 管理 Skill 元数据、版本、授权和签名摘要；
- Agent sync 后落本地只读包；
- ResourceLoader 只注入本次员工已授权 Skills；
- Skill 脚本仍是可执行供应链内容，必须审核、固定版本、校验 hash；
- Skill 不获得超出 tool grant 的新权限；
- 对固定行业方案，可把方案 Skill 作为会话必选上下文，而非依赖模型偶然加载。

### 8.2 Extensions：运行时策略机制（不是隔离边界）

以下是**逻辑职责**，不承诺拆成七个 Extension 包：

| 职责 | 首期实现位置 |
|---|---|
| persona、员工/方案/授权上下文 | SessionHost / ResourceLoader 直接注入 |
| 已授权业务工具、知识工具、委托工具 | custom tools |
| 风险分级与审批拦截 | `aiteam-approval` Extension |
| 本地工具审计、usage、SSE 事件 | AgentSession subscription / product service |
| coding tools 路由 | `aiteam-sandbox-router` Extension，仅负责把所有 coding tool Operations 路由到外部 sandbox，自己不构成隔离 |
| 跨会话记忆 | `memory_recall` / `memory_retain` custom tools，通过 Manager HTTP facade 调用 Hindsight；不在 Agent 部署 memory Extension |

首期不新建内部 `pi.events` 总线；职责之间直接函数调用或使用 AgentSession 公开事件。只有多个独立 Extension 真有解耦需求时才使用 `pi.events`。

暂不建设开放 Extension 市场。Extensions 与 Agent Service 同权限，未经审核自动安装 npm/git package 等同执行任意代码。

### 8.3 Tools：能力执行的唯一入口

工具分三类：

1. **Pi 内置 coding tools**：只对代码类员工按需启用；
2. **AI Team product tools**：知识、文件、任务、连接器等本地工具；
3. **委托工具**：`delegate_employee`。

安全规则：

- Manager grant → 本地 snapshot → `tools` allowlist，三者取交集；
- tool execute 前再次校验 grant 和最终参数；
- `tool_call` extension 可以修改参数且不会重新 schema 校验，因此最终 executor 必须重新校验；
- 动态工具启用仅是 token/context 优化，不是授权机制；
- 工具输出必须截断，完整产物落本地文件并返回引用。

### 8.4 MCP：从默认总线降级为兼容扩展

Pi 核心没有 MCP，并明确鼓励直接工具/CLI/Extension。

本次不再要求知识、记忆、技能、连接器全部先转成 MCP：

- 新能力优先做 Pi custom tool/extension；
- 已有且成熟的 MCP server，可通过审核后的 `pi-mcp-adapter` 接入；
- MCP 只是兼容通道，不是所有能力的强制中间层；
- 不保留 `RunSpec.mcp_config`。

### 8.5 Pi Packages：后置的交付格式

首期直接测试仓库内 Skills/Extensions，不为了一个消费者先打包。出现第二个消费者（例如独立 Pi CLI 验证工具）或确需单独发布时，再打成内部 Pi Package。

生产嵌入始终由 Agent Service 显式 import/加载固定版本，禁止运行时 `pi install` 未审核包。

---

## 9. 知识与记忆

### 9.1 企业知识

所有权不变：

- Manager：文档源、知识集、索引配置、员工/成员授权；
- Agent：已授权索引/产物的本地缓存和检索；
- 对话查询和命中文本不上传 Manager。

首期只采用一条可执行的数据链：**Manager 生成版本化、按授权知识集切分的本地检索产物，Agent 增量 pull 并校验**，不同时建设“Agent 重新索引原文”第二条路。

```text
KnowledgeArtifactManifest
  knowledge_set_id / artifact_version / embedding_model
  files[{path, sha256, size}]
  citation_manifest
  created_at / expires_at / grant_version / signature
```

- snapshot 引用明确的 `knowledge_set_id + artifact_version`；
- Agent 在 content-addressed staging 校验签名/hash 后原子切换缓存；
- 新 prompt 只能使用当前 grant 允许的 artifact version；撤权后禁止新 prompt，已经打开的 Pi Session 按 D5/D14 处理；
- citation id 稳定映射到本地 document/chunk manifest；
- Manager 的索引产物格式必须先做可移植性 spike，不能假设任意 LightRAG 实例目录可直接复制。

最小工具：

```text
knowledge_search(query, limit)
knowledge_get(citation_id)
```

SessionHost 在创建 custom tool 闭包时绑定当前 snapshot 已授权的 knowledge artifact；工具调用者不再传 `knowledge_refs`，也不能自行扩大范围。工具返回可展示 citation，前端不需要知道 LightRAG/MCP。

当前 Agent 侧“创建企业知识库/上传企业文档”的写接口应删除或迁回 Manager；如果未来有“个人本地知识库”，必须作为新对象单独设计，不能继续复用企业知识语义。

### 9.2 会话记忆

分两层：

1. **会话内记忆**：Pi Session + compaction，天然具备，不调用外部记忆服务；
2. **跨会话长期记忆**：Manager 端部署 Hindsight，Agent 通过已认证的 Manager HTTP facade 调用。

Agent 不部署 Hindsight、不安装本地 memory server，也不直接暴露 Hindsight bank。Node Agent 只提供两个 Pi custom tools：

```text
memory_recall(query, limit)
memory_retain(content, metadata)
```

Manager facade 根据 token、tenant、member、employee 和 memory policy 路由到对应 Hindsight bank，Agent 不传任意 bank id。HTTP API 至少覆盖 recall、retain、list、delete、disable 和 retention policy；浏览器不能直连 Hindsight：

```http
POST /api/manager/memory/recall
POST /api/manager/memory/retain
GET  /api/manager/memory/entries
DELETE /api/manager/memory/entries/{id}
POST /api/manager/memory/disable
```

这些是 Agent→Manager 的受认证窄通道；Hindsight 的内部端口、bank id 和原生 API 不出 Manager。

数据边界：

- 普通会话、工具过程和 Pi Session JSONL 仍不上 Manager；
- 只有 memory policy 允许且经过脱敏的 recall query / retain content 才发送到 Manager Hindsight；这是明确的跨端记忆例外，UI 必须展示并允许关闭；
- recall 结果只作为当前 `prompt` 的临时 context；它若作为 Pi tool result 出现在当前 Session，由 Pi 按普通 tool entry 记录，但不会自动 retain 成 Manager 长期记忆；
- retain 失败或 Manager/Hindsight 不可达不阻断主链，Agent 降级为只有 Pi Session；
- retain 前过滤 credentials、附件正文、authorization header 和敏感 tool payload；
- 用户可查看、删除、关闭和设置保留期；Manager 按 tenant/member/employee 进行授权、审计和删除；
- Hindsight 的部署、版本、bank 路由、HTTP 超时、重试、删除语义和 retention policy 必须在 Phase 0 锁定。

因此 D17 改为“Manager 部署 Hindsight + Agent HTTP memory tools”，不再设计本地 memory Extension 或本地 Hindsight。

---

## 10. 群聊和多专家协作

### 10.1 目标结构

每个群聊只有一个主协调者 Pi Session。协调者必须是 Manager 已授权 roster 中的真实员工，并记录 `coordinator_employee_id + snapshot_version`；行业方案显式指定，自由群聊未指定时首期确定性选择 roster 第一个已授权员工，不创建无授权的“合成协调者”。

```text
Group Conversation / Coordinator Employee Pi Session
  ├─ coordinator snapshot
  ├─ roster context
  ├─ solution skill（可选）
  └─ delegate_employee(employee_id, task, context)
         └─ 创建临时 Employee Pi Session
```

`delegate_employee` 本身就是协调者 Session 的 Pi custom tool：

1. 校验 employee 在群聊 roster 且仍被授权；
2. 冻结 employee snapshot；
3. 用该员工 persona/model/skills/tools 创建临时 Pi Session；
4. 将子 Session 的最终结果作为当前 tool call result 返回协调者；
5. 子 Session 的 Pi events 作为带不透明 `source_ref` 的实时 SSE 附带信息，不投影为 parent/child 产品记录或第二套事件日志；
6. 协调者继续自己的 Pi Agent Loop，生成最终 assistant message。

首期 child Session 只使用 `SessionManager.inMemory()`，最终结果作为 parent tool result 写入主 Pi Session；不承诺 child 历史、child JSONL 回放或 child 工具日志持久化，也不创建 child 产品记录。Pi sibling tool calls 的并发性、取消和部分失败必须在 Phase 0 验证；若不稳定，首期只把委托工具调用串行执行，仍保留一个协调者 Session，不恢复 planner/subtask/aggregate 状态机。

### 10.2 @提及

业务层仍解析明确 `@员工`，但只做约束，不负责完整编排：

- 有明确 mentions：本轮 `delegate_employee` 只允许这些员工；
- 无 mentions：协调者可在 roster 内选择；
- 防回环：子员工 session 不拥有 `delegate_employee` 工具；
- child 使用独立 snapshot、workspace、approval namespace 和限额；parent approval 不能复用；
- `context` 只传结构化任务摘要和显式授权 artifact 引用，不默认复制完整群聊/附件；
- parent `abort()` / timeout 递归 abort child；每个 delegate tool call 限制子 Session 数、并发、prompt 次数、时间与成本；
- child 最终结果进入 parent tool result；child 正文和工具过程只存在内存 Session，parent 取消或进程退出即丢弃，不写第二套产品事件表。

### 10.3 行业方案

行业方案不再固化为 Python 中 planner/subtask/aggregate 三段 prompt 状态机。

方案实例下发：

```text
solution profile
  mandatory_skill_refs[]
  coordinator_instructions
  roster constraints
  output contract
  approval policy
```

Agent 将 mandatory skills 和 coordinator instructions 注入群聊主 Session；具体拆解轮数由 Pi Agent Loop 自适应决定。

### 10.4 为什么首期不直接采用 pi-subagents

AI Team 的“数字员工”有 tenant grant、employee snapshot、知识/连接器和产品时间线语义，不等同于 coding-agent 的 scout/reviewer/worker 角色。

首期一个 `delegate_employee` 工具已覆盖 Demo 的本地多专家协作，代码和状态更少。只有出现 worktree、durable mission、复杂评审编排等真实需求时，再把 `pi-subagents` 作为审核后的可选 Extension；不为了“生态完整”预装整套调度系统。

---

## 11. Conversation 计划、任务视图和办公室

计划是 Conversation 的配置，不是 Loop 对象，也不让模型自己维护 cron。Agent 只保留一个轻量 wall-clock scheduler，触发时直接对目标 Pi Session 调用 `prompt()`：

```text
Conversation.schedule_json
  → scheduler 到点读取配置
  → session.prompt(scheduled_prompt)
  → Pi Skills/Tools 执行
  → 新增 Pi Session entries
```

Conversation 上可选的最小 schedule 配置：

```text
schedule_id / revision
schedule: cron / once
timezone
enabled
overlap: skip（首期固定）
misfire: skip（首期固定）
prompt_template / skill_ref?
```

不建立 Loop 表、last_run_id、next_run_at、misfire 状态或重试计数。每次 occurrence 生成确定性的 `Idempotency-Key = H(schedule_id, occurrence_utc, conversation_id)`，直接复用 `idempotency_receipt`：

- 已有 `accepted/completed` 收据时跳过该 occurrence；
- `unknown` 不自动重放，记录需要人工确认；
- 同一 Conversation 正在运行时按 `overlap=skip` 不调用新的 `prompt()`；
- cron 首期采用 `misfire=skip`，scheduler 重启只处理当前时间之后的新 occurrence；
- 一次性 schedule 在创建 occurrence 收据的同一 SQLite 事务中禁用；若随后变成 `unknown`，用户明确重启 schedule 才能再次执行。

历史直接从目标 Pi Session 的 user/assistant entries 查询，不需要 last/next run 字段。

任务看板不是 Task 状态机：

- `conversation.kind=task` 或标签表示任务型 Conversation；
- 当前状态直接由对应 Pi Session 的最后 entry、实时 `AgentSessionEvent`、approval record 和 schedule 推导；
- 附件、产物和引用作为本地文件元数据保存；
- Office 是上述 Conversation/Session 的只读查询页面，不允许页面写回伪状态或使用前端定时器模拟完成；
- 复杂步骤交给 Skill + Pi Agent Loop，不建立 DAG、Task 表或第二套流程引擎。

---

## 12. HITL 与安全执行

### 12.1 审批模型

风险级别：

- L0：只读；
- L1：可逆本地写；
- L2：不可逆写/外部副作用；
- L3：凭据、敏感数据、跨系统或危险命令。

`aiteam-approval` 在 Pi `tool_call` 前：

1. 对最终 tool name + normalized args + snapshot/grant 做校验；
2. L0/L1 放行；
3. L2/L3 生成 `ApprovalRecord`，计算参数 hash；
4. 返回 Pi 原生 `{ block, reason, terminate }`；
5. 通过同一 SSE 连接发送 `approval_required` 附带事件；
6. Pi AgentSession 自然 settle，Agent 不把它转换成 waiting 状态机。

```text
ApprovalRecord
  id / approval_batch_id / session_id / snapshot_version
  tool_call_id / tool_call_entry_id / tool_name
  encrypted_canonical_args / canonical_args_hmac / redacted_summary / risk_level
  status: pending | approved | executing | succeeded | rejected | invalidated | expired | uncertain
  approved_by / approved_at / expires_at
  idempotency_key
```

审批与恢复：

1. `tool_call` 时记录对应 Pi assistant tool-call entry id，并把规范化参数加密保存；同一 assistant message 的危险 sibling 共享 `approval_batch_id`；
2. 用户批准后，重新打开同一 Pi Session，调用普通 `session.prompt()` 发送受控 approval continuation；这仍是 Pi 的普通 user prompt，不是 approval-resume Run；
3. continuation 携带一次性 approval id。Extension 只允许模型重新发起与原 `tool_call_entry_id`、参数 HMAC、snapshot 和 tool name 都匹配的调用；参数变化必须重新审批；
4. 工具执行前以 CAS 原子完成 `approved → executing`，同时检查 approval batch 未被拒绝、取消或过期；将稳定 `idempotency_key` 传给支持幂等的下游；
5. 下游不支持幂等或结果查询时，执行期间崩溃进入 `uncertain`，禁止自动重放，要求人工核对；不宣称通用 exactly-once；
6. 任一审批拒绝、Conversation `abort()` 或 batch 终止时，事务内将所有未执行 sibling 置 `invalidated`；CAS 必须同时检查 batch active；
7. approval continuation 没有在 `expires_at` 前重新发起匹配工具时，将 Approval 标记 `expired`；不会长期保持 `approved`。用户必须重新发起普通 prompt 触发新的审批，或明确取消；不自动重放危险工具。

Pi 默认并行 tool batch 中，危险调用被 block 不代表安全 sibling 停止；允许 L0/L1 sibling 完成并记录，但 L2/L3 本身不得执行。Phase 0 必须验证 settled Session 重新打开后调用普通 `prompt()` 的公开 SDK 行为，以及单危险、危险+安全 sibling、双危险、拒绝、批准前重启、改参和重复调用。

Pi block reason 不直接成为新的前端状态机；前端只展示 approval 附带事件和 ApprovalRecord。ApprovalRecord 的状态机只服务于副作用安全、幂等和审计，不承载普通 prompt 生命周期。

### 12.2 工具隔离分级

默认原则：**非代码员工不获得 built-in file/bash tools**。

| 员工类型 | 默认工具 |
|---|---|
| 一般业务员工 | 只启用 product custom tools；无 bash/write/edit |
| 知识/分析员工 | product tools + 必要只读 file tools |
| 代码员工 | coding tools，但只能在专属 workspace 隔离边界内 |

代码员工必须使用**独立的非特权 sandbox worker/process/container**；Agent Service 整体容器不是 coding tool 的充分隔离，因为宿主仍需持 provider、Manager 与 Session 权限。

- 每个 Conversation/子 Session 使用独立 workspace 和 temp；
- `read/write/edit/bash/grep/find/ls` 全部经同一 sandbox filesystem boundary，不只约束 bash；
- sandbox 只挂当前 workspace/temp，不挂 Agent data、Session、secure store、Docker socket；
- 独立 UID、只读 rootfs、`no_new_privileges`、CPU/内存/PID/时间限制和整棵进程树取消；
- 默认无网络；必要出站经目标 allowlist/proxy broker 单独授权；
- sandbox env 从空白 allowlist 构造，不继承 Agent Service/provider/connector credentials；
- path canonicalization、symlink/TOCTOU 防护；
- sandbox 不可用时 fail-closed；
- 不暴露 Pi TUI `!command` 路径。

`aiteam-sandbox-router` 只负责把 Pi tool Operations 路由到外部隔离边界，Extension 自己不是 sandbox。需要执行更强不可信代码或有合规要求时使用 microVM/OpenShell，不把 project trust、tool allowlist 或 permission hook 当 sandbox。

### 12.3 SessionStoragePolicy

本地优先不等于本地明文无限保留。Pi Session 根目录必须固定且不可由 API 输入：

- open 前 canonicalize，确认仍位于受控根目录；目录 `0700`、文件 `0600`；
- 数据目录不得位于普通 temp、用户全局 Pi 目录或默认云盘同步目录；
- 本地静态加密密钥由 OS keychain/keystore 保护；若文件级加密与 Pi `SessionManager` 不兼容，Phase 0 必须选择加密卷/受控目录等 OS 边界，不自改 JSONL；
- credential、authorization header、provider key 不得进入 Session entry；tools 只接受 credential ref，执行时解析；
- 配置保留期和容量上限；compaction 不是安全删除；
- 删除 Conversation 时删除本地主 Session、Pi entry、artifact、attachment；若策略要求删除对应 Manager Hindsight 记忆，Agent 通过受认证 memory-delete facade 发起带稳定幂等键的远端删除，Manager 负责授权、执行、结果确认和失败重试；Agent 在收到确认前把删除请求标为 pending，不宣称远端已删除；服务重启后只重试这个带稳定幂等键的 Manager 删除请求，不重试任何 Pi prompt；
- 排除普通日志、备份和桌面索引；
- Phase 0 测试半写、截断、异常退出、路径篡改和损坏恢复。

### 12.4 Extension/Skill 供应链

- product extension 固定版本、随产物打包；
- Skill 包使用签名 manifest：package id、版本、来源、全部文件 digest、能力声明、有效期、撤销 epoch；
- Agent 固定信任根，sync 和每次加载前验签/验 hash；内容寻址 staging 后原子切换；
- 安全解包拒绝绝对路径、`..`、symlink/hardlink 和未声明文件；
- 撤销/过期后禁止新 prompt，离线只在明确 TTL 内使用最后验证版本；
- 禁止 package install hooks 和未锁定依赖；Skill script 必须进入 coding sandbox；
- SKILL.md 也是主动 prompt 内容，需按可调用能力审核，不只检查脚本 hash；
- 禁止 Manager 下发 arbitrary JS/TS；
- 禁止 Agent 在运行时自动 `npm install`/`git clone` 未审核 package；
- package 更新先在 CI 做工具、权限、event 和 sandbox 回归。

### 12.5 Provider/Relay 出站边界

“内容不上控制面”只禁止向 Manager/Operator 治理面上传，不代表 prompt 不会发送给模型 Provider/AI Relay。UI 和策略必须展示 provider、endpoint/region、是否经 Relay；企业可限制 provider、数据区域和附件发送。Provider/Relay 的日志、训练和保留策略必须可配置审计，且请求正文不得进入控制面 telemetry、治理摘要或普通诊断日志。

---

## 13. Pi 事件与前端

### 13.1 直接传输 Pi AgentSessionEvent

不再维护 `PiEventProjector`、`AITeamTimelineEvent` 或产品 run/task 事件枚举：

```text
Pi AgentSessionEvent
  → 版本固定的 SSE serializer（只加 conversation_id/source_ref）
  → web/agent
```

SSE 传输 Pi v0.84.2 的公开 discriminated event，前端按 Pi 原生事件渲染：

```text
agent_start / agent_end / agent_settled
message_update / message_end
tool_execution_start / tool_execution_update / tool_execution_end
auto_retry_start / auto_retry_end
compaction_start / compaction_end
approval_required（Extension 附带事件）
```

serializer 只做三件事：

1. 去除 secret、credential、路径和内部 Session 文件信息；
2. 添加 `conversation_id`、不透明 `source_ref` 和必要的 `tool_call_id` 关联；不得暴露 Pi session id、文件路径或 workspace；
3. 按固定 Pi 版本输出 SSE，不把事件改名为 `run_started`、`run_succeeded` 或 `timeline_event`。

前端用 Pi 事件直接判断当前 prompt 是否 active、消息 delta 如何合并、tool 是否开始/结束、compaction 是否发生；`message_end.message` 是最终消息，`agent_settled` 是本次 `prompt()` 的收尾信号。未来升级 Pi 时通过事件 schema/golden test 评估，而不是在 Agent 内维护第二套事件状态机。

### 13.2 持久与瞬时

持久事实全部由 Pi Session 提供：

- 用户、assistant、thinking、tool call/result、compaction 和 retry entries；
- 主 Session 的 JSONL；
- Pi entry id、parent entry 和 Session tree 关系；child Session 首期不持久化。

Agent SQLite 只保存 Pi 无法替代的本地元数据：

- Conversation → Session 索引和员工快照；
- ApprovalRecord、附件、产物引用和 schedule 配置；
- HTTP idempotency receipt；
- 脱敏 usage outbox。

不保存 `message`、`raw_runtime_event`、`timeline_projection`、tool 正文或额外的执行终态记录。SSE 中的 token/thinking/tool progress 是实时传输；断线重连时按 Pi Session entry id 查询历史，不能要求重放已经消失的瞬时 progress。

Usage 直接从 Pi Session stats、assistant message usage、tool nested usage 和 compaction usage 聚合；以 Pi entry id 去重。`prompt_count` 以幂等收据为主，`settled_count` 只统计有明确 durable completion 证据的 prompt，未知崩溃宁可保守少计。Phase 0 覆盖多次 assistant、nested tool、compaction 和 SDK retry，避免 Agent 另造通用 usage event 表。

### 13.3 SSE

```http
GET /api/agent/conversations/{id}/events?after=<pi_entry_id>
Accept: text/event-stream
```

- `after` 使用 Pi Session entry id，不新增 numeric timeline cursor；
- 先建立当前 Conversation 的 live subscription 和有界事件队列，再在同一 keyed mutex/Session 读锁下记录 replay boundary；
- 回放 boundary 之后的 Pi entries，随后按 entry/event id 去重并排空队列，再继续发送 live events，避免“先回放后订阅”的丢事件窗口；
- transient event 不写 SQLite，断线后只能从 Pi Session entry 恢复持久消息和工具结果；
- 前端以 `message_update` 增量更新，以 `message_end` 的 Pi message 替换对应内容；
- delegate 子 Session 事件附带不透明 `source_ref` 和 `tool_call_id`，不合并成另一套 timeline。

首期只保留 SSE，不同时维护 WebSocket；`prompt/steer/follow-up/abort` 继续直接映射 Pi Session 方法。

---

## 14. 本地数据模型

保留 SQLite，但只做 Pi Session 索引和无法由 Pi 承担的本地元数据：

```text
conversation
  id / title / kind / labels
  pi_session_id / pi_session_file
  entry_employee_id / coordinator_employee_id / solution_instance_id
  schedule_json?
  last_read_at / created_at / updated_at

idempotency_receipt
  operation: prompt | memory_delete
  key / conversation_id / caller_id / request_fingerprint
  state: accepted|completed|unknown|pending
  owner_instance / claimed_at / lease_expires_at
  accepted_at / completed_at / last_entry_id?

approval  # pending|approved|executing|succeeded|rejected|invalidated|expired|uncertain
attachment
artifact
loaded_employee_projection
loaded_solution_projection
frozen_snapshot
local_capability_cache
usage_summary_outbox
```

删除或不再建立：

- `message`；
- `turn`；
- `run`；
- `task`；
- `loop`；
- `timeline_projection`；
- `raw_runtime_event`；
- `runtime_worker`；
- `runtime_capability`；
- `runtime_session`；
- `runtime_binding`；
- per-runtime provider env/materialization 表。

Pi Session entry、Session tree 和 AgentSessionEvent 是执行与内容事实源；SQLite 不复制正文或执行状态。Session 文件路径只在本地数据库内部使用，不暴露到 Web、普通 health 响应或跨端摘要。

### 14.1 治理摘要 allowlist

Agent→Manager 只允许固定 schema：

```text
UsageSummary
  schema_version / summary_id / tenant_id
  member_id / employee_id
  period_start / period_end（固定 UTC 时间桶）
  prompt_count / settled_count / error_count
  input_tokens / output_tokens / cache_tokens
  cost_minor / currency（ISO-4217；每条 summary 仅一种币种）
  duration_ms_total / approval_denied_count
```

禁止字段：session/conversation/artifact id、tool name、自由文本错误、路径、文件名、逐次时间戳、prompt/response/附件/工具正文。跨币种禁止直接求和；若治理统一采用结算币种，也必须在 schema_version 中冻结换算来源和时点。Agent 在进入 outbox 前按 schema allowlist 构造，禁止扩展字段；`prompt_count` 从 idempotency receipt 聚合，`settled_count` 只从有明确 durable completion 证据的 Pi entries/收据聚合，未知崩溃保守少计，不依赖瞬时 AgentSessionEvent。按 `summary_id` 幂等。Manager→Operator 再聚合到企业级并剥离 member/device，高基数或小样本桶执行抑制。Outbox 加密、限保留期、成功后清理。

---

## 15. 目标代码结构

```text
server/
├── operation_service/          # Python/FastAPI，保留
├── manager_service/            # Python/FastAPI，保留
├── agent_service/              # 改为 Node.js/TypeScript package
│   ├── package.json
│   ├── src/
│   │   ├── app.ts              # HTTP/SSE 装配
│   │   ├── http/               # conversations/prompt/approvals/sync
│   │   ├── services/           # conversation/group/schedule/sync
│   │   ├── pi/
│   │   │   ├── session-host.ts # thin create/open/prompt/abort adapter
│   │   │   ├── resources.ts
│   │   │   └── model-runtime.ts
│   │   ├── tools/
│   │   │   ├── business.ts
│   │   │   ├── knowledge.ts
│   │   │   ├── memory.ts       # Manager Hindsight HTTP facade client
│   │   │   └── delegate.ts
│   │   ├── extensions/
│   │   │   ├── approval.ts
│   │   │   └── sandbox-router.ts
│   │   ├── storage/
│   │   │   └── sqlite.ts       # session index + minimal metadata
│   │   ├── manager-client.ts
│   │   └── schedule-service.ts
│   ├── skills/
│   └── tests/
├── shared/                     # Python 控制面共享库；不再假设被 Node import
└── run.py                      # 仅 operation|manager，agent 由 Node 入口启动

web/
├── operation/
├── manager/
├── agent/
└── shared/
```

不新建一个 `pi_gateway`、`pi_driver`、`runtime_adapter`、`backend interface` 或 RPC sidecar。唯一实现不需要接口套接口。

跨 Python/TypeScript 契约以 OpenAPI/JSON Schema 为边界：

- Manager Pydantic schema 生成 Agent→Manager OpenAPI；
- Agent 端生成 TypeScript client/types；
- Agent 本地 TypeBox/JSON Schema 生成 web/agent client types；
- CI 做 OpenAPI diff，不手写两份 DTO。

Node Agent 仍必须实现 v1 标准入口与错误契约：`/healthz`、`/readyz`（只检查本地 DB/Session 基础）、`/openapi.json`、`/docs`、`/redoc`，统一 envelope、`application/problem+json`、request_id、CORS/CSP、metrics 和 OpenAPI quality gate。

---

## 16. 应删除和迁移的现有实现

评审通过、TS parity 完成后删除整个旧 Python 用户端实现，而不是保留两套 Agent Service：

```text
server/agent_gateway/**
旧 server/agent_service/**/*.py、旧 Python migrations 与对应 tests
  （业务语义迁入新的 TS package；不是继续运行旧源码）
server/shared/contracts/gateway.py
server/shared/contracts/runspec.py
所有 Gateway/Driver/Executor golden tests
AGENT_RUNTIME / AGENT_RUNTIME_ENV_PASSTHROUGH 配置
agent-client-protocol Python 依赖
runtime_binding 字段与 UI
```

仅保留仍被 Operator/Manager 使用且语言中立/OpenAPI 有来源的共享契约；Node Agent 不 import Python 业务包。

迁移而非删除：

- grants/snapshot/sync；
- local login/token/JWKS；
- Conversation → Pi Session index and schedule metadata；
- idempotency receipts and approval records；
- usage outbox；
- Manager/Operator service client；
- local workspace/attachment/artifact；
- Pi event SSE transport and privacy/boundary tests。

同时修正当前所有权偏差：

- Agent 端不能本地“招募”并创建 employee projection；招募回 Manager；
- Agent 端不能创建企业知识库和摄入企业文档；企业知识管理回 Manager；
- 快照 fallback 只捕获明确 network/timeout，不捕获 401/403/revoked/schema error。

### 16.1 当前代码偏差与硬删除边界

当前仓库尚未真正接入 `pi-coding-agent`：`server/agent_service` 仍是 Python/FastAPI，`server/agent_gateway` 仍装配 Hermes/Codex/Claude/OpenCode/OpenClaw 等多 runtime，`web/agent` 仍调用 `/messages`、`/runs`、`/timeline`、`/loops`。因此本提案不是在旧 `MainlineService` 中替换一个 Driver，而是新增 Node/TypeScript Agent 并进行破坏性切换；旧 Python Agent 只能作为业务参考，不能继续运行、桥接、双写或作为 Node import 依赖。

当前 Agent 组合根 `server/agent_service/app.py` 同时装配 Mainline、Gateway、Loop、Usage、Grants、Workspace、GroupMgmt 和 Terminal。切换必须以新的 Node `app.ts + SessionHost` 原子替换该组合根；只删除旧路由而保留后台 scheduler、GroupMgmt 或 usage callback，仍会留下第二个执行器。

当前代码中以下重复边界必须在切换时一并消失：

- `mainline/service.py`、`mainline/models.py`、`mainline/execution_orchestrator.py` 的 Run/Task/RunSpec 状态与翻译层；
- `mainline/timeline.py`、`mainline/event_mapper.py`、`shared/contracts/events.py` 的 Timeline/Runtime 双事件层；
- `loop/*` 的 Loop→Run scheduler；
- `group_mgmt/*` 的 GroupConversation/GroupMessage 与 Mainline Conversation/Message 双存储及进程内 `_mainline_convs` 映射；
- `mainline/group.py` 的 planner/subtask/aggregate、TaskNode 和 synthetic planner；
- `terminal/*` 与 Gateway TerminalExecutor 的独立执行链；
- `workspace/routes.py` 中 Agent 本地招募、创建企业知识库、上传/摄入企业文档的写接口。

这些代码路径不是迁移后的兼容层，而是 Phase 4 应删除的旧实现。迁移期间只允许保留一份 Pi Session 内容事实源和一份 Agent 本地元数据索引。

### 16.2 Manager 数据与安全迁移约束

- Manager 当前 `memory_item` CRUD 不是 Hindsight。必须改为 Manager→Hindsight 的单一 HTTP adapter；不得同时保留第二个 memory backend。
- 知识授权以 `employee_knowledge_binding` 关系为唯一真相；`employee.knowledge_refs` 仅作为迁移期兼容读取，完成后删除或改为只读派生字段。
- Manager 的 `run_event`、逐 run `usage_ledger` 和 `run_id/team_task_id` 归档不再接收；Agent 只上报固定脱敏 `UsageSummary`。
- `/api/manager/usage/upload` 的租户必须从 service token claims 推导，或严格校验 body tenant 与 token tenant 一致；不得信任请求体中的 tenant_id。
- Agent 删除本地 Conversation 后，远端 Hindsight 删除必须通过 Manager memory facade 和稳定幂等键完成；未收到 Manager 确认前不得宣称远端删除完成。

### 16.3 前端、测试与迁移边界

- `MessageComposer` 从 `messages + runs` 改为一次 `prompt`；`TimelineView`/`TimelineStore` 改为 Pi event/session transport；`RunsPanel`、`LoopPanel`、Run provenance 和旧 `/runs|/tasks|/loops|/timeline` client 删除。
- 群聊前端不再提交可影响执行的 persona/model/skills/knowledge/memory 配置；roster 由 Agent 本地授权投影和快照决定，`delegate_employee` 是唯一协作入口。
- 旧 runs/tasks/loops/timeline/raw_events/group_messages/逐 run usage migrations 不作为新 Node Agent 的运行时 schema；无正式用户数据时直接使用新库，有正式数据时只提供一次性离线 importer。
- 旧 Gateway/Driver/RunSpec/Timeline/Loop 测试删除或改写为 Pi Session、Pi event、sandbox、approval、grants、privacy 和 Manager facade 验收；不为旧 API 保留兼容 alias。

---

## 17. 部署与交付

### 17.1 技术栈

- Operator/Manager：Python + FastAPI，不动；
- Agent Service：Node.js 22.19+，推荐随 Pi 当前支持基线固定 Node 24；
- Agent Web：现有 React/Vite；
- 本地元数据：SQLite；
- Pi：固定精确版本，升级需契约回归。

### 17.2 启动

开发：

```text
scripts/ctl.sh
  operation → python server/run.py --tier=operation
  manager   → python server/run.py --tier=manager
  agent     → pnpm --dir server/agent_service start
```

生产用户端产物只包含：

- Node Agent Service；
- Pi SDK 与固定 product Extensions/Skills；
- web/agent；
- 本地 migrations；
- sandbox/container 配置。

绝不包含 Operator/Manager 代码。

### 17.3 健康检查

标准端点：

- `/healthz`：进程存活；
- `/readyz`：只检查本地 DB、Session 根目录可读写和必要本地迁移，不因 Manager/provider/memory 不可达而失败；
- `/openapi.json`、`/docs`、`/redoc`；
- `/metrics`。

另设受保护的 `/api/agent/diagnostics` 返回 Pi SDK version、provider/model、sandbox、knowledge/memory、Manager sync 等状态；普通响应只返回目录 `ready/readable/writable`，不返回 local DB/Session 实际路径。删除 runtime brand/Driver family/CLI path。

---

## 18. 迁移阶段

### Phase 0：SDK 与 Manager 能力 Spike（必须先做，可丢弃）

只回答以下可行性问题：

1. 受控 ResourceLoader 能否完全拒绝 ambient 资源并正确 reload；
2. `createAgentSession()`、SessionManager open/create、`session_start/shutdown/dispose` 生命周期是否稳定；
3. Session create/open/restart/半写恢复是否稳定；
4. skills/persona/model/custom tool 是否按 snapshot 注入；
5. Pi 原生 message/tool/compaction/retry/settled events 是否能直接序列化为 SSE；
6. abort、超时和进程重启是否按“unknown、不自动重放”收敛；
7. settled Session 重新打开后能否用普通 `session.prompt()` 做审批 continuation；若不能，验证宿主执行批准工具并再 prompt 的最小替代路径；
8. 两个 `delegate_employee` 的并行性、事件归属、取消传播、部分失败和 usage 聚合；
9. 全部 coding tools 是否进入独立 sandbox 且 fail-closed；
10. Manager 知识索引产物是否可移植、增量和稳定 citation；
11. Manager Hindsight HTTP facade 的认证、tenant/member/employee bank 路由、recall/retain/list/delete/disable/retention、超时和降级语义；recall 作为 Pi tool result 的本地 Session 保留边界。
12. idempotency receipt 的 fingerprint、lease、启动 recovery、同 key 冲突和 schedule occurrence 去重；
13. SSE subscribe-before-replay 的边界、队列和 entry/event 去重，证明不会丢事件。

产物放 `experiments/pi-sdk-spike/`，结论回填本文，试验代码不直接演变成生产代码。

### Phase 1：私聊纵向切片

- 新 Node Agent Service 最小骨架；
- Manager login/sync/snapshot client；
- SQLite Conversation → Pi Session index；
- 受控 ResourceLoader（全部 `no*` + 显式 resources）和严格 tools allowlist；这是第一条真实私聊前置，不能推迟；
- Pi SessionHost 薄层；
- `POST /prompt` + SSE + `abort`；执行中再次 prompt 返回 409；
- Idempotency-Key receipt 和 crash 后 `unknown` 处理，不写 custom entry、不自动 retry；
- Node JWT/JWKS middleware + Python→Node golden token tests；
- 标准 health/ready/docs/problem+json；
- 一个 employee、一个 provider、无 knowledge/memory/group/schedule；
- 前端直接渲染 Pi events。

验收：创建 Conversation → 调用 `prompt` → 看到 Pi delta/tool/final → 刷新从 Session entry 恢复 → `abort` → 用户用新 key 再次 prompt。

### Phase 2：Skills、知识、审批、记忆与代码工具

- Skill 签名 sync/materialize；
- knowledge artifact pull + 无 refs 参数的 tools + citations；
- approval CAS/idempotency/uncertain + 普通 prompt continuation；
- 独立 coding sandbox worker；
- provider/AI Relay credential broker；
- Manager Hindsight HTTP memory tools：recall/retain/list/delete/disable/retention；服务不可用时降级为 Pi Session；
- 固定 allowlist usage summary outbox。

### Phase 3：群聊、方案、计划和办公室视图

- 已授权 coordinator employee + delegate_employee；
- child 内存 Session 限额、取消传播、部分失败和 Pi event 附带信息；
- solution skills；
- Conversation schedule + scheduler→`session.prompt()`；
- Task/Office 作为 Conversation/Session 查询视图，不建 Task/Loop 表；
- child usage 只在 parent tool result/主 Session 的可见 usage 中统计；不承诺 child Session 独立历史。

### Phase 4：切换与删除

- web/agent 全量切新 API；
- 独立 parity/隐私/契约测试通过；
- 停止旧 Python Agent Service；
- 删除 `agent_gateway`、RunSpec/Driver/Executor 与旧 tests；
- 删除 runtime_binding/AGENT_RUNTIME；
- 更新安装包、CI、SOP 和正式 v1 文档。

不做：生产双写、旧 Gateway 反代 Pi、长期兼容 alias。

本地数据默认策略：若切换前尚无正式用户数据，开发/测试环境直接重置 Agent 本地库；一旦存在需保留的用户会话，切换前必须提供一次性离线 importer，将 SQLite Conversation/Message 转成 Pi Session 并校验数量/hash。二者必须在发布决策中二选一，不留给安装器猜测。

---

## 19. 验收矩阵

### 19.1 Demo 业务能力

| 场景 | 验收 |
|---|---|
| 私聊 | 真实 Pi streaming、工具、`abort`、新 prompt、刷新恢复 |
| 群聊 | coordinator Session + `delegate_employee` child Sessions，parent tool result 汇总 |
| @提及 | 明确 mentions 约束 delegate 目标，无 mention 才允许协调者选择 |
| 计划 | Conversation schedule 定时调用真实 Pi `prompt()`，启停/历史可查 |
| 任务/Office | 直接读取 Conversation、Pi entries、events、approval、artifact，不是前端动画 |
| Skills | Manager 授权 → Agent sync → Pi 加载 → 实际执行 |
| 知识 | 本地检索、有 citation；正常查询不上传 Manager |
| 记忆 | Agent custom tools → Manager Hindsight HTTP；可 retain/recall/删除/关闭；服务不可用时降级 |
| 人才市场 | Operator 模板 → Manager 招募/授权 → Agent pull，不在本地造实例 |
| 行业方案 | 方案 Skills + roster 下发，协调者按方案规则执行 |
| 治理 | Agent→Manager→Operator 只有脱敏摘要，无法还原会话；记忆例外仅发送明确授权内容 |

### 19.2 Pi SDK 契约测试

- 固定 Pi 版本下的公开 event golden tests；
- message delta 重组 + `message_end` 权威替换；
- tool args 被 Extension 修改后的二次校验；
- Session reopen/compaction 后历史重建；
- idempotency receipt fingerprint/lease/recovery 和 schedule occurrence 去重；
- SSE subscribe-before-replay、边界队列和 entry/event 去重；
- 同 Conversation 并发串行；
- `prompt`/`steer`/`followUp`/`abort`/timeout/provider error；
- settled Session 审批 continuation；
- Extension 初始化/关闭与资源泄漏；
- Pi 升级前后 Session 兼容。

### 19.3 安全和隐私

- ambient `~/.pi` resource 不会被加载；
- 未授权 tool/skill/knowledge/employee 无法启用；
- arbitrary package 无法安装；
- coding tool 无 sandbox 时拒绝；
- workspace 越界、symlink、secret file、网络策略测试；
- 401/403/revoked 不会回退旧快照；
- usage/trace/outbox 不含 prompt、response、附件、工具正文；
- Manager/Operator API 无普通 Session/Message/工具正文；Hindsight HTTP 只接受 memory policy 明确允许的脱敏 recall/retain 数据；
- Agent 不部署本地 Hindsight，不把 memory bank id 暴露给前端。

### 19.4 完成标准

只有当以下同时成立才可删除旧架构：

1. Phase 1–3 用户流自动化通过；
2. Agent OpenAPI 与前端类型生成通过；
3. Pi event/Session/sandbox golden tests 通过；
4. 隐私扫描与三端边界测试通过；
5. 用户端精简产物不含控制面代码；
6. 旧 Gateway/Driver/RunSpec 引用归零；
7. 独立 reviewer 无 blocker。

---

## 20. 对 v1 D1–D24 的影响

| 裁决 | 处理 |
|---|---|
| D1 三端形态 | **语义保留、内部形态修订**：三端不变，“用户端内含 Gateway”改为“用户端内含 PiSessionHost” |
| D2 API 前缀 | **保留** `/api/operation|manager|agent`；Agent 内部资源路径调整 |
| D3 三套前端 | **保留** |
| D4 窄通信 | **保留** |
| D5 执行快照 | **保留**，改为直接组装 Pi Session |
| D6 raw event | **修订**：删除多 runtime raw event 表和 durable product timeline；Pi Session entries 是内容/工具事实，SSE 直接传 Pi events |
| D7 Runtime Worker | **替换**：本地进程内 Pi SDK 是唯一运行形态；不再设计 Daemon/Cloud Worker |
| D8/D9 认证/无 Edge | **安全语义保留、共享实现修订**：Manager 签发/Agent 本地验签不变，Node JOSE + 语言中立 schema/test vectors 替代 Python import |
| D10 后端 FastAPI | **修订**：Operator/Manager 保持 FastAPI；Agent Service 改 Node/TypeScript |
| D11 工程落点 | **修订**：`server/agent_service` 改 TS package，删除 `server/agent_gateway` |
| D12–D14 授权/隐私/离线 | **保留并加强** |
| D15 分端产物/统一启动器 | **分端精简产物保留、启动器修订**：`scripts/ctl.sh` 统一开发入口，Python `run.py` 不再启动 Agent |
| D16 RunSpec/MCP/Driver | **替换**：Snapshot → controlled ResourceLoader/AgentSession；MCP 仅兼容扩展；不建立 Run/Turn/Timeline 翻译层 |
| D17 mem0 | **修订**：Manager 部署 Hindsight，Agent 通过受认证 HTTP facade 使用 memory tools，不做本地 memory service |
| D18 provider | **保留管理面**，执行改由 ModelRuntime/provider extension |
| D19 编排/Loop | **保留业务归属、删除 Loop 执行对象**：coordinator/delegate 使用 Pi custom tool，计划配置附着 Conversation，scheduler 直接调用 `session.prompt()` |
| D20–D24 | **保留** |

本提案会改变冻结裁决，因此不能只改 `06` 一篇。正式批准后必须原子更新：

- `00` 裁决表；
- `04` snapshot/capability/provider/记忆；
- `05` 端内调用；
- `06` 全文；
- `07` 事件模型；
- `09` 构建与启动；
- `10/11` 阶段与工单；
- `AGENTS.md/CLAUDE.md` 技术选型、结构、检查点。

---

## 21. 明确不做

- 不继续维护多 runtime；
- 不把 Pi 包在原 Gateway 的新 Driver 里；
- 不做 Python↔Node RPC sidecar；
- 不迁移 Operator/Manager 到 Node；
- 不让 Manager/Operator 执行 Pi；
- 不开放任意 Extension/npm/git 插件市场；
- 不把所有能力强制转 MCP；
- 不建立新的通用 DAG/工作流内核；
- 不建立 Run、Turn、Task、Loop、Timeline 第二套执行抽象；
- 不让 Office 成为状态源；
- 不支持跨用户实时群聊；
- 不上传普通会话内容、Session JSONL 或工具明细到控制面；长期记忆只有在 memory policy 明确允许时，以脱敏 recall/retain 通过 Manager Hindsight HTTP 传输；
- 不依赖 Pi TUI/CLI 私有行为；
- 不保留旧 runtime API alias 或生产双写。

---

## 22. 待用户/架构评审确认的五个决策

1. **Agent Service 改 Node/TypeScript**：这是删除 Gateway 和同进程 SDK 的必要条件；若拒绝，只能退化为 Python + Node sidecar，复杂度会明显回升。
2. **Pi Session 作为唯一会话内容事实源**：Conversation 只做 Session 索引；SQLite 不保存 Message、Run、Task 或 Timeline 正文/状态。
3. **D17 改为 Manager Hindsight HTTP**：Manager 承载 Hindsight，Agent 只通过受认证 memory tools 使用，普通会话仍不上传；记忆例外必须受 policy 和脱敏约束。
4. **Agent 北向 API 直接映射 Pi**：用幂等 `/prompt`、SSE、`/abort`，按需增加一对一的 `/steer` 和 `/follow-up`；删除 `/messages + /runs`、`/retry`、Run/Turn 状态机。
5. **现有 Agent 本地数据处置**：无正式数据则重置；有正式用户数据则先做一次性 SQLite Message→Pi Session 离线 importer，不做生产双写。

建议接受 1–4；5 在发布前按实际数据状态二选一。若只接受“换 runtime”而保留 Run/Task/Loop/Timeline 等旧产品执行层，仍会把 Pi SDK 外再造一套 Agent Loop。
