/**
 * Authentication flow invariants shared by the store and behavior tests.
 *
 * Keep this module free of browser/Tauri imports so the security-sensitive
 * decisions can be exercised directly in the Node test suite.
 */

interface AuthenticationProblemLike {
  status?: unknown
  code?: unknown
  message?: unknown
  problem?: {
    code?: unknown
    detail?: unknown
  }
}

export class SessionPersistenceError extends Error {
  constructor() {
    super('登录凭证未能保存到本地加密沙盒，请检查应用存储权限后重试。')
    this.name = 'SessionPersistenceError'
  }
}

/** Retry transient vault access failures without logging credential contents. */
export async function readCredentialWithRetry(
  read: () => Promise<string | null>,
  wait: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 250)),
): Promise<string | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await read()
    } catch (error) {
      if (attempt === 2) throw error
      await wait()
    }
  }
}

/** A successful login must not claim persistence until the vault can read it. */
export async function persistVerifiedCredential(
  value: string,
  write: (value: string) => Promise<void>,
  read: () => Promise<string | null>,
): Promise<void> {
  try {
    await write(value)
    if (await read() !== value) throw new SessionPersistenceError()
  } catch {
    // Native errors may contain platform details; show only a fixed safe message.
    throw new SessionPersistenceError()
  }
}

export function resolveAuthenticatedTenantId(
  resolvedTenantId: string,
  claimsTenantId: string | null,
): string {
  const resolved = resolvedTenantId.trim()
  if (!resolved) throw new Error('tenant resolution returned an empty tenant_id')

  const claimed = claimsTenantId?.trim() ?? ''
  if (!claimed) throw new Error('authentication returned an empty tenant_id')
  if (claimed !== resolved) {
    throw new Error('authentication claims do not match the resolved tenant')
  }
  return claimed
}

export function isPasswordResetRequired(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as AuthenticationProblemLike
  const code = candidate.problem?.code ?? candidate.code
  const detail = candidate.problem?.detail ?? candidate.message

  if (candidate.status !== 403 || code !== 'forbidden' || typeof detail !== 'string') {
    return false
  }
  return /password(?:\s+expired[^;]*)?;?\s*reset required|password reset required/i.test(detail)
}

export function shouldInvalidateSessionOnUnauthorized(
  status: number,
  token: string | null | undefined,
  currentToken: string | null | undefined = token,
): boolean {
  return status === 401 && Boolean(token) && token === currentToken
}

/**
 * Invalidate a credential without relying on deletion succeeding.
 *
 * The blank value is deliberately written first. It cannot be parsed as a
 * session, so a keyring backend that rejects deletion still cannot revive the
 * previous token on the next launch. Failure to write the tombstone is
 * propagated because safe invalidation could not be guaranteed.
 */
export async function invalidateSecureCredential(
  writeTombstone: () => Promise<void>,
  deleteCredential: () => Promise<void>,
): Promise<void> {
  await writeTombstone()
  try {
    await deleteCredential()
  } catch {
    // The tombstone already made the persisted value non-restorable.
  }
}

/** An event-stream 401 alone cannot establish that the login credential expired. */
export async function verifyUnauthorizedSession(
  token: string | null | undefined,
  getCurrentToken: () => string | null | undefined,
  verifyIdentity: () => Promise<number>,
): Promise<'confirmed' | 'rejected' | 'unavailable' | 'stale'> {
  if (!shouldInvalidateSessionOnUnauthorized(401, token, getCurrentToken())) return 'stale'
  let status: number
  try { status = await verifyIdentity() } catch { return 'unavailable' }
  if (!shouldInvalidateSessionOnUnauthorized(401, token, getCurrentToken())) return 'stale'
  if (status === 401) return 'confirmed'
  return status >= 200 && status < 300 ? 'rejected' : 'unavailable'
}
