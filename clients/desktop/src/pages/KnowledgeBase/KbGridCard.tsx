/**
 * 知识库总览网格卡片：180×180 方形卡片。
 *
 * @description 展示类型图标、名称（单行截断）、更新时间。Hover 时右上角
 *   出现 “⋮” 操作菜单按钮，点击弹出下拉菜单。
 * @notice 主操作和菜单是两个并列按钮，避免 role=button 容器嵌套真实 button。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, MoreVertical } from 'lucide-react'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'
import type { KnowledgeBase as KnowledgeBaseItem } from './types'

interface KbGridCardProps {
  item: KnowledgeBaseItem
  // 与 index.tsx 中的 handleOpenDetail 保持一致签名，允许可选参数
  onOpen: (id?: string) => void
}

export default function KbGridCard({ item, onOpen }: KbGridCardProps) {
  // 控制右上角操作菜单的展开状态
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null)

  const handleCloseMenu = useCallback(() => {
    setIsMenuOpen(false)
    window.requestAnimationFrame(() => menuTriggerRef.current?.focus())
  }, [])

  useGlobalShortcutClose({ active: isMenuOpen, onClose: handleCloseMenu })

  // 点击卡片外区域关闭菜单
  useEffect(() => {
    if (!isMenuOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false)
      }
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleCloseMenu()
      }
    }
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    })
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [handleCloseMenu, isMenuOpen])

  // 点击 ⋮ 按钮：切换菜单，阻止冒泡到卡片
  const handleToggleMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    setIsMenuOpen((prev) => !prev)
  }

  // 菜单项点击：目前只有“打开知识库”，与卡片点击等价
  const handleMenuOpen = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    setIsMenuOpen(false)
    onOpen(item.id)
  }

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
    if (items.length === 0) return
    event.preventDefault()
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Home') items[0].focus()
    else if (event.key === 'End') items[items.length - 1].focus()
    else if (event.key === 'ArrowDown') items[(currentIndex + 1 + items.length) % items.length].focus()
    else items[(currentIndex - 1 + items.length) % items.length].focus()
  }

  return (
    <article className="kb-grid-card">
      <button
        type="button"
        className="kb-grid-card-main"
        onClick={() => onOpen(item.id)}
        aria-label={`打开知识库 ${item.name}`}
      >
        <span className="kb-grid-card-icon">
          <BookOpen size={26} strokeWidth={1.6} />
        </span>
        <span className="kb-grid-card-name" title={item.name}>{item.name}</span>
        <span className="kb-grid-card-meta">
          <span>{item.docCount} 文档</span>
          <span>更新于 {item.updatedAt || '—'}</span>
        </span>
      </button>

      {/* 右上角 ⋮ 操作按钮 + 下拉菜单，仅 Hover 或菜单展开时可见 */}
      <div className={`kb-grid-card-menu ${isMenuOpen ? 'open' : ''}`} ref={menuRef}>
        <button
          ref={menuTriggerRef}
          type="button"
          className="kb-grid-card-menu-trigger"
          onClick={handleToggleMenu}
          aria-haspopup="menu"
          aria-expanded={isMenuOpen}
          aria-label={`${item.name} 更多操作`}
          title="更多操作"
        >
          <MoreVertical size={14} strokeWidth={1.8} />
        </button>
        {isMenuOpen && (
          <div className="kb-grid-card-menu-list" role="menu" aria-label={`${item.name} 操作`} onKeyDown={handleMenuKeyDown}>
            <button
              type="button"
              role="menuitem"
              className="kb-grid-card-menu-item"
              onClick={handleMenuOpen}
            >
              打开知识库
            </button>
          </div>
        )}
      </div>
    </article>
  )
}
