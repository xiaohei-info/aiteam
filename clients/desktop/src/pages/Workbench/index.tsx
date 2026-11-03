import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, ChevronDown, ChevronRight, Code, Copy, Cpu, Download, ExternalLink, FileImage, FileSpreadsheet, FileText, Folder, FolderOpen, FolderSearch, Inbox, LayoutDashboard, LoaderCircle, MessageSquare, MonitorOff, Play, Presentation, RefreshCw, Search, ShieldAlert, Square, Terminal, TriangleAlert } from 'lucide-react'
import { isTauri } from '../../api/agent/runtime'
import { ChatDialog } from '../../components/Chat/ChatDialog'
import { formatConversationTime } from '../../lib/conversationSummary'
import { useChatStore } from '../../stores/chat'
import { detectRunners, getDependencySource, loadFredProjects, loadLocalProjects, openProjectFile, projectRunStatus, readProjectFile, setDependencySource, startProject, stopProject } from './api'
import { parseCsv, sandboxedHtml, svgDataUrl } from './preview'
import {
  buildFileTree,
  DEEPSEEK,
  DEFAULT_DEPENDENCY_SOURCE,
  dependencySourceLabel,
  NPM_MIRROR,
  PYPI_MIRROR,
  sourceUrlError,
  defaultFile,
  employeeOptions,
  extensionOf,
  fileNodeKey,
  fileTypeLabel,
  FILTER_LABELS,
  filterProjects,
  formatSize,
  htmlPageToRun,
  isExpanded,
  matchesSource,
  needsPolling,
  partKey,
  PROJECT_SOURCES,
  projectRunnerKind,
  RUNNER_LABELS,
  runnerDetail,
  runnableUnitCount,
  runPhaseText,
  runStatusFromOutcome,
  sortProjects,
  unitKey,
  unitRevealFile,
  visibleTreeRows,
  type DependencySource,
  type ProjectFile,
  type ProjectPart,
  type ProjectSource,
  type ProjectSummary,
  type RunStatus,
  type RunUnit,
  type SourceFilter,
  type SourceState,
  type StartOutcome,
} from './projects'
import '../../components/Chat/TextMessage.css'
import styles from './index.module.css'

const CARD_FILE_CHIPS = 3
const RUN_POLL_MS = 1500

type SourceKey = Exclude<SourceFilter, 'all'>

const SOURCE_DESCRIPTIONS: Record<SourceKey, string> = {
  fred: '本机 Agent 会话中 AI 员工工作目录里的项目',
  codex: 'Codex 会话中新建的项目目录（只读识别）',
  claude: 'Claude Code CLI 会话中新建的项目目录（只读识别）',
  claude_desktop: 'Claude 桌面版 Cowork 输出与 Code 会话中新建的项目目录（只读识别）',
  workbuddy: '~/WorkBuddy 下的任务目录（只读识别）',
  deepseek: '任一来源上由 DeepSeek 模型做出的项目，与各来源重复计数',
}

// 来源卡片较窄，提示只放最短的定位信息，完整说明在 title 中。
const SOURCE_HINTS: Record<SourceKey, string> = {
  fred: 'AI 员工项目',
  codex: '~/.codex',
  claude: '~/.claude',
  claude_desktop: 'Cowork / Code',
  workbuddy: '~/WorkBuddy',
  deepseek: '按模型筛选',
}

/** 没有文本内容的文件：不读取，直接提示用系统应用打开。 */
const BINARY_FORMATS = new Set<ProjectFile['format']>(['image', 'document'])
/** 有渲染预览、可切换到源码的格式。 */
const PREVIEW_FORMATS = new Set<ProjectFile['format']>(['markdown', 'html', 'svg', 'csv'])

interface ContentState {
  key: string
  loading: boolean
  error: string
  text: string | null
}

interface SelectedFile {
  part: number
  fileId: string
}

interface ConsentRequest {
  part: ProjectPart
  unit: RunUnit
  projectName: string
  commands: string[]
  cwd: string
  fingerprint: string
}

type FileAction = 'open' | 'reveal'

function sourceStatusText(state: SourceState | undefined, loading: boolean, hint: string): string {
  if (loading || !state) return '读取中…'
  if (state.status === 'missing') return '本机未发现记录'
  if (state.status === 'desktop_only') return '仅桌面端可读取'
  if (state.status === 'error') return state.message ?? '读取失败'
  if (state.message) return state.message
  return state.truncated ? '仅扫描最近的会话' : hint
}

function formatTime(value: number | null): string {
  return formatConversationTime(value) || '—'
}

const errorText = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback)

// 文件正文来自本机：只放行 http(s) 链接，图片不加载，避免渲染时访问任意地址。
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

function ProjectMarkdown({ content }: { content: string }) {
  return <div className={`tm-md ${styles.markdown}`}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</ReactMarkdown>
  </div>
}

function SourceBadge({ source }: { source: SourceKey }) {
  return <span className={`${styles.sourceBadge} ${styles[`source_${source}`]}`}>{FILTER_LABELS[source]}</span>
}

