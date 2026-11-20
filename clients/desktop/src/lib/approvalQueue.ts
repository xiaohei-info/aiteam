/**
 * 审批队列的挑选逻辑（从 UI 抽出来是为了能直接测）。
 *
 * 规则（设计 2026-11-19 §3.1）：同一会话的多条待批合并成一个队列卡片，一次只显示一条；
 * 正在等浏览器登录（signing_in）的条目不挡住新来的审批；按会话分组，卡片上显示「第 N / M 条」。
 */

export interface QueueEntry {
  approvalId: string
  conversationId: string
  phase: string
}

/** 该条是否正在等浏览器登录（这类条目排在新审批之后）。 */
export function isWaitingSignIn(entry: QueueEntry): boolean {
  return entry.phase === 'signing_in'
}

/** 同一会话内、非 signing_in 的可见条目顺序（按给定顺序稳定）。 */
export function visibleQueue<T extends QueueEntry>(pending: readonly T[], conversationId: string): T[] {
  return pending.filter((item) => item.conversationId === conversationId && !isWaitingSignIn(item))
}

/** 当前应显示的审批：优先非 signing_in 的条目（按会话分组、组内取最早），否则取第一条 signing_in。 */
export function pickCurrent<T extends QueueEntry>(pending: readonly T[]): T | undefined {
  const fresh = pending.filter((item) => !isWaitingSignIn(item))
  if (fresh.length > 0) {
    // 分组后取「组内第一条」；会话按首次出现顺序，保证稳定性。
    const firstByConversation = new Map<string, T>()
    for (const item of fresh) if (!firstByConversation.has(item.conversationId)) firstByConversation.set(item.conversationId, item)
    return fresh.find((item) => firstByConversation.get(item.conversationId) === item)
  }
  return pending[0]
}

/** 该审批在其会话队列里的位置（1 起）与队列长度。 */
export function queuePosition<T extends QueueEntry>(pending: readonly T[], target: T): { index: number; total: number } {
  const queue = visibleQueue(pending, target.conversationId)
  const index = queue.findIndex((item) => item.approvalId === target.approvalId)
  return { index: index < 0 ? 0 : index + 1, total: queue.length }
}
