/**
 * agentAuth store —— 新栈的登录会话与 Bearer token。
 *
 * 桌面端登录状态唯一事实源：token + claims + tenant_id + 401 登出。
 *
 * token 只保存在内存里，不落盘：每次启动都会新起本机 Agent，上次的 token 无法再用来恢复登录，
 * 所以启动时只做两件事——清掉旧版本留下的 token，再按「自动登录」开关决定自动登录还是进登录页。
 *
 * token 通过运行期内存变量 __agentToken 暴露给 AgentApiClient(避免 import 循环)。
 * 401 事件由 client 派发,这里订阅并清空会话。
 */
import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { recordAuthDiagnostic, authErrorStatus, sessionRemainingSeconds, type AuthDiagnosticInput } from '../lib/authDiagnostics'
import { canAttemptAutoLogin, endLaunchAutoLogin, readAutoLoginPreference, shouldAutoLogin, writeAutoLoginPreference } from '../lib/autoLogin'
import { AgentApiClient } from '../api/agent'
import { backendApi } from '../api/backend'
import { syncAuthenticatedAgent, type EnterpriseIdentity } from '../api/agent/auth'
import type { AuthClaims } from '../api/agent/types'
import {
  invalidateSecureCredential,
  isPasswordResetRequired,
  resolveAuthenticatedTenantId,
} from '../lib/authSession'
import { deleteSavedLoginCredentials, readSavedLoginCredentials } from '../lib/loginCredentials'

// 旧版 WebView 持久化 key,只用于启动时清理,禁止再写入。
const LEGACY_STORAGE_KEY = 'aifred.agent-auth.v1'


interface AuthSession {
  token: string
  claims: AuthClaims
  tenantId: string
  account: string
  credentialEnterprise?: string
}

type PendingPasswordReset = EnterpriseIdentity & { account: string }

export type AgentLoginOutcome = 'authenticated' | 'password_reset_required'

interface AgentAuthState {
  token: string | null
  claims: AuthClaims | null
  tenantId: string | null
  account: string | null
  credentialEnterprise: string | null
  pendingPasswordReset: PendingPasswordReset | null
  isAuthenticated: boolean
  // 正在自动登录：应用展示内部页，顶栏显示“连接中...”，页面内容等拿到 token 才挂载。
  isConnecting: boolean
  // 连接期间侧栏展示的账号；登录完成前不代表已认证身份。
  connectingAccount: string | null
  // 自动登录失败的原始错误，由登录页转成提示文案。
  autoLoginFailure: unknown
  // 最近一次授权同步中未更新的员工（Agent partial 同步）；空数组表示完整同步或无结果。
  grantsSyncSkipped: string[]
  sessionGeneration: number

  // 启动时调用一次：清理旧版本保存的 token，开了自动登录就进入连接中。
  initializeSession: () => Promise<void>
  // 连接中时调用：能自动登录就登录，否则结束连接，由路由回到登录页。
  // 由 App 在本机 Agent 就绪后触发，避免登录请求早于 Agent 启动完成。
  runPendingAutoLogin: () => Promise<void>
  // 企业代码或名称通过 enterprise 登录；留空时按账号解析内部租户。
  // 失败会抛 AgentApiError 交给 UI 层判断。
  login: (enterprise: string, account: string, password: string) => Promise<AgentLoginOutcome>
  resetPassword: (oldPassword: string, newPassword: string) => Promise<void>
  cancelPasswordReset: () => void
  setSession: (session: AuthSession, generation?: number) => Promise<void>
  logout: (reason?: AuthDiagnosticInput) => Promise<void>
  // 用当前会话重新同步授权；失败时抛错，原有提示保持不变。
  retryGrantsSync: () => Promise<void>
}

let pendingAutoLogin: Promise<void> | null = null
let initialization: Promise<void> | null = null
let sessionGeneration = 0

// initial is written together with the new generation, so subscribers never see an in-between signed-out state.
function beginSessionOperation(initial: Partial<AgentAuthState> = {}): number {
  const generation = ++sessionGeneration
  useAgentAuthStore.setState({ sessionGeneration: generation, ...initial })
  return generation
}

function isCurrentSession(generation: number): boolean {
  return generation === sessionGeneration
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
}

function removeLegacySession(): void {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    // A disabled WebView store is already non-persistent for this session.
  }
}

// 清除旧版本在钥匙串里保存的 token；新版本只删不写。
async function deleteSecureSession(): Promise<void> {
  if (!isTauriRuntime()) return
  await invalidateSecureCredential(
    () => invoke<void>('secure_session_write', { session: '' }),
    () => invoke<void>('secure_session_delete'),
  )
}

function pushToken(token: string | null): void {
  // 全局挂载 token 给 AgentApiClient.getToken 使用。用 globalThis 而不是 import,
  // 是为了避免 client → store → client 的循环依赖。
  const globalRef = globalThis as { __agentToken?: string | null }
  globalRef.__agentToken = token
}


