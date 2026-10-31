/**
 * 群聊协作 → 办公室动作（纯逻辑，不依赖 React / Pixi，便于单测）。
 *
 * 数据来源是会话 SSE：协调人 A 调用 mention_employee（或兼容别名 delegate_employee）时，
 * 服务端会先发 tool_execution_start（source_employee_id = A，args.employee_id = 被 @ 的 B），
 * B 回复后发 tool_execution_end。这里把「尚未结束的 @」整理成场景要做的事：
 *
 * - 同一会话里同时只有 A、B 两人在协作 → visit：A 走到 B 的工位旁交流；
 * - 同一会话里同时有 ≥3 人在协作（A 同时 @B、@C，或 B 又 @ 了 C）→ meeting：全员进会议室；
 *   （入口开关：meetingsEnabled，默认开；应用里由 useOfficeCollaboration 传入，当前关闭，
 *   关闭后 ≥3 人协作不产出任何意图——不开会、也不拆成串门；已经在串门的会继续到结束。
 *   下面的会议逻辑与场景里的执行代码都保留，打开开关即可恢复。）
 * - 会议一旦成立成员只增不减，直到所有 @ 都结束并过了 lingerMs 才散会，
 *   避免顺序 @（A→B 再 A→C）或收尾间隙里人来回折返。
 *
 * 被 @ 的对象可以是 employee_id、handle 或显示名（与服务端 resolveEmployeeReference 一致），
 * 解析放在 plan() 里按当前花名册做，花名册后到也不丢信号。
 *
 * 两处防抖/补漏：
 * - 一条 @ 存活不足 debounceMs 就不算（失败得很快的 @、断线重放的「开始+结束」都会被忽略，不会让人白跑一趟）；
 * - 办公室订阅会话比 @ 发生得晚时，重连快照（reconciliation）里还没拿到回复的 mention 工具调用会补成「开始」。
 */
import type { AgentSseEvent } from '../api/agent/events'
import type { ConversationReconciliation, PiSseEventData } from '../api/agent/types'
import type { OfficeCollabIntent } from '../scene/office/officeMap/types'

export type { OfficeCollabIntent }

const MENTION_TOOLS = new Set(['mention_employee', 'delegate_employee'])

export type CollabSignal =
  | { phase: 'start'; key: string; conversationId: string; from: string; toRef: string }
  | { phase: 'end'; key: string }
  /** 某员工本轮运行结束：它发出的所有 @ 都不会再有回复，一并收尾 */
  | { phase: 'settled'; conversationId: string; from: string }

