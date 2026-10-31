import type { ConversationEntry, ConversationMetadata } from '../api/agent/types'

export interface ConversationUnreadState {
  unread?: number
  summaryAvailability?: { unreadCount: boolean }
}

// 列表徽标和 Tab 汇总必须使用相同口径，不能把不可用状态下的残留值计入 Tab。
// undefined 表示数量未知；已读会话在 store 中用 unread: undefined 表示零。
export function getConversationUnreadCount(conversation: ConversationUnreadState): number | undefined {
  if (conversation.summaryAvailability?.unreadCount === false) return undefined
  const count = conversation.unread ?? 0
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined
}

export function sumConversationUnreadCounts(conversations: readonly ConversationUnreadState[]): number {
  return conversations.reduce((total, conversation) => total + (getConversationUnreadCount(conversation) ?? 0), 0)
}

export function formatUnreadCount(count: number): string {
  return count > 99 ? '99+' : String(count)
}

// 服务端条目按时间排序；id 是不透明标识，不能通过字符串大小判断是否已读。
export function countUnreadReplies(
  entries: readonly ConversationEntry[],
  lastReadEntryId: string | null,
): number | undefined {
  const anchor = lastReadEntryId === null ? -1 : entries.findIndex((entry) => entry.id === lastReadEntryId)
  if (lastReadEntryId !== null && anchor < 0) return undefined
  const seen = new Set<string>()
  for (const entry of entries.slice(0, anchor + 1)) seen.add(entry.logical_message_id ?? entry.id)
  let count = 0
  for (const entry of entries.slice(anchor + 1)) {
    const id = entry.logical_message_id ?? entry.id
    if (seen.has(id)) continue
    const message = entry.message
    if (!message || (message.role !== 'assistant' && !(message.role === 'user' && entry.source_type === 'employee'))) continue
    const content = message.content
    const hasReply = typeof content === 'string'
      ? content.trim().length > 0
      : Array.isArray(content) && content.some((part) => (
        part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0
        || part.type === 'image'
      ))
    if (!hasReply) continue
    seen.add(id)
    count += 1
  }
  return count
}

// 优先使用后台计数；旧 Agent 只有 last_read_entry_id 时从真实 entries 补齐。
// 限制并发，单个历史请求失败时保留“未读数量未提供”的可用性状态。
export async function fillConversationUnreadCounts(
  conversations: readonly ConversationMetadata[],
  listEntries: (id: string) => Promise<{ entries: ConversationEntry[] }>,
): Promise<ConversationMetadata[]> {
  const result: ConversationMetadata[] = []
  for (let offset = 0; offset < conversations.length; offset += 6) {
    result.push(...await Promise.all(conversations.slice(offset, offset + 6).map(async (conversation) => {
      if (Number.isInteger(conversation.unread_count) && conversation.unread_count! >= 0) return conversation
      try {
        const { entries } = await listEntries(conversation.id)
        const unreadCount = countUnreadReplies(entries, conversation.last_read_entry_id)
        return unreadCount === undefined ? conversation : { ...conversation, unread_count: unreadCount }
      } catch {
        return conversation
      }
    })))
  }
  return result
}
