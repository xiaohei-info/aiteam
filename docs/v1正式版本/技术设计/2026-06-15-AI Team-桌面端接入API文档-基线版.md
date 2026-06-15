# AI Team 桌面端接入 API 文档（基线版）

> 面向桌面端客户端开发。
> 本文档只覆盖 **AI Team 当前前端已实现、已对接** 的北向 API。
> 不覆盖仓库内其他 WebUI 历史 `/api/*` 路由。
> 当前 `/api/docs` / `/api/openapi.json` 仅是路径索引，不是完整契约；桌面端接入以本文档为准。

## 1. 文档范围

- 覆盖范围：`/api/team/*`、`/api/enterprise-admin/*`、`/api/system-admin/*`、认证登录链路相关 `/api/auth/*`
- 证据来源：
  - 前端 API client：`app/static/aiteam/api-client.js`
  - 前端页面真实调用：`app/static/aiteam/pages/*.js`
  - L2/L4 契约测试：`app/tests/aiteam/layer2_team_panel/*`、`app/tests/aiteam/layer4_frontend_bff/*`
- 交付定位：**桌面端接入基线版**
  - 已尽量补齐当前真实请求方式、query/body、返回结构
  - 对少数“前端已调用但测试未锁全字段”的接口，本文档会标记为“字段以当前页面依赖为准”

## 2. 通用接入约定

### 2.1 返回风格

- 大多数 JSON 接口返回 HTTP 状态码 + JSON body
- 错误通常包含：
  - `error: "ERROR_CODE"`
  - 或 `error: { code, message, retryable }`
- 列表接口常见分页字段：
  - `items`
  - `page`
  - `page_size`
  - `total`
  - `has_more`

### 2.2 角色与权限

- 企业侧角色：`owner | enterprise_admin | finance_admin | member`
- 系统侧角色：`system_admin | system_operator`
- `system-admin` 路由当前前端会自动附加 `?role=system_admin` 或 `?role=system_operator`
- 桌面端请求系统后台接口时，必须显式带 `role` query 参数

### 2.3 Run / Timeline / SSE

- SSE 流接口：
  - `GET /api/team/runs/{run_id}/stream?cursor={n}`
- Content-Type：
  - `text/event-stream`
- 事件名固定：
  - `event: timeline`
- SSE `data:` 负载为 `RunTimelineEvent` JSON，至少包含：
  - `event_id`
  - `event_cursor`
  - `run_id`
  - `event_type`
  - `source_type`
  - `source_id`
  - `event_ts`
- 游标规则：
  - 使用 numeric cursor
  - 重连时带上最近已消费的 `cursor`

### 2.4 上传与附件

- 文件上传不是 multipart；当前 Team 前端走 JSON 元数据上传：
  - `name`
  - `size`
  - `mime_type`
  - 可选 `content_text`
- 成功后返回：
  - `asset_id`
  - `storage_key`
  - `preview_url`
- 聊天/群聊消息中的附件引用当前依赖：
  - `asset_id`
  - `preview_url`

---

## 3. 接口矩阵

下表按“当前桌面端最可能接入”的业务模块组织。

### 3.1 认证与入驻

