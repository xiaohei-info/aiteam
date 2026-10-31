/**
 * Chat store (新栈,Phase 2)。
 *
 * 关键改造(见 docs/archive/api-agent-migration.md §3.5):
 *   - 数据源: FredServer agent_service(/api/agent/*),不再走 Hermes /api/team/*。
 *   - 消息模型: PiEntry(text/thinking/toolCall/image content parts)代替 HermesMessage 扁平结构。
 *   - 发消息路径: 页面调 `submitPrompt` + store 内的 `startAssistantStream(convId)`,不再有 runId。
 *   - SSE: 会话级订阅(每 conv 一个),按 source_employee_id 分流,agent_settled 才是终态。
 *   - 已读: `PATCH /conversations/:id { last_read_entry_id }` 代替 workbench/state。
 *   - 分页: entries 接口是全量返回,无游标分页。loadMoreMessages 变 no-op,activePagination.hasMore 恒为 false。
 *   - 占位消息 id: 会话/发送者前缀 + UUID，每轮生成独立占位(群聊按发送者 fan-out)。
 *
 * 保留(为 UI 层零改动):
 *   - Message/ToolCall/ThinkingStep 形状。
 *   - state/actions 命名。startAssistantStream 首参从 (convId, runId) 改为 (convId, opts?)。
 *   - activeConvRawItems 保留为 ConversationEntry[](类型收窄,业务不使用)。
 */
import { create } from 'zustand'
import type { CachedFile } from '../lib/fileCache'
import { agentApi, AgentApiError } from '../api/agent'
import { skillDisplayNames } from '../lib/skillDisplay'
import { useAgentAuthStore } from './agentAuth'
import { useApprovalStore } from './approvals'
import type {
  ConversationEntry,
  ConversationMetadata,
  ConversationReconciliation,
  ExpertProjection,
  SolutionProjection,
} from '../api/agent/types'
import type { EventSubscription } from '../api/agent/events'
import {
  dispatchPiEvent,
  entriesToMessages,
  resolvePiEventSenderIdentity,
  type PiStreamCallbacks,
} from '../lib/piConverters'
import {
  createSettleTracker,
  type SettleTracker,
} from '../lib/groupStreamLifecycle'
import { globalActivityCollector } from '../lib/globalActivityCollector'
import { mergeReplyProjection, reconcileReplyProjection } from '../lib/replyProjection'
import {
  participantRoster,
  type GroupMember,
} from '../lib/groupRoster'
import { rememberEmployeeConversation, type WorkbenchEmployee } from '../lib/employeeConversationMap'
import { classifyRequestError, type RequestErrorInfo } from '../lib/requestError'
import { notifyConversationCompleted } from '../lib/systemNotifications'
import { formatConversationTime, resolveConversationSummary, type ConversationSummaryAvailability } from '../lib/conversationSummary'
import {
  getPinnedStorageKey as buildPinnedStorageKey,
  loadPinnedConversations,
  migratePinnedConversationId,
  savePinnedConversations,
} from '../lib/pinnedConversations'

export type { GroupMember } from '../lib/groupRoster'

// -------------------- 前端类型(保持与旧栈一致) --------------------

export interface GroupItem {
  description?: string | null
  orchestration?: import('../api/agent/customGroups').GroupOrchestration | null
  id: string
  name: string
  lastMessage: string
  time: string
  memberCount: number | null
  unread?: number
  lastMessageAt?: number
  summaryAvailability?: ConversationSummaryAvailability
  solutionInstanceId: string | null
  rosterStatus: 'loaded' | 'unavailable'
  rosterMessage?: string
  // 群成员列表：仅由 solution roster 派生；无 solution 时只含可确认的 coordinator。
  members?: GroupMember[]
}

export interface ConversationItem {
  id: string            // conversation_id;若还没建会话则用 employee_id 占位(前缀 emp_)
  title: string
  agentEmoji: string
  // 员工头像 URL,来自 ExpertProjection.avatar_url,列表项优先展示 URL,回退到 emoji/首字符。
  agentAvatarUrl?: string | null
  agentName: string
  lastMessage: string
  time: string
  unread?: number
  lastMessageAt?: number
  summaryAvailability?: ConversationSummaryAvailability
  _employeeId?: string  // 内部字段:始终为 entry_employee_id,发消息时使用
}

export type MsgStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
export type MsgType = 'text' | 'image' | 'file' | 'card'
export type MessageSenderRole = 'human' | 'child' | 'participant' | 'coordinator'

export interface ToolCall {
  id: string
  name: string
  toolKind?: 'memory' | 'rag' | 'todo'
  input?: Record<string, unknown>
  result?: string
  resultValue?: unknown
  isError?: boolean
}

export type ThinkingStep =
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; tool: ToolCall }

export interface Message {
  workId?: string
  entryRefs?: string[]
  id: string
  role: 'user' | 'assistant'
  msgType: MsgType
  content: string
  time: string
  thinking?: string
  toolCalls?: ToolCall[]
  thinkingSteps?: ThinkingStep[]
  runId?: string   // 新栈不再使用;保留字段避免上层 UI 类型报错。
  status?: MsgStatus
  senderName?: string
  senderEmployeeId?: string
  senderRole?: MessageSenderRole
  recipientName?: string
  recipientEmployeeId?: string
  attachments?: MessageAttachment[]
  /** 用户消息由本机网关附带了授权目录检索结果（search）或目录清单（list）；正文已去掉该块。 */
  localContext?: 'search' | 'list'
  _ts?: number
  /** 占位消息(未收到 agent_settled 前展示 thinking/工具调用过程)。 */
  _pending?: boolean
}

// 附件按文档中的会话文件 ID 下载。
// name 是旧栈叫法,新栈用 filename;两者等价,同时保留供 UI 组件读。
export interface MessageAttachment {
  id: string
  filename: string
  name?: string
  mime_type: string
  byte_size?: number
  // 图片/文件类型按 MIME 前缀推导。
  kind?: 'image' | 'file'
}

// -------------------- 占位 id / 兜底文案 --------------------

// 每轮创建独立占位，避免停止后再次发送时按旧 id 原位覆盖，导致思考气泡留在新消息上方。
// 同一轮按 source 复用由 sub.placeholders 保证。
const placeholderId = (convId: string, sourceEmployeeId?: string): string =>
  `pending_${convId}${sourceEmployeeId ? `_${sourceEmployeeId}` : ''}_${crypto.randomUUID()}`

const EMPTY_REPLY_PLACEHOLDER = '(无回复内容)'
let conversationLoadSequence = 0

// -------------------- 通用 helper --------------------

// 会话列表时间戳格式(设计文档 5.1.2):今天 HH:MM,昨天显示"昨天",更早显示 MM-DD。
// 之前是"N 分钟前 / N 小时前 / N 天前"相对时间,与设计不符,已切换到日期分段。
const relativeTime = formatConversationTime

function hhmm(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 置顶是按租户和账号隔离的本机偏好，当前服务端契约不支持 pinned_at。
// key 结构 { [convId]: pinned_at_ISO }，仅用于 Panel 侧本地排序，不表示已同步到其他端。
function getPinnedStorageKey(): string | null {
  const { isAuthenticated, tenantId, claims, account } = useAgentAuthStore.getState()
  const memberId = claims?.user_id ?? account
  return buildPinnedStorageKey({ isAuthenticated, tenantId, memberId })
}

// 加载置顶 map。localStorage 不可用(如隐私模式)或数据损坏时降级为空 map,避免整页崩溃。
function loadPinnedFromStorage(storageKey: string | null): Record<string, string> {
  if (!storageKey) return {}
  return loadPinnedConversations(localStorage, storageKey)
}

// 写回置顶 map。quota / 隐私模式等失败场景静默忽略,内存态仍然有效。
function savePinnedToStorage(pinned: Record<string, string>): void {
  const storageKey = getPinnedStorageKey()
  if (!storageKey) return
  savePinnedConversations(localStorage, storageKey, pinned)
}

// 已读成功后清理本地计数；不使用时间窗口屏蔽后续真实回复的未读数。
function applyUnread(serverUnread: number | undefined): number | undefined {
  return serverUnread || undefined
}

/**
 * 单聊列表只来自真实会话，与员工列表相互独立：没发起过对话的员工不出现；同一员工的多个会话各占一行；
 * 员工已下架时会话仍保留，名称和头像回退到已知值。experts 需包含已下架员工。
 */
function buildConversationItems(
  convs: readonly ConversationMetadata[],
  experts: readonly ExpertProjection[],
  existingConvs: readonly ConversationItem[],
): ConversationItem[] {
  const expertsById = new Map(experts.map((e) => [e.employee_id, e]))
  return convs
    .flatMap((c) => {
      const employeeId = c.entry_employee_id
      if (c.kind === 'group' || !employeeId) return []
      const expert = expertsById.get(employeeId)
      const existing = existingConvs.find((item) => item.id === c.id)
        ?? existingConvs.find((item) => item._employeeId === employeeId)
      const summary = resolveConversationSummary(c)
      const agentName = expert?.display_name ?? existing?.agentName ?? '已下架员工'
      rememberEmployeeConversation(c.id, employeeId)
      const item: ConversationItem = {
        id: c.id,
        // 普通单聊没有标题，显示员工名；自动化任务会话显示任务名。
        title: c.title?.trim() || agentName,
        agentEmoji: existing?.agentEmoji ?? '🤖',
        agentAvatarUrl: expert?.avatar_url !== undefined ? expert.avatar_url : existing?.agentAvatarUrl ?? null,
        agentName,
        lastMessage: summary.preview,
        time: summary.lastMessageAt ? relativeTime(summary.lastMessageAt) : '',
        unread: applyUnread(summary.unreadCount),
        lastMessageAt: summary.lastMessageAt,
        summaryAvailability: summary.availability,
        _employeeId: employeeId,
      }
      // 刚建、还没消息的会话按更新时间排，不沉到列表底部。
      return [{ item, sortAt: summary.lastMessageAt ?? (Date.parse(c.updated_at) || 0) }]
    })
    .sort((a, b) => b.sortAt - a.sortAt)
    .map(({ item }) => item)
}

// 消息按 id upsert;新字段覆盖已有(undefined 除外),不 mutate 入参。
function upsertMessage(msgs: Message[], msg: Message): Message[] {
  const idx = msgs.findIndex((m) => m.id === msg.id)
  if (idx < 0) return [...msgs, msg]
  const existing = msgs[idx]
  const overrides: Partial<Message> = {}
  for (const key of Object.keys(msg) as (keyof Message)[]) {
    const value = msg[key]
    if (value !== undefined) (overrides as Record<string, unknown>)[key] = value
  }
  return msgs.map((m, i) => (i === idx ? { ...existing, ...overrides } : m))
}

function dedupById(msgs: Message[]): Message[] {
  const seen = new Set<string>()
  const out: Message[] = []
  for (const m of msgs) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    out.push(m)
  }
  return out
}

