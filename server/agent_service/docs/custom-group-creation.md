# 自选成员创建群聊接口

日期：2026-09-11。实现范围为用户端 Agent；群简介、编排提示词、成员与会话内容仅在本地持久化。

## 接口与兼容性

新增 `POST /api/agent/conversations/custom-group`，自动与自定义编排均使用此接口。需要现有 Agent 登录认证；所有者由认证上下文决定。客户端可读取 `/openapi.json`，以该路径存在 POST 操作为能力判断。

现有 `POST /api/agent/conversations` 保留原创建行为，不接受 `description`、`member_employee_ids`、`orchestration` 三个新字段。已有自由群与方案群继续使用原执行逻辑。

创建仅保存配置并初始化固定成员 Session，不调用模型。用户发送任务后，沿用现有 Pi Session、`mention_employee`、工具权限和工作记录执行链。

## 请求

自动编排示例：

```json
{
  "id": "group-client-generated-uuid",
  "title": "AI 课程协作群",
  "description": "整理课程技术亮点，形成客户价值主张和交付方案。",
  "member_employee_ids": ["emp_sales", "emp_tech", "emp_pm"],
  "coordinator_employee_id": "emp_sales",
  "orchestration": { "mode": "auto" }
}
```

自定义编排示例：

```json
{
  "id": "group-client-generated-uuid-2",
  "title": "课程销售协作群",
  "description": "销售与交付团队的协作空间。",
  "member_employee_ids": ["emp_sales", "emp_tech", "emp_pm"],
  "coordinator_employee_id": "emp_sales",
  "orchestration": {
    "mode": "custom",
    "format": "collaboration-markdown-v1",
    "prompt": "协作目标：形成课程销售方案。\n执行规则：依次推进，使用前一步实际结果；缺少必要信息时向用户提问。\n协作流程：\n1. @{emp_tech} → @{emp_sales}：技术专家整理技术亮点，销售顾问转化为客户价值。\n2. @{emp_sales} → @{emp_pm}：销售顾问提供客户预算，项目经理评估排期与资源。\n3. @{emp_pm} → @{emp_sales}：反馈交付约束，销售顾问调整承诺。\n最终交付：由协调人汇总方案和待确认事项。"
  }
}
```

示例员工 ID 需替换为当前用户已授权、具有有效快照的实际员工 ID。

| 字段 | 约束 |
| --- | --- |
| `id` | 可选，1–256 字符；建议客户端为同一次创建意图生成固定 ID |
| `title` | 必填，1–200 字符，去除首尾空白后不能空 |
| `description` | 可选或 null，最多 4,000 字符；自动模式下去除空白后必填 |
| `member_employee_ids` | 必填，1–32 个不同的授权员工 ID；单个 ID 最多 256 字符，不含空白或花括号 |
| `coordinator_employee_id` | 必填，必须是所选成员之一 |
| `orchestration` | 必填，严格按 `mode` 区分，拒绝未知属性 |
| `permission_mode` | 可选，沿用既有枚举，默认 `read-only`；编排不提升工具权限 |

`auto` 仅接受 `mode`。`custom` 必须指定 `format: collaboration-markdown-v1` 和非空 `prompt`，提示词最多 16,000 字符，保存时去除首尾空白。长度校验作用于请求原文，客户端应提交已 trim 的内容。新接口不接受 `kind`、`solution_instance_id` 或客户端所有者字段，服务端固定创建 `group`。

员工引用格式为 `@{employee_id}`，必须属于本次所选成员。显示姓名由前端映射，不作为身份主键；“我”不由后端猜测为某个员工。章节和编号是模型可理解的协作规则，不编译为确定性任务图。

## 响应与读取

成功返回 `201`，结构为 `{ "data": ConversationMetadata }`。除既有元数据字段外，返回：

```json
{
  "description": "群用途说明",
  "orchestration": { "mode": "auto" }
}
```

上面仅展示新增字段，并非完整响应。群成员以 `GET /api/agent/conversations/:id/participants` 为准；详情与列表返回相同的简介和编排配置。刷新和进程重启不改变名单，新增员工授权不会自动加入已有群。

