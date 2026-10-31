/**
 * PiEntry / PiSseEvent → 前端 Message 与流式回调 的转换层。
 *
 * 目标(见 docs/archive/api-agent-migration.md §3.5):
 *   1. 纯函数,不依赖 zustand / DOM,可单测。
 *   2. 保留旧栈 chat.ts 消息展示形状(Message/ThinkingStep/ToolCall),UI 层零改动。
 *   3. FredServer PiEntry / PiSseEventData 是唯一事实源,不猜测字段。
 *
 * 关键决策:
 *   - 群聊按 `source_employee_id` 分流:每个专家的 Pi session 都会各自产 agent_end/agent_settled,
 *     必须全部 settled 后 UI 才能解锁,只看到一个 agent_end 就 finalize 会丢失后续输出。
 *   - agent_end != 终态。真正终态是 agent_settled(pi-coding-agent 语义:auto_retry/compaction/续跑
 *     都完成后才发出)。前端的 UI 解锁 / prompting=false 一律以 agent_settled 为准。
 *   - message_update.assistantMessageEvent.done 也不代表 run 结束,只是一段 content_index 收尾。
 *   - toolResult 消息把结果并回它引用的 toolCall(entry.message.toolCallId + isError),不产生独立气泡。
 */
import type {
  ConversationContentPart,
  ConversationEntry,
  ConversationMessage,
  PiSseAssistantMessageEvent,
  PiSseEventData,
} from '../api/agent/types'
import { CONTEXT_RESET_ENTRY_TYPE, type ContextResetMemoryReason } from '../api/agent/types.ts'
import { dividerMemoryText, isContextResetMemoryReason } from './contextResetMemory.ts'
import type { Message, ThinkingStep, ToolCall } from '../stores/chat'
import { splitLocalContext, type LocalContextAction } from './localContextBlock.ts'

// -------------------- Entry → Message --------------------

// 转换时间戳:entry 允许 date-time 字符串或 unix 整数;UI 需要 HH:mm 展示 + 毫秒 _ts 排序。
function normalizeTimestamp(ts: unknown): { time: string; ms: number } {
  let ms = 0
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    ms = ts
  } else if (typeof ts === 'string' && ts) {
    const parsed = Date.parse(ts)
    if (!Number.isNaN(parsed)) ms = parsed
  }
  if (!ms) ms = Date.now()
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return { time: `${hh}:${mm}`, ms }
}

// 把内容片段拆成三份:文本(text 拼接),thinkingSteps(思考文本 + 工具调用按顺序交错),
// toolCalls(所有工具调用扁平列表,方便老代码里对 toolCalls 数组的兼容读)。
export interface SplitParts {
  content: string
  thinkingSteps: ThinkingStep[]
  toolCalls: ToolCall[]
}

export function splitContentParts(parts: ConversationContentPart[]): SplitParts {
  const texts: string[] = []
  const thinkingSteps: ThinkingStep[] = []
  const toolCalls: ToolCall[] = []

  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'text') {
      if (typeof part.text === 'string') texts.push(part.text)
    } else if (part.type === 'thinking') {
      const text = typeof part.thinking === 'string' ? part.thinking : ''
      if (!text) continue
      // 连续的 thinking 片段合并成同一 reasoning step,避免 UI 上被工具调用之外的空气泡切碎。
      const last = thinkingSteps[thinkingSteps.length - 1]
      if (last && last.kind === 'reasoning') {
        thinkingSteps[thinkingSteps.length - 1] = {
          kind: 'reasoning',
          text: last.text + text,
        }
      } else {
        thinkingSteps.push({ kind: 'reasoning', text })
      }
    } else if (part.type === 'toolCall') {
      // arguments 在服务端已被 BoundedJsonValue 清洗;前端保留任意 JSON,ToolCall.input 允许 record。
      const argsRecord =
        part.arguments && typeof part.arguments === 'object' && !Array.isArray(part.arguments)
          ? (part.arguments as Record<string, unknown>)
          : part.arguments !== undefined
            ? ({ value: part.arguments } as Record<string, unknown>)
            : undefined
      const tool: ToolCall = {
        id: part.id ?? `tool_${toolCalls.length}`,
        name: part.name ?? '',
        input: argsRecord,
      }
      thinkingSteps.push({ kind: 'tool', tool })
      toolCalls.push(tool)
    }
    // image 片段是占位(server 明确图片字节不通过事件返回),UI 若要展示图片必须走 attachments。
    // 这里不在 content 里塞占位符,避免污染 text。
  }

  return {
    content: texts.join(''),
    thinkingSteps,
    toolCalls,
  }
}

