---
name: aiteam-msg-sending
description: AITeam消息发送详细流程 - 单聊和群聊的消息发送逻辑、API调用、状态更新
---

# AITeam 消息发送详细流程

## 速查清单

修改消息发送逻辑前逐项核对：

- [ ] 用户消息立即写store（optimistic update），不等API响应
- [ ] 文件先上传获取`storage_key`，再附加到消息
- [ ] 新对话使用`employee_id`占位，首次发消息后升级为`conversation_id`
- [ ] 消息状态：`sending` → `sent`(300ms) → `delivered`(服务端ACK)
- [ ] API失败标记`failed`，UI显示重发按钮
- [ ] 群聊需传`senderId`和`mentions`参数

---

## 一、单聊发送 (src/pages/Chat/index.tsx:234)

```typescript
sendMessage → uploadFiles → sendTextMessage → dispatch
  → API sendRun → startAssistantStream
```

### 关键步骤

1. **上传附件** - `uploadFiles(files)` 获取storage_key
2. **构造消息** - `sendTextMessage(ctx, text, attachments)`
3. **立即写store** - `appendMessage`（optimistic update）
4. **调用API** - `sendRun({ employee_id, text, attachments })`
5. **升级ID** - 首次对话时 `upgradeConversationId`
6. **启动流式** - `startAssistantStream(convId, runId)`

### 文件上传 (src/lib/messageSender.ts:109)

- 文本文件：传 `content_text`
- 二进制文件：传 `content_base64`
- 失败文件跳过，不阻塞

---

## 二、群聊发送 (src/pages/GroupChat/index.tsx:54)

```typescript
handleSend → appendMessage(userMsg)
  → sendGroupMessage({ convId, text, senderId, mentions })
  → beginAssistantStream
```

### 与单聊差异

| 项目 | 单聊 | 群聊 |
|------|------|------|
| **发送者** | 固定当前用户 | 需传`senderId` |
| **senderName** | 不设置 | 设置为`display_name` |
| **mentions** | 不支持 | 支持`@mention` |
| **文件处理** | 批量附加到文本消息 | 每个文件独立消息 |

---

## 三、消息状态流转

```
sending (构造时)
  ↓ 立即写store
sent (300ms后)
  ↓ API响应成功
delivered (服务端ACK)
```

```
[失败场景]
sending
  ↓ API失败
failed (点击重发)
```

### 状态更新 (src/stores/chat.ts:637)

```typescript
updateMessageStatus: (convId, msgId, status) =>
  set((s) => ({
    activeConvMessages: s.activeConvMessages.map((m) =>
      m.id === msgId ? { ...m, status } : m
    )
  }))
```

---

## 四、对话预览更新 (src/stores/chat.ts:955)

```typescript
updateConvPreview: (convId, preview) =>
  set((s) => {
    const updated = s.conversations.map((c) =>
      c.id === convId
        ? { ...c, lastMessage: preview.slice(0, 60), time: relativeTime(Date.now()) }
        : c
    )
    // 置顶当前对话
    const idx = updated.findIndex((c) => c.id === convId)
    if (idx > 0) updated.unshift(updated.splice(idx, 1)[0])
    return { conversations: updated }
  })
```

**调用时机：**
- 发送消息后立即调用
- 助手消息完成后调用

---

## 五、错误处理

### 无可用智能体
```typescript
if (!employee) {
  setNewSessionError('暂无可用智能体')
  return
}
```

### API失败
```typescript
try {
  const result = await sendRun({ ... })
} catch (err) {
  updateMessageStatus(convId, userMsg.id, 'failed')
  return
}
```

### 用户重试 (src/pages/Chat/index.tsx:461)
```typescript
onClick={msg.status === 'failed' ? () => sendMessage(msg.content) : undefined}
```

---

## 六、最佳实践

### Optimistic Update
- 消息立即写store，不等API
- 提升用户体验
- 失败后允许重试

### 文件上传
- 先上传获取URL，再发消息
- 失败文件跳过，不阻塞
- 文本传原文，二进制传base64

### 对话ID升级
- 新对话用`emp_<id>`占位
- 首次发消息后升级为真实`conversation_id`
- 调用`upgradeConversationId`和`rememberEmployeeConversation`

---

## 相关Skill

- **aiteam-msg-architecture** - 架构总览
- **aiteam-msg-streaming** - SSE流式机制
- **aiteam-msg-receiving** - 消息接收处理

---

**最后更新：** 2026-08-20
