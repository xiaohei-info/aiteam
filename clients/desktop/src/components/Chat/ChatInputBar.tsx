import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, useId, memo, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { ArrowUp, BookOpen, ChevronDown, Mic, Paperclip, Plus, Square, X } from 'lucide-react'
import { useMergeRefs } from '@floating-ui/react'
import type { CachedFile } from '../../lib/fileCache'
import {
  attachmentErrorMessage,
  beginAttachmentUpload,
  completeAttachmentUpload,
  failAttachmentUpload,
  hasBlockingAttachmentUpload,
  importErrorMessage,
  isImportingAttachment,
  planAttachmentImports,
  queueAttachmentUpload,
  isReferencedByPath,
  referenceAttachmentByPath,
  removeAttachmentUpload,
  runWhenAttachmentsReady,
  type UploadableChatFile,
} from '../../lib/chatAttachmentUpload'
import { composerRestoreTarget } from '../../lib/chatComposerRestore'
import { mergeDraftFiles } from '../../lib/chatDraftFiles'
import type { WorkbenchEmployee } from '../../lib/employeeConversationMap'
import type { GroupMember } from '../../stores/chat'
// Phase 3:语音转写从旧 /api/team/stt 切到新栈 /api/agent/audio/transcriptions。
// 服务端契约:{ filename, mime_type, data (base64) } → { text, duration? }。
// 单文件 ≤5 MiB;Manager 不可达 → 503,由调用方兜底。
import { backendApi } from '../../api/backend'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'
import { useVoiceInput, type VoiceRecording } from '../../hooks/useVoiceInput'
import { PopoverPortal, PopoverTabOrder } from '../Popover/PopoverLayer'
import { useAnchoredPopover } from '../Popover/useAnchoredPopover'
import MentionInput, { type MentionInputSnapshot } from './MentionInput'
import { useComposerValue } from './useComposerValue'
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
import { registerFileDropZone } from '../../lib/nativeFileDrop'

/** One file to add: what to show straight away, how to copy it in, and what to say if that fails. */
interface ImportRequest {
  meta: { name: string; mime: string; size: number }
  load: () => Promise<CachedFile | null>
  failure: (error: unknown) => string
}

const CHAT_TEXTAREA_MIN_HEIGHT = 60
const CHAT_TEXTAREA_MAX_HEIGHT = 240