function collectMsgIds(msgs: Message[]): Set<string> {
  const s = new Set<string>()
  for (const m of msgs) s.add(m.id)
  return s
}

// -------------------- 会话订阅注册表 --------------------

// 每个 conversation_id 一个订阅句柄 + 累积状态。切换会话/退出时清理。
interface ConvSubscription {
  convId: string
  handle: EventSubscription
  // sourceEmployeeId(私聊为空字符串) → 已累积的文本 / 思考
  accumulatedText: Map<string, string>
  accumulatedThinking: Map<string, string>
  // sourceEmployeeId → 当前占位消息 id
  placeholders: Map<string, string>
  workIds: Map<string, string>
  textBoundaries: Set<string>
  // 参与本轮 prompt 的 source_employee_id 集合(通过 agent_start / message_update 观察)
  activeSources: Set<string>
  // 已收到 agent_settled 的 source_employee_id
  settledSources: Set<string>
  // SSE 自带的员工身份是流式消息事实源；roster 只在旧事件缺字段时兜底。
  sourceIdentities: Map<string, { displayName?: string; role?: MessageSenderRole }>
  // 后台切换期间保留执行投影；当前模型消息快照不能覆盖此前的执行过程。
  pendingMessages: Map<string, Message>
  historyEntries: ConversationEntry[]
  // 是否已经处于"正在生成"状态(标记 store 的 generatingConvIds)
  generating: boolean
  tracker: SettleTracker | null
  completionTimer: ReturnType<typeof setTimeout> | null
  // 上次 UI flush 时间戳(80ms 节流用)。
  lastFlush: number
}
const subscriptions = new Map<string, ConvSubscription>()

function clearSubscription(convId: string): void {
  const sub = subscriptions.get(convId)
  if (!sub) return
  sub.generating = false
  try {
    sub.handle.close()
  } catch {
    // ignore
  }
  sub.tracker?.release()
  if (sub.completionTimer) clearTimeout(sub.completionTimer)
  subscriptions.delete(convId)
}

function reconciliationActiveEntries(payload: ConversationReconciliation): ConversationEntry[] {
  if (!Array.isArray(payload.active_runs)) return []
  return payload.active_runs.flatMap((run, index) => {
    const message = run?.message
    if (!message || (message.role !== 'assistant' && message.role !== 'user')) return []
    const workId = typeof run.work_id === 'string' && run.work_id ? run.work_id : `active-${index}`
    return [{
      id: `active:${workId}:${index}`,
      type: 'message',
      work_id: typeof run.work_id === 'string' ? run.work_id : undefined,
      source_employee_id: run.source_employee_id,
      source_employee_display_name: run.source_employee_display_name,
      source_role: run.source_role,
      message,
    }]
  })
}

function messageThinkingText(message: Message): string {
  return (message.thinkingSteps ?? [])
    .filter((step): step is Extract<ThinkingStep, { kind: 'reasoning' }> => step.kind === 'reasoning')
    .map((step) => step.text)
    .join('')
}

function mergePendingProjection(messages: Message[], sub: ConvSubscription | undefined): Message[] {
  if (!sub?.generating) return messages
  let next = messages
  for (const message of sub.pendingMessages.values()) {
    const result = reconcileReplyProjection(next, message)
    next = result.messages
    sub.pendingMessages.set(message.id, result.message)
    for (const [key, id] of sub.placeholders) {
      if (id !== message.id) continue
      if (result.message.workId) sub.workIds.set(key, result.message.workId)
      sub.accumulatedText.set(key, result.message.content)
      sub.accumulatedThinking.set(key, messageThinkingText(result.message))
    }
  }
  return dedupById(next)
}

function projectionStreamingIds(current: Set<string>, messages: Message[], sub?: ConvSubscription): Set<string> {
  const ids = collectMsgIds(messages)
  const streaming = new Set([...current].filter(id => ids.has(id)))
  for (const message of sub?.pendingMessages.values() ?? []) {
    if (message._pending && ids.has(message.id)) streaming.add(message.id)
    else streaming.delete(message.id)
  }
  return streaming
}

// -------------------- Store 接口 --------------------

export interface AssistantStreamOptions {
  kind?: 'chat' | 'group'
  targetEmployeeIds?: readonly string[]
  expectedTargetsKnown?: boolean
  /** 本轮 submitPrompt 的幂等键。202 只表示已接受，服务端异步开始执行，
   *  执行真正开始前 prompting 仍为 false；有键时以收据终态判断本轮是否结束。 */
  promptIdempotencyKey?: string
}

interface ChatStore {
  // -- state --
  activeConvId: string
  conversations: ConversationItem[]
  activeConvMessages: Message[]
  activeConvMsgIds: Set<string>
  activeConvRawItems: ConversationEntry[]
  activePagination: { hasMore: boolean; prevCursor: string | null }
  detailOpen: boolean
  conversationDetail: ConversationMetadata | null
  conversationDetailLoading: boolean
  conversationDetailError: RequestErrorInfo | null
  groups: GroupItem[]
  groupSolutions: SolutionProjection[]
  workbenchEmployees: WorkbenchEmployee[]
  workbenchLoading: boolean
  workbenchRefreshing: boolean
  workbenchError: RequestErrorInfo | null
  activeGroupId: string
  groupDetailOpen: boolean
  highlightMsgId: string | null
  draftsByConv: Record<string, { text: string; files: CachedFile[] }>
  streamingMsgIds: Set<string>
  generatingConvIds: Set<string>
  // 本轮生成已结束、正在拉 entries 对齐的会话。对齐会整体替换消息列表，
  // 期间发出的消息会被旧快照覆盖，所以输入栏把它视为本轮的一部分，等对齐完成再发下一条。
  syncingConvIds: Set<string>
  activeMessagesLoading: boolean
  activeMessagesError: RequestErrorInfo | null
  // 会话置顶 map（按账号隔离的本机偏好）。key = conv id，value = 置顶时的 ISO 时间戳。
  // 服务端当前无 pinned_at 字段；不得将该 map 当作跨端同步状态。
  pinnedConvs: Record<string, string>

