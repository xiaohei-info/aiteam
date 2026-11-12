/**
 * 全局活动信号 SSE 订阅。
 *
 * FredServer 路由: GET /api/agent/events
 *
 * 帧格式(text/event-stream):
 *   event: activity
 *   data: <JSON: GlobalActivityEvent>
 *
 * 与 per-conversation 的 `events.ts` 区别:
 *   - 一条连接覆盖当前成员的所有会话,不预先订阅某个具体会话。
 *   - 只携带"哪个会话有动静"的最小信号,不携带会话正文。
 *   - 前端用它做列表补丁与按需订阅(per-conversation SSE),正文仍走会话流 / /entries。
 *
 * 断线(网络错误、HTTP 非 2xx)与服务端正常结束(EOF,如 Agent 重启、代理空闲关闭)都使用指数退避重连;
 * 重连成功后由上层触发一次列表刷新,补齐断连期间可能漏掉的信号。
 */
import { isDocumentedRequest } from './contract'
import { AgentApiError } from './client'
import { pickAgentFetch } from './runtime'
import { resolveBackendBaseUrl } from '../backend/config'
import { DEPLOYED_AGENT_HTTP_ORIGINS } from './config'
import { API_URL_SECURITY_ERROR_CODE, ApiUrlSecurityError, assertSecureApiUrl } from '../urlSecurity'
import { logDevRequest } from '../requestLogging'
import { newRequestCorrelation, recordApplicationLog } from '../../lib/applicationLog'
import { verifyUnauthorizedSession, shouldInvalidateSessionOnUnauthorized } from '../../lib/authSession'
import { createSseFrameStream } from './events'

export type GlobalActivityEvent =
  | {
      type: 'prompt_started'
      conversation_id: string
      employee_id: string | null
      tenant_id: string | null
      member_id: string | null
      source_type: string
      background: boolean
      started_at: string
    }
  | {
      type: 'prompt_settled'
      conversation_id: string
      employee_id: string | null
      tenant_id: string | null
      member_id: string | null
      outcome: string
      last_preview: string | null
      last_message_at: string
      assistant_message_count: number
    }

export interface GlobalActivitySubscribeOptions {
  // 每收到一条全局活动信号调用。
  onEvent: (event: GlobalActivityEvent) => void
  // 连接建立（HTTP 200）后调用；用于区分首次连接与断线重连。
  onConnected?: () => void
  // 网络级错误(HTTP 非 2xx 除 401 之外,或 stream 中断)。可选;默认走内部退避重连。
  onError?: (err: Error) => void
  // 服务端正常结束了这条流(EOF)。仅作通知,订阅仍会按退避策略自动重连。可选。
  onClose?: () => void
  // 用于测试。桌面使用原生 HTTP,浏览器使用全局 fetch。
  fetchImpl?: typeof fetch
}

export interface GlobalActivitySubscription {
  // 主动结束订阅:中止当前请求,后续不会再触发回调。
  close(): void
  readonly isClosed: boolean
}

const INITIAL_RETRY_MS = 500
const MAX_RETRY_MS = 15_000
// 连接稳定该时长后视为"稳定连接",重置退避到初始值。
const STABLE_MS = 30_000

function getToken(): string | null {
  const globalRef = globalThis as { __agentToken?: string | null }
  return globalRef.__agentToken ?? null
}

async function buildGlobalEventsUrl(): Promise<string> {
  const path = '/api/agent/events'
  if (!isDocumentedRequest('GET', path)) throw new AgentApiError('全局活动接口路径无效', 0, { code: 'client_path_denied' })
  const base = await resolveBackendBaseUrl()
  const url = `${base}${path}`
  try {
    return assertSecureApiUrl(url, 'SSE', DEPLOYED_AGENT_HTTP_ORIGINS)
  } catch (err) {
    if (err instanceof ApiUrlSecurityError) {
      throw new AgentApiError(err.message, 0, { code: API_URL_SECURITY_ERROR_CODE })
    }
    throw err
  }
}

interface GlobalRuntime {
  controller: AbortController
  closed: boolean
  fetchImpl: typeof fetch | null
  retryDelayMs: number
  retryTimer: ReturnType<typeof setTimeout> | null
  connectedAt: number | null
}

