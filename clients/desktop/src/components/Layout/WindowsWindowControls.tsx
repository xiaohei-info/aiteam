/**
 * Windows 风格的窗口控件：右上角 ─ ▢ ✕，悬停灰底、关闭悬停红底。
 * macOS 不渲染（保持无边框自绘外观，红黄绿见 BackendStartupScreen），浏览器开发时也不渲染。
 */
import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { usesWindowsWindowControls } from '../../lib/windowChrome'
import './WindowsWindowControls.css'

const GLYPH = { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true } as const

function canControlWindow(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export default function WindowsWindowControls() {
  const [maximized, setMaximized] = useState(false)
  const enabled = canControlWindow() && usesWindowsWindowControls(typeof navigator === 'undefined' ? '' : navigator.userAgent)

  useEffect(() => {
    if (!enabled) return
    const appWindow = getCurrentWindow()
    let current = true
    const sync = () => {
      void appWindow.isMaximized().then((value) => {
        if (current) setMaximized(value)
      })
    }
    sync()
    const pending = appWindow.onResized(() => sync())
    return () => {
      current = false
      void pending.then((unlisten) => unlisten())
    }
  }, [enabled])

  if (!enabled) return null
  const appWindow = getCurrentWindow()

  return (
    <div className="window-controls" role="group" aria-label="窗口控制">
      <button
        type="button"
        className="window-control"
        onClick={() => void appWindow.minimize()}
        title="最小化"
        aria-label="最小化窗口"
      >
        <svg {...GLYPH}>
          <path d="M0 5.5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button
        type="button"
        className="window-control"
        onClick={() => void appWindow.toggleMaximize()}
        title={maximized ? '向下还原' : '最大化'}
        aria-label={maximized ? '还原窗口' : '最大化窗口'}
      >
        {maximized ? (
          <svg {...GLYPH}>
            <path d="M2.5 2.5v-2h7v7h-2" fill="none" stroke="currentColor" strokeWidth="1" />
            <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg {...GLYPH}>
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="window-control window-control-close"
        onClick={() => void appWindow.close()}
        title="关闭"
        aria-label="关闭窗口"
      >
        <svg {...GLYPH}>
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  )
}
