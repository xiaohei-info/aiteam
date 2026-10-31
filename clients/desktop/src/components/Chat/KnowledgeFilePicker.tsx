import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ChevronLeft, ChevronRight, FileText } from 'lucide-react'
import { ChatDialog } from './ChatDialog'
import { readLocalScanCache } from '../../pages/KnowledgeBase/localKnowledgeStore'
import type { ScannedKnowledgeFile } from '../../pages/KnowledgeBase/types'
import { formatFileSize, type CachedFile } from '../../lib/fileCache'
import { KNOWLEDGE_FILE_CATEGORIES, buildKnowledgeFileIndex, filterKnowledgeFiles, paginateKnowledgeFiles, type KnowledgeFileCategory } from '../../lib/knowledgeFilePicker'
import { useAgentAuthStore } from '../../stores/agentAuth'

interface KnowledgeFilePickerProps { convId: string; onSelect: (file: CachedFile) => void; onClose: () => void }

export function KnowledgeFilePicker({ convId, onSelect, onClose }: KnowledgeFilePickerProps) {
  const mounted = useRef(true)
  const listRef = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState(0)
  const [files, setFiles] = useState<ScannedKnowledgeFile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<KnowledgeFileCategory>('全部')
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const userId = useAgentAuthStore(state => state.account) ?? 'guest'
  useEffect(() => {
    mounted.current = true
    let cancelled = false
    readLocalScanCache().then(cache => { if (!cancelled) setFiles(cache?.files ?? []) })
      .catch(() => { if (!cancelled) setError('知识文件读取失败，请关闭后重试') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; mounted.current = false }
  }, [])
  const handleSelect = async (file: ScannedKnowledgeFile) => {
    setPending(true); setError('')
    try {
      const cached = await invoke<CachedFile>('cache_file', { userId, chatId: convId || 'new-session', srcPath: file.path })
      if (mounted.current) { onSelect(cached); onClose() }
    } catch { setError('读取文件失败，文件可能已移动或无权访问，请重新扫描知识库') }
    finally { setPending(false) }
  }
  const index = useMemo(() => buildKnowledgeFileIndex(files), [files])
  const visible = useMemo(() => filterKnowledgeFiles(index, selected, query), [index, selected, query])
  const currentPage = paginateKnowledgeFiles(visible, page)
  const handlePage = (next: number) => {
    setPage(next)
    if (listRef.current) listRef.current.scrollTop = 0
  }
  const handleCategory = (category: KnowledgeFileCategory) => {
    setSelected(category)
    handlePage(0)
  }

  return <ChatDialog title="从知识库选择文件" onClose={() => { if (!pending) onClose() }}>
    <p className="chat-tools-note">本地知识文件可作为附件发送。企业知识库接口暂未开放。</p>
    <input className="chat-tools-search" aria-label="搜索知识文件" placeholder="搜索文件名称" value={query} onChange={event => { setQuery(event.target.value); handlePage(0) }} />
    <div className="chat-knowledge-layout">
      <section className="chat-knowledge-categories" aria-label="文件分类">
        <h3 className="chat-knowledge-panel-title">文件分类</h3>
        <nav aria-label="选择文件分类">
          {KNOWLEDGE_FILE_CATEGORIES.map(item => <button key={item} type="button" className={selected === item ? 'active' : ''} aria-pressed={selected === item} onClick={() => handleCategory(item)}>
            {item}<span>{index[item].length}</span>
          </button>)}
        </nav>
      </section>
      <section className="chat-knowledge-results" aria-label="知识文件列表">
        <h3 className="chat-knowledge-panel-title"><span>{selected === '全部' ? '全部文件' : selected}</span><span>{visible.length.toLocaleString()} 个文件</span></h3>
        <div ref={listRef} className="chat-knowledge-list" aria-busy={loading || pending}>
          {loading ? <p role="status">正在读取知识文件…</p> : visible.length === 0 ? <p>{files.length === 0 ? '暂无本地知识文件，请先在知识库授权目录并扫描。' : '没有匹配的文件'}</p> : currentPage.files.map(({ file, category }) => <button type="button" key={file.path} disabled={pending} onClick={() => void handleSelect(file)}>
            <FileText size={18} aria-hidden="true" /><span><strong>{file.name}</strong><small>{category} · {formatFileSize(file.size)}</small></span>
          </button>)}
        </div>
        {!loading && visible.length > 0 && <div className="chat-knowledge-pagination">
          <span role="status">第 {currentPage.page + 1} / {currentPage.pageCount} 页</span>
          <div>
            <button type="button" disabled={pending || currentPage.page === 0} onClick={() => handlePage(currentPage.page - 1)}><ChevronLeft size={14} aria-hidden="true" />上一页</button>
            <button type="button" disabled={pending || currentPage.page + 1 >= currentPage.pageCount} onClick={() => handlePage(currentPage.page + 1)}>下一页<ChevronRight size={14} aria-hidden="true" /></button>
          </div>
        </div>}
      </section>
    </div>
    {pending && <p role="status">正在添加附件…</p>}
    {error && <p role="alert">{error}</p>}
  </ChatDialog>
}
