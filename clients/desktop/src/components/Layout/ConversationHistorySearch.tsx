import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import {
  AlertCircle,
  CalendarDays,
  History,
  MessageCircle,
  RefreshCw,
  Search,
  Square,
  Users,
  X,
} from 'lucide-react'
import './ConversationHistorySearch.css'
import { agentApi } from '../../api/agent'
import { searchLocalMessages } from '../../lib/localMessageSearch'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'
import {
  buildSolutionEmployeeIds,
  isHistorySearchAbortError,
  parseHistorySearchDate,
  type ConversationHistorySearchFilters,
  type ConversationHistorySearchProgress,
  type ConversationHistorySearchResponse,
  type ConversationHistorySearchResult,
} from '../../lib/conversationHistorySearch'
import { classifyRequestError, type RequestErrorInfo } from '../../lib/requestError'
import { useChatStore } from '../../stores/chat'
import { HISTORY_SEARCH_REQUEST_EVENT } from './historySearch'

type SearchStatus = 'idle' | 'searching' | 'complete' | 'cancelled' | 'error'

const INITIAL_PROGRESS: ConversationHistorySearchProgress = {
  phase: 'conversations',
  discoveredConversations: 0,
  scannedConversations: 0,
  totalConversations: null,
  failedConversations: 0,
  matchedEntries: 0,
}
const INITIAL_VISIBLE_RESULT_COUNT = 100
const VISIBLE_RESULT_STEP = 100

function formatResultTime(timestamp: number | null): string {
  if (timestamp === null) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

function HighlightedSnippet({ text, query }: { text: string; query: string }) {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const index = text.toLocaleLowerCase().indexOf(normalizedQuery)
  if (!normalizedQuery || index < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + normalizedQuery.length)}</mark>
      {text.slice(index + normalizedQuery.length)}
    </>
  )
}

