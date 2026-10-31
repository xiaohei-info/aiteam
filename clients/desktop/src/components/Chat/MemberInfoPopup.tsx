import { useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import './MemberInfoPopup.css'
import type { GroupMember } from '../../stores/chat'
import { getAvatarFallback, getEmployeeAvatar, renderAvatar } from '../../lib/avatarUtils'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'

interface Props {
  member: GroupMember
  anchor: { x: number; y: number }
  onClose: () => void
}

export function MemberInfoPopup({ member, anchor, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useGlobalShortcutClose({ onClose })

  useLayoutEffect(() => {
    const activeElement = document.activeElement
    returnFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null
    const frame = window.requestAnimationFrame(() => ref.current?.focus())
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
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClick)
    }
  }, [onClose])

  const avatarContent = getEmployeeAvatar(member.display_name, member.avatar_url)
  const avatar = renderAvatar(avatarContent, getAvatarFallback(member.display_name))

  return createPortal(
    <div
      ref={ref}
      className="mip"
      style={{ top: anchor.y, left: anchor.x }}
      role="dialog"
      aria-modal="false"
      aria-labelledby="member-info-popup-title"
      tabIndex={-1}
    >
      <div className="mip-avatar">{avatar}</div>
      <div className="mip-info">
        <span className="mip-name" id="member-info-popup-title">{member.display_name}</span>
        {member.role_name && <span className="mip-role">{member.role_name}</span>}
        {member.is_system_planner && <span className="mip-badge">主持人</span>}
      </div>
    </div>,
    document.body,
  )
}