// 把一个 ConversationMessage 展开成前端 Message 字段。role 转换以服务端为准:
//   - user → 用户气泡
//   - assistant → 员工气泡(含 thinkingSteps)
//   - toolResult → 不产气泡,由调用方合并到对应 toolCall(见下面 attachToolResult)
function messageToFields(msg: ConversationMessage): {
  role: 'user' | 'assistant' | 'toolResult'
  content: string
  thinkingSteps?: ThinkingStep[]
  toolCalls?: ToolCall[]
  isError?: boolean
  localContext?: LocalContextAction
} {
  let content = ''
  let thinkingSteps: ThinkingStep[] | undefined
  let toolCalls: ToolCall[] | undefined

  const raw = msg.content
  if (typeof raw === 'string') {
    content = raw
  } else if (Array.isArray(raw)) {
    const split = splitContentParts(raw)
    content = split.content
    if (split.thinkingSteps.length > 0) thinkingSteps = split.thinkingSteps
    if (split.toolCalls.length > 0) toolCalls = split.toolCalls
  }

  const role = msg.role === 'user' ? 'user' : msg.role === 'toolResult' ? 'toolResult' : 'assistant'
  // 用户消息末尾可能带有本机网关追加的授权目录检索块，正文只展示用户自己输入的内容。
  const local = role === 'user' ? splitLocalContext(content) : { text: content }
  return {
    role,
    content: local.text,
    thinkingSteps,
    toolCalls,
    isError: msg.isError,
    localContext: local.localContext,
  }
}

// 将 toolResult entry 合并到之前的某条 assistant 消息里对应的 toolCall。
// 如果找不到匹配的 toolCallId(异常场景),就作为一条独立的"工具结果"消息插入,避免丢失信息。
function attachToolResult(msgs: Message[], entry: ConversationEntry): Message[] {
  const msg = entry.message
  if (!msg) return msgs
  const toolCallId = typeof msg.toolCallId === 'string' ? msg.toolCallId : undefined
  const contentText = typeof msg.content === 'string'
    ? msg.content
    : Array.isArray(msg.content)
      ? splitContentParts(msg.content).content
      : ''
  const toolKind = msg.tool_kind === 'memory' || msg.tool_kind === 'rag' || msg.tool_kind === 'todo'
    ? msg.tool_kind
    : undefined
  const isError = msg.isError === true

  if (!toolCallId) return msgs

  // 从后往前找,匹配 thinkingSteps 中 tool.id 相同的 step。
  for (let i = msgs.length - 1; i >= 0; i--) {
    const target = msgs[i]
    if (target.senderEmployeeId !== entry.source_employee_id || target.workId !== entry.work_id) continue
    const steps = target.thinkingSteps
    if (!steps || steps.length === 0) continue
    let hit = false
    const nextSteps = steps.map((step) => {
      if (step.kind !== 'tool') return step
      if (step.tool.id !== toolCallId) return step
      hit = true
      return {
        kind: 'tool' as const,
        tool: {
          ...step.tool,
          toolKind,
          result: contentText,
          resultValue: msg.result,
          isError,
        },
      }
    })
    if (hit) {
      const nextMsg: Message = { ...target, thinkingSteps: nextSteps, entryRefs: [...(target.entryRefs ?? [target.id]), entry.entry_ref ?? entry.id] }
      // 同步反射到 toolCalls 数组(兼容旧读法)。
      if (target.toolCalls) {
        nextMsg.toolCalls = target.toolCalls.map((call) =>
          call.id === toolCallId
            ? { ...call, toolKind, result: contentText, resultValue: msg.result, isError }
            : call,
        )
      }
      const next = msgs.slice()
      next[i] = nextMsg
      return next
    }
  }

  return msgs
}

export interface EntrySenderIdentity {
  role: 'user' | 'assistant'
  senderName?: string
  senderEmployeeId?: string
  senderRole?: 'human' | 'child' | 'participant' | 'coordinator'
}

export interface EmployeeSenderFallback {
  senderName?: string
  senderRole?: 'child' | 'participant' | 'coordinator'
}

