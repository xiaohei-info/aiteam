---
name: aiteam-msg-streaming
description: AITeam SSE流式输出机制详解 - 流式订阅、增量更新、状态管理、恢复机制
---

# AITeam SSE流式输出机制详解

## 一、流式订阅入口

### startAssistantStream (src/stores/chat.ts:1002)

```typescript
startAssistantStream(convId, runId, opts?) {
  // 1. 防止重复订阅
  if (streamRegistry.has(convId)) return

  // 2. 占位消息ID：pending_<runId>
  const assistantMsgId = opts?.existingMsgId ?? pendingAssistantId(runId)

  // 3. 创建占位消息
  appendMessage(convId, {
    id: assistantMsgId,
    role: 'assistant',
    msgType: 'text',
    content: '',
    status: 'sending',
    runId,
    _pending: true,
  })

  // 4. 更新流式状态集合
  streamingMsgIds.add(assistantMsgId)
  generatingConvIds.add(convId)

  // 5. 启动SSE订阅
  const cancel = streamRun(runId, onDelta, onThinkingDelta, onComplete, onError, onToolCall)

  // 6. 注册到streamRegistry
  streamRegistry.add({ convId, runId, cancel, onDelta, onThinkingDelta, getSnapshot })
}
```

## 二、增量更新

### 内容增量 (80ms防抖)

```typescript
let accumulated = ''
let lastFlush = 0

const onDelta = (chunk: string) => {
  accumulated += chunk
  const t = Date.now()
  if (t - lastFlush >= 80) {
    lastFlush = t
    updateMessageContent(convId, assistantMsgId, accumulated)
  }
}
```

### 推理增量 (无防抖)

```typescript
const onThinkingDelta = (chunk: string) => {
  thinkingAccumulated += chunk
  updateMessageThinking(convId, assistantMsgId, thinkingAccumulated)
}
```

## 三、流式完成

```typescript
const finalize = (status: MsgStatus, overrideContent?: string) => {
  // 1. 更新最终内容
  updateMessageContent(convId, assistantMsgId, finalContent)

  // 2. 清理流式状态
  streamingMsgIds.delete(assistantMsgId)
  generatingConvIds.delete(convId)

  // 3. 移除注册表
  streamRegistry.remove(convId)

  // 4. 发送完成日志
  globalActivityCollector.emit({ ... })

  // 5. 更新对话预览
  if (status === 'delivered') {
    updateConvPreview(convId, finalContent)
  }

  // 6. 刷新对话列表
  refreshConversations()
}
```

## 四、流式恢复

### 恢复时机 (src/stores/chat.ts:727)

```typescript
// loadConversation后检查最新run
if (ACTIVE_RUN_STATUSES.has(data.run_status) && !streamRegistry.has(convId)) {
  resumeAssistantStream(convId, latestRunId)
}
```

**ACTIVE_RUN_STATUSES：** queued, routing, submitting, running, waiting_human

### resumeAssistantStream

```typescript
resumeAssistantStream(convId, runId) {
  if (streamRegistry.has(convId)) return
  // 复用pending_<runId>占位消息ID
  startAssistantStream(convId, runId, { existingMsgId: pendingAssistantId(runId) })
}
```

## 五、中止流式

### abortStream (src/stores/chat.ts:1194)

```typescript
abortStream(convId) {
  const entry = streamRegistry.get(convId)
  
  // 1. 调用API中止run
  await abortRun(entry.runId)

  // 2. 清空thinking，追加"停止生成"
  updateMessageContent(convId, msgId, content + '\n\n停止生成')

  // 3. 取消SSE订阅
  entry.cancel()
  streamRegistry.remove(convId)

  // 4. 清理状态集合
  streamingMsgIds.delete(msgId)
  generatingConvIds.delete(convId)
}
```

## 六、StreamRegistry (src/lib/streamRegistry.ts)

```typescript
interface StreamEntry {
  convId: string
  runId: string
  cancel: () => void
  onDelta: (chunk: string) => void
  onThinkingDelta: (chunk: string) => void
  getSnapshot: () => { assistantMsgId, content, thinking }
}
```

**作用：**
- 避免重复订阅
- 提供快照接口（恢复订阅）
- 管理取消函数（中止流式）

## 七、活动日志

- **思考中** - 第一次收到thinking时
- **工具调用** - tool_call完成时
- **完成** - run_succeeded/run_failed时

---

**最后更新：** 2026-08-20
