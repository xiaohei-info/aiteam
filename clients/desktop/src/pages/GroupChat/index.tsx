import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { GitBranch } from 'lucide-react'
import '../Chat/Chat.css'
import { useChatStore, type Message } from '../../stores/chat'
import { useAgentAuthStore } from '../../stores/agentAuth'
import { pickAndCacheFile, readCachedFileBlob, type CachedFile } from '../../lib/fileCache'
import {
  uploadedAttachmentIds,
  uploadedMessageAttachments,
  type UploadableChatFile,
} from '../../lib/chatAttachmentUpload'
import { blobToBase64 } from '../../lib/messageSender'
import { submitGroupPrompt } from '../../lib/groupPrompt'
import type { GroupMember } from '../../stores/chat'
import { agentApi, AgentApiError } from '../../api/agent'
import { globalActivityCollector } from '../../lib/globalActivityCollector'
import { useStreamRun } from '../../hooks/useStreamRun'
import { useChatScroll } from '../../hooks/useChatScroll'
import { MessageRow } from '../../components/Chat/MessageRow'
import { ChatInputBar } from '../../components/Chat/ChatInputBar'
import { ChatHeader } from '../../components/Chat/ChatHeader'
import { ChatDialog } from '../../components/Chat/ChatDialog'
import ConversationFiles from '../../components/Chat/ConversationFiles'
import { ConversationPermissions } from '../../components/Chat/ConversationPermissions'
import { ConversationStatus } from '../../components/Chat/ConversationStatus'
import { ContextOutcomePrompt } from '../../components/Chat/ContextOutcomePrompt'
import { ContextResetFeedback, ContextResetToolButton } from '../../components/Chat/ContextResetControls'
import { ContextResetDivider } from '../../components/Chat/ContextResetDivider'
import { useConversationSegments } from '../../hooks/useConversationSegments'
import { useContextReset } from '../../hooks/useContextReset'
import { currentSegmentMessages } from '../../lib/contextOutcome'
import { anchorTrailingDivider, contextResetDividers, contextResetMemoryText, contextResetPlacement } from '../../lib/piConverters'
import GroupAvatar from '../../components/Chat/GroupAvatar'
import { MemberInfoPopup } from '../../components/Chat/MemberInfoPopup'
import RequestErrorState from '../../components/RequestState/RequestErrorState'
import { getLastReadEntryId } from '../../lib/readAnchor'
import { isAppFocused, useAppFocus } from '../../hooks/useAppFocus'
import { shouldShowGroupAssignmentTransition } from '../../lib/groupAssignmentTransition'
import { resolveFixedWorkflowProgressAvailability } from '../../lib/fixedWorkflowProgress'

