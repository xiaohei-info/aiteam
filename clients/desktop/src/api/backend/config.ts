import { TEST_AGENT_BASE_URL } from '../agent/config'
import { isTauri, resolveAgentBaseUrl } from '../agent/runtime'

export const BACKEND_BASE_URL = import.meta.env.VITE_BACKEND_BASE_URL || TEST_AGENT_BASE_URL
// 桌面端只连随包的本机 Agent：登录、身份、授权同步、本地目录和会话都由它自己处理并直接访问 Manager，
// 不再转发到远端 Agent（见 docs/agent-sidecar.md）。
export async function resolveBackendBaseUrl(): Promise<string> {
  if (isTauri()) return resolveAgentBaseUrl()
  return import.meta.env.DEV ? '/backend-api' : BACKEND_BASE_URL.replace(/\/$/, '')
}
