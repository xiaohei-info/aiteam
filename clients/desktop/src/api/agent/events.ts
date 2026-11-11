/**
 * 会话级 SSE 订阅。
 *
 * FredServer 路由: GET /api/agent/conversations/:id/events
 *
 * 帧格式(text/event-stream):
 *   id: <event_id>
 *   event: pi
 *   data: <JSON: PiSseEventData>
 *   event: reconciliation
 *   data: <JSON: ConversationReconciliation>（连接 fence 后的快照，无 id）
 *
 * 关键约束(见 docs/archive/api-agent-migration.md §3.4 §五#3):
 *   1. 每个 conversation 最多一个活动订阅(重复 subscribe 复用现有连接)。
 *   2. 事件 id 去重:同一 id 收到多次(网络重放/重连)只回调一次。
 *   3. 断线重连使用指数退避,重连时携带 ?after=<lastEventId>,服务端规定 after 优先于 Last-Event-ID。
 *   4. 群聊 fan-out 的终态跟踪由上层 piConverters / store 处理,这里只保证不丢事件、不重复回调。
 *   5. 因 EventSource 不支持自定义 Authorization header,统一用 fetch stream 手动解析 SSE。
 */
import { isDocumentedRequest } from './contract'
import { AgentApiError } from './client'
import { pickAgentFetch } from './runtime'
import { resolveBackendBaseUrl } from '../backend/config'
import { DEPLOYED_AGENT_HTTP_ORIGINS } from './config'
import { API_URL_SECURITY_ERROR_CODE, ApiUrlSecurityError, assertSecureApiUrl } from '../urlSecurity'
import { logDevRequest } from '../requestLogging'
import { newRequestCorrelation, recordApplicationLog } from '../../lib/applicationLog'
import { recordAuthDiagnostic } from '../../lib/authDiagnostics'
import { verifyUnauthorizedSession, shouldInvalidateSessionOnUnauthorized } from '../../lib/authSession'
import type { ConversationReconciliation, PiSseEventData } from './types'

export type AgentSseEvent = PiSseEventData | ConversationReconciliation

// -------------------- SSE 帧解析 --------------------

// 一次 SSE 帧的最小结构。event 缺省为 'message',id 用于 `after` 续读。
export interface SseFrame {
  id?: string
  event: string
  data: string
}

// text/event-stream 解析器:按行读取,遇空行时 flush 当前帧。
// 允许多行 data(SSE 规范把多个 data 行拼成 \n 连接的字符串)。
function createSseFrameStream(): TransformStream<string, SseFrame> {
  let buffer = ''
  let currentId: string | undefined
  let currentEvent = 'message'
  let currentData: string[] = []

  const emit = (controller: TransformStreamDefaultController<SseFrame>) => {
    if (currentData.length === 0 && currentId === undefined && currentEvent === 'message') {
      // 完全空的分隔块,直接跳过。
      return
    }
    controller.enqueue({
      id: currentId,
      event: currentEvent,
      data: currentData.join('\n'),
    })
    currentId = undefined
    currentEvent = 'message'
    currentData = []
  }

  const handleLine = (line: string, controller: TransformStreamDefaultController<SseFrame>) => {
    if (line === '') {
      emit(controller)
      return
    }
    // 注释行(SSE 规范)。keep-alive 走这里,直接忽略。
    if (line.startsWith(':')) return
    const colonIdx = line.indexOf(':')
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx)
    let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1)
    // SSE 规范:冒号后允许一个可选空格。
    if (value.startsWith(' ')) value = value.slice(1)
    switch (field) {
      case 'id':
        currentId = value
        break
      case 'event':
        currentEvent = value || 'message'
        break
      case 'data':
        currentData.push(value)
        break
      // retry 字段暂不处理(我们自己控制退避)。
      default:
        break
    }
  }

  return new TransformStream<string, SseFrame>({
    transform(chunk, controller) {
      buffer += chunk
      // 兼容 \r\n、\r、\n 换行。
      const normalized = buffer.replace(/\r\n?/g, '\n')
      const lines = normalized.split('\n')
      // 最后一段可能是不完整行,留到下次。
      buffer = lines.pop() ?? ''
      for (const line of lines) handleLine(line, controller)
    },
    flush(controller) {
      if (buffer.length > 0) {
        handleLine(buffer, controller)
        buffer = ''
      }
      // 结束时如果还有累积帧,强制 flush(容忍服务端没有以空行收尾)。
      if (currentData.length > 0) emit(controller)
    },
  })
}

