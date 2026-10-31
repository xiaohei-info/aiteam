import type { UploadableChatFile } from './chatAttachmentUpload'

/**
 * 生成中输入的消息先在输入框上方排队，上一轮结束后按顺序逐条发送。
 * 队列按会话隔离；纯函数便于测试，组件只负责持有状态与触发发送。
 */
export interface QueuedChatMessage<Snapshot = unknown> {
  id: string
  text: string
  files: UploadableChatFile[]
  employeeId?: string
  mentions?: string[]
  /** 群聊 @ 输入框的 DOM 快照，编辑时原样放回，保留 @ 成员标签。 */
  mentionSnapshot?: Snapshot
}

export type ChatSendQueues<Snapshot = unknown> = Record<string, QueuedChatMessage<Snapshot>[]>

export function enqueueMessage<S>(queues: ChatSendQueues<S>, convId: string, message: QueuedChatMessage<S>): ChatSendQueues<S> {
  return { ...queues, [convId]: [...(queues[convId] ?? []), message] }
}

/** 发送失败的队首消息放回最前面，保持原有顺序。 */
export function prependQueuedMessage<S>(queues: ChatSendQueues<S>, convId: string, message: QueuedChatMessage<S>): ChatSendQueues<S> {
  return { ...queues, [convId]: [message, ...(queues[convId] ?? [])] }
}

/** 编辑排队消息时，输入框里原有的内容占用它的位置；replacement 为空则直接移除。 */
export function replaceQueuedMessage<S>(
  queues: ChatSendQueues<S>,
  convId: string,
  id: string,
  replacement: QueuedChatMessage<S> | null,
): ChatSendQueues<S> {
  if (!replacement) return removeQueuedMessage(queues, convId, id)
  const queue = queues[convId]
  if (!queue?.some((item) => item.id === id)) return queues
  return { ...queues, [convId]: queue.map((item) => item.id === id ? replacement : item) }
}

export function removeQueuedMessage<S>(queues: ChatSendQueues<S>, convId: string, id: string): ChatSendQueues<S> {
  const queue = queues[convId]
  if (!queue?.some((item) => item.id === id)) return queues
  return withQueue(queues, convId, queue.filter((item) => item.id !== id))
}

/** 拖拽排序：把 fromId 移到 toId 所在的位置。 */
export function moveQueuedMessage<S>(queues: ChatSendQueues<S>, convId: string, fromId: string, toId: string): ChatSendQueues<S> {
  const queue = queues[convId] ?? []
  const from = queue.findIndex((item) => item.id === fromId)
  const to = queue.findIndex((item) => item.id === toId)
  if (from < 0 || to < 0 || from === to) return queues
  const next = [...queue]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return { ...queues, [convId]: next }
}

/** 立即发送：移到队首，等当前这轮结束（或被中止）后第一个发出。 */
export function promoteQueuedMessage<S>(queues: ChatSendQueues<S>, convId: string, id: string): ChatSendQueues<S> {
  const queue = queues[convId] ?? []
  const index = queue.findIndex((item) => item.id === id)
  if (index <= 0) return queues
  return { ...queues, [convId]: [queue[index], ...queue.slice(0, index), ...queue.slice(index + 1)] }
}

/** 取出队首；队列为空时 message 为 undefined。 */
export function takeNextQueuedMessage<S>(queues: ChatSendQueues<S>, convId: string): {
  message: QueuedChatMessage<S> | undefined
  queues: ChatSendQueues<S>
} {
  const queue = queues[convId]
  if (!queue?.length) return { message: undefined, queues }
  return { message: queue[0], queues: withQueue(queues, convId, queue.slice(1)) }
}

/** emp_ 占位会话升级为真实会话时，队列跟着迁移，并接在已有队列之后。 */
export function renameQueue<S>(queues: ChatSendQueues<S>, fromConvId: string, toConvId: string): ChatSendQueues<S> {
  const queue = queues[fromConvId]
  if (!queue?.length || fromConvId === toConvId) return queues
  const next = withQueue(queues, fromConvId, [])
  return { ...next, [toConvId]: [...(next[toConvId] ?? []), ...queue] }
}

/** 是否应该从队列发出下一条：本轮已结束（含结束后的历史对齐）、输入框可用、没有正在提交的请求。 */
export function shouldDispatchQueue(state: {
  queueLength: number
  isGenerating: boolean
  isSyncing: boolean
  disabled: boolean
  isSubmitting: boolean
}): boolean {
  return state.queueLength > 0 && !state.isGenerating && !state.isSyncing && !state.disabled && !state.isSubmitting
}

function withQueue<S>(queues: ChatSendQueues<S>, convId: string, queue: QueuedChatMessage<S>[]): ChatSendQueues<S> {
  if (queue.length > 0) return { ...queues, [convId]: queue }
  const next = { ...queues }
  delete next[convId]
  return next
}
