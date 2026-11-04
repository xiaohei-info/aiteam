/**
 * 回复失败：识别模型调用 / 执行失败，把原始报错翻译成用户能看懂的提示。
 *
 * 失败信息是消息上的独立字段（Message.failure），不拼进正文：复制回复不带警告，
 * 界面单独画成提示条，后续加「重试」「去设置」等入口只改提示条。
 *
 * 本文件只放纯函数，便于 node 测试。
 */
import type { ConversationMessage, PiSseEventData } from '../api/agent/types.ts'

export type ReplyFailureKind = 'model' | 'execution'

export interface ReplyFailure {
  kind: ReplyFailureKind
  /** 给用户看的一句话。 */
  summary: string
  /** 原始报错（Agent 已脱敏），放在「查看详情」里，便于反馈排查。 */
  detail?: string
}

interface FailureRule {
  pattern: RegExp
  summary: string
}

// 顺序即优先级：先认具体原因，再认笼统的服务端错误。
const RULES: FailureRule[] = [
  { pattern: /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[ _-]?api[ _-]?key|authentication|permission denied/i, summary: '模型 Key 无效或没有权限，请联系管理员' },
  { pattern: /\b429\b|rate[ _-]?limit|quota|insufficient[ _-]?(balance|credit)|too many requests|额度|余额/i, summary: '调用太频繁或额度已用完，请稍后再试' },
  { pattern: /timed? ?out|timeout|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket hang up/i, summary: '网络连接失败，请检查网络后重试' },
  { pattern: /cannot find module|module not found|ERR_MODULE_NOT_FOUND/i, summary: '程序文件不完整，请重新安装 AIFred' },
  { pattern: /manager returned http 404|runtime[- ]config.*404/i, summary: '服务端找不到这个员工的配置，请联系管理员' },
  { pattern: /\b50[0-4]\b|overloaded|server error|service unavailable|bad gateway/i, summary: '模型服务繁忙，请稍后重试' },
]

const FALLBACK: Record<ReplyFailureKind, string> = {
  model: '模型调用失败',
  execution: '执行失败',
}

/** 按原始报错归类；认不出时用通用说法，原文保留在 detail。 */
export function describeFailure(kind: ReplyFailureKind, raw: string | undefined): ReplyFailure {
  const detail = raw?.trim() || undefined
  const rule = detail ? RULES.find(item => item.pattern.test(detail)) : undefined
  return { kind, summary: rule?.summary ?? FALLBACK[kind], ...(detail ? { detail } : {}) }
}

/**
 * 模型调用失败时 Pi 只留下一条 assistant 消息（stopReason=error + errorMessage）。
 * 非失败消息返回 undefined。
 */
export function assistantFailure(message: ConversationMessage | undefined): ReplyFailure | undefined {
  if (message?.role !== 'assistant' || message.stopReason !== 'error') return undefined
  return describeFailure('model', typeof message.errorMessage === 'string' ? message.errorMessage : undefined)
}

/**
 * agent_settled 自带的失败：会话初始化等执行前失败没有 assistant 消息，
 * Agent 只在 settled 事件上给出 failed + error_message。
 */
export function settledFailure(event: PiSseEventData | undefined): ReplyFailure | undefined {
  if (event?.failed !== true) return undefined
  return describeFailure('execution', typeof event.error_message === 'string' ? event.error_message : undefined)
}

/** 本轮实时看到、但聊天记录里可能没有的失败（执行前失败不进历史）。 */
export interface LocalFailure<M> {
  workId?: string
  senderEmployeeId?: string
  /** 记录里找不到同一次执行时，原样补在列表末尾的那条回复。 */
  message: M
  failure: ReplyFailure
}

type FailureTarget = {
  role: string
  workId?: string
  senderEmployeeId?: string
  failure?: ReplyFailure
}

/**
 * 按聊天记录重建列表后，把本轮的失败补回去：记录里有同一次执行（workId + 员工）就挂到那条回复上
 * （已有失败的不覆盖）；没有就把失败回复补在末尾。直到下一轮开始前都保留。
 */
export function applyLocalFailures<M extends FailureTarget>(messages: M[], locals: readonly LocalFailure<M>[]): M[] {
  if (locals.length === 0) return messages
  let next = messages
  const appended: M[] = []
  for (const local of locals) {
    const index = local.workId
      ? next.findIndex(message => message.role === 'assistant'
        && message.workId === local.workId
        && (local.senderEmployeeId === undefined || message.senderEmployeeId === local.senderEmployeeId))
      : -1
    if (index === -1) {
      appended.push({ ...local.message, failure: local.failure })
      continue
    }
    if (next[index].failure) continue
    next = next === messages ? [...messages] : next
    next[index] = { ...next[index], failure: local.failure }
  }
  return appended.length ? [...next, ...appended] : next
}

type RetrySource = FailureTarget & {
  id: string
  content: string
  attachments?: readonly unknown[]
}

/**
 * 能「重试」的失败：列表最后一条是失败的回复，且触发它的用户消息只有文字（带附件的需要重新选择文件，交给输入框）。
 * 返回失败回复的 id 和要重发的文字。
 */
export function retryTarget(messages: readonly RetrySource[]): { failedId: string; text: string } | null {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant' || !last.failure) return null
  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user') continue
    const text = message.content.trim()
    return text && !message.attachments?.length ? { failedId: last.id, text } : null
  }
  return null
}
