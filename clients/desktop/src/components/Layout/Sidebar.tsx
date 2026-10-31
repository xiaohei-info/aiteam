import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  BookOpen,
  Building2,
  ChevronsLeft,
  ChevronsRight,
  LayoutDashboard,
  MessageCircle,
  Network,
  Settings as SettingsIcon,
  Sparkles,
  Users,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { formatUnreadCount, sumConversationUnreadCounts } from '../../lib/conversationUnread'
import { useAgentAuthStore } from '../../stores/agentAuth'
import { useChatStore } from '../../stores/chat'
import { useThemeStore } from '../../stores/theme'

const NAV_ITEMS: { icon: LucideIcon; path: string; label: string; shortcut: string }[] = [
  { icon: MessageCircle, path: '/chat', label: '单聊', shortcut: '⌘1' },
  { icon: Users, path: '/group-chat', label: '群聊', shortcut: '⌘2' },
  { icon: Zap, path: '/tasks', label: '自动化', shortcut: '⌘3' },
  { icon: BookOpen, path: '/knowledge', label: '知识库', shortcut: '⌘4' },
  { icon: Sparkles, path: '/talents', label: '人才市场', shortcut: '⌘5' },
  { icon: LayoutDashboard, path: '/workbench', label: '工作台', shortcut: '⌘6' },
  { icon: Network, path: '/org', label: '组织架构', shortcut: '⌘7' },
  { icon: Building2, path: '/office', label: '办公室', shortcut: '⌘8' },
]

