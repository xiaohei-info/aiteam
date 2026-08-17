---
created: 2026-08-17
status: draft-for-review
canonical: false
source_spec: docs/superpowers/specs/2026-08-17-pi-coding-agent-sdk-agent架构重构设计.md
scope: agent-rebuild
---

# AI Team 基于 pi-coding-agent 的代码迁移与删除计划

> 本计划是 `docs/superpowers/specs/2026-08-17-pi-coding-agent-sdk-agent架构重构设计.md` 的实施配套，不新增架构裁决。
> 目标是把当前 Python Agent/Gateway 代码迁移为 Node/TypeScript + 进程内 Pi SDK，并删除旧执行模型。
> 本计划只描述迁移顺序、文件边界、接口和验收；若与 spec 冲突，以 spec 为准。

## 1. 当前基线

### 1.1 实现事实

当前仓库尚未在 `server` 或 `web` 中接入 `pi-coding-agent` SDK：

- `server/agent_service/` 仍为 Python/FastAPI，约 12,320 行；
- `server/agent_gateway/` 仍为多 runtime Gateway，约 3,479 行、25 个 Python 文件；
- `web/agent/` 仍以 Run/Task/Loop/Timeline API 为主链，约 9,628 行 TS/TSX；
- Agent/Gateway 相关测试约 91 个文件；
- Agent 组合根 `server/agent_service/app.py:248-307` 同时装配 Mainline、Gateway、Loop、Usage、Grants、Workspace、GroupMgmt 和 Terminal；
- 当前不存在 Node Agent package、SessionHost、Pi Session index 或 Manager Hindsight HTTP client。

### 1.2 当前主链

```text
web MessageComposer
  → POST /api/agent/conversations/{id}/messages
  → POST /api/agent/conversations/{id}/runs
  → MainlineService.start_run()
  → GatewayRunner
  → Driver + Executor
  → AgentRuntimeEvent
  → event_mapper
  → BusinessTimelineEvent
  → timeline_events / SSE / WebSocket
```

计划任务也进入同一旧链：

```text
LoopScheduler
  → MainlineService.start_run()
  → Run
  → Timeline
```

群聊另有一套 `group_conversations/group_messages`，通过进程内 `_mainline_convs` 映射到 Mainline Conversation。

## 2. 最终目标结构

```text
server/operation_service/       Python/FastAPI，保留
server/manager_service/         Python/FastAPI，保留
server/agent_service/            Node.js/TypeScript，新建
  src/
    app.ts
    http/
    pi/
      session-host.ts
      resources.ts
      model-runtime.ts
      event-sse.ts
    tools/
      knowledge.ts
      memory.ts
      delegate.ts
      business.ts
    extensions/
      approval.ts
      sandbox-router.ts
    storage/
      sqlite.ts
    manager-client.ts
    schedule-service.ts

web/agent/                       React，改调本地 Node Agent API
```

Pi 原生映射：

```text
Conversation       → Pi Session
消息               → Pi message entry
用户执行           → session.prompt()
实时输出           → AgentSessionEvent → SSE 薄封装
取消               → session.abort()
steer/follow-up    → session.steer()/session.followUp()
群聊委托           → delegate_employee custom tool + 内存 child Session
技能               → Skill
业务能力           → custom tool
安全策略           → Extension
```

## 3. 文件迁移矩阵

### 3.1 直接删除的旧 Agent 执行层

