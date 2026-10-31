---
name: aiteam-msg-receiving
description: AITeam消息接收处理详细流程 - WebSocket推送、格式转换、流式播放触发
---

# AITeam 消息接收处理详细流程

## 速查清单

修改消息接收逻辑前逐项核对：

- [ ] WebSocket推送统一走`receiveMessage`入口
- [ ] 服务端消息通过`serverMsgToLocal`转换为本地格式
- [ ] assistant消息自动触发`onStream`流式播放
- [ ] 消息立即写store，[DB-DISABLED]不写本地DB
- [ ] WebSocket连接由`useSocket` hook管理，登录后自动连接

---

## 一、接收流程总览

```
服务端推送
  ↓
WebSocket.onmessage (socket.ts:97)
  ↓
parseServerMessage(data) - 解析帧
  ↓
receiveMessage(ctx, raw) (messageReceiver.ts:71)
  ↓
serverMsgToLocal(raw) - 格式转换
  ↓
ctx.appendMessage(convId, msg) - 写store
  ↓
ctx.onStream(convId, msgId) - 触发流式播放
  ↓
UI渲染新消息
```

---

## 二、WebSocket连接管理

### 2.1 单例模式 (src/lib/socket.ts)

```typescript
// 全局单例状态
const state: SocketState = {
  ws: null,
  status: 'disconnected',
  token: null,
}

// 建立连接
export function connect(token: string, ctx: ReceiveContext): void {
  const ws = new WebSocket(buildWsUrl(token))
  
  ws.onopen = () => setStatus('connected')
  
  ws.onmessage = (event) => {
    const raw = parseServerMessage(event.data)
    if (!raw) {
      console.warn('[socket] unrecognized frame', event.data)
      return
    }
    receiveMessage(ctx, raw)  // 转交给接收层处理
  }
  
  ws.onerror = (e) => setStatus('error')
  ws.onclose = (e) => setStatus('disconnected')
}
```

### 2.2 Hook集成 (src/hooks/useSocket.ts:22)

```typescript
export function useSocket(
  onStream?: (convId: string, msgId: string) => void
): SocketStatus {
  const token = useAuthStore((s) => s.token)
  const userId = useAuthStore((s) => s.userId) ?? ''
  const dbReady = useAuthStore((s) => s.dbReady)
  const appendMessage = useChatStore((s) => s.appendMessage)

  useEffect(() => {
    if (!token || !dbReady) return

    const ctx: ReceiveContext = {
      userId,
      dbReady,
      appendMessage,
      onStream: onStream ?? (() => {}),
    }

    connect(token, ctx)
    return () => disconnect()
  }, [token, dbReady])

  return status
}
```

**使用位置：**
- `src/pages/Chat/index.tsx:117` - `useSocket()`
- App根层调用，登录后自动连接

---

## 三、消息接收处理

### 3.1 receiveMessage函数 (src/lib/messageReceiver.ts:71)

```typescript
export async function receiveMessage(
  ctx: ReceiveContext,
  raw: ServerMessage,
): Promise<void> {
  const msg = serverMsgToLocal(raw)

  // 1. 写入store → UI立即渲染
  ctx.appendMessage(raw.conv_id, msg)

  // 2. 触发流式播放（仅assistant文字消息）
  if (msg.role === 'assistant' && msg.msgType === 'text') {
    ctx.onStream(raw.conv_id, msg.id)
  }

  // 3. [DB-DISABLED] 持久化已停用
}
```

### 3.2 格式转换 (src/lib/messageReceiver.ts:50)

```typescript
function serverMsgToLocal(raw: ServerMessage): Message {
  const d = new Date(raw.created_at)
  const time = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  
  return {
    id: raw.id,
    role: 'assistant',
    msgType: raw.msg_type,
    content: raw.content,
    thinking: raw.thinking,
    time,
    status: 'delivered' as MsgStatus,
  }
}
```

### 3.3 ReceiveContext结构 (src/lib/messageReceiver.ts:37)

```typescript
export interface ReceiveContext {
  userId: string                          // 当前登录用户ID
  dbReady: boolean                        // DB就绪状态（已停用）
  appendMessage: (convId: string, msg: Message) => void  // 写store
  onStream: (convId: string, msgId: string) => void      // 触发流式播放
}
```

---

