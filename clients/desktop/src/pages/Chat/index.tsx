import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import './Chat.css'
import { useChatStore, type Message, type ConversationItem } from '../../stores/chat'
import { employeeUnavailableMessage } from '../../lib/employeeAvailability'
import { useAgentAuthStore } from '../../stores/agentAuth'
import { pickAndCacheFile, readCachedFileBlob, type CachedFile } from '../../lib/fileCache'
import {
  uploadedAttachmentIds,
  uploadedMessageAttachments,
  type UploadableChatFile,
} from '../../lib/chatAttachmentUpload'
import { blobToBase64, sendTextMessage, type SendContext } from '../../lib/messageSender'
import { submitSingleChatPrompt } from '../../lib/singleChatPrompt'
import { agentApi, AgentApiError } from '../../api/agent'
import { globalActivityCollector } from '../../lib/globalActivityCollector'
import { getEmployeeId, rememberEmployeeConversation, type WorkbenchEmployee } from '../../lib/employeeConversationMap'
import { useChatScroll } from '../../hooks/useChatScroll'
import { MessageRow } from '../../components/Chat/MessageRow'
import { ThinkingBlock } from '../../components/Chat/ThinkingBlock'
import { ChatInputBar } from '../../components/Chat/ChatInputBar'
import type { ChatInputBarProps } from '../../components/Chat/ChatInputBar'
import { ConversationStatus } from '../../components/Chat/ConversationStatus'
import { ContextOutcomePrompt } from '../../components/Chat/ContextOutcomePrompt'
import { ContextResetFeedback, ContextResetToolButton } from '../../components/Chat/ContextResetControls'
import { ContextResetDivider } from '../../components/Chat/ContextResetDivider'
import { useConversationSegments } from '../../hooks/useConversationSegments'
import { useContextReset } from '../../hooks/useContextReset'
import { currentSegmentMessages } from '../../lib/contextOutcome'
import { contextResetDividers, contextResetMemoryText, contextResetPlacement } from '../../lib/piConverters'
import { ConversationPermissions } from '../../components/Chat/ConversationPermissions'
import { ChatDialog } from '../../components/Chat/ChatDialog'
import ConversationFiles from '../../components/Chat/ConversationFiles'
import { ChatHeader } from '../../components/Chat/ChatHeader'
import RequestErrorState from '../../components/RequestState/RequestErrorState'
import { resolveEmployeePresence } from '../../lib/employeePresence'
import { getLastReadEntryId } from '../../lib/readAnchor'
import { isAppFocused, useAppFocus } from '../../hooks/useAppFocus'
import { getAvatarFallback, getEmployeeAvatar, renderAvatar } from '../../lib/avatarUtils'

export type { ChatInputBarProps }
export { ChatInputBar, MessageRow, ThinkingBlock }

interface TalentChatState {
  employeeId?: string
  conversationId?: string
  profileName?: string
  agentName?: string
  initialMessage?: string
  /** 人才市场发起：会话为空时让员工先自我介绍。 */
  introduce?: boolean
  refreshWorkbench?: boolean
}

interface PendingInitialMessage {
  key: string
  convId: string
  /** 人才市场带来的默认消息；与 introduce 互斥。 */
  text?: string
  introduce?: boolean
}

interface EnsuredConversation {
  id: string
  item: ConversationItem
  employeeId: string
}

interface PendingSendAttempt {
  conversationId: string
  messageId: string
  text: string
  attachmentIds: string[]
  idempotencyKey: string
}

