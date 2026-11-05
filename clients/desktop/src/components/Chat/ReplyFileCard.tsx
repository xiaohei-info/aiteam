import { useState } from 'react'
import { FileText, FolderSearch, LoaderCircle } from 'lucide-react'
import './ReplyFileCard.css'
import type { ReplyFile } from '../../api/agent/types'
import { isTauriRuntime } from '../../api/agent/runtime'
import { openArtifact, revealArtifact } from '../../lib/artifactOpen'

const MARKDOWN = 'text/markdown'

/** File card under a long reply whose full text was saved as a Markdown artifact. */
export default function ReplyFileCard({ conversationId, file }: { conversationId: string; file: ReplyFile }) {
  const [pending, setPending] = useState<'open' | 'reveal' | null>(null)
  const [error, setError] = useState('')
  const ref = { id: file.id, filename: file.filename, mime_type: MARKDOWN }

  const run = async (action: 'open' | 'reveal') => {
    if (pending) return
    setPending(action); setError('')
    try {
      if (action === 'open') await openArtifact(conversationId, ref)
      else await revealArtifact(conversationId, ref)
    } catch {
      setError(action === 'open' ? '抱歉，文件没能打开，请稍后再试。' : '抱歉，没能在 Finder 中显示文件，请稍后再试。')
    } finally { setPending(null) }
  }

  return <div className="reply-file-card">
    <button type="button" className="reply-file-main" onClick={() => void run('open')} disabled={pending !== null} title={`打开 ${file.path ?? file.filename}`}>
      <span className="reply-file-icon">{pending === 'open' ? <LoaderCircle size={18} className="reply-file-spinner" aria-label="正在打开" /> : <FileText size={18} strokeWidth={1.7} aria-hidden="true" />}</span>
      <span className="reply-file-info">
        <strong>{file.filename}</strong>
        <small>回复较长，全文 {file.chars.toLocaleString('zh-CN')} 字已存成文件，点击打开</small>
      </span>
    </button>
    {isTauriRuntime() && <button type="button" className="reply-file-reveal" onClick={() => void run('reveal')} disabled={pending !== null} title="在 Finder 中显示" aria-label={`在 Finder 中显示 ${file.filename}`}>
      {pending === 'reveal' ? <LoaderCircle size={15} className="reply-file-spinner" /> : <FolderSearch size={15} aria-hidden="true" />}
      <span>Finder</span>
    </button>}
    {error && <p className="reply-file-error" role="alert">{error}</p>}
  </div>
}