| 接口 | 方法 | 说明 | 关键请求参数 | 关键响应字段 |
|---|---|---|---|---|
| `/api/auth/login` | `POST` | 密码登录 | body: `{ password }` | 成功后客户端跳转；历史页面依赖 `ok/error` |
| `/api/auth/status` | `GET` | 登录方式状态 | 无 | `passkeys_enabled` |
| `/api/auth/passkey/options` | `POST` | Passkey 登录 options | 空 body | `publicKey` |
| `/api/auth/passkey/login` | `POST` | Passkey 登录提交 | WebAuthn credential payload | 登录成功后跳转 |
| `/api/auth/login/wechat/init` | `POST` | 微信登录初始化 | 空 body | `state`, `qr_url`, `expires_in` |
| `/api/auth/login/wechat/poll?state=...` | `GET` | 微信登录轮询 | `state` | `status: pending/scanned/confirmed/expired`，确认时带 `code` |
| `/api/auth/login/wechat/callback` | `POST` | 微信登录回调提交 | body: `{ state, code }` | 登录完成 payload |
| `/api/auth/login/phone/send-code` | `POST` | 手机验证码下发 | body: `{ phone }` | `expires_in` |
| `/api/auth/login/phone/verify` | `POST` | 手机验证码登录 | body: `{ phone, code }` | `access_token`, `expires_in` |
| `/api/me` | `GET` | 当前登录用户/企业上下文 | Header: `Authorization: Bearer ...` 可选 | `current_enterprise`, 可选 `onboarding` |
| `/api/enterprises/current` | `GET` | 当前企业上下文 | Header: `Authorization` | `enterprise_id` |
| `/api/auth/onboarding/create-enterprise` | `POST` | 创建企业并入驻 | body: `{ name, slug? }` | `enterprise_id`, `name`, `slug`, `role=owner` |
| `/api/auth/onboarding/join-enterprise` | `POST` | 加入企业 | body: `{ invite_code }` | `enterprise_id`, `name`, `role` |

### 3.2 工作台 / 私聊 / Run / Timeline

| 接口 | 方法 | 说明 | 关键请求参数 | 关键响应字段 |
|---|---|---|---|---|
| `/api/team/workbench` | `GET` | 工作台首页聚合数据 | 无 | `enterprise`, `employees`, `my_team`, `conversations`, `navigation`, `task_status_digest`, `permissions`, `empty_state` |
| `/api/team/workbench/state` | `POST` | 工作台状态更新 | body: `{ conversation_id, mark_read }` 等 | 页面当前仅依赖成功/失败 |
| `/api/team/conversations/{conversation_id}` | `GET` | 私聊详情 | path: `conversation_id` | `conversation_id`, `conversation_type`, `status`, `created_at`, `messages`, `employee_summary` |
| `/api/team/employees/{employee_id}/conversations` | `GET` | 员工关联私聊列表 | path: `employee_id` | 当前聊天页依赖列表结果 |
| `/api/team/runs` | `POST` | 发起一次私聊运行 | body 见 4.3 | `run_id`, `status`, `conversation_id`, `stream_url`, `events_url`, `runtime_handle` |
| `/api/team/runs/{run_id}/retry` | `POST` | 重试 run | path: `run_id`; body 可带 `idempotency_key` | `run_id`, `retry_of_run_id`, `conversation_id`, `runtime_handle` |
| `/api/team/runs/{run_id}/abort` | `POST` | 中断 run | path: `run_id`; body 可带 `reason` | `run_id`, `status=cancelled`, `aborted`, `event_cursor` |
| `/api/team/runs/{run_id}/stream?cursor={n}` | `GET` | SSE timeline 流 | path: `run_id`; query: `cursor` | `event: timeline`，`RunTimelineEvent` |
| `/api/team/runs/{run_id}/events?cursor={n}&limit={n}` | `GET` | timeline 分页拉取 | path: `run_id`; query: `cursor`, `limit` | `items`, `next_cursor`, `has_more`, `run_status` |
| `/api/team/uploads` | `POST` | 上传附件元数据/内容 | body: `{ name, size?, mime_type?, content_text? }` | `asset_id`, `name`, `size`, `mime_type`, `storage_key`, `preview_url` |

### 3.3 群聊 / 组织 / 办公区 / 知识库