// -------------------- 订阅句柄 & 回调 --------------------

export interface EventSubscribeOptions {
  conversationId: string
  // 从这条 event id 之后开始拉取(不含该 id 本身)。断线续读时传上一次收到的 lastEventId。
  after?: string | null
  // 每收到一条 Agent SSE 事件调用。已完成 id 去重；reconciliation 帧没有 id。
  onEvent: (event: AgentSseEvent, eventId: string | undefined) => void
  // 网络级错误(HTTP 非 2xx 除 401 之外,或 stream 中断)。可选;默认走内部退避重连。
  onError?: (err: Error) => void
  // 服务端主动关闭(stream 正常 end)。UI 可据此判断"服务端认为本次事件流已结束"。
  onClose?: () => void
  // 用于测试。桌面使用原生 HTTP，浏览器使用全局 fetch。
  fetchImpl?: typeof fetch
}

export interface EventSubscription {
  readonly conversationId: string
  // 主动结束订阅:中止当前请求,后续不会再触发回调。
  close(): void
  // 只读快照:UI 可用来做"重连指示"。
  readonly lastEventId: string | null
  readonly isClosed: boolean
}

// -------------------- 订阅注册表 --------------------

// 每个 conversation 只允许一个活动订阅。重复 subscribe 复用同一句柄,
// 新回调追加到同一广播列表,close 时按 unsubscribe 计数决定是否真的中止连接。
interface Registration {
  conversationId: string
  controller: AbortController
  seenIds: Set<string>
  lastEventId: string | null
  listeners: Set<EventSubscribeOptions>
  closed: boolean
  fetchImpl: typeof fetch | null
  // 退避状态:连接稳定 30s 后重置。
  retryDelayMs: number
  retryTimer: ReturnType<typeof setTimeout> | null
  connectedAt: number | null
}

// key = conversationId,同一进程内单例。
const registry = new Map<string, Registration>()

const INITIAL_RETRY_MS = 500
const MAX_RETRY_MS = 15_000
// 连接稳定该时长后视为"稳定连接",重置退避到初始值。
const STABLE_MS = 30_000
// 单条 SSE 事件缓存长度上限,防止长时间连接内存膨胀。
const MAX_SEEN_IDS = 5_000

function trimSeenIds(set: Set<string>) {
  if (set.size <= MAX_SEEN_IDS) return
  const excess = set.size - Math.floor(MAX_SEEN_IDS * 0.9)
  const iter = set.values()
  for (let i = 0; i < excess; i++) {
    const first = iter.next()
    if (first.done) break
    set.delete(first.value)
  }
}

function getToken(): string | null {
  const globalRef = globalThis as { __agentToken?: string | null }
  return globalRef.__agentToken ?? null
}

async function buildEventsUrl(conversationId: string, after?: string | null): Promise<string> {
  const path = `/api/agent/conversations/${encodeURIComponent(conversationId)}/events`
  if (!isDocumentedRequest('GET', path)) throw new AgentApiError('会话事件接口路径无效', 0, { code: 'client_path_denied' })
  const base = await resolveBackendBaseUrl()
  const url = after ? `${base}${path}?after=${encodeURIComponent(after)}` : `${base}${path}`
  try {
    return assertSecureApiUrl(url, 'SSE', DEPLOYED_AGENT_HTTP_ORIGINS)
  } catch (err) {
    if (err instanceof ApiUrlSecurityError) {
      throw new AgentApiError(err.message, 0, { code: API_URL_SECURITY_ERROR_CODE })
    }
    throw err
  }
}

