/**
 * AgentApiClient — 新栈传输层。
 *
 * 对齐 FredServer agent_service（Fastify）契约：
 *   - envelope `{data}` / `{data,page}` 解包
 *   - 错误 `application/problem+json` 解码
 *   - 鉴权 Authorization: Bearer <JWT>
 *   - 幂等写请求走 Idempotency-Key
 *
 * 本机 Agent 与后台服务共用传输和路由契约，通过不同目标地址承载对应业务。
 */
import { API_URL_SECURITY_ERROR_CODE, ApiUrlSecurityError, assertSecureApiUrl } from '../urlSecurity'
import { logDevRequest } from '../requestLogging'
import { newRequestCorrelation, recordApplicationLog } from '../../lib/applicationLog'
import { recordAuthDiagnostic, type AuthDiagnosticInput } from '../../lib/authDiagnostics'
import { shouldInvalidateSessionOnUnauthorized } from '../../lib/authSession'
import { DEPLOYED_AGENT_HTTP_ORIGINS } from './config'
import { resolveBackendBaseUrl } from '../backend/config'
import { isDocumentedRequest } from './contract'

import { resolveAgentBaseUrl, pickAgentFetch } from './runtime'
import { classifyTransportFailure } from './transportFailure'

export interface AgentProblem {
  type?: string
  title?: string
  status?: number
  detail?: string
  code?: string
}

// application/problem+json → Error 的封装,业务侧 catch 后可读 status/code 分支处理。
export class AgentApiError extends Error {
  status: number
  code?: string
  problem?: AgentProblem

  constructor(message: string, status: number, options?: { code?: string; problem?: AgentProblem }) {
    super(message)
    this.name = 'AgentApiError'
    this.status = status
    this.code = options?.code
    this.problem = options?.problem
  }
}

type FetchImpl = typeof fetch

export interface AgentClientOptions {
  baseUrl?: string
  resolveBaseUrl?: () => Promise<string>
  getToken?: () => string | null | undefined
  onUnauthorized?: (reason: AuthDiagnosticInput) => void
  // 允许测试注入 mock fetch；桌面使用原生 HTTP，浏览器开发通过 Vite proxy。
  fetchImpl?: FetchImpl
}

export interface AgentRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT'
  path: string
  body?: unknown
  query?: Record<string, string | number | boolean | undefined | null>
  headers?: Record<string, string>
  idempotencyKey?: string
  // 一些接口需要跳过 envelope 解包(例如 /healthz、/readyz 目前返回 { data: {...} },
  // 但保留 raw 出口便于将来加入 SSE / 流式响应)。
  binary?: boolean
  raw?: boolean
  signal?: AbortSignal
}

// 后台与本机 Agent 共用文档契约，通过不同 base URL 分流。
type ApiService = 'agent' | 'backend'

function buildQuery(params?: AgentRequestOptions['query']): string {
  if (!params) return ''
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    usp.append(k, String(v))
  }
  const qs = usp.toString()
  return qs ? `?${qs}` : ''
}

function validateApiUrl(url: string, purpose: string): string {
  try {
    return assertSecureApiUrl(url, purpose, DEPLOYED_AGENT_HTTP_ORIGINS)
  } catch (err) {
    if (err instanceof ApiUrlSecurityError) {
      throw new AgentApiError(err.message, 0, { code: API_URL_SECURITY_ERROR_CODE })
    }
    throw err
  }
}

export class ServiceApiClient {
  private resolveBaseUrl: () => Promise<string>
  private getToken?: () => string | null | undefined
  private onUnauthorized?: (reason: AuthDiagnosticInput) => void
  private fetchImplPromise: Promise<FetchImpl>
  private unauthorizedChecks = new Map<string, Promise<boolean>>()

