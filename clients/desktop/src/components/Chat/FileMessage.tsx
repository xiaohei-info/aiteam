/**
 * 聊天文件消息气泡，支持图片内联预览与非图片文件的图标展示。
 *
 * @注意 调用 Tauri invoke('show_in_folder') 定位缓存文件，仅在桌面端可用。
 *       依赖 fileCache 工具函数解析文件元数据。
 * @events 右键菜单通过内嵌 ContextMenu 处理复制/转发等操作（内部事件，不向外传递）
 */
import { ReactNode, useState, MouseEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import MessageBubble from './MessageBubble'
import ContextMenu from './ContextMenu'
import { formatFileSize, isImageMime } from '../../lib/fileCache'
import './FileMessage.css'

interface FilePayload {
  name: string
  size: number
  mime: string
  asset_url: string
  rel_path: string
}

interface FileMessageProps {
  side: 'left' | 'right'
  avatar?: ReactNode
  name?: string
  recipientName?: string
  time?: string
  content: string
  onAvatarClick?: (e: MouseEvent<HTMLButtonElement>) => void
}

interface MenuPos { x: number; y: number }

function FileIcon({ mime }: { mime: string }) {
  if (mime === 'application/pdf') return <span>📄</span>
  if (mime.startsWith('video/')) return <span>🎬</span>
  if (mime.startsWith('audio/')) return <span>🎵</span>
  if (mime.includes('zip') || mime.includes('compressed')) return <span>🗜</span>
  if (mime.includes('word') || mime === 'text/plain') return <span>📝</span>
  if (mime.includes('sheet') || mime === 'text/csv') return <span>📊</span>
  return <span>📁</span>
}

export default function FileMessage({ side, avatar, name, recipientName, time, content, onAvatarClick }: FileMessageProps) {
  const [menu, setMenu] = useState<MenuPos | null>(null)

  let payload: FilePayload | null = null
  try { payload = JSON.parse(content) } catch { return null }
  if (!payload) return null

  const isImage = isImageMime(payload.mime)

  const handleContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const handleCopyName = () => { if (payload) navigator.clipboard.writeText(payload.name) }
  const handleShowInFolder = () => {
    if (payload) invoke('show_in_folder', { relPath: payload.rel_path }).catch(console.error)
  }

  return (
    <>
      <MessageBubble side={side} avatar={avatar} name={name} recipientName={recipientName} time={time} onContextMenu={handleContextMenu} onAvatarClick={onAvatarClick}>
        {isImage ? (
          <div className="fm-image-wrap">
            <img src={payload.asset_url} alt={payload.name} className="fm-image" />
            <div className="fm-image-meta">
              <span className="fm-image-name">{payload.name}</span>
              <span className="fm-image-size">{formatFileSize(payload.size)}</span>
            </div>
          </div>
        ) : (
          <div className="fm-card">
            <div className="fm-card-icon">
              <FileIcon mime={payload.mime} />
            </div>
            <div className="fm-card-info">
              <p className="fm-card-name">{payload.name}</p>
              <p className="fm-card-size">{formatFileSize(payload.size)}</p>
            </div>
          </div>
        )}
      </MessageBubble>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: '复制文件名', icon: '📋', onClick: handleCopyName },
            { label: '在文件夹中显示', icon: '📂', onClick: handleShowInFolder },
          ]}
        />
      )}
    </>
  )
}
