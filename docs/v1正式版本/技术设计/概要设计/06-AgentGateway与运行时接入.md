---
created: 2026-06-15
updated: 2026-08-25
status: frozen-baseline-amended
canonical: true
part_of: v1 概要设计（拆分集）
tags: [project, aiteam, technical-design, pi-coding-agent, agent-session, solution, group-chat]
---

# AI Team v1 概要设计 · Pi Agent Session 与解决方案协作

> **本篇正式修订**：2026-08-25 Pi-native 补充裁决已并入本篇。历史版本中的多 runtime Gateway、Executor、Driver、RunSpec 和临时 child Run 仅作为设计演进 provenance，不再是 v1 Agent 的生产执行链。配套 provenance 见 [`docs/superpowers/specs/2026-08-25-pi-solution-group-chat-addendum.md`](../../../superpowers/specs/2026-08-25-pi-solution-group-chat-addendum.md)。
>
> **当前落点**：`server/agent_service`（Node.js/TypeScript + 进程内 Pi SDK）、`web/agent`；Operator/Manager 仍为 Python/FastAPI。用户端不再部署独立 `server/agent_gateway`，不接入多 runtime。
>
> **关联裁决**：D5（员工快照）、D7（本地执行）、D16（Pi Session/Skill/Tool 能力适配）、D17（Hindsight 记忆）、D18（Provider）、D19（Conversation 与多 Agent 协作）。

## 7. Pi Agent Session 宿主设计

### 7.1 唯一运行时

AI Team Agent 的唯一执行内核是固定版本的 `@earendil-works/pi-coding-agent` SDK。Agent Service 在同一 Node.js 进程内装配 Pi：

```text
Agent HTTP/SSE
  -> SessionHost
      -> controlled ResourceLoader
      -> ModelRuntime / authorized provider config
      -> AgentSession / SessionManager
      -> product-owned custom tools and inline extensions
```

不再存在以下生产路径：

- `Agent Gateway -> Executor -> Driver -> RunSpec`；
- Hermes/Codex/Claude/OpenCode/OpenClaw 多 runtime adapter；
- Python↔Node sidecar/RPC；
- Agent Service 自建 Run/Task/Loop/DAG 执行状态机；
- 旧 `app/`、`HERMES_WEBUI_*` 或 WebUI loopback。

Operator/Manager 不执行 Pi。Manager 只持配置、授权、快照和企业管理面；Agent 本地持 Pi Session 内容事实源。

### 7.2 数字员工与 EmployeeExecutionSnapshot

数字员工不是 runtime 进程，而是一份 Manager 授权并由 Agent 冻结的 Pi 会话配置：

```text
EmployeeExecutionSnapshot
  employee_id / version / snapshot_version / display_name
  persona
  model_policy(provider_ref/model/thinking/pricing version)
  tools / signed skill refs
  employee knowledge bindings / connector refs
  memory policy / workspace and approval policy
```

一次 Pi prompt 使用一个固定 snapshot。snapshot 不含 runtime brand、CLI 参数、任意 custom args、secret 或 tenant 外部存储路径；Provider secret 仅在本地进程内按本次 Session 作用域注入。

### 7.3 受控 ResourceLoader 与安全边界

每个 Agent Session 显式使用：

- 产品专属 `agentDir`、Session 根目录和 workspace；
- `SettingsManager.inMemory()`；
- 禁止 ambient `~/.pi`、项目 `.pi`、未审核 package/extension/context 自动发现；
- 仅加载 Manager 授权、签名、固定 hash/version 的 Skill；
- 平台内置工具/Extension 默认随 Agent 产物提供；业务能力仍按 Manager 快照和本地会话权限生效；
- Hindsight、Manager RAG、审批和 sandbox 为产品自有受控扩展/工具；默认 Memory 使用 employee-private scope，默认 RAG 使用当前 tenant 唯一企业知识空间。

Pi Project Trust、tool allowlist 和 prompt 不是 sandbox。coding tools 必须全部经过 Agent 的外部非特权 sandbox boundary；sandbox 不可用时 fail-closed。

### 7.4 Conversation 与 Pi Session

Conversation 直接映射 Pi Session 内容事实：

```text
private Conversation
  -> 1 个固定 participant employee Pi Session JSONL
  -> permission_mode: read-only | workspace-write | full-access

group Conversation
  -> N 个固定 participant employee Pi Session JSONL
  -> one shared permission_mode for all participant Sessions
```

Agent SQLite 只保存 Conversation 索引、participant Session 索引、授权 snapshot、approval、附件/制品、schedule、幂等收据、消息来源索引和治理 outbox；不复制 Message/Run/Task/Timeline 正文。

创建新的 Conversation 才创建新的 Pi Session 文件。一个群聊 Conversation 创建时，为当前授权 solution roster 创建一组 participant Session；同一群聊后续消息始终复用同一组 Session。群聊不创建临时 `SessionManager.inMemory()` child 作为生产主链。

### 7.5 Pi 原生能力适配（替代历史 RunSpec/MCP/Driver）

