import { invoke } from '@tauri-apps/api/core'
import { invalidateSecureCredential, persistVerifiedCredential } from './authSession.ts'

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
}

export interface SavedLoginCredentials {
  enterprise: string
  account: string
  password: string
  // 本次实际登录的企业（内部 tenant_id，不回填企业标识输入框）。自动登录按它直接登录，
  // 多企业账号留空企业标识时不会再被要求选择。旧版保存的记录没有该字段。
  // 存储索引仍是 (enterprise, account)：企业标识留空时同一账号换企业登录会覆盖同一条记录，
  // 自动登录跟随最后一次登录的企业，这是「记住上次登录」的预期行为，不是丢数据。
  tenantId?: string
}

export interface SavedCredentialProfileSummary {
  enterprise: string
  account: string
  updated_at: number
}

export interface LoginCredentialFilter {
  enterprise?: string
  account?: string
}

export function parseSavedLoginCredentials(raw: string | null): SavedLoginCredentials | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<SavedLoginCredentials>
    if (!value || typeof value !== 'object') return null
    if (typeof value.enterprise !== 'string' || typeof value.account !== 'string' || typeof value.password !== 'string') return null
    if (!value.account.trim() || !value.password) return null
    const tenantId = typeof value.tenantId === 'string' ? value.tenantId.trim() : ''
    return {
      enterprise: value.enterprise.trim(),
      account: value.account.trim(),
      password: value.password,
      ...(tenantId ? { tenantId } : {}),
    }
  } catch {
    return null
  }
}

export function matchSavedCredentialProfile(
  profiles: SavedCredentialProfileSummary[],
  enterprise: string,
  account: string,
): SavedCredentialProfileSummary | null {
  const normEnterprise = enterprise.trim().toLowerCase()
  const normAccount = account.trim().toLowerCase()
  if (!normEnterprise && !normAccount) return null

  if (normEnterprise && normAccount) {
    const exact = profiles.find(
      item =>
        item.enterprise.trim().toLowerCase() === normEnterprise
        && item.account.trim().toLowerCase() === normAccount,
    )
    if (exact) return exact
    return (
      profiles.find(
        item =>
          item.enterprise.trim() === ''
          && item.account.trim().toLowerCase() === normAccount,
      ) ?? null
    )
  }

  if (normAccount) {
    return (
      profiles.find(item => item.account.trim().toLowerCase() === normAccount)
      ?? null
    )
  }

  return (
    profiles.find(item => item.enterprise.trim().toLowerCase() === normEnterprise)
    ?? null
  )
}

export async function readSavedLoginCredentials(
  filter?: LoginCredentialFilter,
): Promise<SavedLoginCredentials | null> {
  if (!isTauriRuntime()) return null
  const enterprise = filter?.enterprise?.trim()
  const account = filter?.account?.trim()
  const raw = await invoke<string | null>('secure_login_credentials_read', {
    enterprise: enterprise || null,
    account: account || null,
  })
  return parseSavedLoginCredentials(raw)
}

export async function listSavedLoginCredentialProfiles(): Promise<SavedCredentialProfileSummary[]> {
  if (!isTauriRuntime()) return []
  try {
    const list = await invoke<SavedCredentialProfileSummary[]>('secure_login_credentials_list')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export async function saveLoginCredentials(credentials: SavedLoginCredentials): Promise<void> {
  if (!isTauriRuntime()) return
  const enterprise = credentials.enterprise.trim()
  const account = credentials.account.trim()
  const tenantId = credentials.tenantId?.trim()
  const value = JSON.stringify({
    enterprise,
    account,
    password: credentials.password,
    ...(tenantId ? { tenantId } : {}),
  })
  await persistVerifiedCredential(
    value,
    next => invoke<void>('secure_login_credentials_write', { credentials: next }),
    () =>
      invoke<string | null>('secure_login_credentials_read', {
        enterprise: enterprise || null,
        account: account || null,
      }),
  )
}

export async function deleteSavedLoginCredentials(
  filter?: LoginCredentialFilter,
): Promise<void> {
  if (!isTauriRuntime()) return
  const enterprise = filter?.enterprise?.trim() || null
  const account = filter?.account?.trim() || null
  await invalidateSecureCredential(
    () => invoke<void>('secure_login_credentials_write', { credentials: '' }),
    () => invoke<void>('secure_login_credentials_delete', { enterprise, account }),
  )
}