## 四、服务端消息格式

### 4.1 ServerMessage接口 (src/lib/messageReceiver.ts:20)

```typescript
export interface ServerMessage {
  id: string                  // 服务端消息唯一ID
  conv_id: string             // 所属对话ID（peer_id）
  sender_id: string
  receiver_id: string
  msg_type: MsgType           // 'text' | 'image' | 'file' | 'card'
  content: string             // 消息内容
  created_at: number          // 服务端时间戳（ms）
  thinking?: string           // assistant消息的推理过程
}
```

### 4.2 对接要点

**文件：** `src/lib/socket.ts:57`

```typescript
function parseServerMessage(data: unknown): ServerMessage | null {
  try {
    const payload = typeof data === 'string' ? JSON.parse(data) : data
    
    // 基本字段校验
    if (
      typeof payload.id !== 'string' ||
      typeof payload.conv_id !== 'string' ||
      typeof payload.content !== 'string'
    ) {
      return null
    }
    
    return payload as ServerMessage
  } catch {
    return null
  }
}
```

**TODO：** 按实际服务端协议调整解析逻辑

---

## 五、流式播放触发

### 5.1 触发条件

```typescript
if (msg.role === 'assistant' && msg.msgType === 'text') {
  ctx.onStream(raw.conv_id, msg.id)
}
```

**仅当：**
- `role === 'assistant'`
- `msgType === 'text'`

### 5.2 onStream回调

由调用方（Chat页面）注入，通常触发SSE流式订阅。

**注意：** WebSocket推送的消息可能已经是完整内容，不一定需要流式播放。流式播放通常由用户发送消息后，主动调用`startAssistantStream`触发。

---

## 六、消息写入Store

### 6.1 appendMessage (src/stores/chat.ts:622)

```typescript
appendMessage: (convId, msg) =>
  set((s) => {
    if (convId !== s.activeConvId && convId !== s.activeGroupId) return {}
    
    // 已存在则合并刷新，不存在则新增
    if (s.activeConvMsgIds.has(msg.id)) {
      return { activeConvMessages: upsertMessage(s.activeConvMessages, msg) }
    }
    
    const nextIds = new Set(s.activeConvMsgIds)
    nextIds.add(msg.id)
    return {
      activeConvMessages: [...s.activeConvMessages, msg],
      activeConvMsgIds: nextIds,
    }
  })
```

**特性：**
- 仅当对话为活跃对话时写入（`activeConvId`或`activeGroupId`）
- 已存在的消息ID会触发upsert（合并更新）
- `activeConvMsgIds` 与 `activeConvMessages` 严格同步

### 6.2 upsertMessage (src/stores/chat.ts:268)

```typescript
function upsertMessage(msgs: Message[], msg: Message): Message[] {
  const idx = msgs.findIndex((m) => m.id === msg.id)
  if (idx < 0) return [...msgs, msg]
  
  const existing = msgs[idx]
  const overrides: Partial<Message> = {}
  for (const key of Object.keys(msg) as (keyof Message)[]) {
    const value = msg[key]
    if (value !== undefined) {
      (overrides as Record<string, unknown>)[key] = value
    }
  }
  const merged: Message = { ...existing, ...overrides }
  return msgs.map((m, i) => (i === idx ? merged : m))
}
```

**合并策略：** 新字段覆盖非undefined项，保留累积状态

---

## 七、[DB-DISABLED] 持久化已停用

**当前策略：** 所有数据以服务端为准，恢复离线缓存时取消注释相关代码

---

## 八、对接清单

### 8.1 WebSocket地址

**文件：** `src/lib/socket.ts:46`

```typescript
function buildWsUrl(token: string): string {
  const base = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8080/ws'
  return `${base}?token=${encodeURIComponent(token)}`
}
```

- [ ] 修改为真实WebSocket地址
- [ ] 确认鉴权方式（URL query / 握手header）

### 8.2 消息格式对齐

- [ ] 对齐`ServerMessage`接口字段
- [ ] 确认`thinking`字段传递方式
- [ ] 确认时间戳单位（ms / s）

---

## 相关Skill

- **aiteam-msg-architecture** - 架构总览
- **aiteam-msg-sending** - 消息发送流程
- **aiteam-msg-streaming** - SSE流式机制

---

**最后更新：** 2026-08-20
