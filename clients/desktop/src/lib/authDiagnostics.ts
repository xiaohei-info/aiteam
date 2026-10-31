import { recordApplicationLog } from './applicationLog.ts'

/** Authentication diagnostics contain only fixed reason/source codes and numbers. */
export const AUTH_DIAGNOSTIC_KEY = 'aifred.auth-diagnostics.v1'
const MAX_RECORDS = 100
const reasons = [
  'user_logout', 'token_expired', 'reauthentication', 'invalid_login_session',
  'http_unauthorized', 'http_unauthorized_ignored', 'sse_unauthorized',
  'sse_unauthorized_ignored', 'restore_started', 'restore_missing', 'restore_invalid', 'restore_expired',
  'restore_vault_failed', 'restore_identity_failed', 'restore_sync_failed',
  'session_restored', 'login_succeeded', 'credential_delete_failed', 'grants_sync_failed', 'grants_sync_partial',
] as const
const sources = ['agent_http', 'backend_http', 'sse', 'restore', 'expiry_timer', 'login', 'user'] as const
export type AuthDiagnosticReason = typeof reasons[number]
export type AuthDiagnosticSource = typeof sources[number]
export interface AuthDiagnosticInput {
  reason: AuthDiagnosticReason
  source: AuthDiagnosticSource
  status?: number
  verification?: 'confirmed' | 'rejected' | 'unavailable' | 'stale'
  expiresInSeconds?: number
}
export interface AuthDiagnostic extends AuthDiagnosticInput { time: string }
let memory: AuthDiagnostic[] = []
let storageUnavailable = false

function sanitize(value: unknown): AuthDiagnostic | null {
  if (!value || typeof value !== 'object') return null
  const item = value as AuthDiagnostic
  if (!reasons.includes(item.reason) || !sources.includes(item.source)
    || typeof item.time !== 'string' || !Number.isFinite(Date.parse(item.time))) return null
  return {
    time: new Date(item.time).toISOString(), reason: item.reason, source: item.source,
    ...(['confirmed', 'rejected', 'unavailable', 'stale'].includes(item.verification ?? '') ? { verification: item.verification } : {}),
    ...(typeof item.status === 'number' && Number.isInteger(item.status) && item.status >= 0 && item.status <= 599 ? { status: item.status } : {}),
    ...(typeof item.expiresInSeconds === 'number' && Number.isFinite(item.expiresInSeconds) ? { expiresInSeconds: Math.round(item.expiresInSeconds) } : {}),
  }
}

export function readAuthDiagnostics(): AuthDiagnostic[] {
  if (storageUnavailable) return memory.slice()
  try {
    const raw: unknown = JSON.parse(globalThis.localStorage.getItem(AUTH_DIAGNOSTIC_KEY) ?? '[]')
    if (Array.isArray(raw)) return raw.slice(-MAX_RECORDS).map(sanitize).filter((item): item is AuthDiagnostic => item !== null)
  } catch { /* Diagnostics must never interfere with authentication. */ }
  return memory.slice()
}

export function recordAuthDiagnostic(input: AuthDiagnosticInput): void {
  const item = sanitize({ ...input, time: new Date().toISOString() })
  if (!item) return
  recordApplicationLog('info', 'auth.lifecycle', { code: item.reason, phase: item.source, status: item.status })
  memory = [...readAuthDiagnostics(), item].slice(-MAX_RECORDS)
  try {
    globalThis.localStorage.setItem(AUTH_DIAGNOSTIC_KEY, JSON.stringify(memory))
    storageUnavailable = false
  } catch { storageUnavailable = true }
}

export function authErrorStatus(error: unknown, depth = 0): number | undefined {
  if (!error || typeof error !== 'object' || depth > 3) return undefined
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' && Number.isInteger(status) && status >= 0 && status <= 599 ? status : authErrorStatus((error as { cause?: unknown }).cause, depth + 1)
}

export function sessionRemainingSeconds(exp?: number): number | undefined {
  return typeof exp === 'number' && Number.isFinite(exp) ? Math.round(exp - Date.now() / 1000) : undefined
}