function EmployeeAvatar({ project }: { project: ProjectSummary }) {
  if (project.employeeAvatarUrl) return <img className={styles.avatar} src={project.employeeAvatarUrl} alt="" />
  return <span className={`${styles.avatar} ${styles[`source_${project.source}`]}`} aria-hidden="true">{project.employeeName.slice(0, 1).toUpperCase()}</span>
}

function FileIcon({ file, size = 16 }: { file: Pick<ProjectFile, 'name' | 'format'>; size?: number }) {
  const extension = extensionOf(file.name)
  const props = { size, strokeWidth: 1.8, 'aria-hidden': true } as const
  if (file.format === 'svg' || file.format === 'image') return <FileImage {...props} />
  if (file.format === 'html' || file.format === 'code') return <Code {...props} />
  if (file.format === 'csv' || extension === 'xlsx' || extension === 'xls') return <FileSpreadsheet {...props} />
  if (extension === 'pptx' || extension === 'ppt') return <Presentation {...props} />
  return <FileText {...props} />
}

/** 卡片上展示的文件：最近修改的在前。 */
function recentFiles(project: ProjectSummary, count: number): ProjectFile[] {
  return project.parts
    .flatMap(part => part.files)
    .sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0))
    .slice(0, count)
}

export default function Workbench() {
  const navigate = useNavigate()
  const desktop = isTauri()
  const [fredProjects, setFredProjects] = useState<ProjectSummary[]>([])
  const [localProjects, setLocalProjects] = useState<ProjectSummary[]>([])
  const [states, setStates] = useState<Partial<Record<ProjectSource, SourceState>>>({})
  const [loading, setLoading] = useState({ fred: true, local: true })
  const [source, setSource] = useState<SourceFilter>('all')
  const [employee, setEmployee] = useState('')
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null)
  const [toggledDirs, setToggledDirs] = useState<ReadonlySet<string>>(new Set())
  const [content, setContent] = useState<ContentState | null>(null)
  const [showSource, setShowSource] = useState(false)
  const [copied, setCopied] = useState(false)
  const [pendingAction, setPendingAction] = useState<FileAction | null>(null)
  const [actionError, setActionError] = useState('')
  /** 每个目录（partKey）能单独运行的单元；运行状态、进行中操作和错误按 unitKey 区分。 */
  const [units, setUnits] = useState<Record<string, RunUnit[]>>({})
  const [runs, setRuns] = useState<Record<string, RunStatus>>({})
  const [pendingRun, setPendingRun] = useState<string | null>(null)
  const [runError, setRunError] = useState<{ key: string; message: string } | null>(null)
  const [consent, setConsent] = useState<ConsentRequest | null>(null)
  const [downloadSource, setDownloadSource] = useState<DependencySource>(DEFAULT_DEPENDENCY_SOURCE)
  const [sourceDialog, setSourceDialog] = useState(false)

  useEffect(() => {
    if (desktop) void getDependencySource().then(setDownloadSource)
  }, [desktop])
  const loadSequence = useRef(0)
  const contentSequence = useRef(0)
  const detectGeneration = useRef(0)
  const detecting = useRef(new Set<string>())
  const detailRef = useRef<HTMLElement>(null)

  const load = useCallback(() => {
    const request = ++loadSequence.current
    // 文件可能已变化：重新识别运行方式；正在运行的状态由宿主保留，不清空。
    detectGeneration.current += 1
    detecting.current.clear()
    setUnits({})
    const mergeStates = (next: SourceState[]) => setStates(previous => ({
      ...previous,
      ...Object.fromEntries(next.map(state => [state.source, state])),
    }))
    setLoading({ fred: true, local: true })
    void loadFredProjects().then(result => {
      if (request !== loadSequence.current) return
      setFredProjects(result.projects)
      mergeStates(result.states)
      setLoading(previous => ({ ...previous, fred: false }))
    })
    void loadLocalProjects().then(result => {
      if (request !== loadSequence.current) return
      setLocalProjects(result.projects)
      mergeStates(result.states)
      setLoading(previous => ({ ...previous, local: false }))
    })
  }, [])

  useEffect(() => {
    load()
    return () => {
      loadSequence.current += 1
      contentSequence.current += 1
      detectGeneration.current += 1
    }
  }, [load])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const allProjects = useMemo(() => sortProjects([...fredProjects, ...localProjects]), [fredProjects, localProjects])
  const partsByKey = useMemo(() => new Map(allProjects.flatMap(project => project.parts.map(part => [partKey(part), part] as const))), [allProjects])
  const employees = useMemo(() => employeeOptions(allProjects, source), [allProjects, source])
  const visible = useMemo(() => filterProjects(allProjects, { source, employee, query }), [allProjects, source, employee, query])
  const selected = useMemo(() => allProjects.find(project => project.key === selectedKey) ?? null, [allProjects, selectedKey])
  const selectedPart = selected && selectedFile ? selected.parts[selectedFile.part] ?? null : null
  const selectedProjectFile = selectedPart?.files.find(file => file.id === selectedFile?.fileId) ?? null
  const tree = useMemo(() => (selected ? buildFileTree(selected) : []), [selected])
  const treeRows = useMemo(() => visibleTreeRows(tree, toggledDirs), [tree, toggledDirs])
  const fileCount = useMemo(() => allProjects.reduce((total, project) => total + project.fileCount, 0), [allProjects])
  const isLoading = loading.fred || loading.local
  const hasFilters = Boolean(query.trim() || employee || source !== 'all')

  // 识别每个目录里能单独运行的单元，顺带取应用内已有的运行状态。
  useEffect(() => {
    if (!desktop) return
    const parts = [...partsByKey.entries()]
      .filter(([key]) => !(key in units) && !detecting.current.has(key))
      .map(([, part]) => part)
    if (parts.length === 0) return
    const generation = detectGeneration.current
    for (const part of parts) detecting.current.add(partKey(part))
    void detectRunners(parts, (part, found, statuses) => {
      if (generation !== detectGeneration.current) return
      setUnits(previous => ({ ...previous, [partKey(part)]: found }))
      const known = Object.entries(statuses)
      if (known.length) setRuns(previous => ({ ...previous, ...Object.fromEntries(known.map(([dir, status]) => [unitKey(part, dir), status])) }))
    })
  }, [desktop, partsByKey, units])

  const unitsByKey = useMemo(() => new Map([...partsByKey.values()].flatMap(part =>
    (units[partKey(part)] ?? []).map(unit => [unitKey(part, unit.dir), { part, unit }] as const))), [partsByKey, units])

  // 代码项目运行时轮询状态与日志；地址由宿主识别后自动在浏览器打开。
  const pollSignature = useMemo(
    () => Object.keys(runs).filter(key => needsPolling(unitsByKey.get(key)?.unit.runner, runs[key])).sort().join('\n'),
    [runs, unitsByKey],
  )
  useEffect(() => {
    if (!pollSignature) return
    const keys = pollSignature.split('\n')
    const timer = window.setInterval(() => {
      for (const key of keys) {
        const entry = unitsByKey.get(key)
        if (!entry) continue
        void projectRunStatus(entry.part, entry.unit.dir)
          .then(status => setRuns(previous => ({ ...previous, [key]: status })))
          .catch(() => undefined)
      }
    }, RUN_POLL_MS)
    return () => window.clearInterval(timer)
  }, [pollSignature, unitsByKey])

  const selectSource = (next: SourceFilter) => {
    setSource(next)
    if (employee && !employeeOptions(allProjects, next).some(option => option.name === employee)) setEmployee('')
  }

  const clearFilters = () => {
    setSource('all')
    setEmployee('')
    setQuery('')
  }

  const selectFile = async (project: ProjectSummary, partIndex: number, file: ProjectFile) => {
    const part = project.parts[partIndex]
    const key = fileNodeKey(part, file)
    setSelectedKey(project.key)
    setSelectedFile({ part: partIndex, fileId: file.id })
    setShowSource(false)
    setCopied(false)
    setActionError('')
    const request = ++contentSequence.current
    if (BINARY_FORMATS.has(file.format)) {
      setContent({ key, loading: false, error: '', text: null })
      return
    }
    setContent({ key, loading: true, error: '', text: null })
    try {
      const text = await readProjectFile(part, file)
      if (request === contentSequence.current) setContent({ key, loading: false, error: '', text })
    } catch (error) {
      if (request !== contentSequence.current) return
      setContent({ key, loading: false, error: errorText(error, '文件读取失败'), text: null })
    }
  }

  const selectProject = (project: ProjectSummary) => {
    if (project.key === selectedKey) return
    // 详情栏独立滚动：换项目时回到顶部。
    if (detailRef.current) detailRef.current.scrollTop = 0
    setToggledDirs(new Set())
    setRunError(null)
    const initial = desktop ? defaultFile(project) : null
    if (initial) {
      void selectFile(project, initial.part, initial.file)
      return
    }
    contentSequence.current += 1
    setSelectedKey(project.key)
    setSelectedFile(null)
    setContent(null)
  }

  const toggleDir = (key: string) => setToggledDirs(previous => {
    const next = new Set(previous)
    if (!next.delete(key)) next.add(key)
    return next
  })

  const openInChat = (project: ProjectSummary) => {
    if (!project.conversationId) return
    if (project.isGroup) {
      useChatStore.getState().setActiveGroupId(project.conversationId)
      navigate('/group-chat')
    } else {
      navigate(`/chat/${encodeURIComponent(project.conversationId)}`)
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
    if (!selectedPart || !selectedProjectFile || pendingAction) return
    setPendingAction(action)
    setActionError('')
    try {
      await openProjectFile(selectedPart, selectedProjectFile, action === 'reveal')
    } catch (error) {
      setActionError(errorText(error, '文件打开失败'))
    } finally {
      setPendingAction(null)
    }
  }

  const selectedFileIdIn = (part: ProjectPart) => (selectedPart && partKey(selectedPart) === partKey(part) ? selectedFile?.fileId ?? null : null)

  const applyOutcome = (part: ProjectPart, unit: RunUnit, outcome: StartOutcome, projectName: string) => {
    if (outcome.outcome === 'needs_consent') {
      setConsent({ part, unit, projectName, commands: outcome.commands, cwd: outcome.cwd, fingerprint: outcome.fingerprint })
      return
    }
    const status = runStatusFromOutcome(outcome)
    if (status) setRuns(previous => ({ ...previous, [unitKey(part, unit.dir)]: status }))
  }

  /** 运行；已在运行时宿主复用进程或服务，并在浏览器重新打开。 */
  const runUnit = async (part: ProjectPart, unit: RunUnit, projectName: string, fingerprint?: string) => {
    const key = unitKey(part, unit.dir)
    if (unit.runner.kind === 'none' || pendingRun) return
    setPendingRun(key)
    setRunError(null)
    try {
      const outcome = await startProject(part, unit.dir, { fileId: htmlPageToRun(unit.runner, selectedFileIdIn(part)), consent: fingerprint })
      applyOutcome(part, unit, outcome, projectName)
    } catch (error) {
      setRunError({ key, message: errorText(error, '运行失败，请重试') })
    } finally {
      setPendingRun(null)
    }
  }

  const stopUnit = async (part: ProjectPart, unit: RunUnit) => {
    const key = unitKey(part, unit.dir)
    if (pendingRun) return
    setPendingRun(key)
    setRunError(null)
    try {
      const status = await stopProject(part, unit.dir)
      setRuns(previous => ({ ...previous, [key]: status }))
    } catch (error) {
      setRunError({ key, message: errorText(error, '停止失败，请重试') })
    } finally {
      setPendingRun(null)
    }
  }

  const revealUnit = async (part: ProjectPart, dir: string) => {
    setRunError(null)
    try {
      await openProjectFile(part, unitRevealFile(part, dir), true)
    } catch (error) {
      setRunError({ key: unitKey(part, dir), message: errorText(error, '无法在文件夹中显示，请重试') })
    }
  }

  const confirmConsent = () => {
    if (!consent) return
    const request = consent
    setConsent(null)
    void runUnit(request.part, request.unit, request.projectName, request.fingerprint)
  }

  const sourceCount = (key: SourceKey) => allProjects.filter(project => matchesSource(project, key)).length
  const fileContent = selectedPart && selectedProjectFile && content?.key === fileNodeKey(selectedPart, selectedProjectFile) ? content : null
  const selectedFileNodeKey = selectedPart && selectedProjectFile ? fileNodeKey(selectedPart, selectedProjectFile) : null

  return <div className={styles.root}>
    <header className={styles.toolbar}>
      <div>
        <div className={styles.titleRow}><h1>工作台</h1><span className={styles.liveBadge}>本机项目</span></div>
        <p className={styles.subtitle}>汇总 AI 员工在 Fred、Codex、Claude、WorkBuddy 中做出的项目，可查看文件并一键运行；DeepSeek 按做出项目的模型筛选。只识别 Agent 新建的目录，不含你自己的代码仓库；项目内容不离开本机。</p>
      </div>
      <div className={styles.toolbarActions}>
        {desktop && <button className={styles.secondaryButton} type="button" onClick={() => setSourceDialog(true)} title="运行 Node / Python 项目时安装依赖用的下载源">
          <Download size={14} />下载源：{dependencySourceLabel(downloadSource)}
        </button>}
        <button className={styles.secondaryButton} type="button" onClick={load} disabled={isLoading}>
          <RefreshCw size={14} className={isLoading ? styles.spinner : undefined} />刷新
        </button>
      </div>
    </header>

    <section className={styles.sources} aria-label="项目来源">
      <button type="button" className={`${styles.sourceCard} ${source === 'all' ? styles.sourceCardActive : ''}`} aria-pressed={source === 'all'} onClick={() => selectSource('all')}>
        <span className={styles.sourceCardTop}><LayoutDashboard size={16} />全部来源</span>
        <strong>{allProjects.length}<small> 个项目</small></strong>
        <span className={styles.sourceCardHint} title={`${fileCount} 个文件 · ${employees.length} 位员工`}>{isLoading ? '读取中…' : `${fileCount} 个文件`}</span>
      </button>
      {PROJECT_SOURCES.map(key => {
        const state = states[key]
        const sourceLoading = key === 'fred' ? loading.fred : loading.local
        const unavailable = !sourceLoading && state && state.status !== 'ready'
        const status = sourceStatusText(state, sourceLoading, SOURCE_HINTS[key])
        return <button key={key} type="button" className={`${styles.sourceCard} ${source === key ? styles.sourceCardActive : ''}`} aria-pressed={source === key} onClick={() => selectSource(key)}>
          <span className={styles.sourceCardTop}><SourceBadge source={key} />{unavailable && (state.status === 'error' ? <TriangleAlert size={14} className={styles.warnIcon} /> : <MonitorOff size={14} />)}</span>
          <strong>{sourceLoading ? '—' : sourceCount(key)}<small> 个项目</small></strong>
          <span className={`${styles.sourceCardHint} ${state?.status === 'error' && !sourceLoading ? styles.sourceCardError : ''}`} title={`${status} · ${SOURCE_DESCRIPTIONS[key]}`}>{status}</span>
        </button>
      })}
      <button type="button" className={`${styles.sourceCard} ${source === DEEPSEEK ? styles.sourceCardActive : ''}`} aria-pressed={source === DEEPSEEK} onClick={() => selectSource(DEEPSEEK)}>
        <span className={styles.sourceCardTop}><SourceBadge source={DEEPSEEK} /><Cpu size={14} /></span>
        <strong>{isLoading ? '—' : sourceCount(DEEPSEEK)}<small> 个项目</small></strong>
        <span className={styles.sourceCardHint} title={SOURCE_DESCRIPTIONS.deepseek}>{SOURCE_HINTS.deepseek}</span>
      </button>
    </section>

    <div className={styles.filters} aria-label="项目筛选">
      <label className={styles.searchField}>
        <Search size={16} />
        <input aria-label="搜索项目" type="search" value={query} maxLength={120} onChange={event => setQuery(event.target.value)} placeholder="搜索项目名、简介、文件名、员工或目录" />
      </label>
      <select aria-label="员工筛选" value={employee} onChange={event => setEmployee(event.target.value)}>
        <option value="">全部员工</option>
        {employees.map(option => <option key={option.name} value={option.name}>{option.name}（{option.count}）</option>)}
      </select>
    </div>
    <div className={styles.resultsHeading}>
      <span>{hasFilters ? '筛选结果' : '全部项目'} · {visible.length} 个</span>
      {hasFilters && <button type="button" onClick={clearFilters}>清除筛选</button>}
      {isLoading && allProjects.length > 0 && <small role="status">正在更新…</small>}
    </div>

    <div className={styles.layout}>
      <section className={styles.list} aria-label="项目列表" aria-busy={isLoading}>
        {isLoading && !visible.length && <div className={styles.emptyState} role="status"><LoaderCircle className={styles.spinner} size={24} />正在读取各 Agent 做出的项目…</div>}
        {!isLoading && !visible.length && <div className={styles.emptyState}>
          <Inbox size={40} />
          <strong>{hasFilters ? '没有匹配的项目' : '还没有 AI Agent 做出的项目'}</strong>
          <span>{hasFilters ? '试试其他关键词，或清除筛选条件。' : desktop ? '让 AI 员工在 Fred，或在 Codex、Claude、WorkBuddy 中做一个网页、小游戏或小工具，项目目录会出现在这里。' : '工作台读取本机项目目录，请在 AIFred 桌面端中使用。'}</span>
          {hasFilters && <button type="button" onClick={clearFilters}>清除筛选</button>}
        </div>}
        {visible.map(project => {
          const partUnits = project.parts.map(part => units[partKey(part)])
          const kind = desktop ? projectRunnerKind(partUnits) : null
          const apps = runnableUnitCount(partUnits)
          const running = project.parts.some(part => (units[partKey(part)] ?? []).some(unit => runs[unitKey(part, unit.dir)]?.running))
          const chips = recentFiles(project, CARD_FILE_CHIPS)
          return <button type="button" key={project.key} className={`${styles.card} ${selectedKey === project.key ? styles.cardSelected : ''}`} aria-pressed={selectedKey === project.key} onClick={() => selectProject(project)}>
            <span className={styles.cardTop}>
              <EmployeeAvatar project={project} />
              <span className={styles.cardEmployee}>{project.employeeName}</span>
              <SourceBadge source={project.source} />
              <ChevronRight size={16} />
            </span>
            <strong>{project.name}</strong>
            {project.description && <span className={styles.cardPreview}>{project.description}</span>}
            <span className={styles.cardFiles}>
              {chips.map(file => <span key={file.id} className={styles.fileChip} title={file.path}><FileIcon file={file} size={12} />{file.name}</span>)}
              {project.fileCount > chips.length && <span className={styles.fileChipMore}>+{project.fileCount - chips.length}</span>}
            </span>
            <span className={styles.cardMeta}>
              {running && <span className={styles.runningTag}><span className={styles.runningDot} aria-hidden="true" />运行中</span>}
              {kind && <span className={`${styles.runnerBadge} ${kind === 'none' ? styles.runnerBadgeMuted : ''}`}>{RUNNER_LABELS[kind]}</span>}
              {apps > 1 && <span>{apps} 个应用</span>}
              <span>{formatTime(project.updatedAt)}</span>
              <span>{project.fileCount} 个文件</span>
              {project.isGroup && <span>群聊</span>}
              {project.models.length > 0 && <span className={styles.cardTag} title={project.models.join('、')}><Cpu size={12} />{project.models.join('、')}</span>}
              {project.location && <span className={styles.cardTag} title={project.location}><FolderOpen size={12} />{project.location}</span>}
            </span>
          </button>
        })}
      </section>

      <section ref={detailRef} className={styles.detail} aria-label="项目详情" aria-busy={fileContent?.loading}>
        {!selected ? <div className={styles.detailPlaceholder}><LayoutDashboard size={28} /><span>选择左侧项目，查看文件或直接运行。</span></div> : <div className={styles.detailPanel}>
          <div className={styles.detailHeader}>
            <div className={styles.detailTitle}>
              <span className={styles.detailEyebrow}><SourceBadge source={selected.source} />{selected.employeeName}</span>
              <h2>{selected.name}</h2>
              {selected.description && <p className={styles.detailDescription}>{selected.description}</p>}
            </div>
            {selected.conversationId && <button className={styles.secondaryButton} type="button" onClick={() => openInChat(selected)}><MessageSquare size={14} />回到会话</button>}
          </div>

          <div className={styles.sectionHeading}><h3>运行</h3>{(selected.isGroup || runnableUnitCount(selected.parts.map(part => units[partKey(part)])) > 1) && <span>每个应用单独运行</span>}</div>
          {!desktop
            ? <p className={styles.hint}>仅桌面端可运行项目。</p>
            : <div className={styles.runList}>
              {selected.parts.flatMap(part => {
                const found: (RunUnit | undefined)[] = units[partKey(part)] ?? [undefined]
                return found.map(unit => {
                  const dir = unit?.dir ?? ''
                  const key = unitKey(part, dir)
                  return <RunControls
                    key={key}
                    label={[part.label, dir].filter(Boolean).join(' / ') || null}
                    removed={part.removed}
                    runner={unit?.runner}
                    status={runs[key]}
                    pending={pendingRun === key}
                    busy={pendingRun !== null}
                    error={runError?.key === key ? runError.message : ''}
                    onRun={() => unit && void runUnit(part, unit, selected.name)}
                    onStop={() => unit && void stopUnit(part, unit)}
                    onReveal={() => void revealUnit(part, dir)}
                  />
                })
              })}
            </div>}

          <div className={styles.detailMeta}>
            <div><span>最近更新</span><strong>{formatTime(selected.updatedAt)}</strong></div>
            <div><span>模型</span><strong>{selected.models.length ? selected.models.join('、') : '未记录'}</strong></div>
            <div><span>{selected.source === 'fred' ? '会话类型' : '项目目录'}</span><strong>{selected.source === 'fred' ? (selected.isGroup ? '群聊' : '单聊') : selected.location ?? '未记录'}</strong></div>
          </div>

          <div className={styles.sectionHeading}><h3>文件</h3><span>{selected.fileCount} 个{selected.truncated ? ' · 文件过多，只列出一部分' : ''}</span></div>
          {!desktop
            ? <p className={styles.hint}>仅桌面端可查看项目文件。</p>
            : <div className={styles.filesLayout}>
              <nav className={styles.tree} aria-label="项目文件">
                {treeRows.map(node => {
                  const indent = { paddingLeft: 8 + node.depth * 14 }
                  if (node.kind === 'dir') {
                    const expanded = isExpanded(node, toggledDirs)
                    return <button type="button" key={node.key} className={`${styles.treeRow} ${node.removed ? styles.treeRowMuted : ''}`} style={indent} aria-expanded={expanded} onClick={() => toggleDir(node.key)}>
                      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<Folder size={14} /><span>{node.name}</span>
                    </button>
                  }
                  const active = node.key === selectedFileNodeKey
                  return <button type="button" key={node.key} className={`${styles.treeRow} ${active ? styles.treeRowActive : ''}`} style={indent} aria-pressed={active} title={node.file.path} onClick={() => void selectFile(selected, node.part, node.file)}>
                    <span className={styles.treeSpacer} /><FileIcon file={node.file} size={14} /><span>{node.name}</span>
                  </button>
                })}
              </nav>
              {selectedPart && selectedProjectFile
                ? <FilePanel
                    file={selectedProjectFile}
                    content={fileContent}
                    showSource={showSource}
                    copied={copied}
                    pendingAction={pendingAction}
                    actionError={actionError}
                    onToggleSource={setShowSource}
                    onCopy={text => void copyContent(text)}
                    onAction={action => void runFileAction(action)}
                    onRetry={() => void selectFile(selected, selectedFile?.part ?? 0, selectedProjectFile)}
                  />
                : <p className={styles.hint}>选择左侧文件查看内容。</p>}
            </div>}
        </div>}
      </section>
    </div>

    {consent && <ChatDialog title="确认运行项目" icon={<ShieldAlert size={18} />} description={consent.unit.dir ? `${consent.projectName} / ${consent.unit.dir}` : consent.projectName} onClose={() => setConsent(null)}>
      <p className="chat-tools-note">首次运行（或命令、依赖文件变化后）需要你确认。将在项目目录中依次执行：</p>
      <pre className={styles.consentCommands}>{consent.commands.join('\n')}</pre>
      <p className={styles.consentCwd}><span>工作目录</span>{consent.cwd}</p>
      <p className={styles.consentCwd}><span>依赖下载源</span>{dependencySourceLabel(downloadSource)}（可在工作台右上角「下载源」中更改）</p>
      <p className={styles.consentWarning}><TriangleAlert size={15} /><span>项目代码会以你的用户权限运行，可能访问网络和本机文件；安装依赖时会联网下载，并可能执行依赖包的安装脚本。只运行你信任的项目。</span></p>
      <footer>
        <button type="button" onClick={() => setConsent(null)}>取消</button>
        <button type="button" className={styles.consentConfirm} onClick={confirmConsent}><Play size={14} />确认并运行</button>
      </footer>
    </ChatDialog>}

    {sourceDialog && <DependencySourceDialog
      value={downloadSource}
      onClose={() => setSourceDialog(false)}
      onSaved={saved => {
        setDownloadSource(saved)
        setSourceDialog(false)
      }}
    />}
  </div>
}

