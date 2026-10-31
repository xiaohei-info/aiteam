import { useId, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import './ChatTools.css'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'

interface ChatDialogProps {
  title: string
  onClose: () => void
  children: ReactNode
  className?: string
  /** 标题左侧的图标块；与 description 都缺省时，标题栏结构保持不变。 */
  icon?: ReactNode
  /** 标题下方的一行说明。 */
  description?: string
}

export function ChatDialog({ title, onClose, children, className, icon, description }: ChatDialogProps) {
  const ref = useDialogFocus<HTMLDivElement>()
  const titleId = useId()
  useGlobalShortcutClose({ active: true, onClose })
  return createPortal(<div className="chat-tools-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div ref={ref} className={className ? `chat-tools-dialog ${className}` : 'chat-tools-dialog'} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header>
        {icon || description ? <div className="chat-tools-heading">
          {icon && <span className="chat-tools-heading-icon" aria-hidden="true">{icon}</span>}
          <div><h2 id={titleId}>{title}</h2>{description && <p>{description}</p>}</div>
        </div> : <h2 id={titleId}>{title}</h2>}
        <button type="button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
      </header>
      {children}
    </div>
  </div>, document.body)
}