function normalizeEmployeeSenderRole(
  role: ConversationEntry['source_role'],
): 'child' | 'participant' | 'coordinator' | undefined {
  return role === 'coordinator' || role === 'participant' || role === 'child'
    ? role
    : undefined
}

/** 将 SSE 来源字段转换成与历史 entry 相同的员工身份形状。 */
export function resolvePiEventSenderIdentity(
  event: PiSseEventData,
  fallback: EmployeeSenderFallback = {},
): Omit<EntrySenderIdentity, 'role'> {
  if (!event.source_employee_id || event.source_role === 'human') return {}
  return {
    senderName: event.source_employee_display_name ?? fallback.senderName ?? event.source_employee_id,
    senderEmployeeId: event.source_employee_id,
    senderRole: normalizeEmployeeSenderRole(event.source_role) ?? fallback.senderRole ?? 'participant',
  }
}

/**
 * 把 Pi 会话内的 message role 与群聊来源身份拆开。
 *
 * Pi session 中员工转交给另一员工的内容也会以 `message.role=user` 保存；只有服务端明确标注
 * `source_type=employee` 时才按员工消息展示。普通用户消息始终忽略 employee fallback 字段，
 * 防止旧历史条目把 coordinator 错认成用户消息发送者。
 */
export function resolveEntrySenderIdentity(
  entry: ConversationEntry,
  messageRole: 'user' | 'assistant',
): EntrySenderIdentity {
  const employeeAuthored = messageRole === 'assistant' || entry.source_type === 'employee'
  if (!employeeAuthored) {
    return { role: 'user', senderRole: 'human' }
  }

  const senderEmployeeId = messageRole === 'assistant'
    ? entry.source_employee_id
    : entry.source_id ?? entry.source_employee_id
  const senderName = messageRole === 'assistant'
    ? entry.source_employee_display_name ?? senderEmployeeId
    : entry.source_display_name ?? entry.source_employee_display_name ?? senderEmployeeId
  const senderRole = normalizeEmployeeSenderRole(entry.source_role) ?? 'participant'

  return {
    role: 'assistant',
    senderName,
    senderEmployeeId,
    senderRole,
  }
}

/**
 * 将 /entries 返回的历史条目转换为前端 Message 列表。
 *
 * 排序:输入已按 timestamp + 稳定 id 排序,这里不再重排,只保留原顺序。
 * 幂等:重复条目 id 会 dedup,保留首个。
 */
export function entriesToMessages(
  entries: ConversationEntry[],
  resolveEmployeeName?: (employeeId: string) => string | undefined,
): Message[] {
  const seenIds = new Set<string>()
  let msgs: Message[] = []
  for (const entry of entries) {
    if (!entry || !entry.id) continue
    const entryId = entry.entry_ref ?? entry.id
    if (seenIds.has(entryId)) continue
    seenIds.add(entryId)

    const message = entry.message
    if (!message) {
      // 无 message 的 entry(纯系统条目)暂不展示,交给上游按需扩展。
      continue
    }
    const { role, content, thinkingSteps, toolCalls, localContext } = messageToFields(message)

    if (role === 'toolResult') {
      msgs = attachToolResult(msgs, entry)
      continue
    }

    const { time, ms } = normalizeTimestamp(entry.timestamp ?? message.timestamp)
    // wire id 使用复合 `employee_id:entry_id` 时,直接用 entry.id 做前端 Message.id 已足够唯一;
    // 服务端相同 entry.id 不会在不同员工间复用。
    const identity = resolveEntrySenderIdentity(entry, role)
    const isDirectedDelegation = entry.source_type === 'employee'
      && Boolean(entry.participant_employee_id)
      && entry.participant_employee_id !== identity.senderEmployeeId
    const recipientEmployeeId = isDirectedDelegation ? entry.participant_employee_id : undefined
    // main 不再返回 participant 展示名；仅按真实员工 ID 查目录，不用发送者姓名代替目标。
    // 未加载或撤权成员可能不在目录中，保留 ID，避免委派目标徽标消失。
    const recipientName = recipientEmployeeId
      ? (resolveEmployeeName?.(recipientEmployeeId)?.trim() || recipientEmployeeId)
      : undefined
    msgs.push({
      id: entryId,
      entryRefs: [entryId],
      workId: role === 'assistant' ? entry.work_id : undefined,
      role: identity.role,
      msgType: 'text',
      content,
      time,
      thinking: undefined,
      thinkingSteps,
      toolCalls,
      status: 'delivered',
      senderName: identity.senderName,
      senderEmployeeId: identity.senderEmployeeId,
      senderRole: identity.senderRole,
      recipientEmployeeId,
      recipientName,
      ...(localContext ? { localContext } : {}),
      _ts: ms,
    })
  }
  return groupWorkMessages(msgs)
}