function recordSkippedEmployees(skipped: string[], source: AuthDiagnosticInput['source']): string[] {
  if (skipped.length > 0) recordAuthDiagnostic({ reason: 'grants_sync_partial', source })
  return skipped
}

// 登录只校验用户本身的身份；AI 员工授权同步失败只记诊断，不阻止进入工作台。
// 返回本次未更新的员工；整次同步失败时返回空数组（失败已记诊断）。
async function syncGrantsWithoutBlocking(
  client: AgentApiClient,
  identity: { tenant_id: string; user_id: string },
  source: 'restore' | 'login',
): Promise<string[]> {
  try {
    return recordSkippedEmployees((await syncAuthenticatedAgent(client, identity)).skippedEmployeeIds, source)
  } catch (error) {
    recordAuthDiagnostic({ reason: 'grants_sync_failed', source, status: authErrorStatus(error) })
    return []
  }
}

async function attemptPendingAutoLogin(): Promise<void> {
  const store = useAgentAuthStore
  try {
    const saved = canAttemptAutoLogin() ? await readSavedLoginCredentials().catch(() => null) : null
    const eligible = shouldAutoLogin({
      enabled: readAutoLoginPreference(),
      hasSavedCredentials: Boolean(saved),
      passwordResetPending: Boolean(store.getState().pendingPasswordReset),
    })
    if (!saved || !eligible) return
    store.setState({ connectingAccount: saved.account })
    await store.getState().login(saved.enterprise, saved.account, saved.password)
  } catch (error) {
    store.setState({ autoLoginFailure: error })
  } finally {
    store.setState({ isConnecting: false, connectingAccount: null })
  }
}

function clearRuntimeSession(set: (partial: Partial<AgentAuthState>) => void): void {
  pushToken(null)
  set({
    token: null,
    claims: null,
    tenantId: null,
    account: null,
    credentialEnterprise: null,
    pendingPasswordReset: null,
    isAuthenticated: false,
    autoLoginFailure: null,
    grantsSyncSkipped: [],
  })
}