| 当前路径 | 处理 | 原因 |
|---|---|---|
| `server/agent_gateway/**` | Phase 4 删除 | 多 runtime Driver/Executor/Gateway 全部由 Pi SDK 替代 |
| `server/agent_service/mainline/service.py` | 删除，业务语义迁入 TS | `start_run` 是第二执行器 |
| `server/agent_service/mainline/models.py` 中 `Run*`/`Task*` | 删除 | Pi Session/entry/event 已承担执行事实 |
| `server/agent_service/mainline/execution_orchestrator.py` | 删除 | Snapshot→RunSpec/MCP 翻译层不再存在 |
| `server/agent_service/mainline/event_mapper.py` | 删除 | 不再维护 RuntimeEvent→BusinessTimelineEvent 双翻译 |
| `server/agent_service/mainline/timeline.py` | 删除 | 不建立第二套 Timeline 事实源 |
| `server/agent_service/mainline/stream.py` | 删除或缩为 TS SSE transport | 只能做 Pi event 传输，不能维护产品事件状态 |
| `server/shared/contracts/gateway.py` | 删除 | Driver/Executor/RuntimeCapability 不再存在 |
| `server/shared/contracts/runspec.py` | 删除 | 不再接受 RunSpec/AgentRunRequest |
| `server/shared/contracts/events.py` 中旧 Runtime/Business 双层 | 删除或改为版本固定 Pi SSE schema | 不再维护两层事件模型 |
| `server/agent_service/terminal/**` | 删除或迁为 Pi custom tool | 不保留独立 Terminal 执行链 |
| `server/agent_service/capabilities/mcp_config.py` | 删除旧通用装配 | 能力改为明确 custom tools；成熟 MCP 只保留兼容适配 |
| `server/agent_service/capabilities/registry.py` | 删除旧 runtime readiness registry | Pi resource/tool 装配由 SessionHost 管理 |
| `server/agent_service/capabilities/skill_projector.py` | 迁入 TS Skill materializer | 只保留签名、hash、版本和授权校验 |

### 3.2 保留并迁移到 Node 的 Agent 业务能力

| 当前路径 | 处理 | 目标 |
|---|---|---|
| `agent_service/auth/**` | 迁移 | Node JOSE、本地 token cache、Manager login/JWKS |
| `agent_service/grants/**` | 迁移并收缩 | Agent pull authorized projection、snapshot、revocation、offline fallback |
| `agent_service/local_db.py` | 重写 | TS SQLite session index、approval、receipt、artifact metadata |
| `agent_service/workspace/**` | 拆分迁移 | 保留上传、artifact、工作台偏好和只读投影；删除招募/企业知识写路径 |
| `agent_service/usage/**` | 重写 | 从 Pi entries/stats 生成脱敏 summary outbox，不按 Run 记账 |
| `agent_service/cleanup/**` | 迁移 | Session/artifact/attachment/remote memory delete cleanup |
| `agent_service/group_mgmt/**` | 合并重写 | Conversation roster/metadata；删除第二套 group message store |
| `agent_service/loop/**` | 删除 | schedule 配置附着 Conversation，由 `schedule-service.ts` 直接调用 prompt |
| `agent_service/mainline/mentions.py` | 迁移 | `delegate_employee` 的 mention 约束和防回环 |
| `agent_service/mainline/group.py` | 拆分 | 只保留 roster/mention policy；删除 planner/subtask/aggregate |

### 3.3 Manager 侧迁移边界

| 当前路径 | 处理 | 目标 |
|---|---|---|
| `manager_service/employee_config_*` | 保留并收缩 | Employee 配置真相；删除 `runtime_binding` |
| `manager_service/snapshot_service.py` | 保留并收缩 | 生成授权后的 `EmployeeSnapshot`，不包含 runtime/CLI 语义 |
| `manager_service/routes_memory_items.py` | 删除或改 facade | 不与 Hindsight 形成第二个 memory backend |
| `manager_service/memory_items_*` | 删除 | Hindsight 是唯一长期记忆存储 |
| `manager_service/capability_catalog_*` memory policy | 收敛 | 只表达 memory policy/scope，不表达 backend 实现 |
| `manager_service/employee_bindings_*` memory setting | 收敛 | 与 memory policy 合成一个明确来源 |
| `manager_service/knowledge_intake_service.py` | 保留并收敛 | `employee_knowledge_binding` 为唯一知识授权关系 |
| `employee.knowledge_refs` | 迁移期兼容后删除 | 消除 legacy JSON refs 与关系表双真相 |
| `manager_service/routes_usage_audit_quota.py` | 修正 | tenant 从 service token claims 获取，不信任 body tenant_id |
| `manager_service/migrations/0013_run_event_usage_ledger.sql` | 新库不再创建 | 删除 run_event、逐 run usage ledger |
| `manager_service/routes_usage_audit_quota.py` run-event/ledger routes | 删除 | Manager 只接收固定脱敏 UsageSummary |
| `manager_service/routes_memory_*` | 新增/改造 | Manager→Hindsight HTTP facade，浏览器不直连 Hindsight |

### 3.4 前端迁移边界