export interface ContextResetDividers {
  // 分隔线画在含该 entry ref 的消息之前;value 为 reset_id。
  before: Map<string, string>
  // 重置后历史里还没有新消息:画在 afterEntryRef 所在消息之后(null 表示列表开头)。
  // 锚定到具体消息而不是列表末尾,实时流入的新消息才会排在分隔线下方。
  trailing: { resetId: string; afterEntryRef: string | null } | null
  // reset_id → 各参与者标记里的 memory_reason;旧标记没有该字段时不记录。
  memory: Map<string, ContextResetMemoryReason[]>
}

/**
 * 从 /entries 原始条目定位"新上下文"分隔线。重置标记不进 Message 列表,
 * 避免会话预览、已读游标和搜索把它当成普通消息;群聊各参与者共享 reset_id,按它去重。
 */
export function contextResetDividers(entries: ConversationEntry[]): ContextResetDividers {
  const before = new Map<string, string>()
  const memory = new Map<string, ContextResetMemoryReason[]>()
  const seen = new Set<string>()
  let pending: string[] = []
  let lastMessageRef: string | null = null
  for (const entry of entries) {
    if (!entry?.id) continue
    if (entry.type === 'custom' && entry.customType === CONTEXT_RESET_ENTRY_TYPE) {
      const data = entry.data
      const resetId = data && typeof data === 'object' && 'reset_id' in data && typeof data.reset_id === 'string'
        ? data.reset_id : entry.entry_ref ?? entry.id
      const reason = data && typeof data === 'object' && 'memory_reason' in data ? data.memory_reason : undefined
      if (isContextResetMemoryReason(reason)) memory.set(resetId, [...(memory.get(resetId) ?? []), reason])
      if (!seen.has(resetId)) {
        seen.add(resetId)
        pending.push(resetId)
      }
      continue
    }
    const role = entry.message?.role
    if (role !== 'user' && role !== 'assistant') continue
    const ref = entry.entry_ref ?? entry.id
    lastMessageRef = ref
    if (pending.length === 0) continue
    // 连续多次重置之间没有消息时只画一条。
    before.set(ref, pending[pending.length - 1])
    pending = []
  }
  const resetId = pending[pending.length - 1]
  return { before, trailing: resetId ? { resetId, afterEntryRef: lastMessageRef } : null, memory }
}

/** 按消息自身 id 和合并后的 entryRefs 判断该消息前后要画的"新上下文"分隔线;值为 reset_id,null 表示不画。 */
export function contextResetPlacement(
  msg: Pick<Message, 'id' | 'entryRefs'>,
  index: number,
  dividers: ContextResetDividers,
): { before: string | null; after: string | null } {
  const refs = [msg.id, ...(msg.entryRefs ?? [])]
  const trailing = dividers.trailing
  const beforeRef = refs.find((ref) => dividers.before.has(ref))
  return {
    before: beforeRef !== undefined
      ? dividers.before.get(beforeRef)!
      : index === 0 && trailing !== null && trailing.afterEntryRef === null ? trailing.resetId : null,
    after: trailing !== null && trailing.afterEntryRef !== null && refs.includes(trailing.afterEntryRef) ? trailing.resetId : null,
  }
}

/** 分隔线上显示的记忆状态文字;旧标记没有 memory_reason 时返回 null。 */
export function contextResetMemoryText(resetId: string, dividers: ContextResetDividers): string | null {
  return dividerMemoryText(dividers.memory.get(resetId) ?? [])
}

