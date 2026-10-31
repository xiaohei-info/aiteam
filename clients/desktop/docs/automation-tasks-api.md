# 自动化任务 API 契约

本文档对应桌面端 `/tasks` 自动化任务页面。后端应提供独立的自动化任务资源，不建议继续把任务直接暴露为普通 conversation；调度器可以复用现有 schedule service，但任务的名称、分类、MCP 连接器和员工关系需要独立持久化。

## 1. 鉴权与租户隔离

- 所有接口使用现有 Agent Bearer 鉴权。
- `tenant_id`、当前成员身份从 token 解析，不接受客户端覆盖。
- 每个任务只能被其所属 tenant 的已授权成员读取或修改。
- `employee_id` 必须属于当前成员可见的授权员工；否则返回 `403 employee_not_authorized`。
- `connector_id` 必须属于当前 tenant 且处于启用状态；否则返回 `422 connector_unavailable`。

## 2. 资源模型

建议资源名：`automation_task`。

```json
{
  "task_id": "task_01J...",
  "name": "每日工作简报",
  "prompt": "汇总昨天的项目进度、风险和待办，生成一份简明的团队简报。",
  "category": "report",
  "employee_id": "employee-aria",
  "employee": {
    "employee_id": "employee-aria",
    "display_name": "Aria",
    "role_title": "研究分析师"
  },
  "connector_ids": ["notion"],
  "connectors": [
    {
      "connector_id": "notion",
      "display_name": "Notion Integration",
      "status": "enabled"
    }
  ],
  "schedule": {
    "mode": "daily",
    "timezone": "Asia/Shanghai",
    "time": "09:00:00"
  },
  "status": "active",
  "last_run_at": "2026-09-20T01:12:00.000Z",
  "next_run_at": "2026-09-21T01:00:00.000Z",
  "last_run": {
    "status": "succeeded",
    "started_at": "2026-09-20T01:00:00.000Z",
    "finished_at": "2026-09-20T01:01:16.000Z",
    "error_code": null
  },
  "created_by": "member-001",
  "created_at": "2026-09-18T08:00:00.000Z",
  "updated_at": "2026-09-20T01:12:00.000Z"
}
```

### 字段约束

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `task_id` | string | 服务端生成，稳定且不可变 |
| `name` | string | 必填，1–120 个字符 |
| `prompt` | string | 必填，1–20,000 个字符；服务端禁止记录完整 prompt 到普通请求日志 |
| `category` | enum | `report`、`monitor`、`reminder`、`other` |
| `employee_id` | string | 必填，当前成员可见的员工 |
| `connector_ids` | string[] | 可为空；MVP 可限制最多 10 个 |
| `schedule` | object | 必填，见下文 |
| `status` | enum | `active`、`paused`、`completed`、`failed` |

## 3. 调度模型

所有时间都必须明确 `timezone`。服务端存储 UTC，返回值使用 ISO 8601；`schedule.timezone` 只接受 IANA 时区名。

### 每天

```json
{
  "mode": "daily",
  "timezone": "Asia/Shanghai",
  "time": "09:00:00"
}
```

### 每周

`weekday` 使用 ISO-8601：`1` 为周一，`7` 为周日。

```json
{
  "mode": "weekly",
  "timezone": "Asia/Shanghai",
  "weekday": 1,
  "time": "10:00:00"
}
```

### 每月

`day_of_month` 取 `1–31`。如果某月没有该日期，必须固定采用一种策略，建议使用 `skip`，并在接口文档中保持一致。

```json
{
  "mode": "monthly",
  "timezone": "Asia/Shanghai",
  "day_of_month": 1,
  "time": "09:00:00",
  "invalid_date_policy": "skip"
}
```

### 间隔

间隔任务需要一个起始时间，避免服务重启后无法确定第一次执行时间。`interval_seconds` 最小建议为 `300`。

```json
{
  "mode": "interval",
  "timezone": "Asia/Shanghai",
  "interval_seconds": 7200,
  "starts_at": "2026-09-20T09:00:00+08:00"
}
```

### 单次

单次任务执行成功或失败后都应变为 `completed`，不可再次触发；如需重试，使用任务运行记录的 retry 能力，而不是重复触发同一 occurrence。

```json
{
  "mode": "once",
  "timezone": "Asia/Shanghai",
  "run_at": "2026-10-01T16:30:00+08:00"
}
```

## 4. 接口列表

### 4.1 查询任务列表

```http
GET /api/agent/automation-tasks?category=all&status=active&q=简报&employee_id=employee-aria&limit=50&cursor=...
```

Query 参数：

