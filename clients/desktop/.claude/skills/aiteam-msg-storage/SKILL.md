---
name: aiteam-msg-storage
description: AITeam 消息存储、未读数、数据库表结构速查 — 涉及消息存储/未读数/DB 变更时必须调用，确保与现有架构一致
---

# AITeam 消息存储架构

## 速查清单

涉及消息存储、未读数、DB 结构变更时逐项核对：

- [ ] 写 DB 操作通过 `dbWrite` 串行队列，不直接调用 `invoke`
- [ ] 消息插入用 `dbInsertMessage`，内容字段用 `NewMessage` 接口
- [ ] thinking 内容存储格式：`THINKING:{thinking}\n---\n{text}`
- [ ] 流式回复用 `dbUpdateMessageContent` 节流写入，结束时 `dbUpdateMessageStatus`
- [ ] 未读数以服务端为事实源；本地清零用 `clearUnread`，WS 推送到非活跃会话时 `bumpUnread` 临时 +1（轮询/刷新与服务端对齐）
- [ ] 清零未读：先 `clearUnread`（store），再 `markConvRead`（API）
- [ ] 活跃会话收到新消息立即清零未读
- [ ] 清零后有 15s 保护窗口（`READ_GRACE_MS`），`refreshConversations` 不会用服务端旧 unread 覆盖本地已清零状态（防红点闪回）
- [ ] workbench 轮询：`Layout/index.tsx` 每 30s 调 `refreshConversations`（页面隐藏时暂停）

---

## 数据库表

### 静态表

**`users`** — 智能体用户
| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | |
| username | TEXT | |
| avatar | TEXT | emoji 或 URL |
| role | TEXT | `self` / `contact` / `agent` |
| extra | TEXT | JSON 字符串，含 profession/model/talents 等 |
| created_at / updated_at | INTEGER | Unix ms |

**`conversations`** — 私聊会话
| 字段 | 类型 | 说明 |
|------|------|------|
| peer_id | TEXT PK | |
| title | TEXT | |
| last_message_preview | TEXT | |
| last_message_at | INTEGER | Unix ms |
| unread_count | INTEGER | 由服务端同步，本地只清零 |
| is_pinned | BOOLEAN | |

**`group_list`** — 群聊会话，同 conversations，增加 `member_count`。

### 动态表

**`messages_{peer_id}`** — 每个私聊会话一张表
| 字段 | 类型 | 说明 |
|------|------|------|
| local_id | TEXT PK | 本地生成 UUID |
| server_id | TEXT | 服务端 message_id，可 null |
| sender_id / receiver_id | TEXT | |
| msg_type | TEXT | `text` / `image` / `file` / `card` |
| status | TEXT | `sending` / `sent` / `delivered` / `read` / `failed` |
| content | TEXT | JSON 字符串；有 thinking 时格式为 `THINKING:{...}\n---\n{text}` |
| created_at | INTEGER | Unix ms |
| server_at | INTEGER | 服务端时间，可 null |

对应全文索引虚拟表 `fts_messages_{peer_id}`，三个触发器自动维护（insert / update content / delete）。

---

## 消息存储流程

```
UI 发送
  ↓
store.appendMessage（乐观更新）
  ↓
dbInsertMessage → messages_{peer_id}（dbWrite 串行队列）
  ↓
streamRun 流式接口
  ↓  定时器节流
dbUpdateMessageContent（内容追加）
  ↓  结束
dbUpdateMessageStatus('delivered' | 'failed')
```

打开会话时：
1. `loadConversation` → `dbGetMessages(convId, 0, 20)` 读本地最新 20 条
2. 后台 `syncConvMessages` 拉服务端，`run_id` 匹配本地消息做 update，无匹配则 insert

---

## 未读数策略

