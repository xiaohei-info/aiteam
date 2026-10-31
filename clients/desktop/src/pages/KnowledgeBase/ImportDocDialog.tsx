import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileText, LoaderCircle, UploadCloud, X } from 'lucide-react'
import '../../components/Chat/CreateAgentDialog.css'
import './KnowledgeBaseDialog.css'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { fetchKnowledgeBases, uploadKnowledgeFile } from './api'
import { knowledgeBaseSourceLabel, uploadKnowledgeBatch } from './knowledgeService'
import type { KnowledgeBase } from './types'

interface Props { onClose: () => void; onUploaded?: () => void }

export default function ImportDocDialog({ onClose, onUploaded }: Props) {
  const [bases, setBases] = useState<KnowledgeBase[]>([])
  const [kbId, setKbId] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [feedback, setFeedback] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)
  const busyRef = useRef(false)
  const dialogRef = useDialogFocus<HTMLDivElement>()
  const selected = bases.find(base => base.id === kbId)

  useEffect(() => {
    let active = true
    fetchKnowledgeBases(messages => { if (active) setWarnings(messages) }).then(items => {
      if (!active) return
      setBases(items); setKbId(items[0]?.id ?? '')
    }).catch(error => { if (active) setFeedback(error instanceof Error ? error.message : '知识库加载失败') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); if (!busyRef.current) onClose() }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  function addFiles(next: FileList | null) {
    if (!next || busyRef.current) return
    // FileList is live: snapshot before the input is reset or the drop event ends.
    const selectedFiles = Array.from(next)
    setFiles(current => {
      const result = [...current]
      for (const file of selectedFiles) {
        if (!result.some(item => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) result.push(file)
      }
      return result
    })
    setFeedback('')
  }
  async function upload() {
    if (!selected || !files.length || busyRef.current) return
    busyRef.current = true; setBusy(true)
    try {
      const result = await uploadKnowledgeBatch(files.map(file => ({ file })),
        ({ file }) => uploadKnowledgeFile(selected.id, file, undefined, undefined, undefined, selected.source),
        (index, total) => setFeedback(`正在上传 ${index}/${total}：${files[index - 1].name}`))
      setFiles(result.failed.map(({ item }) => item.file))
      setFeedback(result.failed.length
        ? `已提交 ${result.uploaded.length} 个，失败 ${result.failed.length} 个；重试仅提交失败文件。${result.failed.map(({ item, error }) => `${item.file.name}：${error}`).join('；')}`
        : `已提交 ${result.uploaded.length} 个文件，请在知识库详情查看解析与入库状态。`)
      if (result.uploaded.length) onUploaded?.()
    } finally { busyRef.current = false; setBusy(false) }
  }

  return createPortal(<div className="cad-overlay" onClick={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <div ref={dialogRef} className="cad" style={{ width: 520 }} role="dialog" aria-modal="true" aria-labelledby="import-document-title" tabIndex={-1}>
      <div className="cad-header"><div className="cad-header-icon"><UploadCloud size={20} /></div><div><div className="cad-header-title" id="import-document-title">上传知识文档</div><div className="cad-header-sub">文件将上传到所选企业或个人知识库</div></div></div>
      <div className="cad-fields">
        <label className="cad-field"><span className="cad-label">目标知识库</span><select className="cad-select" value={kbId} onChange={event => setKbId(event.target.value)} disabled={busy || loading}>
          {!bases.length && <option value="">{loading ? '加载中…' : '暂无知识库，请先连接企业知识库或添加个人知识库服务'}</option>}
          {bases.map(base => <option key={base.id} value={base.id}>{knowledgeBaseSourceLabel(base)} · {base.name}</option>)}
        </select></label>
        <label className={`kbd-upload-zone ${dragging ? 'dragging' : ''} ${busy ? 'disabled' : ''}`}
          onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true) }}
          onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files) }}>
          <UploadCloud size={30} /><strong>点击选择或拖入文件</strong><span>{selected?.source === 'enterprise' ? 'Manager：单文件最大 4 MiB' : '个人知识库服务：格式与大小以服务端支持为准'}</span>
          <input aria-label="选择上传文档" type="file" multiple disabled={busy || !selected} onChange={event => { addFiles(event.target.files); event.target.value = '' }} />
        </label>
        {!!files.length && <div className="kbd-file-list">{files.map((file, index) => <div className="kbd-file-row" key={`${file.name}-${file.lastModified}-${index}`}><FileText size={15} /><span>{file.name}</span><small>{(file.size / 1024).toFixed(1)} KB</small><button type="button" disabled={busy} aria-label={`移除 ${file.name}`} onClick={() => setFiles(current => current.filter((_, i) => i !== index))}><X size={13} /></button></div>)}</div>}
        {warnings.map(message => <p key={message} className="kbd-service-notice">{message}</p>)}
        {feedback && <p className="kbd-service-notice" role="status" aria-live="polite">{feedback}</p>}
      </div>
      <div className="cad-footer"><button type="button" className="cad-btn-cancel" disabled={busy} onClick={onClose}>关闭</button><button type="button" className="cad-btn-submit" disabled={busy || !selected || !files.length} onClick={() => void upload()}>{busy ? <LoaderCircle size={14} /> : <UploadCloud size={14} />}{busy ? '上传中…' : '开始上传'}</button></div>
    </div>
  </div>, document.body)
}
