import { useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { MessageCircle, UserCog } from 'lucide-react'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'

interface Props {
  anchor: { x: number; y: number }
  onClose: () => void
  onChat: () => void
  onAssign?: () => void
  assignDisabledReason: string
}

export function MemberActionPopup({ anchor, onClose, onChat, onAssign, assignDisabledReason }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useGlobalShortcutClose({ onClose })

  useLayoutEffect(() => {
    const activeElement = document.activeElement
    returnFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null
    const frame = window.requestAnimationFrame(() => {
      ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
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
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClick)
    }
  }, [onClose])

  // 钳制到可视区域内，鼠标右键与键盘入口共用同一菜单。
  const menuWidth = 220
  const menuHeight = assignDisabledReason ? 150 : 90
  const viewportPadding = 8
  const style: React.CSSProperties = {
    position: 'fixed',
    top: Math.max(viewportPadding, Math.min(anchor.y, window.innerHeight - menuHeight - viewportPadding)),
    left: Math.max(viewportPadding, Math.min(anchor.x, window.innerWidth - menuWidth - viewportPadding)),
    zIndex: 1000,
  }

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
    <div ref={ref} className="map-popup" style={style} role="menu" aria-label="员工操作" onKeyDown={handleMenuKeyDown}>
      <button type="button" role="menuitem" className="map-popup-item" onClick={() => { onChat(); onClose() }}>
        <MessageCircle size={14} strokeWidth={1.7} aria-hidden="true" />
        对话
      </button>
      <div className="map-popup-divider" role="separator" aria-hidden="true" />
      <button type="button" role="menuitem" className="map-popup-item" disabled={Boolean(assignDisabledReason) || !onAssign} onClick={() => { onAssign?.() }} title={assignDisabledReason || undefined} aria-describedby={assignDisabledReason ? 'map-assign-disabled-reason' : undefined}>
        <UserCog size={14} strokeWidth={1.7} aria-hidden="true" />
        分配部门
      </button>
      {assignDisabledReason && <p id="map-assign-disabled-reason" className="map-popup-notice">{assignDisabledReason}</p>}
    </div>,
    document.body
  )
}
