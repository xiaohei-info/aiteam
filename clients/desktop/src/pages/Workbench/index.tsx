import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, ChevronRight, Code, Copy, Cpu, ExternalLink, FileImage, FileSpreadsheet, FileText, FolderOpen, FolderSearch, History, Inbox, LayoutDashboard, LoaderCircle, MessageSquare, MonitorOff, Presentation, RefreshCw, Search, TriangleAlert } from 'lucide-react'
import { formatConversationTime } from '../../lib/conversationSummary'
import { useChatStore } from '../../stores/chat'
import { canRevealSolutionFile, loadFredSolutions, loadLocalSolutions, openSolutionFile, readSolutionFile } from './api'
import {
  DEEPSEEK,
  employeeOptions,
  fileTypeLabel,
  FILTER_LABELS,
  filterSolutions,
  matchesSource,
  parseCsv,
  sandboxedHtml,
  SOLUTION_SOURCES,
  sortSolutions,
  svgDataUrl,
  type SolutionFile,
  type SolutionFileContent,
  type SolutionSource,
  type SolutionSummary,
  type SourceFilter,
  type SourceState,
} from './solutions'
import '../../components/Chat/TextMessage.css'
import styles from './index.module.css'

const CARD_FILE_CHIPS = 3

type SourceKey = Exclude<SourceFilter, 'all'>

const SOURCE_DESCRIPTIONS: Record<SourceKey, string> = {
  fred: '本机 Agent 会话中 AI 员工生成的文件',
  claude: '本机 ~/.claude 中 Claude Code CLI 会话写入的文档（只读）',
  claude_desktop: 'Claude 桌面版 Cowork 与 Code 会话写入的文档（只读）',
  codex: '本机 ~/.codex 会话写入的文档（只读）',
  trae: '本机 ~/.trae/cli 中 TRAE CLI 会话写入的文档（只读）',
  qoder: '本机 ~/.qoder 中 Qoder CLI 会话写入的文档（只读）',
  workbuddy: '本机 ~/.workbuddy 会话与 ~/WorkBuddy 任务目录中的文档（只读）',
  deepseek: '任一平台上由 DeepSeek 模型写出的方案，与各来源重复计数',
}

// 来源卡片较窄，提示只放最短的定位信息，完整说明在 title 中。
const SOURCE_HINTS: Record<SourceKey, string> = {
  fred: 'AI 员工产物',
  claude: '~/.claude',
  claude_desktop: 'Cowork / Code',
  codex: '~/.codex',
  trae: '~/.trae/cli',
  qoder: '~/.qoder',
  workbuddy: '~/.workbuddy',
  deepseek: '按模型汇总',
}

interface ContentState {
  key: string
  loading: boolean
  error: string
  data: SolutionFileContent | null
}

type FileAction = 'open' | 'reveal'

const fileKey = (solution: SolutionSummary, file: SolutionFile) => `${solution.key}/${file.id}`

function sourceStatusText(state: SourceState | undefined, loading: boolean, hint: string): string {
  if (loading || !state) return '读取中…'
  if (state.status === 'missing') return '本机未发现记录'
  if (state.status === 'desktop_only') return '仅桌面端可读取'
  if (state.status === 'error') return state.message ?? '读取失败'
  if (state.message) return state.message
  return state.truncated ? '仅扫描最近 300 个会话' : hint
}

function formatTime(value: number | null): string {
  return formatConversationTime(value) || '—'
}

// 方案正文来自本机文件：只放行 http(s) 链接，图片不加载，避免渲染时访问任意地址。
const markdownComponents: Components = {
  a({ href, children }) {
    if (href && /^https?:\/\//i.test(href)) {
      return <a href={href} target="_blank" rel="noopener noreferrer" className="tm-link">{children}</a>
    }
    return <span className={styles.localRef} title={href}>{children}</span>
  },
  img({ alt }) {
    return <span className={styles.localRef}>[图片{alt ? `：${alt}` : ''}]</span>
  },
}

function SolutionMarkdown({ content }: { content: string }) {
  return <div className={`tm-md ${styles.markdown}`}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</ReactMarkdown>
  </div>
}

