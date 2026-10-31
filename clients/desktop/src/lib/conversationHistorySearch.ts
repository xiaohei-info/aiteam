import type {
  ConversationEntry,
  ConversationMetadata,
  Page,
  SolutionProjection,
} from '../api/agent/types'
import { splitLocalContext } from './localContextBlock.ts'

const DEFAULT_CONVERSATION_PAGE_SIZE = 100
const DEFAULT_ENTRY_CONCURRENCY = 4
const SNIPPET_CONTEXT_LENGTH = 64

export interface ConversationHistorySearchFilters {
  query: string
  employeeId?: string
  startAt?: number
  endAt?: number
}

export interface ConversationHistorySearchProgress {
  phase: 'conversations' | 'entries'
  discoveredConversations: number
  scannedConversations: number
  totalConversations: number | null
  failedConversations: number
  matchedEntries: number
}

export interface ConversationHistorySearchFailure {
  conversationId: string
  conversationTitle: string
  reason: string
}

export interface ConversationHistorySearchResult {
  key: string
  conversation: ConversationMetadata
  entryId: string
  text: string
  snippet: string
  timestamp: number | null
  senderName: string
  senderEmployeeId?: string
}

export interface ConversationHistorySearchResponse {
  results: ConversationHistorySearchResult[]
  discoveredConversations: number
  scannedConversations: number
  failures: ConversationHistorySearchFailure[]
}

export interface ConversationHistorySearchApi {
  listConversations: (
    params: { cursor?: string; limit: number },
    signal: AbortSignal,
  ) => Promise<{ conversations: ConversationMetadata[]; page: Page }>
  listEntries: (
    conversationId: string,
    signal: AbortSignal,
  ) => Promise<{ conversation_id: string; entries: ConversationEntry[] }>
}

export interface ConversationHistorySearchOptions {
  signal: AbortSignal
  concurrency?: number
  conversationEmployeeIds?: ReadonlyMap<string, readonly string[]>
  solutionEmployeeIds?: ReadonlyMap<string, readonly string[]>
  onProgress?: (progress: ConversationHistorySearchProgress) => void
}

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') return new DOMException('Search aborted', 'AbortError')
  const error = new Error('Search aborted')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw createAbortError()
}

export function isHistorySearchAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase()
}

/** 只索引真正渲染成消息正文的 string/text parts，不把思考过程或工具参数伪装成聊天消息。 */
export function getHistoryEntryText(entry: ConversationEntry): string {
  if (entry.message?.role !== 'user' && entry.message?.role !== 'assistant') return ''
  const content = entry.message?.content
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = content
      .filter((part): part is Extract<typeof part, { type: 'text' }> => part?.type === 'text')
      .map((part) => part.text)
      .join('')
  }
  // 网关附带的授权目录检索块不是用户输入，不参与历史搜索。
  return (entry.message?.role === 'user' ? splitLocalContext(text).text : text).trim()
}

/** 接受 FredServer ConversationEntry 的 ISO 或 Unix 毫秒 timestamp；无法确认时返回 null。 */
export function getHistoryEntryTimestamp(entry: ConversationEntry): number | null {
  const raw = entry.timestamp
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw
  }
  if (typeof raw !== 'string' || !raw.trim()) return null
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? null : parsed
}

/** 将 date input 的本地日期转换为包含整天的毫秒边界。 */
export function parseHistorySearchDate(value: string, endOfDay = false): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return undefined
  }
  return date.getTime()
}

/** 按 solution id 建立群成员索引，覆盖尚未进入本地 groups 首屏的历史群聊。 */
export function buildSolutionEmployeeIds(
  solutions: readonly SolutionProjection[],
): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, readonly string[]>()
  for (const solution of solutions) {
    if (!solution.solution_instance_id) continue
    const employeeIds = [
      ...(solution.expert_employee_ids ?? []),
      solution.coordinator_employee_id,
    ].filter((id): id is string => Boolean(id))
    result.set(solution.solution_instance_id, [...new Set(employeeIds)])
  }
  return result
}

