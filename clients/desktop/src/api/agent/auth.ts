/**
 * 登录相关 API。
 *
 *   POST /api/agent/login { enterprise?, tenant_id?, account, password } → { token, claims }
 *   之后所有请求携带 Authorization: Bearer <token>。
 *
 * 企业标识可省略：省略时由企业服务按账号和密码匹配企业——只有一个企业密码通过则直接登录；
 * 多个则返回 409 tenant_selection_required（meta.candidates 只含密码通过的企业），
 * 选定后带 tenant_id 重试。旧的 resolve-tenant-by-account 已停用（固定 410），不再调用。
 *
 * 两个接口都 `security: []`,不需要预先登录;但都会经过 Manager 转发,
 * Manager 不可达时会返回 503 ManagerUnavailable。
 */
import type { ServiceApiClient } from './client'
import type { AuthResult } from './types'

// 三选一：企业标识、409 候选/403 改密响应给出的 tenant_id，或都不带（按账号和密码匹配企业）。
export type EnterpriseIdentity =
  | { enterprise: string; tenant_id?: never }
  | { tenant_id: string; enterprise?: never }
  | { enterprise?: never; tenant_id?: never }

export type LoginParams = EnterpriseIdentity & {
  account: string
  password: string
}

export function login(client: ServiceApiClient, params: LoginParams): Promise<AuthResult> {
  return client.request<AuthResult>({
    method: 'POST',
    path: '/api/agent/login',
    body: params,
  })
}

export type ResetPasswordParams = EnterpriseIdentity & {
  account: string
  old_password: string
  new_password: string
}

export interface GrantSyncSummary {
  // Agent 因 Manager 拒绝快照（404/409）而未更新的员工；这些员工保留旧配置，下次同步重试。
  skippedEmployeeIds: string[]
}

// 使用已由本机 whoami 验证的身份，在开放工作台前同步成员授权。
export async function syncAuthenticatedAgent(
  client: ServiceApiClient,
  identity: { tenant_id: string; user_id: string },
): Promise<GrantSyncSummary> {
  try {
    const result = await client.request<{ ok: boolean; partial?: boolean; skipped_employee_ids?: unknown }>({
      method: 'POST',
      path: '/api/agent/grants/sync',
      body: { tenant_id: identity.tenant_id, member_id: identity.user_id },
    })
    if (result?.ok !== true) throw new Error('服务未确认同步成功')
    const readiness = await client.request<{ runtime: string }>({ path: '/api/agent/grants/readiness' })
    // 单个专家缺少配置不阻止登录；专家可用性由各自的 readiness 决定。
    if (readiness?.runtime !== 'ready') throw new Error('本地 Agent 执行环境尚未就绪')
    // 旧版随包 Agent 不返回 partial；此时按完整同步处理。
    const skipped = result.partial === true && Array.isArray(result.skipped_employee_ids)
      ? result.skipped_employee_ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
    return { skippedEmployeeIds: skipped }
  } catch (error) {
    const detail = error instanceof Error ? error.message : '请检查本机 Agent 和企业服务连接'
    throw Object.assign(new Error(`同步用户授权配置失败：${detail}`), { cause: error })
  }
}

export function resetPassword(
  client: ServiceApiClient,
  params: ResetPasswordParams,
): Promise<AuthResult> {
  return client.request<AuthResult>({
    method: 'POST',
    path: '/api/agent/reset-password',
    body: params,
  })
}
