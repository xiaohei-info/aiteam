---
created: 2026-08-25
status: active-implementation-addendum
canonical: false
supersedes: docs/superpowers/specs/2026-08-17-pi-coding-agent-sdk-agent架构重构设计.md §10 群聊中由 coordinator 转发用户 @ 的临时方案
---

# Pi 原生行业解决方案与多 Session 群聊补充裁决

## 1. 核心裁决

行业解决方案是固定版本的专家团队蓝图，不是第二套专家能力配置：

```text
SolutionTemplate
  ordered expert template refs
  coordinator template ref
  optional coordinator instructions
  optional workflow skill ref / output requirements
```

Operator 方案模板不再定义：

- tenant knowledge id / `knowledge_refs`；
- 普通专家裸 `skill_refs`；
- `planner_prompt/subtask_prompt/aggregate_prompt`；
- tenant member/department `default_grants`。

专家自身的 persona、模型、工具、Skill、知识绑定、记忆策略和连接器授权属于 Employee/EmployeeSnapshot。企业成员授权与租户知识绑定由 Manager 在应用方案时完成。

## 2. Manager 应用方案

Manager 从 Operator 拉取固定版本方案包：

1. 校验所有专家模板可用；
2. 展开为 tenant employee 实例；
3. 将 `coordinator_template_id` 映射为真实 `coordinator_employee_id`；
4. 接受本企业管理员选择的 member/department grants；
5. 通过现有 tenant-scoped employee knowledge binding 绑定知识；
6. 创建 `solution_instance` 和 solution grant；
7. Agent 只得到当前成员可见的只读 solution projection。

`SolutionInstance` 至少包含：

```text
id / source_solution_id / source_solution_version
ordered_employee_ids / coordinator_employee_id
coordinator_instructions / workflow_skill_ref / output_requirements
status / config_version
```

知识、普通技能、模型和工具不复制到 solution instance 作为第二真相。

## 3. 群聊是一个 Conversation 的多 participant Pi Sessions

单聊与群聊共享 Conversation、Pi entry、SSE、entries、abort、幂等和前端 Composer：

```text
private Conversation
  → 1 fixed participant employee Pi Session

group Conversation
  → N fixed participant employee Pi Sessions
```

创建新的群聊 Conversation 时，为当前 roster 创建一组新的持久 Pi Session 文件；同一群聊 Conversation 后续消息始终复用同一组 participant sessions。临时 `SessionManager.inMemory()` child session 不作为群聊主链。

本地元数据使用 `conversation_participant_session(conversation_id, employee_id, role, session_file, workspace, pi_session_id, employee_version)`。正文事实仍由各 participant Pi Session JSONL 承担。

## 4. 统一群聊消息投递

用户 @ 和 Agent 协作 @ 使用同一进程内 `GroupMessageDeliveryService`，不让 Node Agent 通过 CLI/HTTP 回调自身：

```text
GroupMessageCommand
  conversation_id
  source: human | employee
  target_employee_ids[]
  text / images
  logical_message_id / idempotency_key
```

入口：

- 浏览器 `POST /api/agent/conversations/{id}/prompt`；
- coordinator Pi custom tool `mention_employee`；
- legacy `delegate_employee` 仅作短期快照兼容别名。

两者都通过同一 delivery service 找到当前 Conversation 的固定 participant Session 并调用 `session.prompt()`。目标 session 仍按 tenant/member/solution roster/snapshot 重新授权。

## 5. 常规群聊 @ 语义

- 无 `@`：直接投递 coordinator participant Session；
- `@one`：直接投递被提及 participant Session，不经 coordinator 转发；
- `@many`：直接并行投递多个被提及 participant Sessions；
- 非 roster、撤权、未授权目标：fail-closed；
- coordinator 可调用 `mention_employee` 咨询固定 peer Session；
- 普通 employee 首期不启用该工具，避免递归协作；
- Agent 回复正文中的 `@` 不自动触发，只有正式 Pi tool call 触发；
- 每个 participant Session 单写者；root prompt 的幂等收据覆盖全部目标；任一目标结果不确定则整体不自动重放。

被 @ 的 Agent 看到的提示需要携带群聊来源元数据（human 或 employee），但消息投递/Session prompt 机制相同。来源不由模型或浏览器任意填写。

## 6. 历史与事件

一个群聊 SSE 聚合当前 Conversation 的全部 participant Session subscriptions：

```text
GET /api/agent/conversations/{id}/events
GET /api/agent/conversations/{id}/entries
```

SSE/entries 为每条事件附加 `source_employee_id/source_employee_display_name/source_role`。用户输入来源通过 `conversation_entry_source` 索引与 `logical_message_id` 保存，避免刷新后把 human/employee source 误标成目标 employee；正文仍只从 Pi Session 读取。

多个 Session 的 entries 以时间和稳定 entry id 合并；底层 `mention_employee` tool call/result 可在产品 Timeline 中折叠，避免和被提及 Agent 的业务消息重复展示。

## 7. 前端

`MessageComposer`、`ConversationList`、`TimelineView`、SSE/entries、附件、abort、schedule、history 由私聊和群聊共用。群聊只额外提供 solution-scoped mention roster 和 `kind=group` 过滤。

创建方案群聊只提交：

```json
{"kind":"group","solution_instance_id":"..."}
```

浏览器不提交 coordinator/roster；Agent 根据已授权 solution projection 固化 participant set。群聊“新建对话”创建新 Conversation 和新的 participant session 集合；历史按 solution instance 聚合展示。

## 8. Pi Extension / Tool 边界

- `mention_employee` 是 AI Team 自有 Pi custom tool，不是第三方通用 Extension；
- 用户 @ 是 Agent Service 路由，不经过模型；
- 若需给 participant 注入群聊来源/有界共享上下文，可使用 product-owned inline Extension 的 `before_agent_start/context`，但该 Extension 不是通信总线；
- Hindsight、RAG、审批和 sandbox Extension 不承担群聊消息路由；
- CLI 只可作为后置测试/运维入口，不是生产 Agent 协作主路径。

## 9. 当前实现状态

已实现基础切片：

- Operator 简化方案模板并移除旧配置 UI/API；
- Manager coordinator metadata、固定方案 projection、应用授权选择；
- Agent fixed participant session index；
- human/employee unified delivery；
- direct no-mention/coordinator、single/multi mention routing；
- coordinator `mention_employee` fixed-peer Session；
- shared Agent composer/group creation/history UI；
- applied status gating、solution version pinning、entry source metadata。

仍需继续：

- 多 Session history 的稳定 logical-message 去重/顺序索引完善；
- 方案专家模板固定版本引用（不依赖 apply 时 latest）；
- Manager 应用阶段的 tenant knowledge binding UI/事务补偿；
- product-owned bounded group context/roster manifest；
- 三端真实 E2E（Operator publish → Manager apply/authorize → Agent sync → group create → no @/single @/multi @/Agent mention/history/restart/abort/revoke）；
- 将本补充裁决评审通过后再原子更新 canonical v1 F07/D16/D19。