| 当前路径 | 处理 | 目标 |
|---|---|---|
| `web/agent/src/features/chat/useChatApi.ts` | 重写 | `prompt/events/abort`，删除 messages+runs/timeline fetcher |
| `web/agent/src/features/chat/MessageComposer.tsx` | 重写 | 一次 `POST /prompt`，Idempotency-Key 由客户端生成 |
| `web/agent/src/features/chat/TimelineView.tsx` | 改为 `SessionEventView` | 直接消费 Pi SSE event schema |
| `web/agent/src/features/chat/ChatPage.tsx` | 重写装配 | 删除 RunsPanel/LoopPanel，保留会话/Session 视图 |
| `web/agent/src/features/runs/RunsPanel.tsx` | 删除 | 无 Run/Task 投影 |
| `web/agent/src/features/runs/useRunsApi.ts` | 删除 | 无 Run API |
| `web/agent/src/features/runs/LoopPanel.tsx` | 删除或改 Conversation schedule | 不操作 Loop 状态机 |
| `web/agent/src/features/runs/useLoopsApi.ts` | 删除 | 无 `/loops/*` |
| `web/shared/src/timeline-client/**` | 删除 | 不维护 numeric timeline cursor client |
| `web/shared/src/contracts/events.ts` | 重写 | 版本固定 Pi event transport types |
| `web/agent/src/features/group/**` | 重写部分 | coordinator/delegate SSE；roster 不由客户端提交配置 |
| `web/agent/src/features/office/**` | 保留视图、改数据源 | Session/event/schedule 查询，不生成 scheduled Run 状态 |
| `web/agent/src/features/terminal/**` | 删除或改 Pi tool UI | 不再调用独立 Terminal service |

## 4. API 迁移表

| 旧 API | 新 API | 处理 |
|---|---|---|
| `POST /api/agent/conversations/{id}/messages` | `POST /api/agent/conversations/{id}/prompt` | 删除旧入口，prompt 原子接收 |
| `POST /api/agent/conversations/{id}/runs` | 无 | 删除，`prompt()` 直接执行 |
| `GET /api/agent/conversations/{id}/messages` | `GET /api/agent/conversations/{id}/entries` 或 Conversation history | Pi Session entries |
| `GET /api/agent/conversations/{id}/runs` | 无 | 从 Session/events/metadata 查询 |
| `GET /api/agent/runs/{id}` | 无 | 不暴露 Run |
| `POST /api/agent/runs/{id}/cancel` | `POST /api/agent/conversations/{id}/abort` | 直接调用 `session.abort()` |
| `POST /api/agent/runs/{id}/retry` | 无 | 用户用新 Idempotency-Key 再次 prompt |
| `GET /api/agent/conversations/{id}/timeline` | `GET /api/agent/conversations/{id}/entries?after=` | Pi entry id 游标 |
| `GET /api/agent/conversations/{id}/timeline/stream` | `GET /api/agent/conversations/{id}/events?after=` | Pi events SSE |
| `WS /api/agent/ws/conversations/{id}/timeline` | 无 | 删除 WebSocket |
| `POST /api/agent/conversations/{id}/tasks` | 无 | task 是 Conversation kind/label |
| `GET/PATCH/POST /api/agent/loops/*` | `GET/PATCH /api/agent/conversations/{id}/schedule` | schedule 只是 Conversation metadata |
| `POST /api/agent/conversations/{id}/group-dispatch` | 普通 coordinator `prompt()` | `delegate_employee` 是 Session custom tool |
| `POST /api/agent/recruitments` | 无 | 招募必须回 Manager |
| `POST /api/agent/knowledge-bases*` 写接口 | 无 | 企业知识写入回 Manager |

所有新 Agent API 必须由 Node Agent 生成 OpenAPI/TypeScript types；不保留旧 API alias。

## 5. SQLite 迁移策略

### 5.1 新 Agent 最小表

```text
conversation
  id / title / kind / labels
  pi_session_id / pi_session_file
  employee_id / coordinator_employee_id / solution_ref
  schedule_json / last_read_entry_id / created_at / updated_at

idempotency_receipt
  operation / key / conversation_id / caller_id / request_fingerprint
  state / owner_instance / claimed_at / lease_expires_at
  accepted_at / completed_at / last_entry_id

approval
  id / session_id / tool_call_id / snapshot_version
  canonical_args_hmac / risk_level / status / expires_at / idempotency_key

loaded_employee_projection
employee_snapshot
attachment
artifact
usage_summary_outbox
```

