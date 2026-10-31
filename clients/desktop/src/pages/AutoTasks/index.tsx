import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type Ref } from 'react'
import { CalendarClock, Check, ChevronRight, Clock3, ExternalLink, LoaderCircle, Pause, Play, Plus, RefreshCw, Search, SlidersHorizontal, Trash2, X, Zap } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { agentApi, AgentApiError, type AutomationTask, type Connector, type TaskCategory, type TaskRun, type TaskSchedule } from '../../api/agent'
import type { ExpertProjection } from '../../api/agent/types'
import styles from './index.module.css'
import { useDialogFocus } from '../../hooks/useDialogFocus'

type Draft = {
  name: string
  prompt: string
  category: TaskCategory
  employeeId: string
  connectorIds: string[]
  mode: TaskSchedule['mode']
  timezone: string
  time: string
  weekday: number
  dayOfMonth: number
  intervalMinutes: number
  startAt: string
}

const categoryLabels: Record<TaskCategory | 'all', string> = { all: '全部分类', report: '报告', monitor: '监控', reminder: '提醒', other: '其他' }
const statusLabels: Record<string, string> = { active: '启用中', paused: '已暂停', completed: '已完成', queued: '等待执行', blocked: '已阻塞', running: '执行中', succeeded: '执行成功', error: '执行失败', aborted: '已中止', unknown: '结果待核实', skipped: '已跳过' }
const runModes: Array<[TaskSchedule['mode'], string]> = [['daily', '每天'], ['weekly', '每周'], ['monthly', '每月'], ['interval', '固定间隔'], ['once', '单次']]

function localDateTime(value: string) {
  const date = new Date(value)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function defaultDraft(): Draft {
  return {
    name: '', prompt: '', category: 'other', employeeId: '', connectorIds: [], mode: 'daily',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai', time: '09:00', weekday: 1,
    dayOfMonth: 1, intervalMinutes: 60, startAt: localDateTime(new Date(Date.now() + 3_600_000).toISOString()),
  }
}

function draftFromTask(task: AutomationTask): Draft {
  const draft = defaultDraft()
  const rule = task.schedule
  return {
    ...draft, name: task.name, prompt: task.prompt ?? '', category: task.category,
    employeeId: task.employee_id ?? '', connectorIds: task.connector_ids,
    ...(rule ? { mode: rule.mode, timezone: rule.timezone } : {}),
    ...(rule && 'time' in rule ? { time: rule.time.slice(0, 5) } : {}),
    ...(rule?.mode === 'weekly' ? { weekday: rule.weekday } : {}),
    ...(rule?.mode === 'monthly' ? { dayOfMonth: rule.day_of_month } : {}),
    ...(rule?.mode === 'interval' ? { intervalMinutes: Math.max(1, Math.round(rule.interval_seconds / 60)), startAt: localDateTime(rule.starts_at) } : {}),
    ...(rule?.mode === 'once' ? { startAt: localDateTime(rule.run_at) } : {}),
  }
}

function scheduleFromDraft(draft: Draft): TaskSchedule {
  const timezone = draft.timezone.trim()
  if (draft.mode === 'once') return { mode: 'once', timezone, run_at: new Date(draft.startAt).toISOString() }
  if (draft.mode === 'interval') return { mode: 'interval', timezone, interval_seconds: draft.intervalMinutes * 60, starts_at: new Date(draft.startAt).toISOString() }
  const time = draft.time.length === 5 ? `${draft.time}:00` : draft.time
  if (draft.mode === 'weekly') return { mode: 'weekly', timezone, weekday: draft.weekday, time }
  if (draft.mode === 'monthly') return { mode: 'monthly', timezone, day_of_month: draft.dayOfMonth, invalid_date_policy: 'skip', time }
  return { mode: 'daily', timezone, time }
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }) : '—'
}

function scheduleLabel(rule: TaskSchedule | null) {
  if (!rule) return '尚未配置'
  if (rule.mode === 'once') return `单次 · ${formatDate(rule.run_at)}`
  if (rule.mode === 'interval') return `每 ${Math.round(rule.interval_seconds / 60)} 分钟 · ${rule.timezone}`
  const prefix = rule.mode === 'daily' ? '每天' : rule.mode === 'weekly' ? `每周${'一二三四五六日'[rule.weekday - 1]}` : `每月 ${rule.day_of_month} 日`
  return `${prefix} ${rule.time} · ${rule.timezone}`
}

