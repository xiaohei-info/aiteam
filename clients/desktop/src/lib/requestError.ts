export type RequestErrorKind = 'forbidden' | 'unavailable' | 'network' | 'unknown'

export interface RequestErrorInfo {
  kind: RequestErrorKind
  title: string
  message: string
  status?: number
}

export type RequestDataState = 'loading' | 'error' | 'empty' | 'ready'

export function resolveRequestDataState(
  loading: boolean,
  error: RequestErrorInfo | null,
  itemCount: number,
): RequestDataState {
  if (loading) return 'loading'
  if (error) return 'error'
  return itemCount === 0 ? 'empty' : 'ready'
}

interface ErrorLike {
  status?: unknown
  code?: unknown
  message?: unknown
  problem?: {
    status?: unknown
  }
}

const NETWORK_ERROR_CODES = new Set([
  'ERR_NETWORK',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
])

const NETWORK_MESSAGE_PATTERN = /failed to fetch|fetch failed|network\s*error|network request failed|load failed|econn|enetunreach|enotfound|offline/i
const CLIENT_ERROR_MESSAGES: Record<string, string> = {
  client_insecure_api_url: 'API 地址不符合安全策略，请检查应用配置。',
  client_path_denied: '请求被客户端安全策略拒绝，请检查应用配置。',
  client_bad_content_type: '服务返回了无法识别的响应格式，请稍后重试。',
}

function readStatus(error: ErrorLike): number | undefined {
  if (typeof error.status === 'number') return error.status
  return typeof error.problem?.status === 'number' ? error.problem.status : undefined
}

function isNetworkError(error: unknown, value: ErrorLike, status: number | undefined): boolean {
  if (status === 0) return true
  if (error instanceof TypeError) return true
  if (typeof value.code === 'string' && NETWORK_ERROR_CODES.has(value.code.toUpperCase())) return true
  return typeof value.message === 'string' && NETWORK_MESSAGE_PATTERN.test(value.message)
}

export function classifyRequestError(
  error: unknown,
  fallbackMessage = '数据加载失败，请稍后重试。',
): RequestErrorInfo {
  const value = error && typeof error === 'object' ? error as ErrorLike : {}
  const status = readStatus(value)
  const code = typeof value.code === 'string' ? value.code : undefined

  if (code && CLIENT_ERROR_MESSAGES[code]) {
    return {
      kind: 'unknown',
      title: '请求配置错误',
      message: CLIENT_ERROR_MESSAGES[code],
      status,
    }
  }

  if (status === 403) {
    return {
      kind: 'forbidden',
      title: '暂无访问权限',
      message: '当前账号无权查看这些数据。如权限刚刚变更，请重试。',
      status,
    }
  }

  if (status === 410 || status === 503) {
    return {
      kind: 'unavailable',
      title: '服务暂不可用',
      message: status === 410
        ? '此服务当前未开放或正在迁移，请稍后重试。'
        : '服务暂时无法响应，请稍后重试。',
      status,
    }
  }

  if (isNetworkError(error, value, status)) {
    return {
      kind: 'network',
      title: '网络连接失败',
      message: '请检查网络连接后重试。',
      status,
    }
  }

  return {
    kind: 'unknown',
    title: '加载失败',
    message: fallbackMessage,
    status,
  }
}