本期普通会话 PATCH 拒绝修改成员、协调人和编排等新群配置，也不允许将此类群改成私聊；名称和既有允许修改的元数据沿用原契约。

## 创建一致性与错误

完成结构、业务规则、所有者和员工授权检查后，在同一 SQLite 事务中写入会话及 `conversation_participant_session`。随后初始化所选成员 Session；失败时清理本次创建的会话、参与者和 Session 资源。事务不跨异步初始化。

错误沿用 `application/problem+json`：

| HTTP | code | 条件 |
| --- | --- | --- |
| 422 | `invalid_group_configuration` | schema 不匹配，包括未知字段、长度超限、重复成员、缺少字段或混用旧字段；标题全空白等业务错误 |
| 422 | `invalid_group_members` | schema 通过后发现成员 ID 为空白或包含非法引用字符 |
| 422 | `invalid_group_coordinator` | 协调人不属于所选成员 |
| 422 | `invalid_group_orchestration` | 自动模式简介为空、自定义提示词全空白等业务约束失败 |
| 422 | `invalid_orchestration_reference` | 提示词引用群外员工或引用格式不完整 |
| 403 | `employee_not_authorized` | 所选员工未授权、已撤销或快照不可用 |
| 409 | `conversation_exists` | 同一所有者下创建 ID 已存在 |
| 404 | `conversation_not_found` | 创建 ID 属于其他所有者，不泄露其配置 |

服务端全局 Fastify schema validator 当前关闭，因此本接口在 handler 内显式执行 TypeBox `Check`，不能仅依赖 OpenAPI 声明。

请求超时、断网或收到 409 时，客户端先读取同 ID 的元数据和成员。只有名称、简介、编排、协调人、工具权限及成员集合全部一致才恢复进入群；不一致应提示冲突，不能覆盖或自动创建第二个群。若未创建成功，可重用同一 ID 重试。这不是 prompt 的 `Idempotency-Key` 契约。

## 执行语义

- 自动模式：协调人读取群简介、固定成员 ID、员工简介与能力，为当前任务规划分工。
- 自定义模式：协调人读取完整自定义提示词和固定成员信息；群简介仅保存展示，不再注入为第二份编排规则。
- 协调人接收真实工具结果后再向下一个成员传递输入；自身工作直接完成，不调用自身。自定义模式的员工分派工具声明为串行，但自然语言协作规则仍不构成严格工作流保证。
- 普通成员只执行当前被分配的任务，不重新启动整个群流程。员工被撤销或群成员索引缺失时拒绝越界执行，不回退到全部授权员工。
- 必需编排和成员上下文保留完整，预算 64,000 字符；可选近期历史单独裁剪。必需上下文超限则报错，不带截断规则启动任务。
- `work_id`、思考/工具历史及 `todo_update` 契约不变；协调人通过更新同一份任务清单反映进度，前端沿用单卡片和可展开执行记录。

## 实现与验证

主要文件：`src/http/custom-group-schemas.ts`、`src/http/server.ts`、`src/groups/orchestration.ts`、`src/storage/sqlite.ts`、`src/pi/session-host.ts`、`src/tools/delegate.ts`、`src/main.ts`。

SQLite 新增 `description` 和 `orchestration_json` 两列，仅升级当前 Agent 本地库，不迁移冻结 MVP 数据。旧群的编排字段为空，维持既有行为。

- TypeScript 类型检查通过。
- 自定义创建、会话读取、工作记录、SessionHost、SSE 与 SQLite 相关回归 67 项通过。
- 最终自定义创建、HTTP/OpenAPI、边界和 SessionHost 检查 39 项通过。
- 新测试使用临时 SQLite 和模拟模型，覆盖固定成员、配置回读/重启、非法字段和引用、租户/用户隔离、重复 ID、失败清理、完整长提示词、实际员工工具分派及结果返回。

发布时先升级 Agent，再发布客户端。此变更未部署线上服务，也未调用真实模型；桌面端视觉验收尚待完成。
