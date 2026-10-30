/**
 * 本地会话 CRUD / prompt / entries / abort / 已读。
 *
 * FredServer 侧对应路由(SSOT: server/agent_service/src/http/server.ts):
 *   GET    /api/agent/conversations                 列出会话(游标分页)
 *   POST   /api/agent/conversations                 创建 chat/group 会话
 *   GET    /api/agent/conversations/:id             获取会话元数据
 *   PATCH  /api/agent/conversations/:id             部分更新(含 last_read_entry_id)
 *   PUT    /api/agent/conversations/:id             等价 PATCH
 *   DELETE /api/agent/conversations/:id             删除会话及本地执行状态
 *   GET    /api/agent/conversations/:id/state       持久化 state + 瞬时 prompting
 *   PUT    /api/agent/conversations/:id/state       更新持久化 state
 *   GET    /api/agent/conversations/:id/context     上下文 HUD(model/tokens/thinking_level)
 *   PATCH  /api/agent/conversations/:id/context     更新 thinking_level
 *   POST   /api/agent/conversations/:id/context/reset 开启新上下文(旧上下文交给 Manager 记忆),可附带本段结果评估
 *   GET    /api/agent/conversations/:id/segments    各上下文段落的结果评估
 *   PATCH  /api/agent/conversations/:id/segments/:segment_id 修改或撤销段落评估
 *   POST   /api/agent/conversations/:id/prompt      提交提示,202 + Idempotency-Key
 *   POST   /api/agent/conversations/:id/introduction 空单聊的员工自我介绍,202 + 收据
 *   GET    /api/agent/conversations/:id/entries     历史条目全量(脱敏)
 *   POST   /api/agent/conversations/:id/abort       终止当前 prompt 执行
 *
 * 幂等约束:prompt 强制走 Idempotency-Key。同一 key 重放返回 { state:'completed' }。
 */
import type { AgentApiClient } from './client'
import type { WorkRecord, WorkHistoryEnvelope } from './observations.types'
import type {
  ContextResetRequest,
  ContextResetResult,
  ContextSegment,
  ContextSegmentUpdateRequest,
  ConversationContextOut,
  ConversationCreateRequest,
  ConversationEntry,
  ConversationMetadata,
  ConversationStateOut,
  ConversationStateValue,
  ConversationUpdateRequest,
  Page,
  PromptAccepted,
  PromptReceiptOut,
  PromptRequest,
  ThinkingLevel,
  AbortResult,
} from './types'

// -------------------- 会话列表 --------------------

export interface ListConversationsParams {
  // FredServer ConversationQuery 只接受 cursor / limit；additionalProperties=false。
  cursor?: string
  limit?: number
  signal?: AbortSignal
}

export interface ConversationsPage {
  conversations: ConversationMetadata[]
  page: Page
}

export async function listConversations(
  client: AgentApiClient,
  params: ListConversationsParams = {},
): Promise<ConversationsPage> {
  // 需要同时拿 data 和 page,所以走 raw 自己解包。
  const payload = await client.request<{ data: ConversationMetadata[]; page: Page }>({
    method: 'GET',
    path: '/api/agent/conversations',
    query: {
      cursor: params.cursor,
      limit: params.limit,
    },
    raw: true,
    signal: params.signal,
  })
  return {
    conversations: payload.data ?? [],
    page: payload.page ?? { next_cursor: null, has_more: false },
  }
}

// -------------------- 会话创建/读取/更新/删除 --------------------

export function createConversation(
  client: AgentApiClient,
  params: ConversationCreateRequest,
): Promise<ConversationMetadata> {
  // 前置校验:服务端 ConversationCreateRequest schema 允许字段全部 optional,但发上去后
  // handler 层会再检查 entry_employee_id / coordinator_employee_id 是否在 grants 中,
  // 空字符串或未定义都会命中 422(schema minLength:1)或 403。这里提前失败,避免无效请求。
  const kind = params.kind ?? 'chat'
  if (kind === 'chat' && !params.entry_employee_id) {
    return Promise.reject(new Error('createConversation(chat): entry_employee_id 不能为空'))
  }
  if (kind === 'group' && !params.coordinator_employee_id) {
    return Promise.reject(new Error('createConversation(group): coordinator_employee_id 不能为空'))
  }
  return client.request<ConversationMetadata>({
    method: 'POST',
    path: '/api/agent/conversations',
    body: params,
  })
}

export function getConversation(
  client: AgentApiClient,
  conversationId: string,
): Promise<ConversationMetadata> {
  return client.request<ConversationMetadata>({
    method: 'GET',
    path: `/api/agent/conversations/${encodeURIComponent(conversationId)}`,
  })
}

