export type SafeDiagnosticCategory = 'configuration' | 'network' | 'render' | 'service'
export type SafeDiagnosticCode =
  | 'BACKEND_CONFIGURATION_ERROR'
  | 'BACKEND_AGENT_NOT_INSTALLED'
  | 'BACKEND_HOST_RESTART_REQUIRED'
  | 'BACKEND_HEALTH_TIMEOUT'
  | 'BACKEND_NETWORK_TIMEOUT'
  | 'BACKEND_READY_TIMEOUT'
  | 'UI_RENDER_FAILURE'
export type SafeDiagnosticStage = 'health' | 'react-render' | 'readiness'

export interface SafeDiagnostic {
  errorId: string
  code: SafeDiagnosticCode
  stage: SafeDiagnosticStage
  category: SafeDiagnosticCategory
  occurredAt: string
  view: string
}

interface SafeDiagnosticOptions {
  code: SafeDiagnosticCode
  stage: SafeDiagnosticStage
  category: SafeDiagnosticCategory
  pathname?: string
  now?: Date
  errorId?: string
}

const SAFE_VIEWS: Record<string, string> = {
  agents: 'agents',
  chat: 'chat',
  knowledge: 'knowledge',
  login: 'login',
  mcp: 'mcp',
  office: 'office',
  org: 'org',
  profile: 'profile',
  settings: 'settings',
  skills: 'skills',
  talents: 'talents',
  tasks: 'tasks',
  'group-chat': 'group-chat',
}

function randomErrorSuffix(): string {
  const cryptoRef = globalThis.crypto
  if (typeof cryptoRef?.randomUUID === 'function') {
    return cryptoRef.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()
  }
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0').toUpperCase()
}

export function createSafeErrorId(now = new Date()): string {
  const timestamp = now.getTime().toString(36).toUpperCase()
  return `AT-${timestamp}-${randomErrorSuffix()}`
}

export function resolveSafeView(pathname?: string): string {
  if (!pathname) return 'unknown'
  const firstSegment = pathname.split(/[?#]/, 1)[0].split('/').filter(Boolean)[0]
  return firstSegment ? SAFE_VIEWS[firstSegment] ?? 'unknown' : 'root'
}

export function createSafeDiagnostic(options: SafeDiagnosticOptions): SafeDiagnostic {
  const now = options.now ?? new Date()
  return {
    errorId: options.errorId ?? createSafeErrorId(now),
    code: options.code,
    stage: options.stage,
    category: options.category,
    occurredAt: now.toISOString(),
    view: resolveSafeView(options.pathname),
  }
}

export function createRenderDiagnostic(pathname?: string): SafeDiagnostic {
  return createSafeDiagnostic({
    code: 'UI_RENDER_FAILURE',
    stage: 'react-render',
    category: 'render',
    pathname,
  })
}

export function formatSafeDiagnostic(diagnostic: SafeDiagnostic): string {
  return [
    `error_id=${diagnostic.errorId}`,
    `code=${diagnostic.code}`,
    `stage=${diagnostic.stage}`,
    `category=${diagnostic.category}`,
    `time=${diagnostic.occurredAt}`,
    `view=${diagnostic.view}`,
  ].join('\n')
}