function SourceBadge({ source }: { source: SourceKey }) {
  return <span className={`${styles.sourceBadge} ${styles[`source_${source}`]}`}>{FILTER_LABELS[source]}</span>
}

function EmployeeAvatar({ solution }: { solution: SolutionSummary }) {
  if (solution.employeeAvatarUrl) return <img className={styles.avatar} src={solution.employeeAvatarUrl} alt="" />
  return <span className={`${styles.avatar} ${styles[`source_${solution.source}`]}`} aria-hidden="true">{solution.employeeName.slice(0, 1).toUpperCase()}</span>
}

function FileIcon({ file, size = 16 }: { file: Pick<SolutionFile, 'name' | 'format'>; size?: number }) {
  const extension = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()
  const props = { size, strokeWidth: 1.8, 'aria-hidden': true } as const
  if (file.format === 'svg') return <FileImage {...props} />
  if (file.format === 'html') return <Code {...props} />
  if (file.format === 'csv' || extension === 'xlsx' || extension === 'xls') return <FileSpreadsheet {...props} />
  if (extension === 'pptx' || extension === 'ppt') return <Presentation {...props} />
  return <FileText {...props} />
}

const kindLabel = (file: SolutionFile) => (file.kind === 'created' ? '新建' : '修改')

export default function Workbench() {
  const navigate = useNavigate()
  const [fredSolutions, setFredSolutions] = useState<SolutionSummary[]>([])
  const [localSolutions, setLocalSolutions] = useState<SolutionSummary[]>([])
  const [states, setStates] = useState<Partial<Record<SolutionSource, SourceState>>>({})
  const [loading, setLoading] = useState({ fred: true, local: true })
  const [source, setSource] = useState<SourceFilter>('all')
  const [employee, setEmployee] = useState('')
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [content, setContent] = useState<ContentState | null>(null)
  const [showSource, setShowSource] = useState(false)
  const [copied, setCopied] = useState(false)
  const [pendingAction, setPendingAction] = useState<FileAction | null>(null)
  const [actionError, setActionError] = useState('')
  const loadSequence = useRef(0)
  const contentSequence = useRef(0)
  const detailRef = useRef<HTMLElement>(null)

  const load = useCallback(() => {
    const request = ++loadSequence.current
    const mergeStates = (next: SourceState[]) => setStates(previous => ({
      ...previous,
      ...Object.fromEntries(next.map(state => [state.source, state])),
    }))
    setLoading({ fred: true, local: true })
    void loadFredSolutions().then(result => {
      if (request !== loadSequence.current) return
      setFredSolutions(result.solutions)
      mergeStates(result.states)
      setLoading(previous => ({ ...previous, fred: false }))
    })
    void loadLocalSolutions().then(result => {
      if (request !== loadSequence.current) return
      setLocalSolutions(result.solutions)
      mergeStates(result.states)
      setLoading(previous => ({ ...previous, local: false }))
    })
  }, [])

  useEffect(() => {
    load()
    return () => {
      loadSequence.current += 1
      contentSequence.current += 1
    }
  }, [load])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const allSolutions = useMemo(() => sortSolutions([...fredSolutions, ...localSolutions]), [fredSolutions, localSolutions])
  const employees = useMemo(() => employeeOptions(allSolutions, source), [allSolutions, source])
  const visible = useMemo(() => filterSolutions(allSolutions, { source, employee, query }), [allSolutions, source, employee, query])
  const selected = useMemo(() => allSolutions.find(solution => solution.key === selectedKey) ?? null, [allSolutions, selectedKey])
  const selectedFile = selected?.files.find(file => file.id === selectedFileId) ?? null
  const fileCount = useMemo(() => allSolutions.reduce((total, solution) => total + solution.files.length, 0), [allSolutions])
  const isLoading = loading.fred || loading.local
  const hasFilters = Boolean(query.trim() || employee || source !== 'all')

  const selectSource = (next: SourceFilter) => {
    setSource(next)
    if (employee && !employeeOptions(allSolutions, next).some(option => option.name === employee)) setEmployee('')
  }

  const clearFilters = () => {
    setSource('all')
    setEmployee('')
    setQuery('')
  }

  const selectFile = async (solution: SolutionSummary, file: SolutionFile) => {
    const key = fileKey(solution, file)
    // 详情栏独立滚动：换方案时回到顶部，同一方案内切换文件保留位置。
    if (solution.key !== selectedKey && detailRef.current) detailRef.current.scrollTop = 0
    setSelectedKey(solution.key)
    setSelectedFileId(file.id)
    setShowSource(false)
    setCopied(false)
    setActionError('')
    const request = ++contentSequence.current
    setContent({ key, loading: true, error: '', data: null })
    try {
      const data = await readSolutionFile(solution, file)
      if (request === contentSequence.current) setContent({ key, loading: false, error: '', data })
    } catch (error) {
      if (request !== contentSequence.current) return
      setContent({ key, loading: false, error: error instanceof Error ? error.message : '文件读取失败', data: null })
    }
  }

  const openInChat = (solution: SolutionSummary) => {
    if (solution.isGroup) {
      useChatStore.getState().setActiveGroupId(solution.id)
      navigate('/group-chat')
    } else {
      navigate(`/chat/${encodeURIComponent(solution.id)}`)
    }
  }

  const copyContent = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const runFileAction = async (action: FileAction) => {
    if (!selected || !selectedFile || pendingAction) return
    setPendingAction(action)
    setActionError('')
    try {
      await openSolutionFile(selected, selectedFile, action === 'reveal')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '文件打开失败')
    } finally {
      setPendingAction(null)
    }
  }

  const sourceCount = (key: SourceKey) => allSolutions.filter(solution => matchesSource(solution, key)).length
  const fileContent = selected && selectedFile && content?.key === fileKey(selected, selectedFile) ? content : null

  return <div className={styles.root}>
    <header className={styles.toolbar}>
      <div>
        <div className={styles.titleRow}><h1>工作台</h1><span className={styles.liveBadge}>本机汇总</span></div>
        <p className={styles.subtitle}>汇总 AI 员工在 Fred、Claude、Codex、TRAE、Qoder、WorkBuddy 对话中生成的方案文件，每份文件只展示最终版本；DeepSeek 按写出文件的模型汇总。本机 Agent 记录只读解析，不读取对话内容、代码改动和工具输出。</p>
      </div>
      <button className={styles.secondaryButton} type="button" onClick={load} disabled={isLoading}>
        <RefreshCw size={14} className={isLoading ? styles.spinner : undefined} />刷新
      </button>
    </header>

    <section className={styles.sources} aria-label="方案来源">
      <button type="button" className={`${styles.sourceCard} ${source === 'all' ? styles.sourceCardActive : ''}`} aria-pressed={source === 'all'} onClick={() => selectSource('all')}>
        <span className={styles.sourceCardTop}><LayoutDashboard size={16} />全部来源</span>
        <strong>{allSolutions.length}<small> 个方案</small></strong>
        <span className={styles.sourceCardHint} title={`${fileCount} 份文件 · ${employees.length} 位员工`}>{isLoading ? '读取中…' : `${fileCount} 份文件`}</span>
      </button>
      {SOLUTION_SOURCES.map(key => {
        const state = states[key]
        const sourceLoading = key === 'fred' ? loading.fred : loading.local
        const unavailable = !sourceLoading && state && state.status !== 'ready'
        const status = sourceStatusText(state, sourceLoading, SOURCE_HINTS[key])
        return <button key={key} type="button" className={`${styles.sourceCard} ${source === key ? styles.sourceCardActive : ''}`} aria-pressed={source === key} onClick={() => selectSource(key)}>
          <span className={styles.sourceCardTop}><SourceBadge source={key} />{unavailable && (state.status === 'error' ? <TriangleAlert size={14} className={styles.warnIcon} /> : <MonitorOff size={14} />)}</span>
          <strong>{sourceLoading ? '—' : sourceCount(key)}<small> 个方案</small></strong>
          <span className={`${styles.sourceCardHint} ${state?.status === 'error' && !sourceLoading ? styles.sourceCardError : ''}`} title={`${status} · ${SOURCE_DESCRIPTIONS[key]}`}>{status}</span>
        </button>
      })}
      <button type="button" className={`${styles.sourceCard} ${source === DEEPSEEK ? styles.sourceCardActive : ''}`} aria-pressed={source === DEEPSEEK} onClick={() => selectSource(DEEPSEEK)}>
        <span className={styles.sourceCardTop}><SourceBadge source={DEEPSEEK} /><Cpu size={14} /></span>
        <strong>{isLoading ? '—' : sourceCount(DEEPSEEK)}<small> 个方案</small></strong>
        <span className={styles.sourceCardHint} title={SOURCE_DESCRIPTIONS.deepseek}>{SOURCE_HINTS.deepseek}</span>
      </button>
    </section>

    <div className={styles.filters} aria-label="方案筛选">
      <label className={styles.searchField}>
        <Search size={16} />
        <input aria-label="搜索方案" type="search" value={query} maxLength={120} onChange={event => setQuery(event.target.value)} placeholder="搜索标题、文件名、需求、员工或工作目录" />
      </label>
      <select aria-label="员工筛选" value={employee} onChange={event => setEmployee(event.target.value)}>
        <option value="">全部员工</option>
        {employees.map(option => <option key={option.name} value={option.name}>{option.name}（{option.count}）</option>)}
      </select>
    </div>
    <div className={styles.resultsHeading}>
      <span>{hasFilters ? '筛选结果' : '全部方案'} · {visible.length} 个</span>
      {hasFilters && <button type="button" onClick={clearFilters}>清除筛选</button>}
      {isLoading && allSolutions.length > 0 && <small role="status">正在更新…</small>}
    </div>

    <div className={styles.layout}>
      <section className={styles.list} aria-label="方案列表" aria-busy={isLoading}>
        {isLoading && !visible.length && <div className={styles.emptyState} role="status"><LoaderCircle className={styles.spinner} size={24} />正在读取各 Agent 生成的文件…</div>}
        {!isLoading && !visible.length && <div className={styles.emptyState}>
          <Inbox size={40} />
          <strong>{hasFilters ? '没有匹配的方案' : '还没有生成方案文件的对话'}</strong>
          <span>{hasFilters ? '试试其他关键词，或清除筛选条件。' : 'AI 员工在 Fred、Claude、Codex、TRAE、Qoder、WorkBuddy 的对话中生成 Markdown、Word、PPT、HTML 等方案文件后，会出现在这里。'}</span>
          {hasFilters && <button type="button" onClick={clearFilters}>清除筛选</button>}
        </div>}
        {visible.map(solution => {
          const latest = solution.files[0]
          const task = latest.task && latest.task !== solution.title ? latest.task : null
          return <button type="button" key={solution.key} className={`${styles.card} ${selectedKey === solution.key ? styles.cardSelected : ''}`} aria-pressed={selectedKey === solution.key} onClick={() => void selectFile(solution, latest)}>
            <span className={styles.cardTop}>
              <EmployeeAvatar solution={solution} />
              <span className={styles.cardEmployee}>{solution.employeeName}</span>
              <SourceBadge source={solution.source} />
              <ChevronRight size={16} />
            </span>
            <strong>{solution.title}</strong>
            {task && <span className={styles.cardPreview}>{task}</span>}
            <span className={styles.cardFiles}>
              {solution.files.slice(0, CARD_FILE_CHIPS).map(file => <span key={file.id} className={styles.fileChip} title={file.path ?? file.name}><FileIcon file={file} size={12} />{file.name}</span>)}
              {solution.files.length > CARD_FILE_CHIPS && <span className={styles.fileChipMore}>+{solution.files.length - CARD_FILE_CHIPS}</span>}
            </span>
            <span className={styles.cardMeta}>
              <span>{formatTime(solution.updatedAt)}</span>
              <span>{solution.files.length} 份文件</span>
              {solution.isGroup && <span>群聊</span>}
              {solution.models.length > 0 && <span className={styles.cardTag} title={solution.models.join('、')}><Cpu size={12} />{solution.models.join('、')}</span>}
              {solution.workspace && <span className={styles.cardTag} title={solution.workspace}><FolderOpen size={12} />{solution.workspace}</span>}
            </span>
          </button>
        })}
      </section>

      <section ref={detailRef} className={styles.detail} aria-label="方案详情" aria-busy={fileContent?.loading}>
        {!selected ? <div className={styles.detailPlaceholder}><LayoutDashboard size={28} /><span>选择左侧方案，查看 AI 员工生成的文件。</span></div> : <div className={styles.detailPanel}>
          <div className={styles.detailHeader}>
            <div>
              <span className={styles.detailEyebrow}><SourceBadge source={selected.source} />{selected.employeeName}</span>
              <h2>{selected.title}</h2>
            </div>
            {selected.source === 'fred' && <button className={styles.secondaryButton} type="button" onClick={() => openInChat(selected)}><MessageSquare size={14} />打开会话</button>}
          </div>
          <div className={styles.detailMeta}>
            <div><span>最近更新</span><strong>{formatTime(selected.updatedAt)}</strong></div>
            <div><span>模型</span><strong>{selected.models.length ? selected.models.join('、') : selected.model ?? '未记录'}</strong></div>
            <div><span>{selected.source === 'fred' ? '会话类型' : '工作目录'}</span><strong>{selected.source === 'fred' ? (selected.isGroup ? '群聊' : '单聊') : selected.workspace ?? '未记录'}</strong></div>
          </div>

          <div className={styles.sectionHeading}><h3>方案文件</h3><span>{selected.files.length} 份 · 最近修改在前</span></div>
          {selected.files.length > 1 && <div className={styles.fileTabs}>
            {selected.files.map(file => <button type="button" key={file.id} className={`${styles.fileTab} ${file.id === selectedFile?.id ? styles.fileTabActive : ''}`} aria-pressed={file.id === selectedFile?.id} onClick={() => void selectFile(selected, file)}>
              <FileIcon file={file} />
              <span className={styles.fileTabName} title={file.path ?? file.name}>{file.name}</span>
              <span className={styles.fileTabMeta}>{fileTypeLabel(file)} · {kindLabel(file)} · {formatTime(file.changedAt)}</span>
            </button>)}
          </div>}

          {selectedFile
            ? <FilePanel
                solution={selected}
                file={selectedFile}
                content={fileContent}
                showSource={showSource}
                copied={copied}
                pendingAction={pendingAction}
                actionError={actionError}
                onToggleSource={setShowSource}
                onCopy={text => void copyContent(text)}
                onAction={action => void runFileAction(action)}
                onRetry={() => void selectFile(selected, selectedFile)}
              />
            : <p className={styles.hint}>该文件已不在最新列表中，请选择其他文件。</p>}
        </div>}
      </section>
    </div>
  </div>
}

