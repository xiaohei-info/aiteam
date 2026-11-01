import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, Bot, Building2, ChevronRight, ExternalLink, Globe, LogOut, MessageSquarePlus, RefreshCw, Wrench, type LucideIcon } from 'lucide-react'
import './Settings.css'
import ApplicationLogs from './ApplicationLogs'
import FileAccessSettings from './FileAccessSettings'
import {
  buildNotificationStorageKey,
  readNotificationPreferenceResult,
  writeNotificationPreference,
  type NotificationPreference,
} from '../../lib/notificationPolicy'
import {
  checkSystemNotificationPermission,
  DESKTOP_NOTIFICATION_CLICK_MESSAGE,
  requestSystemNotificationPermission,
  type SystemNotificationPermissionResult,
} from '../../lib/systemNotifications'
import { isOutcomeBubbleMuted, setOutcomeBubbleMuted } from '../../lib/contextOutcomeBubble'
import { openPortal, PORTALS } from '../../lib/portals'

// 暂不在设置里展示的入口（仍保留在 PORTALS 中，与 external_links.rs 保持一致）。
const HIDDEN_PORTAL_KEYS: ReadonlySet<string> = new Set(['agent-user'])
import { useAgentAuthStore } from '../../stores/agentAuth'

const INITIAL_NOTIFICATION_PERMISSION: SystemNotificationPermissionResult = {
  state: 'checking',
  message: '正在读取系统通知状态…',
}

const PORTAL_ICONS: Record<string, LucideIcon> = {
  'taiyi-ops': Globe,
  'enterprise-admin': Building2,
  'agent-user': Bot,
}

