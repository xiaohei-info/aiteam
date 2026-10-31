import type {
  ContextOutcomeReason,
  ContextResetRequest,
  ContextResetResult,
  ContextSegment,
  ContextSegmentEvaluation,
  ContextSegmentOutcome,
  ContextSegmentUpdateRequest,
} from '../api/agent/types.ts'
import type { Message } from '../stores/chat.ts'
import { contextResetNotice, type ContextResetNotice } from './contextResetMemory.ts'
import { contextResetPlacement, type ContextResetDividers } from './piConverters.ts'

export const MAX_OUTCOME_NOTE_CHARS = 500

export const OUTCOME_REASONS: ReadonlyArray<{ value: ContextOutcomeReason; label: string }> = [
  { value: 'off_topic', label: '答非所问' },
  { value: 'missing_info', label: '信息不够' },
  { value: 'execution_failed', label: '执行失败' },
  { value: 'wrong_result', label: '结果不对' },
  { value: 'too_slow', label: '太慢' },
  { value: 'other', label: '其他' },
]

const OUTCOME_LABELS: Record<ContextSegmentOutcome, string> = { resolved: '已解决', unresolved: '未解决' }

export function outcomeReasonLabel(reason: ContextOutcomeReason): string {
  return OUTCOME_REASONS.find((item) => item.value === reason)?.label ?? reason
}

/** 用户在提示条或修改评估里填的结果;原因、备注和待跟进只属于「未解决」。 */
export interface ContextOutcomeDraft {
  outcome: ContextSegmentOutcome
  reasons: ContextOutcomeReason[]
  note: string
  followUp: boolean
}

export const emptyOutcomeDraft = (outcome: ContextSegmentOutcome): ContextOutcomeDraft => ({ outcome, reasons: [], note: '', followUp: false })

export function segmentOutcomeDraft(segment: ContextSegment): ContextOutcomeDraft {
  return {
    outcome: segment.outcome ?? 'resolved',
    reasons: [...segment.outcome_reasons],
    note: segment.outcome_note ?? '',
    followUp: segment.follow_up,
  }
}

/** 当前上下文段:最后一条"新上下文"分隔线之后的消息;没有分隔线时为全部消息。 */
export function currentSegmentMessages<T extends Pick<Message, 'id' | 'entryRefs'>>(messages: readonly T[], dividers: ContextResetDividers): T[] {
  let start = 0
  messages.forEach((msg, index) => {
    const placement = contextResetPlacement(msg, index, dividers)
    if (placement.before) start = index
    if (placement.after) start = index + 1
  })
  return messages.slice(start)
}

/**
 * 「解决了吗」提示条:本段有用户消息、最后一条是已结束的员工回复、当前没在生成时出现。
 * 关掉后到下一次回复结束前不再出现(dismissed 由调用方在新一轮生成开始时清除)。
 */
export function shouldShowOutcomePrompt(input: {
  segment: ReadonlyArray<Pick<Message, 'role' | '_pending'>>
  generating: boolean
  dismissed: boolean
}): boolean {
  if (input.generating || input.dismissed) return false
  const last = input.segment[input.segment.length - 1]
  if (!last || last.role !== 'assistant' || last._pending) return false
  return input.segment.some((msg) => msg.role === 'user')
}

/** 评估字段:已解决只带 outcome;未解决只带填写过的原因、备注和待跟进。 */
export function outcomeEvaluation(draft: ContextOutcomeDraft): ContextSegmentEvaluation & { outcome: ContextSegmentOutcome } {
  if (draft.outcome === 'resolved') return { outcome: 'resolved' }
  const note = [...draft.note.trim()].slice(0, MAX_OUTCOME_NOTE_CHARS).join('')
  const reasons = OUTCOME_REASONS.map((item) => item.value).filter((reason) => draft.reasons.includes(reason))
  return {
    outcome: 'unresolved',
    ...(reasons.length ? { outcome_reasons: reasons } : {}),
    ...(note ? { outcome_note: note } : {}),
    ...(draft.followUp ? { follow_up: true } : {}),
  }
}

/**
 * 重置请求体。记忆保存失败、用户确认继续时带 on_memory_failure='proceed',评估字段必须原样再带一次。
 * evaluation 为 null 表示旧版 Agent 不认识评估字段,只做重置。
 */
export function contextResetRequest(evaluation: ContextSegmentEvaluation | null, proceed: boolean): ContextResetRequest {
  return { ...(evaluation ?? {}), ...(proceed ? { on_memory_failure: 'proceed' as const } : {}) }
}

/** 修改评估的请求体;draft 为 null 表示撤销评估。PATCH 整体替换,未带的原因、备注会被清空。 */
export function segmentUpdateRequest(draft: ContextOutcomeDraft | null, revision: number): ContextSegmentUpdateRequest {
  return draft ? { ...outcomeEvaluation(draft), revision } : { outcome: null, revision }
}

/** 修改评估时草稿是否和已保存的评估不同;按提交内容比较,已解决时残留的原因、备注不算改动。未评估的段落任何选择都算改动。 */
export function isOutcomeDraftChanged(segment: ContextSegment, draft: ContextOutcomeDraft): boolean {
  if (!segment.outcome) return true
  return JSON.stringify(outcomeEvaluation(draft)) !== JSON.stringify(outcomeEvaluation(segmentOutcomeDraft(segment)))
}

/** 旧版随包 Agent 不认识评估字段,请求体校验返回 422 invalid_request;此时去掉评估重发,只重置。 */
export function isOutcomeUnsupportedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const { status, code } = err as { status?: unknown; code?: unknown }
  return status === 422 && code === 'invalid_request'
}