| 接口 | 方法 | 说明 | 关键请求参数 | 关键响应字段 |
|---|---|---|---|---|
| `/api/team/group-conversations` | `POST` | 创建群聊 | body: `{ title, member_employee_ids[], created_by? }` | `conversation_id`, `title`, `member_count`, `status`, `navigation` |
| `/api/team/group-conversations/{conversation_id}` | `GET` | 群聊详情 | path | `conversation_id`, `conversation_type`, `title`, `status`, `display_state`, `member_count`, `members`, `latest_run`, `timeline`, `task_tree` |
| `/api/team/group-conversations/{conversation_id}/members` | `POST` | 新增群成员 | body: `{ employee_id }` | `employee_id`, `status` |
| `/api/team/group-conversations/{conversation_id}/members/{member_id}` | `DELETE` | 移除群成员 | path | 成功返回移除结果；系统主持人不可移除时返回 `409` |
| `/api/team/group-conversations/{conversation_id}` | `DELETE` | 归档群聊 | path | `conversation_id`, `status=archived` |
| `/api/team/group-conversations/{conversation_id}/messages` | `POST` | 群聊发消息 | body: 当前页面提交文本/编排消息 | 成功后客户端继续走 run/timeline |
| `/api/team/org/tree` | `GET` | 组织树 | 无 | `enterprise`, `departments`, `unassigned_members`, `stats` |
| `/api/team/org/assignments/{assignment_id}` | `PATCH` | 调整组织归属 | body: `{ department_id?, position_title?, visibility_scope? }` | 更新后的 assignment |
| `/api/team/office/scene` | `GET` | 办公区场景视图 | 无 | 场景摘要、座位/员工状态、刷新游标 |
| `/api/team/office/feed` | `GET` | 办公区动态流 | 无 | `items`, `queue`, `generated_cursor`, `refresh_hint_ms` |
| `/api/team/knowledge-bases` | `GET` | 知识库列表 | 无 | `knowledge_bases` |
| `/api/team/knowledge-bases` | `POST` | 创建知识库 | body: `{ name, description? }` | `knowledge_base_id`, `name`, `description`, `status`, `document_count` |
| `/api/team/knowledge-bases/{kb_id}/search?q=...` | `GET` | 知识库问答/检索 | query: `q` | `knowledge_base_id`, `query`, `answer`, `citations`, `items` |
| `/api/team/knowledge-bases/{kb_id}/documents` | `POST` | 知识库挂载文档 | body: `{ asset_id, display_name? }` | `document_id`, `status`, `ingestion_job_id` |

### 3.4 企业管理后台

