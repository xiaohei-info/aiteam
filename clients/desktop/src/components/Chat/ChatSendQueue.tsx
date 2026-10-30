import { useState, memo } from 'react'
import { GripVertical, Paperclip, Pencil, SendHorizontal, Trash2 } from 'lucide-react'
import type { QueuedChatMessage } from '../../lib/chatSendQueue'

interface ChatSendQueueProps {
  items: QueuedChatMessage[]
  /** 队首发送失败后暂停自动发送，等用户点「立即发送」或再发一条消息时继续。 */
  paused?: boolean
  isGenerating?: boolean
  onSendNow: (id: string) => void
  onEdit: (id: string) => void
  onRemove: (id: string) => void
  onMove: (fromId: string, toId: string) => void
}

/** 输入框上方的待发送队列：拖动排序、立即发送、放回输入框编辑、删除。 */
export const ChatSendQueue = memo(({ items, paused, isGenerating, onSendNow, onEdit, onRemove, onMove }: ChatSendQueueProps) => {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  if (items.length === 0) return null

  return (
    <div className="chat-send-queue-wrap">
    {paused && <p className="chat-send-queue-paused" role="status">队列中的消息发送失败，已暂停；点「立即发送」重试</p>}
    <ul className="chat-send-queue" aria-label={`待发送消息队列，共 ${items.length} 条，当前回复结束后依次发送`}>
      {items.map((item) => {
        const label = item.text || (item.files.length > 0 ? `${item.files.length} 个附件` : '')
        return (
          <li
            key={item.id}
            className={`chat-send-queue-item${draggingId === item.id ? ' dragging' : ''}${overId === item.id && draggingId !== item.id ? ' drop-target' : ''}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', item.id)
              setDraggingId(item.id)
            }}
            onDragOver={(e) => {
              if (!draggingId) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (overId !== item.id) setOverId(item.id)
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (draggingId) onMove(draggingId, item.id)
              setDraggingId(null)
              setOverId(null)
            }}
            onDragEnd={() => { setDraggingId(null); setOverId(null) }}
          >
            <span className="chat-send-queue-grip" aria-hidden="true"><GripVertical size={14} strokeWidth={1.8} /></span>
            <span className="chat-send-queue-text" title={item.text}>{label}</span>
            {item.text && item.files.length > 0 && (
              <span className="chat-send-queue-files" title={`${item.files.length} 个附件`}>
                <Paperclip size={12} strokeWidth={1.8} aria-hidden="true" />{item.files.length}
              </span>
            )}
            <span className="chat-send-queue-actions">
              <button type="button" className="chat-send-queue-btn" title={isGenerating ? '立即发送（中止当前回复）' : '立即发送'} aria-label={`立即发送：${label}`} onClick={() => onSendNow(item.id)}>
                <SendHorizontal size={14} strokeWidth={1.8} aria-hidden="true" />
              </button>
              <button type="button" className="chat-send-queue-btn" title="编辑" aria-label={`编辑：${label}`} onClick={() => onEdit(item.id)}>
                <Pencil size={14} strokeWidth={1.8} aria-hidden="true" />
              </button>
              <button type="button" className="chat-send-queue-btn" title="删除" aria-label={`删除：${label}`} onClick={() => onRemove(item.id)}>
                <Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </span>
          </li>
        )
      })}
    </ul>
    </div>
  )
})
