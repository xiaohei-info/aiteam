import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertCircle,
  BookOpen,
  CornerDownLeft,
  History,
  ListTodo,
  MessageCircle,
  RefreshCw,
  Search,
  Users,
  X,
} from 'lucide-react'
import './CommandPalette.css'
import { getAvatarFallback, getEmployeeAvatar, renderAvatar } from '../../lib/avatarUtils'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'
import { useChatStore } from '../../stores/chat'
import { openEmployeeChat } from '../../lib/openEmployeeChat'
import {
  buildCommandPaletteConversationSources,
  moveCommandPaletteSelection,
  moveTrappedFocus,
  searchCommandPalette,
  UNAVAILABLE_SEARCH_SOURCES,
  type CommandPaletteResult,
} from './commandPaletteSearch'
import { GLOBAL_SEARCH_REQUEST_EVENT } from './globalSearch'
import { requestHistorySearch } from './historySearch'

const FOCUSABLE_SELECTOR = [
  'button:not(:disabled)',
  'input:not(:disabled)',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function getOptionId(index: number): string {
  return `command-palette-option-${index}`
}

export default function CommandPalette() {
  const navigate = useNavigate()
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const isOpenRef = useRef(false)
  const restoreTimerRef = useRef<number | null>(null)

  const conversations = useChatStore((state) => state.conversations)
  const groups = useChatStore((state) => state.groups)
  const workbenchEmployees = useChatStore((state) => state.workbenchEmployees)
  const workbenchLoading = useChatStore((state) => state.workbenchLoading)
  const workbenchRefreshing = useChatStore((state) => state.workbenchRefreshing)
  const workbenchError = useChatStore((state) => state.workbenchError)
  const loadAgentsAndConversations = useChatStore((state) => state.loadAgentsAndConversations)
  const setActiveConvId = useChatStore((state) => state.setActiveConvId)
  const setActiveGroupId = useChatStore((state) => state.setActiveGroupId)

  const employeeSources = useMemo(() => workbenchEmployees.map((employee) => ({
    employeeId: employee.employeeId,
    displayName: employee.displayName,
    roleName: employee.roleName,
    skills: employee.skills,
    persona: employee.persona,
    targetConversationId: employee.conversationId ?? `emp_${employee.employeeId}`,
    avatarUrl: employee.avatarUrl,
  })), [workbenchEmployees])

  const conversationSources = useMemo(() => {
    return buildCommandPaletteConversationSources({
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        lastMessage: conversation.lastMessage,
        employeeId: conversation._employeeId,
      })),
      groups,
      employees: workbenchEmployees,
    })
  }, [conversations, groups, workbenchEmployees])

  const results = useMemo(() => searchCommandPalette({
    query,
    employees: employeeSources,
    conversations: conversationSources,
  }), [conversationSources, employeeSources, query])

  const actionableResults = useMemo(
    () => [...results.employees, ...results.conversations],
    [results.conversations, results.employees],
  )
  const resultIndexByKey = useMemo(
    () => new Map(actionableResults.map((result, index) => [result.key, index])),
    [actionableResults],
  )
  const hasWorkbenchData = employeeSources.length > 0 || conversationSources.length > 0
  const isInitialLoading = workbenchLoading && !hasWorkbenchData
  const normalizedQuery = query.trim()

  const handleClose = useCallback(() => {
    if (!isOpenRef.current) return
    isOpenRef.current = false
    setIsOpen(false)
    setQuery('')
    const returnTarget = returnFocusRef.current
    if (restoreTimerRef.current !== null) window.clearTimeout(restoreTimerRef.current)
    restoreTimerRef.current = window.setTimeout(() => {
      if (returnTarget?.isConnected && !returnTarget.hasAttribute('disabled')) returnTarget.focus()
      restoreTimerRef.current = null
    }, 0)
  }, [])

  useGlobalShortcutClose({ active: isOpen, onClose: handleClose })

  const handleActivate = useCallback((result: CommandPaletteResult) => {
    if (result.kind === 'group-conversation') {
      setActiveGroupId(result.targetId)
      navigate('/group-chat')
    } else if (result.kind === 'employee' && result.targetId.startsWith('emp_')) {
      // 还没有会话的员工：对话列表不再有占位，先新建会话再跳转。
      const employeeId = result.targetId.slice(4)
      openEmployeeChat({ employeeId, displayName: result.label }, navigate).catch((err) => {
        console.error('[CommandPalette] open chat failed:', err)
        window.alert(err instanceof Error ? `发起对话失败：${err.message}` : '发起对话失败，请稍后重试')
      })
    } else {
      setActiveConvId(result.targetId)
      navigate('/chat')
    }
    handleClose()
  }, [handleClose, navigate, setActiveConvId, setActiveGroupId])

  useEffect(() => {
    const handleOpen = () => {
      if (!isOpenRef.current) {
        const activeElement = document.activeElement
        returnFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null
        setQuery('')
        setActiveIndex(-1)
      }
      isOpenRef.current = true
      setIsOpen(true)
      const workbench = useChatStore.getState()
      const hasLoadedData = workbench.workbenchEmployees.length > 0
        || workbench.conversations.length > 0
        || workbench.groups.length > 0
      if (!hasLoadedData && !workbench.workbenchError) void workbench.loadAgentsAndConversations()
      window.setTimeout(() => inputRef.current?.focus(), 0)
    }

    window.addEventListener(GLOBAL_SEARCH_REQUEST_EVENT, handleOpen)
    return () => window.removeEventListener(GLOBAL_SEARCH_REQUEST_EVENT, handleOpen)
  }, [])

  useEffect(() => () => {
    if (restoreTimerRef.current !== null) window.clearTimeout(restoreTimerRef.current)
  }, [])

  useLayoutEffect(() => {
    if (!isOpen) return
    inputRef.current?.focus()
  }, [isOpen])

  useEffect(() => {
    setActiveIndex(actionableResults.length > 0 ? 0 : -1)
  }, [actionableResults])

  useEffect(() => {
    if (activeIndex < 0) return
    document.getElementById(getOptionId(activeIndex))?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const handleBackdropMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) handleClose()
  }

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      handleClose()
      return
    }

    if (event.key === 'Tab') {
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])
        .filter((element) => element.getAttribute('aria-hidden') !== 'true')
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement)
      const nextIndex = moveTrappedFocus(currentIndex, focusable.length, event.shiftKey)
      if (nextIndex >= 0) {
        event.preventDefault()
        focusable[nextIndex].focus()
      }
      return
    }

    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    inputRef.current?.focus()
    setActiveIndex((current) => moveCommandPaletteSelection(
      current,
      actionableResults.length,
      event.key as 'ArrowDown' | 'ArrowUp' | 'Home' | 'End',
    ))
  }

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    const activeResult = actionableResults[activeIndex]
    if (!activeResult) return
    event.preventDefault()
    handleActivate(activeResult)
  }

  const handleRetry = () => {
    void loadAgentsAndConversations()
  }

  const handleOpenHistorySearch = () => {
    const initialQuery = query.trim()
    handleClose()
    window.setTimeout(() => requestHistorySearch(initialQuery), 0)
  }

  const renderResult = (result: CommandPaletteResult) => {
    const index = resultIndexByKey.get(result.key) ?? -1
    const isActive = index === activeIndex
    const isGroup = result.kind === 'group-conversation'
    const avatar = result.kind === 'employee' || result.kind === 'private-conversation'
      ? getEmployeeAvatar(result.label, result.avatarUrl)
      : null

    return (
      <button
        type="button"
        id={getOptionId(index)}
        key={result.key}
        className={`command-palette-result ${isActive ? 'selected' : ''}`}
        role="option"
        aria-selected={isActive}
        onClick={() => handleActivate(result)}
        onMouseMove={() => setActiveIndex(index)}
      >
        <span className={`command-palette-result-icon ${isGroup ? 'group' : ''}`} aria-hidden="true">
          {avatar ? renderAvatar(avatar, getAvatarFallback(result.label)) : <Users size={16} strokeWidth={1.7} />}
        </span>
        <span className="command-palette-result-copy">
          <strong>{result.label}</strong>
          <span>{result.description}</span>
        </span>
        {result.preview && <span className="command-palette-result-preview">{result.preview}</span>}
        <CornerDownLeft className="command-palette-enter" size={13} strokeWidth={1.8} aria-hidden="true" />
      </button>
    )
  }

  if (!isOpen) return null

  return (
    <div className="command-palette-backdrop" onMouseDown={handleBackdropMouseDown}>
      <div
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        aria-describedby="command-palette-description"
        onKeyDown={handleDialogKeyDown}
      >
        <header className="command-palette-header">
          <Search size={18} strokeWidth={1.8} aria-hidden="true" />
          <label className="command-palette-search-field">
            <span id="command-palette-title" className="command-palette-sr-only">全局搜索</span>
            <input
              ref={inputRef}
              value={query}
              type="search"
              role="combobox"
              aria-autocomplete="list"
              aria-controls="command-palette-actionable-results"
              aria-expanded="true"
              aria-activedescendant={activeIndex >= 0 ? getOptionId(activeIndex) : undefined}
              autoComplete="off"
              autoFocus
              placeholder="搜索员工或会话"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleInputKeyDown}
            />
          </label>
          {(workbenchRefreshing || (workbenchLoading && hasWorkbenchData)) && (
            <span className="command-palette-refreshing" role="status">正在更新</span>
          )}
          <button
            type="button"
            className="command-palette-close"
            onClick={handleClose}
            aria-label="关闭全局搜索"
            aria-keyshortcuts="Meta+W Control+W"
            title="关闭全局搜索（⌘W / Ctrl+W）"
          >
            <X size={16} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </header>

        <p id="command-palette-description" className="command-palette-sr-only">
          输入关键词搜索真实员工和会话。任务与知识服务未开放时会显示不可用原因。
        </p>

        <div className="command-palette-results">
          {workbenchError && (
            <div className="command-palette-error" role="alert">
              <AlertCircle size={16} strokeWidth={1.8} aria-hidden="true" />
              <span>
                <strong>{hasWorkbenchData ? '数据更新失败，当前显示上次结果' : workbenchError.title}</strong>
                <small>{workbenchError.message}</small>
              </span>
              <button type="button" onClick={handleRetry} disabled={workbenchLoading || workbenchRefreshing}>
                <RefreshCw size={13} strokeWidth={1.9} aria-hidden="true" />
                {workbenchLoading || workbenchRefreshing ? '重试中' : '重试'}
              </button>
            </div>
          )}

          {isInitialLoading && (
            <div className="command-palette-loading" role="status" aria-label="正在加载员工与会话">
              {[0, 1, 2].map((item) => (
                <span className="command-palette-skeleton" key={item}>
                  <i />
                  <b />
                </span>
              ))}
            </div>
          )}

          <div
            id="command-palette-actionable-results"
            className="command-palette-actionable"
            role="listbox"
            aria-label="员工与会话搜索结果"
          >
            {!isInitialLoading && (!workbenchError || hasWorkbenchData) && (
              <>
              <section className="command-palette-section" role="group" aria-labelledby="command-palette-employees-title">
                <h2 id="command-palette-employees-title">
                  <Users size={13} strokeWidth={1.8} aria-hidden="true" />
                  员工
                  <span>{results.employees.length}</span>
                </h2>
                {results.employees.length > 0 ? results.employees.map(renderResult) : (
                  <p className="command-palette-empty">
                    {normalizedQuery ? '没有匹配的员工' : '当前没有可用员工'}
                  </p>
                )}
              </section>

              <section className="command-palette-section" role="group" aria-labelledby="command-palette-conversations-title">
                <h2 id="command-palette-conversations-title">
                  <MessageCircle size={13} strokeWidth={1.8} aria-hidden="true" />
                  会话
                  <span>{results.conversations.length}</span>
                </h2>
                {results.conversations.length > 0 ? results.conversations.map(renderResult) : (
                  <p className="command-palette-empty">
                    {normalizedQuery ? '没有匹配的真实会话' : '当前没有已创建的会话'}
                  </p>
                )}
              </section>
              </>
            )}
          </div>

          <section className="command-palette-section history" aria-labelledby="command-palette-history-title">
            <h2 id="command-palette-history-title">
              <History size={13} strokeWidth={1.8} aria-hidden="true" />
              消息历史
            </h2>
            <button type="button" className="command-palette-history-action" onClick={handleOpenHistorySearch}>
              <span className="command-palette-result-icon" aria-hidden="true">
                <History size={16} strokeWidth={1.7} />
              </span>
              <span>
                <strong>搜索全部消息历史</strong>
                <small>分页扫描所有私聊与群聊，可按员工和日期筛选</small>
              </span>
              <CornerDownLeft size={13} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </section>

          <section className="command-palette-section unavailable" aria-labelledby="command-palette-unavailable-title">
            <h2 id="command-palette-unavailable-title">当前不可用</h2>
            {UNAVAILABLE_SEARCH_SOURCES.map((source) => (
              <div className="command-palette-unavailable" key={source.key} aria-disabled="true">
                <span className="command-palette-result-icon" aria-hidden="true">
                  {source.key === 'tasks'
                    ? <ListTodo size={16} strokeWidth={1.7} />
                    : <BookOpen size={16} strokeWidth={1.7} />}
                </span>
                <span>
                  <strong>{source.label}搜索不可用</strong>
                  <small>{source.reason}</small>
                </span>
              </div>
            ))}
          </section>
        </div>

        <footer className="command-palette-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>↵</kbd> 打开</span>
          <span><kbd>esc</kbd> 关闭</span>
        </footer>
      </div>
    </div>
  )
}