| 接口 | 方法 | 说明 | 关键请求参数 | 关键响应字段 |
|---|---|---|---|---|
| `/api/team/employees` | `GET` | 员工列表 | query: `role` 可选 | `employees`, `total`, `page`, `limit` |
| `/api/team/employees` | `POST` | 创建员工 | body: `{ display_name, role_name?, model_provider?, model_name? }` | `employee_id`, `conversation_id`, `status` |
| `/api/team/employees/{employee_id}` | `GET` | 员工详情 | path | `employee_id`, `display_name`, `role_name`, `status`, `presence`, `profile_config`, `usage_summary`, `scheduled_jobs`, `bindings_summary` |
| `/api/team/employees/{employee_id}` | `PATCH` | 更新员工 | body: 可改模型、prompt、配置等 | 更新后的 employee，常见 `reprovision_status` |
| `/api/team/employees/{employee_id}` | `DELETE` | 删除员工 | path | `status=deleted` |
| `/api/team/employees/export` | `GET` | 员工导出 | query: `role` | CSV |
| `/api/team/audit-events` | `GET` | 审计事件列表 | query: `target_type`, `target_id`, `role` 等 | `items`, `total` |
| `/api/team/talent-market/templates` | `GET` | 前台人才市场模板列表 | query: `q`, `category`, `tag`, `sort_by`, `page`, `page_size` | `items`, `page`, `page_size`, `total`, `has_more`, `sort_by`, `sort_order` |
| `/api/team/talent-market/templates/{template_id}` | `GET` | 前台模板详情 | path | `template_id`, `name`, `category`, `description`, `default_skills`, `default_memory_config`, `price_tier` |
| `/api/team/templates` | `GET` | 管理视图模板列表 alias | query: `role` | 与前台模板列表同形 |
| `/api/team/templates/{template_id}` | `GET` | 管理视图模板详情 alias | path | 与前台模板详情同形 |
| `/api/team/recruitments` | `POST` | 由模板招募员工 | body: `{ template_id, display_name?, idempotency_key? }` | `order_id`, `status`, `employee_id`, `profile_name` |
| `/api/team/skills/catalog` | `GET` | 技能市场 catalog | query: `page`, `page_size`, `q` 等 | 页面依赖 catalog 列表 |
| `/api/team/skills/installs` | `GET` | 已安装技能列表 | 无 | 安装列表 |
| `/api/team/skills/installs` | `POST` | 安装技能 | body: 依页面流程 | 安装结果 |
| `/api/team/skills/installs/{install_id}` | `PATCH` | 更新安装技能 | body | 更新结果 |
| `/api/team/skills/installs/{install_id}` | `DELETE` | 删除安装技能 | path | 删除结果 |
| `/api/team/solutions` | `GET` | 行业方案列表 | 无 | `solutions`, `total` |
| `/api/team/solutions/{solution_id}/apply` | `POST` | 应用行业方案 | body: `{ mode, department_id?, idempotency_key? }` | `apply_record_id`, `created_employee_ids`, `created_knowledge_base_ids` 等 |
| `/api/team/connectors` | `GET` | 连接器列表 | 无 | `connectors`, `definitions` |
| `/api/team/connectors` | `POST` | 创建连接器 | body: `{ name, provider_code, type?, credential_ref?, config? }` | `connector_id`, `status` |
| `/api/team/connectors/{connector_id}` | `GET` | 连接器详情 | path | `connector_id`, `credential_ref`, `credential_mask`, `credential_state`, `config`, `employee_grants` |
| `/api/team/connectors/{connector_id}` | `PATCH` | 更新连接器 | body: `name/config/credential_input` 等 | 更新后 connector |
| `/api/team/connectors/{connector_id}` | `DELETE` | 删除连接器 | path | `connector_id`, `status=archived` |
| `/api/team/connectors/{connector_id}/test` | `POST` | 测试连接器 | body 可空 | 最新测试结果 |
| `/api/team/connectors/{connector_id}/status` | `GET` | 查询连接器状态 | path | `connector_id`, `status`, `last_test_result` |
| `/api/team/connectors/{connector_id}/grants` | `PATCH` | 调整连接器授权 | body: `{ grant: [], revoke: [] }` | `granted`, `revoked`, `errors` |
| `/api/team/llm-providers` | `GET` | LLM Provider 列表 | 无 | `providers` |
| `/api/team/llm-providers` | `POST` | 创建 LLM Provider | body: `provider_key/display_name/base_url/api_key/transport` | 创建结果 |
| `/api/team/llm-providers/{provider_id}` | `PATCH` | 更新 LLM Provider | body | 更新结果 |
| `/api/team/llm-providers/{provider_id}` | `DELETE` | 删除 LLM Provider | path | 删除结果 |
| `/api/team/llm-providers/{provider_id}/models` | `POST` | 给 Provider 添加模型 | body: `model_id/label/context_length/is_default` | 添加结果 |
| `/api/team/llm-models` | `GET` | LLM 模型列表 | 无 | `models` |
| `/api/team/llm-models/{model_uid}` | `DELETE` | 删除模型 | path | 删除结果 |
| `/api/team/collaboration-template` | `GET` | 群聊编排模板读取 | 无 | `defaults`, `placeholders`, `template` |
| `/api/team/collaboration-template` | `POST` | 群聊编排模板保存 | body: `name/planner_prompt/subtask_prompt/aggregate_prompt` | 保存结果 |
| `/api/team/memories` | `GET` | 记忆列表 | query: `employee_id`, `q`, `tag`, `include=prompt_use_trace`, `trace_limit` | `items`, `page`, `page_size`, `total`, `has_more`, `sort_by`, `sort_order` |
| `/api/team/memories` | `POST` | 新建记忆 | body: `employee_id/content/category/importance/tags/visibility_scope` | 新建后的 memory |
| `/api/team/memories/{memory_id}` | `PATCH` | 更新记忆 | body: `content/importance/tags/review` | 更新后的 memory |
| `/api/team/memories/{memory_id}` | `DELETE` | 删除记忆 | path | `{ memory_id, status: "deleted" }` |
| `/api/team/memories/bulk-delete` | `POST` | 批量删记忆 | body: `{ employee_id, memory_ids[] }` | `deleted_count`, `memory_ids` |
| `/api/team/settings` | `GET` | 企业设置 | 无 | `enterprise_id`, `name`, `invite_code`, `notification_policy`, `admin_invites` |
| `/api/team/settings` | `PATCH` | 更新企业设置 | body: `name/contact_phone/notification_policy/low_balance_threshold_cents` 等 | 更新后的 settings |
| `/api/team/settings/admin-invites` | `POST` | 创建管理员邀请 | body: `phone/role/permissions/idempotency_key` | `invite_id`, `status`, `phone` |
| `/api/team/settings/admin-invites/{invite_id}` | `DELETE` | 撤销管理员邀请 | path | `invite_id`, `status=revoked` |
| `/api/team/billing/usage/overview` | `GET` | 企业用量概览 | 无 | 页面依赖概览数据 |
| `/api/team/billing/usage/records` | `GET` | 企业用量明细 | query 依页面过滤项 | 记录列表 |
| `/api/team/billing/usage/records/export` | `GET` | 企业用量导出 | query 同 records | CSV |
| `/api/team/billing/balance` | `GET` | 企业余额 | 无 | `balance`, `balance_cents`, `token_balance`, `low_balance_warning` |
| `/api/team/billing/recharges` | `GET` | 充值记录 | 无 | `items`, `total` |
| `/api/team/billing/recharges` | `POST` | 发起 mock 充值 | body: `{ amount, payment_method, idempotency_key }` | `recharge_id`, `status`, `mock_provider`, `token_credited` |

