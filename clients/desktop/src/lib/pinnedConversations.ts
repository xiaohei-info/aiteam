export const LEGACY_PINNED_STORAGE_KEY = 'aifred:conv:pinned'
const PINNED_STORAGE_PREFIX = 'aifred:conv:pinned:v2'

export interface PinnedAccountScope {
  isAuthenticated: boolean
  tenantId: string | null
  memberId: string | null
}

export interface PinnedStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export type PinnedConversations = Record<string, string>

export function getPinnedStorageKey(scope: PinnedAccountScope): string | null {
  if (!scope.isAuthenticated || !scope.tenantId || !scope.memberId) return null
  return `${PINNED_STORAGE_PREFIX}:${encodeURIComponent(scope.tenantId)}:${encodeURIComponent(scope.memberId)}`
}

export function loadPinnedConversations(
  storage: PinnedStorage,
  storageKey: string | null,
): PinnedConversations {
  if (!storageKey) return {}
  try {
    let raw = storage.getItem(storageKey)
    const legacyRaw = storage.getItem(LEGACY_PINNED_STORAGE_KEY)

    // 全局旧数据只交给首个建立认证作用域的账号，随后删除，避免后续账号串用。
    if (!raw && legacyRaw) {
      raw = legacyRaw
      storage.setItem(storageKey, legacyRaw)
    }
    if (legacyRaw) storage.removeItem(LEGACY_PINNED_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const pinned: PinnedConversations = {}
    for (const [conversationId, pinnedAt] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof pinnedAt === 'string') pinned[conversationId] = pinnedAt
    }
    return pinned
  } catch {
    return {}
  }
}

export function savePinnedConversations(
  storage: PinnedStorage,
  storageKey: string | null,
  pinned: PinnedConversations,
): void {
  if (!storageKey) return
  try {
    storage.setItem(storageKey, JSON.stringify(pinned))
  } catch {
    // 隐私模式或 quota 错误不应影响当前内存态。
  }
}

export function migratePinnedConversationId(
  pinned: PinnedConversations,
  oldId: string,
  newId: string,
): PinnedConversations {
  const next = { ...pinned }
  if (!next[oldId]) return next
  next[newId] = next[oldId]
  delete next[oldId]
  return next
}