  // -- actions --
  loadAgentsAndConversations: () => Promise<void>
  refreshConversations: () => Promise<void>
  upgradeConversationId: (oldId: string, newConvId: string, employeeId: string) => void
  setActiveConvId: (id: string) => void
  clearUnread: (convId: string) => void
  clearGroupUnread: (groupId: string) => void
  bumpUnread: (convId: string, preview: string, isGroup?: boolean) => void
  toggleDetail: () => void
  loadConversationDetail: () => Promise<void>
  setActiveGroupId: (id: string) => void
  toggleGroupDetail: () => void
  addConversation: (conv: ConversationItem) => void
  addGroup: (group: GroupItem) => void
  appendMessage: (convId: string, msg: Message) => void
  updateMessageStatus: (convId: string, msgId: string, status: MsgStatus) => void
  updateMessageContent: (convId: string, msgId: string, content: string) => void
  updateMessageThinking: (convId: string, msgId: string, thinking: string) => void
  loadConversation: (convId: string) => Promise<void>
  loadGroupConversation: (groupId: string) => Promise<void>
  // 原地重读当前会话 entries(不清空列表、不显示加载态),用于开启新上下文后补上分隔标记。
  refreshActiveEntries: (convId: string) => Promise<void>
  // 服务端 404 时从列表和 active 里剥离 stale conversation id,避免后续每次交互都重复失败。
  // kind 缺省会同时清 conv/group 两个列表,调用方明确时传入以减少不必要的 set。
  dropStaleConversation: (convId: string, kind?: 'conv' | 'group') => void
  loadMoreMessages: (convId: string, isGroup?: boolean) => Promise<boolean>
  setHighlightMsgId: (id: string | null) => void
  setConvDraft: (convId: string, text: string, files: CachedFile[]) => void
  // 新栈:page 层通过 submitPrompt 发起 prompt 后调用此 action,创建占位并接管 SSE。
  startAssistantStream: (convId: string, opts?: AssistantStreamOptions) => void
  abortStream: (convId: string) => Promise<void>
  // 挂回 UI 侧的兼容函数,新栈无 runId 概念,只是转发到 startAssistantStream。
  resumeAssistantStream: (convId: string) => void
  // 会话置顶切换：只写内存 + localStorage，不调用服务端 PATCH。
  togglePinConversation: (convId: string) => void
}

// -------------------- Store 实现(初值) --------------------