### 3.5 企业管理员 namespace

| 接口 | 方法 | 说明 | 关键请求参数 | 关键响应字段 |
|---|---|---|---|---|
| `/api/enterprise-admin/invites` | `GET` | 管理员邀请列表 | query: `role=owner` 等 | `items` |
| `/api/enterprise-admin/invites` | `POST` | 创建管理员邀请 | body: `phone/role/permissions/idempotency_key` | `invite_id`, `status`, `phone` |
| `/api/enterprise-admin/invites/{invite_id}` | `DELETE` | 撤销管理员邀请 | path | `invite_id`, `status=revoked` |

### 3.6 系统后台 namespace

| 接口 | 方法 | 说明 | 关键请求参数 | 关键响应字段 |
|---|---|---|---|---|
| `/api/system-admin/health?role=system_admin` | `GET` | 系统健康概览 | query: `role` | 健康状态数据 |
| `/api/system-admin/finance/overview?role=system_admin` | `GET` | 平台财务总览 | query: `role`, 可带周期 | `summary`, `trend`, `top_enterprises` |
| `/api/system-admin/finance/reports?role=system_admin` | `GET` | 平台财务报表导出/列表 | query: `role` | 页面当前用于导出 |
| `/api/system-admin/enterprises?role=system_admin` | `GET` | 企业账号列表 | query: `name/status/created_from/created_to/role` | 企业列表 |
| `/api/system-admin/enterprises/export?role=system_admin` | `GET` | 企业账号导出 | query: `role` | 导出结果 |
| `/api/system-admin/enterprises/{enterprise_id}?role=system_admin` | `GET` | 企业详情 | path + query: `role` | `id`, `name`, `slug`, `status` |
| `/api/system-admin/enterprises/{enterprise_id}/quota?role=system_admin` | `GET` | 企业配额详情 | path + query | 配额详情 |
| `/api/system-admin/enterprises/{enterprise_id}/actions?role=system_admin&actor_id=...` | `POST` | 系统治理动作 | body: `action`, 可带 `reason/amount/idempotency_key/message` | `enterprise_id`, `action`, `status`, `message`, `audit_event_id` |
| `/api/system-admin/templates?role=system_admin` | `GET` | 系统模板列表 | query: `role` | 模板列表 |
| `/api/system-admin/templates?role=system_admin` | `POST` | 创建系统模板 | body: `name/role_name/category_code/default_model_ref` 等 | 创建后的 template |
| `/api/system-admin/templates/{template_id}?role=system_admin` | `PATCH` | 更新/发布模板 | body 可含 `publish_action` | 更新后的 template |
| `/api/system-admin/solutions?role=system_admin` | `GET` | 系统方案列表 | query: `role` | 方案列表 |
| `/api/system-admin/solutions?role=system_admin` | `POST` | 创建系统方案 | body: `name/template_ids` 等 | 创建后的 solution |
| `/api/system-admin/solutions/{solution_id}?role=system_admin` | `PATCH` | 更新/发布方案 | body 可含 `publish_action` | 更新后的 solution |