function FilePanel({ solution, file, content, showSource, copied, pendingAction, actionError, onToggleSource, onCopy, onAction, onRetry }: {
  solution: SolutionSummary
  file: SolutionFile
  content: ContentState | null
  showSource: boolean
  copied: boolean
  pendingAction: FileAction | null
  actionError: string
  onToggleSource: (showSource: boolean) => void
  onCopy: (text: string) => void
  onAction: (action: FileAction) => void
  onRetry: () => void
}) {
  const text = content?.data?.text ?? null
  const canToggle = text !== null && file.format !== 'text'
  return <article className={styles.filePanel}>
    <div className={styles.fileHeader}>
      <span className={styles.fileIcon}><FileIcon file={file} size={18} /></span>
      <div className={styles.fileTitle}>
        <strong>{file.name}</strong>
        <span title={file.path ?? undefined}>{file.path ?? `${fileTypeLabel(file)} · Fred 会话产物`}</span>
      </div>
      <div className={styles.fileActions}>
        {text !== null && <button type="button" className={styles.smallButton} onClick={() => onCopy(text)} aria-label={`复制 ${file.name} 的内容`}>
          {copied ? <><Check size={13} />已复制</> : <><Copy size={13} />复制</>}
        </button>}
        {file.exists && <button type="button" className={styles.smallButton} disabled={pendingAction !== null} onClick={() => onAction('open')}>
          {pendingAction === 'open' ? <LoaderCircle size={13} className={styles.spinner} /> : <ExternalLink size={13} />}打开
        </button>}
        {canRevealSolutionFile(solution, file) && <button type="button" className={styles.smallButton} disabled={pendingAction !== null} onClick={() => onAction('reveal')}>
          {pendingAction === 'reveal' ? <LoaderCircle size={13} className={styles.spinner} /> : <FolderSearch size={13} />}在文件夹中显示
        </button>}
      </div>
    </div>
    <div className={styles.fileFacts}>
      <span>{fileTypeLabel(file)}</span>
      <span>{solution.source === 'fred' ? '生成' : kindLabel(file)}于 {formatTime(file.changedAt)}</span>
      {file.model && <span>{file.model}</span>}
      {canToggle && <span className={styles.viewToggle} role="group" aria-label="显示方式">
        <button type="button" aria-pressed={!showSource} onClick={() => onToggleSource(false)}>预览</button>
        <button type="button" aria-pressed={showSource} onClick={() => onToggleSource(true)}>源码</button>
      </span>}
    </div>
    {file.task && <p className={styles.taskPrompt} title={file.task}><span>需求</span>{file.task}</p>}
    {actionError && <div className={styles.errorBanner} role="alert"><TriangleAlert size={15} /><span>{actionError}</span></div>}
    {content?.data?.fromRecord && <p className={styles.recordNotice}><History size={14} />原文件已删除或移动，以下是根据会话记录还原的最终内容。</p>}
    {(!content || content.loading) && <div className={styles.detailPlaceholder} role="status"><LoaderCircle className={styles.spinner} size={24} /><span>正在读取文件内容…</span></div>}
    {content?.error && <div className={styles.errorBanner} role="alert">
      <TriangleAlert size={15} /><span>{content.error}</span>
      <button type="button" onClick={onRetry}>重试</button>
    </div>}
    {content?.data && <div className={styles.previewBody}><FilePreview file={file} text={text} showSource={showSource} /></div>}
  </article>
}

