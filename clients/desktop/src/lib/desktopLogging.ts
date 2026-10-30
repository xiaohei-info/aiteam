import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '../api/agent/runtime'
import { applicationLogSnapshot, installGlobalErrorLogging, installLogSink, recordApplicationLog, type ApplicationLogRecord } from './applicationLog'

const pending: ApplicationLogRecord[] = []
let flushing: Promise<void> | undefined
let dropped = 0
let failed = false
let installed = false
export function logPersistenceStatus() { return { dropped, failed, mode: isTauri() ? 'local-files' : 'memory' } }
export function flushApplicationLogs(): Promise<void> {
  if (flushing) return flushing
  if (!pending.length || !isTauri()) return Promise.resolve()
  const batch = pending.splice(0, 100)
  flushing = invoke('append_application_logs', { records: batch }).then(() => { failed = false }).catch(() => {
    failed = true
    dropped += batch.length
  }).finally(() => { flushing = undefined })
  return flushing
}
export function initializeApplicationLogging(): void {
  if (installed) return
  installed = true
  installGlobalErrorLogging(window)
  installLogSink(record => {
    if (!isTauri()) return
    if (pending.length >= 500) { pending.shift(); dropped++ }
    pending.push(record)
  })
  const timer = window.setInterval(() => { void flushApplicationLogs() }, 1000)
  window.addEventListener('pagehide', () => {
    recordApplicationLog('info', 'ui.page_hidden')
    void flushApplicationLogs()
  })
  window.addEventListener('online', () => recordApplicationLog('info', 'network.online'))
  window.addEventListener('offline', () => recordApplicationLog('warn', 'network.offline'))
  recordApplicationLog('info', 'ui.started', { connection_mode: isTauri() ? 'desktop' : 'browser' })
  if (import.meta.hot) import.meta.hot.dispose(() => { clearInterval(timer); installed = false })
}
export interface LogBundle {
  schema_version: number
  generated_at: string | number
  records: Array<{ timestamp: string | number; service: string; level: string; event: string; fields?: Record<string, unknown> }>
  client_version?: string
  platform?: string
  truncated?: boolean
  omitted_lines?: number
  scope?: string
}
export async function loadApplicationLogs(): Promise<LogBundle> {
  await flushApplicationLogs()
  if (!isTauri()) return applicationLogSnapshot()
  const persisted = await invoke<LogBundle>('application_log_snapshot')
  // Native failures remain explicit; memory-only records are still available on the page.
  return persisted
}
export async function exportApplicationLogs(): Promise<boolean> {
  // Bound drain; no infinite wait under continuous request traffic.
  for (let i = 0; i < 6 && pending.length; i++) await flushApplicationLogs()
  if (isTauri()) return invoke<boolean>('export_application_logs')
  const blob = new Blob([JSON.stringify({ ...applicationLogSnapshot(), scope: 'browser_memory_only', excludes: ['server_logs', 'credentials', 'chat_content'] }, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `aifred-diagnostics-${Date.now()}.json`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  return true
}
