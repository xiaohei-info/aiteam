export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export interface ApplicationLogRecord {
  schema_version: 1
  timestamp: string
  service: 'desktop-ui'
  instance_id: string
  level: LogLevel
  event: string
  fields: Record<string, string | number | boolean>
}
const LIMIT = 1000
const instanceId = globalThis.crypto.randomUUID()
let records: ApplicationLogRecord[] = []
let dropped = 0
let sinkFailures = 0
let sink: ((record: ApplicationLogRecord) => void) | undefined
const identifiers = /^(?:[0-9a-f]{8}-[0-9a-f-]{27}|req_[0-9a-f]{32}|[0-9a-f]{32})$/i
const numberFields = new Set(['status', 'duration_ms', 'count', 'retry', 'dropped', 'with_source', 'null_source', 'missing_source', 'matched', 'via_source', 'via_link'])
const codeFields = new Set(['code', 'error_type', 'phase', 'outcome', 'view', 'method', 'dependency', 'connection_mode'])
const idFields = new Set(['request_id', 'server_request_id', 'trace_id', 'conversation_id', 'work_id'])
const routeWords = new Set('api agent auth manager operation healthz readyz metrics login logout whoami conversations entries state context participants prompt abort events stream grants experts solutions snapshots readiness sync work-records changes usage statistics outbox flush marketplace templates org tree office scene feed attachments artifacts files messages search automation tasks departments members employees knowledge-bases documents billing models providers reset-password resolve-tenant-by-account'.split(' '))
export function safeLogRoute(value: string): string {
  try {
    return new URL(value, 'https://local.invalid').pathname.split('/').map(segment => !segment || routeWords.has(segment) ? segment : ':id').join('/').slice(0, 240)
  } catch { return '/invalid' }
}
export function safeLogFields(input: Record<string, unknown>): ApplicationLogRecord['fields'] {
  const output: ApplicationLogRecord['fields'] = {}
  for (const [key, value] of Object.entries(input)) {
    if (numberFields.has(key) && typeof value === 'number' && Number.isFinite(value)) output[key] = Math.max(0, Math.round(value * 1000) / 1000)
    else if (idFields.has(key) && typeof value === 'string' && identifiers.test(value)) output[key] = value
    else if (codeFields.has(key) && typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)) output[key] = value
    else if (key === 'route' && typeof value === 'string') output[key] = safeLogRoute(value)
    else if (key === 'origin' && typeof value === 'string') {
      try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol)) output[key] = url.origin } catch { /* No raw URL fallback. */ }
    }
  }
  return output
}
export function recordApplicationLog(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const record: ApplicationLogRecord = {
    schema_version: 1, timestamp: new Date().toISOString(), service: 'desktop-ui', instance_id: instanceId,
    level, event: /^[a-z][a-z0-9_.]{0,79}$/.test(event) ? event : 'invalid_event', fields: safeLogFields(fields),
  }
  records.push(record)
  if (records.length > LIMIT) { records.shift(); dropped++ }
  try { sink?.(record) } catch { sinkFailures++ }
}
export function installLogSink(next: (record: ApplicationLogRecord) => void): () => void {
  sink = next
  return () => { if (sink === next) sink = undefined }
}
export function applicationLogSnapshot() {
  return { schema_version: 1, instance_id: instanceId, generated_at: new Date().toISOString(), dropped, sink_failures: sinkFailures, records: structuredClone(records) }
}
export function clearApplicationLogMemory(): void { records = []; dropped = 0; sinkFailures = 0 }
export function newRequestCorrelation() {
  const request_id = crypto.randomUUID()
  const trace_id = crypto.randomUUID().replace(/-/g, '')
  const traceparent = `00-${trace_id}-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}-01`
  return { request_id, trace_id, traceparent }
}
export function installGlobalErrorLogging(target: Window): () => void {
  // Do not retain Error.message, stack, filename, promise reason or resource URL.
  const error = () => recordApplicationLog('error', 'ui.uncaught_error', { error_type: 'Error' })
  const rejection = () => recordApplicationLog('error', 'ui.unhandled_rejection', { error_type: 'UnhandledRejection' })
  target.addEventListener('error', error)
  target.addEventListener('unhandledrejection', rejection)
  return () => { target.removeEventListener('error', error); target.removeEventListener('unhandledrejection', rejection) }
}