### 5.2 不迁移为运行时 schema 的旧表

```text
messages
runs
tasks
timeline_events
raw_events
loops
group_messages
usage_ledger(run_id)
```

`conversations` 只迁移为 Pi Session index，不再保存消息正文或执行状态。正式用户数据存在时，提供一次性离线 importer；没有正式数据时直接使用全新 Agent 数据目录。

## 6. 实施阶段与闸门

### M0：Pi SDK Spike

产出：

- `experiments/pi-sdk-spike/pi-api-compatibility.md`；
- controlled ResourceLoader 资源拒绝证明；
- Session create/open/reopen/compaction/crash 结果；
- Pi event SSE 序列化样例；
- approval continuation、delegate child Session、sandbox、Hindsight facade 结果。

未通过的 SDK 能力不能进入生产 Agent；使用真实公开 API 替代或将相关业务后置。

### M1：Node 私聊

范围：

- `server/agent_service` Node package；
- auth/JWKS；
- Conversation → Pi Session index；
- `prompt/events/abort`；
- controlled ResourceLoader；
- 一个员工、一个 provider、无群聊/计划/长期 memory；
- 前端真实 streaming。

闸门：

- 不依赖 Python Agent/Gateway；
- 不写 Message/Run/Timeline 双份事实；
- prompt crash 后不自动重复；
- SSE 断线可按 Pi entry 恢复；
- OpenAPI 和前端类型生成通过。

### M2：授权能力与安全

范围：

- grants/snapshot/revocation；
- Skills materialize；
- Manager knowledge artifact + `knowledge_search/get`；
- Manager Hindsight HTTP `recall/retain/list/delete/disable`；
- approval；
- provider credential broker；
- coding sandbox。

闸门：

- 401/403/revoked 不回退旧快照；
- memory 不可用只降级为 Pi Session；
- 普通会话不上传 Manager；
- Hindsight 只接受明确授权且脱敏的 memory 数据；
- coding tool 无 sandbox 时 fail-closed。

### M3：群聊、计划、Office

范围：

- coordinator Session + `delegate_employee`；
- 内存 child Session；
- Conversation schedule + deterministic occurrence key；
- Office/任务视图改为 Session/event 查询；
- 删除 GroupMgmt 双消息存储和旧 planner 状态机。

闸门：

- child 不持久化；
- parent abort 可取消 child；
- occurrence 不重复 prompt；
- 不产生 Run/Task/Timeline 表写入。

### M4：破坏性切换

1. web/agent 全量切新 Node API；
2. 停止旧 Python Agent Service；
3. 删除 `server/agent_gateway/**` 和旧 Python Agent；
4. 删除旧 migrations/tests/前端旧 API client；
5. 删除 `AGENT_RUNTIME`、`runtime_binding`、RunSpec/Driver/Executor 契约；
6. 更新部署、CI、SOP 和正式 v1 `00–11` 文档；
7. 独立 reviewer 通过后才关闭旧代码路径。

## 7. 验收清单

### Pi 原生主链

- Conversation 创建并绑定 Pi Session；
- 普通 prompt 产生 Pi user/assistant entries；
- `message_update`/`message_end`/tool events 原样薄封装到 SSE；
- `agent_settled` 或固定版本对应的真实收尾事件正确释放 Session；
- `abort`、重开、compaction、provider error 可恢复；
- 不存在 Run/Task/Loop/Timeline 写入。

### 业务边界

- Manager 招募和授权后 Agent 才能看到员工；
- Agent 无法创建企业员工或企业知识库；
- snapshot 只读、版本固定、撤权正确；
- group roster 不由客户端提交权限配置；
- Hindsight 只经 Manager HTTP facade；
- usage tenant 从 service identity 得到；
- Operator/Manager 不接收 Session JSONL、普通 prompt、工具正文。

### 删除完成

```bash
rg -n 'RunSpec|AgentRunRequest|AgentRuntimeEvent|BusinessTimelineEvent|runtime_binding|AGENT_RUNTIME|/runs|/tasks|/loops|timeline_events|raw_events' server web
```

最终结果应只剩：

- 必要的历史迁移/importer 说明；
- Manager/Operator 治理摘要字段中的 prompt_count/session 统计语义；
- 测试 fixture 中明确标记的旧数据转换代码；
- 不再存在可运行的旧 Agent/Gateway 执行路径。