async function runOnce(rt: GlobalRuntime, onEvent: (event: GlobalActivityEvent) => void, onConnected?: () => void): Promise<void> {
  if (rt.closed) return
  const fetchImpl = rt.fetchImpl ?? (await pickAgentFetch())
  rt.fetchImpl = fetchImpl

  const url = await buildGlobalEventsUrl()
  const correlation = newRequestCorrelation()
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    'X-Request-ID': correlation.request_id,
    traceparent: correlation.traceparent,
  }
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const logResponse = logDevRequest('AgentGlobalActivity', { method: 'GET', url, hasBody: false, requestId: correlation.request_id, traceId: correlation.trace_id })

  let res: Response
  try {
    res = await fetchImpl(url, { method: 'GET', headers, signal: rt.controller.signal })
  } catch (err) {
    logResponse(rt.controller.signal.aborted ? 'cancelled' : 'failed')
    if (rt.controller.signal.aborted) return
    throw err
  }
  logResponse(res.status, { stream: res.ok ? 'connected' : 'rejected' })

  if (!res.ok) {
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {})
      const result = await verifyUnauthorizedSession(token, getToken, async () => {
        const controller = new AbortController()
        const abort = () => controller.abort()
        rt.controller.signal.addEventListener('abort', abort, { once: true })
        if (rt.controller.signal.aborted) controller.abort()
        const timeout = setTimeout(abort, 5000)
        try {
          const identityUrl = url.slice(0, url.indexOf('/api/agent/')) + '/api/agent/whoami'
          const response = await fetchImpl(identityUrl, {
            headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, signal: controller.signal,
          })
          await response.body?.cancel().catch(() => {})
          return response.status
        } finally {
          clearTimeout(timeout)
          rt.controller.signal.removeEventListener('abort', abort)
        }
      })
      if (rt.closed || rt.controller.signal.aborted) return
      if (result === 'confirmed' && shouldInvalidateSessionOnUnauthorized(401, token, getToken())) {
        window.dispatchEvent(new CustomEvent('agent-auth:unauthorized', {
          detail: { reason: 'sse_unauthorized', source: 'global_activity', status: 401, verification: result },
        }))
        throw new AgentApiError('unauthorized', 401, { code: 'unauthorized' })
      }
      // Unconfirmed or stale 401s follow normal backoff; do not stop streaming forever.
      throw new AgentApiError('全局活动流身份校验暂未通过，将重试连接', 503, { code: 'session_verification_deferred' })
    }
    throw new AgentApiError(`全局活动流 HTTP ${res.status}`, res.status)
  }

  if (!res.body) throw new AgentApiError('全局活动流 response has no body', 0)

  rt.connectedAt = Date.now()
  onConnected?.()

  const textStream = res.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(createSseFrameStream())

  const reader = textStream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      // 服务端会下发 event:activity 与周期性 keep-alive 注释行(注释行不会产生帧,直接忽略)。
      if (value.event && value.event !== 'activity' && value.event !== 'message') continue
      if (!value.data) continue
      let parsed: GlobalActivityEvent
      try {
        parsed = JSON.parse(value.data) as GlobalActivityEvent
      } catch {
        continue
      }
      if (parsed.type !== 'prompt_started' && parsed.type !== 'prompt_settled') continue
      try {
        onEvent(parsed)
      } catch {
        // 单个 listener 异常不影响连接。
      }
    }
  } finally {
    recordApplicationLog('info', 'global_activity.closed', { request_id: correlation.request_id, outcome: rt.controller.signal.aborted ? 'cancelled' : 'closed' })
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

/**
 * 订阅全局活动信号。
 *
 * 使用方式:
 *   const sub = subscribeGlobalActivity({ onEvent: (evt) => store.applyGlobalActivity(evt) })
 *   // ...
 *   sub.close()
 */
export function subscribeGlobalActivity(options: GlobalActivitySubscribeOptions): GlobalActivitySubscription {
  const rt: GlobalRuntime = {
    controller: new AbortController(),
    closed: false,
    fetchImpl: options.fetchImpl ?? null,
    retryDelayMs: INITIAL_RETRY_MS,
    retryTimer: null,
    connectedAt: null,
  }

  const close = () => {
    if (rt.closed) return
    rt.closed = true
    rt.controller.abort()
    if (rt.retryTimer) {
      clearTimeout(rt.retryTimer)
      rt.retryTimer = null
    }
  }

  const waitBeforeRetry = async () => {
    // 连接稳定足够久后再断开,视为一次新的故障,退避从头开始。
    if (rt.connectedAt && Date.now() - rt.connectedAt >= STABLE_MS) rt.retryDelayMs = INITIAL_RETRY_MS
    rt.connectedAt = null
    recordApplicationLog('warn', 'global_activity.reconnecting', { duration_ms: rt.retryDelayMs })
    const delay = rt.retryDelayMs
    rt.retryDelayMs = Math.min(MAX_RETRY_MS, Math.round(rt.retryDelayMs * 2))
    await new Promise<void>((resolve) => {
      rt.retryTimer = setTimeout(resolve, delay + Math.random() * 250)
    })
    rt.retryTimer = null
  }

  void (async () => {
    while (!rt.closed) {
      try {
        await runOnce(rt, options.onEvent, options.onConnected)
        if (rt.closed || rt.controller.signal.aborted) return
        // 服务端正常结束流(Agent 重启、代理空闲关闭等)。流一旦结束就收不到实时信号,
        // 必须重连;重连成功后的 onConnected 会触发上层刷新列表,补齐断连期间的信号。
        options.onClose?.()
      } catch (err) {
        if (rt.closed || rt.controller.signal.aborted) return
        // 401 已派发事件;交给 auth store,不再重连。
        if (err instanceof AgentApiError && err.status === 401) return
        // URL 配置错误不会随重试恢复;停止,避免永久重连。
        if (err instanceof AgentApiError && err.code === API_URL_SECURITY_ERROR_CODE) return
        options.onError?.(err instanceof Error ? err : new Error(String(err)))
      }
      if (rt.closed) return
      await waitBeforeRetry()
    }
  })()

  return {
    get isClosed() {
      return rt.closed
    },
    close,
  }
}
