import { invoke } from '@tauri-apps/api/core'
import { assertSecureApiUrl } from '../urlSecurity'
import { normalizeAgentRuntimeError } from '../../lib/agentRuntimeError'
import { DEPLOYED_AGENT_HTTP_ORIGINS } from './config'
import { createNativeHttpFetch } from './nativeHttpFetch'
import { recordApplicationLog } from '../../lib/applicationLog'

export const isTauri = () => typeof window !== 'undefined'
  && !!(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
export const isTauriRuntime = isTauri

let desktopBaseUrl: string | null = null
let discovery: Promise<string> | null = null

export async function resolveAgentBaseUrl(): Promise<string> {
  if (!isTauri()) return getAgentBaseUrl()
  // Share concurrent discovery, but recheck the child for subsequent API/SSE requests.
  if (!discovery) {
    discovery = invoke<string>('get_agent_base_url').then(value => {
      let url: URL
      try { url = new URL(value) } catch { throw new Error('本地 Agent 返回了无效地址') }
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
        || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('本地 Agent 返回了无效地址')
      }
      if (desktopBaseUrl !== url.origin) recordApplicationLog('info', 'agent.address_discovered', { origin: url.origin, connection_mode: 'local' })
      desktopBaseUrl = url.origin
      return url.origin
    }).catch(reason => {
      desktopBaseUrl = null
      recordApplicationLog('error', 'agent.discovery_failed', { code: normalizeAgentRuntimeError(reason).code })
      throw normalizeAgentRuntimeError(reason)
    })
  }
  const task = discovery
  try { return await task } finally { if (discovery === task) discovery = null }
}

export async function initializeAgentRuntime(): Promise<void> {
  if (isTauri()) await resolveAgentBaseUrl()
}

// Synchronous access is reserved for code that has already awaited startup.
export function getAgentBaseUrl(): string {
  if (isTauri()) {
    if (!desktopBaseUrl) throw new Error('本地 Agent 尚未就绪')
    return desktopBaseUrl
  }
  if (import.meta.env.DEV) return ''
  const configured = import.meta.env.VITE_AGENT_BASE_URL
  if (!configured) throw new Error('尚未配置本机 Agent 地址')
  return assertSecureApiUrl(configured, 'Agent', DEPLOYED_AGENT_HTTP_ORIGINS).replace(/\/$/, '')
}

export async function pickAgentFetch(): Promise<typeof fetch> {
  if (!isTauri()) return globalThis.fetch.bind(globalThis)
  return createNativeHttpFetch(invoke)
}
