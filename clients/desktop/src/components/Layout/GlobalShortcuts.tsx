import { useCallback, useEffect, useRef, useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import './GlobalShortcuts.css'
import { globalShortcutRegistry } from '../../hooks/useGlobalShortcut'
import { handleGlobalShortcut } from '../../lib/globalShortcuts'

const ERROR_VISIBLE_MS = 4_000

function isTauriRuntime(): boolean {
  return isTauri()
    || (typeof window !== 'undefined'
      && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__))
}

export default function GlobalShortcuts() {
  const [errorMessage, setErrorMessage] = useState('')
  const errorTimerRef = useRef<number | null>(null)

  const reportError = useCallback((message: string) => {
    setErrorMessage(message)
    if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current)
    errorTimerRef.current = window.setTimeout(() => {
      setErrorMessage('')
      errorTimerRef.current = null
    }, ERROR_VISIBLE_MS)
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      handleGlobalShortcut(event, {
        registry: globalShortcutRegistry,
        isTauri: isTauriRuntime(),
        closeTauriWindow: () => getCurrentWindow().close(),
        onActionError: () => reportError('快捷键操作失败，请重试。'),
        onWindowCloseError: () => reportError('窗口关闭失败，请使用左上角关闭按钮重试。'),
      })
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [reportError])

  useEffect(() => () => {
    if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current)
  }, [])

  if (!errorMessage) return null
  return <div className="global-shortcut-error" role="alert">{errorMessage}</div>
}