export const useChatStore = create<ChatStore>((set, get) => ({
  activeConvId: '',
  conversations: [],
  activeConvMessages: [],
  activeConvMsgIds: new Set<string>(),
  activeConvRawItems: [],
  activePagination: { hasMore: false, prevCursor: null },
  detailOpen: false,
  conversationDetail: null,
  conversationDetailLoading: false,
  conversationDetailError: null,
  groups: [],
  groupSolutions: [],
  workbenchEmployees: [],
  workbenchLoading: true,
  workbenchRefreshing: false,
  workbenchError: null,
  activeGroupId: '',
  groupDetailOpen: false,
  highlightMsgId: null,
  draftsByConv: {},
  streamingMsgIds: new Set<string>(),
  generatingConvIds: new Set<string>(),
  syncingConvIds: new Set<string>(),
  activeMessagesLoading: false,
  activeMessagesError: null,
  // 会话置顶 map 初值：从当前账号的 localStorage 恢复；隐私模式或数据无效时降级为空。
  // 这是当前唯一置顶来源，只代表本机偏好。
  pinnedConvs: loadPinnedFromStorage(getPinnedStorageKey()),

  // -------- 数据加载 --------

  loadAgentsAndConversations: async () => {
    set({ workbenchLoading: true, workbenchError: null })
    try {
      // 并行:授权专家投影 + 本地会话列表。新栈无 workbench 汇总接口,员工→会话映射由
      // conversations.entry_employee_id 反查得到,不再依赖服务端 conversation_id 字段。
      const [expertsRes, solutionsRes, convsRes] = await Promise.all([
        agentApi.listExperts(),
        agentApi.listSolutions(),
        // 服务端 ConversationQuery.limit 上限 100,再大直接 422 unprocessable。
        // 超过 100 条的场景当前无 UI 分页,暂用上限值兜底;若历史沉淀多,需后续接 next_cursor。
        agentApi.listAllConversations(),
      ])
      const experts = expertsRes.experts.filter((e) => !e.revoked)
      const groupSolutions = solutionsRes.solutions
      // 部分旧版服务端的专家投影不会回传 avatar_url。保留当前 store 中
      // 已经由头像上传接口拿到的地址，避免一次刷新就把头像清空。
      const existingEmployeesById = new Map(
        get().workbenchEmployees.map((employee) => [employee.employeeId, employee]),
      )
      const existingConvs = get().conversations
      const empToConv = new Map<string, ConversationMetadata>()
      const groupConvs: ConversationMetadata[] = []
      for (const c of convsRes.conversations) {
        if (c.kind === 'group') { groupConvs.push(c); continue }
        if (c.entry_employee_id) {
          // 同一员工可能有多个会话,取最新更新的那个作为主会话。
          const cur = empToConv.get(c.entry_employee_id)
          if (!cur || Date.parse(c.updated_at) > Date.parse(cur.updated_at)) empToConv.set(c.entry_employee_id, c)
        }
      }

      const conversations = buildConversationItems(convsRes.conversations, expertsRes.experts, existingConvs)

      const workbenchEmployees: WorkbenchEmployee[] = experts.map((e) => {
        // avatar_url 为空时沿用本地已知值；上传接口返回的 URL 仍然有效。
        const existingEmployee = existingEmployeesById.get(e.employee_id)
        return {
          employeeId: e.employee_id,
          displayName: e.display_name,
          roleName: e.role_title ?? '岗位未设置',
          conversationId: empToConv.get(e.employee_id)?.id ?? null,
          availability_reason: e.availability_reason,
          availability_revision: e.availability_revision,
          status: e.status,
          // 透传 ExpertProjection 中的员工画像字段,供 AgentDetailPanel 使用。
          avatarUrl: e.avatar_url !== undefined ? e.avatar_url : existingEmployee?.avatarUrl ?? null,
          skills: skillDisplayNames(e.skills, e.skill_details),
          persona: e.persona,
          memorySummary: typeof e.memory_summary === 'string' ? e.memory_summary : (typeof e.memory_policy?.summary === 'string' ? e.memory_policy.summary : null),
          modelName: typeof e.model_policy?.model === 'string' ? e.model_policy.model : null,
          modelProvider: typeof e.model_policy?.provider_ref === 'string' ? e.model_policy.provider_ref : null,
          connectorRefs: e.connector_refs ?? [],
          knowledgeRefs: e.knowledge_refs ?? [],
          automationTasks: Array.isArray(e.automation_tasks) ? e.automation_tasks.filter((item): item is string => typeof item === 'string') : [],
          onlineStatus: e.online_status ?? null,
          lastSeenAt: e.last_seen_at ?? null,
        }
      })

      const rosters = new Map(await Promise.all(groupConvs.map(async c => {
        try { return [c.id, participantRoster(await agentApi.getParticipants(c.id), experts)] as const }
        catch { return [c.id, { status: 'unavailable' as const, members: [] as import('../lib/groupRoster').GroupMember[], memberCount: null, message: '群成员读取失败，请刷新重试。' }] as const }
      })))
      const groups: GroupItem[] = groupConvs.map((c) => {
        const roster = rosters.get(c.id)!
        const summary = resolveConversationSummary(c)
        return {
          id: c.id,
          name: c.title ?? '未命名群',
          lastMessage: summary.preview,
          time: summary.lastMessageAt ? relativeTime(summary.lastMessageAt) : '',
          lastMessageAt: summary.lastMessageAt,
          summaryAvailability: summary.availability,
          memberCount: roster.memberCount,
          members: roster.members,
          solutionInstanceId: c.solution_instance_id,
          description: c.description,
          orchestration: c.orchestration,
          rosterStatus: roster.status,
          rosterMessage: roster.message,
          unread: applyUnread(summary.unreadCount),
        }
      }).sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))

      // 旧版 emp_ 占位已不再出现在列表里，不能继续作为当前会话。
      const currentActiveId = get().activeConvId.startsWith('emp_') ? '' : get().activeConvId
      const activeConvId = currentActiveId || conversations[0]?.id || ''
      const currentActiveGroupId = get().activeGroupId
      const activeGroupId = currentActiveGroupId || groups[0]?.id || ''
      set({
        conversations,
        groups,
        groupSolutions,
        workbenchEmployees,
        activeConvId,
        activeGroupId,
        workbenchLoading: false,
        workbenchError: null,
      })
    } catch (err) {
      console.error('[store] loadAgentsAndConversations failed:', err)
      set({
        workbenchLoading: false,
        workbenchError: classifyRequestError(err, '会话与员工列表加载失败，请稍后重试。'),
      })
    }
  },

  refreshConversations: async () => {
    // 复用 loadAgentsAndConversations 的合并逻辑；群成员始终从最新 solution roster 重建。
    set({ workbenchRefreshing: true })
    try {
      const [expertsRes, solutionsRes, convsRes] = await Promise.all([
        agentApi.listExperts(),
        agentApi.listSolutions(),
        // 与 loadAgentsAndConversations 保持一致:服务端 limit 上限 100。
        agentApi.listAllConversations(),
      ])
      const experts = expertsRes.experts.filter((e) => !e.revoked)
      const groupSolutions = solutionsRes.solutions
      // 刷新接口可能暂时不返回 avatar_url（上传接口已成功，但专家投影尚未同步）。
      // 先保留当前内存中的地址，避免头像在刷新后闪回默认图标。
      const existingEmployeesById = new Map(
        get().workbenchEmployees.map((employee) => [employee.employeeId, employee]),
      )
      const empToConv = new Map<string, ConversationMetadata>()
      const groupConvs: ConversationMetadata[] = []
      for (const c of convsRes.conversations) {
        if (c.kind === 'group') { groupConvs.push(c); continue }
        if (c.entry_employee_id) {
          const cur = empToConv.get(c.entry_employee_id)
          if (!cur || Date.parse(c.updated_at) > Date.parse(cur.updated_at)) empToConv.set(c.entry_employee_id, c)
        }
      }
      const existingConvs = get().conversations
      const existingGroups = get().groups
      const workbenchEmployees: WorkbenchEmployee[] = experts.map((e) => {
        const existingEmployee = existingEmployeesById.get(e.employee_id)
        return {
          employeeId: e.employee_id,
          displayName: e.display_name,
          roleName: e.role_title ?? '岗位未设置',
          conversationId: empToConv.get(e.employee_id)?.id ?? null,
          availability_reason: e.availability_reason,
          availability_revision: e.availability_revision,
          status: e.status,
          avatarUrl: e.avatar_url !== undefined ? e.avatar_url : existingEmployee?.avatarUrl ?? null,
          skills: skillDisplayNames(e.skills, e.skill_details),
          persona: e.persona,
          memorySummary: typeof e.memory_summary === 'string' ? e.memory_summary : (typeof e.memory_policy?.summary === 'string' ? e.memory_policy.summary : null),
          modelName: typeof e.model_policy?.model === 'string' ? e.model_policy.model : null,
          modelProvider: typeof e.model_policy?.provider_ref === 'string' ? e.model_policy.provider_ref : null,
          connectorRefs: e.connector_refs ?? [],
          knowledgeRefs: e.knowledge_refs ?? [],
          automationTasks: Array.isArray(e.automation_tasks) ? e.automation_tasks.filter((item): item is string => typeof item === 'string') : [],
          onlineStatus: e.online_status ?? null,
          lastSeenAt: e.last_seen_at ?? null,
        }
      })
      const conversations = buildConversationItems(convsRes.conversations, expertsRes.experts, existingConvs)
      const rosters = new Map(await Promise.all(groupConvs.map(async c => {
        try { return [c.id, participantRoster(await agentApi.getParticipants(c.id), experts)] as const }
        catch { return [c.id, { status: 'unavailable' as const, members: [] as import('../lib/groupRoster').GroupMember[], memberCount: null, message: '群成员读取失败，请刷新重试。' }] as const }
      })))
      const groups: GroupItem[] = groupConvs.map((c) => {
        const existing = existingGroups.find((g) => g.id === c.id)
        const roster = rosters.get(c.id)!
        const summary = resolveConversationSummary(c)
        return {
          id: c.id,
          name: c.title ?? existing?.name ?? '未命名群',
          lastMessage: summary.preview,
          time: summary.lastMessageAt ? relativeTime(summary.lastMessageAt) : '',
          lastMessageAt: summary.lastMessageAt,
          summaryAvailability: summary.availability,
          memberCount: roster.memberCount,
          unread: applyUnread(summary.unreadCount),
          members: roster.members,
          solutionInstanceId: c.solution_instance_id,
          description: c.description,
          orchestration: c.orchestration,
          rosterStatus: roster.status,
          rosterMessage: roster.message,
        }
      }).sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
      set({
        conversations,
        groups,
        groupSolutions,
        workbenchEmployees,
        workbenchRefreshing: false,
        workbenchError: null,
      })
    } catch (err) {
      console.error('[store] refreshConversations failed:', err)
      set({
        workbenchRefreshing: false,
        workbenchError: classifyRequestError(err, '会话与员工列表刷新失败，请稍后重试。'),
      })
    }
  },

  // -------- 会话切换 & 未读 --------

  setActiveConvId: (id) => {
    const prev = get().activeConvId
    if (prev === id) return
    conversationLoadSequence += 1
    // 会话切换不关闭后台 Agent SSE；每个会话保留自己的运行快照，
    // 切回时由 reconciliation 或本地 pending projection 恢复 thinking。
    set({
      activeConvId: id,
      activeConvMessages: [],
      activeConvMsgIds: new Set<string>(),
      activeConvRawItems: [],
      activePagination: { hasMore: false, prevCursor: null },
      detailOpen: false,
      conversationDetail: null,
      conversationDetailLoading: false,
      conversationDetailError: null,
      activeMessagesLoading: false,
      activeMessagesError: null,
    })
  },

  upgradeConversationId: (oldId, newConvId, employeeId) => {
    rememberEmployeeConversation(newConvId, employeeId)
    set((s) => {
      const pinnedConvs = migratePinnedConversationId(s.pinnedConvs, oldId, newConvId)
      if (s.pinnedConvs[oldId]) savePinnedToStorage(pinnedConvs)
      return {
        activeConvId: s.activeConvId === oldId ? newConvId : s.activeConvId,
        conversations: s.conversations.map((c) => c.id === oldId ? { ...c, id: newConvId } : c),
        pinnedConvs,
      }
    })
    const oldSub = subscriptions.get(oldId)
    if (oldSub) {
      subscriptions.delete(oldId)
      subscriptions.set(newConvId, { ...oldSub, convId: newConvId })
    }
  },

  clearUnread: (convId) => {
    set((s) => ({
      conversations: s.conversations.map((c) => c.id === convId ? {
        ...c,
        unread: undefined,
        summaryAvailability: c.summaryAvailability
          ? { ...c.summaryAvailability, unreadCount: true }
          : undefined,
      } : c),
    }))
  },

  clearGroupUnread: (groupId) => {
    set((s) => ({
      groups: s.groups.map((g) => g.id === groupId ? {
        ...g,
        unread: undefined,
        summaryAvailability: g.summaryAvailability
          ? { ...g.summaryAvailability, unreadCount: true }
          : undefined,
      } : g),
    }))
  },

  bumpUnread: (convId, preview, isGroup) => set((s) => {
    // 20 字截断遵循设计文档 5.1.2 单聊列表规范,群聊同处理。
    const trimmed = preview.slice(0, 20)
    const time = relativeTime(Date.now())
    if (isGroup) {
      if (convId === s.activeGroupId) return {}
      const updated = s.groups.map((g) =>
        g.id === convId ? { ...g, lastMessage: trimmed, time, unread: (g.unread ?? 0) + 1 } : g,
      )
      const idx = updated.findIndex((g) => g.id === convId)
      if (idx > 0) updated.unshift(updated.splice(idx, 1)[0])
      return { groups: updated }
    }
    if (convId === s.activeConvId) return {}
    const updated = s.conversations.map((c) =>
      c.id === convId ? { ...c, lastMessage: trimmed, time, unread: (c.unread ?? 0) + 1 } : c,
    )
    const idx = updated.findIndex((c) => c.id === convId)
    if (idx > 0) updated.unshift(updated.splice(idx, 1)[0])
    return { conversations: updated }
  }),

  toggleDetail: () => {
    const { detailOpen } = get()
    const opening = !detailOpen
    set({ detailOpen: opening })
    if (opening) void get().loadConversationDetail()
  },

  loadConversationDetail: async () => {
    const activeConvId = get().activeConvId
    if (!activeConvId || activeConvId.startsWith('emp_')) {
      set({ conversationDetail: null, conversationDetailLoading: false, conversationDetailError: null })
      return
    }
    set({ conversationDetailLoading: true, conversationDetailError: null })
    try {
      const detail = await agentApi.getConversation(activeConvId)
      if (get().activeConvId !== activeConvId) return
      set({ conversationDetail: detail, conversationDetailLoading: false, conversationDetailError: null })
    } catch (err) {
      console.error(`[store] loadConversationDetail ${activeConvId} failed:`, err)
      if (get().activeConvId !== activeConvId) return
      set({
        conversationDetailLoading: false,
        conversationDetailError: classifyRequestError(err, '员工详情加载失败，请稍后重试。'),
      })
    }
  },

  setActiveGroupId: (id) => {
    if (get().activeGroupId === id) return
    // 群聊同样保留后台订阅，避免 fan-out 的参与者在切换期间丢失状态。
    set({
      activeGroupId: id,
      groupDetailOpen: false,
      activeConvMessages: [],
      activeConvMsgIds: new Set<string>(),
      activeConvRawItems: [],
      activePagination: { hasMore: false, prevCursor: null },
      activeMessagesLoading: false,
      activeMessagesError: null,
    })
  },

  toggleGroupDetail: () => set((s) => ({ groupDetailOpen: !s.groupDetailOpen })),
  setHighlightMsgId: (id) => set({ highlightMsgId: id }),

  addConversation: (conv) => set((s) => ({ conversations: [conv, ...s.conversations] })),
  addGroup: (group) => set((s) => ({ groups: [group, ...s.groups] })),

  // -------- 消息读写 --------

  appendMessage: (convId, msg) => set((s) => {
    if (convId !== s.activeConvId && convId !== s.activeGroupId) return {}
    if (s.activeConvMsgIds.has(msg.id)) {
      return { activeConvMessages: upsertMessage(s.activeConvMessages, msg) }
    }
    const nextIds = new Set(s.activeConvMsgIds)
    nextIds.add(msg.id)
    return { activeConvMessages: [...s.activeConvMessages, msg], activeConvMsgIds: nextIds }
  }),

  updateMessageStatus: (convId, msgId, status) => set((s) => {
    if (convId !== s.activeConvId && convId !== s.activeGroupId) return {}
    return { activeConvMessages: s.activeConvMessages.map((m) => m.id === msgId ? { ...m, status } : m) }
  }),

  updateMessageContent: (convId, msgId, content) => set((s) => {
    if (convId !== s.activeConvId && convId !== s.activeGroupId) return {}
    return { activeConvMessages: s.activeConvMessages.map((m) => m.id === msgId ? { ...m, content } : m) }
  }),

  updateMessageThinking: (convId, msgId, thinking) => set((s) => {
    if (convId !== s.activeConvId && convId !== s.activeGroupId) return {}
    return { activeConvMessages: s.activeConvMessages.map((m) => m.id === msgId ? { ...m, thinking } : m) }
  }),

  // -------- 会话加载 --------

  loadConversation: async (convId) => {
    const loadSequence = ++conversationLoadSequence
    set({
      activeConvMessages: [],
      activeConvMsgIds: new Set<string>(),
      activeConvRawItems: [],
      activePagination: { hasMore: false, prevCursor: null },
      activeMessagesLoading: true,
      activeMessagesError: null,
    })
    if (!convId || convId.startsWith('emp_')) {
      set({ activeMessagesLoading: false })
      return
    }
    try {
      const [entriesRes, stateRes] = await Promise.all([
        agentApi.listEntries(convId),
        // 执行状态查询失败不能丢弃已成功读取的历史消息。
        agentApi.getConversationState(convId).catch(() => null),
      ])
      if (get().activeConvId !== convId || loadSequence !== conversationLoadSequence) return
      const subscription = subscriptions.get(convId)
      if (subscription) subscription.historyEntries = entriesRes.entries ?? []
      const resolveEmployeeName = (id: string) => get().workbenchEmployees.find((e) => e.employeeId === id)?.displayName
      const msgs = mergePendingProjection(
        dedupById(entriesToMessages(entriesRes.entries ?? [], resolveEmployeeName)),
        subscription,
      )
      set({
        activeConvMessages: msgs,
        activeConvMsgIds: collectMsgIds(msgs),
        activeConvRawItems: entriesRes.entries ?? [],
        activePagination: { hasMore: false, prevCursor: null },
        activeMessagesLoading: false,
        activeMessagesError: null,
        streamingMsgIds: projectionStreamingIds(get().streamingMsgIds, msgs, subscription),
      })
      // 服务端标记正在执行 prompt → 恢复 SSE 订阅接管流式渲染。
      if (stateRes?.prompting && !subscriptions.has(convId)) {
        get().startAssistantStream(convId)
      }
    } catch (err) {
      // 服务器换栈 / 会话被删除后,本地缓存的 activeConvId 会持续冲 404。
      if (get().activeConvId !== convId || loadSequence !== conversationLoadSequence) return
      // 命中一次就把它从列表和 active 里移除,避免每次刷新都重复失败。
      if (err instanceof AgentApiError && err.status === 404) {
        if (get().activeConvId === convId) {
          set({ activeMessagesLoading: false, activeMessagesError: null })
        }
        get().dropStaleConversation(convId, 'conv')
        return
      }
      console.error(`[store] loadConversation ${convId} failed:`, err)
      if (get().activeConvId === convId) {
        set({
          activeMessagesLoading: false,
          activeMessagesError: classifyRequestError(err, '会话消息加载失败，请稍后重试。'),
        })
      }
    }
  },

  loadGroupConversation: async (groupId) => {
    set({
      activeConvMessages: [],
      activeConvMsgIds: new Set<string>(),
      activeConvRawItems: [],
      activePagination: { hasMore: false, prevCursor: null },
      activeMessagesLoading: true,
      activeMessagesError: null,
    })
    if (!groupId) {
      set({ activeMessagesLoading: false })
      return
    }
    try {
      const [entriesRes, stateRes] = await Promise.all([
        agentApi.listEntries(groupId),
        agentApi.getConversationState(groupId),
      ])
      if (get().activeGroupId !== groupId) return
      const subscription = subscriptions.get(groupId)
      if (subscription) subscription.historyEntries = entriesRes.entries ?? []
      const resolveEmployeeName = (id: string) => get().workbenchEmployees.find((e) => e.employeeId === id)?.displayName
      const msgs = mergePendingProjection(
        dedupById(entriesToMessages(entriesRes.entries ?? [], resolveEmployeeName)),
        subscription,
      )
      set({
        activeConvMessages: msgs,
        activeConvMsgIds: collectMsgIds(msgs),
        activeConvRawItems: entriesRes.entries ?? [],
        activePagination: { hasMore: false, prevCursor: null },
        activeMessagesLoading: false,
        activeMessagesError: null,
        streamingMsgIds: projectionStreamingIds(get().streamingMsgIds, msgs, subscription),
      })
      if (stateRes?.prompting && !subscriptions.has(groupId)) {
        get().startAssistantStream(groupId, { kind: 'group', expectedTargetsKnown: false })
      }
    } catch (err) {
      // 群会话被删除或服务端换栈后,同样需要清理 stale id,否则每次进入群面板都会连打两次 404。
      if (err instanceof AgentApiError && err.status === 404) {
        if (get().activeGroupId === groupId) {
          set({ activeMessagesLoading: false, activeMessagesError: null })
        }
        get().dropStaleConversation(groupId, 'group')
        return
      }
      console.error(`[store] loadGroupConversation ${groupId} failed:`, err)
      if (get().activeGroupId === groupId) {
        set({
          activeMessagesLoading: false,
          activeMessagesError: classifyRequestError(err, '群聊消息加载失败，请稍后重试。'),
        })
      }
    }
  },

  refreshActiveEntries: async (convId) => {
    const res = await agentApi.listEntries(convId)
    if (get().activeConvId !== convId && get().activeGroupId !== convId) return
    // 期间又开始了新一轮生成,交给 SSE 结束后的同步,避免覆盖流式占位。
    if (subscriptions.has(convId)) return
    const resolveEmployeeName = (id: string) => get().workbenchEmployees.find((e) => e.employeeId === id)?.displayName
    const msgs = dedupById(entriesToMessages(res.entries ?? [], resolveEmployeeName))
    set({
      activeConvMessages: msgs,
      activeConvMsgIds: collectMsgIds(msgs),
      activeConvRawItems: res.entries ?? [],
      activePagination: { hasMore: false, prevCursor: null },
    })
  },

  dropStaleConversation: (convId, kind) => {
    clearSubscription(convId)
    set((s) => {
      // 私聊列表:如果被剥离的 id 恰好是当前 activeConvId,补一个 fallback,否则保持不变。
      const patch: Partial<ChatStore> = {}
      if (!kind || kind === 'conv') {
        const conversations = s.conversations.filter((c) => c.id !== convId)
        if (conversations.length !== s.conversations.length) {
          patch.conversations = conversations
          if (s.activeConvId === convId) patch.activeConvId = conversations[0]?.id ?? ''
        }
      }
      if (!kind || kind === 'group') {
        const groups = s.groups.filter((g) => g.id !== convId)
        if (groups.length !== s.groups.length) {
          patch.groups = groups
          if (s.activeGroupId === convId) patch.activeGroupId = groups[0]?.id ?? ''
        }
      }
      if (s.pinnedConvs[convId]) {
        const pinnedConvs = { ...s.pinnedConvs }
        delete pinnedConvs[convId]
        savePinnedToStorage(pinnedConvs)
        patch.pinnedConvs = pinnedConvs
      }
      if (s.draftsByConv[convId]) {
        const draftsByConv = { ...s.draftsByConv }
        delete draftsByConv[convId]
        patch.draftsByConv = draftsByConv
      }
      return patch
    })
  },

  // 新栈 /entries 全量返回,无游标分页;保留签名,始终返回 false。
  loadMoreMessages: async () => false,

  setConvDraft: (convId, text, files) =>
    set((s) => ({ draftsByConv: { ...s.draftsByConv, [convId]: { text, files } } })),

  // -------- 流式订阅入口(核心) --------

  startAssistantStream: (convId, opts) => {
    if (subscriptions.has(convId)) return

    const agentName = get().conversations.find((c) => c.id === convId)?.agentName
      || get().groups.find((g) => g.id === convId)?.name
      || '未知员工'

    const targets = [...new Set((opts?.targetEmployeeIds ?? []).filter(Boolean))]
    const isGroup = opts?.kind === 'group' || get().groups.some((group) => group.id === convId)
    const expectedTargetsKnown = !isGroup || opts?.expectedTargetsKnown === true

    const sub: ConvSubscription = {
      convId,
      // SAFETY: the subscription handle is assigned by startStream before any consumer can use it.
      handle: null as unknown as EventSubscription,
      accumulatedText: new Map(),
      accumulatedThinking: new Map(),
      placeholders: new Map(),
      workIds: new Map(),
      textBoundaries: new Set(),
      activeSources: new Set<string>(),
      settledSources: new Set<string>(),
      sourceIdentities: new Map(),
      pendingMessages: new Map(),
      historyEntries: convId === get().activeConvId || convId === get().activeGroupId ? get().activeConvRawItems : [],
      generating: true,
      tracker: null,
      completionTimer: null,
      lastFlush: 0,
    }
    subscriptions.set(convId, sub)

    set((s) => ({ generatingConvIds: new Set([...s.generatingConvIds, convId]) }))

    // 按 source_employee_id 生成/复用占位消息。私聊 src=undefined 只造一份。
    const ensurePlaceholder = (sourceEmployeeId?: string): string => {
      const key = sourceEmployeeId ?? ''
      const workId = sub.workIds.get(key)
      const existing = sub.placeholders.get(key)
      if (existing) return existing
      // A refresh may already have loaded part of this execution from /entries.
      const isActive = convId === get().activeConvId || convId === get().activeGroupId
      const restored = workId && isActive ? get().activeConvMessages.find((message) => (
        message.role === 'assistant' && message.workId === workId
        && (!isGroup || message.senderEmployeeId === sourceEmployeeId)
      )) : undefined
      if (restored) {
        sub.placeholders.set(key, restored.id)
        sub.accumulatedText.set(key, restored.content)
        sub.accumulatedThinking.set(key, restored.thinking ?? messageThinkingText(restored))
        sub.pendingMessages.set(restored.id, { ...restored, _pending: true })
        set((s) => ({
          streamingMsgIds: new Set([...s.streamingMsgIds, restored.id]),
          activeConvMessages: s.activeConvMessages.map((m) => m.id === restored.id ? { ...m, _pending: true } : m),
        }))
        return restored.id
      }
      const id = placeholderId(convId, sourceEmployeeId)
      sub.placeholders.set(key, id)
      const time = hhmm()
      let senderName: string | undefined
      let senderRole: MessageSenderRole | undefined
      if (sourceEmployeeId) {
        const grp = get().groups.find((g) => g.id === convId)
        const rosterMember = grp?.members?.find((m) => m.employee_id === sourceEmployeeId)
        const eventIdentity = sub.sourceIdentities.get(sourceEmployeeId)
        senderName = eventIdentity?.displayName ?? rosterMember?.display_name ?? sourceEmployeeId
        senderRole = eventIdentity?.role
          ?? (rosterMember?.is_system_planner ? 'coordinator' : 'participant')
      }
      const pendingMessage: Message = {
        id, workId, role: 'assistant', msgType: 'text', content: '', time,
        status: 'sending', senderName, senderEmployeeId: sourceEmployeeId, senderRole,
        _ts: Date.now(), _pending: true,
      }
      sub.pendingMessages.set(id, pendingMessage)
      get().appendMessage(convId, pendingMessage)
      set((s) => ({ streamingMsgIds: new Set([...s.streamingMsgIds, id]) }))
      return id
    }

    // 发送成功即显示思考气泡，无需等到首个 delta。群聊按明确的接收员工占位。
    if (!isGroup) ensurePlaceholder()
    else targets.forEach((employeeId) => ensurePlaceholder(employeeId))

    // 80ms 防抖 flush(与旧栈保持一致);force=true 时忽略节流,用于结束前的最后一段。
    const flushText = (sourceEmployeeId: string | undefined, force = false) => {
      const key = sourceEmployeeId ?? ''
      const now = Date.now()
      if (!force && now - sub.lastFlush < 80) return
      sub.lastFlush = now
      const msgId = ensurePlaceholder(sourceEmployeeId)
      const text = sub.accumulatedText.get(key) ?? ''
      get().updateMessageContent(convId, msgId, text)
      const pending = sub.pendingMessages.get(msgId)
      if (pending) sub.pendingMessages.set(msgId, { ...pending, content: text })
    }

    const finalizePlaceholder = (sourceEmployeeId: string | undefined) => {
      const key = sourceEmployeeId ?? ''
      const msgId = sub.placeholders.get(key)
      if (!msgId) return
      const text = sub.accumulatedText.get(key) ?? ''
      const message = sub.pendingMessages.get(msgId)
      const hasProcess = Boolean(message?.thinkingSteps?.length || message?.thinking)
      const content = text || (hasProcess ? '' : EMPTY_REPLY_PLACEHOLDER)
      if (message) sub.pendingMessages.set(msgId, { ...message, content, status: 'delivered', _pending: false })
      get().updateMessageContent(convId, msgId, content)
      set((s) => {
        const streamingMsgIds = new Set(s.streamingMsgIds); streamingMsgIds.delete(msgId)
        const active = convId === s.activeConvId || convId === s.activeGroupId
        if (!active) return { streamingMsgIds }
        return {
          streamingMsgIds,
          activeConvMessages: s.activeConvMessages.map((m) =>
            m.id === msgId ? { ...m, status: 'delivered' as MsgStatus, _pending: false } : m,
          ),
        }
      })
    }

    const finalizeAll = () => {
      if (!sub.generating) return
      sub.generating = false
      if (sub.completionTimer) {
        clearTimeout(sub.completionTimer)
        sub.completionTimer = null
      }
      for (const key of sub.placeholders.keys()) {
        finalizePlaceholder(key || undefined)
      }
      // SSE 只保证增量,终态后拉一次 entries 做对齐(换成服务端的真实 entry id 与完整内容)。
      // 生成结束与进入对齐在同一次 set 里切换,中间没有「空闲」窗口可供下一条插队发出。
      const isActive = convId === get().activeConvId || convId === get().activeGroupId
      set((s) => {
        const generatingConvIds = new Set(s.generatingConvIds); generatingConvIds.delete(convId)
        if (!isActive) return { generatingConvIds }
        return { generatingConvIds, syncingConvIds: new Set([...s.syncingConvIds, convId]) }
      })
      const notificationState = get()
      void notifyConversationCompleted({
        conversationId: convId,
        kind: isGroup ? 'group' : 'chat',
        activeConversationId: notificationState.activeConvId,
        activeGroupId: notificationState.activeGroupId,
      })
      clearSubscription(convId)
      if (isActive) {
        agentApi.listEntries(convId).then((res) => {
          if (get().activeConvId !== convId && get().activeGroupId !== convId) return
          if (subscriptions.has(convId)) return
          const resolveEmployeeName = (id: string) => get().workbenchEmployees.find((e) => e.employeeId === id)?.displayName
          const msgs = dedupById(entriesToMessages(res.entries ?? [], resolveEmployeeName))
          set({
            activeConvMessages: msgs,
            activeConvMsgIds: collectMsgIds(msgs),
            activeConvRawItems: res.entries ?? [],
          })
        }).catch(console.error).finally(() => {
          set((s) => {
            if (!s.syncingConvIds.has(convId)) return {}
            const syncingConvIds = new Set(s.syncingConvIds); syncingConvIds.delete(convId)
            return { syncingConvIds }
          })
        })
      }
      get().refreshConversations().catch(console.error)
    }

    const tracker = createSettleTracker({
      mode: isGroup ? 'group' : 'single',
      expectedEmployeeIds: targets,
      expectedTargetsKnown,
      onComplete: finalizeAll,
    })
    sub.tracker = tracker

    // 提交后服务端还没开始执行时 prompting=false、entries 里也还没有这条用户消息；
    // 若据此判定结束，会用不含新消息的 entries 覆盖列表并关闭 SSE，用户消息和回复都会消失。
    // 所以有幂等键时，必须等收据离开 accepted（completed/unknown）才承认本轮结束。
    const promptKey = opts?.promptIdempotencyKey
    let promptReceiptSettled = !promptKey
    const isPromptReceiptSettled = async (): Promise<boolean> => {
      if (promptReceiptSettled || !promptKey) return true
      try {
        const receipt = await agentApi.getPromptReceipt(convId, promptKey)
        promptReceiptSettled = receipt.state !== 'accepted'
      } catch (err) {
        // 收据不存在说明无法用它判断，退回只看 prompting；其他错误稍后重试。
        if (err instanceof AgentApiError && err.status === 404) promptReceiptSettled = true
        else throw err
      }
      return promptReceiptSettled
    }

    let completionCheckInFlight = false
    const scheduleConversationCompletionCheck = (delayMs = 0) => {
      if (!sub.generating || completionCheckInFlight || sub.completionTimer) return
      sub.completionTimer = setTimeout(() => {
        sub.completionTimer = null
        if (!sub.generating) return
        completionCheckInFlight = true
        let shouldRetry = false
        agentApi.getConversationState(convId)
          .then(async (state) => {
            if (!sub.generating) return
            if (state.prompting || !(await isPromptReceiptSettled())) shouldRetry = true
            else if (sub.generating) tracker.markConversationEnded()
          })
          .catch((err) => {
            shouldRetry = true
            console.error('[SSE] completion state check failed:', err)
          })
          .finally(() => {
            completionCheckInFlight = false
            if (shouldRetry) scheduleConversationCompletionCheck(250)
          })
      }, delayMs)
    }

    const callbacks: PiStreamCallbacks = {
      onDelta: (chunk, src) => {
        tracker.markRunning(src)
        const key = src ?? ''
        sub.activeSources.add(key)
        const msgId = ensurePlaceholder(src)
        const cur = sub.accumulatedText.get(key) ?? ''
        const separator = sub.textBoundaries.delete(key) && cur ? '\n\n' : ''
        const content = cur + separator + chunk
        sub.accumulatedText.set(key, content)
        // Throttle only the visible render, never the recovery cache.
        const cached = sub.pendingMessages.get(msgId)
        if (cached) sub.pendingMessages.set(msgId, { ...cached, content })
        flushText(src)
      },
      onThinkingDelta: (chunk, src) => {
        tracker.markRunning(src)
        const key = src ?? ''
        sub.activeSources.add(key)
        const msgId = ensurePlaceholder(src)
        const cur = sub.accumulatedThinking.get(key) ?? ''
        const next = cur + chunk
        sub.accumulatedThinking.set(key, next)
        const cached = sub.pendingMessages.get(msgId)
        if (cached) {
          const steps: ThinkingStep[] = [...(cached.thinkingSteps ?? [])]
          const last = steps[steps.length - 1]
          if (last?.kind === 'reasoning') steps[steps.length - 1] = { kind: 'reasoning', text: last.text + chunk }
          else steps.push({ kind: 'reasoning', text: chunk })
          sub.pendingMessages.set(msgId, { ...cached, thinking: next, thinkingSteps: steps })
        }
        set((s) => {
          if (convId !== s.activeConvId && convId !== s.activeGroupId) return {}
          const nextMessages = s.activeConvMessages.map((m) => {
            if (m.id !== msgId) return m
            const steps: ThinkingStep[] = [...(m.thinkingSteps ?? [])]
            const last = steps[steps.length - 1]
            if (last?.kind === 'reasoning') steps[steps.length - 1] = { kind: 'reasoning', text: last.text + chunk }
            else steps.push({ kind: 'reasoning', text: chunk })
            return { ...m, thinking: next, thinkingSteps: steps }
          })
          return { activeConvMessages: nextMessages }
        })
        globalActivityCollector.emit({
          time: hhmm(), agent: agentName, text: '正在思考...', type: 'thinking', convId,
        })
      },
      onToolCall: (call, phase, src) => {
        tracker.markRunning(src)
        const msgId = ensurePlaceholder(src)
        const cached = sub.pendingMessages.get(msgId)
        if (cached) {
          const steps: ThinkingStep[] = cached.thinkingSteps ? [...cached.thinkingSteps] : []
          let hit = false
          for (let i = steps.length - 1; i >= 0; i--) {
            const step = steps[i]
            if (step.kind === 'tool' && step.tool.id === call.id) {
              steps[i] = { kind: 'tool', tool: { ...step.tool, ...Object.fromEntries(Object.entries(call).filter(([, value]) => value !== undefined)) } }
              hit = true
              break
            }
          }
          if (!hit) steps.push({ kind: 'tool', tool: call })
          sub.pendingMessages.set(msgId, { ...cached, thinkingSteps: steps, toolCalls: steps.filter((step): step is Extract<ThinkingStep, { kind: 'tool' }> => step.kind === 'tool').map((step) => step.tool) })
        }
        set((s) => {
          if (convId !== s.activeConvId && convId !== s.activeGroupId) return {}
          return {
            activeConvMessages: s.activeConvMessages.map((m) => {
              if (m.id !== msgId) return m
              const steps: ThinkingStep[] = m.thinkingSteps ? [...m.thinkingSteps] : []
              let hit = false
              for (let i = steps.length - 1; i >= 0; i--) {
                const step = steps[i]
                if (step.kind === 'tool' && step.tool.id === call.id) {
                  steps[i] = { kind: 'tool', tool: { ...step.tool, ...Object.fromEntries(Object.entries(call).filter(([, value]) => value !== undefined)) } }
                  hit = true; break
                }
              }
              if (!hit) steps.push({ kind: 'tool', tool: call })
              return { ...m, thinkingSteps: steps }
            }),
          }
        })
        if (phase === 'exec_end' || phase === 'model_call') {
          globalActivityCollector.emit({
            time: hhmm(), agent: agentName, text: `调用 ${call.name || '工具'}`, type: 'tool', convId,
          })
        }
      },
      onSettled: (src) => {
        if (isGroup && !src) return
        // 最后一段 delta 必须落库,再标记 settled;避免节流吞掉尾部字节。
        flushText(src, true)
        finalizePlaceholder(src)
        sub.settledSources.add(src ?? '')
        tracker.markSettled(src)
        if (isGroup && !expectedTargetsKnown) scheduleConversationCompletionCheck()
      },
      onAgentEnd: (src) => tracker.markRunning(src),
      // 工具权限审批：汇入全局审批 store，ApprovalDialog 弹窗提交决定
      onApprovalRequired: (event) => {
        useApprovalStore.getState().addFromSse(event, convId)
      },
      onError: (msg, src) => {
        const msgId = ensurePlaceholder(src)
        const key = src ?? ''
        const tail = `\n\n⚠️ ${msg}`
        const next = (sub.accumulatedText.get(key) ?? '') + tail
        sub.accumulatedText.set(key, next)
        get().updateMessageContent(convId, msgId, next)
        const cached = sub.pendingMessages.get(msgId)
        if (cached) sub.pendingMessages.set(msgId, { ...cached, content: next })
      },
    }

    const resetSource = (source: string | undefined) => {
      const key = source ?? ''
      finalizePlaceholder(source)
      sub.placeholders.delete(key)
      sub.workIds.delete(key)
      sub.accumulatedText.delete(key)
      sub.accumulatedThinking.delete(key)
      sub.textBoundaries.delete(key)
      sub.settledSources.delete(key)
      tracker.markRunning(source, true)
    }

    const applyReconciliation = (event: ConversationReconciliation) => {
      if (event.conversation_id !== convId) return
      // A reconciliation contains only a recent window. Retain older entries and
      // rebuild work projections from raw entry identities, not concatenated bubbles.
      if (!event.receipt_settlement_pending) {
        const entries = new Map(sub.historyEntries.map(entry => [entry.entry_ref ?? entry.id, entry]))
        for (const entry of event.entries ?? []) entries.set(entry.entry_ref ?? entry.id, entry)
        sub.historyEntries = [...entries.values()]
      }
      const resolveEmployeeName = (id: string) => get().workbenchEmployees.find((e) => e.employeeId === id)?.displayName
      const projected = entriesToMessages(sub.historyEntries, resolveEmployeeName)
      const activeRuns = Array.isArray(event.active_runs) ? event.active_runs : []
      for (const run of activeRuns) {
        if (isGroup && !run.source_employee_id) continue
        const source = isGroup ? run.source_employee_id : undefined
        const key = source ?? ''
        const previousWork = sub.workIds.get(key)
        if ((run.work_id && previousWork && previousWork !== run.work_id)
          || (sub.settledSources.has(key) && run.work_id !== previousWork)) resetSource(source)
        if (run.work_id) sub.workIds.set(key, run.work_id)
        const msgId = ensurePlaceholder(source)
        const cached = sub.pendingMessages.get(msgId)!
        const identity = {
          workId: run.work_id ?? cached.workId,
          senderEmployeeId: run.source_employee_id ?? cached.senderEmployeeId,
          senderName: run.source_employee_display_name ?? cached.senderName,
        }
        // The active message is only the current model round, not the full work.
        // First anchor/merge durable history, then overlay the current snapshot.
        let message = reconcileReplyProjection(projected, { ...cached, ...identity }).message
        const candidate = entriesToMessages(reconciliationActiveEntries({ ...event, active_runs: [run] }), resolveEmployeeName)[0]
        if (candidate?.role === 'assistant') {
          // Synthetic snapshot IDs must never become search/read entry references.
          message = mergeReplyProjection(message, { ...candidate, entryRefs: [], id: msgId }, 'current-message')
        }
        sub.pendingMessages.set(msgId, { ...message, id: msgId, ...identity, _pending: true, status: 'sending' })
        sub.accumulatedText.set(key, message.content)
        sub.accumulatedThinking.set(key, messageThinkingText(message))
        sub.activeSources.add(key)
        sub.settledSources.delete(key)
        tracker.markRunning(source, true)
        if (run.source_employee_display_name) {
          sub.sourceIdentities.set(run.source_employee_id ?? '', {
            displayName: run.source_employee_display_name,
            role: run.source_role === 'human' ? undefined : run.source_role,
          })
        }
      }

      if (event.prompting) {
        sub.generating = true
        set((s) => ({ generatingConvIds: new Set([...s.generatingConvIds, convId]) }))
      }
      // Update background caches too; otherwise switching back revives old projections.
      const reconciled = mergePendingProjection(projected, sub)
      const active = convId === get().activeConvId || convId === get().activeGroupId
      if (active) {
        set((s) => {
          let messages = s.activeConvMessages
          for (const message of reconciled) messages = upsertMessage(messages, message)
          messages = mergePendingProjection(messages, sub)
          return {
            activeConvMessages: messages,
            activeConvMsgIds: collectMsgIds(messages),
            activeConvRawItems: sub.historyEntries,
            streamingMsgIds: projectionStreamingIds(s.streamingMsgIds, messages, sub),
          }
        })
      }
      if (!event.prompting && activeRuns.length === 0 && sub.generating) {
        const receipt = promptKey ? event.receipts?.find((item) => item.idempotency_key === promptKey) : undefined
        if (receipt && receipt.state !== 'accepted') promptReceiptSettled = true
        // 本轮提示还没到终态（执行尚未开始）时不能结束，交给运行态 + 收据轮询确认。
        if (promptReceiptSettled) sub.tracker?.markConversationEnded()
        else scheduleConversationCompletionCheck(250)
      }
    }

    const handle = agentApi.subscribeEvents({
      conversationId: convId,
      onEvent: (event) => {
        if (event.type === 'reconciliation') {
          applyReconciliation(event)
          return
        }
        const source = isGroup ? event.source_employee_id : undefined
        const key = source ?? ''
        // Ordinary SSE has no work_id. A settled employee's next agent_start
        // establishes a new execution; retries before settled stay in the same row.
        if (event.type === 'agent_start' && sub.settledSources.has(key)) resetSource(source)
        if (event.work_id && event.source_role !== 'human' && event.message?.role !== 'user') {
          const previousWorkId = sub.workIds.get(key)
          if (previousWorkId && previousWorkId !== event.work_id) {
            resetSource(source)
          }
          sub.workIds.set(key, event.work_id)
          // Adopt the optimistic bubble created before the first SSE event.
          const pendingId = sub.placeholders.get(key)
          if (pendingId && !previousWorkId) {
            const active = convId === get().activeConvId || convId === get().activeGroupId
            const restored = (active ? get().activeConvMessages : []).find((m) => (
              m.id !== pendingId && m.role === 'assistant' && m.workId === event.work_id
              && (!isGroup || m.senderEmployeeId === source)
            ))
            if (restored) {
              // Single chat creates an optimistic bubble before its work ID is known.
              sub.placeholders.delete(key)
              sub.pendingMessages.delete(pendingId)
              set((s) => {
                const streamingMsgIds = new Set(s.streamingMsgIds)
                streamingMsgIds.delete(pendingId)
                const messages = s.activeConvMessages.filter((m) => m.id !== pendingId)
                return { activeConvMessages: messages, activeConvMsgIds: collectMsgIds(messages), streamingMsgIds }
              })
              ensurePlaceholder(source)
            } else {
              const pending = sub.pendingMessages.get(pendingId)
              if (pending) sub.pendingMessages.set(pendingId, { ...pending, workId: event.work_id })
              set((s) => ({ activeConvMessages: s.activeConvMessages.map((m) => m.id === pendingId ? { ...m, workId: event.work_id } : m) }))
            }
          }
        }
        if (event.type === 'message_end' && event.message?.role === 'assistant') {
          sub.textBoundaries.add(key)
        }
        if (event.type === 'agent_start') tracker.markRunning(event.source_employee_id)
        if (event.source_employee_id) {
          const group = get().groups.find((item) => item.id === convId)
          const rosterMember = group?.members?.find((member) => member.employee_id === event.source_employee_id)
          const identity = resolvePiEventSenderIdentity(event, {
            senderName: rosterMember?.display_name,
            senderRole: rosterMember?.is_system_planner ? 'coordinator' : 'participant',
          })
          sub.sourceIdentities.set(event.source_employee_id, {
            displayName: identity.senderName,
            role: identity.senderRole === 'human' ? undefined : identity.senderRole,
          })
        }
        if (event.type === 'agent_start' && (!isGroup || event.source_employee_id)) {
          ensurePlaceholder(isGroup ? event.source_employee_id : undefined)
        }
        // 单聊来源始终归到同一个气泡，避免携带 source_employee_id 时再造一条占位。
        dispatchPiEvent(isGroup ? event : { ...event, source_employee_id: undefined }, callbacks)
        // Keep the true employee identity even though single-chat routing uses ''.
        // This lets a call ID anchor its live projection to owned history safely.
        if (event.source_employee_id && event.source_role !== 'human' && event.message?.role !== 'user') {
          const id = sub.placeholders.get(key)
          const pending = id ? sub.pendingMessages.get(id) : undefined
          if (pending) {
            const identity = resolvePiEventSenderIdentity(event, {
              senderName: pending.senderName ?? sub.sourceIdentities.get(event.source_employee_id)?.displayName,
              senderRole: pending.senderRole === 'human' ? undefined : pending.senderRole,
            })
            if (pending.senderEmployeeId !== identity.senderEmployeeId
              || pending.senderName !== identity.senderName || pending.senderRole !== identity.senderRole) {
              sub.pendingMessages.set(pending.id, { ...pending, ...identity })
              set((s) => {
                if (convId !== s.activeConvId && convId !== s.activeGroupId) return {}
                return { activeConvMessages: s.activeConvMessages.map(m => m.id === pending.id ? { ...m, ...identity } : m) }
              })
            }
          }
        }
      },
      onError: () => console.error('[SSE] connection failed'),
      onClose: () => {
        // Agent 的会话 SSE 是长连接，transport EOF 不是 prompt 终态；以聚合 prompting=false 确认。
        scheduleConversationCompletionCheck()
      },
    })
    sub.handle = handle
    // 快速回复可能在 SSE 连上前完成；用会话运行态兜底，避免思考气泡一直停留。
    scheduleConversationCompletionCheck(100)
  },

  abortStream: async (convId) => {
    const sub = subscriptions.get(convId)
    try {
      await agentApi.abortConversation(convId)
    } catch (err) {
      console.error('[abortStream] failed:', err)
    }
    if (sub) {
      sub.generating = false
      sub.tracker?.release()
      if (sub.completionTimer) clearTimeout(sub.completionTimer)
      for (const [key, msgId] of sub.placeholders.entries()) {
        const text = sub.accumulatedText.get(key) ?? ''
        const finalContent = (text ? text + '\n\n' : '') + '停止生成'
        get().updateMessageContent(convId, msgId, finalContent)
        set((s) => {
          const streamingMsgIds = new Set(s.streamingMsgIds); streamingMsgIds.delete(msgId)
          const active = convId === s.activeConvId || convId === s.activeGroupId
          if (!active) return { streamingMsgIds }
          return {
            streamingMsgIds,
            activeConvMessages: s.activeConvMessages.map((m) =>
              m.id === msgId ? { ...m, status: 'delivered', _pending: false } : m,
            ),
          }
        })
      }
      set((s) => {
        const generatingConvIds = new Set(s.generatingConvIds); generatingConvIds.delete(convId)
        return { generatingConvIds }
      })
      clearSubscription(convId)
    }
  },

  resumeAssistantStream: (convId) => {
    if (!convId) return
    if (subscriptions.has(convId)) return
    get().startAssistantStream(convId)
  },

  // 会话置顶切换(A2.2):内存 map 立刻更新 + 落 localStorage 持久化。
  // - 无该 convId 键 → 新增,值为当前时刻 ISO(用于同置顶集合内按时间倒序展示)。
  // - 已有键 → 移除即取消置顶,回到默认按最新消息时间排序。
  // 服务端 PATCH 契约不支持 pinned_at，因此这里不发起任何同步请求。
  togglePinConversation: (convId) => {
    if (!convId) return
    const current = get().pinnedConvs
    const next: Record<string, string> = { ...current }
    if (next[convId]) {
      // 取消置顶:直接删掉该键,让排序回退到 lastMessageAt 默认路径。
      delete next[convId]
    } else {
      // 新置顶:记录 ISO 时间戳,便于多个置顶项按后置顶靠前的顺序排列。
      next[convId] = new Date().toISOString()
    }
    set({ pinnedConvs: next })
    savePinnedToStorage(next)
  },
}))

// 鉴权恢复、账号切换或退出时同步对应账号的置顶数据；未登录态始终保持为空。
let activePinnedStorageKey = getPinnedStorageKey()
useAgentAuthStore.subscribe(() => {
  const nextStorageKey = getPinnedStorageKey()
  if (nextStorageKey === activePinnedStorageKey) return
  activePinnedStorageKey = nextStorageKey
  useChatStore.setState({ pinnedConvs: loadPinnedFromStorage(nextStorageKey) })
})