```
服务端 workbench（loadAgentsAndConversations / refreshConversations / 30s 轮询）
  → recent_conversations[].unread_count / groups[].unread_count
  → applyUnread(convId, count)（尊重 15s 清零保护窗口）
  → store.conversations[].unread / groups[].unread（UI 红点）

用户点击会话
  → clearUnread(convId)       // store 立即清零，并记录清零时刻
  → markConvRead(convId)      // API 通知服务端（异步）

活跃会话收到新消息
  → 立即 clearUnread          // 不累积未读

WS 推送到非活跃会话（messageReceiver.receiveMessage）
  → bumpUnread(convId, preview, isGroup)  // 未读 +1、预览更新、会话置顶
  → 轮询/下次刷新与服务端 unread_count 对齐

发送消息后 SSE finalize（chat store startAssistantStream）
  → 非活跃会话：refreshConversations() 与服务端对齐
  → 活跃会话：靠"活跃会话收到新消息立即清零"路径兜底
```

注意：`markConvRead` 异步落库完成前，服务端可能仍返回旧 `unread_count`。清零后 15s（`READ_GRACE_MS`，`stores/chat.ts`）内 `applyUnread` 不回填未读，防止红点闪回；窗口过后服务端数据视为可信。

---

## 消息去重

Rust层 `db_insert_message` 使用 `INSERT OR IGNORE`，重复 `local_id` 静默跳过，无需 JS 层查重。

---

## 历史消息分页

**分页状态**：store `paginationByConv[convId] = { hasMore, serverCursor? }`

**加载优先级**（`loadMoreMessages`）：
1. 先查 DB：`db_get_messages_before(convId, oldestTs, 20)`（`WHERE created_at < ?1`，避免offset漂移）
2. DB 无结果时，用 `serverCursor` 向服务端拉历史，写入 DB（INSERT OR IGNORE去重），再从 DB 读出展示
3. `hasMore=false` 时停止

**触发方式**：Chat/GroupChat 的消息列表滚动到顶部（`scrollTop < 60`）时触发，保持滚动位置。

**服务端 cursor**：`fetchConvMessages(convId, cursor?)` / `fetchGroupMessages(convId, cursor?)`，初始不传则拉最新一页；`next_cursor` 持久化到 `paginationByConv`。

---

## 群聊消息存储

群聊消息复用私聊动态表机制（`messages_{groupId}`），通过 `loadGroupConversation` 加载：

1. 先读 DB 本地最新 20 条
2. 后台调 `fetchGroupMessages` 补充服务端新消息，写入 DB
3. `sendMessage` 发送时同步写用户消息和 assistant 消息到 DB

`sender_id` / `receiver_id` 约定：用户发出 → `sender_id=userId, receiver_id=groupId`；assistant 回复 → `sender_id=groupId, receiver_id=userId`。

---

## 关键 DB API（`src/lib/db.ts`）

| 函数 | 说明 |
|------|------|
| `dbInsertMessage(peerId, msg)` | 写消息，走 dbWrite 队列 |
| `dbUpdateMessageContent(peerId, localId, content)` | 更新内容（流式节流） |
| `dbUpdateMessageStatus(peerId, localId, status)` | 更新状态 |
| `dbUpdateMessageServerId(peerId, localId, serverId)` | 绑定服务端 ID |
| `dbUpsertConversation(conv)` | 创建或更新会话（含未读数） |
| `dbSearchMessages(peerId, query)` | 全文搜索，走 FTS 虚拟表 |

所有写操作通过 `dbWrite` 串行执行，保证 insert/update 顺序。

---

## 注意点

- **`loadConversation` / `loadGroupConversation` 只加载 20 条**：无分页/无限滚动，历史消息需另行处理。
- **`group_list.last_message_at` 可为 null**：服务端未返回时存 null，读取时 `relativeTime(null)` 返回空字符串，按无消息处理，属正常情况。

---

## 变更规范

- 涉及消息存储/未读数/DB 表结构变更，必须同步更新本 skill。
- 说明变更影响范围、测试覆盖、回滚方案。
- 建议 code review 后合并。
