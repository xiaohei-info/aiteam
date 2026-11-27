import { useId, useState } from 'react'
import { FileText, Music2, Video, ChevronDown, ChevronUp, Download } from 'lucide-react'
import './AttachmentBar.css'
import type { MessageAttachment } from '../../stores/chat'
import { agentApi } from '../../api/agent'
import { attachmentRefPath } from '../../lib/attachmentRefPaths'
import { invokeWithFileAccess } from '../../lib/fileAccess'
import { fileAccessErrorKind } from '../../lib/fileAccessPolicy'

type AttachmentDownloadHandler = (attachment: MessageAttachment) => void

/**
 * 打开本机附件；应用内打不开的类型（Excel、视频、压缩包…）退化为在文件夹里定位。
 * 打不开的原因不再被丢掉：授权、系统权限、文件不在了、类型不支持是四件不同的事。
 */
async function openLocalAttachment(path: string, name: string): Promise<'opened' | 'revealed'> {
  try {
    await invokeWithFileAccess<void>('open_local_file', { path }, path)
    return 'opened'
  } catch (error) {
    console.error('[AttachmentBar] open local attachment failed:', error)
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
    const kind = fileAccessErrorKind(error)
    if (kind === 'authorization') throw new Error(`打开 ${name} 需要重新授权访问它所在的文件夹。`)
    if (kind === 'system') throw new Error(`系统不允许访问 ${name}，请在系统设置里给本应用文件访问权限。`)
    if (/No such file|not found|os error 2|不存在/i.test(message)) throw new Error(`${name} 已被移动或删除。`)
    // 剩下的主要是「这类文件不支持应用内打开」：文件还在，带用户去它所在的文件夹。
    try {
      await invokeWithFileAccess<void>('reveal_local_file', { path }, path)
      return 'revealed'
    } catch (revealError) {
      console.error('[AttachmentBar] reveal local attachment failed:', revealError)
      throw new Error(`无法打开 ${name}，也无法在文件夹里定位它。`)
    }
  }
}

function FileTypeIcon({ mime }: { mime?: string }) {
  if (!mime) return <FileText size={14} strokeWidth={1.8} aria-hidden="true" />
  if (mime.startsWith('video/')) return <Video size={14} strokeWidth={1.8} aria-hidden="true" />
  if (mime.startsWith('audio/')) return <Music2 size={14} strokeWidth={1.8} aria-hidden="true" />
  return <FileText size={14} strokeWidth={1.8} aria-hidden="true" />
}

/** 返回非空字符串时是一条给用户的说明（不是错误）。 */
async function downloadAttachment(conversationId: string, att: MessageAttachment): Promise<string> {
  // Attached by path: the Agent holds no copy, so open the file where it is on this machine.
  const name = att.name ?? '附件'
  const path = att.path ?? (att.id.startsWith('ref-') ? await attachmentRefPath(conversationId, att.id) : undefined)
  if (path) {
    const outcome = await openLocalAttachment(path, name)
    return outcome === 'revealed' ? `${name} 不支持在应用内直接打开，已在文件夹里定位它。` : ''
  }
  if (att.id.startsWith('ref-')) throw new Error(`${name} 是按本机位置发送的，这台电脑上没有记录它的位置，请到原文件夹打开。`)
  const blob = await agentApi.downloadFile(conversationId, 'attachment', att.id)
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = att.name ?? 'download'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(a.href)
  return ''
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
  const [notice, setNotice] = useState<string | null>(null)

  const handleDownload = (attachment: MessageAttachment) => {
    setDownloadError(null)
    setNotice(null)
    void downloadAttachment(conversationId, attachment).then((info) => {
      if (info) setNotice(info)
    }, (err: unknown) => {
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
      {notice && <p className="att-notice" role="status">{notice}</p>}
    </div>
  )
}
