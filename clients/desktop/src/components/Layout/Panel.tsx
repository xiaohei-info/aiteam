/**
 * 聊天侧边面板，展示会话列表并提供搜索功能（支持按智能体名称或消息内容检索）。
 *
 * @注意 依赖 useChatStore 的已加载消息搜索；搜索输入有 300ms 防抖。
 *       切换会话时通过 store 的 setActiveConv 方法更新全局状态。
 */
import { useCallback, useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { CheckCheck, ChevronRight, MessageSquare, Pin, PinOff, Plus, Search, Trash2, Users } from 'lucide-react'
import './Panel.css'
import { useChatStore } from '../../stores/chat'
// Phase 2 起本地 SQLite 已经不再被业务侧读写(见 docs/archive/api-agent-migration.md §3.6)。
// 搜索改为搜索已加载的内存消息;创建智能体的欢迎消息由服务端 Pi 侧欢迎回复替代,前端不再本地插入。
import { agentApi, AgentApiError } from '../../api/agent'
import CreateGroupDialog, { type CreateGroupData } from '../Chat/CreateGroupDialog'
import GroupAvatar from '../Chat/GroupAvatar'
import ConversationUnreadBadge from './ConversationUnreadBadge'
import { getAvatarFallback, getEmployeeAvatar, renderAvatar } from '../../lib/avatarUtils'
import RequestErrorState from '../RequestState/RequestErrorState'
import { getLastReadEntryId } from '../../lib/readAnchor'
import { useGlobalShortcutClose, useGlobalShortcutNew } from '../../hooks/useGlobalShortcut'
import { resolveContextualNewAction } from '../../lib/globalShortcuts'
import { participantRoster } from '../../lib/groupRoster'

// ── Types ──────────────────────────────────────────────────────────────────────

interface AgentResult {
  convId: string
  avatarUrl?: string | null
  name: string
  profession: string
}

interface MessageResult {
  convId: string
  convAvatarUrl?: string | null
  convTitle: string
  msgId: string
  content: string
  msgType: string
}

interface ConvMsgGroup {
  convId: string
  convAvatarUrl?: string | null
  convTitle: string
  messages: MessageResult[]
}

interface PanelNotice {
  kind: 'success' | 'error'
  message: string
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Wrap first match of keyword in a highlight span */
function highlight(text: string, keyword: string): React.ReactNode {
  if (!keyword) return text
  const idx = text.toLowerCase().indexOf(keyword.toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <span className="panel-sr-highlight">{text.slice(idx, idx + keyword.length)}</span>
      {text.slice(idx + keyword.length)}
    </>
  )
}

/** Extract display text from message content (handles JSON for file/image types) */
function msgPreview(content: string, msgType: string): string {
  if (msgType === 'file' || msgType === 'image') {
    try {
      const p = JSON.parse(content)
      return `[${msgType === 'file' ? '文件' : '图片'}] ${p.name ?? ''}`
    } catch {
      return content
    }
  }
  // Strip THINKING prefix if present
  if (content.startsWith('THINKING:')) {
    const sep = content.indexOf('\n---\n')
    if (sep !== -1) return content.slice(sep + 5)
  }
  return content
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function Panel() {
  const [search, setSearch] = useState('')
  const [showCreateGroup, setShowCreateGroup] = useState(false)
  const [agentResults, setAgentResults] = useState<AgentResult[]>([])
  const [msgResults, setMsgResults] = useState<MessageResult[]>([])
  const [searching, setSearching] = useState(false)
  const [expandedConvId, setExpandedConvId] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const {
    activeConvId, conversations,
    setActiveConvId,
    setHighlightMsgId, draftsByConv, clearUnread,
    groups, workbenchEmployees,
    workbenchLoading, workbenchRefreshing, workbenchError, loadAgentsAndConversations,
    activeGroupId, setActiveGroupId, addGroup,
    dropStaleConversation,
    // 私聊会话置顶只是按账号隔离的本机偏好（localStorage）；
    // 服务端当前无 pinned_at 契约，不向用户承诺跨端同步。
    pinnedConvs, togglePinConversation,
  } = useChatStore()
  // A2 右键菜单:记录当前打开菜单的会话 id 与屏幕坐标(fixed 定位用),null = 关闭。
  // 用本地 state 而不放到 store,原因是菜单是纯 UI 短生命周期,跨会话切换会自动重置。
  const [contextMenu, setContextMenu] = useState<{ convId: string; x: number; y: number } | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [notice, setNotice] = useState<PanelNotice | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const contextMenuTriggerRef = useRef<HTMLButtonElement | null>(null)

  const location = useLocation()
  const navigate = useNavigate()

  const basePath = '/' + location.pathname.split('/')[1]
  const isGroupChat = basePath === '/group-chat'
  const employeesById = useMemo(
    () => new Map(workbenchEmployees.map((employee) => [employee.employeeId, employee])),
    [workbenchEmployees],
  )
  const canCreateGroup = true
  const contextualNewAction = resolveContextualNewAction(location.pathname, {
    canCreateChat: workbenchEmployees.length > 0,
    canCreateGroup,
  })

  const handleContextualNew = useCallback(() => {
    if (contextualNewAction === 'group') {
      setShowCreateGroup(true)
      return
    }
    if (contextualNewAction === 'chat') {
      setActiveConvId('')
      navigate('/chat')
    }
  }, [contextualNewAction, navigate, setActiveConvId])

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null)
    contextMenuTriggerRef.current?.focus()
  }, [])

  useGlobalShortcutNew(handleContextualNew, contextualNewAction !== null)
  useGlobalShortcutClose({ active: contextMenu !== null, onClose: handleCloseContextMenu })

  const handleConvClick = (convId: string) => {
    if (convId === activeConvId) return
    setActiveConvId(convId)
    // 已读由 Chat 在 entries 加载完成后用最后一个真实 entry id 上报。
  }

  const showNotice = (nextNotice: PanelNotice) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    setNotice(nextNotice)
    noticeTimerRef.current = setTimeout(() => setNotice(null), 2400)
  }

  useEffect(() => () => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
  }, [])

  // ── Search logic ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)

    const q = search.trim()
    if (!q) {
      setAgentResults([])
      setMsgResults([])
      setSearching(false)
      return
    }

    setSearching(true)
    setExpandedConvId(null)
    debounceRef.current = setTimeout(async () => {
      // 1. Agent / conversation name search (local, instant)
      const lq = q.toLowerCase()
      const matchedAgents: AgentResult[] = conversations
        .filter((c) => {
          const employee = c._employeeId ? employeesById.get(c._employeeId) : undefined
          return (
            c.title.toLowerCase().includes(lq) ||
            c.agentName.toLowerCase().includes(lq) ||
            (employee?.displayName ?? '').toLowerCase().includes(lq) ||
            (employee?.roleName ?? '').toLowerCase().includes(lq) ||
            (employee?.persona ?? '').toLowerCase().includes(lq) ||
            (employee?.skills ?? []).some((skill) => skill.toLowerCase().includes(lq))
          )
        })
        .map((c) => {
          const employee = c._employeeId ? employeesById.get(c._employeeId) : undefined
          return {
            convId: c.id,
            avatarUrl: c.agentAvatarUrl,
            name: employee?.displayName ?? c.agentName,
            profession: employee?.roleName ?? '',
          }
        })

      setAgentResults(matchedAgents)

      // 2. 消息搜索:新栈没有全历史搜索接口,当前只搜索已加载到内存的活跃对话消息。
      // 后续如需跨全部历史 entries 搜索,应该新增 Agent 搜索接口,不启用本地 SQLite FTS。
      const allMsgResults: MessageResult[] = []
      const { activeConvId, activeConvMessages } = useChatStore.getState()
      const activeConv = conversations.find((c) => c.id === activeConvId)
      if (activeConv) {
        for (const m of activeConvMessages) {
          const text = (m.content ?? '').toLowerCase()
          if (!text.includes(lq)) continue
          allMsgResults.push({
            convId: activeConv.id,
            convAvatarUrl: activeConv.agentAvatarUrl,
            convTitle: activeConv.title,
            msgId: m.id,
            content: msgPreview(m.content, m.msgType),
            msgType: m.msgType,
          })
        }
      }
      setMsgResults(allMsgResults)
      setSearching(false)
    }, 300)

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [search, conversations, employeesById])

  // ── Group message results by conversation ────────────────────────────────────

  const msgGroups = useMemo<ConvMsgGroup[]>(() => {
    const map = new Map<string, ConvMsgGroup>()
    for (const r of msgResults) {
      if (!map.has(r.convId)) {
        map.set(r.convId, { convId: r.convId, convAvatarUrl: r.convAvatarUrl, convTitle: r.convTitle, messages: [] })
      }
      map.get(r.convId)!.messages.push(r)
    }
    return Array.from(map.values())
  }, [msgResults])

  // ── 会话排序:置顶项排到最前(内部按 ISO 时间戳倒序,后置顶靠前),其他保持原顺序 ─────
  // conversations 数组本身在 store 里已按 lastMessageAt desc 排好,这里只做"置顶提前",
  // 不再重排未置顶部分,保持用户对现有顺序的直觉记忆。
  const sortedConversations = useMemo(() => {
    const pinned = conversations.filter((c) => pinnedConvs[c.id])
    const rest = conversations.filter((c) => !pinnedConvs[c.id])
    // 同置顶集合内按置顶时间倒序(后置顶靠前),提升"最近操作项在上"的感知一致性。
    pinned.sort((a, b) => (pinnedConvs[b.id] ?? '').localeCompare(pinnedConvs[a.id] ?? ''))
    return [...pinned, ...rest]
  }, [conversations, pinnedConvs])

  // 菜单渲染后按实际尺寸钳制到视口内，并把焦点放到首个可用操作。
  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return
    const menu = contextMenuRef.current
    const rect = menu.getBoundingClientRect()
    const gutter = 8
    const x = Math.max(gutter, Math.min(contextMenu.x, window.innerWidth - rect.width - gutter))
    const y = Math.max(gutter, Math.min(contextMenu.y, window.innerHeight - rect.height - gutter))
    if (x !== contextMenu.x || y !== contextMenu.y) {
      setContextMenu((current) => current ? { ...current, x, y } : null)
      return
    }
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
  }, [contextMenu])

  // ── 右键菜单:点击菜单外或按 Esc 时关闭 ────────────────────────────────────────
  // 用 mousedown 而不是 click,避免菜单项自身的点击先触发 click 冒泡把菜单关掉;
  // Esc 走 keydown 是通用键盘可达性做法。
  useEffect(() => {
    if (!contextMenu) return
    const handleDown = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null
      if (target && target.closest('.panel-context-menu')) return
      setContextMenu(null)
    }
    const handleKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        setContextMenu(null)
        contextMenuTriggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', handleDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [contextMenu])

  // ── 右键菜单动作 ──────────────────────────────────────────────────────────────

  // 打开右键菜单:阻止浏览器原生菜单,记录锚点为鼠标坐标(fixed 定位,不受父容器 transform 影响)。
  const handleOpenContextMenu = (e: React.MouseEvent, convId: string) => {
    e.preventDefault()
    e.stopPropagation()
    contextMenuTriggerRef.current = e.currentTarget as HTMLButtonElement
    setContextMenu({ convId, x: e.clientX, y: e.clientY })
  }

  // emp_ 占位（含已下架、尚未建会话的员工）与真实会话共用同一菜单；各动作内部处理占位分支。
  const handleConversationKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, convId: string) => {
    if (!(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) return
    e.preventDefault()
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    contextMenuTriggerRef.current = e.currentTarget
    setContextMenu({ convId, x: rect.left + Math.min(rect.width, 48), y: rect.top + Math.min(rect.height, 40) })
  }

  const handleContextMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
    if (items.length === 0) return
    e.preventDefault()
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Home') items[0].focus()
    else if (e.key === 'End') items[items.length - 1].focus()
    else if (e.key === 'ArrowDown') items[(currentIndex + 1 + items.length) % items.length].focus()
    else items[(currentIndex - 1 + items.length) % items.length].focus()
  }

  // 置顶/取消置顶：纯本机状态，写内存 + localStorage。
  const handleTogglePin = (convId: string) => {
    togglePinConversation(convId)
    handleCloseContextMenu()
  }

  // 标记全部已读必须先拿到最后一个真实 entry id；null 在服务端表示清空读锚点。
  const handleMarkAllRead = async (convId: string) => {
    const actionKey = `read:${convId}`
    if (busyAction === actionKey) return
    handleCloseContextMenu()
    if (convId.startsWith('emp_')) {
      clearUnread(convId)
      showNotice({ kind: 'success', message: '该会话暂无消息' })
      return
    }
    setBusyAction(actionKey)
    try {
      const { entries } = await agentApi.listEntries(convId)
      const lastEntryId = getLastReadEntryId(entries)
      if (!lastEntryId) {
        clearUnread(convId)
        showNotice({ kind: 'success', message: '该会话暂无未读消息' })
        return
      }
      await agentApi.markConversationRead(convId, lastEntryId)
      clearUnread(convId)
      showNotice({ kind: 'success', message: '已标记为全部已读' })
    } catch (err) {
      if (err instanceof AgentApiError && err.status === 404) {
        dropStaleConversation(convId, 'conv')
        showNotice({ kind: 'error', message: '会话已不存在，已从列表移除' })
        return
      }
      console.error('[handleMarkAllRead] failed:', err)
      showNotice({ kind: 'error', message: '标记已读失败，请稍后重试' })
    } finally {
      setBusyAction(null)
    }
  }

  // 删除会话:window.confirm 二次确认(设计要求);emp_ 占位没有服务端资源,仅本地剥离即可。
  // 真实 conv 调 DELETE /conversations/:id;成功后统一用 dropStaleConversation 从列表移除(它同时会处理 activeConvId 回退)。
  const handleDeleteConversation = async (convId: string) => {
    const actionKey = `delete:${convId}`
    if (busyAction === actionKey) return
    const ok = window.confirm('删除后会话及消息记录将无法恢复,确定删除吗?')
    handleCloseContextMenu()
    if (!ok) return
    if (convId.startsWith('emp_')) {
      // emp_ 只是已招募员工的入口，尚无可删除的服务端会话，不能把员工误当会话移除。
      showNotice({ kind: 'error', message: '该员工尚未创建会话，无需删除' })
      return
    }
    setBusyAction(actionKey)
    try {
      await agentApi.deleteConversation(convId)
      dropStaleConversation(convId, 'conv')
      showNotice({ kind: 'success', message: '会话已删除' })
    } catch (err) {
      if (err instanceof AgentApiError && err.status === 404) {
        // 服务端已不存在,视作删除成功。
        dropStaleConversation(convId, 'conv')
        showNotice({ kind: 'success', message: '会话已删除' })
        return
      }
      console.error('[handleDeleteConversation] failed:', err)
      showNotice({ kind: 'error', message: '删除失败，请稍后重试' })
    } finally {
      setBusyAction(null)
    }
  }

  // ── Create group ──────────────────────────────────────────────────────────────

  const handleCreateGroup = async (data: CreateGroupData) => {
    const { conversation: conv, participants } = await agentApi.createCustomGroup(data)
    const experts = await agentApi.listExperts().then(result => result.experts).catch(() => [])
    const roster = participants ? participantRoster(participants, experts) : {
      members: [], memberCount: null, status: 'unavailable' as const, message: '群已创建，成员读取失败，请刷新重试。',
    }
    addGroup({
      id: conv.id, name: conv.title ?? data.title, lastMessage: '', time: '刚刚',
      members: roster.members, memberCount: roster.memberCount, rosterStatus: roster.status, rosterMessage: roster.message,
      solutionInstanceId: null, description: conv.description, orchestration: conv.orchestration,
    })
    setActiveGroupId(conv.id)
    setShowCreateGroup(false)
    navigate('/group-chat')
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  const isSearching = search.trim().length > 0
  const hasResults = agentResults.length > 0 || msgGroups.length > 0

  return (
    <>
      <aside className="panel" aria-label={isGroupChat ? '群聊会话列表' : '单聊会话列表'}>
        {/* Header */}
        <div className={`panel-header ${isGroupChat ? 'group' : ''}`}>
          {isGroupChat ? (
            <button
              className="panel-add-btn"
              onClick={() => setShowCreateGroup(true)}
              type="button"
              title={canCreateGroup ? '创建群聊（⌘N / Ctrl+N）' : '创建自选成员群聊'}
              aria-label="创建群聊"
              aria-keyshortcuts={canCreateGroup ? 'Meta+N Control+N' : undefined}
            >
              <Plus size={12} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className={`panel-new-session-btn tooltip-trigger${!activeConvId ? ' active' : ''}`}
              data-tip={workbenchEmployees.length > 0 ? '新建单聊会话' : '招募人才开始新会话'}
              onClick={() => {
                if (workbenchEmployees.length > 0) handleContextualNew()
                else navigate('/talents')
              }}
              aria-keyshortcuts={workbenchEmployees.length > 0 ? 'Meta+N Control+N' : undefined}
              title={workbenchEmployees.length > 0 ? '新建会话（⌘N / Ctrl+N）' : '前往人才市场'}
            >
              <Plus size={14} strokeWidth={2} aria-hidden="true" />
              {workbenchEmployees.length > 0 ? '新建会话' : '招募AI员工'}
            </button>
          )}
        </div>

        {/* Search */}
        <div className="panel-search-wrap">
          <Search className="panel-search-icon" size={15} strokeWidth={2} aria-hidden="true" />
          <input
            className="panel-search-input"
            type="text"
            placeholder={isGroupChat ? '搜索群聊…' : '搜索AI员工、消息…'}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={isGroupChat ? '搜索群聊' : '搜索 AI 员工和已加载消息'}
          />
        </div>

        {/* Content */}
        {workbenchLoading ? (
          <p className="panel-search-empty" role="status">正在加载会话与员工…</p>
        ) : workbenchError ? (
          <RequestErrorState
            compact
            className="panel-request-error"
            error={workbenchError}
            onRetry={() => void loadAgentsAndConversations()}
            retrying={workbenchLoading || workbenchRefreshing}
          />
        ) : isSearching ? (
          <div className="panel-search-results">
            {searching && (
              <p className="panel-search-empty">搜索中…</p>
            )}

            {!searching && !hasResults && (
              <p className="panel-search-empty">未找到相关结果</p>
            )}

            {/* Agent results */}
            {agentResults.length > 0 && (
              <div className="panel-search-section">
                <div className="panel-search-section-title">智能体</div>
                {agentResults.map((r) => (
                  <button
                    type="button"
                    key={r.convId}
                    className="panel-sr-agent"
                    onClick={() => { handleConvClick(r.convId); setSearch('') }}
                    aria-label={`打开与 ${r.name} 的会话`}
                  >
                    <div className="panel-sr-agent-avatar">
                      {renderAvatar(getEmployeeAvatar(r.name, r.avatarUrl), getAvatarFallback(r.name))}
                    </div>
                    <div>
                      <div className="panel-sr-agent-name">{highlight(r.name, search)}</div>
                      {r.profession && (
                        <div className="panel-sr-agent-sub">{highlight(r.profession, search)}</div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Divider between sections */}
            {agentResults.length > 0 && msgResults.length > 0 && (
              <div className="panel-divider" aria-hidden="true" />
            )}

            {/* Message results — grouped by conversation */}
            {msgGroups.length > 0 && (
              <div className="panel-search-section">
                <div className="panel-search-section-title">消息记录</div>
                {msgGroups.map((g) => {
                  const isExpanded = expandedConvId === g.convId
                  return (
                    <div key={g.convId}>
                      <button
                        type="button"
                        className={`panel-sr-conv${isExpanded ? ' expanded' : ''}`}
                        onClick={() => {
                          setActiveConvId(g.convId)
                          setExpandedConvId(isExpanded ? null : g.convId)
                        }}
                        aria-expanded={isExpanded}
                        aria-controls={`panel-search-messages-${g.convId}`}
                      >
                        <div className="panel-sr-conv-avatar">
                          {renderAvatar(getEmployeeAvatar(g.convTitle, g.convAvatarUrl), getAvatarFallback(g.convTitle))}
                        </div>
                        <div className="panel-sr-conv-body">
                          <span className="panel-sr-conv-title">{g.convTitle}</span>
                          <span className="panel-sr-conv-count">{g.messages.length} 条</span>
                        </div>
                        <ChevronRight
                          className={`panel-sr-conv-chevron${isExpanded ? ' open' : ''}`}
                          size={12}
                          strokeWidth={1.6}
                        />
                      </button>
                      {isExpanded && (
                        <div className="panel-sr-msg-list" id={`panel-search-messages-${g.convId}`}>
                          {g.messages.map((r) => (
                            <button
                              type="button"
                              key={r.msgId}
                              className="panel-sr-msg"
                              onClick={() => {
                                setHighlightMsgId(r.msgId)
                                setSearch('')
                                setExpandedConvId(null)
                              }}
                              aria-label={`定位消息：${r.content}`}
                            >
                              <div className="panel-sr-msg-content">{highlight(r.content, search)}</div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        ) : isGroupChat ? (
          /* Group list */
          groups.length === 0 ? (
            // 群聊空态:引导用户创建首个群聊(设计文档 5.2 - 空状态)。
            <div className="panel-empty-state">
              <div className="panel-empty-icon">
                <Users size={28} strokeWidth={1.4} aria-hidden="true" />
              </div>
              <p className="panel-empty-text">还没有群聊，创建一个和多位 AI 员工协作吧</p>
              <button
                type="button"
                className="panel-empty-cta"
                onClick={() => setShowCreateGroup(true)}
                aria-keyshortcuts={canCreateGroup ? 'Meta+N Control+N' : undefined}
                title={canCreateGroup ? '创建群聊（⌘N / Ctrl+N）' : '创建自选成员群聊'}
              >
                <Plus size={14} strokeWidth={2} aria-hidden="true" />
                创建群聊
              </button>
            </div>
          ) : (
          <div className="panel-list">
            {groups.map((group, i) => (
              <button
                type="button"
                key={group.id}
                onClick={() => {
                  if (group.id !== activeGroupId) setActiveGroupId(group.id)
                  // 已读由 GroupChat 在 entries 加载完成后用最后一个真实 entry id 上报。
                }}
                className={`panel-conv-item${activeGroupId === group.id ? ' active' : ''}`}
                style={{ animationDelay: `${i * 50}ms` }}
                aria-current={activeGroupId === group.id ? 'true' : undefined}
              >
                <div className="panel-conv-avatar">
                  <GroupAvatar
                    members={group.members ?? []}
                    label={`${group.name}群头像`}
                    rosterDescription={group.rosterMessage}
                  />
                  <ConversationUnreadBadge conversation={group} />
                </div>
                <div className="panel-conv-body">
                  <div className="panel-conv-row">
                    <span className="panel-conv-name">{group.name}</span>
                    <span className="panel-conv-time">
                      {group.summaryAvailability?.lastMessageAt === false ? '时间未提供' : group.time}
                    </span>
                  </div>
                  <p className="panel-conv-preview">
                    {group.summaryAvailability?.preview === false ? '摘要未提供' : group.lastMessage || '暂无消息'}
                  </p>
                </div>
              </button>
            ))}
          </div>
          )
        ) : (
          /* Normal conversation list */
          conversations.length === 0 ? (
            // 私聊空态:引导用户前往人才市场招募第一位 AI 员工(设计文档 5.1 - 空状态)。
            <div className="panel-empty-state">
              <div className="panel-empty-icon">
                <MessageSquare size={28} strokeWidth={1.4} aria-hidden="true" />
              </div>
              <p className="panel-empty-text">还没有聊天会话，去人才市场招募你的第一位 AI 员工吧</p>
              <button
                type="button"
                className="panel-empty-cta"
                onClick={() => navigate('/talents')}
              >
                <Plus size={14} strokeWidth={2} aria-hidden="true" />
                前往人才市场
              </button>
            </div>
          ) : (
          <div className="panel-list">
            {sortedConversations.map((conv, i) => {
              const isActive = conv.id === activeConvId
              // 是否已置顶:决定右键菜单第一项的文案(置顶 vs 取消置顶),以及是否渲染小图钉标记。
              const isPinned = Boolean(pinnedConvs[conv.id])
              return (
                <button
                  type="button"
                  key={conv.id}
                  onClick={() => handleConvClick(conv.id)}
                  onContextMenu={(e) => handleOpenContextMenu(e, conv.id)}
                  onKeyDown={(e) => handleConversationKeyDown(e, conv.id)}
                  className={`panel-conv-item${isActive ? ' active' : ''}${isPinned ? ' pinned' : ''}`}
                  style={{ animationDelay: `${i * 50}ms` }}
                  aria-current={isActive ? 'true' : undefined}
                  aria-keyshortcuts="Shift+F10"
                >
                  <div className="panel-conv-avatar">
                    {/* 员工头像:优先使用 ExpertProjection.avatar_url,回退到员工名首字符。 */}
                    {renderAvatar(getEmployeeAvatar(conv.agentName, conv.agentAvatarUrl), getAvatarFallback(conv.agentName))}
                    <ConversationUnreadBadge conversation={conv} />
                  </div>
                  <div className="panel-conv-body">
                    <div className="panel-conv-row">
                      <span className="panel-conv-name">{conv.title}</span>
                      {/* 置顶标记:金色小图钉,紧邻名称尾部,让用户一眼判断当前项处于置顶态。 */}
                      {isPinned && (
                        <Pin
                          className="panel-conv-pin-mark"
                          size={10}
                          strokeWidth={2.2}
                          aria-label="已置顶"
                        />
                      )}
                      <span className="panel-conv-time">
                        {conv.summaryAvailability?.lastMessageAt === false ? '时间未提供' : conv.time}
                      </span>
                    </div>
                    {(() => {
                      const d = draftsByConv[conv.id]
                      if (d && (d.text || d.files.length > 0)) {
                        return (
                          <p className="panel-conv-preview">
                            <span className="panel-conv-draft">草稿</span>
                            {d.text ? `：${d.text}` : ''}
                          </p>
                        )
                      }
                      return (
                        <p className="panel-conv-preview">
                          {conv.summaryAvailability?.preview === false ? '摘要未提供' : conv.lastMessage || '暂无消息'}
                        </p>
                      )
                    })()}
                  </div>
                </button>
              )
            })}
          </div>
          )
        )}
      </aside>

      {notice && (
        <div
          className={`panel-notice ${notice.kind}`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          {notice.message}
        </div>
      )}

      {showCreateGroup && (
        <CreateGroupDialog
          onClose={() => setShowCreateGroup(false)}
          onCreate={handleCreateGroup}
        />
      )}

      {/* A2.1 右键菜单：按实际尺寸回避屏幕边缘，支持焦点与方向键操作。 */}
      {contextMenu && (() => {
        // 提前计算当前项状态,菜单里同时用于展示文案与图标。
        const isPinned = Boolean(pinnedConvs[contextMenu.convId])
        return (
          <div
            ref={contextMenuRef}
            className="panel-context-menu"
            role="menu"
            aria-label="会话操作"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={handleContextMenuKeyDown}
          >
            {/* 置顶 / 取消置顶 —— 切换态,图标随之切换(Pin / PinOff)让状态可视化。 */}
            <button
              type="button"
              className="panel-context-menu-item"
              role="menuitem"
              onClick={() => handleTogglePin(contextMenu.convId)}
              disabled={busyAction !== null}
            >
              {isPinned ? (
                <PinOff size={14} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <Pin size={14} strokeWidth={1.8} aria-hidden="true" />
              )}
              <span>{isPinned ? '取消置顶' : '置顶会话'}</span>
            </button>

            {/* 标记全部已读 —— 中性操作,不做二次确认,直接派发。 */}
            <button
              type="button"
              className="panel-context-menu-item"
              role="menuitem"
              onClick={() => handleMarkAllRead(contextMenu.convId)}
              disabled={busyAction !== null}
            >
              <CheckCheck size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>标记全部已读</span>
            </button>

            {/* 分隔线:区分中性操作与危险操作,视觉上给用户一次"注意力停顿"。 */}
            <div className="panel-context-menu-divider" role="separator" aria-hidden="true" />

            {/* 删除会话 —— 危险色 + Trash 图标,handler 内 window.confirm 二次确认(A2.1)。 */}
            <button
              type="button"
              className="panel-context-menu-item danger"
              role="menuitem"
              onClick={() => handleDeleteConversation(contextMenu.convId)}
              disabled={busyAction !== null}
            >
              <Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>删除会话</span>
            </button>
          </div>
        )
      })()}
    </>
  )
}