/** 带评估的重置结束后的顶部提示;记忆状态仍由分隔线展示。 */
export function contextOutcomeNotice(result: ContextResetResult, outcomeRecorded: boolean): ContextResetNotice | null {
  const base = contextResetNotice(result)
  if (!result.reset || result.already_reset) return base
  if (!outcomeRecorded) return { tone: 'ok', text: '已开启新上下文，当前版本暂不记录评估。' }
  if (result.outcome) return { tone: 'ok', text: `已记为${OUTCOME_LABELS[result.outcome]}，已开启新上下文。` }
  return base
}

/** 按 segment_id 合并段落评估;segment_id 等于历史里重置标记的 reset_id。 */
export function segmentsByResetId(segments: readonly ContextSegment[]): Map<string, ContextSegment> {
  return new Map(segments.map((segment) => [segment.segment_id, segment]))
}

/** 新段落或修改后的段落替换同 ID 的旧记录,按结束时间保持正序。 */
export function upsertSegment(segments: readonly ContextSegment[], next: ContextSegment): ContextSegment[] {
  return [...segments.filter((segment) => segment.segment_id !== next.segment_id), next]
    .sort((a, b) => Date.parse(a.ended_at) - Date.parse(b.ended_at))
}

export interface DividerOutcome {
  tone: ContextSegmentOutcome | 'none'
  text: string
}

/** 分隔线上的结果;上线前的旧重置没有段落记录,和撤销后的段落一样显示为未评估。 */
export function dividerOutcome(segment: ContextSegment | undefined): DividerOutcome {
  if (!segment?.outcome) return { tone: 'none', text: '未评估' }
  if (segment.outcome === 'resolved') return { tone: 'resolved', text: '✓ 已解决' }
  const reasons = segment.outcome_reasons.map(outcomeReasonLabel)
  return { tone: 'unresolved', text: reasons.length ? `↻ 未解决：${reasons.join('、')}` : '↻ 未解决' }
}

/** 以 resetId 这条分隔线结束的那段消息:上一条分隔线之后到它为止;找不到该分隔线时为空。 */
export function endedSegmentMessages<T extends Pick<Message, 'id' | 'entryRefs'>>(
  messages: readonly T[], dividers: ContextResetDividers, resetId: string,
): T[] {
  let start = 0
  for (let index = 0; index < messages.length; index += 1) {
    const placement = contextResetPlacement(messages[index], index, dividers)
    if (placement.before === resetId) return messages.slice(start, index)
    if (placement.before) start = index
    if (placement.after === resetId) return messages.slice(start, index + 1)
    if (placement.after) start = index + 1
  }
  return []
}

export interface SegmentSummary {
  // 10/28 14:02–14:35;跨天时两端都带日期。
  range: string
  // 消息数、文件数、记忆状态。
  facts: string[]
  firstQuestion: string | null
}

const FIRST_QUESTION_MAX_CHARS = 80
const pad2 = (value: number) => String(value).padStart(2, '0')
const formatDay = (date: Date) => `${date.getMonth() + 1}/${date.getDate()}`
const formatClock = (date: Date) => `${pad2(date.getHours())}:${pad2(date.getMinutes())}`

/** 修改评估对话框顶部的段落摘要,让用户知道改的是哪一段。消息数以服务端段落记录为准。 */
export function segmentSummary(
  segment: Pick<ContextSegment, 'ended_at' | 'message_count'>,
  messages: ReadonlyArray<Pick<Message, 'role' | 'content' | '_ts' | 'attachments'>>,
  memoryText: string | null | undefined,
): SegmentSummary {
  const end = new Date(segment.ended_at)
  const startTs = messages.find((message) => message._ts !== undefined)?._ts
  const start = startTs === undefined ? null : new Date(startTs)
  let range = `${formatDay(end)} ${formatClock(end)} 结束`
  if (start && formatDay(start) === formatDay(end) && start.getFullYear() === end.getFullYear()) {
    range = `${formatDay(start)} ${formatClock(start)}–${formatClock(end)}`
  } else if (start) {
    range = `${formatDay(start)} ${formatClock(start)} – ${formatDay(end)} ${formatClock(end)}`
  }
  const files = messages.reduce((count, message) => count + (message.attachments?.length ?? 0), 0)
  const facts = [`${segment.message_count} 条消息`]
  if (files > 0) facts.push(`${files} 个文件`)
  if (memoryText) facts.push(memoryText)
  const question = messages.find((message) => message.role === 'user' && message.content.trim())?.content.replace(/\s+/g, ' ').trim()
  const firstQuestion = question === undefined ? null
    : [...question].length > FIRST_QUESTION_MAX_CHARS ? `${[...question].slice(0, FIRST_QUESTION_MAX_CHARS).join('')}…` : question
  return { range, facts, firstQuestion }
}

/** 还能修改多久;已过期返回 null。 */
export function editWindowText(segment: Pick<ContextSegment, 'editable_until'>, now: number): string | null {
  const remaining = Date.parse(segment.editable_until) - now
  if (!Number.isFinite(remaining) || remaining <= 0) return null
  const hours = Math.floor(remaining / 3_600_000)
  if (hours >= 24) return `还可修改 ${Math.floor(hours / 24)} 天`
  if (hours >= 1) return `还可修改 ${hours} 小时`
  return '还可修改不到 1 小时'
}

/** 结束后 7 天内(editable_until 之前)可修改评估;服务端已返回 segment_edit_window_closed 的段落不再允许。 */
export function canEditSegment(segment: ContextSegment, now: number, closedSegmentIds: ReadonlySet<string>): boolean {
  if (closedSegmentIds.has(segment.segment_id)) return false
  const until = Date.parse(segment.editable_until)
  return Number.isFinite(until) && now < until
}
