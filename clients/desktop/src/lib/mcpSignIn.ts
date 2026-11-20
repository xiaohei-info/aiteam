/**
 * MCP 浏览器登录与「添加 MCP」表单的纯逻辑（设计 2026-11-18 MCP鉴权与配置导入 §3.3 / §3.6 / §3.9）。
 * 审批弹窗与设置「个人能力」共用；不发请求，便于单测。
 */
import type { McpAuth, McpInstallRequest, McpLogin } from '../api/agent/types'

const SIGN_IN_FAILURE: Record<string, string> = {
  timeout: '登录超时：10 分钟内没有完成登录。',
  cancelled: '已取消登录。',
  denied: '你在服务方页面拒绝了授权。',
}

/** 登录失败原因；retry 是给用户的下一步建议。 */
export function signInFailureText(error: McpLogin['error'], retry = '可以稍后重试。'): string {
  return `${(error && SIGN_IN_FAILURE[error]) || '登录没有完成。'}${retry}`
}

const REF_RE = /^[a-z][a-z0-9_-]{0,63}$/
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/

export interface AddMcpForm {
  ref: string
  displayName: string
  url: string
  timeoutMs: number | null
  reason: string
  /** 探测或配置得出的鉴权方式；null 表示还没探测。 */
  auth: McpAuth | null
  token: string
  header: string
  clientId: string
  clientSecret: string
  replace: boolean
}

/** 表单问题；null 表示可以提交。令牌缺失只在已知需要令牌时报。 */
export function addMcpProblem(form: AddMcpForm): string | null {
  const url = form.url.trim()
  if (!url) return '请填写 MCP 地址'
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '地址须以 https:// 开头'
  } catch { return '地址格式不对' }
  if (!REF_RE.test(form.ref.trim())) return '标识须以小写字母开头，只含小写字母、数字、- 或 _（最多 64 个字符）'
  if (form.timeoutMs !== null && (!Number.isInteger(form.timeoutMs) || form.timeoutMs < 1000 || form.timeoutMs > 300000)) return '调用超时须在 1000–300000 毫秒之间'
  if (form.auth === 'bearer' && !form.token.trim()) return '这个 MCP 需要访问令牌，请填写服务方发的令牌'
  if (form.header.trim() && !HEADER_RE.test(form.header.trim())) return '请求头名只能含字母、数字和 -'
  if (form.clientSecret.trim() && !form.clientId.trim()) return '填写应用密钥时也要填写应用编号'
  return null
}

/** 组装 POST /api/agent/capabilities/mcp 请求体；只带当前鉴权方式需要的字段。 */
export function addMcpRequest(form: AddMcpForm): McpInstallRequest {
  const header = form.header.trim()
  return {
    ref: form.ref.trim(),
    url: form.url.trim(),
    ...(form.displayName.trim() ? { display_name: form.displayName.trim() } : {}),
    ...(form.timeoutMs !== null ? { timeout_ms: form.timeoutMs } : {}),
    ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
    ...(form.replace ? { replace: true } : {}),
    ...(form.auth === 'bearer' ? { credential: { token: form.token.trim(), ...(header ? { header } : {}) } } : {}),
    ...(form.auth !== 'bearer' && form.clientId.trim()
      ? { oauth_client: { client_id: form.clientId.trim(), ...(form.clientSecret.trim() ? { client_secret: form.clientSecret.trim() } : {}) } }
      : {}),
  }
}
