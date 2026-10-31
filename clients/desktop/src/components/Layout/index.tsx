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
import AgentDetailPanel from '../Chat/AgentDetailPanel'
import GroupDetailPanel from '../Chat/GroupDetailPanel'
import { useChatStore } from '../../stores/chat'

/** workbench 轮询间隔：刷新会话列表/未读数 */
const WORKBENCH_POLL_INTERVAL_MS = 30_000

interface LayoutProps {
  children: ReactNode
}

/** 周期性刷新会话列表与未读数；页面隐藏时暂停，重新可见时立即刷新一次。 */
function useWorkbenchPolling(refresh: () => Promise<void>) {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null

    const start = () => {
      if (timer) return
      timer = setInterval(() => {
        refresh().catch(console.error)
      }, WORKBENCH_POLL_INTERVAL_MS)
    }
    const stop = () => {
      if (timer) { clearInterval(timer); timer = null }
    }

    const onVisibility = () => {
      if (document.hidden) {
        stop()
      } else {
        refresh().catch(console.error)  // 回到前台立即对齐一次
        start()
      }
    }

    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
}

export default function Layout({ children }: LayoutProps) {
  const location = useLocation()
  const loadAgentsAndConversations = useChatStore((s) => s.loadAgentsAndConversations)
  const refreshConversations = useChatStore((s) => s.refreshConversations)
  const showPanel = location.pathname.startsWith('/chat') || location.pathname.startsWith('/group-chat')
  const isGroupChat = location.pathname.startsWith('/group-chat')

  useEffect(() => {
    loadAgentsAndConversations()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useWorkbenchPolling(refreshConversations)

  return (
    <div className="app-shell relative flex h-[100dvh] overflow-hidden">
      <div className="absolute inset-0 grain pointer-events-none" />
      <Sidebar />
      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <TopBar />
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
