---
name: aiteam-msg-architecture
description: AITeam消息系统架构总览 - 单聊和群聊的核心架构、数据流和关键模块说明，修改消息逻辑前必读
---

# AITeam 消息系统架构总览

## 速查清单

修改消息相关逻辑前逐项核对：

- [ ] 消息发送走 `messageSender.ts`，不直接操作 store
- [ ] 消息接收走 `messageReceiver.ts`，由 WebSocket 触发
- [ ] 流式输出通过 `streamRegistry` 注册，避免重复订阅
- [ ] 本地 DB 已停用 [DB-DISABLED]，所有数据以服务端为准
- [ ] 占位消息 ID 格式：`pending_<runId>`，恢复订阅时复用
- [ ] 群聊消息需传入 `memberMap` 用于显示发送者名称
- [ ] 分页加载确保 run 完整性（user + assistant + thinking）

---

## 一、核心文件定位

| 模块 | 文件路径 | 职责 |
|------|---------|------|
| 消息发送 | `src/lib/messageSender.ts` | 构造消息、optimistic update |
| 消息接收 | `src/lib/messageReceiver.ts` | WebSocket消息处理 |
| 状态管理 | `src/stores/chat.ts` | Zustand全局状态 |
| WebSocket | `src/lib/socket.ts` | 单例连接管理 |
| SSE流式 | `src/lib/streamRegistry.ts` | 流式订阅注册表 |
| 单聊页面 | `src/pages/Chat/index.tsx` | 单聊UI入口 |
| 群聊页面 | `src/pages/GroupChat/index.tsx` | 群聊UI入口 |
| API接口 | `src/api/hermes.ts` | HTTP + SSE接口 |

---

## 二、数据流概览

### 2.1 发送流程（单聊）

```
用户输入 → sendMessage
  ↓
messageSender.sendTextMessage (optimistic update)
  ↓
API sendRun({ employee_id, text })
  ↓
startAssistantStream(convId, runId)
  ↓
SSE流式推送 → updateMessageContent
  ↓
UI实时渲染
```

### 2.2 发送流程（群聊）

```
用户输入 → handleSend
  ↓
appendMessage(groupId, userMsg)
  ↓
API sendGroupMessage({ convId, text, senderId, mentions })
  ↓
beginAssistantStream(groupId, run_id)
  ↓
SSE流式推送 → updateMessageContent
  ↓
UI实时渲染
```

### 2.3 接收流程（WebSocket推送）

```
服务端推送
  ↓
WebSocket.onmessage → parseServerMessage
  ↓
messageReceiver.receiveMessage
  ↓
serverMsgToLocal (格式转换)
  ↓
appendMessage (写入store)
  ↓
onStream (触发流式播放)
  ↓
UI渲染
```

---

## 三、关键技术点

### 3.1 消息去重与聚合

**函数：** `buildRunMessages(items, memberMap)`（`chat.ts:156`）

**问题：** 服务端将一个run拆成多条消息（user/assistant/reasoning/tool_call）

**解决：**
- 按 `run_id` 分组
- reasoning + tool_call 聚合到 `thinkingSteps`
- 只保留一条 `run_succeeded` 展示消息
- 未完成的run产出 `pending_<runId>` 占位消息

### 3.2 流式订阅恢复

**场景：** 刷新页面或切换对话，active run仍在运行

**机制：**
1. `loadConversation` 检查最新run状态
2. 若状态在 `ACTIVE_RUN_STATUSES` 且无活跃订阅
3. 调用 `resumeAssistantStream(convId, latestRunId)`
4. 复用 `pending_<runId>` ID 继续接收SSE

### 3.3 占位消息规范

**格式：** `pending_<runId>`

**作用：**
- 前后端统一使用此格式
- 避免刷新后占位消息与UUID重复
- `startAssistantStream` 默认使用此ID

### 3.4 分页加载策略

**目标：** 确保加载完整run（不切割reasoning/tool）

**逻辑：**
1. 首次加载50条
2. 若最旧消息的run缺user消息，继续向前拉
3. 最多补拉12轮（每轮50条）
4. 直到run边界出现或无更多历史

---

## 四、消息类型定义

### 4.1 本地格式 (`Message`)

```typescript
{
  id: string                    // 消息ID
  role: 'user' | 'assistant'
  msgType: 'text' | 'image' | 'file' | 'card'
  content: string
  time: string                  // HH:mm格式
  thinking?: string             // 推理过程
  thinkingSteps?: ThinkingStep[] // reasoning + tool调用
  runId?: string
  status?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
  senderName?: string           // 群聊发送者名称
  attachments?: MessageAttachment[]
  _ts?: number                  // 排序用时间戳
  _pending?: boolean            // 占位消息标记
}
```

### 4.2 服务端格式 (`ServerMessage`)

```typescript
{
  id: string
  conv_id: string
  sender_id: string
  receiver_id: string
  msg_type: MsgType
  content: string
  created_at: number            // Unix时间戳(ms)
  thinking?: string
}
```

### 4.3 状态转换

```
[用户消息]
sending → sent (300ms) → delivered (服务端ACK)

[助手消息]
sending (流式中) → delivered (完成) | failed (出错)
```

---

## 五、关键约束

### 5.1 [DB-DISABLED] 标记

本地SQLite持久化已停用，标记遍布：
- `messageSender.ts` - db调用已注释
- `stores/chat.ts` - db导入已注释

**当前策略：** 所有数据以服务端为准

### 5.2 消息ID规范

- **用户消息：** `crypto.randomUUID()`
- **助手消息（流式）：** `pending_<runId>`
- **助手消息（完成）：** 服务端 `message_id`

### 5.3 群聊特殊处理

- 需要 `memberMap` 映射 `sender_id` → `display_name`
- `buildRunMessages(items, memberMap)` 第二参数传入
- UI通过 `msg.senderName` 显示发送者

### 5.4 流式防抖

`onDelta` 采用80ms防抖，避免高频渲染：

```typescript
const onDelta = (chunk: string) => {
  accumulated += chunk
  const t = Date.now()
  if (t - lastFlush >= 80) {
    lastFlush = t
    get().updateMessageContent(convId, assistantMsgId, accumulated)
  }
}
```

---

## 六、对接清单

### WebSocket对接
- [ ] `buildWsUrl(token)` 改为真实地址
- [ ] `parseServerMessage(data)` 按实际协议解析
- [ ] 确认鉴权方式（query/header）

### API对接
- [ ] 确认 `sendRun` 参数和响应
- [ ] 确认 `sendGroupMessage` 参数和响应
- [ ] 确认 SSE `streamRun` 事件类型

### 消息格式
- [ ] 对齐 `ServerMessage` 接口字段
- [ ] 确认 `thinking` 传递方式
- [ ] 确认 `attachments` 结构

---

## 相关Skill

- **aiteam-msg-sending** - 消息发送详细流程
- **aiteam-msg-receiving** - 消息接收详细流程
- **aiteam-msg-ui** - UI组件使用说明
- **aiteam-msg-streaming** - SSE流式机制
- **aiteam-msg-storage** - 消息存储（现有）

---

**最后更新：** 2026-08-20  
**维护说明：** 修改消息逻辑时同步更新相关skill
