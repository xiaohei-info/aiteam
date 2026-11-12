/**
 * 全局活动通道监听。
 *
 * 挂载后保持一条 `GET /api/agent/events` 长连接：
 * - 收到信号 → 交给 chat store 做「列表补丁 + 按需订阅当前会话」；
 * - 断线 → 内部指数退避重连；重连成功后对齐一次会话列表，补齐断连期间漏掉的信号。
 *
 * 按 `sessionGeneration` 重挂：切换账号后 token 变化，旧连接必须重新建立。
 */
import { useEffect } from 'react'
import { agentApi } from '../api/agent'
import { useAgentAuthStore } from '../stores/agentAuth'
import { useChatStore } from '../stores/chat'

export function useGlobalActivity(): void {
  const isAuthenticated = useAgentAuthStore((s) => s.isAuthenticated)
  const sessionGeneration = useAgentAuthStore((s) => s.sessionGeneration)

  useEffect(() => {
    if (!isAuthenticated) return
    // 首次连接不算「重连」：列表刚由 loadAgentsAndConversations 拉过。
    let hasConnected = false
    const subscription = agentApi.subscribeGlobalActivity({
      onEvent: (event) => {
        useChatStore.getState().applyGlobalActivity(event)
      },
      onConnected: () => {
        if (!hasConnected) {
          hasConnected = true
          return
        }
        useChatStore.getState().refreshConversations().catch(console.error)
      },
      onError: (err) => console.error('[global activity] connection failed', err),
    })
    return () => subscription.close()
  }, [isAuthenticated, sessionGeneration])
}