export default function Settings() {
  const logout = useAgentAuthStore((s) => s.logout)
  const tenantId = useAgentAuthStore((s) => s.tenantId)
  const memberId = useAgentAuthStore((s) => s.claims?.user_id ?? s.account)
  const navigate = useNavigate()
  const notificationStorageKey = buildNotificationStorageKey({ tenantId, memberId })
  const [notificationPreference, setNotificationPreference] = useState<NotificationPreference>('disabled')
  const [notificationPermission, setNotificationPermission] = useState<SystemNotificationPermissionResult>(
    INITIAL_NOTIFICATION_PERMISSION,
  )
  const [notificationBusy, setNotificationBusy] = useState(false)
  const [notificationPreferenceError, setNotificationPreferenceError] = useState<string | null>(null)
  const [notificationStorageError, setNotificationStorageError] = useState<string | null>(null)
  const [outcomeBubbleMuted, setOutcomeBubbleMutedState] = useState(isOutcomeBubbleMuted)
  const [outcomeBubbleError, setOutcomeBubbleError] = useState<string | null>(null)
  const toggleOutcomeBubble = (muted: boolean) => {
    if (setOutcomeBubbleMuted(muted)) { setOutcomeBubbleMutedState(muted); setOutcomeBubbleError(null) }
    else setOutcomeBubbleError('无法保存本地偏好，提示设置未改变。')
  }
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [portalError, setPortalError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const preferenceResult = readNotificationPreferenceResult(notificationStorageKey)
    setNotificationPreference(preferenceResult.preference)
    setNotificationStorageError(
      preferenceResult.status === 'unavailable'
        ? '无法读取此设备的账号通知偏好，通知保持关闭。'
        : preferenceResult.status === 'invalid'
          ? '检测到无效的通知偏好，已安全关闭通知。'
          : null,
    )
    setNotificationPermission(INITIAL_NOTIFICATION_PERMISSION)
    checkSystemNotificationPermission().then((result) => {
      if (!cancelled) setNotificationPermission(result)
    })
    return () => { cancelled = true }
  }, [notificationStorageKey])

  const handleOpenPortal = async (key: string) => {
    setPortalError(null)
    try {
      await openPortal(key)
    } catch (err) {
      setPortalError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  const handleEnableNotifications = async () => {
    setNotificationBusy(true)
    setNotificationPreferenceError(null)
    const result = await requestSystemNotificationPermission()
    setNotificationPermission(result)
    if (result.state === 'granted') {
      const saved = writeNotificationPreference(notificationStorageKey, 'enabled')
      if (saved) {
        setNotificationPreference('enabled')
        setNotificationStorageError(null)
      } else {
        setNotificationPreference('disabled')
        setNotificationPreferenceError('权限已授予，但本地偏好保存失败，通知仍保持关闭。')
      }
    }
    setNotificationBusy(false)
  }

  const handleDisableNotifications = () => {
    setNotificationPreferenceError(null)
    if (writeNotificationPreference(notificationStorageKey, 'disabled')) {
      setNotificationPreference('disabled')
      setNotificationStorageError(null)
    } else {
      setNotificationPreferenceError('无法保存本地偏好，系统通知设置未改变。')
    }
  }

  const handleRefreshNotificationPermission = async () => {
    setNotificationBusy(true)
    setNotificationPreferenceError(null)
    setNotificationPermission(INITIAL_NOTIFICATION_PERMISSION)
    setNotificationPermission(await checkSystemNotificationPermission())
    setNotificationBusy(false)
  }

  const notificationStatusLabel = notificationPermission.state === 'granted'
    ? notificationPreference === 'enabled' ? '已开启' : '本地已关闭'
    : notificationPermission.state === 'checking' ? '检测中'
      : notificationPermission.state === 'prompt' ? '等待授权'
        : notificationPermission.state === 'denied' ? '权限被拒绝'
          : notificationPermission.state === 'unavailable' ? '当前不可用'
            : '检测失败'

  return (
    <div className="settings-page">
      <div className="settings-content">
        <section className="settings-card glass-panel" aria-labelledby="settings-portals-title">
          <div className="settings-section-heading">
            <Globe size={16} strokeWidth={1.7} aria-hidden="true" />
            <div>
              <h2 id="settings-portals-title">平台入口</h2>
              <p>点击后在系统浏览器中打开对应的管理页面。</p>
            </div>
          </div>
          <ul className="settings-portal-list">
            {PORTALS.filter((portal) => !HIDDEN_PORTAL_KEYS.has(portal.key)).map((portal) => {
              const Icon = PORTAL_ICONS[portal.key] ?? Globe
              return (
                <li key={portal.key}>
                  <button
                    type="button"
                    className="settings-portal"
                    onClick={() => { void handleOpenPortal(portal.key) }}
                    aria-label={`在浏览器中打开${portal.name}`}
                  >
                    <span className="settings-portal-icon"><Icon size={18} strokeWidth={1.6} aria-hidden="true" /></span>
                    <span className="settings-portal-copy">
                      <strong>{portal.name}</strong>
                      <span>{portal.features.join(' · ')}</span>
                    </span>
                    <ExternalLink className="settings-portal-open" size={14} aria-hidden="true" />
                  </button>
                </li>
              )
            })}
          </ul>
          {portalError && <p className="settings-notification-error" role="alert">{portalError}</p>}
        </section>

        <section id="notifications" className="settings-card glass-panel" aria-labelledby="settings-notifications-title">
          <div className="settings-section-heading">
            <Bell size={16} strokeWidth={1.7} aria-hidden="true" />
            <div>
              <h2 id="settings-notifications-title">系统通知</h2>
              <p>应用不在前台时，提示 AI 消息已完成。</p>
            </div>
            <span className={`settings-notification-status ${notificationPermission.state}`}>
              {notificationStatusLabel}
            </span>
          </div>

          <div className="settings-notification-panel">
            <div className="settings-notification-copy">
              <span>任务与消息完成提醒</span>
              <p>{notificationPermission.message}</p>
            </div>
            <div className="settings-notification-actions">
              {notificationPreference === 'enabled' && notificationPermission.state === 'granted' ? (
                <button type="button" onClick={handleDisableNotifications} disabled={notificationBusy}>
                  关闭通知
                </button>
              ) : (
                <button type="button" onClick={handleEnableNotifications} disabled={notificationBusy}>
                  {notificationBusy ? '处理中…' : '启用并申请权限'}
                </button>
              )}
              <button
                type="button"
                className="secondary"
                onClick={handleRefreshNotificationPermission}
                disabled={notificationBusy}
              >
                <RefreshCw size={13} aria-hidden="true" />
                重新检测
              </button>
            </div>
          </div>

          {notificationPreferenceError && (
            <p className="settings-notification-error" role="alert">{notificationPreferenceError}</p>
          )}
          {notificationStorageError && (
            <p className="settings-notification-error" role="alert">{notificationStorageError}</p>
          )}
          <p className="settings-notification-note">
            通知偏好仅保存在此设备的当前账号下，不会同步到其他设备。{DESKTOP_NOTIFICATION_CLICK_MESSAGE}
          </p>
        </section>

        <section className="settings-card glass-panel" aria-labelledby="settings-outcome-title">
          <div className="settings-section-heading">
            <MessageSquarePlus size={16} strokeWidth={1.7} aria-hidden="true" />
            <div>
              <h2 id="settings-outcome-title">对话</h2>
              <p>回复结束后，在「开启新上下文」按钮旁询问这个问题是否解决。</p>
            </div>
            <span className={`settings-notification-status ${outcomeBubbleMuted ? '' : 'granted'}`}>
              {outcomeBubbleMuted ? '已关闭' : '已开启'}
            </span>
          </div>
          <div className="settings-notification-panel">
            <div className="settings-notification-copy">
              <span>「解决了吗」提示</span>
              <p>关闭后仍可在对话里的「新上下文」分隔线上补评，7 天内有效。</p>
            </div>
            <div className="settings-notification-actions">
              <button type="button" onClick={() => toggleOutcomeBubble(!outcomeBubbleMuted)}>
                {outcomeBubbleMuted ? '重新开启' : '关闭提示'}
              </button>
            </div>
          </div>
          {outcomeBubbleError && <p className="settings-notification-error" role="alert">{outcomeBubbleError}</p>}
        </section>

        <FileAccessSettings />

        <details
          className="settings-card glass-panel settings-advanced"
          onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
        >
          <summary>
            <Wrench size={16} strokeWidth={1.7} aria-hidden="true" />
            <span>高级与诊断</span>
            <ChevronRight className="settings-advanced-chevron" size={14} aria-hidden="true" />
          </summary>
          <div className="settings-advanced-body">
            <div className="settings-managed-config">
              <strong>由受控部署配置</strong>
              <p>Agent 与 Manager 服务地址由应用部署配置；Provider 密钥通过后端安全凭据链路管理。</p>
              <p>当前客户端不读取、保存或回显手工 API Key，也不支持覆盖服务地址。</p>
            </div>
            {advancedOpen && <ApplicationLogs />}
            <p className="settings-about-copy">AI Team Desktop v0.1.0</p>
          </div>
        </details>

        <button
          type="button"
          onClick={handleLogout}
          className="settings-logout"
        >
          <LogOut size={14} aria-hidden="true" />
          退出登录
        </button>
      </div>
    </div>
  )
}
