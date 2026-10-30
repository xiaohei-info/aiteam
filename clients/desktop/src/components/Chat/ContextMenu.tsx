/**
 * 通用右键上下文菜单，通过 Portal 渲染到 body，自动修正位置避免超出视口边界。
 *
 * @注意 点击菜单区外自动调用 onClose 关闭；菜单宽度固定 160px，高度按菜单项数量计算。
 * @events onClose 点击菜单外部时触发；items[].onClick 各菜单项的点击回调
 */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './ContextMenu.css'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'

export interface ContextMenuItem {
  label: string
  icon?: ReactNode
  onClick: () => void
  danger?: boolean
}

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useGlobalShortcutClose({ onClose })

  const menuWidth = 160
  const menuHeight = items.length * 36 + 8
  const adjustedX = Math.min(x, window.innerWidth - menuWidth - 8)
  const adjustedY = Math.min(y, window.innerHeight - menuHeight - 8)

  useLayoutEffect(() => {
    const activeElement = document.activeElement
    returnFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null
    const frame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
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
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
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
    const menuItems = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
    if (menuItems.length === 0) return
    e.preventDefault()
    const currentIndex = menuItems.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Home') menuItems[0].focus()
    else if (e.key === 'End') menuItems[menuItems.length - 1].focus()
    else if (e.key === 'ArrowDown') menuItems[(currentIndex + 1 + menuItems.length) % menuItems.length].focus()
    else menuItems[(currentIndex - 1 + menuItems.length) % menuItems.length].focus()
  }

  return createPortal(
    <div
      ref={menuRef}
      className="cm"
      style={{ left: adjustedX, top: adjustedY }}
      role="menu"
      aria-label="消息操作"
      onKeyDown={handleMenuKeyDown}
    >
      {items.map((item, i) => (
        <button
          type="button"
          role="menuitem"
          key={i}
          className={`cm-item${item.danger ? ' danger' : ''}`}
          onClick={() => { item.onClick(); onClose() }}
        >
          {item.icon && <span className="cm-item-icon">{item.icon}</span>}
          {item.label}
        </button>
      ))}
    </div>,
    document.body
  )
}
