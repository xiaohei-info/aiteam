/**
 * 用户信息浮层，展示用户 ID、用户名及登出按钮，锚定于触发按钮右侧。
 *
 * @注意 通过 Portal 渲染到 body；位置根据 anchorRect 动态计算；点击外部或按 Escape 关闭。
 * @events onClose 点击外部或按 Escape 时触发；onLogout 点击登出按钮时触发
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { LogOut } from 'lucide-react'
import './UserProfileDialog.css'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'

interface UserProfileDialogProps {
  userId: string
  username: string
  anchorRect: DOMRect
  onClose: () => void
  onLogout: () => void
}

export default function UserProfileDialog({
  userId,
  username,
  anchorRect,
  onClose,
  onLogout,
}: UserProfileDialogProps) {
  const ref = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useGlobalShortcutClose({ onClose })

  // Position: right of avatar + small gap, aligned to bottom of anchor
  const left = anchorRect.right + 10
  const top = anchorRect.bottom - 120

  useLayoutEffect(() => {
    const activeElement = document.activeElement
    returnFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null
    const frame = window.requestAnimationFrame(() => {
      ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    })
    return () => {
      window.cancelAnimationFrame(frame)
      const returnTarget = returnFocusRef.current
      window.setTimeout(() => {
        if (returnTarget?.isConnected && !returnTarget.hasAttribute('disabled')) returnTarget.focus()
      }, 0)
    }
  }, [])

  useEffect(() => {
    const handleDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', handleDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  const handleMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
    if (items.length === 0) return
    e.preventDefault()
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Home') items[0].focus()
    else if (e.key === 'End') items[items.length - 1].focus()
    else if (e.key === 'ArrowDown') items[(currentIndex + 1 + items.length) % items.length].focus()
    else items[(currentIndex - 1 + items.length) % items.length].focus()
  }

  return createPortal(
    <div
      ref={ref}
      className="upd"
      style={{ left, top }}
      role="menu"
      aria-label="用户账户操作"
      onKeyDown={handleMenuKeyDown}
    >
      {/* User info */}
      <div className="upd-header">
        <div className="upd-avatar">{username.slice(0, 1).toUpperCase()}</div>
        <div className="upd-info">
          <div className="upd-name">{username}</div>
          <div className="upd-id">{userId}</div>
        </div>
      </div>

      <div className="upd-divider" role="separator" aria-hidden="true" />

      {/* Actions */}
      <button type="button" role="menuitem" className="upd-item danger" onClick={onLogout}>
        <LogOut size={14} strokeWidth={1.7} aria-hidden="true" />
        退出登录
      </button>
    </div>,
    document.body
  )
}
