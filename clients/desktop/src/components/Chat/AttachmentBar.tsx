import { useId, useState } from 'react'
import { FileText, Music2, Video, ChevronDown, ChevronUp, Download } from 'lucide-react'
import './AttachmentBar.css'
import type { MessageAttachment } from '../../stores/chat'
import { agentApi } from '../../api/agent'

type AttachmentDownloadHandler = (attachment: MessageAttachment) => void

function FileTypeIcon({ mime }: { mime?: string }) {
  if (!mime) return <FileText size={14} strokeWidth={1.8} aria-hidden="true" />
  if (mime.startsWith('video/')) return <Video size={14} strokeWidth={1.8} aria-hidden="true" />
  if (mime.startsWith('audio/')) return <Music2 size={14} strokeWidth={1.8} aria-hidden="true" />
  return <FileText size={14} strokeWidth={1.8} aria-hidden="true" />
}

async function downloadAttachment(conversationId: string, att: MessageAttachment) {
  const blob = await agentApi.downloadFile(conversationId, 'attachment', att.id)
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = att.name ?? 'download'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(a.href)
}

function SingleFile({ att, onDownload }: { att: MessageAttachment; onDownload: AttachmentDownloadHandler }) {
  return (
    <button type="button" className="att-single" onClick={() => onDownload(att)} title={att.name} aria-label={`下载附件 ${att.name ?? '附件'}`}>
      <span className="att-icon"><FileTypeIcon mime={att.mime_type} /></span>
      <span className="att-name">{att.name ?? '附件'}</span>
      <Download size={12} strokeWidth={1.8} className="att-dl" aria-hidden="true" />
    </button>
  )
}

function MultiFiles({ atts, onDownload }: { atts: MessageAttachment[]; onDownload: AttachmentDownloadHandler }) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  return (
    <div className="att-multi">
      <button
        type="button"
        className="att-toggle"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls={listId}
      >
        {open ? <ChevronUp size={13} strokeWidth={1.8} aria-hidden="true" /> : <ChevronDown size={13} strokeWidth={1.8} aria-hidden="true" />}
        附件 ({atts.length})
      </button>
      {open && (
        <div className="att-list" id={listId} aria-label="消息附件">
          {atts.map((att, i) => (
            <button type="button" key={i} className="att-list-item" onClick={() => onDownload(att)} title={att.name} aria-label={`下载附件 ${att.name ?? '附件'}`}>
              <span className="att-icon"><FileTypeIcon mime={att.mime_type} /></span>
              <span className="att-list-name">{att.name ?? '附件'}</span>
              <Download size={12} strokeWidth={1.8} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function AttachmentBar({ conversationId, attachments }: { conversationId: string; attachments: MessageAttachment[] }) {
  const [downloadError, setDownloadError] = useState<string | null>(null)

  const handleDownload = (attachment: MessageAttachment) => {
    setDownloadError(null)
    void downloadAttachment(conversationId, attachment).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : '附件下载失败，请稍后重试'
      console.error('[downloadAttachment] failed:', err)
      setDownloadError(message)
    })
  }

  if (attachments.length === 0) return null
  return (
    <div className="att-bar" aria-label="消息附件">
      {attachments.length === 1
        ? <SingleFile att={attachments[0]} onDownload={handleDownload} />
        : <MultiFiles atts={attachments} onDownload={handleDownload} />}
      {downloadError && <p className="att-error" role="alert">{downloadError}</p>}
    </div>
  )
}