**D16 修订**：业务层不再生成 `RunSpec`，也不把所有能力强制打包为 `mcp_config`。业务层提供 snapshot 和受控资源，SessionHost 直接组装 Pi Session：

```text
EmployeeSnapshot
  -> controlled ResourceLoader + selected Skill
  -> authorized custom tools / approved Extensions
  -> ModelRuntime + provider/model
  -> createAgentSession()
  -> session.prompt()
```

能力映射：

| 业务能力 | Pi 原生接入 |
|---|---|
| persona/协作说明 | Session system prompt/context 注入 |
| 专业流程 | Pi Skill（固定版本、签名/hash 校验） |
| 知识 | Agent custom tool → Manager RAG facade/受控 RAG MCP |
| 长期记忆 | 受控 Hindsight Extension/Manager lease |
| 连接器 | snapshot 授权的 custom tool/approved MCP adapter |
| 人工审批 | `tool_call` gate + ApprovalRecord |
| 文件/bash/edit | Pi built-in tools，经外部 sandbox operations 路由 |
| Agent 协作 | `mention_employee` custom tool + 固定 peer Session |

Pi Extension 只提供机制，不取得业务授权；默认平台能力不绕过 Manager 的撤销/收紧结果，connector 等带凭据能力仍必须经过 Manager grant。文件类工具另外受 Conversation 的 `permission_mode` 约束，默认 `read-only`，可显式升为 `workspace-write` 或 `full-access`。

### 7.6 私聊、本地群聊与统一消息投递

私聊和群聊共用：

```text
POST /api/agent/conversations/{id}/prompt
GET  /api/agent/conversations/{id}/events
GET  /api/agent/conversations/{id}/entries
POST /api/agent/conversations/{id}/abort
```

群聊通过同一个 `GroupMessageDeliveryService` 处理用户消息和 Agent 消息：

```text
GroupMessageCommand
  conversation_id
  source: human | employee
  target_employee_ids[]
  text/images
  logical_message_id/idempotency_key
```

路由规则是普通群聊语义：

- 无 `@`：直接投递 coordinator participant Session；
- `@` 一个成员：直接投递该成员在当前群聊的固定 Session，不经 coordinator 转发；
- `@` 多个成员：并行投递多个固定 Session；
- 非 roster、撤权、方案 projection 缺失或非 `applied`：fail-closed；
- coordinator 可调用 `mention_employee(employee_id, message, context)` 咨询固定 peer Session；
- 普通 employee 首期不启用该工具，避免递归协作；
- Agent 回复正文里的 `@` 不自动触发，只有正式 custom tool 调用触发。

用户 HTTP prompt 与 coordinator custom tool 使用相同 delivery seam，只是用户入口返回 `202` 并由 SSE 接收结果，Pi tool 入口等待目标 Session 的结果后作为 tool result 返回协调者。

### 7.7 方案模板、应用与群聊

Operator 的行业方案模板只描述固定版本团队蓝图：

```text
SolutionTemplate
  solution_id/version/display_name/description/tags
  ordered expert template refs
  coordinator template ref
  optional coordinator instructions
  optional workflow skill/output requirements
```

不包含租户知识 ID、普通专家 Skill、成员/部门 grants 或 planner/subtask/aggregate prompt。

Manager 应用方案：

1. 拉取并校验固定版本专家模板；
2. 在 tenant 创建 employee 实例；
3. 映射 `coordinator_template_id -> coordinator_employee_id`；
4. 接受企业管理员选择的 member/department grants；
5. 通过 tenant-scoped employee knowledge bindings 管理企业知识；
6. 创建 `solution_instance` 与 solution grant；
7. Agent sync 当前成员可见的 solution projection 和 employee snapshots。

Agent 创建方案群聊时只提交 `solution_instance_id`。Agent 根据本地授权 projection 固定 coordinator 与 participant roster，并创建一组 Pi Session 文件；浏览器不得提交 coordinator、roster、knowledge 或 tool policy。

### 7.8 审批、幂等与取消

- 同一 participant Session 单写者；
- 用户 root prompt 的幂等收据绑定 Conversation、caller、fingerprint 和目标集合；
- 多目标执行任一结果不确定时不自动重放；
- `abort` 取消本次涉及的全部 participant Session；
- 工具副作用仍由 `tool_call` gate、规范化参数 hash、ApprovalRecord 和下游幂等键控制；
- `mention_employee` 受 roster、snapshot、并发、调用次数、输出预算和 parent abort 约束；
- child Session 不作为群聊持久历史，peer Session 的真实回复保存在目标员工固定 Pi Session 中。

### 7.9 历史内容说明

此前本篇的 ACP/JSON-RPC/JSONL CLI Executor、Driver、RunSpec、MCP 全量适配和多 runtime Worker 章节属于早期 v1 Gateway baseline，保留在 Git 历史及 2026-08-17 提案中作为 provenance；它们不再是当前 canonical 生产实现。当前实现以本篇 §7.1–§7.8 和 2026-08-25 补充裁决为准。
