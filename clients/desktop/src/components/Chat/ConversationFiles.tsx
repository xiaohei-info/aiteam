import { useEffect, useRef, useState } from 'react'
import { Archive, ChevronRight, FileAudio, FileImage, FileText, FileVideo, Folder, FolderSearch, LoaderCircle } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import './ConversationFiles.css'
import { agentApi } from '../../api/agent'
import type { LocalFileMetadata } from '../../api/agent/types'
import { isTauriRuntime } from '../../api/agent/runtime'
import { formatFileSize, type CachedFile } from '../../lib/fileCache'
import { buildFileTree, type FileTreeNode } from '../../lib/fileTree'
import { refreshWhenRunsSettle } from '../../lib/settledRefresh'

type FileKind = LocalFileMetadata['kind']

function FileIcon({ mime }: { mime: string }) {
  if (mime.startsWith('image/')) return <FileImage size={18} strokeWidth={1.7} aria-hidden="true" />
  if (mime.startsWith('audio/')) return <FileAudio size={18} strokeWidth={1.7} aria-hidden="true" />
  if (mime.startsWith('video/')) return <FileVideo size={18} strokeWidth={1.7} aria-hidden="true" />
  if (mime.includes('zip') || mime.includes('compressed')) return <Archive size={18} strokeWidth={1.7} aria-hidden="true" />
  return <FileText size={18} strokeWidth={1.7} aria-hidden="true" />
}

const groupLabels: Record<FileKind, string> = {
  artifact: '生成文件',
  attachment: '上传附件',
}

