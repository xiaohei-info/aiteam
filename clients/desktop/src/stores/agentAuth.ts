/**
 * agentAuth store —— 新栈的登录会话与 Bearer token。
 *
 * 桌面端登录状态唯一事实源：token + claims + tenant_id + 401 登出。
 *
 * token 通过运行期内存变量 __agentToken 暴露给 AgentApiClient(避免 import 循环)。
 * 401 事件由 client 派发,这里订阅并清空会话。
 */
import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { recordAuthDiagnostic, authErrorStatus, sessionRemainingSeconds, type AuthDiagnosticInput } from '../lib/authDiagnostics'
import { AgentApiClient } from '../api/agent'
import { backendApi } from '../api/backend'
import { syncAuthenticatedAgent, type EnterpriseIdentity } from '../api/agent/auth'
import type { AuthClaims } from '../api/agent/types'
import {
  invalidateSecureCredential,
  isPasswordResetRequired,
  persistVerifiedCredential,
  readCredentialWithRetry,
  resolveAuthenticatedTenantId,
} from '../lib/authSession'

// 旧版 WebView 持久化 key,只用于一次性迁移和清理,禁止再写入。
const LEGACY_STORAGE_KEY = 'aifred.agent-auth.v1'
const MAX_TIMER_DELAY_MS = 2_147_483_647

interface PersistedSession {
  token: string
  claims: AuthClaims
  tenantId: string
  account: string
}

type PendingPasswordReset = EnterpriseIdentity & { account: string }

export type AgentLoginOutcome = 'authenticated' | 'password_reset_required'

interface AgentAuthState {
  token: string | null
  claims: AuthClaims | null
  tenantId: string | null
  account: string | null
  pendingPasswordReset: PendingPasswordReset | null
  isAuthenticated: boolean
  isRestoring: boolean
  restoreError: string | null
  // 最近一次授权同步中未更新的员工（Agent partial 同步）；空数组表示完整同步或无结果。
  grantsSyncSkipped: string[]
  sessionGeneration: number

  restoreSession: () => Promise<void>
  // 企业代码或名称通过 enterprise 登录；留空时按账号解析内部租户。
  // 失败会抛 AgentApiError 交给 UI 层判断。
  login: (enterprise: string, account: string, password: string) => Promise<AgentLoginOutcome>
  resetPassword: (oldPassword: string, newPassword: string) => Promise<void>
  cancelPasswordReset: () => void
  setSession: (session: PersistedSession, generation?: number) => Promise<void>
  logout: (reason?: AuthDiagnosticInput) => Promise<void>
  // 用当前会话重新同步授权；失败时抛错，原有提示保持不变。
  retryGrantsSync: () => Promise<void>
}

let volatileSession: PersistedSession | null = null
let expiryTimer: ReturnType<typeof setTimeout> | null = null
let restorePromise: Promise<void> | null = null
let storageQueue: Promise<void> = Promise.resolve()
let sessionGeneration = 0

function beginSessionOperation(): number {
  const generation = ++sessionGeneration
  restorePromise = null
  useAgentAuthStore.setState({ sessionGeneration: generation, isRestoring: false })
  return generation
}

function isCurrentSession(generation: number): boolean {
  return generation === sessionGeneration
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
}

function parseSession(raw: string | null): PersistedSession | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<PersistedSession>
    if (!value || typeof value !== 'object') return null
    if (typeof value.token !== 'string' || !value.token) return null
    if (typeof value.tenantId !== 'string' || !value.tenantId.trim()) return null
    if (typeof value.account !== 'string' || !value.account.trim()) return null
    if (!value.claims || typeof value.claims !== 'object') return null
    if (typeof value.claims.user_id !== 'string') return null
    if (!Array.isArray(value.claims.roles)) return null
    if (value.claims.tenant_id !== null && typeof value.claims.tenant_id !== 'string') return null
    if (value.claims.exp !== undefined && typeof value.claims.exp !== 'number') return null
    const tenantId = resolveAuthenticatedTenantId(value.tenantId, value.claims.tenant_id)
    return { ...value, tenantId, account: value.account.trim() } as PersistedSession
  } catch {
    return null
  }
}

function takeLegacySession(): PersistedSession | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(LEGACY_STORAGE_KEY)
  } catch {
    // localStorage may be disabled; there is then nothing we can migrate.
  } finally {
    removeLegacySession()
  }
  return parseSession(raw)
}

function removeLegacySession(): void {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    // A disabled WebView store is already non-persistent for this session.
  }
}

function enqueueStorage<T>(operation: () => Promise<T>): Promise<T> {
  const result = storageQueue.then(operation, operation)
  storageQueue = result.then(() => undefined, () => undefined)
  return result
}