async function runStream(reg: Registration): Promise<void> {
  if (reg.closed) return
  const fetchImpl = reg.fetchImpl ?? (await pickAgentFetch())
  reg.fetchImpl = fetchImpl

  const url = await buildEventsUrl(reg.conversationId, reg.lastEventId)
  const correlation = newRequestCorrelation()
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    'X-Request-ID': correlation.request_id,
    traceparent: correlation.traceparent,
    // 双保险:同时传 after 参数和 Last-Event-ID,服务端规定 after 优先。
    ...(reg.lastEventId ? { 'Last-Event-ID': reg.lastEventId } : {}),
  }
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const logResponse = logDevRequest('AgentSse', { method: 'GET', url, hasBody: false, requestId: correlation.request_id, traceId: correlation.trace_id })

  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: reg.controller.signal,
    })
  } catch (err) {
    logResponse(reg.controller.signal.aborted ? 'cancelled' : 'failed')
    if (reg.controller.signal.aborted) return
    throw err
  }
  logResponse(res.status, { stream: res.ok ? 'connected' : 'rejected' })

  if (!res.ok) {
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {})
      const result = await verifyUnauthorizedSession(token, getToken, async () => {
        const controller = new AbortController()
        const abort = () => controller.abort()
        reg.controller.signal.addEventListener('abort', abort, { once: true })
        if (reg.controller.signal.aborted) controller.abort()
        const timeout = setTimeout(abort, 5000)
        try {
          const identityUrl = url.slice(0, url.indexOf('/api/agent/conversations/')) + '/api/agent/whoami'
          const response = await fetchImpl(identityUrl, {
            headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, signal: controller.signal,
          })
          await response.body?.cancel().catch(() => {})
          return response.status
        } finally {
          clearTimeout(timeout)
          reg.controller.signal.removeEventListener('abort', abort)
        }
      })
      if (reg.closed || reg.controller.signal.aborted) return
      if (result === 'confirmed' && shouldInvalidateSessionOnUnauthorized(401, token, getToken())) {
        window.dispatchEvent(new CustomEvent('agent-auth:unauthorized', {
          detail: { reason: 'sse_unauthorized', source: 'sse', status: 401, verification: result },
        }))
        throw new AgentApiError('unauthorized', 401, { code: 'unauthorized' })
      }
      recordAuthDiagnostic({ reason: 'sse_unauthorized_ignored', source: 'sse', status: 401, verification: result })
      // Unconfirmed or stale 401s follow normal backoff; do not stop streaming forever.
      throw new AgentApiError('事件流身份校验暂未通过，将重试连接', 503, { code: 'session_verification_deferred' })
    }
    // 非 2xx 一律作为错误抛出,由 runWithReconnect 决定是否重连。
    throw new AgentApiError(`SSE HTTP ${res.status}`, res.status)
  }

  if (!res.body) throw new AgentApiError('SSE response has no body', 0)

  reg.connectedAt = Date.now()

  const textStream = res.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(createSseFrameStream())

  const reader = textStream.getReader()
  try {
    // 读到 done 就是服务端主动关闭。中止会抛 AbortError,由外层 catch 判定。
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      // 服务端可能同时下发 event:pi、event:reconciliation 与 keep-alive。
      if (value.event && value.event !== 'pi' && value.event !== 'message' && value.event !== 'reconciliation') continue
      const eventId = value.id
      // 只有带 id 的事件才参与去重。keep-alive 不带 id,天然跳过。
      if (eventId) {
        if (reg.seenIds.has(eventId)) continue
        reg.seenIds.add(eventId)
        trimSeenIds(reg.seenIds)
        reg.lastEventId = eventId
      }
      if (!value.data) continue
      let parsed: AgentSseEvent
      try {
        parsed = JSON.parse(value.data) as AgentSseEvent
      } catch {
        // 解析失败(不应发生):忽略这一条,下一条继续。
        continue
      }
      if (value.event === 'reconciliation' && parsed.type !== 'reconciliation') continue
      if (value.event !== 'reconciliation' && parsed.type === 'reconciliation') continue
      for (const listener of Array.from(reg.listeners)) {
        try {
          listener.onEvent(parsed, eventId)
        } catch {
          // 单个 listener 异常不影响其他 listener。
        }
      }
    }
  } finally {
    recordApplicationLog('info', 'stream.closed', { request_id: correlation.request_id, conversation_id: reg.conversationId, outcome: reg.controller.signal.aborted ? 'cancelled' : 'closed' })
    // releaseLock 在流被 abort 后调用会抛;吞掉即可。
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

async function runWithReconnect(reg: Registration): Promise<void> {
  while (!reg.closed) {
    try {
      await runStream(reg)
      // 服务端正常关闭:通知 listener 并结束(不自动重连,避免无限空拉)。
      for (const listener of Array.from(reg.listeners)) {
        try {
          listener.onClose?.()
        } catch {
          // 忽略 listener 异常
        }
      }
      return
    } catch (err) {
      if (reg.controller.signal.aborted || reg.closed) return
      // 401 由 runStream 派发事件后再抛;这里直接结束订阅,交给 auth store。
      if (err instanceof AgentApiError && err.status === 401) {
        reg.closed = true
        return
      }
      const errorObj = err instanceof Error ? err : new Error(String(err))
      for (const listener of Array.from(reg.listeners)) {
        try {
          listener.onError?.(errorObj)
        } catch {
          // 忽略 listener 异常
        }
      }
      // URL 配置错误不会随重试恢复；明确通知一次后停止，避免永久重连。
      if (err instanceof AgentApiError && err.code === API_URL_SECURITY_ERROR_CODE) {
        reg.closed = true
        return
      }
      // 稳定连接后再断线,退避从头计。
      if (reg.connectedAt && Date.now() - reg.connectedAt >= STABLE_MS) {
        reg.retryDelayMs = INITIAL_RETRY_MS
      }
      recordApplicationLog('warn', 'stream.reconnecting', { conversation_id: reg.conversationId, duration_ms: reg.retryDelayMs })
      const delay = reg.retryDelayMs
      // 指数退避 + 少量抖动(避免所有重连同一时刻发生)。
      reg.retryDelayMs = Math.min(MAX_RETRY_MS, Math.round(reg.retryDelayMs * 2))
      const jitter = Math.random() * 250
      await new Promise<void>((resolve) => {
        reg.retryTimer = setTimeout(resolve, delay + jitter)
      })
      reg.retryTimer = null
    }
  }
}

// -------------------- 对外 API --------------------

/**
 * 订阅指定会话的 SSE 事件流。
 *
 * 使用方式:
 *   const sub = subscribeConversationEvents({
 *     conversationId,
 *     after: lastEventId,       // 断线续读时传上一次的 lastEventId
 *     onEvent: (evt, id) => { ... },
 *     onError: (err) => { ... },
 *     onClose: () => { ... },
 *   })
 *   // ...
 *   sub.close()
 *
 * 同一 conversationId 重复调用会复用底层连接,后续 close 需要每个订阅各调一次。
 */
export function subscribeConversationEvents(options: EventSubscribeOptions): EventSubscription {
  const existing = registry.get(options.conversationId)
  if (existing && !existing.closed) {
    existing.listeners.add(options)
    // 复用连接时以连接自身游标为准。调用方传入的 after 可能来自旧快照，
    // 直接覆盖会跳过当前连接尚未分发的事件（事件 ID 也不保证可作字符串排序）。
    return buildSubscriptionHandle(existing, options)
  }

  const controller = new AbortController()
  const reg: Registration = {
    conversationId: options.conversationId,
    controller,
    seenIds: new Set<string>(),
    lastEventId: options.after ?? null,
    listeners: new Set([options]),
    closed: false,
    fetchImpl: options.fetchImpl ?? null,
    retryDelayMs: INITIAL_RETRY_MS,
    retryTimer: null,
    connectedAt: null,
  }
  registry.set(options.conversationId, reg)
  // 后台运行;错误已在内部消化,这里不要 unhandled rejection。
  void runWithReconnect(reg).finally(() => {
    // 退出主循环时清理注册表(如果这个 reg 仍是当前 reg 才清理)。
    if (registry.get(options.conversationId) === reg) {
      registry.delete(options.conversationId)
    }
  })
  return buildSubscriptionHandle(reg, options)
}

function buildSubscriptionHandle(reg: Registration, listener: EventSubscribeOptions): EventSubscription {
  let handleClosed = false
  return {
    get conversationId() {
      return reg.conversationId
    },
    get lastEventId() {
      return reg.lastEventId
    },
    get isClosed() {
      return handleClosed || reg.closed
    },
    close() {
      if (handleClosed) return
      handleClosed = true
      reg.listeners.delete(listener)
      if (reg.listeners.size === 0) {
        reg.closed = true
        reg.controller.abort()
        if (reg.retryTimer) {
          clearTimeout(reg.retryTimer)
          reg.retryTimer = null
        }
      }
    },
  }
}

// 供测试使用:清空注册表。生产代码不应依赖此接口。
export function __resetSubscriptionsForTest(): void {
  for (const reg of registry.values()) {
    reg.closed = true
    reg.controller.abort()
    if (reg.retryTimer) clearTimeout(reg.retryTimer)
  }
  registry.clear()
}

// 暴露最小工具给单测:直接使用 SSE 帧解析。
export const __testables = { createSseFrameStream }