// 相邻消息 > 5 分钟时展示的分隔文案。今天只显示 HH:MM,昨天带"昨天"前缀,更早显示 M-D HH:MM。
function formatMessageDivider(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return hhmm
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hhmm}`
  return `${d.getMonth() + 1}-${d.getDate()} ${hhmm}`
}

async function uploadAttachment(conversationId: string, file: CachedFile): Promise<string> {
  const data = await blobToBase64(await readCachedFileBlob(file))
  const uploaded = await agentApi.uploadFile(conversationId, 'attachment', {
    filename: file.name,
    mime_type: file.mime,
    data,
  })
  if (!uploaded.id) throw new Error('附件服务未返回文件 ID')
  return uploaded.id
}

function isSameSendAttempt(
  attempt: PendingSendAttempt | null,
  conversationId: string,
  text: string,
  attachmentIds: readonly string[],
): attempt is PendingSendAttempt {
  return attempt?.conversationId === conversationId
    && attempt.text === text
    && attempt.attachmentIds.length === attachmentIds.length
    && attempt.attachmentIds.every((id, index) => id === attachmentIds[index])
}


// ── New session page ──────────────────────────────────────────────────────────

interface NewSessionPageProps {
  onSend: (text: string, files: UploadableChatFile[], employeeId?: string) => boolean | Promise<boolean>
  onPickFile: () => Promise<CachedFile | null>
  onUploadFile: (file: CachedFile, employeeId?: string) => Promise<string>
  onDeleteUploadedFile: (attachmentId: string) => Promise<void>
  disabled?: boolean
  draft?: string
  draftFiles?: CachedFile[]
  onDraftChange: (convId: string, text: string, files: CachedFile[]) => void
  error?: string | null
  employees?: WorkbenchEmployee[]
}

function NewSessionPage({
  onSend,
  onPickFile,
  onUploadFile,
  onDeleteUploadedFile,
  disabled,
  draft,
  draftFiles,
  onDraftChange,
  error,
  employees,
}: NewSessionPageProps) {
  return (
    <div className="chat-new-session">
      <main className="chat-new-main">
        <h1 className="chat-new-title">AIFred 管家为您服务</h1>

        <ChatInputBar
          variant="hero"
          enableKnowledgeFiles
          onSend={onSend}
          onPickFile={onPickFile}
          onUploadFile={onUploadFile}
          onDeleteUploadedFile={onDeleteUploadedFile}
          disabled={disabled}
          convId=""
          draft={draft}
          draftFiles={draftFiles}
          onDraftChange={onDraftChange}
          placeholder="随心输入"
          autoFocus
          employees={employees}
          helper={error ? <p className="chat-input-error">{error}</p> : <p className="chat-input-hint chat-input-hint-hero" />}
        />
      </main>
    </div>
  )
}

// ── Chat page ─────────────────────────────────────────────────────────────────

export default function Chat() {
  const location = useLocation()
  const navigate = useNavigate()

  const [filesConversationId, setFilesConversationId] = useState<string | null>(null)
  const [flashMsgId, setFlashMsgId] = useState<string | null>(null)

  const [isGenerating, setIsGenerating] = useState(false)
  const [newSessionError, setNewSessionError] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [pendingInitialMessage, setPendingInitialMessage] = useState<PendingInitialMessage | null>(null)
  const [messageLoadAttempt, setMessageLoadAttempt] = useState(0)
  // 开启新上下文后递增,让 ConversationStatus 重新挂载并重新读取上下文用量。
  const [contextResetCount, setContextResetCount] = useState(0)

  const {
    activeConvId, conversations, activeConvMessages, activeConvRawItems, appendMessage, updateMessageStatus,
    loadConversation, refreshActiveEntries,
    refreshConversations, upgradeConversationId, toggleDetail,
    highlightMsgId, setHighlightMsgId, draftsByConv, setConvDraft,
    addConversation, setActiveConvId, workbenchEmployees, clearUnread, loadMoreMessages, activePagination,
    startAssistantStream, abortStream, generatingConvIds, syncingConvIds, streamingMsgIds,
    dropStaleConversation,
    workbenchLoading, workbenchRefreshing, workbenchError, loadAgentsAndConversations,
    activeMessagesLoading, activeMessagesError,
  } = useChatStore()
  const userId = useAgentAuthStore((state) => state.account) ?? 'guest'
  const resetDividers = useMemo(() => contextResetDividers(activeConvRawItems), [activeConvRawItems])
  const segments = useConversationSegments(activeConvId, contextResetCount)
  const segmentMessages = useMemo(() => currentSegmentMessages(activeConvMessages, resetDividers), [activeConvMessages, resetDividers])
  const contextReset = useContextReset(activeConvId ?? '', (result) => {
    if (result.segment) segments.upsert(result.segment)
    setContextResetCount((count) => count + 1)
    if (activeConvId) refreshActiveEntries(activeConvId).catch(console.error)
  })
  const msgRowRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const loadedMsgCountRef = useRef(0)
  const loadedConversationRef = useRef<string | null>(null)
  const pendingInitialMessageRef = useRef<PendingInitialMessage | null>(null)
  const consumedInitialMessageKeysRef = useRef(new Set<string>())
  const conversationCreationRef = useRef<{
    sourceId: string
    promise: Promise<EnsuredConversation>
  } | null>(null)
  const upgradedConversationIdsRef = useRef(new Map<string, string>())
  const newSessionConversationRef = useRef<EnsuredConversation | null>(null)
  const newSessionCreationRef = useRef<Promise<EnsuredConversation> | null>(null)
  const pendingSendAttemptRef = useRef<PendingSendAttempt | null>(null)
  const [readSyncError, setReadSyncError] = useState<string | null>(null)

  useEffect(() => {
    loadedMsgCountRef.current = messages.length
  }, [activeConvId]) // eslint-disable-line react-hooks/exhaustive-deps

  // 旧 useSocket() 已废弃(新栈无 WebSocket 接收链路,消息统一走会话级 SSE),不再挂载。

  // 处理人才市场"对话"按钮跳转：先刷新列表，再激活对应会话
  useEffect(() => {
    const state = location.state as TalentChatState | null
    if (!state?.conversationId) return

    const convId = state.conversationId
    const employeeId = state.employeeId
    const displayName = state.profileName ?? state.agentName ?? '助手'
    const title = state.agentName ?? displayName
    const employeeAvatarUrl = employeeId
      ? workbenchEmployees.find((employee) => employee.employeeId === employeeId)?.avatarUrl
      : null
    const currentConvs = useChatStore.getState().conversations
    const existing = currentConvs.find((c) => c.id === convId)
    const hasEmployeePlaceholder = employeeId ? currentConvs.some((c) => c.id === employeeId) : false

    if (employeeId) rememberEmployeeConversation(convId, employeeId)
    if (employeeId && hasEmployeePlaceholder && !existing) {
      upgradeConversationId(employeeId, convId, employeeId)
    } else {
      if (!existing) {
        addConversation({
          id: convId,
          title,
          agentEmoji: '🤖',
          agentName: displayName,
          agentAvatarUrl: employeeAvatarUrl ?? null,
          lastMessage: '',
          time: '',
          _employeeId: employeeId,
        })
      }
      setActiveConvId(convId)
    }

    const initialText = state.initialMessage?.trim()
    const pending: PendingInitialMessage | null = initialText
      ? { key: `${location.key}:${convId}:${initialText}`, convId, text: initialText }
      : state.introduce ? { key: `${location.key}:${convId}:introduce`, convId, introduce: true } : null
    if (pending) {
      pendingInitialMessageRef.current = pending
      setPendingInitialMessage(pending)
    }

    if (state.refreshWorkbench) refreshConversations().catch(console.error)
    navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: null },
    )
  }, [
    location.key,
    location.pathname,
    location.search,
    location.hash,
    location.state,
    navigate,
    addConversation,
    refreshConversations,
    setActiveConvId,
    upgradeConversationId,
    workbenchEmployees,
  ])

  const conv = conversations.find((c) => c.id === activeConvId)
  const messages: Message[] = activeConvMessages
  const activeEmployee = workbenchEmployees.find((employee) => employee.employeeId === conv?._employeeId)
  const unavailableMessage = employeeUnavailableMessage(activeEmployee)
  const activeEmployeePresence = resolveEmployeePresence({
    online_status: activeEmployee?.onlineStatus,
    last_seen_at: activeEmployee?.lastSeenAt,
  })

  const { msgListRef, scrollToBottom } = useChatScroll({
    messagesLength: messages.length,
    activeId: activeConvId,
    hasMore: activePagination.hasMore,
    loadMore: loadMoreMessages,
  })

  // "↓ 新消息"按钮:仅当用户已经离开底部一段距离,且新消息到达时才显示。
  // 判定阈值 120px;高于此阈值就认为"离开底部",新消息到达后展示提示。
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const isNearBottomRef = useRef(true)
  useEffect(() => {
    const el = msgListRef.current
    if (!el) return
    const handler = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      isNearBottomRef.current = distanceFromBottom < 120
      if (isNearBottomRef.current) setShowJumpToLatest(false)
    }
    el.addEventListener('scroll', handler, { passive: true })
    return () => el.removeEventListener('scroll', handler)
  }, [msgListRef])
  useEffect(() => {
    if (!isNearBottomRef.current && messages.length > 0) setShowJumpToLatest(true)
  }, [messages.length])
  useEffect(() => {
    // 切换会话时重置状态,避免误显示。
    setShowJumpToLatest(false)
    isNearBottomRef.current = true
  }, [activeConvId])

  const appFocused = useAppFocus()
  const lastEntryId = getLastReadEntryId(activeConvRawItems)

  // 当前对话在前台获得焦点时，等 entries 加载完成后用最后一个真实 entry id 上报。
  // null 的服务端语义是清空已读锚点，因此加载中/空列表绝不能提前清零。
  useEffect(() => {
    if (!activeConvId || activeConvId.startsWith('emp_')) return
    if (!appFocused || !isAppFocused() || activeMessagesLoading || !lastEntryId) return
    let cancelled = false
    // 404 说明会话已被服务端删除,清掉本地 stale id 避免后续每条新消息又打一次。
    agentApi.markConversationRead(activeConvId, lastEntryId)
      .then(() => {
        if (cancelled || !isAppFocused()) return
        clearUnread(activeConvId)
        setReadSyncError(null)
      })
      .catch((err) => {
        if (err instanceof AgentApiError && err.status === 404) {
          dropStaleConversation(activeConvId, 'conv')
          return
        }
        console.error('[Chat] markConversationRead failed:', err)
        if (!cancelled) setReadSyncError('已读状态同步失败，将在下次打开时重试')
      })
    return () => { cancelled = true }
  }, [lastEntryId, activeConvId, conv?.unread, appFocused, activeMessagesLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setReadSyncError(null), [activeConvId])

  // ── Scroll to highlighted message ──────────────────────────────────────────
  useEffect(() => {
    if (!highlightMsgId) return
    const targetMsg = messages.find((m) => m.id === highlightMsgId || m.entryRefs?.includes(highlightMsgId))
    if (!targetMsg) return

    // Messages are loaded — wait one frame for refs to populate after render
    const raf = requestAnimationFrame(() => {
      const el = msgRowRefs.current[targetMsg.id]
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setFlashMsgId(targetMsg.id)
      setHighlightMsgId(null)
      setTimeout(() => setFlashMsgId(null), 2000)
    })

    return () => cancelAnimationFrame(raf)
  }, [highlightMsgId, messages, setHighlightMsgId])

  // ── SendContext ───────────────────────────────────────────────────────────────

  const buildSendContext = useCallback((convId: string): SendContext => ({
    convId,
    appendMessage,
  }), [appendMessage])

  const handleAbort = useCallback(async (convId: string) => {
    await abortStream(convId)
  }, [abortStream])

  const streamState = { active: streamingMsgIds }

  // ── Send text ────────────────────────────────────────────────────────────────

  const ensureConversation = useCallback(async (sourceId: string): Promise<EnsuredConversation> => {
    const existing = conversations.find((item) => item.id === sourceId)
    const employeeId = getEmployeeId(sourceId)
      ?? existing?._employeeId
      ?? (sourceId.startsWith('emp_') ? sourceId.slice(4) : undefined)
    if (!employeeId) throw new Error('当前会话缺少员工信息')
    if (!sourceId.startsWith('emp_')) {
      if (!existing) throw new Error('当前会话不存在')
      return { id: sourceId, item: existing, employeeId }
    }

    const upgradedId = upgradedConversationIdsRef.current.get(sourceId)
    if (upgradedId) {
      const upgraded = useChatStore.getState().conversations.find((item) => item.id === upgradedId)
      if (upgraded) return { id: upgradedId, item: upgraded, employeeId }
    }
    if (conversationCreationRef.current?.sourceId === sourceId) {
      return conversationCreationRef.current.promise
    }

    const promise = agentApi.createConversation({ kind: 'chat', entry_employee_id: employeeId })
      .then((created) => {
        const employee = workbenchEmployees.find((item) => item.employeeId === employeeId)
        const item: ConversationItem = existing
          ? { ...existing, id: created.id }
          : {
              id: created.id,
              title: created.title ?? '新会话',
              agentEmoji: '🤖',
              agentName: employee?.displayName ?? '助手',
              agentAvatarUrl: employee?.avatarUrl ?? null,
              lastMessage: '',
              time: '刚刚',
              _employeeId: employeeId,
            }
        upgradedConversationIdsRef.current.set(sourceId, created.id)
        // 新建会话没有历史。先标记已加载，避免 ID 切换触发空历史请求，
        // 覆盖紧接着追加的首条用户消息。
        if (useChatStore.getState().activeConvId === sourceId) {
          loadedConversationRef.current = created.id
        }
        upgradeConversationId(sourceId, created.id, employeeId)
        rememberEmployeeConversation(created.id, employeeId)
        return { id: created.id, item, employeeId }
      })
      .finally(() => {
        if (conversationCreationRef.current?.sourceId === sourceId) {
          conversationCreationRef.current = null
        }
      })
    conversationCreationRef.current = { sourceId, promise }
    return promise
  }, [conversations, upgradeConversationId, workbenchEmployees])

  const submitMessage = useCallback(async (
    conversation: EnsuredConversation,
    text: string,
    files: UploadableChatFile[],
  ): Promise<boolean> => {
    const blocked = employeeUnavailableMessage(useChatStore.getState().workbenchEmployees.find((employee) => employee.employeeId === conversation.employeeId))
    if (blocked) return false
    const attachmentIds = uploadedAttachmentIds(files)
    if (attachmentIds.length !== files.length) return false

    const previousAttempt = pendingSendAttemptRef.current
    let messageId: string
    let idempotencyKey: string
    if (isSameSendAttempt(previousAttempt, conversation.id, text, attachmentIds)) {
      messageId = previousAttempt.messageId
      idempotencyKey = previousAttempt.idempotencyKey
      updateMessageStatus(conversation.id, messageId, 'sending')
    } else {
      const userMessage = sendTextMessage(
        buildSendContext(conversation.id),
        text,
        uploadedMessageAttachments(files),
      )
      if (!userMessage) return false
      messageId = userMessage.id
      idempotencyKey = crypto.randomUUID()
      pendingSendAttemptRef.current = {
        conversationId: conversation.id,
        messageId,
        text,
        attachmentIds,
        idempotencyKey,
      }
    }

    try {
      await submitSingleChatPrompt(
        conversation.id,
        text,
        files,
        idempotencyKey,
        agentApi.submitPrompt.bind(agentApi),
      )
    } catch (error) {
      console.error('[Chat] submitPrompt failed:', error)
      updateMessageStatus(conversation.id, messageId, 'failed')
      return false
    }

    updateMessageStatus(conversation.id, messageId, 'sent')
    pendingSendAttemptRef.current = null
    setConvDraft(conversation.id, '', [])

    const agentName = useChatStore.getState().conversations.find((item) => item.id === conversation.id)?.agentName
      ?? conversation.item.agentName
      ?? '未知员工'
    const now = new Date()
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    globalActivityCollector.emit({
      time,
      agent: agentName,
      text: '收到消息,思考中...',
      type: 'thinking',
      convId: conversation.id,
    })
    startAssistantStream(conversation.id, { promptIdempotencyKey: idempotencyKey })
    return true
  }, [buildSendContext, setConvDraft, startAssistantStream, updateMessageStatus])

  const sendMessage = useCallback(async (text: string, files: UploadableChatFile[] = []): Promise<boolean> => {
    if ((!text && files.length === 0) || !activeConvId) return false
    if (unavailableMessage) return false
    setSendError(null)
    try {
      const conversation = await ensureConversation(activeConvId)
      const sent = await submitMessage(conversation, text, files)
      if (!sent) setSendError('发送失败，请重试。')
      return sent
    } catch (error) {
      console.error('[Chat] createConversation failed:', error)
      setSendError('创建会话失败，请重试。')
      return false
    }
  }, [activeConvId, ensureConversation, submitMessage, unavailableMessage])

  // 切换对话时从服务器拉取最新 20 条消息；人才市场跳转的默认消息等拉取完成后再发，避免被覆盖。
  useEffect(() => {
    if (!activeConvId) {
      loadedConversationRef.current = null
      return
    }
    const pendingForActive = pendingInitialMessage?.convId === activeConvId
    const shouldLoad = loadedConversationRef.current !== activeConvId || pendingForActive
    if (!shouldLoad) return
    loadedConversationRef.current = null

    let cancelled = false
    const loadAndSendInitialMessage = async () => {
      await loadConversation(activeConvId)
      if (cancelled) return
      if (useChatStore.getState().activeMessagesError) return
      loadedConversationRef.current = activeConvId

      const pending = pendingInitialMessageRef.current
      if (!pending || pending.convId !== activeConvId) return

      const alreadyConsumed = consumedInitialMessageKeysRef.current.has(pending.key)
      const alreadyHasMessage = useChatStore.getState().activeConvMessages.some((msg) =>
        msg.role === 'user' && msg.content.trim() === pending.text
      )

      consumedInitialMessageKeysRef.current.add(pending.key)
      pendingInitialMessageRef.current = null
      setPendingInitialMessage(null)

      if (pending.introduce) {
        if (alreadyConsumed || useChatStore.getState().activeConvMessages.length > 0) return
        // 自我介绍是附加体验：会话已有消息（409）、员工不可用或随包 Agent 尚不支持时静默跳过。
        agentApi.introduceConversation(activeConvId)
          .then((receipt) => {
            if (receipt.state === 'accepted') startAssistantStream(activeConvId, { promptIdempotencyKey: receipt.idempotency_key })
          })
          .catch((err) => console.warn('[Chat] employee introduction skipped:', err))
        return
      }
      if (!pending.text || alreadyConsumed || alreadyHasMessage) return
      sendMessage(pending.text).catch(console.error)
    }

    loadAndSendInitialMessage().catch(console.error)
    return () => { cancelled = true }
  }, [activeConvId, messageLoadAttempt, pendingInitialMessage?.key]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Pick & send file ─────────────────────────────────────────────────────────

  const pickFileAction = useCallback(
    () => pickAndCacheFile(userId, activeConvId || 'new-session'),
    [userId, activeConvId]
  )

  const handleUploadFile = useCallback(async (file: CachedFile): Promise<string> => {
    if (!activeConvId) throw new Error('请先选择会话')
    const sourceId = activeConvId
    const conversation = await ensureConversation(sourceId)
    return uploadAttachment(conversation.id, file)
  }, [activeConvId, ensureConversation])

  const handleDeleteUploadedFile = useCallback(async (attachmentId: string): Promise<void> => {
    if (!activeConvId) return
    const conversationId = upgradedConversationIdsRef.current.get(activeConvId) ?? activeConvId
    if (conversationId.startsWith('emp_')) return
    await agentApi.deleteFile(conversationId, 'attachment', attachmentId)
  }, [activeConvId])

  const ensureNewSessionConversation = useCallback(async (employeeId?: string): Promise<EnsuredConversation> => {
    const employee = workbenchEmployees.find((item) => item.employeeId === employeeId) ?? workbenchEmployees[0]
    if (!employee) throw new Error('暂无可用智能体')
    if (newSessionConversationRef.current) {
      if (newSessionConversationRef.current.employeeId !== employee.employeeId) {
        throw new Error('已有附件属于另一位员工，请先移除附件')
      }
      return newSessionConversationRef.current
    }
    if (newSessionCreationRef.current) return newSessionCreationRef.current

    const promise = agentApi.createConversation({ kind: 'chat', entry_employee_id: employee.employeeId })
      .then((created) => {
        const existing = useChatStore.getState().conversations.find((item) => item.id === created.id)
        const ensured: EnsuredConversation = {
          id: created.id,
          employeeId: employee.employeeId,
          item: existing ?? {
            id: created.id,
            title: created.title ?? '新会话',
            agentEmoji: '🤖',
            agentName: employee.displayName,
            agentAvatarUrl: employee.avatarUrl ?? null,
            lastMessage: '',
            time: '刚刚',
            _employeeId: employee.employeeId,
          },
        }
        rememberEmployeeConversation(created.id, employee.employeeId)
        newSessionConversationRef.current = ensured
        return ensured
      })
      .finally(() => {
        newSessionCreationRef.current = null
      })
    newSessionCreationRef.current = promise
    return promise
  }, [workbenchEmployees])

  const handleNewSessionUpload = useCallback(async (file: CachedFile, employeeId?: string): Promise<string> => {
    const conversation = await ensureNewSessionConversation(employeeId)
    return uploadAttachment(conversation.id, file)
  }, [ensureNewSessionConversation])

  const handleDeleteNewSessionUpload = useCallback(async (attachmentId: string): Promise<void> => {
    const conversation = newSessionConversationRef.current
    if (!conversation) return
    await agentApi.deleteFile(conversation.id, 'attachment', attachmentId)
  }, [])

  const startNewSession = useCallback(async (
    text: string,
    files: UploadableChatFile[] = [],
    employeeId?: string,
  ): Promise<boolean> => {
    const trimmed = text.trim()
    if (!trimmed) {
      if (files.length > 0) setNewSessionError('新会话需要先输入一句任务描述。')
      return false
    }
    const employee = workbenchEmployees.find(e => e.employeeId === employeeId) ?? workbenchEmployees[0]
    if (!employee) {
      setNewSessionError('暂无可用智能体,请先同步或创建一个智能体。')
      return false
    }
    if (uploadedAttachmentIds(files).length !== files.length) return false

    setNewSessionError(null)
    setSendError(null)
    setIsGenerating(true)

    // 发送时输入框已清空；切到新会话后新会话页的输入框已卸载，失败时把内容写回该会话的草稿，
    // 由会话输入框放回。尚未切换时新会话页的输入框自己放回。
    let activatedConversationId: string | null = null
    try {
      const conversation = await ensureNewSessionConversation(employee.employeeId)
      const existing = useChatStore.getState().conversations.some((item) => item.id === conversation.id)
      const item = {
        ...conversation.item,
        title: trimmed.slice(0, 28),
      }
      if (!existing) addConversation(item)
      setConvDraft('', '', [])
      loadedConversationRef.current = conversation.id
      setActiveConvId(conversation.id)
      activatedConversationId = conversation.id
      newSessionConversationRef.current = null

      const sent = await submitMessage({ ...conversation, item }, trimmed, files)
      if (!sent) {
        setSendError('发送失败，请重试。')
        setConvDraft(conversation.id, trimmed, files)
      }
      return sent
    } catch (error) {
      console.error('[Chat] createConversation failed:', error)
      if (activatedConversationId) setConvDraft(activatedConversationId, trimmed, files)
      setNewSessionError(error instanceof Error && error.message ? error.message : '创建新会话失败，请重试。')
      return false
    } finally {
      setIsGenerating(false)
    }
  }, [workbenchEmployees, addConversation, ensureNewSessionConversation, setActiveConvId, setConvDraft, submitMessage])

  const handleDraftChange = useCallback((convId: string, text: string, files: CachedFile[]) => {
    setConvDraft(convId, text, files)
  }, [setConvDraft])

  const getDisplayContent = (msg: Message): { content: string; streaming: boolean } => ({
    content: msg.content,
    streaming: msg.role === 'assistant' && streamState.active.has(msg.id),
  })

  // ── Render ───────────────────────────────────────────────────────────────────

  if (!activeConvId) {
    if (workbenchLoading) {
      return <div className="chat chat-history-state" role="status">正在加载员工与会话…</div>
    }
    if (workbenchError) {
      return (
        <div className="chat chat-request-state">
          <RequestErrorState
            error={workbenchError}
            onRetry={() => void loadAgentsAndConversations()}
            retrying={workbenchLoading || workbenchRefreshing}
          />
        </div>
      )
    }
    return (
      <NewSessionPage
        onSend={(text, files, employeeId) => startNewSession(text, files, employeeId ?? (location.state as { employeeId?: string } | null)?.employeeId)}
        onPickFile={pickFileAction}
        onUploadFile={handleNewSessionUpload}
        onDeleteUploadedFile={handleDeleteNewSessionUpload}
        disabled={isGenerating}
        draft={draftsByConv['']?.text}
        draftFiles={draftsByConv['']?.files}
        onDraftChange={handleDraftChange}
        error={newSessionError}
        employees={workbenchEmployees}
      />
    )
  }

  return (
    <div className="chat">
      {/* Header */}
      <ChatHeader
        avatar={renderAvatar(
          getEmployeeAvatar(conv?.agentName ?? '助手', conv?.agentAvatarUrl),
          getAvatarFallback(conv?.agentName ?? '助手'),
        )}
        name={conv?.agentName ?? '助手'}
        subtitle={`${activeEmployeePresence.label} · ${activeEmployeePresence.lastSeenLabel}`}
        onMoreClick={toggleDetail}
        onFilesClick={() => setFilesConversationId(activeConvId)}
      />

      {filesConversationId === activeConvId && <ChatDialog title="会话文件目录" onClose={() => setFilesConversationId(null)}>
        {activeConvId.startsWith('emp_') ? <p className="chat-tools-note">暂无生成文件</p> : <ConversationFiles conversationId={activeConvId} />}
      </ChatDialog>}
      {readSyncError && <div className="chat-read-notice" role="alert">{readSyncError}</div>}

      {/* Message list */}
      <div className="chat-messages" ref={msgListRef}>
        <div className="chat-messages-inner">
          {activeMessagesLoading ? (
            <div className="chat-history-state" role="status">正在加载会话消息…</div>
          ) : activeMessagesError ? (
            <RequestErrorState
              error={activeMessagesError}
              onRetry={() => setMessageLoadAttempt((attempt) => attempt + 1)}
            />
          ) : messages.length === 0 ? (
            <div className="chat-history-state empty">还没有消息，发送一条消息开始对话。</div>
          ) : messages.map((msg, i) => {
            const { content, streaming } = getDisplayContent(msg)
            // 相邻消息间隔 > 5 分钟时插入时间分隔标签(设计文档 5.1.3)。
            const prev = messages[i - 1]
            const showTimeDivider = prev && msg._ts && prev._ts && msg._ts - prev._ts > 5 * 60_000
            const resetPlacement = contextResetPlacement(msg, i, resetDividers)
            return (
              <div key={msg.id}>
                {resetPlacement.before && <ContextResetDivider conversationId={activeConvId} resetId={resetPlacement.before} memoryText={contextResetMemoryText(resetPlacement.before, resetDividers)} segments={segments} messages={messages} dividers={resetDividers} />}
                {showTimeDivider && (
                  <div className="chat-time-divider">
                    <span>{formatMessageDivider(msg._ts!)}</span>
                  </div>
                )}
                <div
                  ref={(el) => { msgRowRefs.current[msg.id] = el }}
                  className={`chat-msg-row${flashMsgId === msg.id ? ' highlight' : ''}${msg.status === 'failed' && msg.role === 'user' ? ' failed' : ''}`}
                  style={i < loadedMsgCountRef.current ? { animationDelay: `${Math.min(i, 5) * 60}ms` } : undefined}
                  title={msg.status === 'failed' && msg.role === 'user' ? '消息发送失败，可在输入框中重试' : undefined}
                >
                  <MessageRow
                    conversationId={activeConvId}
                    msg={msg}
                    convAgentName={conv?.agentName ?? '助手'}
                    agentAvatarUrl={conv?.agentAvatarUrl}
                    userAvatar={userId.slice(0, 1).toUpperCase()}
                    displayContent={content}
                    isThisStreaming={streaming}
                    isThinkingPhase={streaming && content === ''}
                  />
                  {msg.status === 'failed' && msg.role === 'user' && (
                    <span className="chat-message-failed-label" role="alert">发送失败</span>
                  )}
                </div>
                {resetPlacement.after && <ContextResetDivider conversationId={activeConvId} resetId={resetPlacement.after} memoryText={contextResetMemoryText(resetPlacement.after, resetDividers)} segments={segments} messages={messages} dividers={resetDividers} />}
              </div>
            )
          })}
        </div>
        {!activeMessagesError && showJumpToLatest && (
          <button
            type="button"
            className="chat-jump-latest"
            onClick={() => {
              scrollToBottom()
              setShowJumpToLatest(false)
            }}
          >
            ↓ 新消息
          </button>
        )}
      </div>

      <ContextResetFeedback reset={contextReset} generating={generatingConvIds.has(activeConvId)} />

      {/* Input bar */}
      <ChatInputBar
        onSend={sendMessage}
        onPickFile={pickFileAction}
        onUploadFile={handleUploadFile}
        onDeleteUploadedFile={handleDeleteUploadedFile}
        disabled={activeMessagesLoading || Boolean(activeMessagesError) || Boolean(unavailableMessage)}
        placeholder={unavailableMessage ?? '输入消息…'}
        convId={activeConvId}
        conversationUpgradeFrom={[...upgradedConversationIdsRef.current].find(([, id]) => id === activeConvId)?.[0]}
        draft={draftsByConv[activeConvId]?.text}
        draftFiles={draftsByConv[activeConvId]?.files}
        onDraftChange={handleDraftChange}
        isGenerating={generatingConvIds.has(activeConvId)}
        isSyncing={syncingConvIds.has(activeConvId)}
        onAbort={() => handleAbort(activeConvId)}
        enableVoiceInput
        enableKnowledgeFiles
        tools={!activeMessagesLoading && !activeMessagesError && !unavailableMessage && !activeConvId.startsWith('emp_') && (
          <ContextOutcomePrompt
            conversationId={activeConvId}
            segment={segmentMessages}
            generating={generatingConvIds.has(activeConvId)}
            reset={contextReset}
            anchor={<ContextResetToolButton reset={contextReset} generating={generatingConvIds.has(activeConvId)} hasContext={segmentMessages.length > 0} />}
          />
        )}
        helper={<>
          {sendError && <p className="chat-input-error" role="alert">{sendError}</p>}
          <div className="chat-composer-footer">
            <ConversationPermissions conversationId={activeConvId} generating={generatingConvIds.has(activeConvId)} ensureConversation={() => ensureConversation(activeConvId)} />
            <ConversationStatus key={`${activeConvId}:${contextResetCount}`} conversationId={activeConvId} generating={generatingConvIds.has(activeConvId)} unavailable={Boolean(unavailableMessage)} />
          </div>
        </>}
      />
    </div>
  )
}
