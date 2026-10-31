import type { ContextResetMemoryReason, ContextResetResult } from '../api/agent/types'

const REASON_LABELS: Record<ContextResetMemoryReason, string> = {
  saved: '已提交保存',
  empty: '没有可保存的内容',
  skipped: '已选择不保存',
  retain_disabled: '员工未开启记忆保存',
  policy: '记忆策略不允许保存',
  unauthorized: '登录已失效',
  too_large: '对话内容超出保存上限',
  manager_unavailable: '记忆服务暂不可用',
  retention_unverified: '无法确认是否已保存',
  timeout: '记忆服务响应超时',
  error: '保存失败',
}

// 这几类是临时失败:后端默认不重置,需要用户确认后带 on_memory_failure='proceed' 再调。
const FAILURES = new Set<ContextResetMemoryReason>(['unauthorized', 'too_large', 'manager_unavailable', 'retention_unverified', 'timeout'])

export function isContextResetMemoryReason(value: unknown): value is ContextResetMemoryReason {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(REASON_LABELS, value)
}

export function memoryReasonLabel(reason: ContextResetMemoryReason): string {
  return REASON_LABELS[reason]
}

export function isMemoryFailure(reason: ContextResetMemoryReason): boolean {
  return FAILURES.has(reason)
}

/** 分隔线上的记忆状态;群聊各参与者共享一条分隔线,按全部参与者的结果汇总。没有记录时返回 null。 */
export function dividerMemoryText(reasons: readonly ContextResetMemoryReason[]): string | null {
  if (reasons.length === 0) return null
  const unsaved = reasons.filter((reason) => reason !== 'saved')
  if (unsaved.length === 0) return '记忆已保存'
  if (unsaved.length < reasons.length) return `部分成员记忆未保存：${memoryReasonLabel(unsaved[0])}`
  return `记忆未保存：${memoryReasonLabel(unsaved[0])}`
}

/** 需要用户确认时的原因说明;多个参与者失败原因不同时只列不重复的。 */
export function confirmationReasonText(result: ContextResetResult): string {
  const reasons = [...new Set(result.participants
    .filter((p) => !p.reset && isMemoryFailure(p.memory_reason))
    .map((p) => memoryReasonLabel(p.memory_reason)))]
  return reasons.join('、')
}

export interface ContextResetNotice {
  tone: 'ok' | 'warn'
  text: string
}

/**
 * 一次重置请求结束后的提示;confirmation_required 由调用方弹确认框,这里不处理。
 * 记忆未保存时返回 null:对话里的新上下文分隔线已显示该状态,不再在顶部重复提示。
 */
export function contextResetNotice(result: ContextResetResult): ContextResetNotice | null {
  if (!result.reset) return { tone: 'warn', text: '当前没有可重置的上下文。' }
  if (result.already_reset) return { tone: 'ok', text: '已经是新上下文，无需重复开启。' }
  const reasons = result.participants.filter((p) => p.reset).map((p) => p.memory_reason)
  const unsaved = reasons.find((reason) => reason !== 'saved')
  if (unsaved === undefined) return { tone: 'ok', text: '已开启新上下文，关键记忆已提交保存。' }
  if (unsaved === 'empty' && reasons.every((reason) => reason === 'empty' || reason === 'saved')) {
    return { tone: 'ok', text: '已开启新上下文。' }
  }
  return null
}
