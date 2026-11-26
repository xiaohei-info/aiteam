/**
 * 登录 / 改密失败的提示文案与企业候选解析。纯函数，不依赖页面与运行时，便于单测。
 *
 * 状态码 → 提示：
 * - 401：账号或密码错误（企业服务有意不区分「账号不存在」与「密码错误」，避免账号被探测）。
 * - 403：账号停用 / 企业不可用（企业服务给出的中文说明）/ 其他权限不足。
 * - 409：`tenant_selection_required` 账号密码匹配多个企业（页面弹窗选择）；`enterprise_ambiguous` 企业标识重名。
 * - 410：`client_upgrade_required` 旧接口已停用，提示升级客户端。
 * - 503：沿用 loginUnavailableMessage（企业服务不可用、时钟偏差、本机验签失败）。
 * - 其余 4xx 透传企业服务的 detail；5xx 才算后端异常。
 */
import { loginUnavailableMessage } from './loginServiceError.ts'

export interface LoginApiFailure {
  status: number
  code?: string
  message?: string
  problem?: { code?: string; detail?: string; meta?: unknown }
}

export interface TenantCandidate {
  tenant_id: string
  // 企业名称（enterprise_settings）；企业没设置名称时企业服务回落为企业标识，客户端也兜底为空串。
  enterprise_name: string
}

/** 弹窗里展示的企业名：有名称展示名称，没有名称展示企业标识（tenant_id）。 */
export function tenantCandidateLabel(candidate: TenantCandidate): string {
  return candidate.enterprise_name.trim() || candidate.tenant_id
}

const TENANT_STATUS_CODES = new Set(['tenant_suspended', 'tenant_banned', 'tenant_closed', 'tenant_deleted', 'tenant_unavailable'])

/** `tenant_selection_required` 携带的候选企业（只含密码通过的企业）；没有或格式不对时返回空数组。 */
export function tenantSelectionCandidates(err: LoginApiFailure): TenantCandidate[] {
  const code = err.problem?.code ?? err.code
  if (err.status !== 409 || code !== 'tenant_selection_required') return []
  const raw = (err.problem?.meta as { candidates?: unknown } | undefined)?.candidates
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): TenantCandidate[] => {
    const value = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    if (typeof value.tenant_id !== 'string' || !value.tenant_id.trim()) return []
    const name = typeof value.enterprise_name === 'string' ? value.enterprise_name.trim() : ''
    return [{ tenant_id: value.tenant_id.trim(), enterprise_name: name }]
  })
}

export function describeLoginApiFailure(err: LoginApiFailure, resettingPassword: boolean): string {
  const code = err.problem?.code ?? err.code ?? ''
  const detail = err.problem?.detail ?? ''
  if (err.status === 401) return resettingPassword ? '当前密码不正确，请重新输入' : '企业标识、账号或密码错误，请重试'
  if (err.status === 403) {
    if (code === 'principal_inactive') return '账号已停用，请联系企业管理员'
    if (TENANT_STATUS_CODES.has(code) && detail) return detail
    return '当前账号无法完成此操作，请联系管理员'
  }
  if (err.status === 404) return '账号不存在或所属企业未开通,请联系管理员'
  if (err.status === 409 && code === 'tenant_selection_required') return '该账号属于多个企业，请在「企业标识」中填写要登录的企业'
  if (err.status === 409 && code === 'enterprise_ambiguous') return '企业标识对应多个企业，请改填企业代码'
  if (err.status === 410 && code === 'client_upgrade_required') return detail || '客户端版本过旧，请升级后登录'
  if (err.status === 422 && code === 'validation_error' && /password policy violation/i.test(detail)) {
    return '新密码不符合企业密码策略（长度、大小写字母、数字和符号）'
  }
  if (err.status === 422) return '提交的信息不符合要求，请检查后重试'
  if (err.status === 503) return loginUnavailableMessage(detail, code, err.problem?.meta)
  if (err.status >= 500) return '后端服务异常,请稍后重试'
  return detail || err.message || '登录失败'
}