/** Keep individual entry references; presentation grouping never changes read cursors. */
function groupWorkMessages(messages: Message[]): Message[] {
  const grouped: Message[] = []
  const indices = new Map<string, number>()
  for (const message of messages) {
    const key = message.workId && message.role === 'assistant'
      ? JSON.stringify([message.senderEmployeeId ?? '', message.workId]) : undefined
    const index = key === undefined ? undefined : indices.get(key)
    if (index === undefined) {
      if (key !== undefined) indices.set(key, grouped.length)
      grouped.push(message)
      continue
    }
    const previous = grouped[index]
    grouped[index] = {
      ...previous,
      content: [previous.content, message.content].filter(Boolean).join('\n\n'),
      thinkingSteps: [...(previous.thinkingSteps ?? []), ...(message.thinkingSteps ?? [])],
      toolCalls: [...(previous.toolCalls ?? []), ...(message.toolCalls ?? [])],
      entryRefs: [...(previous.entryRefs ?? [previous.id]), ...(message.entryRefs ?? [message.id])],
      recipientEmployeeId: previous.recipientEmployeeId ?? message.recipientEmployeeId,
      recipientName: previous.recipientName ?? message.recipientName,
    }
  }
  return grouped
}

// -------------------- SSE 事件 → 流式回调 --------------------

/**
 * 流式回调:与旧 startAssistantStream 的回调保持形状一致,方便 store 内部替换实现。
 * 每个回调都接收 sourceEmployeeId(群聊 fan-out 分流的关键),私聊传 undefined 即可。
 */
export interface PiStreamCallbacks {
  onDelta?: (chunk: string, sourceEmployeeId?: string) => void
  onThinkingDelta?: (chunk: string, sourceEmployeeId?: string) => void
  // 工具调用:kind 表示阶段。start/update/end 对应 tool_execution_* 事件,
  // model_call 对应 assistantMessageEvent.toolcall_end(模型侧发起的工具调用完整片段)。
  onToolCall?: (
    call: ToolCall,
    phase: 'model_call' | 'exec_start' | 'exec_update' | 'exec_end',
    sourceEmployeeId?: string,
  ) => void
  // 一次 agent loop 结束(可能还有 auto_retry/compaction/续跑);UI 不应据此解锁。
  onAgentEnd?: (sourceEmployeeId: string | undefined, event: PiSseEventData) => void
  // 全部处理完成(auto_retry/compaction/续跑都不会再发生);UI 据此 finalize 该员工的占位消息。
  onSettled?: (sourceEmployeeId: string | undefined, event: PiSseEventData) => void
  onAutoRetry?: (
    phase: 'start' | 'end',
    payload: { attempt?: number; maxAttempts?: number; delayMs?: number; errorMessage?: string; success?: boolean; finalError?: string },
    sourceEmployeeId?: string,
  ) => void
  onCompaction?: (
    phase: 'start' | 'end',
    payload: { reason?: string; errorMessage?: string; aborted?: boolean; willRetry?: boolean },
    sourceEmployeeId?: string,
  ) => void
  onApprovalRequired?: (event: PiSseEventData) => void
  // 服务端明确的错误信号:message_update.assistantMessageEvent.type='error' 或事件中 isError=true。
  onError?: (message: string, sourceEmployeeId?: string) => void
  // 未处理的事件,便于调试期打点。生产不必挂载。
  onUnknown?: (event: PiSseEventData) => void
}

// 从 assistantMessageEvent.toolCall 抽出前端 ToolCall。
function assistantEventToTool(evt: PiSseAssistantMessageEvent): ToolCall | null {
  const tc = evt.toolCall
  if (!tc) return null
  const argsRecord =
    tc.arguments && typeof tc.arguments === 'object' && !Array.isArray(tc.arguments)
      ? (tc.arguments as Record<string, unknown>)
      : tc.arguments !== undefined
        ? ({ value: tc.arguments } as Record<string, unknown>)
        : undefined
  return {
    id: tc.id ?? `tool_${Date.now()}`,
    name: tc.name ?? '',
    input: argsRecord,
  }
}

// 从事件的 args 抽出工具入参:tool_execution_* 事件把 args 放在顶层(不是 toolCall 里)。
function eventArgsToRecord(args: unknown): Record<string, unknown> | undefined {
  if (args === undefined) return undefined
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>
  }
  return { value: args }
}