const SOURCE_OPTIONS: { mode: DependencySource['mode']; title: string; detail: string }[] = [
  { mode: 'mirror', title: '国内镜像（推荐）', detail: 'Python 用清华 PyPI 镜像，Node 用 npmmirror' },
  { mode: 'system', title: '跟随系统配置', detail: '使用本机 pip.conf、.npmrc 中的设置，未设置时为官方源' },
  { mode: 'custom', title: '自定义', detail: '填写公司内部或其他镜像地址；留空的一项跟随系统配置' },
]

function DependencySourceDialog({ value, onClose, onSaved }: {
  value: DependencySource
  onClose: () => void
  onSaved: (source: DependencySource) => void
}) {
  const [mode, setMode] = useState<DependencySource['mode']>(value.mode)
  const [pypi, setPypi] = useState(value.mode === 'custom' ? value.pypi ?? '' : '')
  const [npm, setNpm] = useState(value.mode === 'custom' ? value.npm ?? '' : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const pypiError = mode === 'custom' ? sourceUrlError(pypi) : null
  const npmError = mode === 'custom' ? sourceUrlError(npm) : null

  const save = async () => {
    if (saving || pypiError || npmError) return
    const next: DependencySource = mode === 'custom'
      ? { mode, pypi: pypi.trim() || null, npm: npm.trim() || null }
      : { mode }
    setSaving(true)
    setError('')
    try {
      onSaved(await setDependencySource(next))
    } catch (failure) {
      setError(errorText(failure, '保存下载源失败，请重试'))
      setSaving(false)
    }
  }

  return <ChatDialog title="依赖下载源" icon={<Download size={18} />} description="运行 Node / Python 项目时安装依赖用的地址" onClose={onClose}>
    <div className={styles.sourceOptions} role="radiogroup" aria-label="下载源">
      {SOURCE_OPTIONS.map(option => <label key={option.mode} className={`${styles.sourceOption} ${mode === option.mode ? styles.sourceOptionActive : ''}`}>
        <input type="radio" name="dependency-source" checked={mode === option.mode} onChange={() => setMode(option.mode)} />
        <span><strong>{option.title}</strong><small>{option.detail}</small></span>
      </label>)}
    </div>
    {mode === 'custom' && <div className={styles.sourceFields}>
      <label>
        <span>Python（PyPI 索引地址）</span>
        <input value={pypi} maxLength={512} placeholder={PYPI_MIRROR} aria-invalid={Boolean(pypiError)} onChange={event => setPypi(event.target.value)} />
        {pypiError && <small className={styles.fieldError}>{pypiError}</small>}
      </label>
      <label>
        <span>Node（npm registry）</span>
        <input value={npm} maxLength={512} placeholder={NPM_MIRROR} aria-invalid={Boolean(npmError)} onChange={event => setNpm(event.target.value)} />
        {npmError && <small className={styles.fieldError}>{npmError}</small>}
      </label>
    </div>}
    <p className="chat-tools-note">更换下载源会改变安装命令，每个代码项目下次运行前需要重新确认；已安装的依赖不会重新下载。</p>
    {error && <div className={styles.errorBanner} role="alert"><TriangleAlert size={15} /><span>{error}</span></div>}
    <footer>
      <button type="button" onClick={onClose}>取消</button>
      <button type="button" className={styles.consentConfirm} disabled={saving || Boolean(pypiError || npmError)} onClick={() => void save()}>
        {saving && <LoaderCircle size={14} className={styles.spinner} />}保存
      </button>
    </footer>
  </ChatDialog>
}

function RunControls({ label, removed, runner, status, pending, busy, error, onRun, onStop, onReveal }: {
  /** 群聊员工名和 / 或子文件夹名；单个目录本身为 null。 */
  label: string | null
  removed: boolean
  runner: RunUnit['runner'] | undefined
  status: RunStatus | undefined
  pending: boolean
  busy: boolean
  error: string
  onRun: () => void
  onStop: () => void
  onReveal: () => void
}) {
  const running = Boolean(status?.running)
  const phase = runPhaseText(status)
  const failed = status?.phase === 'failed' || status?.url_timed_out
  const logs = status?.logs ?? []
  return <div className={styles.runRow}>
    <div className={styles.runHead}>
      <div className={styles.runInfo}>
        {label && <strong className={removed ? styles.removedLabel : undefined}>{label}{removed ? '（已移出）' : ''}</strong>}
        {runner
          ? <span className={styles.runDetail}><span className={`${styles.runnerBadge} ${runner.kind === 'none' ? styles.runnerBadgeMuted : ''}`}>{RUNNER_LABELS[runner.kind]}</span>{runnerDetail(runner)}</span>
          : <span className={styles.runDetail}><LoaderCircle size={12} className={styles.spinner} />正在识别运行方式…</span>}
      </div>
      <div className={styles.runActions}>
        {runner && runner.kind !== 'none' && !running && <button type="button" className={styles.primaryButton} disabled={busy} onClick={onRun}>
          {pending ? <LoaderCircle size={14} className={styles.spinner} /> : <Play size={14} />}运行
        </button>}
        {running && <button type="button" className={styles.primaryButton} disabled={busy || !status?.url} onClick={onRun} title={status?.url ?? '等待项目输出访问地址'}>
          {pending ? <LoaderCircle size={14} className={styles.spinner} /> : <ExternalLink size={14} />}打开
        </button>}
        {running && <button type="button" className={styles.smallButton} disabled={busy} onClick={onStop}><Square size={12} />停止</button>}
        <button type="button" className={styles.smallButton} onClick={onReveal}><FolderSearch size={13} />在文件夹中显示</button>
      </div>
    </div>
    {(phase || status?.url) && <div className={`${styles.runStatus} ${failed ? styles.runStatusError : ''}`} role="status">
      {running && status?.phase === 'running' && <span className={styles.runningDot} aria-hidden="true" />}
      {phase && <span>{phase}</span>}
      {running && status?.url && <code>{status.url}</code>}
    </div>}
    {error && <div className={styles.errorBanner} role="alert"><TriangleAlert size={15} /><span>{error}</span></div>}
    {logs.length > 0 && <details className={styles.logs}>
      <summary><Terminal size={13} />日志（最近 {logs.length} 行）</summary>
      <pre>{logs.join('\n')}</pre>
    </details>}
  </div>
}

function FilePanel({ file, content, showSource, copied, pendingAction, actionError, onToggleSource, onCopy, onAction, onRetry }: {
  file: ProjectFile
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
  const text = content?.text ?? null
  const canToggle = text !== null && PREVIEW_FORMATS.has(file.format)
  return <article className={styles.filePanel}>
    <div className={styles.fileHeader}>
      <span className={styles.fileIcon}><FileIcon file={file} size={18} /></span>
      <div className={styles.fileTitle}>
        <strong>{file.name}</strong>
        <span title={file.path}>{file.path}</span>
      </div>
      <div className={styles.fileActions}>
        {text !== null && <button type="button" className={styles.smallButton} onClick={() => onCopy(text)} aria-label={`复制 ${file.name} 的内容`}>
          {copied ? <><Check size={13} />已复制</> : <><Copy size={13} />复制</>}
        </button>}
        <button type="button" className={styles.smallButton} disabled={pendingAction !== null} onClick={() => onAction('open')}>
          {pendingAction === 'open' ? <LoaderCircle size={13} className={styles.spinner} /> : <ExternalLink size={13} />}打开
        </button>
        <button type="button" className={styles.smallButton} disabled={pendingAction !== null} onClick={() => onAction('reveal')}>
          {pendingAction === 'reveal' ? <LoaderCircle size={13} className={styles.spinner} /> : <FolderSearch size={13} />}在文件夹中显示
        </button>
      </div>
    </div>
    <div className={styles.fileFacts}>
      <span>{fileTypeLabel(file)}</span>
      <span>{formatSize(file.size)}</span>
      <span>修改于 {formatTime(file.modifiedAt)}</span>
      {canToggle && <span className={styles.viewToggle} role="group" aria-label="显示方式">
        <button type="button" aria-pressed={!showSource} onClick={() => onToggleSource(false)}>预览</button>
        <button type="button" aria-pressed={showSource} onClick={() => onToggleSource(true)}>源码</button>
      </span>}
    </div>
    {actionError && <div className={styles.errorBanner} role="alert"><TriangleAlert size={15} /><span>{actionError}</span></div>}
    {(!content || content.loading) && <div className={styles.detailPlaceholder} role="status"><LoaderCircle className={styles.spinner} size={24} /><span>正在读取文件内容…</span></div>}
    {content?.error && <div className={styles.errorBanner} role="alert">
      <TriangleAlert size={15} /><span>{content.error}</span>
      <button type="button" onClick={onRetry}>重试</button>
    </div>}
    {content && !content.loading && !content.error && <div className={styles.previewBody}><FilePreview file={file} text={text} showSource={showSource} /></div>}
  </article>
}

function FilePreview({ file, text, showSource }: { file: ProjectFile; text: string | null; showSource: boolean }) {
  if (text === null) {
    return <div className={styles.documentPlaceholder}>
      <FileIcon file={file} size={28} />
      <strong>{fileTypeLabel(file)} 文件</strong>
      <span>该文件不支持在页面内预览，请点击「打开」用默认应用查看。</span>
    </div>
  }
  if (!text.trim()) return <p className={styles.hint}>文件内容为空。</p>
  if (showSource) return <pre className={styles.plainText}>{text}</pre>
  switch (file.format) {
    case 'markdown':
      return <ProjectMarkdown content={text} />
    // 空 sandbox：不执行脚本、不共享来源；sandboxedHtml 再禁止加载外部资源。要看运行效果请点「运行」。
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
