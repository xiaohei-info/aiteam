# Hermes API 接口文档

> [!WARNING]
> **已废弃，仅供历史排障参考。** AITeam 桌面端已移除 Hermes `/api/team/*`、Cookie/CSRF
> 与 run 级流式调用；当前接口和数据流请以 [Agent 接口迁移说明](./api-agent-migration.md) 为准。

Base URL: `http://121.40.78.201:8787`

## 认证

所有接口使用 cookie 认证，POST/PATCH/DELETE 需额外携带 CSRF token。

### 登录

```
POST /api/auth/login
Content-Type: application/json

{ "password": "AIFred_2026" }
```

响应：`{ "ok": true }`

登录成功后服务端通过 `Set-Cookie` 写入 `hermes_session`，后续请求自动携带（axios `withCredentials: true`）。

### CSRF Token

页面加载后从 `window.__HERMES_CONFIG__.csrfToken` 获取，所有非 GET 请求需在请求头中携带：

```
X-Hermes-CSRF-Token: <token>
```

---

## 单聊接口

Base path: `/api/team`

### 发送消息（创建 Run）

```
POST /api/team/runs
```

Request Body：

```json
{
  "employee_id": "<agent_id>",
  "conversation_id": "<conv_id>",
  "create_new": false,
  "message": {
    "text": "用户输入的内容",
    "quote_message_id": "<可选>",
    "attachments": []
  },
  "idempotency_key": "chat-<conv_id>-<timestamp>"
}
```

- `create_new: true`：无 `conversation_id` 时传此字段，服务端自动创建新会话
- 响应中含 `conversation_id`（首次发消息后需存入 state）和 `run_id`

### 流式接收消息（SSE）

```
GET /api/team/runs/<run_id>/stream?cursor=<cursor>
```

- `cursor` 初始为 `0`，每次事件携带 `event_cursor`，下次请求传入该值
- 事件类型 `message_delta`：流式文本片段
- 事件类型 `run_finished` / `run_failed`：结束信号

### 获取会话历史

```
GET /api/team/conversations/<conversation_id>
```

响应结构：

```json
{
  "messages": {
    "items": [ /* 消息列表 */ ],
    "has_more": false,
    "next_cursor": 0
  }
}
```

消息字段：`message_id`, `role`(user/assistant/system), `text`, `created_at`, `attachments`, `citations`, `run_id`

### 单聊列表（工作台）

```
GET /api/team/workbench
```

响应结构：

```json
{
  "enterprise_id": "ent_xxx",
  "active_employees": 5,
  "active_conversations": 6,
  "today_runs": 4,
  "today_tokens": 155524,
  "employees": [
    {
      "employee_id": "emp_xxx",
      "display_name": "前端开发",
      "conversation_id": "conv_xxx"
    }
  ],
  "groups": [
    {
      "conversation_id": "conv_xxx",
      "members": [
        { "employee_id": "emp_xxx", "display_name": "产品经理", "conversation_id": "conv_xxx" }
      ]
    }
  ],
  "recent_conversations": [
    {
      "id": "conv_xxx",
      "title": "前端开发",
      "conv_type": "private",
      "status": "active",
      "display_state": "resolved",
      "last_preview": "最后一条消息预览",
      "updated_at": "2026-06-18T01:40:15Z",
      "navigation_target": "/app/chat/conv_xxx",
      "latest_run_status": "succeeded",
      "unread_count": 1,
      "member_count": 0,
      "task_status_digest": {
        "total": 0, "planned": 0, "queued": 0, "running": 0,
        "waiting_deps": 0, "succeeded": 0, "failed": 0, "cancelled": 0
      }
    }
  ]
}
```

字段说明：
- `employees`：单聊 agent 列表，`conversation_id` 为 null 表示未开启过会话（首次发消息用草稿模式）
- `groups`：群聊列表，含成员数组
- `recent_conversations`：最近会话，`conv_type` 为 `private`（单聊）或 `group`（群聊）
- `navigation_target`：前端路由跳转路径

### 员工（Agent）

```
GET /api/team/employees
GET /api/team/employees/<employee_id>/conversations
```

### 群聊

```
GET  /api/team/group-conversations/<conversation_id>
POST /api/team/group-conversations/<conversation_id>/messages
```

---

## 前端实现要点

1. 登录后 cookie 由浏览器自动管理（`withCredentials: true`）
2. CSRF token 需在应用初始化时从后端获取并注入到请求拦截器
3. 首次发消息传 `create_new: true`，拿到 `conversation_id` 后存入 state 供后续使用
4. 流式回复通过 SSE 监听对应 `run_id` 的 stream 端点，按 `event_cursor` 递增轮询
