/**
 * 能力更新检查的时机：登录后随机延迟 0–60 秒一次、之后每 10 分钟、窗口切回前台（1 分钟内不重复）；
 * 正在回复时推迟的同步在回复结束后立即补上。不渲染任何内容。
 */
import { useEffect } from 'react'
import { CAPABILITY_CHECK_INTERVAL_MS, firstCheckDelay, shouldCheckOnFocus } from '../lib/capabilityUpdates'
import { useCapabilityUpdatesStore } from '../stores/capabilityUpdates'
import { useChatStore } from '../stores/chat'

export default function CapabilityUpdateWatcher() {
  useEffect(() => {
    const check = (syncGrants: boolean) => void useCapabilityUpdatesStore.getState().check({ syncGrants })
    let timer: number | undefined
    // 随机错开：许多成员同时上线时不在同一刻请求企业端。登录 / 恢复会话时刚同步过专家配置，首次只读目录。
    const first = window.setTimeout(() => {
      check(false)
      timer = window.setInterval(() => check(true), CAPABILITY_CHECK_INTERVAL_MS)
    }, firstCheckDelay())
    const onFocus = () => {
      if (document.visibilityState === 'hidden') return
      if (shouldCheckOnFocus(useCapabilityUpdatesStore.getState().lastCheckedAt, Date.now())) check(true)
    }
    const stopWatchingReplies = useChatStore.subscribe((state, previous) => {
      if (previous.generatingConvIds.size > 0 && state.generatingConvIds.size === 0 && useCapabilityUpdatesStore.getState().hasDeferredSync()) check(true)
    })
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.clearTimeout(first)
      if (timer !== undefined) window.clearInterval(timer)
      stopWatchingReplies()
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      useCapabilityUpdatesStore.getState().reset()
    }
  }, [])
  return null
}