export function updateConversation(
  client: AgentApiClient,
  conversationId: string,
  patch: ConversationUpdateRequest,
): Promise<ConversationMetadata> {
  return client.request<ConversationMetadata>({
    method: 'PATCH',
    path: `/api/agent/conversations/${encodeURIComponent(conversationId)}`,
    body: patch,
  })
}

// 标记已读:把最后已读 entry id 写回服务端。旧栈的 workbench/state {mark_read} 对应。
export function markConversationRead(
  client: AgentApiClient,
  conversationId: string,
  lastReadEntryId: string | null,
): Promise<ConversationMetadata> {
  return updateConversation(client, conversationId, { last_read_entry_id: lastReadEntryId })
}

export function deleteConversation(
  client: AgentApiClient,
  conversationId: string,
): Promise<{ deleted: boolean }> {
  return client.request({
    method: 'DELETE',
    path: `/api/agent/conversations/${encodeURIComponent(conversationId)}`,
  })
}

// -------------------- 会话运行/上下文状态 --------------------

export function getConversationState(
  client: AgentApiClient,
  conversationId: string,
): Promise<ConversationStateOut> {
  return client.request<ConversationStateOut>({
    method: 'GET',
    path: `/api/agent/conversations/${encodeURIComponent(conversationId)}/state`,
  })
}

export function getPromptReceipt(
  client: AgentApiClient,
  conversationId: string,
  idempotencyKey: string,
): Promise<PromptReceiptOut> {
  return client.request<PromptReceiptOut>({
    method: 'GET',
    path: `/api/agent/conversations/${encodeURIComponent(conversationId)}/receipts/${encodeURIComponent(idempotencyKey)}`,
  })
}

export function setConversationState(
  client: AgentApiClient,
  conversationId: string,
  state: ConversationStateValue,
): Promise<ConversationMetadata> {
  return client.request<ConversationMetadata>({
    method: 'PUT',
    path: `/api/agent/conversations/${encodeURIComponent(conversationId)}/state`,
    body: { state },
  })
}

export function getConversationContext(
  client: AgentApiClient,
  conversationId: string,
): Promise<ConversationContextOut> {
  return client.request<ConversationContextOut>({
    method: 'GET',
    path: `/api/agent/conversations/${encodeURIComponent(conversationId)}/context`,
  })
}

// 只更新思考档位,不影响其他 context 字段。
export function setThinkingLevel(
  client: AgentApiClient,
  conversationId: string,
  thinkingLevel: ThinkingLevel,
): Promise<ConversationContextOut> {
  return client.request<ConversationContextOut>({
    method: 'PATCH',
    path: `/api/agent/conversations/${encodeURIComponent(conversationId)}/context`,
    body: { thinking_level: thinkingLevel },
  })
}

// 清空模型上下文,可见历史保留;生成中会返回 409 conversation_busy。
// 记忆保存临时失败时返回 200 + confirmation_required,用户确认后带 on_memory_failure='proceed' 再调。
export function resetConversationContext(
  client: AgentApiClient,
  conversationId: string,
  body: ContextResetRequest = {},
): Promise<ContextResetResult> {
  return client.request<ContextResetResult>({
    method: 'POST',
    path: `/api/agent/conversations/${encodeURIComponent(conversationId)}/context/reset`,
    body,
  })
}

// 按结束时间正序;上线前的旧重置没有段落记录,前端按未评估处理。
export function listConversationSegments(
  client: AgentApiClient,
  conversationId: string,
): Promise<ContextSegment[]> {
  return client.request<ContextSegment[]>({
    method: 'GET',
    path: `/api/agent/conversations/${encodeURIComponent(conversationId)}/segments`,
  })
}

export function updateConversationSegment(
  client: AgentApiClient,
  conversationId: string,
  segmentId: string,
  body: ContextSegmentUpdateRequest,
): Promise<ContextSegment> {
  return client.request<ContextSegment>({
    method: 'PATCH',
    path: `/api/agent/conversations/${encodeURIComponent(conversationId)}/segments/${encodeURIComponent(segmentId)}`,
    body,
  })
}

// 让空单聊的入口员工先自我介绍。触发指令不进可见历史,只显示员工回复;每个会话只执行一次,
// 重复调用返回同一收据。会话已有消息时 409 conversation_not_empty。
export function introduceConversation(
  client: AgentApiClient,
  conversationId: string,
): Promise<PromptAccepted> {
  return client.request<PromptAccepted>({
    method: 'POST',
    path: `/api/agent/conversations/${encodeURIComponent(conversationId)}/introduction`,
  })
}

// -------------------- Prompt(核心发消息接口) --------------------

// 幂等键必传。UI 层调用者可用 crypto.randomUUID(),重试同一次操作时保持不变。
// 202 收据返回 { state: 'accepted'|'completed' };'completed' 表示是幂等重放,不会再触发 SSE。
export function submitPrompt(
  client: AgentApiClient,
  conversationId: string,
  body: PromptRequest,
  idempotencyKey: string,
): Promise<PromptAccepted> {
  return client.request<PromptAccepted>({
    method: 'POST',
    path: `/api/agent/conversations/${encodeURIComponent(conversationId)}/prompt`,
    body,
    idempotencyKey,
  })
}

