/**
 * 会话列表的活动信号补丁。
 *
 * 服务端在任意 prompt 结束时广播一条全局活动信号（见 `GET /api/agent/events`），
 * 其中只带列表摘要字段（preview / 时间 / 本轮回复条数），不携带会话正文。
 * 前端用它在不整表刷新的情况下更新对应列表项，并把该项提到最前。
 *
 * 这是纯函数，不依赖 store 或具体的时间格式化实现，便于单测。
 */
import type { ConversationSummaryAvailability } from './conversationSummary'
import type { GlobalActivityEvent } from '../api/agent/globalEvents'

export type PromptSettledActivity = Extract<GlobalActivityEvent, { type: 'prompt_settled' }>

export interface ActivityPatchTarget {
  id: string
  lastMessage: string
  time: string
  unread?: number
  lastMessageAt?: number
  summaryAvailability?: ConversationSummaryAvailability | undefined
}

export interface ActivityPatchOptions {
  conversationId: string
  event: PromptSettledActivity
  /** 该会话是否正在被查看：正在查看时未读清零，否则累加。 */
  isActive: boolean
  /** 与列表构建保持同一套相对时间口径。 */
  formatTime: (timestamp: number) => string
}

/**
 * 用活动信号补丁列表项：更新摘要、时间与未读，并把该项提到最前。
 *
 * 只改对应项，其他项相对顺序不变（置顶由 Panel 另行处理）。未读只在「不是在查看」时累加，
 * 正在查看的会话由聊天视图展示并清零。事件不携带正文，preview 只作为列表摘要。
 */
export function patchActivityItem<T extends ActivityPatchTarget>(items: readonly T[], options: ActivityPatchOptions): T[] {
  const { conversationId, event, isActive, formatTime } = options
  const index = items.findIndex((item) => item.id === conversationId)
  const current = index >= 0 ? items[index] : undefined
  if (!current) return [...items]
  const lastMessageAt = Date.parse(event.last_message_at)
  if (!Number.isFinite(lastMessageAt)) return [...items]
  const patched: T = {
    ...current,
    lastMessage: event.last_preview || current.lastMessage,
    lastMessageAt,
    time: formatTime(lastMessageAt),
    unread: isActive ? 0 : (current.unread ?? 0) + (event.assistant_message_count ?? 1),
    summaryAvailability: undefined,
  }
  return [patched, ...items.slice(0, index), ...items.slice(index + 1)]
}