export default function ConversationFiles({ conversationId }: { conversationId: string }) {
  const [files, setFiles] = useState<LocalFileMetadata[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const cachedPaths = useRef(new Map<string, string>())

  useEffect(() => {
    let cancelled = false
    cachedPaths.current.clear()
    setFiles([]); setError(''); setLoading(true)
    Promise.all([agentApi.listFiles(conversationId, 'attachment'), agentApi.listFiles(conversationId, 'artifact')])
      .then(results => { if (!cancelled) setFiles(results.flatMap(result => result.files)) })
      .catch(() => { if (!cancelled) setError('会话文件读取失败') })
      .finally(() => { if (!cancelled) setLoading(false) })
    // 打开期间员工可能又生成了文件；运行结束后静默刷新，读取失败时保留当前列表。
    const stopRefreshing = refreshWhenRunsSettle({
      subscribe: onEvent => {
        const subscription = agentApi.subscribeEvents({ conversationId, onEvent })
        return () => subscription.close()
      },
      isPrompting: async () => (await agentApi.getConversationState(conversationId)).prompting,
      reload: async () => {
        const results = await Promise.all([agentApi.listFiles(conversationId, 'attachment'), agentApi.listFiles(conversationId, 'artifact')])
        if (!cancelled) { setFiles(results.flatMap(result => result.files)); setError('') }
      },
    })
    return () => { cancelled = true; stopRefreshing() }
  }, [conversationId])

  const cacheForNative = async (file: LocalFileMetadata): Promise<string> => {
    const key = `${file.kind}:${file.id}`
    const existing = cachedPaths.current.get(key)
    if (existing) return existing
    const blob = await agentApi.downloadFile(conversationId, file.kind, file.id)
    const cached = await invoke<CachedFile>('cache_conversation_file', {
      userId: 'conversation-files',
      chatId: conversationId,
      filename: file.filename,
      mimeType: file.mime_type,
      data: Array.from(new Uint8Array(await blob.arrayBuffer())),
      cacheKey: key,
    })
    cachedPaths.current.set(key, cached.rel_path)
    return cached.rel_path
  }

  const handleOpen = async (file: LocalFileMetadata) => {
    if (pendingAction) return
    const key = `${file.kind}:${file.id}`
    setPendingAction(`open:${key}`); setError('')
    try {
      if (isTauriRuntime()) {
        const relPath = await cacheForNative(file)
        await invoke('open_cached_file', { relPath })
      } else {
        const blob = await agentApi.downloadFile(conversationId, file.kind, file.id)
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'
        document.body.appendChild(link); link.click(); link.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
    } catch { setError('文件打开失败，请重试') }
    finally { setPendingAction(null) }
  }

  const handleReveal = async (file: LocalFileMetadata) => {
    if (pendingAction) return
    const key = `${file.kind}:${file.id}`
    setPendingAction(`reveal:${key}`); setError('')
    try {
      const relPath = await cacheForNative(file)
      await invoke('show_in_folder', { relPath })
    } catch { setError('无法在 Finder 中显示文件，请重试') }
    finally { setPendingAction(null) }
  }

  const groups = (['artifact', 'attachment'] as const)
    .map(kind => ({ kind, files: files.filter(file => file.kind === kind) }))
    .filter(group => group.files.length > 0)

  const renderFile = (file: LocalFileMetadata) => {
    const key = `${file.kind}:${file.id}`
    const label = file.path ?? file.filename
    return <div className="conversation-file-row" key={key}>
      <button type="button" className="conversation-file-main" onClick={() => void handleOpen(file)} disabled={pendingAction !== null} title={`打开 ${label}`}>
        <span className="conversation-file-icon"><FileIcon mime={file.mime_type} /></span>
        <span className="conversation-file-info"><strong>{file.filename}</strong><small>{formatFileSize(file.byte_size)} · {file.mime_type || '未知类型'}</small></span>
      </button>
      {isTauriRuntime() && <button type="button" className="conversation-file-reveal" onClick={() => void handleReveal(file)} disabled={pendingAction !== null} title="在 Finder 中显示" aria-label={`在 Finder 中显示 ${label}`}>
        {pendingAction === `reveal:${key}` ? <LoaderCircle size={15} className="conversation-files-spinner" /> : <FolderSearch size={15} />}
        <span>Finder</span>
      </button>}
      {pendingAction === `open:${key}` && <LoaderCircle size={15} className="conversation-file-pending conversation-files-spinner" aria-label="正在打开" />}
    </div>
  }

  // A folder that is alone at its level opens by itself, so one folder never hides everything.
  const renderNodes = (nodes: FileTreeNode<LocalFileMetadata>[]) => nodes.map(node => node.type === 'file'
    ? renderFile(node.file)
    : <details className="conversation-file-folder" key={`folder:${node.path}`} open={nodes.length === 1}>
      <summary title={node.path}>
        <ChevronRight size={14} className="conversation-file-folder-chevron" aria-hidden="true" />
        <Folder size={15} strokeWidth={1.7} aria-hidden="true" />
        <span className="conversation-file-folder-name">{node.name}</span>
        <span className="conversation-file-folder-count">{node.count}</span>
      </summary>
      <div className="conversation-file-folder-items">{renderNodes(node.children)}</div>
    </details>)

  return <section className="conversation-files" aria-label="会话附件与产物">
    <div className="conversation-files-head">
      <div>
        <h3>附件与产物</h3>
        <p>点击文件打开，或在 Finder 中定位</p>
      </div>
      {!loading && !error && <span className="conversation-files-count">{files.length} 个文件</span>}
    </div>
    {loading && <div className="conversation-files-state" role="status"><LoaderCircle size={16} className="conversation-files-spinner" />正在读取文件…</div>}
    {error && <p className="conversation-files-error" role="alert">{error}</p>}
    {!loading && !error && files.length === 0 && <div className="conversation-files-state">暂无附件或产物</div>}
    {!loading && !error && groups.length > 0 && <div className="conversation-files-list">
      {groups.map(({ kind, files: groupFiles }) => <section className="conversation-file-group" key={kind}>
        <div className="conversation-file-group-head"><h4>{groupLabels[kind]}</h4><span>{groupFiles.length}</span></div>
        <div className="conversation-file-items">{renderNodes(buildFileTree(groupFiles))}</div>
      </section>)}
    </div>}
  </section>
}