---

## 4. 重点接口详解

### 4.1 创建企业

`POST /api/auth/onboarding/create-enterprise`

请求体：

```json
{
  "name": "Acme AI Lab",
  "slug": "acme-ai-lab"
}
```

成功响应：`201`

```json
{
  "enterprise_id": "ent_xxx",
  "name": "Acme AI Lab",
  "slug": "acme-ai-lab",
  "role": "owner"
}
```

### 4.2 加入企业

`POST /api/auth/onboarding/join-enterprise`

请求体：

```json
{
  "invite_code": "INV-ACME01"
}
```

成功响应：`200`

```json
{
  "enterprise_id": "ent_existing_acme",
  "name": "Acme AI Lab",
  "role": "member"
}
```

错误：

- `404`：邀请码不存在或失效
- `409`：已加入该企业

### 4.3 发起私聊 Run

`POST /api/team/runs`

最小请求体：

```json
{
  "employee_id": "emp_test",
  "conversation_id": "conv_test",
  "message": {
    "text": "Hello"
  },
  "idempotency_key": "run-001"
}
```

带附件示例：

```json
{
  "employee_id": "emp_test",
  "conversation_id": "conv_test",
  "message": {
    "text": "请分析附件",
    "attachments": [
      {
        "asset_id": "ast_new",
        "preview_url": "/api/team/uploads/ast_new/preview"
      }
    ]
  },
  "idempotency_key": "run-002"
}
```

成功响应：`201`

```json
{
  "run_id": "run_xxx",
  "status": "queued",
  "conversation_id": "conv_test",
  "stream_url": "/api/team/runs/run_xxx/stream?cursor=0",
  "events_url": "/api/team/runs/run_xxx/events?cursor=0",
  "runtime_handle": {
    "kind": "session",
    "profile_name": "emp_test",
    "session_id": "sess_xxx"
  }
}
```

典型错误：

```json
{
  "error": "INSUFFICIENT_BALANCE",
  "recharge_required": true
}
```

### 4.4 Run Timeline SSE

`GET /api/team/runs/{run_id}/stream?cursor={n}`

响应头：

```text
Content-Type: text/event-stream
```

事件帧：

```text
event: timeline
data: {"event_id":"evt_xxx","event_cursor":1,"run_id":"run_xxx","event_type":"run_started","source_type":"session","source_id":"sess_xxx","event_ts":"2026-06-15T12:00:00Z"}
```

客户端约定：

- 断线重连时，从最近消费到的 `event_cursor` 继续
- 只消费 `event: timeline`
- 不要依赖 runtime 内部原始事件名

### 4.5 群聊创建与成员管理

创建群聊：`POST /api/team/group-conversations`