function readEmployeeRef(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const value = (args as { employee_id?: unknown }).employee_id
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** 把一条 SSE 事件翻译成协作信号；与协作无关的事件返回 null */
export function parseCollabSignal(evt: AgentSseEvent, fallbackConversationId: string): CollabSignal | null {
  if ((evt as { type?: unknown }).type === 'reconciliation') return null
  const event = evt as PiSseEventData
  const conversationId = event.conversation_id ?? fallbackConversationId
  // 工具事件自己的调用 id 优先：信封里的 tool_call_id 是被委派方继承的上游调用 id
  const toolCallId = event.toolCallId ?? event.tool_call_id
  switch (event.type) {
    case 'tool_execution_start': {
      if (!event.toolName || !MENTION_TOOLS.has(event.toolName) || !toolCallId || !event.source_employee_id) return null
      const toRef = readEmployeeRef(event.args)
      if (!toRef) return null
      return { phase: 'start', key: `${conversationId}:${toolCallId}`, conversationId, from: event.source_employee_id, toRef }
    }
    case 'tool_execution_end': {
      if (!event.toolName || !MENTION_TOOLS.has(event.toolName) || !toolCallId) return null
      return { phase: 'end', key: `${conversationId}:${toolCallId}` }
    }
    case 'agent_end':
    case 'agent_settled':
      return event.source_employee_id ? { phase: 'settled', conversationId, from: event.source_employee_id } : null
    default:
      return null
  }
}

/**
 * 重连快照 → 开始信号：协调人当前那条助手消息里、还没有 toolResult 的 mention 调用，说明对方还没回复。
 * 之后真正的 tool_execution_end 仍会按同一个 key 收尾；快照可重复到达（start 按 key 幂等）。
 */
export function parseReconciliationSignals(evt: AgentSseEvent, fallbackConversationId: string): CollabSignal[] {
  if ((evt as { type?: unknown }).type !== 'reconciliation') return []
  const snapshot = evt as ConversationReconciliation
  const conversationId = snapshot.conversation_id ?? fallbackConversationId
  const finished = new Set<string>()
  for (const entry of snapshot.entries ?? []) {
    const message = entry.message
    if (message?.role === 'toolResult' && message.toolCallId) finished.add(message.toolCallId)
  }
  const signals: CollabSignal[] = []
  for (const run of snapshot.active_runs ?? []) {
    const from = run.source_employee_id
    const content = run.message?.content
    if (!from || !Array.isArray(content)) continue
    for (const part of content) {
      if (part.type !== 'toolCall' || !part.id || !part.name || !MENTION_TOOLS.has(part.name) || finished.has(part.id)) continue
      const toRef = readEmployeeRef(part.arguments)
      if (toRef) signals.push({ phase: 'start', key: `${conversationId}:${part.id}`, conversationId, from, toRef })
    }
  }
  return signals
}

export interface RosterEntry {
  id: string
  name?: string
  handle?: string
}

/** 花名册 → 引用解析器：id / handle（可带 @）/ 显示名，歧义（多人重名）返回 null */
export function buildMentionResolver(roster: readonly RosterEntry[]): (ref: string) => string | null {
  return (ref) => {
    const wanted = ref.trim().replace(/^@/, '')
    const byId = roster.filter((entry) => entry.id === wanted)
    if (byId.length === 1) return byId[0].id
    const matches = new Set(
      roster.filter((entry) => entry.handle === wanted || entry.name === wanted).map((entry) => entry.id),
    )
    return matches.size === 1 ? [...matches][0] : null
  }
}

interface Edge {
  key: string
  conversationId: string
  from: string
  toRef: string
  startedAt: number
  endedAt: number | null
}

interface Session {
  kind: 'visit' | 'meeting'
  visitor?: string
  host?: string
  members: string[]
  lastLiveAt: number
}

export interface CollabTrackerOptions {
  /** 所有 @ 结束后继续保持多久再收尾（毫秒） */
  lingerMs?: number
  /** 一条 @ 超过这么久还没结束就视为丢帧，不再算进行中（毫秒） */
  staleMs?: number
  /** 一条 @ 至少存活这么久才算协作（毫秒），过滤秒失败 / 回放 */
  debounceMs?: number
  /** 是否允许 ≥3 人协作产出「会议」意图；默认 true。关闭时该情形不产出新意图 */
  meetingsEnabled?: boolean
  maxEdges?: number
}

export class CollaborationTracker {
  private readonly edges = new Map<string, Edge>()
  private readonly sessions = new Map<string, Session>()
  private readonly lingerMs: number
  private readonly staleMs: number
  private readonly debounceMs: number
  private readonly meetingsEnabled: boolean
  private readonly maxEdges: number

  constructor(options: CollabTrackerOptions = {}) {
    this.lingerMs = options.lingerMs ?? 6000
    this.staleMs = options.staleMs ?? 20 * 60_000
    this.debounceMs = options.debounceMs ?? 800
    this.meetingsEnabled = options.meetingsEnabled ?? true
    this.maxEdges = options.maxEdges ?? 200
  }

  apply(signal: CollabSignal, now: number): void {
    if (signal.phase === 'start') {
      if (this.edges.has(signal.key)) return
      this.edges.set(signal.key, {
        key: signal.key,
        conversationId: signal.conversationId,
        from: signal.from,
        toRef: signal.toRef,
        startedAt: now,
        endedAt: null,
      })
      this.trim()
    } else if (signal.phase === 'end') {
      const edge = this.edges.get(signal.key)
      if (edge && edge.endedAt === null) edge.endedAt = now
    } else {
      for (const edge of this.edges.values()) {
        if (edge.conversationId === signal.conversationId && edge.from === signal.from && edge.endedAt === null) edge.endedAt = now
      }
    }
  }

  /** 会话不再被订阅（任务离开进行中集合）：把还没结束的 @ 收尾，保留 linger 渐退 */
  closeConversation(conversationId: string, now: number): void {
    for (const edge of this.edges.values()) {
      if (edge.conversationId === conversationId && edge.endedAt === null) edge.endedAt = now
    }
  }

  private trim(): void {
    if (this.edges.size <= this.maxEdges) return
    for (const [key, edge] of this.edges) {
      if (edge.endedAt !== null) this.edges.delete(key)
      if (this.edges.size <= this.maxEdges) return
    }
    const oldest = this.edges.keys().next().value
    if (oldest !== undefined) this.edges.delete(oldest)
  }

  /** 当前应有的协作；纯读取（会清理过期数据），同一输入多次调用结果一致 */
  plan(now: number, resolve: (ref: string) => string | null): OfficeCollabIntent[] {
    const live = new Map<string, { from: string; to: string }[]>()
    // 每个会话里「真正协作过的 @」最近一次结束的时刻：散场倒计时从这里起算，
    // 而不是从上一次 plan() 被调用的时刻起算（否则 plan 调用稀疏时会提前散场）
    const lastEnd = new Map<string, number>()
    const noteEnd = (edge: Edge, endedAt: number) => {
      if (endedAt - edge.startedAt < this.debounceMs) return
      lastEnd.set(edge.conversationId, Math.max(lastEnd.get(edge.conversationId) ?? 0, endedAt))
    }
    for (const [key, edge] of this.edges) {
      if (edge.endedAt !== null) {
        noteEnd(edge, edge.endedAt)
        if (now - edge.endedAt > this.lingerMs * 4) this.edges.delete(key)
        continue
      }
      if (now - edge.startedAt > this.staleMs) {
        edge.endedAt = now
        noteEnd(edge, now)
        continue
      }
      if (now - edge.startedAt < this.debounceMs) continue
      const to = resolve(edge.toRef)
      if (!to || to === edge.from) continue
      const list = live.get(edge.conversationId) ?? []
      list.push({ from: edge.from, to })
      live.set(edge.conversationId, list)
    }

    for (const [conversationId, edges] of live) {
      const parts = [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))]
      const session = this.sessions.get(conversationId)
      if (parts.length >= 3 && this.meetingsEnabled) {
        const members = [...new Set([...(session?.kind === 'meeting' ? session.members : []), ...parts])]
        this.sessions.set(conversationId, { kind: 'meeting', members, lastLiveAt: now })
      } else if (session?.kind === 'meeting') {
        session.lastLiveAt = now
      } else if (parts.length === 2) {
        this.sessions.set(conversationId, { kind: 'visit', visitor: edges[0].from, host: edges[0].to, members: parts, lastLiveAt: now })
      } else if (session) {
        // ≥3 人但会议被关闭：不新开会，已有的串门保持到结束
        session.lastLiveAt = now
      }
    }

    const intents: OfficeCollabIntent[] = []
    for (const [conversationId, session] of [...this.sessions]) {
      session.lastLiveAt = Math.max(session.lastLiveAt, lastEnd.get(conversationId) ?? 0)
      if (!live.has(conversationId) && now - session.lastLiveAt > this.lingerMs) {
        this.sessions.delete(conversationId)
        continue
      }
      if (session.kind === 'meeting') {
        intents.push({ kind: 'meeting', key: `meeting:${conversationId}`, members: session.members })
      } else if (session.visitor && session.host) {
        intents.push({ kind: 'visit', key: `visit:${conversationId}:${session.visitor}>${session.host}`, visitor: session.visitor, host: session.host })
      }
    }
    return intents
  }
}

/** 意图列表是否等价（用于避免无意义的 setState） */
export function sameIntents(a: readonly OfficeCollabIntent[], b: readonly OfficeCollabIntent[]): boolean {
  if (a.length !== b.length) return false
  return a.every((item, index) => {
    const other = b[index]
    if (item.key !== other.key || item.kind !== other.kind) return false
    return item.kind === 'meeting'
      ? other.kind === 'meeting' && item.members.length === other.members.length && item.members.every((m, i) => m === other.members[i])
      : true
  })
}
