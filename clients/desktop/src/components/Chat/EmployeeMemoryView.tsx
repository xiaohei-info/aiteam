/**
 * 员工详情的「记忆」二级视图:和自动化任务同一形态(.adp-nested-view,顶部「‹ 返回」)。
 * 普通成员只看到自己对话产生的记忆并可删除;其他成员贡献的只显示数量。
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, LoaderCircle, MoreHorizontal, Search } from 'lucide-react'
import { agentApi } from '../../api/agent'
import type { EmployeeMemory } from '../../api/agent/employeeMemories'
import type { MemorySummaryState } from '../../hooks/useEmployeeMemorySummary'
import {
  MEMORY_DELETE_CONFIRM_TEXT, MEMORY_EMPTY_TEXT, MEMORY_GROUP_LABELS, MEMORY_PAGE_SIZE, MEMORY_SEARCH_DEBOUNCE_MS,
  MEMORY_SEARCH_EMPTY_TEXT, appendMemoryPage, describeHiddenMemories, describeMemoryDeleteError, describeMemoryProblem,
  describeMemorySummary, groupMemories, isLongMemory, memoryImportanceStars, memoryTimeLabel, normalizeMemoryKeyword,
  type MemoryProblem,
} from '../../lib/employeeMemory'

interface EmployeeMemoryViewProps {
  employeeId: string
  employeeName: string
  summary: MemorySummaryState
  onSummaryChange: () => void
  onClose: () => void
}

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; items: EmployeeMemory[]; nextCursor: string | null; total: number; truncated: boolean }
  | { status: 'error'; problem: MemoryProblem }

const DELETE_NOTICE_MS = 5_000

export default function EmployeeMemoryView({ employeeId, employeeName, summary, onSummaryChange, onClose }: EmployeeMemoryViewProps) {
  const [input, setInput] = useState('')
  const [keyword, setKeyword] = useState<string | undefined>(undefined)
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [menuId, setMenuId] = useState<string | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [notice, setNotice] = useState('')
  const loadMoreController = useRef<AbortController | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setKeyword(normalizeMemoryKeyword(input)), MEMORY_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [input])

  useEffect(() => {
    const controller = new AbortController()
    loadMoreController.current?.abort()
    setLoadingMore(false)
    setLoadMoreError('')
    setPendingDeleteId(null)
    setMenuId(null)
    setList({ status: 'loading' })
    agentApi.listEmployeeMemories(employeeId, { scope: 'mine', keyword, limit: MEMORY_PAGE_SIZE }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setList({ status: 'ready', items: result.data, nextCursor: result.page.has_more ? result.page.next_cursor : null, total: result.meta.total, truncated: result.meta.truncated })
      })
      .catch((error) => { if (!controller.signal.aborted) setList({ status: 'error', problem: describeMemoryProblem(error) }) })
    return () => controller.abort()
  }, [employeeId, keyword, attempt])

  useEffect(() => () => loadMoreController.current?.abort(), [])

  useEffect(() => {
    if (!notice) return undefined
    const timer = setTimeout(() => setNotice(''), DELETE_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const loadMore = async () => {
    if (list.status !== 'ready' || !list.nextCursor || loadingMore) return
    const controller = new AbortController()
    loadMoreController.current = controller
    setLoadingMore(true)
    setLoadMoreError('')
    try {
      const result = await agentApi.listEmployeeMemories(employeeId, { scope: 'mine', keyword, cursor: list.nextCursor, limit: MEMORY_PAGE_SIZE }, controller.signal)
      if (controller.signal.aborted) return
      setList((current) => current.status === 'ready'
        ? { ...current, items: appendMemoryPage(current.items, result.data), nextCursor: result.page.has_more ? result.page.next_cursor : null, total: result.meta.total, truncated: result.meta.truncated }
        : current)
    } catch (error) {
      if (!controller.signal.aborted) setLoadMoreError(describeMemoryProblem(error).text)
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false)
    }
  }

  const confirmDelete = async (memory: EmployeeMemory) => {
    if (deletingId) return
    setDeletingId(memory.memory_id)
    setDeleteError('')
    try {
      await agentApi.deleteEmployeeMemory(employeeId, memory.memory_id)
      setList((current) => current.status === 'ready'
        ? { ...current, items: current.items.filter((item) => item.memory_id !== memory.memory_id), total: Math.max(0, current.total - 1) }
        : current)
      setPendingDeleteId(null)
      setNotice('已删除这条记忆')
      onSummaryChange()
    } catch (error) {
      setDeleteError(describeMemoryDeleteError(error))
    } finally {
      setDeletingId(null)
    }
  }

  const toggleExpanded = (memoryId: string) => setExpanded((current) => {
    const next = new Set(current)
    if (next.has(memoryId)) next.delete(memoryId)
    else next.add(memoryId)
    return next
  })

  const summaryData = summary.status === 'ready' ? summary.data : null
  const count = summaryData?.total_count ?? (list.status === 'ready' && !keyword ? list.total : null)
  const hidden = summaryData ? describeHiddenMemories(summaryData) : null
  const truncated = Boolean(summaryData?.truncated || (list.status === 'ready' && list.truncated))

  const renderMemory = (memory: EmployeeMemory) => {
    const stars = memoryImportanceStars(memory.importance)
    const time = memoryTimeLabel(memory)
    const long = isLongMemory(memory.content)
    const open = expanded.has(memory.memory_id)
    const confirming = pendingDeleteId === memory.memory_id
    return (
      <article className="adp-memory-item" key={memory.memory_id}>
        <p className={`adp-memory-content${long && !open ? ' clamped' : ''}`}>{memory.content}</p>
        {long && (
          <button type="button" className="adp-memory-expand" aria-expanded={open} onClick={() => toggleExpanded(memory.memory_id)}>
            {open ? '收起' : '展开'}
          </button>
        )}
        <div className="adp-memory-meta">
          <span className="adp-memory-category">{memory.category}</span>
          {stars !== null && (
            <span className="adp-memory-stars" role="img" aria-label={`重要度 ${stars} / 4`} title={`重要度 ${stars} / 4`}>
              {'★'.repeat(stars)}<span className="off">{'★'.repeat(4 - stars)}</span>
            </span>
          )}
          {time && <span>{time}</span>}
          <span className="grow" />
          {memory.is_mine && (
            <span className="adp-memory-menu-anchor">
              <button
                type="button"
                className="adp-memory-more"
                aria-label="更多操作"
                aria-haspopup="menu"
                aria-expanded={menuId === memory.memory_id}
                onClick={() => setMenuId((current) => current === memory.memory_id ? null : memory.memory_id)}
              >
                <MoreHorizontal size={14} aria-hidden="true" />
              </button>
              {menuId === memory.memory_id && (
                <span className="adp-memory-menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => { setMenuId(null); setDeleteError(''); setPendingDeleteId(memory.memory_id) }}>删除这条记忆</button>
                </span>
              )}
            </span>
          )}
        </div>
        {confirming && (
          <div className="adp-memory-confirm" role="group" aria-label="确认删除这条记忆">
            <span>{MEMORY_DELETE_CONFIRM_TEXT}</span>
            {deleteError && <span className="adp-memory-confirm-error" role="alert">{deleteError}</span>}
            <div className="adp-task-item-actions">
              <button type="button" onClick={() => setPendingDeleteId(null)} disabled={deletingId !== null}>取消</button>
              <button type="button" className="danger" onClick={() => void confirmDelete(memory)} disabled={deletingId !== null}>
                {deletingId === memory.memory_id ? '删除中…' : '删除'}
              </button>
            </div>
          </div>
        )}
      </article>
    )
  }

  return (
    <div className="adp-nested-view" role="dialog" aria-label={`${employeeName}的记忆`}>
      <div className="adp-nested-header">
        <button type="button" className="adp-nested-back" aria-label="返回员工详情" title="返回员工详情" onClick={onClose}><ChevronLeft size={18} aria-hidden="true" /></button>
        <strong>{employeeName}的记忆</strong>
      </div>
      <div className="adp-nested-body adp-memory-body" aria-busy={list.status === 'loading' || loadingMore}>
        <div className="adp-memory-summary">
          {count !== null && <><b className="font-number">{count}</b><span>条</span></>}
          {summaryData && <span className="muted">· {describeMemorySummary(summaryData)}</span>}
        </div>
        <p className="adp-memory-note">只显示由你的对话产生的记忆。</p>
        {truncated && <p className="adp-memory-note">记忆较多，统计只覆盖已扫描的部分。</p>}
        <label className="adp-memory-search">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            value={input}
            maxLength={1024}
            placeholder="搜索记忆"
            aria-label="搜索记忆"
            onChange={(event) => setInput(event.target.value)}
          />
        </label>

        {list.status === 'loading' && <div className="adp-nested-state"><LoaderCircle className="adp-nested-spinner" size={18} />正在加载记忆…</div>}
        {list.status === 'error' && (
          <div className="adp-nested-state adp-nested-error">
            <span>{list.problem.text}</span>
            {list.problem.retry && <button type="button" onClick={() => setAttempt((value) => value + 1)}>重试</button>}
          </div>
        )}
        {list.status === 'ready' && list.items.length === 0 && (
          <div className="adp-nested-state">{keyword ? MEMORY_SEARCH_EMPTY_TEXT : MEMORY_EMPTY_TEXT}</div>
        )}
        {list.status === 'ready' && groupMemories(list.items).map((group) => (
          <section className="adp-memory-group" key={group.key} aria-label={MEMORY_GROUP_LABELS[group.key]}>
            <h4>{MEMORY_GROUP_LABELS[group.key]}</h4>
            {group.items.map(renderMemory)}
          </section>
        ))}
        {list.status === 'ready' && list.nextCursor && (
          <div className="adp-memory-more-row">
            {loadMoreError && <span role="alert">{loadMoreError}</span>}
            <button type="button" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? '加载中…' : loadMoreError ? '重试' : '加载更多'}</button>
          </div>
        )}
        {list.status !== 'loading' && hidden && <p className="adp-memory-hidden">{hidden}</p>}
      </div>
      <div className="adp-memory-notice" role="status" aria-live="polite">{notice}</div>
    </div>
  )
}
