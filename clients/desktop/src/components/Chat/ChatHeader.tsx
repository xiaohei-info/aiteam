import type { ReactNode } from 'react'
import { FolderOpen, MoreHorizontal } from 'lucide-react'

interface ChatHeaderProps {
  emoji?: string
  avatar?: ReactNode
  name: string
  subtitle: string
  onFilesClick?: () => void
  onMoreClick: () => void
}

export function ChatHeader({ emoji, avatar, name, subtitle, onMoreClick, onFilesClick }: ChatHeaderProps) {
  return (
    <header className="chat-header">
      <div className="chat-header-avatar">
        {avatar ?? emoji ?? '?'}
      </div>
      <div>
        <h3 className="chat-header-name">{name}</h3>
        <p className="chat-header-sub">{subtitle}</p>
      </div>
      <div className="chat-header-actions">
        {onFilesClick && <button className="chat-header-more" type="button" title="会话文件目录" aria-label="会话文件目录" onClick={onFilesClick}><FolderOpen size={17} /></button>}
        <button className="chat-header-more" onClick={onMoreClick} type="button" title="查看会话详情" aria-label="查看会话详情">
          <MoreHorizontal size={16} strokeWidth={1.8} />
        </button>
      </div>
    </header>
  )
}
