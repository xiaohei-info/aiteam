const HTTP_PROTOCOL = 'http:'
const HTTPS_PROTOCOL = 'https:'

export const API_URL_SECURITY_ERROR_CODE = 'client_insecure_api_url'

// Keep this list aligned with src-tauri/capabilities/default.json. Browser-rendered
// remote images must not silently gain access to every HTTPS origin allowed by CSP.
export const TAURI_ALLOWED_REMOTE_HTTPS_ORIGINS = ['https://aifred.cn'] as const

export class ApiUrlSecurityError extends Error {
  readonly code = API_URL_SECURITY_ERROR_CODE

  constructor(message: string) {
    super(message)
    this.name = 'ApiUrlSecurityError'
  }
}

function isRelativeUrl(value: string): boolean {
  return !/^[a-z][a-z\d+.-]*:/i.test(value) && !value.startsWith('//')
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1') {
    return true
  }
  return /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

function parseAbsoluteUrl(value: string, purpose: string): URL {
  try {
    return new URL(value)
  } catch {
    throw new ApiUrlSecurityError(`${purpose}地址无效，已拒绝请求。`)
  }
}

function rejectedOrigin(url: URL): string {
  return url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin
}

/**
 * API 传输策略：相对路径交给同源代理；绝对地址必须是 HTTPS，只有回环主机或
 * 调用方显式传入的精确部署 origin 可用 HTTP。该检查不依赖构建模式。
 */
export function assertSecureApiUrl(
  value: string,
  purpose = 'API',
  allowedRemoteHttpOrigins: readonly string[] = [],
): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new ApiUrlSecurityError(`${purpose}地址为空，已拒绝请求。`)
  }
  if (isRelativeUrl(normalized)) return normalized

  const url = parseAbsoluteUrl(normalized, purpose)
  if (url.username || url.password) {
    throw new ApiUrlSecurityError(`${purpose}地址不得包含账号凭据，已拒绝请求。`)
  }
  if (url.protocol === HTTPS_PROTOCOL) return normalized
  if (url.protocol === HTTP_PROTOCOL && isLoopbackHostname(url.hostname)) return normalized
  if (url.protocol === HTTP_PROTOCOL && allowedRemoteHttpOrigins.includes(url.origin)) return normalized

  const requirement = url.protocol === HTTP_PROTOCOL
    ? '远程 API 必须使用 HTTPS，明文 HTTP 仅允许本机回环地址或应用内固定的部署地址'
    : 'API 仅允许 HTTPS，或使用本机回环地址的 HTTP'
  throw new ApiUrlSecurityError(
    `安全策略已拒绝${purpose}请求：${requirement}。违规地址：${rejectedOrigin(url)}`,
  )
}

/** 下载可额外接受 Tauri/浏览器生成的本地资源协议；远程地址仍执行 API HTTPS 策略。 */
export function assertSecureDownloadUrl(value: string, purpose = '下载'): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new ApiUrlSecurityError(`${purpose}地址为空，已拒绝请求。`)
  }
  if (isRelativeUrl(normalized)) return normalized

  const url = parseAbsoluteUrl(normalized, purpose)
  if (url.protocol === 'data:') return normalized
  if (url.protocol === 'asset:' && isLoopbackHostname(url.hostname)) return normalized
  if (url.protocol === 'blob:' && url.origin !== 'null') {
    assertSecureApiUrl(url.origin, purpose)
    return normalized
  }
  return assertSecureApiUrl(normalized, purpose)
}

/**
 * Image URL policy for content rendered directly by the WebView.
 *
 * Relative and app-generated local URLs use the existing download policy. Absolute
 * HTTP URLs are rejected, while absolute HTTPS URLs must also match Tauri's explicit
 * remote allowlist. This check must run before assigning a value to an img `src`.
 */
export function assertTrustedImageUrl(
  value: string,
  purpose = '图片',
  allowedHttpsOrigins: readonly string[] = TAURI_ALLOWED_REMOTE_HTTPS_ORIGINS,
): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new ApiUrlSecurityError(`${purpose}地址为空，已拒绝加载。`)
  }
  if (isRelativeUrl(normalized)) return normalized

  const url = parseAbsoluteUrl(normalized, purpose)
  if (url.protocol === HTTP_PROTOCOL) {
    throw new ApiUrlSecurityError(`安全策略已拒绝${purpose}加载：绝对图片地址必须使用 HTTPS。`)
  }
  if (url.protocol === HTTPS_PROTOCOL) {
    if (!allowedHttpsOrigins.includes(url.origin)) {
      throw new ApiUrlSecurityError(`安全策略已拒绝${purpose}加载：该 HTTPS 来源不在桌面端允许列表中。`)
    }
    return normalized
  }

  return assertSecureDownloadUrl(normalized, purpose)
}