export default function Sidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const account = useAgentAuthStore((state) => state.account)
  const { conversations, groups, setActiveConvId, setActiveGroupId } = useChatStore()
  useThemeStore((state) => state.theme)
  const [collapsed, setCollapsed] = useState(false)
  const [isAnimating, setIsAnimating] = useState(false)

  const displayName = account ?? '用户'
  const avatarLetter = displayName.slice(0, 1).toUpperCase()
  const width = collapsed ? 'var(--sidebar-collapsed-width)' : 'var(--sidebar-width)'

  const chatUnread = sumConversationUnreadCounts(conversations)
  const groupUnread = sumConversationUnreadCounts(groups)
  const unreadMap: Record<string, number> = { '/chat': chatUnread, '/group-chat': groupUnread }
  const isSettingsActive = location.pathname.startsWith('/settings')

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return

      const item = NAV_ITEMS[Number(event.key) - 1]
      if (!item) return

      event.preventDefault()
      navigate(item.path)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [navigate])

  useEffect(() => {
    if (!isAnimating) return

    const timer = window.setTimeout(() => setIsAnimating(false), 280)
    return () => window.clearTimeout(timer)
  }, [collapsed, isAnimating])

  const handleNavClick = (path: string) => {
    if (path === '/chat' && conversations.length > 0) {
      setActiveConvId(conversations[0].id)
    } else if (path === '/group-chat' && groups.length > 0) {
      setActiveGroupId(groups[0].id)
    }
    navigate(path)
  }

  const handleToggleCollapsed = () => {
    setIsAnimating(true)
    setCollapsed((v) => !v)
  }

  return (
    <aside
      className={`sidebar-shell group/sidebar relative z-20 ${collapsed ? 'is-collapsed' : 'is-expanded'} ${isAnimating ? 'is-animating' : ''}`}
      style={{ width }}
      data-collapsed={collapsed}
      aria-label="应用侧栏"
    >
      <div className="sidebar-surface-clip" aria-hidden="true">
        <div className="sidebar-glass" />
      </div>

      <button
        type="button"
        onClick={handleToggleCollapsed}
        className="absolute right-[-12px] top-1/2 z-50 flex h-6 w-6 -translate-y-1/2 transform-gpu cursor-pointer items-center justify-center rounded-full border border-[var(--border-active)] bg-[var(--navigation-glass-bg-strong)] text-brand opacity-0 shadow-md backdrop-blur-[18px] transition-[opacity,background-color,border-color,color,box-shadow,transform] duration-200 hover:scale-105 hover:bg-[var(--navigation-item-hover)] group-hover/sidebar:opacity-100"
        title={collapsed ? '展开侧栏' : '收起侧栏'}
        aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
        aria-expanded={!collapsed}
      >
        {collapsed ? <ChevronsRight size={12} strokeWidth={1.7} /> : <ChevronsLeft size={12} strokeWidth={1.7} />}
      </button>

      <div className="relative z-10 flex h-full flex-col">
        <div data-tauri-drag-region className="relative z-10 h-12 flex-shrink-0">
          <div className="absolute left-4 top-1/2 flex -translate-y-1/2 items-center gap-[7px]">
            <button
              type="button"
              onClick={() => getCurrentWindow().close()}
              className="h-[12px] w-[12px] flex-shrink-0 cursor-pointer rounded-full border border-[#e0443e]/40 bg-[#ff5f57] shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-colors duration-150 hover:bg-[#ff3b30]"
              title="关闭"
              aria-label="关闭窗口"
            />
            <button
              type="button"
              onClick={() => getCurrentWindow().minimize()}
              className="h-[12px] w-[12px] flex-shrink-0 cursor-pointer rounded-full border border-[#dea123]/40 bg-[#febc2e] shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-colors duration-150 hover:bg-[#f5a623]"
              title="最小化"
              aria-label="最小化窗口"
            />
            <button
              type="button"
              onClick={() => getCurrentWindow().toggleMaximize()}
              className="h-[12px] w-[12px] flex-shrink-0 cursor-pointer rounded-full border border-[#1aab29]/40 bg-[#28c840] shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-colors duration-150 hover:bg-[#1db934]"
              title="最大化"
              aria-label="切换窗口最大化"
            />
          </div>
        </div>

        <div className="relative z-10 flex h-16 items-center gap-3 px-4">
          <div className="gold-gradient glow-gold-sm flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl text-txt-inverse shadow-lg">
            <Sparkles size={18} strokeWidth={1.7} aria-hidden="true" />
          </div>
          <div className="sidebar-label min-w-0 overflow-hidden whitespace-nowrap">
            <div className="min-w-0 overflow-hidden whitespace-nowrap">
              <div className="font-display text-[15px] font-semibold leading-tight text-txt-primary">AIFred</div>
              <div className="mt-0.5 text-[10px] leading-tight text-txt-muted">AI 原生组织</div>
            </div>
          </div>
        </div>

        <nav className="relative z-10 flex flex-1 flex-col gap-1 px-3" aria-label="主导航">
          {NAV_ITEMS.map((item, index) => {
            const isActive = location.pathname.startsWith(item.path)
            const Icon = item.icon
            return (
              <div key={item.path} className="relative">
                <button
                  type="button"
                  onClick={() => handleNavClick(item.path)}
                  className={`${collapsed ? 'tooltip-trigger' : ''} relative flex h-11 w-full items-center gap-3 rounded-md px-3 transition-colors duration-200 ${
                    isActive
                      ? 'bg-[var(--navigation-item-active)] text-brand shadow-[inset_0_0_0_1px_rgba(212,175,55,0.12)]'
                      : 'text-txt-secondary hover:bg-[var(--navigation-item-hover)] hover:text-txt-primary'
                  }`}
                  data-tip={collapsed ? item.label : undefined}
                  title={item.label}
                  aria-current={isActive ? 'page' : undefined}
                  aria-keyshortcuts={`Meta+${index + 1} Control+${index + 1}`}
                >
                  {isActive && <span className="absolute left-0 h-5 w-[3px] rounded-r-full bg-brand" aria-hidden="true" />}
                  <span className="relative flex-shrink-0">
                    <Icon size={20} strokeWidth={1.55} aria-hidden="true" />
                    {unreadMap[item.path] > 0 && (
                      <span className="absolute -right-2 -top-2 h-[16px] min-w-[16px] rounded-full bg-danger px-[3px] text-center text-[9px] font-bold leading-[16px] text-txt-inverse">
                        {formatUnreadCount(unreadMap[item.path])}
                      </span>
                    )}
                  </span>
                  <span className="sidebar-label flex-1 overflow-hidden">
                    <span className="flex min-w-0 items-center justify-between overflow-hidden whitespace-nowrap">
                      <span className="truncate text-[13px] font-medium">{item.label}</span>
                      <span className="text-[10px] text-txt-muted">{item.shortcut}</span>
                    </span>
                  </span>
                </button>
              </div>
            )
          })}
        </nav>

        <div className="relative z-10 flex flex-col gap-1 px-3 pb-3">
          <div className="mb-1 border-t border-[var(--chrome-divider)] pt-2">
            <button
              type="button"
              onClick={() => navigate('/settings')}
              className={`${collapsed ? 'tooltip-trigger' : ''} relative flex h-10 w-full items-center gap-3 rounded-md px-3 text-left transition-colors duration-200 ${
                isSettingsActive
                  ? 'bg-[var(--navigation-item-active)] text-brand'
                  : 'text-txt-secondary hover:bg-[var(--navigation-item-hover)] hover:text-txt-primary'
              }`}
              data-tip={collapsed ? '设置' : undefined}
              title="设置"
              aria-label="打开设置"
              aria-current={isSettingsActive ? 'page' : undefined}
            >
              {isSettingsActive && <span className="absolute left-0 h-5 w-[3px] rounded-r-full bg-brand" aria-hidden="true" />}
              <SettingsIcon className="flex-shrink-0" size={19} strokeWidth={1.6} aria-hidden="true" />
              <span className="sidebar-label overflow-hidden whitespace-nowrap text-[12px] font-medium">设置</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => navigate('/profile')}
            className={`${collapsed ? 'tooltip-trigger' : ''} flex h-12 w-full items-center gap-3 rounded-lg px-3 text-left transition-[background-color] duration-200 hover:bg-[var(--navigation-item-hover)]`}
            data-tip={collapsed ? displayName : undefined}
            title={displayName}
            aria-label="用户信息"
            aria-current={location.pathname.startsWith('/profile') ? 'page' : undefined}
          >
            <span className="gold-gradient flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[12px] font-semibold text-txt-inverse">
              {avatarLetter}
            </span>
            <span className="sidebar-label overflow-hidden">
              <span className="min-w-0 overflow-hidden whitespace-nowrap">
                <span className="block truncate text-[12px] font-medium text-txt-primary">{displayName}</span>
                <span className="mt-0.5 block truncate text-[10px] text-txt-muted">AIFred 组织</span>
              </span>
            </span>
          </button>
        </div>
      </div>
    </aside>
  )
}