export interface ChatInputBarProps {
  onSend: (text: string, files: UploadableChatFile[], employeeId?: string, mentions?: string[]) => boolean | Promise<boolean>
  /** Opens the file picker and returns the chosen path; the file is then imported like a dropped one. */
  onPickFile: () => Promise<string | null>
  /** Caches pasted content that has no file on disk (screenshot, RTF picture) so it can be referenced by path. */
  onImportFile?: (file: File) => Promise<CachedFile | null>
  /** Caches a file dragged in from Finder/Explorer by its path, like「+ 导入」(no size limit). */
  onImportPath?: (path: string) => Promise<CachedFile | null>
  onUploadFile?: (file: CachedFile, employeeId?: string) => Promise<string>
  onDeleteUploadedFile?: (attachmentId: string) => Promise<unknown>
  disabled?: boolean
  convId: string
  conversationUpgradeFrom?: string
  draft?: string
  draftFiles?: CachedFile[]
  /** 草稿里的 @ 成员标签（输入框自己克隆的节点）；有快照就原样放回，没有才退回纯文本。 */
  draftMentions?: MentionInputSnapshot
  /** Saves the typed text of a conversation without touching its attachments. */
  onDraftTextChange: (convId: string, text: string, mentionSnapshot?: MentionInputSnapshot) => void
  /**
   * Changes the attachments of one conversation — the only copy of that state, shown by this input
   * box while that conversation is on screen. Imports and uploads that finish later (or while the
   * input box is closed) update the conversation they were added to through here, so nothing is
   * lost and nothing is shadowed by a stale copy. Returns the attachments after the change.
   */
  onDraftFilesChange: (convId: string, update: (files: UploadableChatFile[]) => UploadableChatFile[]) => UploadableChatFile[]
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
  onSend, onPickFile, onImportFile, onImportPath, onUploadFile, onDeleteUploadedFile,
  disabled, convId, conversationUpgradeFrom, draft, draftFiles, draftMentions,
  onDraftTextChange, onDraftFilesChange,
  variant = 'dock', placeholder = '输入消息…', autoFocus, helper, tools,
  employees = [], members, isGenerating, isSyncing, onAbort, onHeightChange, enableVoiceInput, enableKnowledgeFiles,
}: ChatInputBarProps) => {
  const [knowledgeOpen, setKnowledgeOpen] = useState(false)
  const [fileError, setFileError] = useState('')
  const [isPickingFile, setIsPickingFile] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [textareaHeight, setTextareaHeight] = useState(CHAT_TEXTAREA_MIN_HEIGHT)
  const [selectedRoles, setSelectedRoles] = useState<string[]>([])
  const [roleOpen, setRoleOpen] = useState(false)
  // 单聊与群聊共用同一个 MentionInput：单聊不传成员，@ 菜单不出现，其余输入行为完全一致。
  const composer = useComposerValue(draft ?? '')
  const mentionMembers = members ?? []
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  const roleRef = useRef<HTMLDivElement>(null)
  const roleTriggerRef = useRef<HTMLButtonElement>(null)
  const roleMenuRef = useRef<HTMLDivElement>(null)
  const roleMenuId = useId()
  // 角色菜单渲染到 body（见 useAnchoredPopover）：默认在按钮下方，放不下时翻到上方。
  const rolePopover = useAnchoredPopover({ open: roleOpen, placement: 'bottom-start', fallbackPlacements: ['top-start'], offset: 6, fit: { maxHeight: 240 } })
  const roleTriggerRefs = useMergeRefs([roleTriggerRef, rolePopover.refs.setReference])
  const roleMenuRefs = useMergeRefs([roleMenuRef, rolePopover.refs.setFloating])
  // 附件按会话只存一份：这里显示的就是该会话草稿里的附件，没有第二份本地副本，
  // 所以离开聊天页再回来时跟的是最新状态，不会停在旧的「正在导入」。
  // useMemo keeps the identity stable while the draft is unchanged, so the「等待上传」effect below
  // does not re-run on every render.
  const pendingFiles = useMemo(() => (draftFiles ?? []) as UploadableChatFile[], [draftFiles])
  const filesRef = useRef(pendingFiles)
  filesRef.current = pendingFiles
  const cancelledUploadIdsRef = useRef(new Set<string>())
  // Which conversation each importing/uploading attachment belongs to, pinned when it is added.
  // Imports and uploads keep running when the user switches away; the result goes back to that
  // conversation only.
  const fileOwnersRef = useRef(new Map<string, string>())
  const prevConvRef = useRef(convId)
  const conversationUpgradeFromRef = useRef(conversationUpgradeFrom)
  conversationUpgradeFromRef.current = conversationUpgradeFrom
  // 正在发送的会话；emp_ 升级为真实会话时跟着更新，用于判断失败时把内容放回哪里。
  const submittingConvRef = useRef<string | null>(null)
  const mountedRef = useRef(false)
  const adoptedDraftRef = useRef({ convId, draft, draftFiles, draftMentions })
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

  /** Changes one conversation's attachments; defaults to the conversation on screen. */
  const setFiles = useCallback((
    update: (previous: UploadableChatFile[]) => UploadableChatFile[],
    conversationId?: string,
  ): UploadableChatFile[] => {
    const target = conversationId ?? prevConvRef.current
    const next = onDraftFilesChange(target, update)
    // The store is the single copy, but this render's props are a frame behind: keep the ref that
    // sending and ownership checks read in step with what was just written.
    if (target === prevConvRef.current) filesRef.current = next
    return next
  }, [onDraftFilesChange])

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
      setKnowledgeOpen(false)
      setFileError('')
      // 只存文字：附件已经在各自会话的草稿里（正在导入/上传的也留在原会话，完成后回到那里）。
      // 带上 @ 成员快照：只存纯文本的话切回来「@某人」只剩文字，发送时不再提及对方。
      onDraftTextChange(previousConvId, composer.valueRef.current.text, composer.snapshot())
    }
    if (isConversationUpgrade && submittingConvRef.current === previousConvId) submittingConvRef.current = convId
    if (isConversationUpgrade) {
      for (const [clientId, owner] of fileOwnersRef.current) {
        if (owner === previousConvId) fileOwnersRef.current.set(clientId, convId)
      }
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
    if (!isConversationUpgrade) composer.restore(nextDraft ? draftMentions : undefined, nextDraft)
  }, [convId]) // eslint-disable-line react-hooks/exhaustive-deps

  // 新会话页发送后已切到会话、输入框换了一个；发送失败时页面把内容写回该会话草稿，
  // 这里在输入框为空时采用它。切换会话的草稿由上面的 effect 处理。
  useLayoutEffect(() => {
    const previous = adoptedDraftRef.current
    adoptedDraftRef.current = { convId, draft, draftFiles, draftMentions }
    if (previous.convId !== convId) return
    if (previous.draft === draft && previous.draftFiles === draftFiles) return
    if ((!draft && !draftFiles?.length) || isSubmitting) return
    // Attachments come from the draft on their own now, so only the typed text is adopted — and only
    // when the user has not started typing something else.
    if (composer.valueRef.current.text.trim()) return
    composer.restore(draftMentions, draft ?? '')
  }, [convId, draft, draftFiles]) // eslint-disable-line react-hooks/exhaustive-deps

  // 高度随内容自适应（输入、粘贴、草稿恢复、清空都会改 composer.text）。
  const { getScrollHeight } = composer
  useLayoutEffect(() => {
    const scrollHeight = getScrollHeight() ?? CHAT_TEXTAREA_MIN_HEIGHT
    setTextareaHeight(Math.max(CHAT_TEXTAREA_MIN_HEIGHT, Math.min(CHAT_TEXTAREA_MAX_HEIGHT, scrollHeight)))
  }, [composer.text, getScrollHeight])

  useEffect(() => {
    if (!roleOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (roleRef.current?.contains(target) || roleMenuRef.current?.contains(target)) return
      setRoleOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [roleOpen])

  useEffect(() => {
    if (!roleOpen) return
    const frame = window.requestAnimationFrame(() => {
      const options = roleMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')
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
    // 菜单渲染在 body 里，不在 picker 的 DOM 子树内；键盘事件仍沿 React 树冒泡到这里。
    const options = Array.from(roleMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]:not(:disabled)') ?? [])
    if (options.length === 0) return
    e.preventDefault()
    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Home') options[0].focus()
    else if (e.key === 'End') options[options.length - 1].focus()
    else if (e.key === 'ArrowDown') options[(currentIndex + 1 + options.length) % options.length].focus()
    else options[(currentIndex - 1 + options.length) % options.length].focus()
  }

  /**
   * Puts the new state of one attachment into the conversation it was added to — the same place the
   * input box reads, whether or not that conversation is on screen. Returns false when that
   * conversation no longer holds the attachment (removed, sent or cleared).
   */
  const placeFile = useCallback((clientId: string, next: UploadableChatFile | null): boolean => {
    const owner = fileOwnersRef.current.get(clientId) ?? prevConvRef.current
    if (next?.upload?.status !== 'importing' && next?.upload?.status !== 'uploading') fileOwnersRef.current.delete(clientId)
    let held = false
    setFiles((previous) => {
      held = previous.some((item) => item.upload?.clientId === clientId)
      if (!held) return previous
      return previous.flatMap((item) => item.upload?.clientId !== clientId ? [item] : next ? [next] : [])
    }, owner)
    return held
  }, [setFiles])

  const handleUploadFile = useCallback((file: CachedFile, clientId: string = crypto.randomUUID()) => {
    if (isReferencedByPath(file)) {
      // Attached by path: ready at once, nothing to upload (the Agent reads it when needed).
      const ready = referenceAttachmentByPath(file, clientId)
      const owner = fileOwnersRef.current.get(clientId) ?? prevConvRef.current
      fileOwnersRef.current.delete(clientId)
      setFiles((previous) => {
        const index = previous.findIndex((item) => item.upload?.clientId === clientId)
        if (index < 0) return [...previous, ready]
        return previous.map((item, itemIndex) => itemIndex === index ? ready : item)
      }, owner)
      return
    }
    if (!onUploadFile) return
    const { upload: _previousUpload, ...plainFile } = file as UploadableChatFile
    const uploadingFile = beginAttachmentUpload(plainFile, clientId)
    if (!fileOwnersRef.current.has(clientId)) fileOwnersRef.current.set(clientId, prevConvRef.current)
    const owner = fileOwnersRef.current.get(clientId)
    setFiles((previous) => {
      const index = previous.findIndex((item) => item.upload?.clientId === clientId)
      if (index < 0) return [...previous, uploadingFile]
      return previous.map((item, itemIndex) => itemIndex === index ? uploadingFile : item)
    }, owner)

    const deleteRemote = async (attachmentId: string) => {
      if (!onDeleteUploadedFile) return
      try {
        await onDeleteUploadedFile(attachmentId)
      } catch (error) {
        console.error('[ChatInputBar] cleanup cancelled attachment failed:', error)
      }
    }
    onUploadFile(plainFile, selectedRoles[0] ?? employees[0]?.employeeId)
      .then(async (attachmentId) => {
        if (!attachmentId) throw new Error('附件服务未返回文件 ID')
        if (cancelledUploadIdsRef.current.delete(clientId)) {
          fileOwnersRef.current.delete(clientId)
          await deleteRemote(attachmentId)
          return
        }
        if (!placeFile(clientId, completeAttachmentUpload(uploadingFile, attachmentId))) await deleteRemote(attachmentId)
      })
      .catch((error: unknown) => {
        if (cancelledUploadIdsRef.current.delete(clientId)) {
          fileOwnersRef.current.delete(clientId)
          return
        }
        placeFile(clientId, failAttachmentUpload(uploadingFile, attachmentErrorMessage(error)))
      })
  }, [employees, onDeleteUploadedFile, onUploadFile, placeFile, selectedRoles, setFiles])

  // Imports that finished while their conversation was in the background wait as「等待上传」;
  // upload them as soon as that conversation is back on screen.
  useEffect(() => {
    if (!onUploadFile) return
    for (const file of pendingFiles) {
      if (file.upload?.status === 'queued') handleUploadFile(file, file.upload.clientId)
    }
  }, [handleUploadFile, onUploadFile, pendingFiles])

  /** Copies one already-announced file into the conversation it was added to. */
  const runImport = useCallback((item: ImportRequest, clientId: string, placeholder: UploadableChatFile) => {
    const { load, failure } = item
    return load()
      .then((cached) => {
        if (cancelledUploadIdsRef.current.delete(clientId)) {
          fileOwnersRef.current.delete(clientId)
          return
        }
        if (!cached) {
          placeFile(clientId, null)
          return
        }
        if (isReferencedByPath(cached)) {
          placeFile(clientId, referenceAttachmentByPath(cached, clientId))
          return
        }
        const owner = fileOwnersRef.current.get(clientId)
        const onScreen = mountedRef.current && owner === prevConvRef.current
        if (!onUploadFile) {
          placeFile(clientId, cached)
          return
        }
        if (onScreen) handleUploadFile(cached, clientId)
        else placeFile(clientId, queueAttachmentUpload(cached, clientId))
      })
      .catch((error: unknown) => {
        console.error('[ChatInputBar] import file failed:', error)
        if (cancelledUploadIdsRef.current.delete(clientId)) {
          fileOwnersRef.current.delete(clientId)
          return
        }
        const owner = fileOwnersRef.current.get(clientId)
        if (mountedRef.current && owner === prevConvRef.current) {
          placeFile(clientId, null)
          setFileError(failure(error))
        } else {
          // The user is elsewhere: keep a failed chip in that draft so the loss is visible on return.
          placeFile(clientId, { ...placeholder, upload: { clientId, status: 'failed', error: failure(error) } })
        }
      })
  }, [handleUploadFile, onUploadFile, placeFile])

  /**
   * Adds files: every file gets its「正在导入」chip and is pinned to the conversation it was added
   * to *before* the first copy starts, so sending waits for all of them and switching conversations
   * mid-import cannot move the ones still to come to whatever conversation is on screen by then.
   * The copies then run one after another, each landing in the conversation it was added to.
   */
  const startImports = useCallback((items: readonly ImportRequest[]) => {
    if (items.length === 0) return
    const owner = prevConvRef.current
    const planned = planAttachmentImports(items.map((item) => item.meta))
    for (const { clientId } of planned) fileOwnersRef.current.set(clientId, owner)
    flushSync(() => setFiles((previous) => [...previous, ...planned.map((entry) => entry.placeholder)], owner))
    void (async () => {
      for (const [index, { clientId, placeholder }] of planned.entries()) {
        await runImport(items[index], clientId, placeholder)
      }
    })()
  }, [runImport, setFiles])

  const handlePickFile = async () => {
    if (isPickingFile || isSubmitting) return
    setFileError('')
    setIsPickingFile(true)
    let path: string | null = null
    try {
      path = await onPickFile()
    } catch {
      setFileError('选择文件失败，请重试')
    } finally {
      setIsPickingFile(false)
    }
    // Same route as a dropped file: 「正在导入」 chip at once, result stays with this conversation.
    if (path) importPathsRef.current([path])
  }

  /** Pasted content without a file on disk (screenshot, RTF picture). Files on disk go through importPathsRef. */
  const handleImportFiles = useCallback((files: File[]) => {
    if (!onImportFile || files.length === 0) return
    setFileError('')
    startImports(files.map((file) => {
      const name = file.name || '剪贴板图片'
      return {
        meta: { name, mime: file.type || 'application/octet-stream', size: file.size },
        load: () => onImportFile(file),
        failure: (error: unknown) => importErrorMessage(name, error),
      }
    }))
  }, [onImportFile, startImports])

  const handleRemoveFile = useCallback((file: UploadableChatFile, index: number) => {
    setFiles((previous) => file.upload
      ? removeAttachmentUpload(previous, file.upload.clientId)
      : previous.filter((_, itemIndex) => itemIndex !== index))
    if (!file.upload) return
    if (file.upload.status === 'uploading' || file.upload.status === 'importing') {
      cancelledUploadIdsRef.current.add(file.upload.clientId)
      return
    }
    if (file.upload.status === 'uploaded' && file.upload.attachmentId && onDeleteUploadedFile) {
      void onDeleteUploadedFile(file.upload.attachmentId).catch((error: unknown) => {
        console.error('[ChatInputBar] delete uploaded attachment failed:', error)
      })
    }
  }, [onDeleteUploadedFile, setFiles])

  const clearComposer = () => {
    composer.clear()
    setFiles(() => [])
  }

  /** 读取输入框当前内容；没有文字也没有附件时返回 null。 */
  const readComposer = (files: UploadableChatFile[]): QueuedChatMessage<MentionInputSnapshot> | null => {
    const { text, mentions } = composer.valueRef.current
    if (!text.trim() && files.length === 0) return null
    return {
      id: crypto.randomUUID(),
      text: text.trim(),
      files,
      mentions,
      mentionSnapshot: composer.snapshot(),
      // 单聊按所选/默认员工路由；群聊没有 employees，由 mentions 决定。
      employeeId: selectedRoles[0] ?? employees[0]?.employeeId,
    }
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
        onDraftTextChange(queueConvId, '')
        setQueues((previous) => enqueueMessage(previous, queueConvId, composed))
        resumeQueue(queueConvId)
        return
      }
      const { text, mentions, employeeId, mentionSnapshot } = composed

      // 点击发送立即清空输入框和附件，失败时再放回。
      const rawText = composer.valueRef.current.text
      submittingConvRef.current = prevConvRef.current
      flushSync(() => {
        setIsSubmitting(true)
        clearComposer()
      })
      // 只清文字：附件由 clearComposer 当帧清掉，请求期间新加的不归这次发送。
      onDraftTextChange(prevConvRef.current, '')

      let sent = false
      try {
        sent = await onSend(text, files, employeeId, mentions)
      } catch (error) {
        // 页面层负责展示具体提交错误。
        console.error('[ChatInputBar] send failed:', error)
      }
      const submittedConversationId = submittingConvRef.current ?? ''
      submittingConvRef.current = null
      const target = sent ? { kind: 'none' as const } : composerRestoreTarget({
        mounted: mountedRef.current,
        // 请求期间允许用户从侧栏切换会话；失败的内容回到原会话，不覆盖当前会话。
        sameConversation: prevConvRef.current === submittedConversationId,
        composerTextEmpty: !composer.valueRef.current.text.trim(),
        submittedConversationId,
      })
      flushSync(() => {
        setIsSubmitting(false)
        // 发送期间新加的附件不能被放回的覆盖。
        if (target.kind === 'composer') setFiles((current) => mergeDraftFiles(files, current))
      })
      // 带上 @ 成员快照：重发时仍提及原来的成员，不会落到群聊默认的协调员。
      if (target.kind === 'draft') {
        onDraftTextChange(target.conversationId, rawText, mentionSnapshot)
        onDraftFilesChange(target.conversationId, (current) => mergeDraftFiles(files, current))
      }
      // 原样放回（含 @ 成员 chip）；焦点没被用户移走时 restore 会聚焦到末尾。
      if (target.kind === 'composer') composer.restore(mentionSnapshot, rawText)
    })
  }

  const isHero = variant === 'hero'
  const hasBlockingUpload = isImportingAttachment(pendingFiles)
    || (!!onUploadFile && hasBlockingAttachmentUpload(pendingFiles))
  const hasComposerContent = !!composer.text.trim() || pendingFiles.length > 0
  // 可排队时提交中也允许继续输入，新消息进入队列。
  const isSubmitBlocking = isSubmitting && !canQueue
  const isSendDisabled = !hasComposerContent
    || hasBlockingUpload
    || !!disabled
    || isSubmitBlocking
  const isInteractionDisabled = !!disabled || isSubmitBlocking
  // 从访达/资源管理器拖进来的文件：Tauri 原生拖放给出路径，落在整条输入栏（附件区、工具栏、输入框）上都算拖入对话。
  // 文字拖入由原生拖放吞掉，不会进输入框；文字请粘贴。
  const barRef = useRef<HTMLDivElement>(null)
  const [isFileOver, setIsFileOver] = useState(false)
  const canDropFiles = Boolean(onImportPath) && !isInteractionDisabled
  const importPathsRef = useRef<(paths: string[]) => void>(() => {})
  // 同一个文件再拖入 / 再选一次不重复添加：已在附件区或正在添加的路径跳过。
  const importingPathsRef = useRef(new Set<string>())
  importPathsRef.current = (paths: string[]) => {
    if (!onImportPath) return
    setFileError('')
    // 访达给的路径常是分解形式（NFD），输入框里已有的可能是组合形式：按归一化后的路径去重，导入仍用原路径。
    const key = (path: string) => path.normalize('NFC')
    const seen = new Set([
      ...importingPathsRef.current,
      ...filesRef.current.map((file) => (file.path ? key(file.path) : '')),
    ])
    const fresh = [...new Map(paths.map((path) => [key(path), path])).values()]
      .filter((path) => !seen.has(key(path)))
    fresh.forEach((path) => importingPathsRef.current.add(key(path)))
    startImports(fresh.map((path) => {
      const name = path.split(/[\\/]/).filter(Boolean).pop() || path
      return {
        meta: { name, mime: 'application/octet-stream', size: 0 },
        load: () => onImportPath(path).finally(() => importingPathsRef.current.delete(key(path))),
        failure: (error: unknown) => importErrorMessage(name, error),
      }
    }))
  }
  // 访达/资源管理器复制的文件粘贴进来：和拖入同一条路，按路径导入。
  const handlePastePaths = useCallback((paths: string[]) => importPathsRef.current(paths), [])
  useEffect(() => {
    if (!canDropFiles) return
    const unregister = registerFileDropZone({
      element: () => barRef.current,
      onHover: setIsFileOver,
      onDrop: (paths) => importPathsRef.current(paths),
    })
    return () => {
      unregister()
      setIsFileOver(false)
    }
  }, [canDropFiles])


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
    flushSync(() => setFiles(() => target.files))
    composer.restore(target.mentionSnapshot, target.text)
    composer.focus()
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

  insertTranscriptRef.current = composer.insertText

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
    <div
      ref={barRef}
      className={`chat-input-bar${isHero ? ' chat-input-bar-hero' : ''}${disabled ? ' chat-input-bar-disabled' : ''}${isFileOver ? ' chat-input-bar-file-over' : ''}`}
    >
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
                  onRetry={f.upload?.status === 'failed' && f.rel_path
                    ? () => handleUploadFile(f, f.upload!.clientId)
                    : undefined}
                  onRemove={() => handleRemoveFile(f, i)}
                  disabled={isSubmitting}
                />
              ))}
            </div>
          )}
          <MentionInput
            ref={composer.inputRef}
            members={mentionMembers}
            placeholder={placeholder}
            disabled={isInteractionDisabled}
            className="chat-textarea"
            style={{ height: textareaHeight }}
            autoFocus={autoFocus}
            onEnter={handleSend}
            onChange={composer.handleChange}
            onFiles={onImportFile && !isInteractionDisabled ? handleImportFiles : undefined}
            onPaths={canDropFiles ? handlePastePaths : undefined}
          />
          <div className="chat-input-actions">
            <div className="chat-input-tools">
              <button type="button" onClick={handlePickFile} disabled={isPickingFile || isInteractionDisabled} title={isHero ? '添加上下文' : '发送文件'} aria-label={isPickingFile ? '正在选择文件' : isHero ? '添加上下文文件' : '添加消息附件'} className="chat-tool-btn">
                {isPickingFile ? <span className="chat-tool-btn-spinner" aria-hidden="true" /> : isHero ? <Plus size={17} strokeWidth={1.8} aria-hidden="true" /> : <Paperclip size={15} strokeWidth={1.8} aria-hidden="true" />}
              </button>
              {enableKnowledgeFiles && <button type="button" className="chat-tool-btn" title="从知识库选择文件" aria-label="从知识库选择文件" disabled={isInteractionDisabled} onClick={() => setKnowledgeOpen(true)}><BookOpen size={16} /></button>}
              {tools}
              {isHero && (
                <div className="chat-role-picker" ref={roleRef} onKeyDown={handleRolePickerKeyDown}>
                  <button ref={roleTriggerRefs} type="button" className={`chat-approval-btn${selectedRoles.length > 0 ? ' selected' : ''}`} disabled={isInteractionDisabled || pendingFiles.length > 0} onClick={() => setRoleOpen(o => !o)} aria-haspopup="menu" aria-expanded={roleOpen} aria-controls={roleOpen ? roleMenuId : undefined}>
                    人才角色{selectedRoles.length > 0 && <span className="chat-role-count">{selectedRoles.length}</span>}
                    <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                  {roleOpen && <PopoverPortal><PopoverTabOrder context={rolePopover.context}>
                    <div ref={roleMenuRefs} className="chat-role-dropdown" id={roleMenuId} role="menu" aria-label="选择人才角色" style={rolePopover.floatingStyles}>
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
                  </PopoverTabOrder></PopoverPortal>}
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
        {knowledgeOpen && <KnowledgeFilePicker key={convId} convId={convId} onClose={() => setKnowledgeOpen(false)} onSelect={file => { if (onUploadFile) handleUploadFile(file); else setFiles(previous => [...previous, file]) }} />}
        {helper}
      </div>
    </div>
  )
})
