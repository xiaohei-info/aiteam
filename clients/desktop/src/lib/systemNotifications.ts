import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window'
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import { useAgentAuthStore } from '../stores/agentAuth'
import {
  buildCompletionNotificationCopy,
  buildNotificationStorageKey,
  buildNotificationTarget,
  readNotificationPreference,
  shouldSendCompletionNotification,
  type NotificationTargetKind,
} from './notificationPolicy'

export type SystemNotificationPermissionState =
  | 'checking'
  | 'prompt'
  | 'granted'
  | 'denied'
  | 'unavailable'
  | 'error'

export interface SystemNotificationPermissionResult {
  state: SystemNotificationPermissionState
  message: string
}

export interface ConversationCompletionNotification {
  conversationId: string
  kind: NotificationTargetKind
  activeConversationId: string
  activeGroupId: string
}

// @tauri-apps/plugin-notification 2.4.0 的 desktop Rust 实现只注册发送/权限命令，
// 不注册 JS onAction 所需的 register_listener，也不会保留 notify-rust 的点击句柄。
// 因此桌面端只能诚实降级；不能用 DOM click 冒充系统通知点击回调。
export const DESKTOP_NOTIFICATION_CLICK_SUPPORTED = false
export const DESKTOP_NOTIFICATION_CLICK_MESSAGE = '当前 Tauri 桌面通知插件不提供可验证的点击回调，暂时无法从系统通知直接回到会话。'

function getPreferenceStorageKey(): string | null {
  const auth = useAgentAuthStore.getState()
  return buildNotificationStorageKey({
    tenantId: auth.tenantId,
    memberId: auth.claims?.user_id ?? auth.account,
  })
}

export async function checkSystemNotificationPermission(): Promise<SystemNotificationPermissionResult> {
  if (!isTauri()) {
    return { state: 'unavailable', message: '浏览器预览不支持 Tauri 系统通知，请在桌面客户端中设置。' }
  }
  try {
    if (await isPermissionGranted()) {
      return { state: 'granted', message: '系统通知权限已授予。' }
    }
    return { state: 'prompt', message: '系统通知尚未授权，可在此明确申请。' }
  } catch {
    return { state: 'error', message: '无法读取系统通知权限，请稍后重试。' }
  }
}

// 只能由 Settings 中的明确按钮点击调用，应用启动与消息事件都不得隐式申请权限。
export async function requestSystemNotificationPermission(): Promise<SystemNotificationPermissionResult> {
  if (!isTauri()) {
    return { state: 'unavailable', message: '浏览器预览不支持 Tauri 系统通知，请在桌面客户端中重试。' }
  }
  try {
    const result = await requestPermission()
    if (result === 'granted') {
      return { state: 'granted', message: '系统通知权限已授予。' }
    }
    if (result === 'denied') {
      return { state: 'denied', message: '系统通知权限被拒绝，可重试或前往系统设置开启。' }
    }
    return { state: 'prompt', message: '系统未授予通知权限，你可以稍后重试。' }
  } catch {
    return { state: 'error', message: '通知权限申请失败，请稍后重试。' }
  }
}

export async function notifyConversationCompleted(
  completion: ConversationCompletionNotification,
): Promise<boolean> {
  const target = buildNotificationTarget(completion.kind, completion.conversationId)
  if (!target || !isTauri()) return false

  const preference = readNotificationPreference(getPreferenceStorageKey())
  if (preference !== 'enabled') return false

  // 消息完成事件只能检查现有授权，绝不在后台触发权限弹窗。
  const permissionGranted = await isPermissionGranted().catch(() => null)
  if (permissionGranted === null) return false

  const shouldSend = shouldSendCompletionNotification({
    preference,
    permissionGranted,
    isTauriRuntime: true,
    documentVisible: document.visibilityState === 'visible',
    windowFocused: document.hasFocus(),
    pathname: window.location.pathname,
    activeConversationId: completion.activeConversationId,
    activeGroupId: completion.activeGroupId,
    target,
  })
  if (!shouldSend) return false

  const copy = buildCompletionNotificationCopy(completion.kind)
  try {
    sendNotification({
      title: copy.title,
      body: copy.body,
      extra: { target },
      autoCancel: true,
    })
    return true
  } catch {
    return false
  }
}

// 审批有时限且弹窗在应用内：窗口不在前台时发系统通知并让 Dock 图标弹跳。
// 仅检查现有授权，不隐式申请权限；不依赖“完成通知”开关，因为错过审批会直接导致员工任务失败。
export async function notifyApprovalRequired(summary: { employee?: string; toolLabel: string }): Promise<boolean> {
  if (!isTauri()) return false
  if (document.visibilityState === 'visible' && document.hasFocus()) return false
  void getCurrentWindow().requestUserAttention(UserAttentionType.Critical).catch(() => undefined)
  if (!(await isPermissionGranted().catch(() => false))) return false
  try {
    sendNotification({
      title: '员工请求你的授权',
      body: `${summary.employee ?? '员工'}请求${summary.toolLabel}，请回到应用处理，超时会自动失效。`,
      autoCancel: true,
    })
    return true
  } catch {
    return false
  }
}