/** Exact server-owned anchors only; no time/name/adjacency heuristics. */
export function attachWorkRecordIds(
  entries: ConversationEntry[], records: readonly WorkRecord[], conversationId: string,
): ConversationEntry[] {
  const indices = new Map(entries.flatMap((entry, index) => entry.entry_ref ? [[entry.entry_ref, index] as const] : []))
  const assigned = new Map<number, string>()
  const ambiguous = new Set<number>()
  for (const record of records) {
    if (record.conversation_id !== conversationId || record.provenance !== 'live' || record.outcome !== 'succeeded') continue
    const start = record.input_entry_ref ? indices.get(record.input_entry_ref) : undefined
    const end = record.output_entry_ref ? indices.get(record.output_entry_ref) : undefined
    if (start === undefined || end === undefined || start >= end) continue
    if (entries[start].message?.role !== 'user' || entries[end].message?.role !== 'assistant'
      || entries[end].source_employee_id !== record.employee_id) continue
    const candidates: number[] = []
    let valid = true
    for (let index = start + 1; index <= end; index++) {
      const entry = entries[index]
      if (entry.message?.role === 'user' && entry.participant_employee_id === record.employee_id) {
        valid = false
        break
      }
      if (entry.source_employee_id !== record.employee_id
        || (entry.message?.role !== 'assistant' && entry.message?.role !== 'toolResult')) continue
      if (entry.work_id && entry.work_id !== record.id) { valid = false; break }
      candidates.push(index)
    }
    if (!valid) continue
    for (const index of candidates) {
      if (assigned.has(index) && assigned.get(index) !== record.id) ambiguous.add(index)
      else assigned.set(index, record.id)
    }
  }
  return entries.map((entry, index) => !entry.work_id && assigned.has(index) && !ambiguous.has(index)
    ? { ...entry, work_id: assigned.get(index) } : entry)
}

// -------------------- Entries(历史) --------------------

// server.ts entries 接口返回 { data: { conversation_id, entries } },client unwrap 出 data。
export async function listEntries(
  client: AgentApiClient,
  conversationId: string,
  signal?: AbortSignal,
): Promise<{ conversation_id: string; entries: ConversationEntry[] }> {
  const entries = new Map<string, ConversationEntry>()
  const seen = new Set<string>()
  let cursor: string | undefined
  do {
    const result = await client.request<{ data: { conversation_id: string; entries: ConversationEntry[] }; page: Page }>({
      path: `/api/agent/conversations/${encodeURIComponent(conversationId)}/entries`,
      query: { limit: 100, cursor }, raw: true, signal,
    })
    for (const entry of result.data.entries) entries.set(entry.entry_ref ?? entry.id, entry)
    if (!result.page.has_more) break
    if (!result.page.next_cursor || seen.has(result.page.next_cursor)) throw new Error('消息分页游标无效')
    cursor = result.page.next_cursor
    seen.add(cursor)
  } while (cursor)
  const history = [...entries.values()]
  if (!history.some((entry) => entry.message?.role === 'assistant' && entry.entry_ref && !entry.work_id)) {
    return { conversation_id: conversationId, entries: history }
  }
  // Rolling upgrade: the existing work API already provides authoritative input/output anchors.
  // This optional enrichment must never prevent viewing history on older/unavailable services.
  try {
    const records: WorkRecord[] = []
    const workCursors = new Set<string>()
    let before: string | undefined
    do {
      const page = await client.request<WorkHistoryEnvelope>({
        path: '/api/agent/work-records', query: { limit: 100, before }, raw: true, signal,
      })
      if (!Array.isArray(page.data)) break
      records.push(...page.data.filter((record) => record.conversation_id === conversationId))
      if (!page.page.has_more) break
      if (!page.page.next_cursor || workCursors.has(page.page.next_cursor)) break
      before = page.page.next_cursor
      workCursors.add(before)
    } while (before)
    return { conversation_id: conversationId, entries: attachWorkRecordIds(history, records, conversationId) }
  } catch (error) {
    if (signal?.aborted) throw error
    return { conversation_id: conversationId, entries: history }
  }
}

// -------------------- Abort --------------------

// 服务端 AbortEnvelope:{ conversation_id, aborted: boolean }。aborted=false 说明当前
// 没有活动执行。UI 层可以据此提示"已停止"或"当前无进行中任务"。
export function abortConversation(
  client: AgentApiClient,
  conversationId: string,
): Promise<AbortResult> {
  return client.request<AbortResult>({
    method: 'POST',
    path: `/api/agent/conversations/${encodeURIComponent(conversationId)}/abort`,
  })
}