function buildSnippet(text: string, normalizedQuery: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  const matchIndex = compact.toLocaleLowerCase().indexOf(normalizedQuery)
  if (matchIndex < 0) return compact.slice(0, SNIPPET_CONTEXT_LENGTH * 2)
  const start = Math.max(0, matchIndex - SNIPPET_CONTEXT_LENGTH)
  const end = Math.min(
    compact.length,
    matchIndex + normalizedQuery.length + SNIPPET_CONTEXT_LENGTH,
  )
  return `${start > 0 ? '…' : ''}${compact.slice(start, end)}${end < compact.length ? '…' : ''}`
}

function readEntryEmployeeId(entry: ConversationEntry): string | undefined {
  if (entry.source_type === 'employee') return entry.source_id ?? entry.source_employee_id
  if (entry.message?.role === 'assistant') return entry.source_employee_id ?? entry.source_id
  return undefined
}

function conversationMatchesEmployee(
  conversation: ConversationMetadata,
  entry: ConversationEntry,
  employeeId: string | undefined,
  conversationEmployeeIds: ReadonlyMap<string, readonly string[]> | undefined,
  solutionEmployeeIds: ReadonlyMap<string, readonly string[]> | undefined,
): boolean {
  if (!employeeId) return true
  if (conversation.entry_employee_id === employeeId) return true
  if (conversation.coordinator_employee_id === employeeId) return true
  if (conversationEmployeeIds?.get(conversation.id)?.includes(employeeId)) return true
  if (conversation.solution_instance_id
    && solutionEmployeeIds?.get(conversation.solution_instance_id)?.includes(employeeId)) {
    return true
  }
  return readEntryEmployeeId(entry) === employeeId
}

function entryMatchesFilters(
  entry: ConversationEntry,
  conversation: ConversationMetadata,
  filters: ConversationHistorySearchFilters,
  normalizedQuery: string,
  conversationEmployeeIds: ReadonlyMap<string, readonly string[]> | undefined,
  solutionEmployeeIds: ReadonlyMap<string, readonly string[]> | undefined,
): { text: string; timestamp: number | null } | null {
  const text = getHistoryEntryText(entry)
  if (!text || !text.toLocaleLowerCase().includes(normalizedQuery)) return null
  if (!conversationMatchesEmployee(
    conversation,
    entry,
    filters.employeeId,
    conversationEmployeeIds,
    solutionEmployeeIds,
  )) {
    return null
  }

  const timestamp = getHistoryEntryTimestamp(entry)
  if (filters.startAt !== undefined && (timestamp === null || timestamp < filters.startAt)) return null
  if (filters.endAt !== undefined && (timestamp === null || timestamp > filters.endAt)) return null
  return { text, timestamp }
}

export function filterConversationHistoryEntries(
  conversation: ConversationMetadata,
  entries: readonly ConversationEntry[],
  filters: ConversationHistorySearchFilters,
  conversationEmployeeIds?: ReadonlyMap<string, readonly string[]>,
  solutionEmployeeIds?: ReadonlyMap<string, readonly string[]>,
): ConversationHistorySearchResult[] {
  const normalizedQuery = normalizeSearchText(filters.query)
  if (!normalizedQuery) return []

  const results: ConversationHistorySearchResult[] = []
  for (const entry of entries) {
    if (!entry?.id) continue
    const match = entryMatchesFilters(
      entry,
      conversation,
      filters,
      normalizedQuery,
      conversationEmployeeIds,
      solutionEmployeeIds,
    )
    if (!match) continue
    const senderEmployeeId = readEntryEmployeeId(entry)
    const isUser = entry.message?.role === 'user' && entry.source_type !== 'employee'
    results.push({
      key: `${conversation.id}:${entry.id}`,
      conversation,
      entryId: entry.id,
      text: match.text,
      snippet: buildSnippet(match.text, normalizedQuery),
      timestamp: match.timestamp,
      senderName: isUser
        ? '我'
        : entry.source_display_name
          ?? entry.source_employee_display_name
          ?? 'AI 员工',
      senderEmployeeId,
    })
  }
  return results
}

function safeFailureReason(error: unknown): string {
  const status = error && typeof error === 'object' && 'status' in error
    ? (error as { status?: unknown }).status
    : undefined
  if (status === 403) return '无权读取此会话'
  if (status === 404) return '会话已不存在'
  if (status === 410 || status === 503) return '服务暂不可用'
  if (status === 0 || error instanceof TypeError) return '网络连接失败'
  return '读取消息失败'
}

