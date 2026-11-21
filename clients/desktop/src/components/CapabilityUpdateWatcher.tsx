/** 能力更新检查的时机：登录后一次、每 10 分钟、窗口切回前台（1 分钟内不重复）。不渲染任何内容。 */
import { useEffect } from 'react'
import { CAPABILITY_CHECK_INTERVAL_MS, shouldCheckOnFocus } from '../lib/capabilityUpdates'
import { useCapabilityUpdatesStore } from '../stores/capabilityUpdates'

export default function CapabilityUpdateWatcher() {
  useEffect(() => {
    const store = useCapabilityUpdatesStore.getState()
    // 登录 / 恢复会话时刚同步过专家配置，首次只读目录。
    void store.check()
    const timer = window.setInterval(() => void useCapabilityUpdatesStore.getState().check({ syncGrants: true }), CAPABILITY_CHECK_INTERVAL_MS)
    const onFocus = () => {
      if (document.visibilityState === 'hidden') return
      const current = useCapabilityUpdatesStore.getState()
      if (shouldCheckOnFocus(current.lastCheckedAt, Date.now())) void current.check({ syncGrants: true })
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      useCapabilityUpdatesStore.getState().reset()
    }
  }, [])
  return null
}
