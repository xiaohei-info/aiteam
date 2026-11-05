import { formatConversationTime } from '../../lib/conversationSummary'

export function formatTime(value: number | null): string {
  return formatConversationTime(value) || '—'
}

export const errorText = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback)
