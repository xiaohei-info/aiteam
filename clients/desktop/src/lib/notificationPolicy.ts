export const NOTIFICATION_STORAGE_KEY_PREFIX = 'aifred.notifications.v1'
export const NOTIFICATION_TARGET_SOURCE = 'aifred-desktop'
export const NOTIFICATION_TARGET_VERSION = 1

export type NotificationPreference = 'enabled' | 'disabled'
export type NotificationPreferenceReadStatus = 'available' | 'unavailable' | 'invalid'
export type NotificationTargetKind = 'chat' | 'group'

export interface NotificationStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export interface NotificationIdentity {
  tenantId: string | null | undefined
  memberId: string | null | undefined
}

export interface NotificationPreferenceReadResult {
  preference: NotificationPreference
  status: NotificationPreferenceReadStatus
}

export interface NotificationTarget {
  source: typeof NOTIFICATION_TARGET_SOURCE
  version: typeof NOTIFICATION_TARGET_VERSION
  kind: NotificationTargetKind
  conversationId: string
}

export interface NotificationNavigation {
  path: '/chat' | '/group-chat'
  conversationId: string
  kind: NotificationTargetKind
}

export interface NotificationNavigationActions {
  setActiveConversation: (conversationId: string) => void
  setActiveGroup: (conversationId: string) => void
  navigate: (path: '/chat' | '/group-chat') => void
}

export interface CompletionNotificationContext {
  preference: NotificationPreference
  permissionGranted: boolean
  isTauriRuntime: boolean
  documentVisible: boolean
  windowFocused: boolean
  pathname: string
  activeConversationId: string
  activeGroupId: string
  target: NotificationTarget
}

export interface CompletionNotificationCopy {
  title: string
  body: string
}

const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export function getNotificationStorage(): NotificationStorage | null {
  if (typeof window === 'undefined') return null

  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function buildNotificationStorageKey(identity: NotificationIdentity): string | null {
  const tenantId = identity.tenantId?.trim()
  const memberId = identity.memberId?.trim()
  if (!tenantId || !memberId) return null
  return `${NOTIFICATION_STORAGE_KEY_PREFIX}:${encodeURIComponent(tenantId)}:${encodeURIComponent(memberId)}`
}

export function parseNotificationPreference(value: unknown): NotificationPreference {
  return value === 'enabled' ? 'enabled' : 'disabled'
}

export function readNotificationPreference(
  storageKey: string | null,
  storage: NotificationStorage | null = getNotificationStorage(),
): NotificationPreference {
  return readNotificationPreferenceResult(storageKey, storage).preference
}

export function readNotificationPreferenceResult(
  storageKey: string | null,
  storage: NotificationStorage | null = getNotificationStorage(),
): NotificationPreferenceReadResult {
  if (!storageKey || !storage) return { preference: 'disabled', status: 'unavailable' }

  try {
    const stored = storage.getItem(storageKey)
    if (stored === null || stored === 'disabled') {
      return { preference: 'disabled', status: 'available' }
    }
    if (stored === 'enabled') return { preference: 'enabled', status: 'available' }
    return { preference: 'disabled', status: 'invalid' }
  } catch {
    return { preference: 'disabled', status: 'unavailable' }
  }
}

export function writeNotificationPreference(
  storageKey: string | null,
  preference: NotificationPreference,
  storage: NotificationStorage | null = getNotificationStorage(),
): boolean {
  if (!storageKey || !storage) return false

  try {
    storage.setItem(storageKey, preference)
    return true
  } catch {
    return false
  }
}

export function buildNotificationTarget(
  kind: NotificationTargetKind,
  conversationId: string,
): NotificationTarget | null {
  if (!TARGET_ID_PATTERN.test(conversationId)) return null
  return {
    source: NOTIFICATION_TARGET_SOURCE,
    version: NOTIFICATION_TARGET_VERSION,
    kind,
    conversationId,
  }
}

export function parseNotificationTarget(value: unknown): NotificationTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<NotificationTarget>
  if (candidate.source !== NOTIFICATION_TARGET_SOURCE) return null
  if (candidate.version !== NOTIFICATION_TARGET_VERSION) return null
  if (candidate.kind !== 'chat' && candidate.kind !== 'group') return null
  if (typeof candidate.conversationId !== 'string') return null
  return buildNotificationTarget(candidate.kind, candidate.conversationId)
}

export function resolveNotificationNavigation(
  value: unknown,
  conversationIds: readonly string[],
  groupIds: readonly string[],
): NotificationNavigation | null {
  const target = parseNotificationTarget(value)
  if (!target) return null

  const knownIds = target.kind === 'group' ? groupIds : conversationIds
  if (!knownIds.includes(target.conversationId)) return null
  return {
    path: target.kind === 'group' ? '/group-chat' : '/chat',
    conversationId: target.conversationId,
    kind: target.kind,
  }
}

export function activateNotificationTarget(
  value: unknown,
  conversationIds: readonly string[],
  groupIds: readonly string[],
  actions: NotificationNavigationActions,
): boolean {
  const navigation = resolveNotificationNavigation(value, conversationIds, groupIds)
  if (!navigation) return false

  if (navigation.kind === 'group') actions.setActiveGroup(navigation.conversationId)
  else actions.setActiveConversation(navigation.conversationId)
  actions.navigate(navigation.path)
  return true
}

export function shouldSendCompletionNotification(context: CompletionNotificationContext): boolean {
  if (context.preference !== 'enabled') return false
  if (!context.permissionGranted || !context.isTauriRuntime) return false

  const isCurrentChat = context.target.kind === 'chat'
    && context.pathname.startsWith('/chat')
    && context.activeConversationId === context.target.conversationId
  const isCurrentGroup = context.target.kind === 'group'
    && context.pathname.startsWith('/group-chat')
    && context.activeGroupId === context.target.conversationId
  const isCurrentConversationVisible = context.documentVisible
    && context.windowFocused
    && (isCurrentChat || isCurrentGroup)

  return !isCurrentConversationVisible
}

// 通知正文刻意不带用户请求、会话标题或模型回复；系统锁屏也只显示无敏感信息的固定文案。
export function buildCompletionNotificationCopy(kind: NotificationTargetKind): CompletionNotificationCopy {
  return kind === 'group'
    ? { title: 'AIFred 协作已结束', body: '群聊中有新的 AI 消息，返回应用查看结果。' }
    : { title: 'AIFred 任务已结束', body: 'AI 员工已完成回复，返回应用查看结果。' }
}