  private async confirmUnauthorized(baseUrl: string, token: string): Promise<boolean> {
    const key = `${baseUrl}\n${token}`
    let check = this.unauthorizedChecks.get(key)
    if (!check) {
      check = (async () => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)
        const url = validateApiUrl(`${baseUrl}/api/agent/whoami`, `${this.service} API`)
        const logResponse = logDevRequest(this.service === 'agent' ? 'AgentApi' : 'BackendApi', {
          method: 'GET', url, hasBody: false,
        })
        try {
          const fetchImpl = await this.fetchImplPromise
          const response = await fetchImpl(url, {
            headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
            signal: controller.signal,
          })
          logResponse(response.status, { sessionVerification: true })
          await response.body?.cancel().catch(() => {})
          return response.status === 401
        } catch {
          logResponse(controller.signal.aborted ? 'cancelled' : 'failed', { sessionVerification: true })
          // An unavailable identity service cannot establish session expiry.
          return false
        } finally {
          clearTimeout(timeout)
        }
      })()
      this.unauthorizedChecks.set(key, check)
    }
    try { return await check } finally {
      if (this.unauthorizedChecks.get(key) === check) this.unauthorizedChecks.delete(key)
    }
  }

  protected constructor(options: AgentClientOptions, private service: ApiService) {
    // Resolve the host URL at request time, after App has awaited startup.
    this.resolveBaseUrl = options.resolveBaseUrl ?? (options.baseUrl !== undefined
      ? async () => options.baseUrl!
      : service === 'agent' ? resolveAgentBaseUrl : resolveBackendBaseUrl)
    this.getToken = options.getToken
    this.onUnauthorized = options.onUnauthorized
    this.fetchImplPromise = options.fetchImpl
      ? Promise.resolve(options.fetchImpl)
      : pickAgentFetch()
  }

  async request<T = unknown>(options: AgentRequestOptions): Promise<T> {
    if (!isDocumentedRequest(options.method ?? 'GET', options.path)) {
      throw new AgentApiError(
        `${this.service} API: path not allowed: ${options.path}`,
        0,
        { code: 'client_path_denied' },
      )
    }

    if (typeof FormData !== 'undefined' && options.body instanceof FormData) {
      throw new AgentApiError('当前接口文档仅支持 JSON 请求体', 0, { code: 'client_body_denied' })
    }
    const correlation = newRequestCorrelation()
    const method = options.method ?? 'GET'
    const baseUrl = await this.resolveBaseUrl()
    const url = validateApiUrl(`${baseUrl}${options.path}${buildQuery(options.query)}`, `${this.service} API`)

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options.headers,
      'X-Request-ID': correlation.request_id,
      traceparent: correlation.traceparent,
    }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'

    const token = options.headers?.Authorization ? undefined : this.getToken?.()
    if (token) headers.Authorization = `Bearer ${token}`
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey

    const fetchImpl = await this.fetchImplPromise
    const logResponse = logDevRequest(this.service === 'agent' ? 'AgentApi' : 'BackendApi', {
      method,
      url,
      hasBody: options.body !== undefined,
      requestId: correlation.request_id,
      traceId: correlation.trace_id,
      query: options.query,
      body: options.body,
    })
    let res: Response
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
      })
    } catch (error) {
      const failure = classifyTransportFailure(error, this.service === 'agent' ? '本地 Agent' : '企业服务')
      logResponse(options.signal?.aborted ? 'cancelled' : 'failed', { code: failure.code })
      throw new AgentApiError(failure.message, 0, { code: failure.code })
    }

    if (!res.ok) recordApplicationLog('warn', 'http.correlated', {
      request_id: correlation.request_id, trace_id: correlation.trace_id,
      server_request_id: res.headers.get('x-request-id'), status: res.status,
    })
    // 无 body 的成功响应(204 等)
    if (res.status === 204) {
      logResponse(res.status, null)
      return undefined as T
    }

    const contentType = res.headers.get('content-type') ?? ''
    const isJson = contentType.includes('application/json') || contentType.includes('application/problem+json')

    if (!res.ok) {
      // Projection endpoints can forward an upstream Manager 401 even while
      // this service still accepts the session. Verify identity before logout.
      const handleUnauthorized = async () => {
        if (!this.onUnauthorized || !shouldInvalidateSessionOnUnauthorized(res.status, token, this.getToken?.())) return
        const confirmed = options.path === '/api/agent/whoami'
          || await this.confirmUnauthorized(baseUrl, token!)
        if (confirmed && shouldInvalidateSessionOnUnauthorized(res.status, token, this.getToken?.())) {
          this.onUnauthorized({ reason: 'http_unauthorized', source: this.service === 'agent' ? 'agent_http' : 'backend_http', status: res.status })
        } else {
          recordAuthDiagnostic({ reason: 'http_unauthorized_ignored', source: this.service === 'agent' ? 'agent_http' : 'backend_http', status: res.status })
        }
      }
      if (isJson) {
        const problem = (await res.json().catch(() => null)) as AgentProblem | null
        logResponse(res.status, problem)
        await handleUnauthorized()
        throw new AgentApiError(
          problem?.detail ?? problem?.title ?? `HTTP ${res.status}`,
          res.status,
          { code: problem?.code, problem: problem ?? undefined },
        )
      }
      const text = await res.text().catch(() => '')
      logResponse(res.status, text)
      await handleUnauthorized()
      throw new AgentApiError(text || `HTTP ${res.status}`, res.status)
    }

    if (options.binary) {
      try { const blob = await res.blob(); logResponse(res.status); return blob as T }
      catch (error) { logResponse('failed'); throw error }
    }

    if (!isJson) {
      // 非 JSON 成功响应通常是 raw 路径或 SPA fallback。前者交给调用方,
      // 后者(数字字符索引 keys)通常意味着 dev proxy 没配对,直接报错更容易发现。
      const text = await res.text().catch(() => '')
      logResponse(res.status, text)
      if (options.raw) return text as T
      const preview = text.slice(0, 80)
      throw new AgentApiError(
        `Unexpected non-JSON response for ${options.path}: ${preview}`,
        res.status,
        { code: 'client_bad_content_type' },
      )
    }

    let payload: unknown
    try {
      payload = await res.json()
    } catch {
      logResponse('failed', { status: res.status, code: 'client_bad_response' })
      const serviceName = this.service === 'agent' ? '本地 Agent' : '企业服务'
      throw new AgentApiError(`${serviceName}响应读取失败或 JSON 格式无效，请重试。`, res.status, { code: 'client_bad_response' })
    }
    logResponse(res.status, payload)
    if (options.raw) return payload as T
    // envelope 统一在 client 层解包,业务层拿到的是 data 本身,不用再 .data.data。
    if (payload && typeof payload === 'object' && 'data' in payload) {
      return (payload as { data: T }).data
    }
    return payload as T
  }
}

export class AgentApiClient extends ServiceApiClient {
  constructor(options: AgentClientOptions = {}) {
    super(options, 'agent')
  }
}