// 结果统一转成字符串,前端 ToolCall.result 是 string(旧栈契约)。
function eventResultToText(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

/**
 * 分发一条 PiSseEventData 到相应回调。
 * 未识别的 type 交给 onUnknown(可选)。回调抛错不会中断分发。
 */
export function dispatchPiEvent(event: PiSseEventData, callbacks: PiStreamCallbacks): void {
  if (!event || typeof event !== 'object') return
  const src = event.source_employee_id

  const safe = <T,>(fn: T | undefined, run: (fn: T) => void) => {
    if (!fn) return
    try {
      run(fn)
    } catch {
      // 单个回调异常不影响其它分支;上层可自行 try/catch。
    }
  }

  switch (event.type) {
    case 'message_update': {
      const ame = event.assistantMessageEvent
      if (!ame) return
      // 显式 error 分支优先:后续的 reason 也可能是 'error',但那属于结束事件。
      if (ame.type === 'error') {
        const msg = typeof event.errorMessage === 'string' ? event.errorMessage : 'Pi runtime error'
        safe(callbacks.onError, (fn) => fn(msg, src))
        return
      }
      if (ame.type === 'text_delta' && typeof ame.delta === 'string') {
        safe(callbacks.onDelta, (fn) => fn(ame.delta!, src))
        return
      }
      if (ame.type === 'thinking_delta' && typeof ame.delta === 'string') {
        safe(callbacks.onThinkingDelta, (fn) => fn(ame.delta!, src))
        return
      }
      if (ame.type === 'toolcall_end') {
        const call = assistantEventToTool(ame)
        if (call) safe(callbacks.onToolCall, (fn) => fn(call, 'model_call', src))
        return
      }
      // toolcall_start/delta 的信息量不足以驱动 UI(参数常常还没组装完),这里不处理;
      // 完整视图靠 toolcall_end + tool_execution_*。text_start/end/thinking_start/end 同理不处理。
      return
    }

    case 'tool_execution_start': {
      const call: ToolCall = {
        id: event.toolCallId ?? event.tool_call_id ?? `tool_${Date.now()}`,
        name: event.toolName ?? '',
        toolKind: event.tool_kind,
        input: eventArgsToRecord(event.args),
      }
      safe(callbacks.onToolCall, (fn) => fn(call, 'exec_start', src))
      return
    }
    case 'tool_execution_update': {
      const call: ToolCall = {
        id: event.toolCallId ?? event.tool_call_id ?? `tool_${Date.now()}`,
        name: event.toolName ?? '',
        toolKind: event.tool_kind,
        input: eventArgsToRecord(event.args),
        result: eventResultToText(event.partialResult),
        resultValue: event.partialResult,
      }
      safe(callbacks.onToolCall, (fn) => fn(call, 'exec_update', src))
      return
    }
    case 'tool_execution_end': {
      const call: ToolCall = {
        id: event.toolCallId ?? event.tool_call_id ?? `tool_${Date.now()}`,
        name: event.toolName ?? '',
        toolKind: event.tool_kind,
        input: eventArgsToRecord(event.args),
        result: eventResultToText(event.result),
        resultValue: event.result,
        isError: event.isError === true,
      }
      safe(callbacks.onToolCall, (fn) => fn(call, 'exec_end', src))
      return
    }

    case 'auto_retry_start':
      safe(callbacks.onAutoRetry, (fn) =>
        fn('start', {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorMessage: event.errorMessage,
        }, src),
      )
      return
    case 'auto_retry_end':
      safe(callbacks.onAutoRetry, (fn) =>
        fn('end', {
          attempt: event.attempt,
          success: event.success,
          finalError: event.finalError,
        }, src),
      )
      return

    case 'compaction_start':
      safe(callbacks.onCompaction, (fn) =>
        fn('start', { reason: event.reason }, src),
      )
      return
    case 'compaction_end':
      safe(callbacks.onCompaction, (fn) =>
        fn('end', {
          reason: event.reason,
          errorMessage: event.errorMessage,
          aborted: event.aborted,
          willRetry: event.willRetry,
        }, src),
      )
      return

    case 'approval_required':
      safe(callbacks.onApprovalRequired, (fn) => fn(event))
      return

    case 'agent_end':
      safe(callbacks.onAgentEnd, (fn) => fn(src, event))
      return
    case 'agent_settled':
      safe(callbacks.onSettled, (fn) => fn(src, event))
      return

    case 'agent_start':
    case 'message_end':
      // 前端目前不需要专门反应;上游可以自己 hook onUnknown。
      safe(callbacks.onUnknown, (fn) => fn(event))
      return

    default:
      safe(callbacks.onUnknown, (fn) => fn(event))
      return
  }
}
