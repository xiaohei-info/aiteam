/**
 * 聊天消息气泡容器，封装头像、名称、时间戳和消息内容的布局结构。
 *
 * @注意 纯展示组件，不处理任何业务逻辑；side='left' 为接收消息，side='right' 为发送消息。
 * @events onContextMenu 右键菜单事件，向上透传给父组件处理
 */
import { ReactNode, MouseEvent } from 'react'
import './MessageBubble.css'

export interface MessageBubbleProps {
  side: 'left' | 'right'
  avatar?: ReactNode
  name?: string
  recipientName?: string
  time?: string
  above?: ReactNode
  isStreaming?: boolean
  hideBody?: boolean
  onContextMenu?: (e: MouseEvent<HTMLDivElement>) => void
  onAvatarClick?: (e: MouseEvent<HTMLButtonElement>) => void
  children: ReactNode
}

export default function MessageBubble({
  side,
  avatar,
  name,
  recipientName,
  time,
  above,
  isStreaming,
  hideBody,
  onContextMenu,
  onAvatarClick,
  children,
}: MessageBubbleProps) {
  return (
    <div className={`mb ${side}`}>
      {avatar && (
        <button
          type="button"
          className="mb-avatar-wrap"
          onClick={onAvatarClick}
          aria-label={`查看${name ?? '成员'}信息`}
        >
          <div className={`mb-avatar ${side}${isStreaming ? ' streaming' : ''}`}>
            {avatar}
          </div>
        </button>
      )}

      <div className={`mb-col ${side}`}>
        {name && (
          <div className="mb-name-row">
            <span className="mb-name">{name}</span>
            {recipientName && (
              <span className="mb-recipient" title={`委派给 ${recipientName}`}>
                <span className="mb-recipient-arrow">→</span>
                <span className="mb-recipient-name">@{recipientName}</span>
              </span>
            )}
          </div>
        )}
        {above && <div className="mb-above">{above}</div>}

        {!hideBody && <div
          onContextMenu={onContextMenu}
          className={`mb-bubble ${side}${onContextMenu ? ' interactive' : ''}`}
        >
          {children}
        </div>}

        {time && <span className="mb-time">{time}</span>}
      </div>
    </div>
  )
}