export default function ConversationHistorySearch() {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const runIdRef = useRef(0)
  const lastFiltersRef = useRef<ConversationHistorySearchFilters | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [status, setStatus] = useState<SearchStatus>('idle')
  const [progress, setProgress] = useState(INITIAL_PROGRESS)
  const [response, setResponse] = useState<ConversationHistorySearchResponse | null>(null)
  const [requestError, setRequestError] = useState<RequestErrorInfo | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [visibleResultCount, setVisibleResultCount] = useState(INITIAL_VISIBLE_RESULT_COUNT)
  const dialogRef = useDialogFocus<HTMLDivElement>({ active: isOpen, initialFocusRef: inputRef })

  const conversations = useChatStore((state) => state.conversations)
  const groups = useChatStore((state) => state.groups)
  const groupSolutions = useChatStore((state) => state.groupSolutions)
  const workbenchEmployees = useChatStore((state) => state.workbenchEmployees)
  const addConversation = useChatStore((state) => state.addConversation)
  const addGroup = useChatStore((state) => state.addGroup)
  const setActiveConvId = useChatStore((state) => state.setActiveConvId)
  const setActiveGroupId = useChatStore((state) => state.setActiveGroupId)
  const setHighlightMsgId = useChatStore((state) => state.setHighlightMsgId)

  const conversationEmployeeIds = useMemo(() => {
    const result = new Map<string, readonly string[]>()
    for (const conversation of conversations) {
      if (conversation._employeeId) result.set(conversation.id, [conversation._employeeId])
    }
    for (const group of groups) {
      result.set(group.id, (group.members ?? []).map((member) => member.employee_id))
    }
    return result
  }, [conversations, groups])
  const solutionEmployeeIds = useMemo(
    () => buildSolutionEmployeeIds(groupSolutions),
    [groupSolutions],
  )

  const close = useCallback(() => {
    runIdRef.current += 1
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    setIsOpen(false)
  }, [])

  useGlobalShortcutClose({ active: isOpen, onClose: close })

  useEffect(() => {
    const handleOpen = (event: CustomEvent<{ initialQuery?: string }>) => {
      runIdRef.current += 1
      abortControllerRef.current?.abort()
      abortControllerRef.current = null
      const initialQuery = event.detail?.initialQuery ?? ''
      setQuery(initialQuery)
      setEmployeeId('')
      setStartDate('')
      setEndDate('')
      setStatus('idle')
      setProgress(INITIAL_PROGRESS)
      setResponse(null)
      setRequestError(null)
      setValidationError(null)
      setVisibleResultCount(INITIAL_VISIBLE_RESULT_COUNT)
      setIsOpen(true)
    }
    window.addEventListener(HISTORY_SEARCH_REQUEST_EVENT, handleOpen)
    return () => window.removeEventListener(HISTORY_SEARCH_REQUEST_EVENT, handleOpen)
  }, [])

  useEffect(() => {
    if (!isOpen) return undefined
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [close, isOpen])

  useEffect(() => () => abortControllerRef.current?.abort(), [])

  const executeSearch = useCallback(async (filters: ConversationHistorySearchFilters) => {
    abortControllerRef.current?.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller
    const runId = runIdRef.current + 1
    runIdRef.current = runId
    lastFiltersRef.current = filters
    setStatus('searching')
    setProgress(INITIAL_PROGRESS)
    setResponse(null)
    setRequestError(null)
    setValidationError(null)
    setVisibleResultCount(INITIAL_VISIBLE_RESULT_COUNT)

    try {
      const nextResponse = await searchLocalMessages(agentApi, filters, {
        signal: controller.signal,
        concurrency: 4,
        conversationEmployeeIds,
        solutionEmployeeIds,
        onProgress: (nextProgress) => {
          if (runIdRef.current === runId) setProgress(nextProgress)
        },
      })
      if (runIdRef.current !== runId) return
      setResponse(nextResponse)
      if (nextResponse.discoveredConversations > 0
        && nextResponse.failures.length === nextResponse.discoveredConversations) {
        setRequestError({
          kind: 'unknown',
          title: '消息历史读取失败',
          message: '所有会话都读取失败，没有生成不完整的搜索结果。请重试。',
        })
        setStatus('error')
      } else {
        setStatus('complete')
      }
    } catch (error) {
      if (runIdRef.current !== runId) return
      if (controller.signal.aborted || isHistorySearchAbortError(error)) {
        setStatus('cancelled')
        return
      }
      setRequestError(classifyRequestError(error, '无法读取完整会话目录，请稍后重试。'))
      setStatus('error')
    } finally {
      if (abortControllerRef.current === controller) abortControllerRef.current = null
    }
  }, [conversationEmployeeIds, solutionEmployeeIds])

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedQuery = query.trim()
    if (!normalizedQuery) {
      setValidationError('请输入搜索关键词。')
      inputRef.current?.focus()
      return
    }
    const startAt = startDate ? parseHistorySearchDate(startDate) : undefined
    const endAt = endDate ? parseHistorySearchDate(endDate, true) : undefined
    if ((startDate && startAt === undefined) || (endDate && endAt === undefined)) {
      setValidationError('请输入有效日期。')
      return
    }
    if (startAt !== undefined && endAt !== undefined && startAt > endAt) {
      setValidationError('开始日期不能晚于结束日期。')
      return
    }
    void executeSearch({
      query: normalizedQuery,
      employeeId: employeeId || undefined,
      startAt,
      endAt,
    })
  }

  const handleRetry = () => {
    const filters = lastFiltersRef.current
    if (filters) void executeSearch(filters)
  }

  const handleCancelSearch = () => {
    abortControllerRef.current?.abort()
  }

  const handleResult = async (result: ConversationHistorySearchResult) => {
    try {
      const located = await agentApi.listEntriesPage(result.conversation.id, { entry_ref: result.entryId, limit: 1 })
      if (!located.data.entries.some(entry => entry.entry_ref === result.entryId)) throw new Error('原消息不可定位')
    } catch (error) {
      setRequestError(classifyRequestError(error, '原消息不可定位'))
      return
    }
    const conversation = result.conversation
    if (conversation.kind === 'group') {
      if (!groups.some((group) => group.id === conversation.id)) {
        addGroup({
          id: conversation.id,
          name: conversation.title?.trim() || '未命名群',
          lastMessage: '',
          time: '',
          memberCount: null,
          solutionInstanceId: conversation.solution_instance_id,
          rosterStatus: 'unavailable',
          rosterMessage: '历史会话结果未包含完整群成员，请进入会话后刷新。',
          members: [],
        })
      }
      setActiveGroupId(conversation.id)
      setHighlightMsgId(result.entryId)
      navigate('/group-chat')
    } else {
      if (!conversations.some((item) => item.id === conversation.id)) {
        const employee = workbenchEmployees.find((item) => item.employeeId === conversation.entry_employee_id)
        addConversation({
          id: conversation.id,
          title: conversation.title?.trim() || employee?.displayName || '未命名会话',
          agentEmoji: '🤖',
          agentAvatarUrl: employee?.avatarUrl ?? null,
          agentName: employee?.displayName || conversation.title?.trim() || 'AI 员工',
          lastMessage: '',
          time: '',
          lastMessageAt: result.timestamp ?? undefined,
          _employeeId: conversation.entry_employee_id ?? undefined,
        })
      }
      setActiveConvId(conversation.id)
      setHighlightMsgId(result.entryId)
      navigate('/chat')
    }
    close()
  }

  if (!isOpen) return null

  const visibleResults = response?.results.slice(0, visibleResultCount) ?? []
  const hasMoreResults = Boolean(response && visibleResultCount < response.results.length)
  const hasPartialFailure = Boolean(response
    && response.failures.length > 0
    && response.failures.length < response.discoveredConversations)
  const progressPercent = progress.totalConversations && progress.totalConversations > 0
    ? Math.round((progress.scannedConversations / progress.totalConversations) * 100)
    : null

  return createPortal(
    <div
      className="history-search-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}
    >
      <div
        ref={dialogRef}
        className="history-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-search-title"
        aria-describedby="history-search-description"
        tabIndex={-1}
      >
        <header className="history-search-header">
          <span className="history-search-heading-icon" aria-hidden="true">
            <History size={18} strokeWidth={1.8} />
          </span>
          <div>
            <h2 id="history-search-title">搜索全部消息历史</h2>
            <p id="history-search-description">扫描真实会话与消息，支持员工和日期筛选。</p>
          </div>
          <button type="button" className="history-search-close" onClick={close} aria-label="关闭消息历史搜索">
            <X size={17} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </header>

        <form className="history-search-form" onSubmit={handleSubmit}>
          <label className="history-search-query">
            <span>关键词</span>
            <span className="history-search-input-shell">
              <Search size={15} strokeWidth={1.8} aria-hidden="true" />
              <input
                ref={inputRef}
                data-dialog-initial-focus
                type="search"
                value={query}
                required
                disabled={status === 'searching'}
                autoComplete="off"
                placeholder="输入消息中的文字"
                aria-describedby={validationError ? 'history-search-validation' : undefined}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setValidationError(null)
                }}
              />
            </span>
          </label>

          <div className="history-search-filter-grid">
            <label>
              <span>员工</span>
              <select
                value={employeeId}
                disabled={status === 'searching'}
                onChange={(event) => setEmployeeId(event.target.value)}
              >
                <option value="">全部员工</option>
                {workbenchEmployees.map((employee) => (
                  <option key={employee.employeeId} value={employee.employeeId}>
                    {employee.displayName}{employee.roleName ? ` (${employee.roleName})` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>开始日期</span>
              <span className="history-search-date-shell">
                <CalendarDays size={14} strokeWidth={1.8} aria-hidden="true" />
                <input
                  type="date"
                  value={startDate}
                  disabled={status === 'searching'}
                  onChange={(event) => {
                    setStartDate(event.target.value)
                    setValidationError(null)
                  }}
                />
              </span>
            </label>
            <label>
              <span>结束日期</span>
              <span className="history-search-date-shell">
                <CalendarDays size={14} strokeWidth={1.8} aria-hidden="true" />
                <input
                  type="date"
                  value={endDate}
                  disabled={status === 'searching'}
                  onChange={(event) => {
                    setEndDate(event.target.value)
                    setValidationError(null)
                  }}
                />
              </span>
            </label>
          </div>

          <div className="history-search-form-footer">
            <p className="history-search-cost-note">
              每次搜索会分页读取全部会话，再以最多 4 路并发读取消息。
            </p>
            {status === 'searching' ? (
              <button type="button" className="history-search-cancel" onClick={handleCancelSearch}>
                <Square size={12} fill="currentColor" aria-hidden="true" />
                取消搜索
              </button>
            ) : (
              <button type="submit" className="history-search-submit">
                <Search size={14} strokeWidth={1.9} aria-hidden="true" />
                搜索
              </button>
            )}
          </div>
          {validationError && (
            <p id="history-search-validation" className="history-search-validation" role="alert">
              {validationError}
            </p>
          )}
        </form>

        <div className="history-search-content" aria-live="polite">
          {status === 'idle' && (
            <div className="history-search-empty-state">
              <MessageCircle size={28} strokeWidth={1.5} aria-hidden="true" />
              <strong>输入关键词开始搜索</strong>
              <span>结果来自 Agent 保存的真实消息，不搜索思考过程或工具参数。</span>
            </div>
          )}

          {status === 'searching' && (
            <div className="history-search-progress" role="status">
              <div className="history-search-progress-copy">
                <strong>
                  {progress.phase === 'conversations'
                    ? `正在读取会话目录，已发现 ${progress.discoveredConversations} 个会话`
                    : `正在扫描消息 ${progress.scannedConversations}/${progress.totalConversations ?? 0}`}
                </strong>
                <span>已匹配 {progress.matchedEntries} 条，失败 {progress.failedConversations} 个会话</span>
              </div>
              <div
                className={`history-search-progress-track ${progressPercent === null ? 'indeterminate' : ''}`}
                role="progressbar"
                aria-label="消息历史搜索进度"
                aria-valuemin={0}
                aria-valuemax={progress.totalConversations ?? undefined}
                aria-valuenow={progress.totalConversations ? progress.scannedConversations : undefined}
              >
                <span style={progressPercent === null ? undefined : { width: `${progressPercent}%` }} />
              </div>
            </div>
          )}

          {status === 'cancelled' && (
            <div className="history-search-notice cancelled" role="status">
              <AlertCircle size={17} strokeWidth={1.8} aria-hidden="true" />
              <span>
                <strong>搜索已取消</strong>
                <small>未展示不完整结果。可以使用相同条件重新搜索。</small>
              </span>
              <button type="button" onClick={handleRetry}>重新搜索</button>
            </div>
          )}

          {status === 'error' && requestError && (
            <div className="history-search-notice error" role="alert">
              <AlertCircle size={17} strokeWidth={1.8} aria-hidden="true" />
              <span>
                <strong>{requestError.title}</strong>
                <small>{requestError.message}</small>
              </span>
              <button type="button" onClick={handleRetry}>
                <RefreshCw size={13} strokeWidth={1.8} aria-hidden="true" />
                重试
              </button>
            </div>
          )}

          {status === 'complete' && response && (
            <>
              <div className="history-search-summary">
                <span>找到 <strong>{response.results.length}</strong> 条消息</span>
                <span>已扫描 {response.scannedConversations} 个会话</span>
              </div>

              {hasPartialFailure && (
                <details className="history-search-partial-warning">
                  <summary>
                    <AlertCircle size={15} strokeWidth={1.8} aria-hidden="true" />
                    {response.failures.length} 个会话读取失败，当前结果可能不完整
                  </summary>
                  <div>
                    {response.failures.slice(0, 8).map((failure) => (
                      <p key={failure.conversationId}>
                        <strong>{failure.conversationTitle}</strong>
                        <span>{failure.reason}</span>
                      </p>
                    ))}
                    {response.failures.length > 8 && <small>另有 {response.failures.length - 8} 个失败会话</small>}
                    <button type="button" onClick={handleRetry}>重试完整搜索</button>
                  </div>
                </details>
              )}

              {response.results.length === 0 ? (
                <div className="history-search-empty-state">
                  <Search size={28} strokeWidth={1.5} aria-hidden="true" />
                  <strong>{response.discoveredConversations === 0 ? '没有可搜索的会话' : '没有匹配的消息'}</strong>
                  <span>调整关键词、员工或日期范围后重试。</span>
                </div>
              ) : (
                <div className="history-search-results" aria-label="消息历史搜索结果">
                  {visibleResults.map((result) => (
                    <button
                      type="button"
                      className="history-search-result"
                      key={result.key}
                      onClick={() => handleResult(result)}
                      aria-label={`打开 ${result.conversation.title?.trim() || '未命名会话'} 并定位消息`}
                    >
                      <span className={`history-search-result-icon ${result.conversation.kind === 'group' ? 'group' : ''}`} aria-hidden="true">
                        {result.conversation.kind === 'group'
                          ? <Users size={16} strokeWidth={1.7} />
                          : <MessageCircle size={16} strokeWidth={1.7} />}
                      </span>
                      <span className="history-search-result-body">
                        <span className="history-search-result-heading">
                          <strong>{result.conversation.title?.trim() || '未命名会话'}</strong>
                          <time dateTime={result.timestamp === null ? undefined : new Date(result.timestamp).toISOString()}>
                            {formatResultTime(result.timestamp)}
                          </time>
                        </span>
                        <span className="history-search-result-snippet">
                          <HighlightedSnippet text={result.snippet} query={lastFiltersRef.current?.query ?? query} />
                        </span>
                        <span className="history-search-result-sender">发送者：{result.senderName}</span>
                      </span>
                    </button>
                  ))}
                  {hasMoreResults && (
                    <button
                      type="button"
                      className="history-search-more"
                      onClick={() => setVisibleResultCount((count) => count + VISIBLE_RESULT_STEP)}
                    >
                      显示更多（剩余 {response.results.length - visibleResults.length} 条）
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