function errorMessage(error: unknown) {
  if (error instanceof AgentApiError && error.status === 409) return '任务已被其他操作更新，请刷新后重试。'
  return error instanceof Error ? error.message : '请求失败，请重试。'
}

function StatusPill({ status }: { status: string }) {
  return <span className={`${styles.statusPill} ${styles[`status${status}`] ?? ''}`}><i />{statusLabels[status] ?? status}</span>
}

export default function Tasks() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [tasks, setTasks] = useState<AutomationTask[]>([])
  const [experts, setExperts] = useState<ExpertProjection[]>([])
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [selected, setSelected] = useState<AutomationTask | null>(null)
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [runCursor, setRunCursor] = useState<string | null>(null)
  const [category, setCategory] = useState<TaskCategory | 'all'>('all')
  const [status, setStatus] = useState<'all' | 'active' | 'paused' | 'completed'>('all')
  const [employeeFilter, setEmployeeFilter] = useState(() => searchParams.get('employee') ?? '')
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(() => ({ ...defaultDraft(), employeeId: searchParams.get('employee') ?? '' }))
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [detailLoading, setDetailLoading] = useState(false)
  const listRequestRef = useRef(0)
  const detailRequestRef = useRef(0)

  const loadTasks = useCallback(async (nextCursor?: string) => {
    const request = ++listRequestRef.current
    setLoading(true)
    try {
      const result = await agentApi.listAutomationTasks({ category, status, q: query.trim() || undefined, employee_id: employeeFilter || undefined, cursor: nextCursor, limit: 50 })
      if (request !== listRequestRef.current) return
      setTasks(previous => nextCursor ? [...previous, ...result.data] : result.data)
      setCursor(result.page.next_cursor)
      setError('')
    } catch (err) { if (request === listRequestRef.current) setError(errorMessage(err)) }
    finally { if (request === listRequestRef.current) setLoading(false) }
  }, [category, status, employeeFilter, query])

  useEffect(() => {
    const timer = window.setTimeout(() => void loadTasks(), 220)
    return () => { window.clearTimeout(timer); listRequestRef.current += 1 }
  }, [loadTasks])

  useEffect(() => () => { detailRequestRef.current += 1 }, [])

  useEffect(() => {
    let cancelled = false
    agentApi.listExperts().then(result => { if (!cancelled) setExperts(result.experts.filter(expert => !expert.revoked)) }).catch(err => { if (!cancelled) setError(`员工列表读取失败：${errorMessage(err)}`) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const conversationId = searchParams.get('conversation_id')
    const target = tasks.find(task => task.conversation_id === conversationId)
    if (target && !selected) void openTask(target)
  }, [tasks, searchParams]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false
    setConnectors([])
    if (editing && draft.employeeId) agentApi.listConnectors(draft.employeeId).then(result => { if (!cancelled) setConnectors(result.data) }).catch(err => { if (!cancelled) setError(errorMessage(err)) })
    return () => { cancelled = true }
  }, [editing, draft.employeeId])

  async function openTask(task: AutomationTask) {
    const request = ++detailRequestRef.current
    setDetailLoading(true); setError(''); setEditing(false); setConfirmDelete(false); setSelected(task)
    try {
      const [detail, history] = await Promise.all([agentApi.getAutomationTask(task.task_id), agentApi.listAutomationTaskRuns(task.task_id)])
      if (request !== detailRequestRef.current) return
      setSelected(detail); setRuns(history.data); setRunCursor(history.page.next_cursor)
    } catch (err) { if (request === detailRequestRef.current) { setError(errorMessage(err)); setSelected(null) } }
    finally { if (request === detailRequestRef.current) setDetailLoading(false) }
  }

  function startCreate() {
    detailRequestRef.current += 1
    setDetailLoading(false); setSelected(null); setDraft({ ...defaultDraft(), employeeId: employeeFilter }); setEditing(true); setError('')
  }

  function clearFilters() { setQuery(''); setCategory('all'); setStatus('all'); setEmployeeFilter('') }

  function updateDraft<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft(previous => ({ ...previous, [key]: value }))
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!draft.name.trim() || !draft.prompt.trim() || !draft.employeeId) return
    setBusy(true); setError('')
    try {
      const schedule = scheduleFromDraft(draft)
      if (selected) {
        const before = draftFromTask(selected)
        const body: Parameters<typeof agentApi.updateAutomationTask>[1] = {}
        if (draft.name !== before.name) body.name = draft.name.trim()
        if (draft.prompt !== before.prompt) body.prompt = draft.prompt.trim()
        if (draft.category !== before.category) body.category = draft.category
        if (draft.employeeId !== before.employeeId) body.employee_id = draft.employeeId
        if (JSON.stringify(draft.connectorIds) !== JSON.stringify(before.connectorIds)) body.connector_ids = draft.connectorIds
        if (JSON.stringify(schedule) !== JSON.stringify(selected.schedule)) body.schedule = schedule
        const updated = await agentApi.updateAutomationTask(selected.task_id, body, selected.etag)
        setSelected(updated); setEditing(false); await openTask(updated)
      } else {
        const created = await agentApi.createAutomationTask({ name: draft.name.trim(), prompt: draft.prompt.trim(), category: draft.category, employee_id: draft.employeeId, connector_ids: draft.connectorIds, schedule }, crypto.randomUUID())
        setSelected(created); setEditing(false); await openTask(created)
      }
      await loadTasks()
    } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }

  async function changeAction(action: 'enable' | 'pause' | 'delete') {
    if (!selected) return
    setBusy(true); setError('')
    try {
      if (action === 'delete') { await agentApi.deleteAutomationTask(selected.task_id, selected.etag); setSelected(null); setConfirmDelete(false) }
      else setSelected(await agentApi.setAutomationTaskAction(selected.task_id, action, selected.etag))
      await loadTasks()
    } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }

  async function loadMoreRuns() {
    if (!selected || !runCursor) return
    setBusy(true)
    try { const result = await agentApi.listAutomationTaskRuns(selected.task_id, { cursor: runCursor }); setRuns(previous => [...previous, ...result.data]); setRunCursor(result.page.next_cursor) }
    catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }

  const filteredTasks = tasks
  const summary = useMemo(() => ({ active: tasks.filter(task => task.status === 'active').length, paused: tasks.filter(task => task.status === 'paused').length }), [tasks])
  const hasFilters = Boolean(query.trim() || category !== 'all' || status !== 'all' || employeeFilter)

  return <div className={styles.tasksRoot}>
    <header className={styles.tasksToolbar}>
      <div><div className={styles.tasksTitleRow}><h1>自动化任务</h1><span className={styles.tasksLiveBadge}>本地调度</span></div><p className={styles.tasksSubtitle}>任务在本机运行，需要 Agent 保持运行且登录有效。</p></div>
      <div className={styles.tasksActions}><button className={styles.secondaryButton} type="button" onClick={() => void loadTasks()} disabled={loading}><RefreshCw size={14} className={loading ? styles.spinner : undefined} />刷新</button><button className={styles.primaryButton} type="button" disabled={busy} onClick={startCreate}><Plus size={15} />新建任务</button></div>
    </header>
    <section className={styles.overview} aria-label="当前已加载的任务统计">
      <div><span><CalendarClock size={16} />当前列表</span><strong>{tasks.length}<small>{cursor ? '+ 项' : ' 项'}</small></strong></div>
      <div><span><Play size={16} />启用中</span><strong>{summary.active}<small>项</small></strong></div>
      <div><span><Pause size={16} />已暂停</span><strong>{summary.paused}<small>项</small></strong></div>
      <p>统计仅针对当前筛选下已加载的任务。<br />本地调度 · 请保持 Agent 在线。</p>
    </section>
    {error && <div className={styles.errorBanner} role="alert"><Zap size={15} /><span>{error}</span></div>}
    <div className={styles.tasksFilters} aria-label="任务筛选">
      <label className={styles.searchField}><Search size={16} /><input aria-label="搜索任务" type="search" value={query} maxLength={120} onChange={event => setQuery(event.target.value)} placeholder="搜索任务、指令或员工" /></label>
      <select aria-label="分类筛选" value={category} onChange={event => setCategory(event.target.value as TaskCategory | 'all')}>{Object.entries(categoryLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
      <select aria-label="状态筛选" value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="all">全部状态</option><option value="active">启用中</option><option value="paused">已暂停</option><option value="completed">已完成</option></select>
      <select aria-label="员工筛选" value={employeeFilter} onChange={event => setEmployeeFilter(event.target.value)}><option value="">全部员工</option>{experts.map(expert => <option key={expert.employee_id} value={expert.employee_id}>{expert.display_name}</option>)}</select>
    </div>
    <div className={styles.resultsHeading}><span><SlidersHorizontal size={14} />{hasFilters ? '筛选结果' : '全部任务'} · {tasks.length}{cursor ? '+' : ''} 项</span>{hasFilters && <button type="button" onClick={clearFilters}>清除筛选</button>}{loading && tasks.length > 0 && <small role="status">正在更新…</small>}</div>
    <div className={styles.tasksLayout}>
      <section className={styles.taskList} aria-label="任务列表" aria-busy={loading}>
        {loading && !filteredTasks.length && <div className={styles.emptyState}><LoaderCircle className={styles.spinner} size={24} />正在加载任务…</div>}
        {!loading && !filteredTasks.length && <div className={styles.emptyState}><CalendarClock size={40} /><strong>{error ? '暂时无法读取任务' : hasFilters ? '没有匹配的任务' : '从一项重复工作开始'}</strong><span>{error ? '请检查服务连接后重试。' : hasFilters ? '试试其他关键词，或清除筛选条件。' : '为 AI 员工安排定时报告、监控或提醒。'}</span><button type="button" disabled={busy} onClick={error ? () => void loadTasks() : hasFilters ? clearFilters : startCreate}>{error ? '重新加载' : hasFilters ? '清除筛选' : '创建第一个任务'}</button></div>}
        {filteredTasks.map(task => <button type="button" key={task.task_id} className={`${styles.taskCard} ${selected?.task_id === task.task_id ? styles.taskCardSelected : ''}`} disabled={busy} aria-pressed={selected?.task_id === task.task_id} onClick={() => void openTask(task)}>
          <div className={styles.taskCardTop}><span className={styles.categoryLabel}>{categoryLabels[task.category]}</span><StatusPill status={task.status} /><ChevronRight size={16} /></div><strong>{task.name}</strong><span className={styles.taskCardEmployee}>{task.employee?.display_name ?? '员工不可用'}</span><span className={styles.taskCardPrompt}>{task.prompt_summary}</span><span className={styles.taskCardSchedule}><Clock3 size={13} />{scheduleLabel(task.schedule)}</span><small>下次执行：{formatDate(task.next_run_at)}</small>{task.last_run && <small>上次结果：{statusLabels[task.last_run.status] ?? task.last_run.status}</small>}
        </button>)}
        {cursor && <button className={styles.loadMore} type="button" disabled={loading} onClick={() => void loadTasks(cursor)}>加载更多任务</button>}
      </section>
      <section className={styles.taskDetail} aria-label={editing ? '编辑任务' : '任务详情'} aria-busy={detailLoading}>
        {detailLoading ? <div className={styles.detailPlaceholder} role="status"><LoaderCircle className={styles.spinner} size={24} /><span>正在读取任务详情与运行记录…</span></div> : editing ? <TaskForm draft={draft} experts={experts} connectors={connectors} selected={selected} busy={busy} onChange={updateDraft} onSubmit={save} onCancel={() => setEditing(false)} /> : selected ? <TaskDetail task={selected} runs={runs} runCursor={runCursor} busy={busy} confirmDelete={confirmDelete} onEdit={() => { setDraft(draftFromTask(selected)); setEditing(true) }} onAction={changeAction} onConfirmDelete={setConfirmDelete} onLoadMoreRuns={loadMoreRuns} onOpenConversation={() => selected.conversation_id && navigate(`${selected.target_kind === 'group' ? '/group-chat' : '/chat'}/${encodeURIComponent(selected.conversation_id)}`)} /> : <div className={styles.detailPlaceholder}><Zap size={28} /><span>选择任务查看详情与运行记录。</span></div>}
      </section>
    </div>
  </div>
}

function TaskForm({ draft, experts, connectors, selected, busy, onChange, onSubmit, onCancel }: { draft: Draft; experts: ExpertProjection[]; connectors: Connector[]; selected: AutomationTask | null; busy: boolean; onChange: <K extends keyof Draft>(key: K, value: Draft[K]) => void; onSubmit: (event: FormEvent) => void; onCancel: () => void }) {
  const dialogRef = useDialogFocus<HTMLElement>()
  return <form ref={dialogRef as unknown as Ref<HTMLFormElement>} className={styles.taskForm} onSubmit={onSubmit}><div className={styles.detailHeader}><div><span className={styles.detailEyebrow}>{selected ? '编辑任务' : '新建任务'}</span><h2>{selected ? selected.name : '创建自动化任务'}</h2></div><button type="button" className={styles.iconButton} disabled={busy} onClick={onCancel} aria-label="关闭"><X size={17} /></button></div>
    <fieldset className={styles.formFields} disabled={busy}><legend className={styles.visuallyHidden}>任务配置</legend>
    <label>任务名称<input placeholder="例如：每周销售报告" required maxLength={120} value={draft.name} onChange={event => onChange('name', event.target.value)} /></label>
    <label>执行指令<textarea placeholder="描述要完成的工作、使用的资料和期望的输出…" required maxLength={20_000} rows={6} value={draft.prompt} onChange={event => onChange('prompt', event.target.value)} /></label>
    <div className={styles.formGrid}><label>任务分类<select value={draft.category} onChange={event => onChange('category', event.target.value as TaskCategory)}>{Object.entries(categoryLabels).filter(([key]) => key !== 'all').map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>执行员工<select required value={draft.employeeId} onChange={event => { onChange('employeeId', event.target.value); onChange('connectorIds', []) }}><option value="">请选择员工</option>{experts.map(expert => <option key={expert.employee_id} value={expert.employee_id}>{expert.display_name}</option>)}</select></label></div>
    <fieldset><legend>使用的连接器</legend>{draft.employeeId && !connectors.length && <p className={styles.formHint}>该员工暂无可用连接器，可不选择继续创建。</p>}{connectors.map(connector => <label className={styles.checkbox} key={connector.connector_id}><input type="checkbox" checked={draft.connectorIds.includes(connector.connector_id)} disabled={connector.status !== 'enabled'} onChange={event => onChange('connectorIds', event.target.checked ? [...draft.connectorIds, connector.connector_id] : draft.connectorIds.filter(id => id !== connector.connector_id))} />{connector.display_name}</label>)}</fieldset>
    <div className={styles.formGrid}><label>执行频率<select value={draft.mode} onChange={event => onChange('mode', event.target.value as TaskSchedule['mode'])}>{runModes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>时区<input required value={draft.timezone} onChange={event => onChange('timezone', event.target.value)} placeholder="Asia/Shanghai" /></label></div>
    {['daily', 'weekly', 'monthly'].includes(draft.mode) && <label>当地执行时间<input required type="time" step="1" value={draft.time} onChange={event => onChange('time', event.target.value)} /></label>}
    {draft.mode === 'weekly' && <label>星期<select value={draft.weekday} onChange={event => onChange('weekday', Number(event.target.value))}>{'一二三四五六日'.split('').map((day, index) => <option key={day} value={index + 1}>周{day}</option>)}</select></label>}
    {draft.mode === 'monthly' && <label>每月日期<input required type="number" min={1} max={31} value={draft.dayOfMonth} onChange={event => onChange('dayOfMonth', Number(event.target.value))} /><span className={styles.formHint}>没有该日期的月份将跳过执行。</span></label>}
    {['once', 'interval'].includes(draft.mode) && <label>{draft.mode === 'once' ? '执行时间' : '起始时间'}<input required type="datetime-local" value={draft.startAt} onChange={event => onChange('startAt', event.target.value)} /></label>}
    {draft.mode === 'interval' && <label>间隔分钟<input required type="number" min={5} value={draft.intervalMinutes} onChange={event => onChange('intervalMinutes', Number(event.target.value))} /></label>}
    <p className={styles.formHint}>计划预览：{draft.mode === 'once' ? '按所选时间执行一次' : draft.mode === 'interval' ? `每 ${draft.intervalMinutes} 分钟执行` : `${runModes.find(([mode]) => mode === draft.mode)?.[1]} ${draft.time}`} · {draft.timezone}。单次与间隔起始时间使用本机时区。</p>
    </fieldset>
    <div className={styles.formActions}><button className={styles.secondaryButton} type="button" disabled={busy} onClick={onCancel}>取消</button><button className={styles.saveButton} type="submit" disabled={busy}>{busy ? <><LoaderCircle size={15} className={styles.saveSpinner} />保存中…</> : <><Check size={15} strokeWidth={2.4} />保存任务</>}</button></div>
  </form>
}

function TaskDetail({ task, runs, runCursor, busy, confirmDelete, onEdit, onAction, onConfirmDelete, onLoadMoreRuns, onOpenConversation }: { task: AutomationTask; runs: TaskRun[]; runCursor: string | null; busy: boolean; confirmDelete: boolean; onEdit: () => void; onAction: (action: 'enable' | 'pause' | 'delete') => void; onConfirmDelete: (value: boolean) => void; onLoadMoreRuns: () => void; onOpenConversation: () => void }) {
  return <div className={styles.detailPanel}><div className={styles.detailHeader}><div><span className={styles.detailEyebrow}>{categoryLabels[task.category]}</span><h2>{task.name}</h2></div><StatusPill status={task.status} /></div><p className={styles.detailPrompt}>{task.prompt ?? task.prompt_summary}</p><div className={styles.detailMeta}><div><span>执行员工</span><strong>{task.employee?.display_name ?? '员工不可用'}</strong></div><div><span>执行周期</span><strong>{scheduleLabel(task.schedule)}</strong></div><div><span>下一次执行</span><strong>{formatDate(task.next_run_at)}</strong></div></div>{task.block_reason && <div className={styles.warningBox}>当前无法执行：{task.block_reason}</div>}<div className={styles.detailActions}><button className={styles.primaryButton} type="button" disabled={busy} onClick={onEdit}><Zap size={14} />编辑</button>{task.status !== 'completed' && task.schedule && <button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => onAction(task.status === 'active' ? 'pause' : 'enable')}>{task.status === 'active' ? <><Pause size={14} />暂停</> : <><Play size={14} />启用</>}</button>}{task.conversation_id && <button className={styles.secondaryButton} type="button" onClick={onOpenConversation}><ExternalLink size={14} />打开会话</button>}<button className={styles.dangerButton} type="button" disabled={busy} onClick={() => onConfirmDelete(true)}><Trash2 size={14} />删除</button></div>{confirmDelete && <div className={styles.confirmBox} role="alert"><p>删除后会停止后续调度，但已有会话和运行记录会保留。确定删除？</p><div><button className={styles.secondaryButton} type="button" onClick={() => onConfirmDelete(false)}>取消</button><button className={styles.dangerButton} type="button" disabled={busy} onClick={() => onAction('delete')}>确认删除</button></div></div>}<div className={styles.runsHeader}><h3>运行记录</h3><span>{runs.length} 条</span></div>{!runs.length ? <p className={styles.formHint}>暂无关联的运行记录。</p> : <div className={styles.runsList}>{runs.map(run => <article className={styles.runItem} key={run.run_id}><div><StatusPill status={run.status} /><span>{formatDate(run.scheduled_at)}</span></div>{run.result_summary && <p>{run.result_summary}</p>}{run.error_code && <small>{run.error_code}</small>}{run.conversation_id && <button type="button" onClick={onOpenConversation}>查看执行会话</button>}</article>)}</div>}{runCursor && <button className={styles.loadMore} type="button" disabled={busy} onClick={onLoadMoreRuns}>更多运行记录</button>}</div>
}
