import type { ConversationMetadata } from '../api/agent/types'

export interface ConversationSummaryAvailability {
  preview: boolean
  unreadCount: boolean
  lastMessageAt: boolean
}

export interface ResolvedConversationSummary {
  preview: string
  unreadCount: number | undefined
  lastMessageAt: number | undefined
  availability: ConversationSummaryAvailability
}

export function formatConversationTime(timestamp: number | null | undefined, now = new Date()): string {
  if (timestamp == null || !Number.isFinite(timestamp)) return ''
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return ''
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === now.toDateString()) return time
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`
  const monthDay = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const day = date.getFullYear() === now.getFullYear() ? monthDay : `${date.getFullYear()}-${monthDay}`
  return `${day} ${time}`
}

const hasOwn = (source: ConversationMetadata, key: keyof ConversationMetadata): boolean =>
  Object.prototype.hasOwnProperty.call(source, key)

export function resolveConversationSummary(
  conversation: ConversationMetadata,
): ResolvedConversationSummary {
  const previewAvailable = hasOwn(conversation, 'last_preview')
    && (conversation.last_preview === null || typeof conversation.last_preview === 'string')
  const preview = previewAvailable && typeof conversation.last_preview === 'string'
    ? conversation.last_preview.slice(0, 20)
    : ''

  const unreadAvailable = hasOwn(conversation, 'unread_count')
    && Number.isInteger(conversation.unread_count)
    && (conversation.unread_count ?? -1) >= 0
  const unreadCount = unreadAvailable && conversation.unread_count
    ? conversation.unread_count
    : undefined

  const lastMessageValue = conversation.last_message_at
  const parsedLastMessageAt = typeof lastMessageValue === 'string'
    ? Date.parse(lastMessageValue)
    : Number.NaN
  const lastMessageAtAvailable = hasOwn(conversation, 'last_message_at')
    && (lastMessageValue === null || Number.isFinite(parsedLastMessageAt))

  return {
    preview,
    unreadCount,
    lastMessageAt: lastMessageAtAvailable && Number.isFinite(parsedLastMessageAt)
      ? parsedLastMessageAt
      : undefined,
    availability: {
      preview: previewAvailable,
      unreadCount: unreadAvailable,
      lastMessageAt: lastMessageAtAvailable,
    },
  }
}
