/**
 * 登录相关 API。
 *
 * 登录页通过 enterprise 提交企业代码或名称；留空时先调用 resolve-tenant-by-account：
 *   POST /api/agent/login { enterprise, account, password } → { token, claims }
 *   之后所有请求携带 Authorization: Bearer <token>。
 * 保留 resolve-tenant-by-account 与 loginByAccount 供账号解析场景使用。
 *
 * 两个接口都 `security: []`,不需要预先登录;但都会经过 Manager 转发,
 * Manager 不可达时会返回 503 ManagerUnavailable。
 */
import type { ServiceApiClient } from './client'
import type { AuthResult, TenantResolution } from './types'

export interface ResolveTenantParams {
  account: string
}

export function resolveTenantByAccount(
  client: ServiceApiClient,
  params: ResolveTenantParams,
): Promise<TenantResolution> {
  return client.request<TenantResolution>({
    method: 'POST',
    path: '/api/auth/resolve-tenant-by-account',
    body: { account: params.account },
  })
}

export type EnterpriseIdentity = { enterprise: string; tenant_id?: never } | { tenant_id: string; enterprise?: never }

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

// 便捷组合:一次调用完成 resolve + login,业务层不用维护中间状态。
export async function loginByAccount(
  client: ServiceApiClient,
  params: { account: string; password: string },
): Promise<AuthResult> {
  const { tenant_id } = await resolveTenantByAccount(client, { account: params.account })
  return login(client, { tenant_id, account: params.account, password: params.password })
}
