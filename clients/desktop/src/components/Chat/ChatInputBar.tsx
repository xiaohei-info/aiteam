import { useState, useRef, useEffect, useLayoutEffect, useCallback, useId, memo, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { ArrowUp, BookOpen, ChevronDown, Mic, Paperclip, Plus, Square, X } from 'lucide-react'
import type { CachedFile } from '../../lib/fileCache'
import {
  attachmentErrorMessage,
  beginAttachmentUpload,
  completeAttachmentUpload,
  failAttachmentUpload,
  hasBlockingAttachmentUpload,
  removeAttachmentUpload,
  runWhenAttachmentsReady,
  type UploadableChatFile,
} from '../../lib/chatAttachmentUpload'
import { composerRestoreTarget } from '../../lib/chatComposerRestore'
import type { WorkbenchEmployee } from '../../lib/employeeConversationMap'
import type { GroupMember } from '../../stores/chat'
// Phase 3:语音转写从旧 /api/team/stt 切到新栈 /api/agent/audio/transcriptions。
// 服务端契约:{ filename, mime_type, data (base64) } → { text, duration? }。
// 单文件 ≤5 MiB;Manager 不可达 → 503,由调用方兜底。
import { backendApi } from '../../api/backend'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'
import { useVoiceInput, type VoiceRecording } from '../../hooks/useVoiceInput'
import MentionInput, { type MentionInputHandle, type MentionInputSnapshot } from './MentionInput'
import { ChatSendQueue } from './ChatSendQueue'
import {
  enqueueMessage,
  moveQueuedMessage,
  prependQueuedMessage,
  promoteQueuedMessage,
  removeQueuedMessage,
  renameQueue,
  replaceQueuedMessage,
  shouldDispatchQueue,
  takeNextQueuedMessage,
  type ChatSendQueues,
  type QueuedChatMessage,
} from '../../lib/chatSendQueue'
import { KnowledgeFilePicker } from './KnowledgeFilePicker'
import { FileChip } from './FileChip'
import { isImeKeyboardEvent } from '../../lib/imeKeyboard'

const CHAT_TEXTAREA_MIN_HEIGHT = 60
const CHAT_TEXTAREA_MAX_HEIGHT = 240

export interface ChatInputBarProps {
  onSend: (text: string, files: UploadableChatFile[], employeeId?: string, mentions?: string[]) => boolean | Promise<boolean>
  onPickFile: () => Promise<CachedFile | null>
  onUploadFile?: (file: CachedFile, employeeId?: string) => Promise<string>
  onDeleteUploadedFile?: (attachmentId: string) => Promise<unknown>
  disabled?: boolean
  convId: string
  conversationUpgradeFrom?: string
  draft?: string
  draftFiles?: CachedFile[]
  onDraftChange: (convId: string, text: string, files: CachedFile[]) => void
  employees?: WorkbenchEmployee[]
  members?: GroupMember[]
  variant?: 'dock' | 'hero'
  placeholder?: string
  autoFocus?: boolean
  helper?: ReactNode
  /** 追加在附件、知识库按钮之后的工具按钮（如开启新上下文）。 */
  tools?: ReactNode
  isGenerating?: boolean
  /** 本轮生成已结束、正在拉历史对齐；期间发送的消息排队，对齐完成后再发。 */
  isSyncing?: boolean
  onAbort?: () => void
  onHeightChange?: (height: number) => void
  /** 显示按住说话的语音输入按钮（单聊/群聊对话界面） */
  enableKnowledgeFiles?: boolean
  enableVoiceInput?: boolean
}

export const ChatInputBar = memo(({
  onSend, onPickFile, onUploadFile, onDeleteUploadedFile,
  disabled, convId, conversationUpgradeFrom, draft, draftFiles, onDraftChange,
  variant = 'dock', placeholder = '输入消息…', autoFocus, helper, tools,
  employees = [], members, isGenerating, isSyncing, onAbort, onHeightChange, enableVoiceInput, enableKnowledgeFiles,
}: ChatInputBarProps) => {
  const [knowledgeOpen, setKnowledgeOpen] = useState(false)
  const [fileError, setFileError] = useState('')
  const [input, setInput] = useState(draft ?? '')
  const [pendingFiles, setPendingFiles] = useState<UploadableChatFile[]>(draftFiles ?? [])
  const [isPickingFile, setIsPickingFile] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [textareaHeight, setTextareaHeight] = useState(CHAT_TEXTAREA_MIN_HEIGHT)
  const [selectedRoles, setSelectedRoles] = useState<string[]>([])
  const [roleOpen, setRoleOpen] = useState(false)
  const mentionInputRef = useRef<MentionInputHandle>(null)
  const mentionTextRef = useRef({ text: draft ?? '', mentions: [] as string[] })
  const [mentionText, setMentionText] = useState(draft ?? '')
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const roleRef = useRef<HTMLDivElement>(null)
  const roleTriggerRef = useRef<HTMLButtonElement>(null)
  const roleMenuId = useId()
  const inputRef = useRef(input)
  inputRef.current = input
  const filesRef = useRef(pendingFiles)
  filesRef.current = pendingFiles
  const cancelledUploadIdsRef = useRef(new Set<string>())
  const prevConvRef = useRef(convId)
  const conversationUpgradeFromRef = useRef(conversationUpgradeFrom)
  conversationUpgradeFromRef.current = conversationUpgradeFrom
  const prevMentionModeRef = useRef(members !== undefined && members.length > 0)
  const isComposingRef = useRef(false)
  const isMentionMode = members !== undefined && members.length > 0
  // 正在发送的会话；emp_ 升级为真实会话时跟着更新，用于判断失败时把内容放回哪里。
  const submittingConvRef = useRef<string | null>(null)
  const mountedRef = useRef(false)
  const adoptedDraftRef = useRef({ convId, draft, draftFiles })
  // 生成中发送的消息按会话排队，本轮结束后依次发出；队首发送失败时暂停该会话的队列。
  const [queues, setQueues] = useState<ChatSendQueues<MentionInputSnapshot>>({})
  const queuesRef = useRef(queues)
  queuesRef.current = queues
  const [pausedQueues, setPausedQueues] = useState<ReadonlySet<string>>(() => new Set())
  const canQueue = variant !== 'hero'

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const handleCloseRolePicker = useCallback(() => {
    setRoleOpen(false)
    window.requestAnimationFrame(() => roleTriggerRef.current?.focus())
  }, [])

  useGlobalShortcutClose({ active: roleOpen, onClose: handleCloseRolePicker })

  useLayoutEffect(() => {
    const nextDraft = draft ?? ''
    const previousConvId = prevConvRef.current
    const conversationChanged = previousConvId !== convId
    // emp_ 是尚未落库的同一单聊。附件上传前创建真实会话会触发 id 升级，
    // 这不是用户切换会话，必须保留正在上传的文件和当前输入。
    const isConversationUpgrade = conversationChanged
      && previousConvId === conversationUpgradeFrom
      && !convId.startsWith('emp_')
    if (conversationChanged && !isConversationUpgrade) {
      const previousDraft = prevMentionModeRef.current
        ? mentionTextRef.current.text
        : inputRef.current
      const previousFiles = filesRef.current.filter((file) => {
        if (file.upload?.status !== 'uploading') return true
        cancelledUploadIdsRef.current.add(file.upload.clientId)
        return false
      })
      setKnowledgeOpen(false)
      setFileError('')
      onDraftChange(previousConvId, previousDraft, previousFiles)
      setInput(nextDraft)
      setPendingFiles(draftFiles ?? [])
    }
    if (isConversationUpgrade && submittingConvRef.current === previousConvId) submittingConvRef.current = convId
    if (isConversationUpgrade) {
      setQueues((previous) => renameQueue(previous, previousConvId, convId))
      setPausedQueues((previous) => {
        if (!previous.has(previousConvId)) return previous
        const next = new Set(previous)
        next.delete(previousConvId)
        return next.add(convId)
      })
    }
    if (conversationChanged) prevConvRef.current = convId

    // MentionInput 是 contenteditable，必须显式随 convId 恢复/清空 DOM，避免草稿串会话。
    if (isMentionMode && !isConversationUpgrade) {
      mentionTextRef.current = { text: nextDraft, mentions: [] }
      setMentionText(nextDraft)
      mentionInputRef.current?.setText(nextDraft)
    }
    prevMentionModeRef.current = isMentionMode
  }, [convId, isMentionMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // 新会话页发送后已切到会话、输入框换了一个；发送失败时页面把内容写回该会话草稿，
  // 这里在输入框为空时采用它。切换会话的草稿由上面的 effect 处理。
  useLayoutEffect(() => {
    const previous = adoptedDraftRef.current
    adoptedDraftRef.current = { convId, draft, draftFiles }
    if (previous.convId !== convId) return
    if (previous.draft === draft && previous.draftFiles === draftFiles) return
    if ((!draft && !draftFiles?.length) || isSubmitting) return
    const current = isMentionMode ? mentionTextRef.current.text : inputRef.current
    if (current.trim() || filesRef.current.length > 0) return
    if (isMentionMode) {
      mentionTextRef.current = { text: draft ?? '', mentions: [] }
      setMentionText(draft ?? '')
      mentionInputRef.current?.setText(draft ?? '')
    } else {
      setInput(draft ?? '')
    }
    setPendingFiles(draftFiles ?? [])
  }, [convId, draft, draftFiles]) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    const nextHeight = Math.max(CHAT_TEXTAREA_MIN_HEIGHT, Math.min(CHAT_TEXTAREA_MAX_HEIGHT, textarea.scrollHeight))
    textarea.style.height = `${nextHeight}px`
    setTextareaHeight(nextHeight)
  }, [input])

  useEffect(() => {
    if (!roleOpen) return
    const handler = (e: MouseEvent) => {
      if (roleRef.current && !roleRef.current.contains(e.target as Node)) setRoleOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [roleOpen])

  useEffect(() => {
    if (!roleOpen) return
    const frame = window.requestAnimationFrame(() => {
      const options = roleRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')
      const selected = Array.from(options ?? []).find((option) => option.getAttribute('aria-checked') === 'true')
      ;(selected ?? options?.[0])?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [roleOpen])

  useEffect(() => {
    onHeightChange?.(textareaHeight)
  }, [textareaHeight]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleResizeStart = (e: React.MouseEvent) => {
    dragRef.current = { startY: e.clientY, startH: textareaHeight }
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      setTextareaHeight(Math.max(CHAT_TEXTAREA_MIN_HEIGHT, Math.min(CHAT_TEXTAREA_MAX_HEIGHT, dragRef.current.startH + dragRef.current.startY - ev.clientY)))
    }
    const onUp = () => { dragRef.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const handleResizeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    if (e.key === 'Home') setTextareaHeight(CHAT_TEXTAREA_MIN_HEIGHT)
    else if (e.key === 'End') setTextareaHeight(CHAT_TEXTAREA_MAX_HEIGHT)
    else setTextareaHeight((height) => Math.max(
      CHAT_TEXTAREA_MIN_HEIGHT,
      Math.min(CHAT_TEXTAREA_MAX_HEIGHT, height + (e.key === 'ArrowUp' ? 10 : -10)),
    ))
  }

  const handleRolePickerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!roleOpen) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      handleCloseRolePicker()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const options = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]:not(:disabled)'))
    if (options.length === 0) return
    e.preventDefault()
    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Home') options[0].focus()
    else if (e.key === 'End') options[options.length - 1].focus()
    else if (e.key === 'ArrowDown') options[(currentIndex + 1 + options.length) % options.length].focus()
    else options[(currentIndex - 1 + options.length) % options.length].focus()
  }

  const handleUploadFile = useCallback((file: CachedFile, clientId: string = crypto.randomUUID()) => {
    if (!onUploadFile) return
    const uploadingFile = beginAttachmentUpload(file, clientId)
    setPendingFiles((previous) => {
      const index = previous.findIndex((item) => item.upload?.clientId === clientId)
      if (index < 0) return [...previous, uploadingFile]
      return previous.map((item, itemIndex) => itemIndex === index ? uploadingFile : item)
    })

    onUploadFile(file, selectedRoles[0] ?? employees[0]?.employeeId)
      .then(async (attachmentId) => {
        if (!attachmentId) throw new Error('附件服务未返回文件 ID')
        if (cancelledUploadIdsRef.current.delete(clientId)) {
          if (onDeleteUploadedFile) {
            try {
              await onDeleteUploadedFile(attachmentId)
            } catch (error) {
              console.error('[ChatInputBar] cleanup cancelled attachment failed:', error)
            }
          }
          return
        }
        setPendingFiles((previous) => previous.map((item) =>
          item.upload?.clientId === clientId ? completeAttachmentUpload(item, attachmentId) : item,
        ))
      })
      .catch((error: unknown) => {
        if (cancelledUploadIdsRef.current.delete(clientId)) return
        setPendingFiles((previous) => previous.map((item) =>
          item.upload?.clientId === clientId
            ? failAttachmentUpload(item, attachmentErrorMessage(error))
            : item,
        ))
      })
  }, [employees, onDeleteUploadedFile, onUploadFile, selectedRoles])

  const handlePickFile = async () => {
    if (isPickingFile || isSubmitting) return
    setFileError('')
    setIsPickingFile(true)
    try {
      const cached = await onPickFile()
      if (!cached) return
      if (onUploadFile) handleUploadFile(cached)
      else setPendingFiles(prev => [...prev, cached])
    } catch { setFileError('选择文件失败，请重试') }
    finally { setIsPickingFile(false) }
  }

  const handleRemoveFile = useCallback((file: UploadableChatFile, index: number) => {
    setPendingFiles((previous) => file.upload
      ? removeAttachmentUpload(previous, file.upload.clientId)
      : previous.filter((_, itemIndex) => itemIndex !== index))
    if (!file.upload) return
    if (file.upload.status === 'uploading') {
      cancelledUploadIdsRef.current.add(file.upload.clientId)
      return
    }
    if (file.upload.status === 'uploaded' && file.upload.attachmentId && onDeleteUploadedFile) {
      void onDeleteUploadedFile(file.upload.attachmentId).catch((error: unknown) => {
        console.error('[ChatInputBar] delete uploaded attachment failed:', error)
      })
    }
  }, [onDeleteUploadedFile])

  const clearComposer = () => {
    if (isMentionMode) {
      mentionTextRef.current = { text: '', mentions: [] }
      setMentionText('')
      mentionInputRef.current?.clear()
    } else {
      setInput('')
    }
    setPendingFiles([])
  }

  /** 读取输入框当前内容；没有文字也没有附件时返回 null。 */
  const readComposer = (files: UploadableChatFile[]): QueuedChatMessage<MentionInputSnapshot> | null => {
    if (isMentionMode) {
      const { text, mentions } = mentionTextRef.current
      if (!text.trim() && files.length === 0) return null
      return { id: crypto.randomUUID(), text: text.trim(), files, mentions, mentionSnapshot: mentionInputRef.current?.snapshot() }
    }
    const text = inputRef.current.trim()
    if (!text && files.length === 0) return null
    return { id: crypto.randomUUID(), text, files, employeeId: selectedRoles[0] ?? employees[0]?.employeeId }
  }

  const resumeQueue = useCallback((queueConvId: string) => {
    setPausedQueues((previous) => {
      if (!previous.has(queueConvId)) return previous
      const next = new Set(previous)
      next.delete(queueConvId)
      return next
    })
  }, [])

  const handleSend = async () => {
    if (disabled) return
    const queueConvId = prevConvRef.current
    // 生成中、对齐历史中、正在提交或已有排队消息时，新消息排到队尾，保证发送顺序。
    const shouldQueue = canQueue
      && (!!isGenerating || !!isSyncing || isSubmitting || (queuesRef.current[queueConvId]?.length ?? 0) > 0)
    if (isSubmitting && !shouldQueue) return
    await runWhenAttachmentsReady(filesRef.current, !!onUploadFile, async (files) => {
      const composed = readComposer(files)
      if (!composed) return
      if (shouldQueue) {
        flushSync(clearComposer)
        onDraftChange(queueConvId, '', [])
        setQueues((previous) => enqueueMessage(previous, queueConvId, composed))
        resumeQueue(queueConvId)
        return
      }
      const { text, mentions, employeeId, mentionSnapshot } = composed

      // 点击发送立即清空输入框和附件，失败时再放回。
      const submittedInMentionMode = isMentionMode
      const rawText = isMentionMode ? mentionTextRef.current.text : input
      submittingConvRef.current = prevConvRef.current
      flushSync(() => {
        setIsSubmitting(true)
        clearComposer()
      })
      onDraftChange(prevConvRef.current, '', [])

      let sent = false
      try {
        sent = await onSend(text, files, employeeId, mentions)
      } catch (error) {
        // 页面层负责展示具体提交错误。
        console.error('[ChatInputBar] send failed:', error)
      }
      const submittedConversationId = submittingConvRef.current ?? ''
      submittingConvRef.current = null
      const mentionModeNow = prevMentionModeRef.current
      const target = sent ? { kind: 'none' as const } : composerRestoreTarget({
        mounted: mountedRef.current,
        // 请求期间允许用户从侧栏切换会话；失败的内容回到原会话，不覆盖当前会话。
        sameConversation: prevConvRef.current === submittedConversationId,
        composerEmpty: !(mentionModeNow ? mentionTextRef.current.text : inputRef.current).trim() && filesRef.current.length === 0,
        submittedConversationId,
      })
      flushSync(() => {
        setIsSubmitting(false)
        if (target.kind !== 'composer') return
        if (!mentionModeNow) setInput(rawText)
        setPendingFiles(files)
      })
      if (target.kind === 'draft') onDraftChange(target.conversationId, rawText, files)
      if (target.kind !== 'composer') return
      if (mentionModeNow) {
        if (submittedInMentionMode && mentionSnapshot) {
          mentionInputRef.current?.restore(mentionSnapshot)
        } else {
          mentionTextRef.current = { text: rawText, mentions: [] }
          setMentionText(rawText)
          mentionInputRef.current?.setText(rawText)
        }
      } else if (!document.activeElement || document.activeElement === document.body) {
        textareaRef.current?.focus()
      }
    })
  }

  const isHero = variant === 'hero'
  const hasBlockingUpload = !!onUploadFile && hasBlockingAttachmentUpload(pendingFiles)
  const hasComposerContent = (isMentionMode ? !!mentionText.trim() : !!input.trim()) || pendingFiles.length > 0
  // 可排队时提交中也允许继续输入，新消息进入队列。
  const isSubmitBlocking = isSubmitting && !canQueue
  const isSendDisabled = !hasComposerContent
    || hasBlockingUpload
    || !!disabled
    || isSubmitBlocking
  const isInteractionDisabled = !!disabled || isSubmitBlocking

  // ── 待发送队列 ───────────────────────────────────────────────────────────────
  const activeQueue = canQueue ? queues[convId] ?? [] : []
  const isQueuePaused = pausedQueues.has(convId)

  // onSend 绑定的是当前会话，所以只发当前会话的队列；切走的会话回来后继续。
  const dispatchQueued = useCallback(async (queueConvId: string) => {
    const { message, queues: next } = takeNextQueuedMessage(queuesRef.current, queueConvId)
    if (!message) return
    queuesRef.current = next
    submittingConvRef.current = queueConvId
    flushSync(() => {
      setQueues(next)
      setIsSubmitting(true)
    })
    let sent = false
    try {
      sent = await onSend(message.text, message.files, message.employeeId, message.mentions)
    } catch (error) {
      console.error('[ChatInputBar] queued send failed:', error)
    }
    const submittedConversationId = submittingConvRef.current ?? queueConvId
    submittingConvRef.current = null
    if (!mountedRef.current) return
    setIsSubmitting(false)
    if (sent) return
    // 失败的消息回到队首并暂停，避免后面的消息越过它或反复重试。
    setQueues((previous) => prependQueuedMessage(previous, submittedConversationId, message))
    setPausedQueues((previous) => new Set(previous).add(submittedConversationId))
  }, [onSend])

  useEffect(() => {
    if (!canQueue || isQueuePaused) return
    if (!shouldDispatchQueue({
      queueLength: activeQueue.length,
      isGenerating: !!isGenerating,
      isSyncing: !!isSyncing,
      disabled: !!disabled,
      isSubmitting,
    })) return
    void dispatchQueued(convId)
  }, [canQueue, isQueuePaused, activeQueue.length, isGenerating, isSyncing, disabled, isSubmitting, convId, dispatchQueued])

  const handleQueueSendNow = useCallback((id: string) => {
    setQueues((previous) => promoteQueuedMessage(previous, convId, id))
    resumeQueue(convId)
    // 中止当前回复；生成结束后队首（即这条）会被自动发出。
    if (isGenerating) onAbort?.()
  }, [convId, isGenerating, onAbort, resumeQueue])

  const handleQueueMove = useCallback((fromId: string, toId: string) => {
    setQueues((previous) => moveQueuedMessage(previous, convId, fromId, toId))
  }, [convId])

  const handleQueueRemove = useCallback((id: string) => {
    const removed = queuesRef.current[convId]?.find((item) => item.id === id)
    setQueues((previous) => removeQueuedMessage(previous, convId, id))
    if (!removed || !onDeleteUploadedFile) return
    for (const file of removed.files) {
      const attachmentId = file.upload?.status === 'uploaded' ? file.upload.attachmentId : undefined
      if (!attachmentId) continue
      void onDeleteUploadedFile(attachmentId).catch((error: unknown) => {
        console.error('[ChatInputBar] delete queued attachment failed:', error)
      })
    }
  }, [convId, onDeleteUploadedFile])

  // 编辑：把排队消息放回输入框；输入框里原有的内容占用它在队列中的位置。
  const handleQueueEdit = (id: string) => {
    const target = queuesRef.current[convId]?.find((item) => item.id === id)
    if (!target) return
    if (hasBlockingUpload) {
      setFileError('附件上传中，请稍后再编辑排队消息')
      return
    }
    setFileError('')
    const current = readComposer(filesRef.current)
    setQueues((previous) => replaceQueuedMessage(previous, convId, id, current))
    flushSync(() => {
      if (!isMentionMode) setInput(target.text)
      setPendingFiles(target.files)
    })
    if (isMentionMode) {
      if (target.mentionSnapshot) {
        mentionInputRef.current?.restore(target.mentionSnapshot)
      } else {
        mentionTextRef.current = { text: target.text, mentions: [] }
        setMentionText(target.text)
        mentionInputRef.current?.setText(target.text)
      }
      mentionInputRef.current?.focus()
    } else {
      textareaRef.current?.focus()
    }
  }

  // ── 语音输入（按住说话） ─────────────────────────────────────────────────────
  const voiceConversationRef = useRef(convId)
  const voicePointerInsideRef = useRef(true)
  const voicePressTokenRef = useRef(0)
  const voiceKeyboardActiveRef = useRef(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const voiceErrorTimerRef = useRef<number | null>(null)
  const insertTranscriptRef = useRef<(transcript: string) => void>(() => {})

  const showVoiceError = useCallback((message: string) => {
    setVoiceError(message)
    if (voiceErrorTimerRef.current !== null) window.clearTimeout(voiceErrorTimerRef.current)
    voiceErrorTimerRef.current = window.setTimeout(() => setVoiceError(null), 2500)
  }, [])

  const insertTranscript = useCallback((transcript: string) => {
    if (isMentionMode) {
      mentionInputRef.current?.insertText(transcript)
    } else {
      setInput(prev => prev ? prev + transcript : transcript)
    }
  }, [isMentionMode])
  insertTranscriptRef.current = insertTranscript

  const transcribe = useCallback(async (recording: VoiceRecording) => {
    const recordingConversationId = voiceConversationRef.current
    try {
      // 新栈契约:filename 需要一个安全字符串(不含路径分隔符 / 控制字符),
      // 时长信息由服务端自行解码后返回,durationMs 不再上传。
      const ext = recording.mimeType.includes('wav') ? 'wav'
        : recording.mimeType.includes('mp3') ? 'mp3'
        : recording.mimeType.includes('webm') ? 'webm'
        : 'm4a'
      const result = await backendApi.transcribeAudio({
        filename: `voice-${Date.now()}.${ext}`,
        mime_type: recording.mimeType,
        data: recording.base64,
      })
      if (prevConvRef.current !== recordingConversationId && conversationUpgradeFromRef.current !== recordingConversationId) return
      insertTranscriptRef.current(result.text)
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : '语音识别服务暂不可用'
      showVoiceError(message)
    }
  }, [showVoiceError])

  const isTranscribingRef = useRef<(isTranscribing: boolean) => void>(() => {})
  const voice = useVoiceInput({
    onAutoStop: (recording) => {
      isTranscribingRef.current(true)
      transcribe(recording).finally(() => isTranscribingRef.current(false))
    },
  })
  isTranscribingRef.current = voice.setIsTranscribing

  useEffect(() => {
    if (voice.error) showVoiceError(voice.error)
  }, [voice.error]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    if (voiceErrorTimerRef.current !== null) window.clearTimeout(voiceErrorTimerRef.current)
  }, [])

  const handleVoicePressStart = useCallback(() => {
    voiceConversationRef.current = prevConvRef.current
    const token = ++voicePressTokenRef.current
    voicePointerInsideRef.current = true
    void voice.start().then((started) => {
      if (started && voicePressTokenRef.current !== token) voice.cancel()
    })
  }, [voice])

  const handleVoicePressEnd = useCallback(() => {
    voicePressTokenRef.current += 1
    if (!voicePointerInsideRef.current) {
      voice.cancel()
      return
    }
    const finish = voice.stop()
    voice.setIsTranscribing(true)
    finish.then((recording) => {
      if (!recording) {
        voice.setIsTranscribing(false)
        return
      }
      return transcribe(recording).finally(() => voice.setIsTranscribing(false))
    })
  }, [voice, transcribe])

  const handleVoicePressCancel = useCallback(() => {
    voicePressTokenRef.current += 1
    voiceKeyboardActiveRef.current = false
    voice.cancel()
  }, [voice])

  const handleVoicePointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    handleVoicePressStart()
  }, [disabled, handleVoicePressStart])

  const handleVoiceKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['Enter', ' '].includes(e.key) || e.repeat || voiceKeyboardActiveRef.current) return
    e.preventDefault()
    voiceKeyboardActiveRef.current = true
    handleVoicePressStart()
  }, [handleVoicePressStart])

  const handleVoiceKeyUp = useCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['Enter', ' '].includes(e.key) || !voiceKeyboardActiveRef.current) return
    e.preventDefault()
    voiceKeyboardActiveRef.current = false
    voicePointerInsideRef.current = true
    handleVoicePressEnd()
  }, [handleVoicePressEnd])

  const formatDuration = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${minutes}:${seconds.toString().padStart(2, '0')}`
  }

  const isVoiceActive = enableVoiceInput && !isHero

  return (
    <div className={`chat-input-bar${isHero ? ' chat-input-bar-hero' : ''}${disabled ? ' chat-input-bar-disabled' : ''}`}>
      {!isHero && (
        <div
          className="chat-resize-handle"
          onMouseDown={handleResizeStart}
          onKeyDown={handleResizeKeyDown}
          role="separator"
          tabIndex={0}
          aria-label="调整消息输入框高度"
          aria-orientation="horizontal"
          aria-valuemin={CHAT_TEXTAREA_MIN_HEIGHT}
          aria-valuemax={CHAT_TEXTAREA_MAX_HEIGHT}
          aria-valuenow={textareaHeight}
        />
      )}
      <div className="chat-input-wrap">
        <ChatSendQueue
          items={activeQueue}
          paused={isQueuePaused}
          isGenerating={isGenerating}
          onSendNow={handleQueueSendNow}
          onEdit={handleQueueEdit}
          onRemove={handleQueueRemove}
          onMove={handleQueueMove}
        />
        <div className="chat-input-box">
          {(isVoiceActive && (voice.isRecording || voice.isTranscribing)) && (
            <div className="chat-voice-overlay" role="status" aria-live="polite">
              {voice.isTranscribing ? (
                <>
                  <span className="chat-tool-btn-spinner" />
                  <span className="chat-voice-hint">转换中…</span>
                </>
              ) : (
                <>
                  <span className="chat-voice-dot" />
                  <span className="chat-voice-duration">{formatDuration(voice.durationMs)}</span>
                  <span className="chat-voice-hint">松开识别，移出取消</span>
                </>
              )}
            </div>
          )}
          {(isVoiceActive && voiceError) && (
            <div className="chat-voice-error" role="alert">{voiceError}</div>
          )}
          {pendingFiles.length > 0 && (
            <div className="chat-file-preview" aria-label="待发送附件" onWheel={(e) => { e.preventDefault(); e.currentTarget.scrollLeft += e.deltaY }}>
              {pendingFiles.map((f, i) => (
                <FileChip
                  key={f.upload?.clientId ?? `${f.rel_path}:${i}`}
                  file={f}
                  uploadStatus={f.upload?.status}
                  uploadError={f.upload?.error}
                  onRetry={f.upload?.status === 'failed'
                    ? () => handleUploadFile(f, f.upload!.clientId)
                    : undefined}
                  onRemove={() => handleRemoveFile(f, i)}
                  disabled={isSubmitting}
                />
              ))}
            </div>
          )}
          {isMentionMode ? (
            <MentionInput
              ref={mentionInputRef}
              members={members!}
              placeholder={placeholder}
              disabled={isInteractionDisabled}
              className="chat-textarea"
              style={{ height: textareaHeight }}
              autoFocus={autoFocus}
              onEnter={handleSend}
              onChange={(text, mentions) => {
                mentionTextRef.current = { text, mentions }
                setMentionText(text)
                const scrollH = mentionInputRef.current?.getScrollHeight() ?? CHAT_TEXTAREA_MIN_HEIGHT
                setTextareaHeight(Math.max(CHAT_TEXTAREA_MIN_HEIGHT, Math.min(CHAT_TEXTAREA_MAX_HEIGHT, scrollH)))
              }}
            />
          ) : (
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onCompositionStart={() => { isComposingRef.current = true }}
              onCompositionEnd={() => { isComposingRef.current = false }}
              onKeyDown={(e) => {
                if (isImeKeyboardEvent(e.nativeEvent, isComposingRef.current)) return
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
              placeholder={placeholder}
              style={{ height: textareaHeight }}
              className="chat-textarea"
              disabled={isInteractionDisabled}
              autoFocus={autoFocus}
              autoCorrect="off"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-label={placeholder}
            />
          )}
          <div className="chat-input-actions">
            <div className="chat-input-tools">
              <button type="button" onClick={handlePickFile} disabled={isPickingFile || isInteractionDisabled} title={isHero ? '添加上下文' : '发送文件'} aria-label={isPickingFile ? '正在选择文件' : isHero ? '添加上下文文件' : '添加消息附件'} className="chat-tool-btn">
                {isPickingFile ? <span className="chat-tool-btn-spinner" aria-hidden="true" /> : isHero ? <Plus size={17} strokeWidth={1.8} aria-hidden="true" /> : <Paperclip size={15} strokeWidth={1.8} aria-hidden="true" />}
              </button>
              {enableKnowledgeFiles && <button type="button" className="chat-tool-btn" title="从知识库选择文件" aria-label="从知识库选择文件" disabled={isInteractionDisabled} onClick={() => setKnowledgeOpen(true)}><BookOpen size={16} /></button>}
              {tools}
              {isHero && (
                <div className="chat-role-picker" ref={roleRef} onKeyDown={handleRolePickerKeyDown}>
                  <button ref={roleTriggerRef} type="button" className={`chat-approval-btn${selectedRoles.length > 0 ? ' selected' : ''}`} disabled={isInteractionDisabled || pendingFiles.length > 0} onClick={() => setRoleOpen(o => !o)} aria-haspopup="menu" aria-expanded={roleOpen} aria-controls={roleOpen ? roleMenuId : undefined}>
                    人才角色{selectedRoles.length > 0 && <span className="chat-role-count">{selectedRoles.length}</span>}
                    <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                  {roleOpen && (
                    <div className="chat-role-dropdown" id={roleMenuId} role="menu" aria-label="选择人才角色">
                      {employees.map(emp => (
                        <button key={emp.employeeId} type="button"
                          role="menuitemcheckbox"
                          aria-checked={selectedRoles.includes(emp.employeeId)}
                          className={`chat-role-option${selectedRoles.includes(emp.employeeId) ? ' active' : ''}`}
                          onClick={() => setSelectedRoles(prev => prev.includes(emp.employeeId) ? prev.filter(r => r !== emp.employeeId) : [...prev, emp.employeeId])}>
                          {emp.displayName}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="chat-input-right">
              {isVoiceActive && (
                <button
                  type="button"
                  className={`chat-voice-btn${voice.isRecording ? ' recording' : ''}`}
                  title={voice.isRecording ? '松开识别，移出取消' : '按住说话'}
                  aria-label={voice.isRecording ? '正在录音，松开完成识别' : '按住说话'}
                  aria-pressed={voice.isRecording}
                  disabled={isInteractionDisabled || voice.isTranscribing}
                  onPointerDown={handleVoicePointerDown}
                  onPointerUp={handleVoicePressEnd}
                  onPointerEnter={() => { voicePointerInsideRef.current = true }}
                  onPointerLeave={() => { voicePointerInsideRef.current = false }}
                  onPointerCancel={handleVoicePressCancel}
                  onKeyDown={handleVoiceKeyDown}
                  onKeyUp={handleVoiceKeyUp}
                >
                  <Mic size={16} strokeWidth={2} aria-hidden="true" />
                </button>
              )}
              {isGenerating && onAbort && canQueue && hasComposerContent && (
                <button type="button" onClick={handleSend} disabled={isSendDisabled} className="chat-send-btn chat-queue-btn" title="加入待发送队列" aria-label="加入待发送队列，当前回复结束后发送">
                  <ArrowUp size={16} strokeWidth={2.1} aria-hidden="true" />
                </button>
              )}
              {isGenerating && onAbort ? (
                <button
                  type="button"
                  onClick={onAbort}
                  className="chat-send-btn chat-stop-btn"
                  title="停止生成"
                  aria-label="停止生成"
                >
                  <Square size={12} strokeWidth={2.4} fill="currentColor" aria-hidden="true" />
                </button>
              ) : (
                <button type="button" onClick={handleSend} disabled={isSendDisabled} className="chat-send-btn" aria-label="发送消息">
                  <ArrowUp size={16} strokeWidth={2.1} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        </div>
        {isHero && (
          <div className={`chat-input-context-strip${selectedRoles.length > 0 ? ' visible' : ''}`}>
            <div className="chat-role-chips">
              {selectedRoles.map(id => {
                const name = employees.find(e => e.employeeId === id)?.displayName ?? id
                return (
                  <span key={id} className="chat-role-chip">
                    {name}
                    <button type="button" onClick={() => setSelectedRoles(prev => prev.filter(r => r !== id))} aria-label={`移除人才角色 ${name}`}>
                      <X size={9} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                  </span>
                )
              })}
            </div>
          </div>
        )}
        {fileError && <p className="chat-input-error" role="alert">{fileError}</p>}
        {knowledgeOpen && <KnowledgeFilePicker key={convId} convId={convId} onClose={() => setKnowledgeOpen(false)} onSelect={file => { if (onUploadFile) handleUploadFile(file); else setPendingFiles(previous => [...previous, file]) }} />}
        {helper}
      </div>
    </div>
  )
})
