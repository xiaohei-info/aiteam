import { useEffect, useState } from 'react'

export function isAppFocused(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

// 切回应用或恢复窗口时重新判断；仅可见但没有焦点的窗口不能自动标记已读。
export function useAppFocus(): boolean {
  const [focused, setFocused] = useState(isAppFocused)
  useEffect(() => {
    const handleFocusChange = () => setFocused(isAppFocused())
    window.addEventListener('focus', handleFocusChange)
    window.addEventListener('blur', handleFocusChange)
    document.addEventListener('visibilitychange', handleFocusChange)
    handleFocusChange()
    return () => {
      window.removeEventListener('focus', handleFocusChange)
      window.removeEventListener('blur', handleFocusChange)
      document.removeEventListener('visibilitychange', handleFocusChange)
    }
  }, [])
  return focused
}