async function readSecureSession(): Promise<PersistedSession | null> {
  if (!isTauriRuntime()) return volatileSession
  const raw = await readCredentialWithRetry(() => invoke<string | null>('secure_session_read'))
  const session = parseSession(raw)
  if (raw && !session) recordAuthDiagnostic({ reason: 'restore_invalid', source: 'restore' })
  return session
}

async function writeSecureSession(session: PersistedSession): Promise<void> {
  if (isTauriRuntime()) {
    await persistVerifiedCredential(
      JSON.stringify(session),
      value => invoke<void>('secure_session_write', { session: value }),
      () => readCredentialWithRetry(() => invoke<string | null>('secure_session_read')),
    )
  }
  volatileSession = session
}

async function deleteSecureSession(): Promise<void> {
  volatileSession = null
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

// exp(Unix 秒)距离失效不足 30 秒 → 视为无效会话,避免带临界 token 发请求。
function isExpired(claims: AuthClaims | null): boolean {
  if (!claims?.exp) return false
  return claims.exp * 1000 <= Date.now() + 30_000
}

function clearExpiryTimer(): void {
  if (expiryTimer !== null) clearTimeout(expiryTimer)
  expiryTimer = null
}

function scheduleExpiry(claims: AuthClaims): void {
  clearExpiryTimer()
  if (!claims.exp) return
  const delay = claims.exp * 1000 - Date.now() - 30_000
  if (delay <= 0) {
    void useAgentAuthStore.getState().logout({ reason: 'token_expired', source: 'expiry_timer' }).catch(() => {})
    return
  }
  expiryTimer = setTimeout(() => {
    if (delay > MAX_TIMER_DELAY_MS) {
      scheduleExpiry(useAgentAuthStore.getState().claims ?? claims)
      return
    }
    void useAgentAuthStore.getState().logout({ reason: 'token_expired', source: 'expiry_timer' }).catch(() => {})
  }, Math.min(delay, MAX_TIMER_DELAY_MS))
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

function clearRuntimeSession(set: (partial: Partial<AgentAuthState>) => void): void {
  clearExpiryTimer()
  pushToken(null)
  set({
    token: null,
    claims: null,
    tenantId: null,
    account: null,
    pendingPasswordReset: null,
    isAuthenticated: false,
    isRestoring: false,
    restoreError: null,
    grantsSyncSkipped: [],
  })
}

export const useAgentAuthStore = create<AgentAuthState>((set, get) => ({
  token: null,
  claims: null,
  tenantId: null,
  account: null,
  pendingPasswordReset: null,
  isAuthenticated: false,
  isRestoring: true,
  restoreError: null,
  grantsSyncSkipped: [],
  sessionGeneration: 0,

  restoreSession: async () => {
    if (restorePromise) return restorePromise
    const generation = beginSessionOperation()
    recordAuthDiagnostic({ reason: 'restore_started', source: 'restore' })
    set({ isRestoring: true, restoreError: null })
    const task = enqueueStorage(async () => {
      if (!isCurrentSession(generation)) return
      // Always remove the WebView copy, even when the keychain already has a
      // newer session or migration fails. A failed migration safely logs out.
      const legacySession = takeLegacySession()
      let session: PersistedSession | null
      try {
        session = await readSecureSession()
        if (!isCurrentSession(generation)) return
        if (!session && legacySession && !isExpired(legacySession.claims)) {
          await writeSecureSession(legacySession)
          if (!isCurrentSession(generation)) {
            await deleteSecureSession()
            return
          }
          session = legacySession
        }
      } catch (error) {
        if (!isCurrentSession(generation)) return
        recordAuthDiagnostic({ reason: 'restore_vault_failed', source: 'restore', status: authErrorStatus(error) })
        clearRuntimeSession(set)
        set({ restoreError: '暂时无法读取本地沙盒中已保存的登录凭证，请检查应用存储权限后重试恢复。' })
        return
      }
      if (!session || isExpired(session.claims)) {
        recordAuthDiagnostic({ reason: session ? 'restore_expired' : 'restore_missing', source: 'restore', expiresInSeconds: sessionRemainingSeconds(session?.claims.exp) })
        await deleteSecureSession().catch(() => { recordAuthDiagnostic({ reason: 'credential_delete_failed', source: 'restore' }) })
        if (isCurrentSession(generation)) clearRuntimeSession(set)
        return
      }
      // Verify the restored credential against the local Agent before restoring access.
      const verifier = new AgentApiClient({ getToken: () => session.token })
      let userId: string
      try {
        const claims = await verifier.request<AuthClaims>({ path: '/api/agent/whoami' })
        if (!isCurrentSession(generation)) return
        resolveAuthenticatedTenantId(session.tenantId, claims.tenant_id)
        if (claims.user_id !== session.claims.user_id) throw new Error('身份不一致')
        userId = claims.user_id
      } catch (error) {
        if (!isCurrentSession(generation)) return
        recordAuthDiagnostic({ reason: 'restore_identity_failed', source: 'restore', status: authErrorStatus(error), expiresInSeconds: sessionRemainingSeconds(session.claims.exp) })
        clearRuntimeSession(set)
        set({ restoreError: '无法验证已保存身份，请确认本机 Agent 和企业服务可用后重试。' })
        return
      }
      const grantsSyncSkipped = await syncGrantsWithoutBlocking(verifier, { tenant_id: session.tenantId, user_id: userId }, 'restore')
      if (!isCurrentSession(generation)) return
      pushToken(session.token)
      set({
        token: session.token,
        claims: session.claims,
        tenantId: session.tenantId,
        account: session.account,
        pendingPasswordReset: null,
        isAuthenticated: true,
        isRestoring: false,
        grantsSyncSkipped,
      })
      recordAuthDiagnostic({ reason: 'session_restored', source: 'restore', expiresInSeconds: sessionRemainingSeconds(session.claims.exp) })
      scheduleExpiry(session.claims)
    })
    restorePromise = task
    try {
      await task
    } finally {
      if (restorePromise === task) restorePromise = null
    }
  },

  login: async (inputEnterprise, account, password) => {
    // Re-authentication can select another tenant. Remove the current token
    // before tenant lookup/login so it is neither sent nor left in the keychain.
    const generation = beginSessionOperation()
    clearRuntimeSession(set)
    await enqueueStorage(async () => {
      if (isCurrentSession(generation)) await deleteSecureSession()
    })
    if (!isCurrentSession(generation)) return 'authenticated'
    set({ pendingPasswordReset: null, restoreError: null })
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
      throw new Error('refusing to persist an incomplete authentication session')
    }
    const verifier = new AgentApiClient({ getToken: () => session.token })
    const verified = await verifier.request<AuthClaims>({ path: '/api/agent/whoami' })
    if (!isCurrentSession(generation)) return
    resolveAuthenticatedTenantId(tenantId, verified.tenant_id)
    if (verified.user_id !== session.claims.user_id) throw new Error('本机身份与登录结果不一致')
    const validatedSession = { ...session, claims: verified, tenantId, account: session.account.trim() }
    if (isExpired(validatedSession.claims)) {
      await get().logout({ reason: 'invalid_login_session', source: 'login', expiresInSeconds: sessionRemainingSeconds(validatedSession.claims.exp) })
      throw new Error('refusing to persist an expired authentication session')
    }
    const grantsSyncSkipped = await syncGrantsWithoutBlocking(verifier, { tenant_id: tenantId, user_id: verified.user_id }, 'login')
    if (!isCurrentSession(generation)) return
    const isTenantSwitch = Boolean(get().token && get().tenantId !== validatedSession.tenantId)
    removeLegacySession()
    if (isTenantSwitch) clearRuntimeSession(set)
    await enqueueStorage(async () => {
      // Explicitly delete on tenant changes before writing the replacement.
      // A failed replacement therefore cannot resurrect the previous tenant.
      if (!isCurrentSession(generation)) return
      if (isTenantSwitch) await deleteSecureSession()
      if (!isCurrentSession(generation)) return
      await writeSecureSession(validatedSession)
      // The queue owns storage until this callback finishes. Remove a write
      // invalidated in flight before any newer operation can use the vault.
      if (!isCurrentSession(generation)) await deleteSecureSession()
    })
    if (!isCurrentSession(generation)) return
    pushToken(validatedSession.token)
    set({
      token: validatedSession.token,
      claims: validatedSession.claims,
      tenantId: validatedSession.tenantId,
      account: validatedSession.account,
      pendingPasswordReset: null,
      isAuthenticated: true,
      isRestoring: false,
      restoreError: null,
      grantsSyncSkipped,
    })
    recordAuthDiagnostic({ reason: 'login_succeeded', source: 'login', expiresInSeconds: sessionRemainingSeconds(validatedSession.claims.exp) })
    scheduleExpiry(validatedSession.claims)
  },

  logout: async (reason = { reason: 'user_logout', source: 'user' }) => {
    const generation = beginSessionOperation()
    recordAuthDiagnostic({ ...reason, expiresInSeconds: reason.expiresInSeconds ?? sessionRemainingSeconds(get().claims?.exp) })
    // Revoke runtime access synchronously; serialize the keychain deletion
    // behind any in-flight migration/write so a stale token cannot win.
    removeLegacySession()
    clearRuntimeSession(set)
    try {
      await enqueueStorage(async () => {
        if (isCurrentSession(generation)) await deleteSecureSession()
      })
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