async function loadAllConversations(
  api: ConversationHistorySearchApi,
  signal: AbortSignal,
  onProgress: ConversationHistorySearchOptions['onProgress'],
): Promise<ConversationMetadata[]> {
  const conversations: ConversationMetadata[] = []
  const seenConversationIds = new Set<string>()
  const seenCursors = new Set<string>()
  let cursor: string | undefined

  while (true) {
    throwIfAborted(signal)
    const page = await api.listConversations(
      { cursor, limit: DEFAULT_CONVERSATION_PAGE_SIZE },
      signal,
    )
    throwIfAborted(signal)
    for (const conversation of page.conversations ?? []) {
      if (!conversation?.id || seenConversationIds.has(conversation.id)) continue
      seenConversationIds.add(conversation.id)
      conversations.push(conversation)
    }
    onProgress?.({
      phase: 'conversations',
      discoveredConversations: conversations.length,
      scannedConversations: 0,
      totalConversations: page.page?.has_more ? null : conversations.length,
      failedConversations: 0,
      matchedEntries: 0,
    })

    if (!page.page?.has_more) return conversations
    const nextCursor = page.page.next_cursor
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new Error('会话分页游标无效，无法确认已读取全部会话。')
    }
    seenCursors.add(nextCursor)
    cursor = nextCursor
  }
}

/**
 * 基于真实 Agent API 做客户端聚合搜索。会话目录完整分页，每个会话 entries 全量读取，
 * 通过固定 worker 数限制并发；单会话失败被收集，目录失败与取消直接抛出。
 */
export async function searchConversationHistory(
  api: ConversationHistorySearchApi,
  filters: ConversationHistorySearchFilters,
  options: ConversationHistorySearchOptions,
): Promise<ConversationHistorySearchResponse> {
  const normalizedQuery = normalizeSearchText(filters.query)
  if (!normalizedQuery) throw new Error('请输入搜索关键词。')
  if (filters.startAt !== undefined && filters.endAt !== undefined && filters.startAt > filters.endAt) {
    throw new Error('开始日期不能晚于结束日期。')
  }

  const { signal, onProgress, conversationEmployeeIds, solutionEmployeeIds } = options
  const conversations = await loadAllConversations(api, signal, onProgress)
  const results: ConversationHistorySearchResult[] = []
  const failures: ConversationHistorySearchFailure[] = []
  let nextIndex = 0
  let scannedConversations = 0
  const requestedConcurrency = Math.floor(options.concurrency ?? DEFAULT_ENTRY_CONCURRENCY)
  const concurrency = Math.max(1, Math.min(requestedConcurrency, conversations.length || 1))

  const emitEntryProgress = () => onProgress?.({
    phase: 'entries',
    discoveredConversations: conversations.length,
    scannedConversations,
    totalConversations: conversations.length,
    failedConversations: failures.length,
    matchedEntries: results.length,
  })

  emitEntryProgress()
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      throwIfAborted(signal)
      const index = nextIndex
      nextIndex += 1
      const conversation = conversations[index]
      if (!conversation) return

      try {
        const response = await api.listEntries(conversation.id, signal)
        throwIfAborted(signal)
        results.push(...filterConversationHistoryEntries(
          conversation,
          response.entries ?? [],
          filters,
          conversationEmployeeIds,
          solutionEmployeeIds,
        ))
      } catch (error) {
        if (signal.aborted || isHistorySearchAbortError(error)) throw createAbortError()
        failures.push({
          conversationId: conversation.id,
          conversationTitle: conversation.title?.trim() || '未命名会话',
          reason: safeFailureReason(error),
        })
      } finally {
        scannedConversations += 1
        emitEntryProgress()
      }
    }
  })

  await Promise.all(workers)
  throwIfAborted(signal)
  results.sort((left, right) => {
    if (left.timestamp !== right.timestamp) return (right.timestamp ?? -1) - (left.timestamp ?? -1)
    const updatedDelta = Date.parse(right.conversation.updated_at) - Date.parse(left.conversation.updated_at)
    if (Number.isFinite(updatedDelta) && updatedDelta !== 0) return updatedDelta
    return left.key.localeCompare(right.key)
  })

  return {
    results,
    discoveredConversations: conversations.length,
    scannedConversations,
    failures,
  }
}