```json
{
  "title": "预算评审群",
  "member_employee_ids": ["emp_member", "emp_planner"]
}
```

成功响应：`201`

```json
{
  "conversation_id": "group_new",
  "title": "预算评审群",
  "member_count": 2,
  "status": "active",
  "navigation": {
    "conversation": "/app/group/group_new"
  }
}
```

新增成员：`POST /api/team/group-conversations/{conversation_id}/members`

```json
{
  "employee_id": "emp_planner"
}
```

### 4.6 知识库

列表：`GET /api/team/knowledge-bases`

空态响应：

```json
{
  "knowledge_bases": []
}
```

创建：`POST /api/team/knowledge-bases`

```json
{
  "name": "新知识库",
  "description": "用于新员工资料"
}
```

成功响应：

```json
{
  "knowledge_base_id": "kb_xxx",
  "name": "新知识库",
  "description": "用于新员工资料",
  "status": "active",
  "document_count": 0
}
```

搜索：`GET /api/team/knowledge-bases/{kb_id}/search?q=入职`

成功响应：

```json
{
  "knowledge_base_id": "kb_xxx",
  "query": "入职",
  "answer": "已命中《入职手册》相关知识。",
  "citations": [
    {
      "title": "入职手册"
    }
  ],
  "items": [
    {
      "document_id": "doc_xxx"
    }
  ]
}
```

挂载文档：`POST /api/team/knowledge-bases/{kb_id}/documents`

```json
{
  "asset_id": "ast_xxx",
  "display_name": "faq.pdf"
}
```

成功响应：

```json
{
  "document_id": "doc_xxx",
  "status": "ingesting",
  "ingestion_job_id": "job_xxx"
}
```

### 4.7 企业设置与管理员邀请

`GET /api/team/settings`

关键响应：

```json
{
  "enterprise_id": "ent_test",
  "name": "Test Corp",
  "invite_code": "INV-DEMO",
  "notification_policy": {
    "employee_task_completed": true,
    "system_announcements": true
  },
  "admin_invites": []
}
```

`PATCH /api/team/settings`

```json
{
  "name": "Updated Corp",
  "contact_phone": "13800138000",
  "notification_policy": {
    "employee_task_completed": false,
    "system_announcements": true
  },
  "low_balance_threshold_cents": 8800
}
```

`POST /api/enterprise-admin/invites?role=owner`

```json
{
  "phone": "13900003333",
  "role": "enterprise_admin",
  "permissions": {
    "employees": true,
    "audit": true
  },
  "idempotency_key": "invite-enterprise-admin-001"
}
```

### 4.8 充值与余额

余额：`GET /api/team/billing/balance`

```json
{
  "balance": "0.00",
  "balance_cents": 0,
  "low_balance_warning": true
}
```

充值：`POST /api/team/billing/recharges`

```json
{
  "amount": 100,
  "payment_method": "mock_pay",
  "idempotency_key": "recharge-001"
}
```

成功响应：`201`

```json
{
  "recharge_id": "rch_xxx",
  "status": "succeeded",
  "mock_provider": true,
  "token_credited": 12345
}
```

### 4.9 连接器

列表：`GET /api/team/connectors`

```json
{
  "connectors": [],
  "definitions": []
}
```

创建：`POST /api/team/connectors`

```json
{
  "name": "Test Slack",
  "provider_code": "slack",
  "type": "oauth_connector"
}
```

成功响应：

```json
{
  "connector_id": "conn_xxx",
  "status": "draft"
}
```

详情：`GET /api/team/connectors/{connector_id}`

关键响应：

```json
{
  "connector_id": "conn_xxx",
  "credential_ref": "cred://vault/slack/detail",
  "credential_mask": "已配置",
  "credential_state": "configured",
  "config": {
    "tenant_hint": "acme",
    "bot_secret": "****"
  },
  "employee_grants": []
}
```

授权：`PATCH /api/team/connectors/{connector_id}/grants`

