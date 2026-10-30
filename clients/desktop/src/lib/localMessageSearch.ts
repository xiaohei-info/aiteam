import type { ConversationMetadata } from '../api/agent/types'
import type { MessageSearchEnvelope } from '../api/agent/observations.types'
import type { ConversationHistorySearchFilters, ConversationHistorySearchOptions, ConversationHistorySearchResponse } from './conversationHistorySearch'

interface LocalSearchApi {
  searchMessages: (params: { q: string; employee_id?: string; cursor?: string; limit: number }, signal: AbortSignal) => Promise<MessageSearchEnvelope>
  getConversation: (id: string) => Promise<ConversationMetadata>
}

export async function searchLocalMessages(api: LocalSearchApi, filters: ConversationHistorySearchFilters, options: ConversationHistorySearchOptions): Promise<ConversationHistorySearchResponse> {
  const conversations = new Map<string, ConversationMetadata>()
  const results = new Map<string, ConversationHistorySearchResponse['results'][number]>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  do {
    options.signal.throwIfAborted()
    const page = await api.searchMessages({ q: filters.query.trim(), employee_id: filters.employeeId, limit: 100, cursor }, options.signal)
    for (const hit of page.data) {
      options.signal.throwIfAborted()
      const timestamp = Date.parse(hit.timestamp)
      if (filters.startAt !== undefined && timestamp < filters.startAt) continue
      if (filters.endAt !== undefined && timestamp > filters.endAt) continue
      let conversation = conversations.get(hit.conversation_id)
      if (!conversation) {
        conversation = await api.getConversation(hit.conversation_id)
        conversations.set(hit.conversation_id, conversation)
      }
      const key = `${hit.conversation_id}:${hit.entry_ref}`
      results.set(key, { key, conversation, entryId: hit.entry_ref, text: hit.snippet, snippet: hit.snippet, timestamp,
        senderEmployeeId: hit.source_employee_id,
        senderName: hit.source_display_name ?? hit.source_employee_display_name ?? (hit.role === 'user' && hit.source_type !== 'employee' ? '我' : 'AI 员工'),
      })
    }
    options.onProgress?.({ phase: 'entries', discoveredConversations: conversations.size, scannedConversations: conversations.size, totalConversations: null, failedConversations: 0, matchedEntries: results.size })
    if (!page.page.has_more) break
    if (!page.page.next_cursor || cursors.has(page.page.next_cursor)) throw new Error('消息搜索游标无效')
    cursor = page.page.next_cursor
    cursors.add(cursor)
  } while (cursor)
  return { results: [...results.values()], discoveredConversations: conversations.size, scannedConversations: conversations.size, failures: [] }
}