export default function GroupChat() {
  const {
    activeGroupId, groups, toggleGroupDetail,
    activeConvMessages, activeConvRawItems, appendMessage,
    updateMessageStatus, clearGroupUnread, loadGroupConversation, refreshActiveEntries,
    loadMoreMessages, activePagination, draftsByConv, setConvDraft, generatingConvIds, syncingConvIds,
    dropStaleConversation,
    workbenchLoading, workbenchRefreshing, workbenchError, loadAgentsAndConversations,
    activeMessagesLoading, activeMessagesError,
    groupSolutions,
    highlightMsgId, setHighlightMsgId,
  } = useChatStore()
  const userId = useAgentAuthStore((s) => s.account) ?? 'guest'
  const group = groups.find((g) => g.id === activeGroupId)
  const messages = activeConvMessages
  const entryDividers = useMemo(() => contextResetDividers(activeConvRawItems), [activeConvRawItems])
  const resetDividers = useMemo(() => anchorTrailingDivider(entryDividers, messages), [entryDividers, messages])
  // 开启新上下文后递增,让 ConversationStatus 重新挂载并重新读取上下文用量。
  const [contextResetCount, setContextResetCount] = useState(0)
  const segments = useConversationSegments(activeGroupId, contextResetCount)
  const segmentMessages = useMemo(() => currentSegmentMessages(messages, resetDividers), [messages, resetDividers])
  const contextReset = useContextReset(activeGroupId ?? '', (result) => {
    if (result.segment) segments.upsert(result.segment)
    setContextResetCount((count) => count + 1)
    if (activeGroupId) refreshActiveEntries(activeGroupId).catch(console.error)
  })

  const [memberPopup, setMemberPopup] = useState<{ member: GroupMember; anchor: { x: number; y: number } } | null>(null)
  const [filesConversationId, setFilesConversationId] = useState<string | null>(null)
  const [readSyncError, setReadSyncError] = useState<string | null>(null)
  const [flashMsgId, setFlashMsgId] = useState<string | null>(null)
  const msgRowRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { streamState, beginAssistantStream } = useStreamRun()
  const showAssignmentTransition = shouldShowGroupAssignmentTransition(
    generatingConvIds.has(activeGroupId ?? ''),
    messages,
    streamState.active,
  )
  const workflowProgress = resolveFixedWorkflowProgressAvailability(
    group?.solutionInstanceId ?? null,
    groupSolutions,
  )

  const { msgListRef, scrollToBottom } = useChatScroll({
    messagesLength: messages.length,
    activeId: activeGroupId,
    hasMore: activePagination.hasMore,
    loadMore: loadMoreMessages,
    isGroup: true,
  })

  useEffect(() => {
    if (!activeGroupId) return
    loadGroupConversation(activeGroupId)
  }, [activeGroupId]) // eslint-disable-line react-hooks/exhaustive-deps

  const appFocused = useAppFocus()
  const lastEntryId = getLastReadEntryId(activeConvRawItems)

  // 当前群聊在前台获得焦点时，等 entries 加载完成后用最后一个真实 entry id 上报。
  useEffect(() => {
    if (!activeGroupId) return
    if (!appFocused || !isAppFocused() || activeMessagesLoading || !lastEntryId) return
    let cancelled = false
    // 群 404 同样剥离,和私聊逻辑对称。
    agentApi.markConversationRead(activeGroupId, lastEntryId)
      .then(() => {
        if (cancelled || !isAppFocused()) return
        clearGroupUnread(activeGroupId)
        setReadSyncError(null)
      })
      .catch((err) => {
        if (err instanceof AgentApiError && err.status === 404) {
          dropStaleConversation(activeGroupId, 'group')
          return
        }
        console.error('[GroupChat] markConversationRead failed:', err)
        if (!cancelled) setReadSyncError('已读状态同步失败，将在下次打开时重试')
      })
    return () => { cancelled = true }
  }, [lastEntryId, activeGroupId, group?.unread, appFocused, activeMessagesLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setReadSyncError(null), [activeGroupId])

  // 全局历史搜索通过真实 entry.id 定位；entries 加载完成后滚动并短暂闪烁。
  useEffect(() => {
    if (!highlightMsgId) return
    const target = messages.find((message) => message.id === highlightMsgId || message.entryRefs?.includes(highlightMsgId))
    if (!target) return
    const targetId = target.id
    const frame = requestAnimationFrame(() => {
      const element = msgRowRefs.current[targetId]
      if (!element) return
      element.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setFlashMsgId(targetId)
      setHighlightMsgId(null)
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
      flashTimerRef.current = setTimeout(() => {
        setFlashMsgId(null)
        flashTimerRef.current = null
      }, 2000)
    })
    return () => cancelAnimationFrame(frame)
  }, [highlightMsgId, messages, setHighlightMsgId])

  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
  }, [])

  const handleSend = useCallback(async (text: string, files: UploadableChatFile[], _empId?: string, mentions?: string[]) => {
    if ((!text && files.length === 0) || !activeGroupId || !group) return false

    const now = new Date()
    const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`
    const attachmentIds = uploadedAttachmentIds(files)
    if (attachmentIds.length !== files.length) return false

    const userMsgId = crypto.randomUUID()
    appendMessage(activeGroupId, {
      id: userMsgId,
      role: 'user',
      msgType: 'text',
      content: text,
      time,
      status: 'sending',
      senderRole: 'human',
      attachments: uploadedMessageAttachments(files),
    })

    // 群聊 prompt:mentions 用 @句柄;新栈 handles 从 GroupMember.handle 取。
    // sender 概念在新栈里由服务端根据 Bearer + coordinator/roster 决定,不需要客户端传 senderId。
    const idempotencyKey = crypto.randomUUID()
    try {
      const route = await submitGroupPrompt(
        group,
        text,
        mentions,
        idempotencyKey,
        agentApi.submitPrompt.bind(agentApi),
        attachmentIds,
      )
      beginAssistantStream(activeGroupId, {
        kind: 'group',
        targetEmployeeIds: route.targetEmployeeIds,
        expectedTargetsKnown: route.targetsKnown,
        promptIdempotencyKey: idempotencyKey,
      })
    } catch (err) {
      console.error('[GroupChat] submitPrompt failed:', err)
      updateMessageStatus(activeGroupId, userMsgId, 'failed')
      return false
    }
    updateMessageStatus(activeGroupId, userMsgId, 'sent')

    const groupName = useChatStore.getState().groups.find(g => g.id === activeGroupId)?.name || '未知群组'
    const activityTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    globalActivityCollector.emit({
      time: activityTime, agent: groupName, text: '收到消息,思考中...', type: 'thinking', convId: activeGroupId,
    })
    return true
  }, [activeGroupId, group, appendMessage, updateMessageStatus, beginAssistantStream])

  const handlePickFile = useCallback(
    () => pickAndCacheFile(userId, activeGroupId || 'group'),
    [userId, activeGroupId],
  )

  const handleUploadFile = useCallback(async (file: CachedFile): Promise<string> => {
    if (!activeGroupId) throw new Error('请先选择群聊')
    const data = await blobToBase64(await readCachedFileBlob(file))
    const uploaded = await agentApi.uploadFile(activeGroupId, 'attachment', {
      filename: file.name,
      mime_type: file.mime,
      data,
    })
    return uploaded.id
  }, [activeGroupId])

  const handleDeleteUploadedFile = useCallback(async (attachmentId: string): Promise<void> => {
    if (!activeGroupId) return
    await agentApi.deleteFile(activeGroupId, 'attachment', attachmentId)
  }, [activeGroupId])

  const handleAbort = useCallback(async () => {
    if (!activeGroupId) return
    await useChatStore.getState().abortStream(activeGroupId)
  }, [activeGroupId])

  const handleDraftChange = useCallback((convId: string, text: string, files: CachedFile[]) => {
    setConvDraft(convId, text, files)
  }, [setConvDraft])

  const ensureGroupConversation = useCallback(async () => {
    if (!activeGroupId) throw new Error('请先选择群聊')
    return { id: activeGroupId }
  }, [activeGroupId])

  const handleAvatarClick = useCallback((msg: Message, e: MouseEvent<HTMLButtonElement>) => {
    const members = group?.members ?? []
    const member = members.find((m) => m.employee_id === msg.senderEmployeeId)
    if (!member) return
    const rect = e.currentTarget.getBoundingClientRect()
    setMemberPopup({ member, anchor: { x: rect.right + 8, y: rect.top } })
  }, [group])

  if (!group) {
    if (workbenchLoading) {
      return <div className="chat chat-history-state" role="status">正在加载群聊…</div>
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
      <div className="chat" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>选择一个群聊开始对话</p>
      </div>
    )
  }

  return (
    <div className="chat">
      <ChatHeader
        avatar={(
          <GroupAvatar
            members={group.members ?? []}
            label={`${group.name}群头像`}
            rosterDescription={group.rosterMessage}
          />
        )}
        name={group.name}
        subtitle={group.memberCount === null ? '成员信息不可用' : `${group.memberCount} 位成员`}
        onFilesClick={() => setFilesConversationId(activeGroupId)}
        onMoreClick={toggleGroupDetail}
      />

      {filesConversationId === activeGroupId && <ChatDialog title="会话文件目录" onClose={() => setFilesConversationId(null)}>
        <ConversationFiles conversationId={activeGroupId} />
      </ChatDialog>}

      {workflowProgress.status === 'unavailable' && (
        <div className="chat-workflow-status" role="status">
          <GitBranch size={15} strokeWidth={1.8} aria-hidden="true" />
          <div>
            <strong>{workflowProgress.title}</strong>
            <span>{workflowProgress.reason}</span>
          </div>
        </div>
      )}

      {readSyncError && <div className="chat-read-notice" role="alert">{readSyncError}</div>}

      <div className="chat-messages" ref={msgListRef}>
        <div className="chat-messages-inner">
          {activeMessagesLoading ? (
            <div className="chat-history-state" role="status">正在加载群聊消息…</div>
          ) : activeMessagesError ? (
            <RequestErrorState
              error={activeMessagesError}
              onRetry={() => void loadGroupConversation(activeGroupId)}
              retrying={activeMessagesLoading}
            />
          ) : messages.length === 0 && !showAssignmentTransition ? (
            <div className="chat-history-state empty">还没有群聊消息，发送一条消息开始协作。</div>
          ) : messages.map((msg: Message, i) => {
            const streaming = msg.role === 'assistant' && streamState.active.has(msg.id)
            const isThinkingPhase = streaming && msg.content === ''
            const resetPlacement = contextResetPlacement(msg, i, resetDividers)
            return (
              <Fragment key={msg.id}>
              {resetPlacement.before && <ContextResetDivider conversationId={activeGroupId} resetId={resetPlacement.before} memoryText={contextResetMemoryText(resetPlacement.before, resetDividers)} segments={segments} messages={messages} dividers={resetDividers} />}
              <div
                ref={(element) => { msgRowRefs.current[msg.id] = element }}
                className={`chat-msg-row${flashMsgId === msg.id ? ' highlight' : ''}${msg.status === 'failed' && msg.role === 'user' ? ' failed' : ''}`}
                title={msg.status === 'failed' && msg.role === 'user' ? '消息发送失败' : undefined}
              >
                <MessageRow
                  conversationId={activeGroupId}
                  msg={msg}
                  agentAvatarUrl={group.members?.find((member) => member.employee_id === msg.senderEmployeeId)?.avatar_url}
                  userAvatar={userId.slice(0, 1).toUpperCase()}
                  displayContent={msg.content}
                  isThisStreaming={streaming}
                  isThinkingPhase={isThinkingPhase}
                  onAvatarClick={msg.role === 'assistant' && msg.senderEmployeeId ? (e) => handleAvatarClick(msg, e) : undefined}
                />
                {msg.status === 'failed' && msg.role === 'user' && (
                  <span className="chat-message-failed-label" role="alert">发送失败</span>
                )}
              </div>
              {resetPlacement.after && <ContextResetDivider conversationId={activeGroupId} resetId={resetPlacement.after} memoryText={contextResetMemoryText(resetPlacement.after, resetDividers)} segments={segments} messages={messages} dividers={resetDividers} />}
              </Fragment>
            )
          })}
          {showAssignmentTransition && (
            <div className="chat-assignment-row" role="status" aria-live="polite">
              <div className="chat-assignment-avatar" aria-hidden="true">AI</div>
              <div className="chat-assignment-bubble">
                <span>AI 分配中</span>
                <span className="chat-assignment-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <ContextResetFeedback reset={contextReset} generating={generatingConvIds.has(activeGroupId)} />

      <ChatInputBar
        onSend={handleSend}
        onPickFile={handlePickFile}
        onUploadFile={handleUploadFile}
        onDeleteUploadedFile={handleDeleteUploadedFile}
        convId={activeGroupId}
        draft={draftsByConv[activeGroupId]?.text}
        draftFiles={draftsByConv[activeGroupId]?.files}
        onDraftChange={handleDraftChange}
        disabled={activeMessagesLoading || Boolean(activeMessagesError)}
        isGenerating={generatingConvIds.has(activeGroupId)}
        isSyncing={syncingConvIds.has(activeGroupId)}
        onAbort={handleAbort}
        onHeightChange={scrollToBottom}
        members={group.members ?? []}
        enableVoiceInput
        enableKnowledgeFiles
        tools={!activeMessagesLoading && !activeMessagesError && (
          <ContextOutcomePrompt
            conversationId={activeGroupId}
            segment={segmentMessages}
            generating={generatingConvIds.has(activeGroupId)}
            reset={contextReset}
            anchor={<ContextResetToolButton reset={contextReset} generating={generatingConvIds.has(activeGroupId)} hasContext={segmentMessages.length > 0} />}
          />
        )}
        helper={<div className="chat-composer-footer">
          <ConversationPermissions
            conversationId={activeGroupId}
            generating={generatingConvIds.has(activeGroupId)}
            ensureConversation={ensureGroupConversation}
          />
          <ConversationStatus
            key={`${activeGroupId}:${contextResetCount}`}
            conversationId={activeGroupId}
            generating={generatingConvIds.has(activeGroupId)}
          />
        </div>}
      />

      {memberPopup && (
        <MemberInfoPopup
          member={memberPopup.member}
          anchor={memberPopup.anchor}
          onClose={() => setMemberPopup(null)}
        />
      )}
    </div>
  )
}