function FilePreview({ file, text, showSource }: { file: SolutionFile; text: string | null; showSource: boolean }) {
  if (text === null) {
    return <div className={styles.documentPlaceholder}>
      <FileIcon file={file} size={28} />
      <strong>{fileTypeLabel(file)} 文件</strong>
      <span>该类型不支持在页面内预览，请点击「打开」用默认应用查看。</span>
    </div>
  }
  if (!text.trim()) return <p className={styles.hint}>文件内容为空。</p>
  if (showSource) return <pre className={styles.plainText}>{text}</pre>
  switch (file.format) {
    case 'markdown':
      return <SolutionMarkdown content={text} />
    // 空 sandbox：不执行脚本、不共享来源；sandboxedHtml 再禁止加载外部资源。
    case 'html':
      return <iframe className={styles.htmlFrame} sandbox="" srcDoc={sandboxedHtml(text)} title={`${file.name} 预览`} />
    case 'svg':
      return <div className={styles.svgFrame}><img src={svgDataUrl(text)} alt={file.name} /></div>
    case 'csv':
      return <CsvTable text={text} />
    default:
      return <pre className={styles.plainText}>{text}</pre>
  }
}

const CSV_PREVIEW_ROWS = 200

function CsvTable({ text }: { text: string }) {
  const { rows, truncated } = useMemo(() => parseCsv(text, CSV_PREVIEW_ROWS), [text])
  if (rows.length === 0) return <p className={styles.hint}>文件内容为空。</p>
  const [header, ...body] = rows
  return <div className={styles.csvWrap}>
    <table className={styles.csvTable}>
      <thead><tr>{header.map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead>
      <tbody>{body.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody>
    </table>
    {truncated && <p className={styles.hint}>仅显示前 {CSV_PREVIEW_ROWS} 行，完整内容请用默认应用打开。</p>}
  </div>
}
