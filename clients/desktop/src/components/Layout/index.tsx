/**
 * 全局应用布局容器，组合 Sidebar、Panel（会话列表）、主内容区和 AgentDetailPanel。
 *
 * @注意 Panel 和 AgentDetailPanel 仅在路径以 /chat 开头时渲染。
 * @events children 渲染当前路由匹配的页面内容
 */
import { ReactNode, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import Panel from './Panel'
import TopBar from './TopBar'
import ManagerUnavailableNotice from './ManagerUnavailableNotice'
import AgentDetailPanel from '../Chat/AgentDetailPanel'
import GroupDetailPanel from '../Chat/GroupDetailPanel'
import { useAgentAuthStore } from '../../stores/agentAuth'
import { useChatStore } from '../../stores/chat'
import { useManagerReachability } from '../../lib/managerReachability'

interface LayoutProps {
  children: ReactNode
}

/**
 * 会话列表刷新：不再定时轮询，改为「从死到活」的事件驱动。
 *
 * 触发点：
 * - 窗口重新可见 / 重新获得焦点（从后台或失焦恢复）
 * - 网络从离线恢复在线
 * - 全局活动通道断线重连（由 App 的 useGlobalActivity 负责）
 * - 企业管理服务从不可用恢复
 *
 * 会话有新消息时，列表项由全局活动信号直接补丁（见 chat store applyGlobalActivity），
 * 不必整表刷新。
 */
function useConversationListRefresh(refresh: () => Promise<void>, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    const refreshNow = () => { refresh().catch(console.error) }
    const onVisibility = () => { if (!document.hidden) refreshNow() }
    const onFocus = () => refreshNow()
    const onOnline = () => refreshNow()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnline)
    }
  }, [enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  // Manager 从不可用恢复：列表接口此前会吃 503，恢复后立即对齐一次。
  useEffect(() => {
    if (!enabled) return
    let wasUnavailable = useManagerReachability.getState().unavailable
    return useManagerReachability.subscribe((state) => {
      if (wasUnavailable && !state.unavailable) refresh().catch(console.error)
      wasUnavailable = state.unavailable
    })
  }, [enabled]) // eslint-disable-line react-hooks/exhaustive-deps
}

export default function Layout({ children }: LayoutProps) {
  const location = useLocation()
  // 连接中布局已展示但还没有 token，会话数据等登录完成再加载。
  const isAuthenticated = useAgentAuthStore((s) => s.isAuthenticated)
  const loadAgentsAndConversations = useChatStore((s) => s.loadAgentsAndConversations)
  const refreshConversations = useChatStore((s) => s.refreshConversations)
  const showPanel = location.pathname.startsWith('/chat') || location.pathname.startsWith('/group-chat')
  const isGroupChat = location.pathname.startsWith('/group-chat')

  useEffect(() => {
    if (isAuthenticated) loadAgentsAndConversations()
  }, [isAuthenticated]) // eslint-disable-line react-hooks/exhaustive-deps

  useConversationListRefresh(refreshConversations, isAuthenticated)

  return (
    <div className="app-shell relative flex h-[100dvh] overflow-hidden">
      <div className="absolute inset-0 grain pointer-events-none" />
      <Sidebar />
      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <TopBar />
        <ManagerUnavailableNotice />
        <div className={`${showPanel ? 'workspace-stage ' : ''}flex min-h-0 flex-1 overflow-hidden`}>
          {showPanel && <Panel />}
          <main className={`${showPanel ? 'workspace-main ' : ''}relative flex-1 overflow-hidden`}>
            <div className="relative z-10 h-full overflow-hidden">
              {children}
            </div>
          </main>
          {showPanel && (isGroupChat ? <GroupDetailPanel /> : <AgentDetailPanel />)}
        </div>
      </div>
    </div>
  )
}
