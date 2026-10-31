/**
 * 知识库详情页，展示指定知识库的文档、绑定员工和上传入口。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, FormEvent, KeyboardEvent, MouseEvent, WheelEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import { Link, useParams } from 'react-router-dom'
import remarkGfm from 'remark-gfm'
import {
  Activity,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Link2,
  RefreshCw,
  RotateCcw,
  Search,
  TriangleAlert,
  UploadCloud,
  Users,
  X,
} from 'lucide-react'
import './KnowledgeBase.css'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'
import { KNOWLEDGE_FULL_TEXT_SEARCH_AVAILABILITY } from '../../lib/knowledgeSearchAvailability'
import RequestErrorState from '../../components/RequestState/RequestErrorState'
import { classifyRequestError, type RequestErrorInfo } from '../../lib/requestError'
import {
  fetchKnowledgeBases,
  fetchKnowledgeEmployees,
  fetchKnowledgeFilePreview,
  getKnowledgeFilePreviewUrl,
  getKnowledgeFilePreviewUrlResult,
  findKnowledgeFileLocalPath,
  openLocalKnowledgeFile,
  previewLocalKnowledgeFile,
  retryKnowledgeDocument,
  selectKnowledgeUploadFiles,
  updateEmployeeKnowledgeBases,
  uploadKnowledgeFile,
} from './api'
import type { KnowledgeUploadSelection } from './api'
import KbDocumentGridCard from './KbDocumentGridCard'
import KbViewToggle, { type KbViewMode } from './KbViewToggle'
import type { KbFile, KnowledgeBase, KnowledgeDocumentPreview, KnowledgeEmployee } from './types'
import {
  formatPreviewSize,
  getErrorMessage,
  getErrorTooltipText,
  getFeedbackDismissDelay,
  getUploadPreviewKey,
  getUploadPreviewType,
  isKnowledgeUploadCandidate,
  isPreviewImage,
  normalizeStatusClass,
  normalizeWheelDeltaY,
} from './utils'
import type { Feedback, UploadPreview } from './utils'
import { readKnowledgeSourceConfig } from './knowledgeSourceConfig'
import { REMOVED_DEVICE_KNOWLEDGE_REASON, knowledgeBaseSourceLabel, knowledgeScopeLabel, uploadKnowledgeBatch } from './knowledgeService'
import { KNOWLEDGE_DOCUMENT_ACTIONS_UNAVAILABLE_REASON } from './documentActionAvailability'
import { personalLevelWarning } from './knowledgeSourceGroups'
import {
  readKnowledgeDocumentViewMode,
  writeKnowledgeDocumentViewMode,
} from './viewModePreference'

interface KnowledgeUploadFile {
  file: File
  localPath?: string
}

interface StatusTooltip {
  text: string
  left: number
  top: number
  placement: 'top' | 'bottom'
}

type KnowledgeActionModal = 'bind'

const DOCUMENT_PAGE_SIZE = 10

export default function KnowledgeBaseDetail() {
  const { id } = useParams<{ id: string }>()
  if (id?.startsWith('device:')) {
    return <div className="kb-page"><main className="kb-main">
      <h1>本机副本知识库已移除</h1>
      <p role="status">{REMOVED_DEVICE_KNOWLEDGE_REASON}</p>
      <p>此次更新不会删除此前导入的副本、索引或聊天记录，也不会上传到 NAS 或 Manager。</p>
      <Link to="/knowledge">返回知识库</Link>
      <Link to="/knowledge/local-documents">查看本地文档</Link>
    </main></div>
  }
  return <RemoteKnowledgeBaseDetail />
}

function RemoteKnowledgeBaseDetail() {
  const { id } = useParams<{ id: string }>()
  const [list, setList] = useState<KnowledgeBase[]>([])
  const [employees, setEmployees] = useState<KnowledgeEmployee[]>([])
  const [bindEmployeeId, setBindEmployeeId] = useState('')
  const [uploadFiles, setUploadFiles] = useState<KnowledgeUploadFile[]>([])
  const [uploadPreviews, setUploadPreviews] = useState<UploadPreview[]>([])
  const [documentSearchText, setDocumentSearchText] = useState('')
  const [documentPage, setDocumentPage] = useState(1)
  const [documentViewMode, setDocumentViewMode] = useState<KbViewMode>(() => {
    if (typeof window === 'undefined') return 'list'
    try {
      return readKnowledgeDocumentViewMode(window.localStorage)
    } catch {
      return 'list'
    }
  })
  const [isDragging, setIsDragging] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isUploading, setIsUploading] = useState(false)
  const [isCurrentFileUploaded, setIsCurrentFileUploaded] = useState(false)
  const [isBinding, setIsBinding] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isRetryingId, setIsRetryingId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<RequestErrorInfo | null>(null)
  const [uploadFeedback, setUploadFeedback] = useState<Feedback | null>(null)
  const [bindFeedback, setBindFeedback] = useState<Feedback | null>(null)
  const [retryFeedback, setRetryFeedback] = useState<Feedback | null>(null)
  const [activeModal, setActiveModal] = useState<KnowledgeActionModal | null>(null)
  const [previewFile, setPreviewFile] = useState<KbFile | null>(null)
  const [isPreviewLoaded, setIsPreviewLoaded] = useState(false)
  const [documentPreview, setDocumentPreview] = useState<KnowledgeDocumentPreview | null>(null)
  const [isDocumentPreviewLoading, setIsDocumentPreviewLoading] = useState(false)
  const [documentPreviewError, setDocumentPreviewError] = useState('')
  const [documentOpenError, setDocumentOpenError] = useState('')
  const [documentLocalPath, setDocumentLocalPath] = useState('')
  const [statusTooltip, setStatusTooltip] = useState<StatusTooltip | null>(null)
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false)
  const [canExpandDescription, setCanExpandDescription] = useState(false)
  const mainRef = useRef<HTMLElement | null>(null)
  const descriptionRef = useRef<HTMLParagraphElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const previewRequestRef = useRef(0)
  const pendingUploadedDocsRef = useRef<Map<string, KbFile[]>>(new Map())
  const uploadAnimationTimerRef = useRef<number | null>(null)
  const uploadBusyRef = useRef(false)
  const [sourceWarnings, setSourceWarnings] = useState<string[]>([])
  const bindDialogRef = useDialogFocus<HTMLDivElement>({ active: activeModal === 'bind' })
  const previewDialogRef = useDialogFocus<HTMLElement>({ active: previewFile !== null })
  const [recentlyUploadedFileKeys, setRecentlyUploadedFileKeys] = useState<Set<string>>(new Set())
  const [hasKnowledgeSource, setHasKnowledgeSource] = useState(false)
  const isKnowledgeWriteDisabled = !hasKnowledgeSource
  const knowledgeWriteReason = '请先在知识库首页连接企业知识库或添加个人知识库服务。'

  useEffect(() => {
    const config = readKnowledgeSourceConfig()
    setHasKnowledgeSource(Boolean(config.enterpriseUrl || config.nas.length))
  }, [])

  const loadData = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setIsLoading(true)
    setLoadError(null)
    try {
      const [nextList, nextEmployees] = await Promise.all([
        fetchKnowledgeBases(setSourceWarnings),
        fetchKnowledgeEmployees().catch(() => []),
      ])
      setList(mergePendingUploadedDocs(nextList, pendingUploadedDocsRef.current))
      setEmployees(nextEmployees)
    } catch (err) {
      setLoadError(classifyRequestError(err, '知识库详情加载失败，请稍后重试。'))
    } finally {
      if (!options?.silent) setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    const firstEmployeeId = employees[0]?.employeeId ?? ''
    if (!employees.some((employee) => employee.employeeId === bindEmployeeId)) {
      setBindEmployeeId(firstEmployeeId)
    }
  }, [bindEmployeeId, employees])

  useEffect(() => {
    const nextPreviews = uploadFiles.map(({ file }, index) => {
      const isImage = isPreviewImage(file)
      return {
        key: getUploadPreviewKey(file, index),
        name: file.name,
        size: formatPreviewSize(file.size),
        type: getUploadPreviewType(file),
        isImage,
        url: isImage ? URL.createObjectURL(file) : undefined,
      }
    })

    setUploadPreviews(nextPreviews)

    return () => {
      nextPreviews.forEach((preview) => {
        if (preview.url) URL.revokeObjectURL(preview.url)
      })
    }
  }, [uploadFiles])

  useEffect(() => {
    const delay = getFeedbackDismissDelay(uploadFeedback, isUploading)
    if (!delay) return undefined

    const timer = window.setTimeout(() => {
      setUploadFeedback(null)
    }, delay)

    return () => window.clearTimeout(timer)
  }, [isUploading, uploadFeedback])

  useEffect(() => {
    return () => {
      if (uploadAnimationTimerRef.current !== null) {
        window.clearTimeout(uploadAnimationTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    return () => {
      if (documentPreview?.objectUrl) {
        URL.revokeObjectURL(documentPreview.objectUrl)
      }
    }
  }, [documentPreview])

  useEffect(() => {
    const delay = getFeedbackDismissDelay(retryFeedback, Boolean(isRetryingId))
    if (!delay) return undefined

    const timer = window.setTimeout(() => {
      setRetryFeedback(null)
    }, delay)

    return () => window.clearTimeout(timer)
  }, [isRetryingId, retryFeedback])

  useEffect(() => {
    const delay = getFeedbackDismissDelay(bindFeedback, isBinding)
    if (!delay) return undefined

    const timer = window.setTimeout(() => {
      setBindFeedback(null)
    }, delay)

    return () => window.clearTimeout(timer)
  }, [bindFeedback, isBinding])

  const primaryKb = list.find((item) => item.id === id)
  const selectedKbName = primaryKb?.name ?? '知识库详情'
  const primaryDescription = primaryKb?.description?.trim() || '暂无知识库说明'
  const hasPrimaryDescription = Boolean(primaryKb?.description?.trim())
  const readyDocs = primaryKb?.files.filter((file) => ['ready', 'done', 'active'].includes(String(file.status))).length ?? 0
  const errorDocs = primaryKb?.files.filter((file) => normalizeStatusClass(file.status) === 'error').length ?? 0
  const chunkCount = primaryKb?.files.reduce((sum, file) => sum + (file.chunks ?? 0), 0) ?? 0
  const previewUrlResult = previewFile
    ? getKnowledgeFilePreviewUrlResult(previewFile)
    : { url: null, error: null }
  const previewUrl = previewUrlResult.url
  const normalizedDocumentSearchText = documentSearchText.trim().toLowerCase()
  const filteredDocumentFiles = useMemo(() => {
    const files = primaryKb?.files ?? []
    if (!normalizedDocumentSearchText) return files

    return files.filter((file) => {
      const searchableText = [
        file.name,
        file.fileName,
      ].filter(Boolean).join(' ').toLowerCase()
      return searchableText.includes(normalizedDocumentSearchText)
    })
  }, [normalizedDocumentSearchText, primaryKb?.files])
  const documentPageCount = Math.max(1, Math.ceil(filteredDocumentFiles.length / DOCUMENT_PAGE_SIZE))
  const normalizedDocumentPage = Math.min(documentPage, documentPageCount)
  const pagedDocumentFiles = useMemo(() => {
    const start = (normalizedDocumentPage - 1) * DOCUMENT_PAGE_SIZE
    return filteredDocumentFiles.slice(start, start + DOCUMENT_PAGE_SIZE)
  }, [filteredDocumentFiles, normalizedDocumentPage])

  useEffect(() => {
    setIsDescriptionExpanded(false)
    setCanExpandDescription(false)
    setDocumentSearchText('')
    previewRequestRef.current += 1
    setPreviewFile(null)
    setIsPreviewLoaded(false)
    setDocumentPreview(null)
    setDocumentPreviewError('')
    setDocumentOpenError('')
    setDocumentLocalPath('')
    setIsDocumentPreviewLoading(false)
    setDocumentPage(1)
  }, [id])

  useEffect(() => {
    setDocumentPage(1)
  }, [normalizedDocumentSearchText])

  useEffect(() => {
    if (documentPage > documentPageCount) {
      setDocumentPage(documentPageCount)
    }
  }, [documentPage, documentPageCount])

  useEffect(() => {
    if (!hasPrimaryDescription || isDescriptionExpanded) return undefined

    const measureDescription = () => {
      const node = descriptionRef.current
      if (!node) return
      setCanExpandDescription(node.scrollHeight > node.clientHeight + 1)
    }

    const frame = window.requestAnimationFrame(measureDescription)
    window.addEventListener('resize', measureDescription)

    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', measureDescription)
    }
  }, [hasPrimaryDescription, isDescriptionExpanded, primaryDescription])

  const handleNestedWheel = (event: WheelEvent<HTMLDivElement>) => {
    const scroller = event.currentTarget
    const main = mainRef.current
    if (!main || scroller.scrollHeight <= scroller.clientHeight) return

    const deltaY = normalizeWheelDeltaY(event)
    if (deltaY === 0) return

    const isAtTop = scroller.scrollTop <= 1
    const isAtBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1
    const shouldPassToMain = (deltaY < 0 && isAtTop) || (deltaY > 0 && isAtBottom)
    if (!shouldPassToMain) return

    const mainCanScroll =
      deltaY < 0
        ? main.scrollTop > 0
        : main.scrollTop + main.clientHeight < main.scrollHeight - 1

    if (!mainCanScroll) return

    event.preventDefault()
    main.scrollBy({ top: deltaY })
  }

  const handleRefresh = async () => {
    setIsRefreshing(true)
    try {
      await loadData({ silent: true })
    } finally {
      setIsRefreshing(false)
    }
  }

  const handleChangeDocumentViewMode = useCallback((mode: KbViewMode) => {
    setDocumentViewMode(mode)
    if (typeof window === 'undefined') return
    try {
      writeKnowledgeDocumentViewMode(window.localStorage, mode)
    } catch {
      // localStorage 的 getter 也可能因隐私策略抛错；内存中的视图切换仍然有效。
    }
  }, [])

  const handleOpenBind = () => {
    if (isKnowledgeWriteDisabled) return
    setBindFeedback(null)
    setActiveModal('bind')
  }

  const handleCloseModal = () => {
    setActiveModal(null)
  }

  const handleOpenDocumentPreview = async (file: KbFile) => {
    const requestId = previewRequestRef.current + 1
    previewRequestRef.current = requestId
    setPreviewFile(file)
    setIsPreviewLoaded(false)
    setDocumentPreview(null)
    setDocumentPreviewError('')
    setDocumentOpenError('')
    setDocumentLocalPath('')
    setIsDocumentPreviewLoading(true)

    try {
      const localPath = primaryKb?.id ? await findKnowledgeFileLocalPath(file, primaryKb.id) : null
      if (previewRequestRef.current !== requestId) return
      setDocumentLocalPath(localPath ?? '')

      const preview = await loadDocumentPreview(file, localPath)
      if (previewRequestRef.current !== requestId) {
        if (preview.objectUrl) URL.revokeObjectURL(preview.objectUrl)
        return
      }
      setDocumentPreview(preview)
    } catch (err) {
      if (previewRequestRef.current !== requestId) return
      setDocumentPreviewError(getErrorMessage(err, '预览读取失败'))
    } finally {
      if (previewRequestRef.current === requestId) {
        setIsDocumentPreviewLoading(false)
      }
    }
  }

  const handleDocumentPreviewKeyDown = (event: KeyboardEvent<HTMLDivElement>, file: KbFile) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    void handleOpenDocumentPreview(file)
  }

  const handleCloseDocumentPreview = () => {
    previewRequestRef.current += 1
    setPreviewFile(null)
    setIsPreviewLoaded(false)
    setDocumentPreview(null)
    setDocumentPreviewError('')
    setDocumentOpenError('')
    setDocumentLocalPath('')
    setIsDocumentPreviewLoading(false)
  }

  useGlobalShortcutClose({ active: activeModal !== null, onClose: handleCloseModal })
  useGlobalShortcutClose({ active: previewFile !== null, onClose: handleCloseDocumentPreview })

  const handleOpenOriginalFile = async () => {
    if (!previewFile || !primaryKb?.id) return
    setDocumentOpenError('')

    try {
      const localPath = documentLocalPath || await findKnowledgeFileLocalPath(previewFile, primaryKb.id)
      if (!localPath) {
        setDocumentOpenError('未找到本地文件路径，请先在知识库首页执行本地扫描，或从本地扫描结果上传该文件。')
        return
      }
      setDocumentLocalPath(localPath)
      await openLocalKnowledgeFile(localPath)
    } catch (err) {
      setDocumentOpenError(getErrorMessage(err, '打开原文件失败'))
    }
  }

  const handleShowStatusTooltip = (event: MouseEvent<HTMLElement>, text?: string) => {
    if (!text) return

    const rect = event.currentTarget.getBoundingClientRect()
    const halfWidth = 160
    const placement = rect.top > 96 ? 'top' : 'bottom'
    setStatusTooltip({
      text,
      left: Math.min(Math.max(rect.left + rect.width / 2, halfWidth + 12), window.innerWidth - halfWidth - 12),
      top: placement === 'top' ? rect.top : rect.bottom,
      placement,
    })
  }

  const handleHideStatusTooltip = () => {
    setStatusTooltip(null)
  }

  const handleBindEmployeeChange = (e: ChangeEvent<HTMLSelectElement>) => {
    setBindEmployeeId(e.target.value)
  }

  const handleSetUploadFiles = (items: KnowledgeUploadFile[]) => {
    if (isKnowledgeWriteDisabled || uploadBusyRef.current) {
      if (isKnowledgeWriteDisabled) setUploadFeedback({ kind: 'error', text: knowledgeWriteReason })
      return
    }
    const accepted = items.filter(({ file }) => isKnowledgeUploadCandidate(file))
    const rejected = items.length - accepted.length
    setUploadFiles(accepted)
    if (rejected > 0) {
      setUploadFeedback({ kind: 'error', text: `已忽略 ${rejected} 个临时或无效文件` })
    } else if (uploadFeedback?.kind === 'error') {
      setUploadFeedback(null)
    }
  }

  const handleChooseUploadFiles = async () => {
    if (isKnowledgeWriteDisabled || isUploading) return
    setUploadFeedback(null)
    try {
      const selections = await selectKnowledgeUploadFiles()
      if (selections.length === 0) return
      handleSetUploadFiles(selections.map(mapUploadSelection))
    } catch (err) {
      fileInputRef.current?.click()
      setUploadFeedback({ kind: 'error', text: getErrorMessage(err, '系统文件选择器不可用，已切换为普通选择') })
    }
  }

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (isKnowledgeWriteDisabled) return
    if (e.target.files?.length) {
      handleSetUploadFiles(Array.from(e.target.files).map((file) => ({
        file,
        localPath: getUploadFileLocalPath(file),
      })))
      e.target.value = ''
    }
  }

  const handleRemoveUploadFile = (targetIndex: number) => {
    if (uploadBusyRef.current) return
    setUploadFiles((files) => files.filter((_, index) => index !== targetIndex))
  }

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (isKnowledgeWriteDisabled || isUploading) return
    setIsDragging(true)
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setIsDragging(false)
    }
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (isKnowledgeWriteDisabled || isUploading) return
    setIsDragging(false)
    if (e.dataTransfer.files.length) {
      handleSetUploadFiles(Array.from(e.dataTransfer.files).map((file) => ({
        file,
        localPath: getUploadFileLocalPath(file),
      })))
    }
  }

  const handleUploadSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (isKnowledgeWriteDisabled) {
      setUploadFeedback({ kind: 'error', text: knowledgeWriteReason })
      return
    }
    if (!primaryKb?.id || uploadFiles.length === 0 || uploadBusyRef.current) return

    uploadBusyRef.current = true
    setIsUploading(true)
    setIsCurrentFileUploaded(false)
    setUploadFeedback({ kind: 'info', text: '上传中...' })
    try {
      const result = await uploadKnowledgeBatch(uploadFiles,
        ({ file, localPath }) => uploadKnowledgeFile(primaryKb.id, file, undefined, localPath, () => setIsCurrentFileUploaded(true), primaryKb.source),
        (index, total) => {
          setIsCurrentFileUploaded(false)
          setUploadFeedback({ kind: 'info', text: `上传中 (${index}/${total})：${uploadFiles[index - 1].file.name}` })
        },
      )
      const uploadedDocs = result.uploaded
      rememberPendingUploadedDocs(pendingUploadedDocsRef.current, primaryKb.id, uploadedDocs)
      setList((currentList) => mergeUploadedDocsIntoList(currentList, primaryKb.id, uploadedDocs))
      setRecentlyUploadedFileKeys(new Set(uploadedDocs.map(getKnowledgeFileMergeKey)))
      if (uploadAnimationTimerRef.current !== null) {
        window.clearTimeout(uploadAnimationTimerRef.current)
      }
      uploadAnimationTimerRef.current = window.setTimeout(() => {
        setRecentlyUploadedFileKeys(new Set())
        uploadAnimationTimerRef.current = null
      }, 650)
      setUploadFiles(result.failed.map(({ item }) => item))
      setUploadFeedback(result.failed.length
        ? { kind: 'error', text: `已提交 ${uploadedDocs.length} 个，失败 ${result.failed.length} 个。仅保留失败文件可重试：${result.failed.map(({ item, error }) => `${item.file.name}：${error}`).join('；')}` }
        : { kind: 'success', text: `已提交 ${uploadedDocs.length} 个文件，解析与入库状态请查看文档列表` })
      await loadData({ silent: true })
    } catch (err) {
      setUploadFeedback({ kind: 'error', text: getErrorMessage(err, '上传失败') })
    } finally {
      uploadBusyRef.current = false
      setIsUploading(false)
      setIsCurrentFileUploaded(false)
    }
  }

  const handleBindSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (isKnowledgeWriteDisabled) {
      setBindFeedback({ kind: 'error', text: knowledgeWriteReason })
      return
    }
    if (!primaryKb?.id || !bindEmployeeId) return

    const existingIds = list
      .filter((kb) => kb.employeeBindings?.some((binding) => binding.employeeId === bindEmployeeId))
      .map((kb) => kb.id)

    setIsBinding(true)
    setBindFeedback({ kind: 'info', text: '绑定中...' })
    try {
      if (!existingIds.includes(primaryKb.id)) await updateEmployeeKnowledgeBases(bindEmployeeId, [primaryKb.id])
      setBindFeedback({ kind: 'success', text: existingIds.includes(primaryKb.id) ? '该员工已绑定此知识库' : '绑定成功' })
      await loadData({ silent: true })
      setActiveModal(null)
    } catch (err) {
      setBindFeedback({ kind: 'error', text: getErrorMessage(err, '绑定失败') })
    } finally {
      setIsBinding(false)
    }
  }

  const handleRetry = async (file: KbFile) => {
    if (isKnowledgeWriteDisabled) {
      setRetryFeedback({ kind: 'error', text: knowledgeWriteReason })
      return
    }
    if (!primaryKb?.id || !file.assetId) {
      setRetryFeedback({ kind: 'error', text: '缺少 asset_id，无法重试' })
      return
    }

    setIsRetryingId(file.id)
    setRetryFeedback({ kind: 'info', text: `重试中：${file.name}` })
    try {
      await retryKnowledgeDocument(primaryKb.id, file)
      setRetryFeedback({ kind: 'success', text: '重试成功，已重新触发入库任务' })
      await loadData({ silent: true })
    } catch (err) {
      setRetryFeedback({ kind: 'error', text: getErrorMessage(err, '重试失败') })
    } finally {
      setIsRetryingId(null)
    }
  }

  const documentPagination = (
    <div className="kb-scan-pagination kb-document-pagination">
      <span>
        第 {normalizedDocumentPage} / {documentPageCount} 页 · 共 {filteredDocumentFiles.length} 个
      </span>
      <div>
        <button
          type="button"
          onClick={() => setDocumentPage((page) => Math.max(1, page - 1))}
          disabled={normalizedDocumentPage <= 1}
          aria-label="上一页"
        >
          <ChevronLeft size={14} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          onClick={() => setDocumentPage((page) => Math.min(documentPageCount, page + 1))}
          disabled={normalizedDocumentPage >= documentPageCount}
          aria-label="下一页"
        >
          <ChevronRight size={14} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  )

  return (
    <div className="kb-page kb-detail-page">
      <main className="kb-main kb-detail-main" ref={mainRef}>
        {sourceWarnings.map(message => <p key={message} className="kb-service-notice" role="status">{message}</p>)}
        {isKnowledgeWriteDisabled && <div id="kb-detail-write-disabled-reason" className="kb-service-notice" role="status">
          {knowledgeWriteReason}
        </div>}

        {isLoading ? (
          <div className="kb-loading">正在加载知识库详情...</div>
        ) : loadError ? (
          <RequestErrorState error={loadError} onRetry={() => void loadData()} />
        ) : !primaryKb ? (
          <div className="kb-empty-state large">
            <BookOpen size={26} strokeWidth={1.7} />
            <strong>知识库不存在</strong>
            <span>返回知识库列表后重新选择。</span>
          </div>
        ) : (
          <>
            <section className="kb-overview-panel kb-detail-hero">
              <div className="kb-overview-head">
                <div className="kb-overview-copy">
                  <h2>{primaryKb.name}</h2>
                  <p
                    ref={descriptionRef}
                    className={`kb-description ${isDescriptionExpanded ? 'expanded' : ''}`}
                  >
                    {primaryDescription}
                  </p>
                  {hasPrimaryDescription && canExpandDescription && (
                    <button
                      type="button"
                      className="kb-description-toggle"
                      onClick={() => setIsDescriptionExpanded((expanded) => !expanded)}
                      aria-expanded={isDescriptionExpanded}
                    >
                      {isDescriptionExpanded ? '收起' : '展开'}
                    </button>
                  )}
                </div>
                <div className="kb-overview-actions">
                  <button
                    className="kb-panel-action"
                    disabled={isLoading || isRefreshing}
                    onClick={handleRefresh}
                    type="button"
                  >
                    <RefreshCw size={13} strokeWidth={1.8} className={isRefreshing ? 'spinning' : undefined} />
                    刷新
                  </button>
                  <span className={`kb-status ${normalizeStatusClass(primaryKb.status)}`}>
                    {primaryKb.status || 'unknown'}
                  </span>
                </div>
              </div>

              <div className="kb-meta-line">
                <span>来源：{knowledgeBaseSourceLabel(primaryKb)}</span>
                <span>文档数：{primaryKb.docCount}</span>
                <span>更新于：{primaryKb.updatedAt}</span>
                <span>绑定员工：{primaryKb.employeeBindings?.length ?? 0}</span>
                <span>目录：{primaryKb.directory || '未分类'}</span>
                <span>可见范围：{knowledgeScopeLabel(primaryKb)}</span>
              </div>
              {personalLevelWarning(primaryKb) && (
                <p className="kb-source-warning" role="note"><TriangleAlert size={14} strokeWidth={1.9} />{personalLevelWarning(primaryKb)}</p>
              )}
            </section>

            <section className="kb-detail-metrics" aria-label="知识库详情统计">
              <article>
                <FileText size={16} strokeWidth={1.8} />
                <strong>{primaryKb.files.length}</strong>
                <span>全部文档</span>
              </article>
              <article>
                <Check size={16} strokeWidth={1.8} />
                <strong>{readyDocs}</strong>
                <span>已入库</span>
              </article>
              <article>
                <Activity size={16} strokeWidth={1.8} />
                <strong>{chunkCount}</strong>
                <span>分片数</span>
              </article>
              <article>
                <Users size={16} strokeWidth={1.8} />
                <strong>{primaryKb.employeeBindings?.length ?? 0}</strong>
                <span>绑定员工</span>
              </article>
            </section>

            <section className="kb-detail-layout">
              <div className="kb-detail-content">
                <section className={`kb-detail-panel documents full ${primaryKb.files.length === 0 ? 'empty' : ''}`}>
                  <div className="kb-panel-title">
                    <div>
                      <h3>文档信息</h3>
                      <p>当前知识库下的全部文件、状态、大小、分片和上传时间。</p>
                    </div>
                    <div className="kb-document-view-actions">
                      <span className="kb-sidebar-count">
                        {primaryKb.files.length} 个文件
                      </span>
                      <KbViewToggle
                        value={documentViewMode}
                        onChange={handleChangeDocumentViewMode}
                        ariaLabel="切换文档视图"
                      />
                    </div>
                  </div>

                  <p className="kb-document-actions-unavailable" role="note">
                    {KNOWLEDGE_DOCUMENT_ACTIONS_UNAVAILABLE_REASON}
                  </p>

                  {primaryKb.files.length > 0 && (
                    <div className="kb-ingest-row kb-document-filter-row">
                      <label className="kb-ingest-search">
                        <Search size={15} strokeWidth={1.8} />
                        <input
                          value={documentSearchText}
                          onChange={(e) => setDocumentSearchText(e.target.value)}
                          placeholder="仅筛选文档名称"
                          type="search"
                          aria-label="筛选文档名称（不搜索正文）"
                          aria-describedby="kb-document-search-limit"
                        />
                      </label>
                      <span className="kb-sidebar-count">
                        {normalizedDocumentSearchText ? `${filteredDocumentFiles.length}/${primaryKb.files.length}` : primaryKb.files.length}
                      </span>
                    </div>
                  )}
                  {primaryKb.files.length > 0 && (
                    <p id="kb-document-search-limit" className="kb-document-search-limit" role="note">
                      {KNOWLEDGE_FULL_TEXT_SEARCH_AVAILABILITY.reason}
                    </p>
                  )}

                  {primaryKb.files.length > 0 ? (
                    filteredDocumentFiles.length > 0 ? (
                      documentViewMode === 'grid' ? (
                        <div className="kb-document-grid-list" onWheel={handleNestedWheel}>
                          <div className="kb-document-grid" aria-label="文档网格">
                            {pagedDocumentFiles.map((file) => (
                              <KbDocumentGridCard
                                key={file.id}
                                file={file}
                                justUploaded={recentlyUploadedFileKeys.has(getKnowledgeFileMergeKey(file))}
                                isRetrying={isRetryingId === file.id}
                                isWriteDisabled={isKnowledgeWriteDisabled}
                                writeDisabledReason={knowledgeWriteReason}
                                onOpen={(selectedFile) => void handleOpenDocumentPreview(selectedFile)}
                                onRetry={(selectedFile) => void handleRetry(selectedFile)}
                              />
                            ))}
                          </div>
                          {documentPagination}
                        </div>
                      ) : (
                        <div className="kb-doc-list detail-list" onWheel={handleNestedWheel}>
                          <div className="kb-doc-table-head" aria-hidden="true">
                          <span>文件</span>
                          <span>类型</span>
                          <span>大小</span>
                          <span>上传</span>
                          <span>状态</span>
                          <span>分片</span>
                          <span>操作</span>
                        </div>
                        {pagedDocumentFiles.map((file) => {
                          const errorTooltip = getErrorTooltipText(file.status, file.errorMessage)

                          return (
                            <div
                              key={file.id}
                              className={`kb-doc-row detail previewable ${recentlyUploadedFileKeys.has(getKnowledgeFileMergeKey(file)) ? 'uploaded' : ''}`}
                              role="button"
                              tabIndex={0}
                              onClick={() => void handleOpenDocumentPreview(file)}
                              onKeyDown={(event) => handleDocumentPreviewKeyDown(event, file)}
                              aria-label={`预览文件 ${file.name}`}
                            >
                              <div>
                                <strong>{file.name}</strong>
                                <span>{file.fileName || file.id}</span>
                                {errorTooltip && <em>{errorTooltip}</em>}
                              </div>
                              <span>{file.type}</span>
                              <span>{file.size}</span>
                              <span>{file.uploadedAt}</span>
                              <span
                                className={`kb-status ${normalizeStatusClass(file.status)} ${errorTooltip ? 'has-tooltip' : ''}`}
                                onMouseEnter={(e) => handleShowStatusTooltip(e, errorTooltip)}
                                onMouseLeave={handleHideStatusTooltip}
                              >
                                {file.status || 'unknown'}
                              </span>
                              <span>{file.chunks ?? 0}</span>
                              {file.status === 'error' || file.status === 'failed' ? (
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    void handleRetry(file)
                                  }}
                                  onKeyDown={(event) => event.stopPropagation()}
                                  aria-describedby="kb-detail-write-disabled-reason"
                                  disabled={isKnowledgeWriteDisabled || isRetryingId === file.id}
                                  title={isKnowledgeWriteDisabled ? knowledgeWriteReason : undefined}
                                >
                                  <RotateCcw size={13} strokeWidth={1.8} />
                                  {isRetryingId === file.id ? '重试中' : '重试'}
                                </button>
                              ) : (
                                <span className="kb-doc-placeholder">-</span>
                              )}
                            </div>
                          )
                        })}

                          {documentPagination}
                        </div>
                      )
                    ) : (
                      <div className="kb-empty-state">
                        <FileText size={22} strokeWidth={1.7} />
                        <strong>没有匹配的文档</strong>
                        <span>调整关键词后再试。</span>
                      </div>
                    )
                  ) : (
                    <div className="kb-empty-state">
                      <FileText size={22} strokeWidth={1.7} />
                      <strong>还没有文档</strong>
                      <span>{isKnowledgeWriteDisabled ? '知识库服务恢复后可上传资料。' : '使用下方上传区域导入资料。'}</span>
                    </div>
                  )}

                  <FeedbackMessage feedback={retryFeedback} className="kb-panel-toast" />
                </section>

                <section className="kb-ingest-tools detail" aria-label="入库工具">
                  <div className="kb-tools-stack">
                    <section className={`kb-tool-panel upload ${isDragging ? 'dragging' : ''} ${isKnowledgeWriteDisabled ? 'disabled' : ''}`} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
                      <div className="kb-panel-title">
                        <div>
                          <h3>上传文档</h3>
                          <p>{isKnowledgeWriteDisabled ? knowledgeWriteReason : `上传到当前知识库“${selectedKbName}”。`}</p>
                        </div>
                      </div>
                      <form className="kb-upload-form" onSubmit={handleUploadSubmit}>
                        <div
                          className={`kb-dropzone ${isKnowledgeWriteDisabled ? 'disabled' : ''}`}
                          role="button"
                          tabIndex={isKnowledgeWriteDisabled ? -1 : 0}
                          aria-disabled={isKnowledgeWriteDisabled}
                          aria-describedby="kb-detail-write-disabled-reason"
                          aria-label={`选择上传到 ${selectedKbName} 的文档`}
                          title={isKnowledgeWriteDisabled ? knowledgeWriteReason : undefined}
                          onClick={() => void handleChooseUploadFiles()}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              void handleChooseUploadFiles()
                            }
                          }}
                        >
                          <UploadCloud size={22} strokeWidth={1.7} />
                          <strong>{isKnowledgeWriteDisabled ? '上传暂不可用' : '拖拽文件到这里，或点击选择文件'}</strong>
                          <span>{isKnowledgeWriteDisabled ? knowledgeWriteReason : primaryKb.source === 'enterprise' ? 'Manager：单文件最大 4 MiB；上传后由服务端解析入库' : '个人知识库服务：支持的格式与大小以服务端为准'}</span>
                        </div>
                        <input
                          ref={fileInputRef}
                          type="file"
                          multiple
                          hidden
                          disabled={isKnowledgeWriteDisabled}
                          accept=".txt,.md,.markdown,.csv,.json,.log,.html,.htm,.doc,.docx,.pdf,.ppt,.pptx,.zip,.png,.jpg,.jpeg,.webp,.gif,.bmp,.svg"
                          onChange={handleFileChange}
                        />

                        {uploadPreviews.length > 0 && (
                          <div className="kb-upload-preview" aria-label="待上传文件预览">
                            {uploadPreviews.map((preview, index) => (
                              <article className="kb-preview-item" key={preview.key}>
                                <div className={`kb-preview-thumb ${preview.isImage ? 'image' : ''}`}>
                                  {preview.isImage && preview.url ? (
                                    <img src={preview.url} alt={preview.name} />
                                  ) : (
                                    <FileText size={20} strokeWidth={1.7} />
                                  )}
                                </div>
                                <div className="kb-preview-info">
                                  <strong title={preview.name}>{preview.name}</strong>
                                  <span>{preview.type} / {preview.size}</span>
                                </div>
                                <button
                                  type="button"
                                  className="kb-preview-remove"
                                  onClick={() => handleRemoveUploadFile(index)}
                                  disabled={isUploading}
                                  aria-label={`移除 ${preview.name}`}
                                >
                                  <X size={13} strokeWidth={2} />
                                </button>
                              </article>
                            ))}
                          </div>
                        )}

                        <div className="kb-form-actions">
                          {uploadFiles.length > 0 ? (
                            <p className="kb-file-hint">已选择 {uploadFiles.length} 个文件，将上传到 {selectedKbName}</p>
                          ) : (
                            <p className="kb-file-hint">请选择要入库的文件。</p>
                          )}
                          <button type="submit" disabled={isKnowledgeWriteDisabled || !primaryKb.id || uploadFiles.length === 0 || isUploading} title={isKnowledgeWriteDisabled ? knowledgeWriteReason : undefined}>
                            <UploadCloud size={14} strokeWidth={1.8} />
                            {isUploading ? (isCurrentFileUploaded ? '已上传' : '上传中') : '上传'}
                          </button>
                        </div>
                      </form>
                      <FeedbackMessage feedback={uploadFeedback} className="kb-panel-toast" />
                    </section>
                  </div>
                </section>
              </div>

              <aside className="kb-detail-aside">
                <section className="kb-detail-panel compact kb-bind-panel">
                  <div className="kb-panel-title">
                    <div>
                      <h3>绑定员工</h3>
                      <p>当前可使用该知识库的 AI 员工。</p>
                    </div>
                    <button
                      type="button"
                      className={`kb-panel-action ${activeModal === 'bind' ? 'active' : ''}`}
                      onClick={handleOpenBind}
                      aria-expanded={activeModal === 'bind'}
                      aria-describedby="kb-detail-write-disabled-reason"
                      disabled={isKnowledgeWriteDisabled}
                      title={isKnowledgeWriteDisabled ? knowledgeWriteReason : undefined}
                    >
                      <Link2 size={13} strokeWidth={1.8} />
                      绑定员工
                    </button>
                  </div>

                  {activeModal === 'bind' && (
                    <div ref={bindDialogRef} className="kb-bind-popover" role="dialog" aria-modal="true" aria-labelledby="kb-bind-dialog-title" tabIndex={-1}>
                      <div className="kb-bind-popover-head">
                        <span id="kb-bind-dialog-title">选择员工</span>
                        <button
                          type="button"
                          onClick={handleCloseModal}
                          aria-label="关闭绑定员工浮层"
                          aria-keyshortcuts="Meta+W Control+W"
                          title="关闭绑定员工（⌘W / Ctrl+W）"
                        >
                          <X size={13} strokeWidth={2} />
                        </button>
                      </div>
                      <form className="kb-bind-form" onSubmit={handleBindSubmit}>
                        <label className="kb-field grow">
                          <span>员工</span>
                          <select value={bindEmployeeId} onChange={handleBindEmployeeChange} disabled={isKnowledgeWriteDisabled || employees.length === 0}>
                            {employees.length === 0 ? (
                              <option value="">暂无员工</option>
                            ) : employees.map((employee) => (
                              <option key={employee.employeeId} value={employee.employeeId}>{employee.displayName}</option>
                            ))}
                          </select>
                        </label>
                        <button type="submit" disabled={isKnowledgeWriteDisabled || !primaryKb.id || !bindEmployeeId || isBinding}>
                          <Link2 size={14} strokeWidth={1.8} />
                          {isBinding ? '绑定中' : '绑定'}
                        </button>
                      </form>
                    </div>
                  )}

                  {(primaryKb.employeeBindings?.length ?? 0) > 0 ? (
                    <div className="kb-employee-list">
                      {primaryKb.employeeBindings?.map((binding) => (
                        <article key={binding.employeeId}>
                          <span className="kb-employee-avatar">{binding.displayName.slice(0, 1).toUpperCase()}</span>
                          <div>
                            <strong>{binding.displayName}</strong>
                            <small>{binding.roleName || binding.status || '已绑定'}</small>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="kb-empty-state">
                      <Users size={22} strokeWidth={1.7} />
                      <strong>暂无绑定员工</strong>
                      <span>{isKnowledgeWriteDisabled ? '服务恢复后可为员工绑定知识库。' : '使用上方按钮为员工绑定知识库。'}</span>
                    </div>
                  )}

                  <FeedbackMessage feedback={bindFeedback} className="kb-panel-toast kb-bind-toast" />
                </section>

                <section className="kb-detail-panel compact">
                  <div className="kb-panel-title">
                    <div>
                      <h3>入库概况</h3>
                      <p>当前知识库文档状态汇总。</p>
                    </div>
                  </div>
                  <div className="kb-status-breakdown">
                    <span><Check size={13} strokeWidth={1.8} />已入库 {readyDocs}</span>
                    <span><Activity size={13} strokeWidth={1.8} />异常 {errorDocs}</span>
                    <span><FileText size={13} strokeWidth={1.8} />分片 {chunkCount}</span>
                  </div>
                </section>
              </aside>
            </section>
          </>
        )}
      </main>

      {statusTooltip && (
        <div
          className={`kb-status-tooltip ${statusTooltip.placement}`}
          role="tooltip"
          style={{ left: statusTooltip.left, top: statusTooltip.top }}
        >
          {statusTooltip.text}
        </div>
      )}

      {previewFile && (
        <div className="kb-local-preview-backdrop" onClick={handleCloseDocumentPreview}>
          <section
            ref={previewDialogRef}
            className="kb-modal kb-scan-preview-modal kb-local-preview-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="kb-document-preview-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="kb-local-preview-header">
              <div className="kb-local-preview-title">
                <div className="kb-local-preview-file-kind">
                  <FileText size={14} strokeWidth={1.8} />
                  <span>{getKnowledgePreviewKindLabel(previewFile)}</span>
                  <span>{previewFile.size}</span>
                </div>
                <h2 id="kb-document-preview-title">{previewFile.name}</h2>
              </div>

              <div className="kb-local-preview-actions">
                <span className={`kb-status ${normalizeStatusClass(previewFile.status)}`}>
                  {previewFile.status || 'unknown'}
                </span>
                <button type="button" className="kb-panel-action" onClick={handleOpenOriginalFile}>
                  <ExternalLink size={13} strokeWidth={1.8} />
                  打开原文件
                </button>
                <button
                  type="button"
                  className="kb-local-preview-close"
                  onClick={handleCloseDocumentPreview}
                  aria-label="关闭文档预览"
                  aria-keyshortcuts="Meta+W Control+W"
                  title="关闭文档预览（⌘W / Ctrl+W）"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              </div>
            </div>

            <div className="kb-local-preview-subbar">
              <div className="kb-scan-preview-path" title={documentLocalPath || getKnowledgePreviewIdentity(previewFile)}>
                {documentLocalPath || getKnowledgePreviewIdentity(previewFile)}
              </div>
              <div className="kb-local-preview-belongs">
                隶属于：{selectedKbName}
              </div>
            </div>

            <div className="kb-local-preview-body">
              {documentOpenError && (
                <p className="kb-scan-preview-note error">{documentOpenError}</p>
              )}
              {isDocumentPreviewLoading ? (
                <div className="kb-scan-preview-state">正在读取预览内容...</div>
              ) : documentPreviewError ? (
                <div className="kb-scan-preview-state error">{documentPreviewError}</div>
              ) : !previewUrl && !documentPreview ? (
                <div className="kb-scan-preview-state error">
                  {previewUrlResult.error ?? '服务端未提供安全的预览地址，无法预览这个文件。'}
                </div>
              ) : documentPreview?.mode === 'text' || documentPreview?.mode === 'markdown' ? (
                <>
                  {documentPreview.truncated && (
                    <p className="kb-scan-preview-note">文件较大，当前仅显示前 120000 字。</p>
                  )}
                  <div className={`kb-scan-preview-content ${documentPreview.mode === 'markdown' ? 'markdown' : 'text'}`}>
                    {documentPreview.content?.trim() ? (
                      documentPreview.mode === 'markdown' ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{documentPreview.content}</ReactMarkdown>
                      ) : (
                        <pre>{documentPreview.content}</pre>
                      )
                    ) : (
                      <div className="kb-scan-preview-state">这个文件没有可预览内容。</div>
                    )}
                  </div>
                </>
              ) : documentPreview?.mode === 'image' || documentPreview?.mode === 'pdf' ? (
                <div className="kb-scan-preview-content asset">
                  {!isPreviewLoaded && (
                    <div className="kb-scan-preview-state kb-scan-preview-asset-loading">正在加载预览...</div>
                  )}
                  {documentPreview.mode === 'image' ? (
                    <img
                      className={`kb-scan-preview-asset-image ${isPreviewLoaded ? 'loaded' : ''}`}
                      src={documentPreview.objectUrl}
                      alt={previewFile.name}
                      onLoad={() => setIsPreviewLoaded(true)}
                      onError={() => setIsPreviewLoaded(true)}
                    />
                  ) : (
                    <iframe
                      className={`kb-scan-preview-asset-frame ${isPreviewLoaded ? 'loaded' : ''}`}
                      src={documentPreview.objectUrl}
                      title={previewFile.name}
                      onLoad={() => setIsPreviewLoaded(true)}
                    />
                  )}
                </div>
              ) : documentPreview?.mode === 'unsupported' ? (
                <div className="kb-scan-preview-state">
                  当前文件类型暂不支持直接预览，请使用右上角“打开原文件”查看。
                </div>
              ) : (
                <div className="kb-scan-preview-state">暂无预览内容。</div>
              )}
            </div>
          </section>
        </div>
      )}

    </div>
  )
}

function FeedbackMessage({ feedback, className = '' }: { feedback: Feedback | null; className?: string }) {
  if (!feedback) return null
  return (
    <p
      className={`kb-feedback ${feedback.kind}${className ? ` ${className}` : ''}`}
      role={feedback.kind === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      {feedback.text}
    </p>
  )
}

function rememberPendingUploadedDocs(
  pendingDocsByKb: Map<string, KbFile[]>,
  kbId: string,
  docs: KbFile[],
) {
  if (docs.length === 0) return
  const currentDocs = pendingDocsByKb.get(kbId) ?? []
  pendingDocsByKb.set(kbId, mergeKnowledgeFiles(currentDocs, docs))
}

function mergePendingUploadedDocs(
  list: KnowledgeBase[],
  pendingDocsByKb: Map<string, KbFile[]>,
) {
  if (pendingDocsByKb.size === 0) return list

  return list.map((kb) => {
    const pendingDocs = pendingDocsByKb.get(kb.id)
    if (!pendingDocs?.length) return kb

    const serverKeys = new Set(kb.files.map(getKnowledgeFileMergeKey))
    const unresolvedDocs = pendingDocs.filter((file) => !serverKeys.has(getKnowledgeFileMergeKey(file)))

    if (unresolvedDocs.length > 0) {
      pendingDocsByKb.set(kb.id, unresolvedDocs)
    } else {
      pendingDocsByKb.delete(kb.id)
    }

    if (unresolvedDocs.length === 0) return kb
    const files = mergeKnowledgeFiles(kb.files, unresolvedDocs)
    return {
      ...kb,
      docCount: Math.max(kb.docCount, files.length),
      files,
    }
  })
}

function mergeUploadedDocsIntoList(list: KnowledgeBase[], kbId: string, docs: KbFile[]) {
  if (docs.length === 0) return list
  return list.map((kb) => {
    if (kb.id !== kbId) return kb
    const files = mergeKnowledgeFiles(kb.files, docs)
    return {
      ...kb,
      docCount: Math.max(kb.docCount, files.length),
      files,
    }
  })
}

function mergeKnowledgeFiles(currentFiles: KbFile[], incomingFiles: KbFile[]) {
  const seen = new Set(currentFiles.map(getKnowledgeFileMergeKey))
  const merged = [...currentFiles]

  incomingFiles.forEach((file) => {
    const key = getKnowledgeFileMergeKey(file)
    if (seen.has(key)) return
    seen.add(key)
    merged.push(file)
  })

  return merged
}

function getKnowledgeFileMergeKey(file: KbFile) {
  return file.id || file.assetId || `${file.fileName || file.name}:${file.fileSize ?? file.size}`
}

function mapUploadSelection(selection: KnowledgeUploadSelection): KnowledgeUploadFile {
  return {
    file: selection.file,
    localPath: selection.localPath,
  }
}

function getUploadFileLocalPath(file: File) {
  const path = (file as File & { path?: unknown }).path
  return typeof path === 'string' && path.length > 0 ? path : undefined
}

function canUseLocalDocumentPreview(file: KbFile) {
  const ext = getKnowledgeFileExtension(file).toLowerCase()
  return ext === 'md' || ext === 'docx'
}

async function loadDocumentPreview(file: KbFile, localPath: string | null): Promise<KnowledgeDocumentPreview> {
  if (localPath && canUseLocalDocumentPreview(file)) {
    try {
      return mapLocalPreviewToDocumentPreview(await previewLocalKnowledgeFile(localPath))
    } catch (err) {
      if (!getKnowledgeFilePreviewUrl(file)) throw err
    }
  }

  return fetchKnowledgeFilePreview(file)
}

function mapLocalPreviewToDocumentPreview(preview: {
  file_type: string
  content: string
  truncated: boolean
}): KnowledgeDocumentPreview {
  const type = preview.file_type.toLowerCase()
  return {
    mode: type === 'md' ? 'markdown' : 'text',
    contentType: type === 'md'
      ? 'text/markdown'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    fileType: type,
    content: preview.content,
    truncated: preview.truncated,
  }
}

function getKnowledgePreviewKindLabel(file: KbFile) {
  return (file.type || getKnowledgeFileExtension(file) || 'file').toUpperCase()
}

function getKnowledgePreviewIdentity(file: KbFile) {
  return file.fileName || file.assetId || file.storageKey || file.id
}

function getKnowledgeFileExtension(file: KbFile) {
  const name = file.fileName || file.name
  const ext = name.split('.').pop()
  return ext && ext !== name ? ext : ''
}