```json
{
  "grant": [],
  "revoke": []
}
```

响应：

```json
{
  "granted": [],
  "revoked": [],
  "errors": []
}
```

### 4.10 记忆

列表：`GET /api/team/memories`

空态响应：

```json
{
  "items": [],
  "page": 1,
  "page_size": 20,
  "total": 0,
  "has_more": false,
  "sort_by": "importance",
  "sort_order": "desc"
}
```

查询示例：

`GET /api/team/memories?employee_id=emp_test&q=Preferred&tag=vip&include=prompt_use_trace&trace_limit=5`

创建：`POST /api/team/memories`

```json
{
  "employee_id": "emp_test",
  "content": "Customer prefers concise weekly reports",
  "category": "preference",
  "importance": 5,
  "tags": ["vip", "reporting"],
  "visibility_scope": "admin_only"
}
```

更新：`PATCH /api/team/memories/{memory_id}`

```json
{
  "content": "Updated note",
  "importance": 4,
  "tags": ["updated", "important"],
  "review": {
    "decision": "corrected",
    "comment": "remove unverified detail",
    "corrected_content": "Corrected final note"
  }
}
```

批量删除：`POST /api/team/memories/bulk-delete`

```json
{
  "employee_id": "emp_test",
  "memory_ids": ["mem_1", "mem_2"]
}
```

### 4.11 系统后台企业治理动作

`POST /api/system-admin/enterprises/{enterprise_id}/actions?role=system_admin&actor_id=usr_sys`

封禁：

```json
{
  "action": "ban",
  "reason": "policy violation"
}
```

充值：

```json
{
  "action": "recharge",
  "amount": 500,
  "idempotency_key": "sysacct-test-recharge-1"
}
```

通知：

```json
{
  "action": "notify",
  "message": "Test notification",
  "idempotency_key": "sysacct-test-notify-1"
}
```

成功响应统一形状：

```json
{
  "enterprise_id": "ent_xxx",
  "action": "ban",
  "status": "succeeded",
  "message": "...",
  "audit_event_id": "evt_xxx"
}
```

---

## 5. 已知限制

### 5.1 当前不建议桌面端直接依赖 `/api/docs`

原因：

- 当前 `/api/docs` / `/api/openapi.json` 由静态扫描生成
- 能反映路径和方法
- 但 **不会自动产出完整 request/response schema**

### 5.2 本文档的稳定性边界

- 本文档适合当前桌面端按现状接入
- 若后续北向路径从 `/api/team/*` 迁移到新命名空间，需要重新出一版正式外部 OpenAPI
- 对“页面已调用但测试未锁全字段”的接口，桌面端应只依赖本文档列出的字段，不要猜测未承诺字段

---

## 6. 主要证据文件

- `app/static/aiteam/api-client.js`
- `app/static/aiteam/pages/app-chat.js`
- `app/static/aiteam/pages/app-group.js`
- `app/static/aiteam/pages/knowledge.js`
- `app/static/aiteam/pages/admin-*.js`
- `app/static/aiteam/pages/system-*.js`
- `app/tests/aiteam/layer2_team_panel/test_team_api_contracts.py`
- `app/tests/aiteam/layer2_team_panel/test_knowledge_office_contracts.py`
- `app/tests/aiteam/layer2_team_panel/test_memory_api_contracts.py`
- `app/tests/aiteam/layer2_team_panel/test_system_admin_enterprise_account.py`
- `app/tests/aiteam/layer2_team_panel/test_system_admin_rbac.py`
- `app/tests/aiteam/layer2_team_panel/test_auth_northbound_routes.py`
- `app/tests/aiteam/layer4_frontend_bff/test_admin_pages.py`
- `app/tests/aiteam/layer4_frontend_bff/test_chat_page_rendering.py`
- `app/tests/aiteam/layer4_frontend_bff/test_group_page_rendering.py`
- `app/tests/aiteam/layer4_frontend_bff/test_login_page_contract.py`