export const useAgentAuthStore = create<AgentAuthState>((set, get) => ({
  token: null,
  claims: null,
  tenantId: null,
  account: null,
  credentialEnterprise: null,
  pendingPasswordReset: null,
  isAuthenticated: false,
  isConnecting: false,
  connectingAccount: null,
  autoLoginFailure: null,
  grantsSyncSkipped: [],
  sessionGeneration: 0,

  initializeSession: async () => {
    // 开了自动登录就从一开始进入连接中，等 App 确认本机 Agent 就绪后登录；否则直接去登录页。
    if (!get().isAuthenticated && canAttemptAutoLogin()) set({ isConnecting: true })
    // React StrictMode runs effects twice; both callers share one cleanup.
    initialization ??= (async () => {
      removeLegacySession()
      await deleteSecureSession().catch(() => {
        recordAuthDiagnostic({ reason: 'credential_delete_failed', source: 'restore' })
      })
    })()
    return initialization
  },

  runPendingAutoLogin: () => {
    // React StrictMode runs effects twice; both callers must share one attempt.
    pendingAutoLogin ??= attemptPendingAutoLogin().finally(() => { pendingAutoLogin = null })
    return pendingAutoLogin
  },

  login: async (inputEnterprise, account, password) => {
    // Re-authentication can select another tenant. Drop the current token
    // before tenant lookup/login so it is never sent.
    const generation = beginSessionOperation()
    clearRuntimeSession(set)
    const enterprise = inputEnterprise.trim()
    const identity: EnterpriseIdentity = enterprise
      ? { enterprise }
      : { tenant_id: (await backendApi.resolveTenantByAccount({ account })).tenant_id }
    if (!isCurrentSession(generation)) return 'authenticated'
    if (identity.tenant_id !== undefined) resolveAuthenticatedTenantId(identity.tenant_id, identity.tenant_id)
    let result
    try {
      result = await backendApi.login({
        ...identity,
        account,
        password,
      })
    } catch (error) {
      if (!isCurrentSession(generation)) return 'authenticated'
      if (isPasswordResetRequired(error)) {
        set({ pendingPasswordReset: { ...identity, account } })
        return 'password_reset_required'
      }
      throw error
    }
    if (!isCurrentSession(generation)) return 'authenticated'
    const tenantId = resolveAuthenticatedTenantId(
      identity.tenant_id ?? result.claims.tenant_id,
      result.claims.tenant_id,
    )
    await get().setSession({
      token: result.token,
      claims: result.claims,
      tenantId,
      account,
      credentialEnterprise: enterprise,
    }, generation)
    return 'authenticated'
  },

  resetPassword: async (oldPassword, newPassword) => {
    const pending = get().pendingPasswordReset
    if (!pending) throw new Error('password reset was not requested by the authentication server')

    const generation = beginSessionOperation()
    const result = await backendApi.resetPassword({
      ...(pending.enterprise !== undefined ? { enterprise: pending.enterprise } : { tenant_id: pending.tenant_id }),
      account: pending.account,
      old_password: oldPassword,
      new_password: newPassword,
    })
    if (!isCurrentSession(generation)) return
    const tenantId = resolveAuthenticatedTenantId(
      pending.tenant_id ?? result.claims.tenant_id,
      result.claims.tenant_id,
    )
    await get().setSession({
      token: result.token,
      claims: result.claims,
      tenantId,
      account: pending.account,
      credentialEnterprise: pending.enterprise?.trim() ?? '',
    }, generation)
  },

  cancelPasswordReset: () => {
    beginSessionOperation()
    set({ pendingPasswordReset: null })
  },

  setSession: async (session, operationGeneration) => {
    const generation = operationGeneration ?? beginSessionOperation()
    if (!isCurrentSession(generation)) return
    const tenantId = resolveAuthenticatedTenantId(session.tenantId, session.claims.tenant_id)
    if (!session.token || !session.account.trim()) {
      throw new Error('refusing to use an incomplete authentication session')
    }
    const verifier = new AgentApiClient({ getToken: () => session.token })
    const verified = await verifier.request<AuthClaims>({ path: '/api/agent/whoami' })
    if (!isCurrentSession(generation)) return
    resolveAuthenticatedTenantId(tenantId, verified.tenant_id)
    if (verified.user_id !== session.claims.user_id) throw new Error('本机身份与登录结果不一致')
    const validatedSession = { ...session, claims: verified, tenantId, account: session.account.trim() }

    const grantsSyncSkipped = await syncGrantsWithoutBlocking(verifier, { tenant_id: tenantId, user_id: verified.user_id }, 'login')
    if (!isCurrentSession(generation)) return
    pushToken(validatedSession.token)
    set({
      token: validatedSession.token,
      claims: validatedSession.claims,
      tenantId: validatedSession.tenantId,
      account: validatedSession.account,
      credentialEnterprise: validatedSession.credentialEnterprise?.trim() ?? '',
      pendingPasswordReset: null,
      isAuthenticated: true,
      isConnecting: false,
      connectingAccount: null,
      autoLoginFailure: null,
      grantsSyncSkipped,
    })
    recordAuthDiagnostic({ reason: 'login_succeeded', source: 'login', expiresInSeconds: sessionRemainingSeconds(validatedSession.claims.exp) })

  },

  logout: async (reason = { reason: 'user_logout', source: 'user' }) => {
    const generation = beginSessionOperation()
    const userInitiated = reason.reason === 'user_logout'
    const credentialEnterprise = get().credentialEnterprise ?? ''
    const credentialAccount = get().account ?? ''
    if (userInitiated) {
      // Only an explicit user logout ends this launch's auto-login opportunity.
      // Expiry, revocation and 401 recovery keep the remembered credential.
      endLaunchAutoLogin()
      writeAutoLoginPreference(false)
    }
    const token = get().token
    recordAuthDiagnostic({ ...reason, expiresInSeconds: reason.expiresInSeconds ?? sessionRemainingSeconds(get().claims?.exp) })
    if (token) {
      await new AgentApiClient({ getToken: () => token }).logout().catch(() => undefined)
    }
    // 掉签且还能自动登录时留在内部页重新连接；isConnecting 必须先于清空会话写入，登录页才不会闪现。
    const reconnecting = !userInitiated && canAttemptAutoLogin()
    set({ isConnecting: reconnecting, connectingAccount: reconnecting ? credentialAccount || null : null })
    clearRuntimeSession(set)
    try {
      if (isCurrentSession(generation) && userInitiated && credentialAccount.trim()) {
        await deleteSavedLoginCredentials({
          enterprise: credentialEnterprise,
          account: credentialAccount,
        })
      }
    } catch (error) {
      recordAuthDiagnostic({ reason: 'credential_delete_failed', source: reason.source })
      throw error
    }
  },

  retryGrantsSync: async () => {
    const { token, tenantId, claims, sessionGeneration: generation } = get()
    if (!token || !tenantId || !claims) return
    const client = new AgentApiClient({ getToken: () => token })
    let skipped: string[]
    try {
      skipped = (await syncAuthenticatedAgent(client, { tenant_id: tenantId, user_id: claims.user_id })).skippedEmployeeIds
    } catch (error) {
      if (!isCurrentSession(generation)) return
      recordAuthDiagnostic({ reason: 'grants_sync_failed', source: 'user', status: authErrorStatus(error) })
      throw error
    }
    if (isCurrentSession(generation)) set({ grantsSyncSkipped: recordSkippedEmployees(skipped, 'user') })
  },
}))

// 订阅 client 层派发的 401 事件。挂在模块顶层,只注册一次。
if (typeof window !== 'undefined') {
  window.addEventListener('agent-auth:unauthorized', (event) => {
    // 直接调用 store 的 logout,不用等 React 组件。
    const reason = (event as CustomEvent<AuthDiagnosticInput>).detail
    void useAgentAuthStore.getState().logout(reason ?? { reason: 'http_unauthorized', source: 'agent_http', status: 401 }).catch(() => {})
  })
}
