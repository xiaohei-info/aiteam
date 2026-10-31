import { recordApplicationLog } from '../lib/applicationLog.ts'

export interface RequestLogInput {
  requestId?: string
  traceId?: string
  method: string
  url: string
  hasBody: boolean
  query?: unknown
  body?: unknown
}

export interface SafeRequestMetadata {
  method: string
  url: string
  origin: string
  path: string
  hasQuery: boolean
  hasBody: boolean
}

const SAFE_PARSE_ORIGIN = 'https://request.invalid'
const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i
const OPAQUE_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{24,}$/
const PUBLIC_ROUTE_SEGMENTS = new Set(['resolve-tenant-by-account'])
const SENSITIVE_VALUE_ROUTES = new Set([
  'access-token',
  'authorization',
  'cookie',
  'cookies',
  'jwt',
  'password',
  'reset-password',
  'secret',
  'session',
  'sessions',
  'token',
  'tokens',
])

function shouldRedactSegment(segment: string, previousSegment: string | undefined): boolean {
  const decoded = (() => {
    try {
      return decodeURIComponent(segment)
    } catch {
      return null
    }
  })()

  if (decoded === null) return true

  if (previousSegment && SENSITIVE_VALUE_ROUTES.has(previousSegment.toLowerCase())) return true
  if (PUBLIC_ROUTE_SEGMENTS.has(decoded)) return false
  return decoded.includes('@')
    || JWT_PATTERN.test(decoded)
    || UUID_PATTERN.test(decoded)
    || OPAQUE_SEGMENT_PATTERN.test(decoded)
}

function sanitizePath(pathname: string): string {
  const segments = pathname.split('/')
  return segments.map((segment, index) => {
    if (!segment) return segment
    return shouldRedactSegment(segment, segments[index - 1]) ? ':redacted' : segment
  }).join('/') || '/'
}

export function createSafeRequestMetadata(input: RequestLogInput): SafeRequestMetadata {
  let parsed: URL
  try {
    parsed = new URL(input.url, typeof window !== 'undefined' ? window.location?.origin ?? SAFE_PARSE_ORIGIN : SAFE_PARSE_ORIGIN)
  } catch {
    return {
      method: input.method.toUpperCase(),
      url: '<invalid-url>',
      origin: '<invalid-url>',
      path: '<invalid-url>',
      hasQuery: false,
      hasBody: input.hasBody,
    }
  }

  const path = sanitizePath(parsed.pathname)
  const origin = parsed.origin === SAFE_PARSE_ORIGIN ? '' : parsed.origin
  return {
    method: input.method.toUpperCase(),
    url: `${origin}${path}${parsed.search ? '?<redacted>' : ''}`,
    origin,
    path,
    hasQuery: parsed.search.length > 0,
    hasBody: input.hasBody,
  }
}

// Bound output size before serializing; never log live request/response objects.
const PRIVATE_FIELD = /password|passwd|token|authorization|cookie|secret|api[_-]?key|account|email|phone/i

export type SanitizedLogValue = string | number | boolean | null | undefined | SanitizedLogValue[] | { [key: string]: SanitizedLogValue }

export function sanitizeLogValue(value: unknown, depth = 0): SanitizedLogValue {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    return value.replace(/Bearer\s+[^\s"']+/gi, '[redacted]')
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
      .slice(0, 200)
  }
  if (depth >= 4) return '[truncated]'
  if (Array.isArray(value)) {
    const items = value.slice(0, 3).map(item => sanitizeLogValue(item, depth + 1))
    return value.length > 3 ? [...items, `[+${value.length - 3} items]`] : items
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, item]) => [
      key,
      PRIVATE_FIELD.test(key) || (/^(data|data_base64|audio)$/i.test(key) && typeof item === 'string')
        ? '[redacted]' : sanitizeLogValue(item, depth + 1),
    ]))
  }
  return undefined
}

const observedOrigins = new Map<string, string>()

/** Backend owns successful request history; frontend only records gaps and connection changes. */
export function logDevRequest(scope: string, input: RequestLogInput): (status: number | 'failed' | 'cancelled', result?: unknown) => void {
  const metadata = createSafeRequestMetadata(input)
  const started = performance.now()
  const fields = { method: metadata.method, route: metadata.path, origin: metadata.origin,
    request_id: input.requestId, trace_id: input.traceId, dependency: scope }
  if (observedOrigins.get(scope) !== metadata.origin) {
    if (observedOrigins.size >= 20) observedOrigins.clear()
    observedOrigins.set(scope, metadata.origin)
    recordApplicationLog('info', 'connection.target_observed', { origin: metadata.origin, dependency: scope })
  }
  let completed = false
  return (status, _result) => {
    if (completed) return
    completed = true
    // _result is intentionally never inspected/serialized: even successful responses can contain secrets.
    const duration = performance.now() - started
    if (typeof status === 'number' && status < 400 && duration < 3000) return
    recordApplicationLog(status === 'failed' || typeof status === 'number' && status >= 500 ? 'error' : status === 'cancelled' || typeof status === 'number' && status >= 400 ? 'warn' : 'info', 'http.finished', {
      ...fields, status: typeof status === 'number' ? status : 0,
      outcome: typeof status === 'number' ? 'response' : status, duration_ms: duration,
    })
  }
}
