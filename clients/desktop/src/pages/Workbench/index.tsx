/**
 * 工作台：汇总本机 AI Agent 做出的项目，查看文件并运行。
 * 本文件只负责筛选、选中和页面布局；运行状态见 useProjectRuns，各区块见同目录组件。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronRight, Download, Folder, Inbox, LayoutDashboard, LoaderCircle, MessageSquare, RefreshCw, Search, UserRoundPlus } from 'lucide-react'
import { isTauri } from '../../api/agent/runtime'
import { isMacUserAgent, projectHandoffBlock } from '../../lib/projectConversation'
import { useChatStore } from '../../stores/chat'
import { getDependencySource, loadFredProjects, loadLocalProjects, loadProjectHandoffs, openProjectFile, readProjectFile } from './api'
import ConsentDialog from './ConsentDialog'
import DependencySourceDialog from './DependencySourceDialog'
import FileIcon from './FileIcon'
import FilePanel, { BINARY_FORMATS, type ContentState, type FileAction } from './FilePanel'
import { errorText, formatTime } from './format'
import ProjectCard from './ProjectCard'
import ProjectDevelopDialog from './ProjectDevelopDialog'
import {
  buildFileTree,
  DEFAULT_DEPENDENCY_SOURCE,
  dependencySourceLabel,
  defaultFile,
  employeeOptions,
  fileNodeKey,
  filterProjects,
  isExpanded,
  matchesSource,
  DEEPSEEK,
  FILTER_LABELS,
  partKey,
  projectRunnerKind,
  shownSources,
  withHandoffs,
  type ProjectHandoff,
  runnableUnitCount,
  sortProjects,
  unitKey,
  visibleTreeRows,
  type DependencySource,
  type ProjectFile,
  type ProjectPart,
  type ProjectSource,
  type ProjectSummary,
  type RunUnit,
  type SourceFilter,
  type SourceState,
} from './projects'
import RunControls from './RunControls'
import SourceBadge from './SourceBadge'
import SourceCards from './SourceCards'
import { useProjectRuns } from './useProjectRuns'
import styles from './index.module.css'

interface SelectedFile {
  part: number
  fileId: string
}

export default function Workbench() {
  const navigate = useNavigate()
  const desktop = isTauri()
  const [fredProjects, setFredProjects] = useState<ProjectSummary[]>([])
  const [localProjects, setLocalProjects] = useState<ProjectSummary[]>([])
  const [handoffs, setHandoffs] = useState<ProjectHandoff[]>([])
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
  const [downloadSource, setDownloadSource] = useState<DependencySource>(DEFAULT_DEPENDENCY_SOURCE)
  const [sourceDialog, setSourceDialog] = useState(false)
  const [developing, setDeveloping] = useState<ProjectSummary | null>(null)

  useEffect(() => {
    if (desktop) void getDependencySource().then(setDownloadSource)
  }, [desktop])
  // 已交给 Fred 员工继续做的外部项目归到 Fred。
  const allProjects = useMemo(() => sortProjects([...fredProjects, ...withHandoffs(localProjects, handoffs)]), [fredProjects, localProjects, handoffs])
  const partsByKey = useMemo(() => new Map(allProjects.flatMap(project => project.parts.map(part => [partKey(part), part] as const))), [allProjects])
  const { units, runs, pendingRun, runError, consent, redetect, clearRunError, cancelConsent, run, stop, reveal, tryOpen, downloadPython, confirmConsent } = useProjectRuns(desktop, partsByKey)
  const loadSequence = useRef(0)
  const contentSequence = useRef(0)
  const detailRef = useRef<HTMLElement>(null)

  const load = useCallback(() => {
    const request = ++loadSequence.current
    redetect()
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
    // 项目对话和外部项目一起到，免得项目先显示在原来源、再跳到 Fred。
    void Promise.all([loadLocalProjects(), loadProjectHandoffs()]).then(([result, adopted]) => {
      if (request !== loadSequence.current) return
      setLocalProjects(result.projects)
      setHandoffs(adopted)
      mergeStates(result.states)
      setLoading(previous => ({ ...previous, local: false }))
    })
  }, [redetect])

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

  const employees = useMemo(() => employeeOptions(allProjects, source), [allProjects, source])
  const visible = useMemo(() => filterProjects(allProjects, { source, employee, query }), [allProjects, source, employee, query])
  const selected = useMemo(() => allProjects.find(project => project.key === selectedKey) ?? null, [allProjects, selectedKey])
  // Fred 的项目回到原会话继续；其他工具的项目交给一位员工在新对话里接着做。
  const handoffBlock = selected && selected.source !== 'fred' ? projectHandoffBlock({ desktop, mac: isMacUserAgent(navigator.userAgent) }) : null
  const selectedPart = selected && selectedFile ? selected.parts[selectedFile.part] ?? null : null
  const selectedProjectFile = selectedPart?.files.find(file => file.id === selectedFile?.fileId) ?? null
  const tree = useMemo(() => (selected ? buildFileTree(selected) : []), [selected])
  const treeRows = useMemo(() => visibleTreeRows(tree, toggledDirs), [tree, toggledDirs])
  const fileCount = useMemo(() => allProjects.reduce((total, project) => total + project.fileCount, 0), [allProjects])
  const isLoading = loading.fred || loading.local
  const hasFilters = Boolean(query.trim() || employee || source !== 'all')
  const countOf = useCallback((key: SourceFilter) => allProjects.filter(project => matchesSource(project, key)).length, [allProjects])
  const shown = useMemo(() => shownSources(countOf, states, loading), [countOf, states, loading])
  const showDeepSeek = !isLoading && countOf(DEEPSEEK) > 0
  // 选中的来源被隐藏（例如项目都交给了员工）时回到全部来源。
  useEffect(() => {
    if (isLoading || source === 'all') return
    const hidden = source === DEEPSEEK ? !showDeepSeek : !shown.includes(source)
    if (hidden) setSource('all')
  }, [isLoading, source, shown, showDeepSeek])

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
    clearRunError()
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

    <SourceCards
      source={source}
      states={states}
      loading={loading}
      totalProjects={allProjects.length}
      fileCount={fileCount}
      employeeCount={employees.length}
      countOf={countOf}
      shown={shown}
      showDeepSeek={showDeepSeek}
      onSelect={selectSource}
    />

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
          const running = project.parts.some(part => (units[partKey(part)] ?? []).some(unit => runs[unitKey(part, unit.dir)]?.running))
          return <ProjectCard
            key={project.key}
            project={project}
            selected={selectedKey === project.key}
            runnerKind={desktop ? projectRunnerKind(partUnits) : null}
            apps={runnableUnitCount(partUnits)}
            running={running}
            onSelect={() => selectProject(project)}
          />
        })}
      </section>

      <section ref={detailRef} className={styles.detail} aria-label="项目详情" aria-busy={fileContent?.loading}>
        {!selected ? <div className={styles.detailPlaceholder}><LayoutDashboard size={28} /><span>选择左侧项目，查看文件或直接运行。</span></div> : <div className={styles.detailPanel}>
          <div className={styles.detailHeader}>
            <div className={styles.detailTitle}>
              <span className={styles.detailEyebrow}><SourceBadge source={selected.source} />{selected.origin && <span className={styles.originNote}>原来自 {FILTER_LABELS[selected.origin]}</span>}{selected.employeeName}</span>
              <h2>{selected.name}</h2>
              {selected.description && <p className={styles.detailDescription}>{selected.description}</p>}
            </div>
            <div className={styles.detailActions}>
              {selected.source === 'fred'
                ? selected.conversationId && <button className={styles.secondaryButton} type="button" onClick={() => openInChat(selected)}><MessageSquare size={14} />继续对话</button>
                : <button className={styles.accentButton} type="button" disabled={Boolean(handoffBlock)} title={handoffBlock ?? '选一位员工，在这个项目的目录里接着做'} onClick={() => setDeveloping(selected)}><UserRoundPlus size={14} />交给员工继续做</button>}
            </div>
          </div>
          {handoffBlock && <p className={`${styles.hint} ${styles.detailBlock}`}>{handoffBlock}</p>}

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
                    needsPython={Boolean(unit?.needs_python)}
                    status={runs[key]}
                    pending={pendingRun === key}
                    busy={pendingRun !== null}
                    error={runError?.key === key ? runError.message : ''}
                    onRun={() => unit && void run(part, unit, selected.name, { selectedFileId: selectedFileIdIn(part) })}
                    onStop={() => unit && void stop(part, unit)}
                    onReveal={() => void reveal(part, dir)}
                    onTryOpen={() => void tryOpen(part, dir)}
                    onDownloadPython={() => void downloadPython(part, dir)}
                  />
                })
              })}
            </div>}

          <div className={styles.detailMeta}>
            <div><span>最近更新</span><strong>{formatTime(selected.updatedAt)}</strong></div>
            <div><span>模型</span><strong>{selected.models.length ? selected.models.join('、') : '未记录'}</strong></div>
            <div><span>{selected.location ? '项目目录' : '会话类型'}</span><strong>{selected.location ?? (selected.isGroup ? '群聊' : '单聊')}</strong></div>
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

    {developing && <ProjectDevelopDialog project={developing} onClose={() => setDeveloping(null)} />}
    {consent && <ConsentDialog request={consent} downloadSource={downloadSource} onCancel={cancelConsent} onConfirm={confirmConsent} />}

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