- `category`：`all`、`mine`、`report`、`monitor`、`reminder`；默认 `all`
- `status`：`all`、`active`、`paused`；默认 `all`
- `q`：按任务名称、提示词摘要、员工名称搜索；服务端应限制长度，例如 120 字符
- `employee_id`：按员工筛选
- `limit`：1–100，默认 50
- `cursor`：分页游标

响应：

```json
{
  "data": [],
  "page": { "next_cursor": null, "has_more": false }
}
```

列表中的 `prompt` 建议返回截断摘要（例如最多 240 字符），详情接口再返回完整 prompt。

### 4.2 查询任务详情

```http
GET /api/agent/automation-tasks/{task_id}
```

响应：`200 { "data": AutomationTask }`

### 4.3 创建任务

```http
POST /api/agent/automation-tasks
Idempotency-Key: 4f9d...
Content-Type: application/json
```

请求：

```json
{
  "name": "每日工作简报",
  "prompt": "汇总昨天的项目进度、风险和待办，生成一份简明的团队简报。",
  "category": "report",
  "employee_id": "employee-aria",
  "connector_ids": ["notion"],
  "schedule": {
    "mode": "daily",
    "timezone": "Asia/Shanghai",
    "time": "09:00:00"
  }
}
```

响应：`201 { "data": AutomationTask }`

`Idempotency-Key` 必须在同一 tenant 内生效，建议保留至少 24 小时。重复请求返回第一次创建结果，不得创建重复任务。

### 4.4 更新任务

```http
PATCH /api/agent/automation-tasks/{task_id}
If-Match: "revision-3"
Content-Type: application/json
```

支持部分更新：`name`、`prompt`、`category`、`employee_id`、`connector_ids`、`schedule`。

响应：`200 { "data": AutomationTask }`

服务端应使用 revision/ETag 做乐观锁；版本冲突返回 `409 task_revision_conflict`，避免用户在编辑抽屉保存时覆盖其他人的修改。

### 4.5 删除任务

```http
DELETE /api/agent/automation-tasks/{task_id}
```

建议软删除，保留运行审计记录。响应：`204 No Content`。

### 4.6 启用 / 暂停任务

```http
POST /api/agent/automation-tasks/{task_id}/actions/enable
POST /api/agent/automation-tasks/{task_id}/actions/pause
```

响应：`200 { "data": AutomationTask }`

这两个接口需要幂等：重复 enable 或 pause 都返回当前资源，不应报错。

### 4.7 查询运行记录（建议一并提供）

```http
GET /api/agent/automation-tasks/{task_id}/runs?limit=20&cursor=...
```

响应中的运行记录至少包含：`run_id`、`status`、`scheduled_at`、`started_at`、`finished_at`、`error_code`、`result_summary`。`result_summary` 必须脱敏并限制长度。

## 5. 连接器接口

任务接口只保存 `connector_ids`，不复制连接器凭据。前端创建任务时需要一个当前 tenant 可用的连接器列表：

```http
GET /api/agent/connectors?status=enabled
```

建议响应：

```json
{
  "data": [
    {
      "connector_id": "notion",
      "display_name": "Notion Integration",
      "type": "mcp",
      "status": "enabled",
      "available_employee_ids": ["employee-aria"]
    }
  ],
  "page": { "next_cursor": null, "has_more": false }
}
```

接口不得返回 API key、OAuth refresh token、MCP 私密配置等凭据。

## 6. 错误响应

统一使用现有 HTTP problem 格式：

```json
{
  "error": {
    "code": "task_schedule_invalid",
    "message": "weekly schedule requires weekday and time",
    "request_id": "req_..."
  }
}
```

建议错误码：

- `400 invalid_json`
- `401 unauthenticated`
- `403 forbidden`
- `403 employee_not_authorized`
- `404 task_not_found`
- `404 connector_not_found`
- `409 task_revision_conflict`
- `409 idempotency_key_reused`
- `422 task_name_invalid`
- `422 prompt_invalid`
- `422 task_schedule_invalid`
- `422 connector_unavailable`
- `503 scheduler_unavailable`

## 7. 与当前前端的对应关系

当前桌面端已经具备这些交互字段：`name`、`prompt`、`connector`、`schedule`、`employee_id`、启用/暂停、编辑、删除、列表搜索和分类筛选。后端接口落地后，只需要：

1. 将任务列表的本地存储替换为 `GET /api/agent/automation-tasks`。
2. 将创建和编辑提交替换为 `POST/PATCH`。
3. 将暂停、启用、删除按钮替换为对应 action API。
4. 将 MCP 下拉选项替换为 `GET /api/agent/connectors`。
5. 将本地演示任务和接口失败时的 fallback 数据移除。

