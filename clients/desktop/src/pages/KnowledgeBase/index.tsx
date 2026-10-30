/**
 * 知识库总览页，提供知识库列表、全局统计、创建入口和详情页导航。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, WheelEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Activity,
  ArrowRight,
  BookOpen,
  Building2,
  Check,
  ChevronLeft,
  ChevronRight,
  Database,
  FolderTree,
  HardDrive,
  FileText,
  FolderSearch,
  Layers3,
  LoaderCircle,
  Plus,
  RefreshCw,
  ScanSearch,
  Search,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  UploadCloud,
  X,
} from 'lucide-react'
import './KnowledgeBase.css'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'
import KbViewToggle from './KbViewToggle'
import type { KbViewMode } from './KbViewToggle'
import KbGridCard from './KbGridCard'
import ImportDocDialog from './ImportDocDialog'
import LocalFileWebview from './LocalFileWebview'
import { useTopBarOverride } from '../../components/Layout/topBarOverride'
import KnowledgeSourceCards, {
  EMPTY_SOURCE_DRAFT,
  KnowledgeSourceFields,
  type KnowledgeSourceDraft,
  type NasConnectionView,
} from './KnowledgeSourceCards'
import RequestErrorState from '../../components/RequestState/RequestErrorState'
import { agentApi } from '../../api/agent'
import { classifyRequestError, type RequestErrorInfo } from '../../lib/requestError'
import {
  createKnowledgeBase,
  fetchKnowledgeBases,
  probeKnowledgeSource,
  readFileAsBase64,
  revealLocalKnowledgeFile,
  scanLocalKnowledgeFiles,
  uploadKnowledgeFile,
} from './api'
import {
  formatLocalScanTime,
  getScannedFileKnowledgeBases,
  isScannedFileUploadedToKnowledgeBase,
  planLocalScanAfterDirectorySelect,
  readLocalScanAuthorization,
  readLocalScanCache,
  readLocalUploadedRecords,
  removeLocalScanDirectory,
  runLocalDirectoryScanBatch,
  selectLocalScanDirectories,
  writeLocalScanAuthorization,
  writeLocalScanDirectoryCaches,
  writeLocalUploadedRecord,
} from './localKnowledgeStore'
import type { LocalScanConfirmationPlan } from './localKnowledgeStore'
import type { KnowledgeBase as KnowledgeBaseItem, LocalScanDirectoryCache, LocalUploadedKnowledgeRecord, ScannedKnowledgeFile } from './types'
import {
  displayAddress,
  readKnowledgeSourceConfig,
  upsertNasConnection,
  validateKnowledgeSourceUrl,
  writeKnowledgeSourceConfig,
} from './knowledgeSourceConfig'
import type { KnowledgeSourceConfig } from './types'
import {
  ENTERPRISE_ENDPOINT,
  knowledgeBaseSourceLabel,
  knowledgeScopeLabel,
  knowledgeSourceConnection,
  nasEndpoint,
  sameEndpoint,
  type KnowledgeEndpoint,
  type KnowledgeSourceResult,
} from './knowledgeService'
import {
  PERSONAL_KNOWLEDGE_LEVEL,
  knowledgeListEmptyText,
  personalLevelWarningSummary,
  summarizeKnowledgeSources,
  type KnowledgeCategory,
  type KnowledgeSourceSummary,
} from './knowledgeSourceGroups'
import {
  formatPreviewSize,
  getErrorMessage,
  getFeedbackDismissDelay,
  getScannedFileMimeType,
  getScannedFileType,
  getScannedFileTypeLabel,
  isLocalSearchableFile,
} from './utils'
import type { Feedback } from './utils'

// The connection dialog edits one source: the Manager, a new NAS, or an existing NAS.
type ConnectTarget = { source: 'enterprise' } | { source: 'local'; nasId?: string }

interface StatItem {
  label: string
  value: string
  tone: 'blue' | 'green' | 'purple' | 'orange'
}

interface LocalFileCategory {
  key:
    | 'courseware'
    | 'form'
    | 'summary'
    | 'receipt'
    | 'contract'
    | 'meeting'
    | 'certificate'
    | 'book'
    | 'paper'
    | 'solution'
    | 'report'
    | 'data'
    | 'presentation'
    | 'document'
    | 'other'
  label: string
  description: string
}

const LOCAL_SCAN_PAGE_SIZE = 10
const LEGACY_LOCAL_SCAN_DIRECTORY = '历史缓存'
// 知识库列表视图偏好持久化 key：列表 / 网格，默认列表
const KB_VIEW_MODE_STORAGE_KEY = 'aifred:kb:view-mode'
const LOCAL_FILE_CATEGORIES: LocalFileCategory[] = [
  { key: 'courseware', label: '课件', description: '课程、培训、教案与讲义' },
  { key: 'form', label: '表单', description: '申请、登记、问卷与清单' },
  { key: 'summary', label: '总结', description: '总结、复盘与周期性汇报' },
  { key: 'receipt', label: '票据', description: '发票、收据、账单与凭证' },
  { key: 'contract', label: '合同', description: '合同、协议与条款文件' },
  { key: 'meeting', label: '会议', description: '会议纪要、议程与会务资料' },
  { key: 'certificate', label: '证明', description: '证明、证书与资质材料' },
  { key: 'book', label: '书籍', description: '图书、教材与电子书' },
  { key: 'paper', label: '论文', description: '论文、期刊与研究文献' },
  { key: 'solution', label: '方案', description: '解决方案、设计方案与规划材料' },
  { key: 'report', label: '报告', description: '报告、调研与分析资料' },
  { key: 'data', label: '数据', description: '数据集、统计与历史数据' },
  { key: 'presentation', label: '演示', description: '演示、汇报与方案材料' },
  { key: 'document', label: '文档', description: '说明、记录与通用文档' },
  { key: 'other', label: '其他', description: '暂未识别分类的文件' },
]

export default function KnowledgeBase() {
  const navigate = useNavigate()
  const location = useLocation()
  const isLocalDocumentsPage = location.pathname === '/knowledge/local-documents'
  const [list, setList] = useState<KnowledgeBaseItem[]>([])
  const [knowledgeSearchText, setKnowledgeSearchText] = useState('')
  const [newKbName, setNewKbName] = useState('')
  const [newKbDescription, setNewKbDescription] = useState('')
  const [newKbDirectory, setNewKbDirectory] = useState('未分类')
  const [knowledgeCategory, setKnowledgeCategory] = useState<KnowledgeCategory>('all')
  const [knowledgeDirectory, setKnowledgeDirectory] = useState('全部目录')
  // The connection dialog is the only place that adds or edits a source; a NAS target without `nasId` adds a new NAS.
  const [connectTarget, setConnectTarget] = useState<ConnectTarget | null>(null)
  const [connectDraft, setConnectDraft] = useState(EMPTY_SOURCE_DRAFT)
  const [connectError, setConnectError] = useState('')
  const [isConnecting, setIsConnecting] = useState(false)
  // NAS row whose 新建知识库 opened the create dialog.
  const [createNasId, setCreateNasId] = useState('')
  const [sourceConfig, setSourceConfig] = useState<KnowledgeSourceConfig>(readKnowledgeSourceConfig)
  const [sourceResults, setSourceResults] = useState<KnowledgeSourceResult[]>([])
  // Agent knowledge-source index; null on an older Agent (404) or any failure, so the cards keep the connection view.
  const [sourceSummary, setSourceSummary] = useState<KnowledgeSourceSummary | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isLocalScanning, setIsLocalScanning] = useState(false)
  const [localScanProgress, setLocalScanProgress] = useState({ completed: 0, total: 0, filesFound: 0 })
  const localScanBusyRef = useRef(false)
  const sessionAuthorizedDirsRef = useRef<Set<string>>(new Set())
  const [pendingScanPlan, setPendingScanPlan] = useState<LocalScanConfirmationPlan | null>(null)
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false)
  const [sourceWarnings, setSourceWarnings] = useState<string[]>([])
  const [loadError, setLoadError] = useState<RequestErrorInfo | null>(null)
  const [createFeedback, setCreateFeedback] = useState<Feedback | null>(null)
  const [localScanFeedback, setLocalScanFeedback] = useState<Feedback | null>(null)
  const [localScanResults, setLocalScanResults] = useState<ScannedKnowledgeFile[]>([])
  const [localScanDirectoryCaches, setLocalScanDirectoryCaches] = useState<LocalScanDirectoryCache[]>([])
  const [localScanCachedAt, setLocalScanCachedAt] = useState('')
  const [localScanActiveCategory, setLocalScanActiveCategory] = useState('')
  const [localScanPage, setLocalScanPage] = useState(1)
  const [isLocalScanAuthorized, setIsLocalScanAuthorized] = useState(false)
  const [localScanDirectories, setLocalScanDirectories] = useState<string[]>([])
  const [localPreviewFile, setLocalPreviewFile] = useState<ScannedKnowledgeFile | null>(null)
  const [localPreviewFeedback, setLocalPreviewFeedback] = useState<Feedback | null>(null)
  const [localPreviewKbId, setLocalPreviewKbId] = useState('')
  const [isLocalPreviewUploading, setIsLocalPreviewUploading] = useState(false)
  const [isLocalPreviewUploaded, setIsLocalPreviewUploaded] = useState(false)
  const [localUploadedRecords, setLocalUploadedRecords] = useState<LocalUploadedKnowledgeRecord[]>([])
  const [directoryPendingDeletion, setDirectoryPendingDeletion] = useState('')
  const [isDeletingDirectory, setIsDeletingDirectory] = useState(false)
  const mainRef = useRef<HTMLElement | null>(null)
  const createDialogRef = useDialogFocus<HTMLElement>({ active: isCreateDialogOpen })
  const sourceConfigDialogRef = useDialogFocus<HTMLElement>({ active: connectTarget !== null })
  const confirmScanDialogRef = useDialogFocus<HTMLElement>({ active: pendingScanPlan !== null })
  const deleteDirectoryDialogRef = useDialogFocus<HTMLElement>({ active: directoryPendingDeletion.length > 0 })
  const isKnowledgeWriteDisabled = list.length === 0
  const knowledgeWriteReason = '暂无可上传的知识库，请先连接企业知识库，或添加个人知识库服务后在它那一行新建知识库。'
  // Admins configure the enterprise library; only personal services create libraries, always private.
  const resultFor = (endpoint: KnowledgeEndpoint) => sourceResults.find((result) => sameEndpoint(result.endpoint, endpoint))
  const enterpriseConnection = knowledgeSourceConnection(sourceConfig.enterpriseUrl, resultFor(ENTERPRISE_ENDPOINT))
  const nasViews: NasConnectionView[] = sourceConfig.nas.map((nas) => ({
    id: nas.id,
    name: nas.name,
    address: displayAddress(nas.url),
    connection: knowledgeSourceConnection(nas.url, resultFor(nasEndpoint(nas.id))),
    count: list.filter((item) => item.source === 'local' && item.nasId === nas.id).length,
  }))
  const createNasView = nasViews.find((item) => item.id === createNasId)
  const personalWarning = personalLevelWarningSummary(list)
  // 知识库列表视图模式：首次挂载时从 localStorage 读取，默认为列表
  // 使用惰性初始化保证 SSR / 非浏览器环境下不抛错
  const [kbViewMode, setKbViewMode] = useState<KbViewMode>(() => {
    if (typeof window === 'undefined') return 'list'
    try {
      const stored = window.localStorage.getItem(KB_VIEW_MODE_STORAGE_KEY)
      // 仅接受合法值，其它情况回退到默认的列表视图
      return stored === 'grid' ? 'grid' : 'list'
    } catch {
      return 'list'
    }
  })

  // 视图切换：写入 localStorage 并更新状态；写入失败（例如隐私模式）静默降级
  const handleChangeKbViewMode = useCallback((mode: KbViewMode) => {
    setKbViewMode(mode)
    try {
      window.localStorage.setItem(KB_VIEW_MODE_STORAGE_KEY, mode)
    } catch {
      // 忽略 localStorage 写入异常，视图状态仍在内存中生效
    }
  }, [])

  const loadSourceIndex = useCallback(async () => {
    try {
      setSourceSummary(summarizeKnowledgeSources(await agentApi.listKnowledgeSources()))
    } catch {
      setSourceSummary(null)
    }
  }, [])

  const loadData = useCallback(async (options?: { silent?: boolean }): Promise<KnowledgeSourceResult[]> => {
    if (!options?.silent) setIsLoading(true)
    setLoadError(null)
    void loadSourceIndex()
    let results: KnowledgeSourceResult[] = []
    try {
      const nextList = await fetchKnowledgeBases(setSourceWarnings, (next) => {
        results = next
        setSourceResults(next)
      })
      setList(nextList)
    } catch (err) {
      setLoadError(classifyRequestError(err, '知识库数据加载失败，请稍后重试。'))
    } finally {
      if (!options?.silent) setIsLoading(false)
    }
    return results
  }, [loadSourceIndex])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    const delay = getFeedbackDismissDelay(createFeedback, isCreating)
    if (!delay) return undefined

    const timer = window.setTimeout(() => {
      setCreateFeedback(null)
    }, delay)

    return () => window.clearTimeout(timer)
  }, [createFeedback, isCreating])

  useEffect(() => {
    const delay = getFeedbackDismissDelay(localScanFeedback, isLocalScanning)
    if (!delay) return undefined

    const timer = window.setTimeout(() => {
      setLocalScanFeedback(null)
    }, delay)

    return () => window.clearTimeout(timer)
  }, [isLocalScanning, localScanFeedback])

  useEffect(() => {
    const delay = getFeedbackDismissDelay(localPreviewFeedback, isLocalPreviewUploading)
    if (!delay) return undefined

    const timer = window.setTimeout(() => {
      setLocalPreviewFeedback(null)
    }, delay)

    return () => window.clearTimeout(timer)
  }, [isLocalPreviewUploading, localPreviewFeedback])

  useEffect(() => {
    let isMounted = true

    const restoreLocalScanState = async () => {
      const [authorization, cache, uploadedRecords] = await Promise.all([
        readLocalScanAuthorization(),
        readLocalScanCache(),
        readLocalUploadedRecords(),
      ])
      if (!isMounted) return
      const directories = authorization?.directories ?? []
      setIsLocalScanAuthorized(directories.length > 0)
      setLocalScanDirectories(directories)
      setLocalUploadedRecords(uploadedRecords)
      if (!cache) return
      setLocalScanResults(cache.files)
      setLocalScanDirectoryCaches(cache.directories ?? getLegacyLocalScanDirectoryCaches(cache.files, cache.scannedAt))
      setLocalScanCachedAt(cache.scannedAt)
    }

    void restoreLocalScanState()

    return () => {
      isMounted = false
    }
  }, [])

  const normalizedKnowledgeSearchText = knowledgeSearchText.trim().toLowerCase()
  const categorizedList = useMemo(() => {
    const bySource = knowledgeCategory === 'all' ? list : list.filter((item) => item.source === knowledgeCategory)
    if (knowledgeDirectory === '全部目录') return bySource
    return bySource.filter((item) => (item.directory || '未分类') === knowledgeDirectory)
  }, [knowledgeCategory, knowledgeDirectory, list])
  const directories = useMemo(() => {
    const sourceList = knowledgeCategory === 'all' ? list : list.filter((item) => item.source === knowledgeCategory)
    return ['全部目录', ...new Set(sourceList.map((item) => item.directory || '未分类'))]
  }, [knowledgeCategory, list])
  const filteredList = useMemo(() => {
    if (!normalizedKnowledgeSearchText) return categorizedList
    return categorizedList.filter((item) => {
      const searchableText = [
        item.name,
        item.description,
      ].filter(Boolean).join(' ').toLowerCase()
      return searchableText.includes(normalizedKnowledgeSearchText)
    })
  }, [categorizedList, normalizedKnowledgeSearchText])
  const groupedList = useMemo(() => {
    const groups = new Map<string, KnowledgeBaseItem[]>()
    filteredList.forEach((item) => {
      const directory = item.directory || '未分类'
      groups.set(directory, [...(groups.get(directory) ?? []), item])
    })
    return [...groups.entries()]
  }, [filteredList])

  const totalDocs = useMemo(() => list.reduce((sum, item) => sum + item.docCount, 0), [list])
  const readyChunks = useMemo(() => {
    const chunks = list.reduce(
      (sum, kb) => sum + kb.files.reduce((fileSum, file) => fileSum + (file.chunks ?? 0), 0),
      0,
    )
    const hasUnknownChunks = list.some((kb) => kb.files.some((file) => file.chunks == null))
    return hasUnknownChunks ? '—' : String(chunks)
  }, [list])

  const updatedFilesToday = list.reduce((sum, item) => sum + (item.updatedFilesToday ?? 0), 0)
  const uploadedUsersToday = list.reduce((sum, item) => sum + (item.uploadedUsersToday ?? 0), 0)
  const hasActivityData = list.some((item) => item.updatedFilesToday != null || item.uploadedUsersToday != null)
  const statItems: StatItem[] = [
    { label: '知识库数量', value: String(list.length), tone: 'blue' },
    { label: '文档总数', value: String(totalDocs), tone: 'green' },
    { label: '向量分片', value: readyChunks, tone: 'purple' },
    { label: '今日活跃', value: hasActivityData ? `${updatedFilesToday} 文件 · ${uploadedUsersToday} 人` : '—', tone: 'orange' },
  ]

  const activeDirectoryFiles = localScanResults
  const localScanCategories = useMemo(() => {
    return LOCAL_FILE_CATEGORIES.map((category) => ({
      ...category,
      files: activeDirectoryFiles.filter((file) => getLocalFileCategory(file.name) === category.key),
    })).filter((category) => category.files.length > 0)
  }, [activeDirectoryFiles])
  const selectedLocalScanCategory = localScanCategories.find(
    (category) => category.key === localScanActiveCategory,
  ) ?? null
  const filteredLocalScanResults = useMemo(() => {
    return selectedLocalScanCategory?.files ?? []
  }, [selectedLocalScanCategory])
  const localScanPageCount = Math.max(1, Math.ceil(filteredLocalScanResults.length / LOCAL_SCAN_PAGE_SIZE))
  const normalizedLocalScanPage = Math.min(localScanPage, localScanPageCount)
  const pagedLocalScanResults = useMemo(() => {
    const start = (normalizedLocalScanPage - 1) * LOCAL_SCAN_PAGE_SIZE
    return filteredLocalScanResults.slice(start, start + LOCAL_SCAN_PAGE_SIZE)
  }, [filteredLocalScanResults, normalizedLocalScanPage])

  useEffect(() => {
    setLocalScanPage(1)
    setLocalScanActiveCategory((current) => (
      current && localScanCategories.some((category) => category.key === current) ? current : ''
    ))
  }, [localScanCategories, localScanDirectoryCaches])

  const handleOpenLocalCategory = (categoryKey: LocalFileCategory['key']) => {
    setLocalScanActiveCategory(categoryKey)
    setLocalScanPage(1)
  }

  const localPreviewMatchedKbs = useMemo(() => {
    if (!localPreviewFile) return []
    return getScannedFileKnowledgeBases(localPreviewFile, list, localUploadedRecords)
  }, [list, localPreviewFile, localUploadedRecords])
  const localPreviewTargetKb = useMemo(() => {
    return list.find((kb) => kb.id === localPreviewKbId)
      ?? localPreviewMatchedKbs[0]
      ?? list[0]
      ?? null
  }, [list, localPreviewKbId, localPreviewMatchedKbs])
  const isLocalPreviewUploadedToTarget = Boolean(
    localPreviewFile
    && localPreviewTargetKb
    && isScannedFileUploadedToKnowledgeBase(localPreviewFile, localPreviewTargetKb, localUploadedRecords),
  )
  const isLocalPreviewActionLocked = isLocalPreviewUploading && !isLocalPreviewUploaded

  const handleNestedListWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    const listElement = event.currentTarget
    const isAtTop = listElement.scrollTop <= 0
    const isAtBottom = listElement.scrollTop + listElement.clientHeight >= listElement.scrollHeight - 1
    const shouldPassToMain = (event.deltaY < 0 && isAtTop) || (event.deltaY > 0 && isAtBottom)

    if (!shouldPassToMain || !mainRef.current) return

    event.preventDefault()
    mainRef.current.scrollBy({ top: event.deltaY })
  }, [])

  const handleOpenDetail = (kbId?: string) => {
    if (!kbId) return
    navigate(`/knowledge/${encodeURIComponent(kbId)}`)
  }

  const handleOpenLocalDocuments = () => {
    navigate('/knowledge/local-documents')
  }

  const handleRefresh = async () => {
    setIsRefreshing(true)
    try {
      await loadData({ silent: true })
    } finally {
      setIsRefreshing(false)
    }
  }

  const draftFor = (target: ConnectTarget): KnowledgeSourceDraft => {
    if (target.source === 'enterprise') return { name: '', url: sourceConfig.enterpriseUrl, token: sourceConfig.enterpriseToken }
    const nas = target.nasId ? sourceConfig.nas.find((item) => item.id === target.nasId) : undefined
    return nas ? { name: nas.name, url: nas.url, token: nas.token } : EMPTY_SOURCE_DRAFT
  }

  // Verifies the draft before saving, so a failing address never replaces or adds a connection.
  // Resolves with the saved NAS id ('' for Manager), or null when nothing was saved.
  const saveConnection = async (target: ConnectTarget): Promise<string | null> => {
    const url = connectDraft.url.trim()
    if (!url) {
      setConnectError(target.source === 'local' ? '请填写服务地址。' : '请填写 Manager 地址。')
      return null
    }
    const urlError = validateKnowledgeSourceUrl(url)
    if (urlError) {
      setConnectError(urlError)
      return null
    }
    const current = readKnowledgeSourceConfig()
    let next: KnowledgeSourceConfig
    let nasId = ''
    try {
      if (target.source === 'enterprise') {
        next = { ...current, enterpriseUrl: url, enterpriseToken: connectDraft.token }
      } else {
        const saved = upsertNasConnection(current, { id: target.nasId, ...connectDraft })
        next = saved.config
        nasId = saved.id
      }
    } catch (err) {
      setConnectError(getErrorMessage(err, '连接信息无效，请检查后重试。'))
      return null
    }
    setIsConnecting(true)
    setConnectError('')
    try {
      try {
        await probeKnowledgeSource(target.source, url, connectDraft.token)
      } catch (err) {
        setConnectError(`连接失败，未保存：${getErrorMessage(err, '无法连接该服务')}`)
        return null
      }
      writeKnowledgeSourceConfig(next)
      setSourceConfig(readKnowledgeSourceConfig())
      await loadData({ silent: true })
      return nasId
    } catch (err) {
      setConnectError(getErrorMessage(err, '服务配置保存失败，请重试。'))
      return null
    } finally {
      setIsConnecting(false)
    }
  }

  const handleOpenConnect = (target: ConnectTarget) => {
    setConnectDraft(draftFor(target))
    setConnectError('')
    setConnectTarget(target)
  }

  const handleCloseConnect = () => {
    if (isConnecting) return
    setConnectTarget(null)
    setConnectError('')
  }

  const handleSubmitConnect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!connectTarget || isConnecting) return
    if (await saveConnection(connectTarget) !== null) setConnectTarget(null)
  }

  // Removes only this machine's connection; libraries stay on the NAS or Manager.
  const handleDisconnectSource = async () => {
    if (!connectTarget || isConnecting) return
    const current = readKnowledgeSourceConfig()
    try {
      writeKnowledgeSourceConfig(connectTarget.source === 'enterprise'
        ? { ...current, enterpriseUrl: '', enterpriseToken: '' }
        : { ...current, nas: current.nas.filter((item) => item.id !== connectTarget.nasId) })
    } catch (err) {
      setConnectError(getErrorMessage(err, '断开连接失败，请重试。'))
      return
    }
    setSourceConfig(readKnowledgeSourceConfig())
    setConnectTarget(null)
    await loadData({ silent: true })
  }

  // Libraries are created from a NAS row, so the target NAS is always explicit.
  const handleOpenCreateDialog = (nasId: string) => {
    setCreateNasId(nasId)
    setCreateFeedback(null)
    setIsCreateDialogOpen(true)
  }

  const handleCloseCreateDialog = () => {
    if (isCreating) return
    setIsCreateDialogOpen(false)
    setNewKbName('')
    setNewKbDescription('')
    setNewKbDirectory('未分类')
    setCreateFeedback(null)
  }

  const executeLocalScan = async (targetDirectories: string[]) => {
    if (localScanBusyRef.current) return
    if (targetDirectories.length === 0) {
      setLocalScanFeedback({ kind: 'info', text: '没有需要扫描的目录' })
      return
    }

    const scanId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`
    localScanBusyRef.current = true
    setLocalScanProgress({ completed: 0, total: targetDirectories.length, filesFound: 0 })
    setIsLocalScanning(true)
    setLocalScanFeedback({ kind: 'info', text: '正在扫描目录中的文档...（注：员工对话检索仅支持纯文本 Markdown/CSV；DOCX/PDF/PPT 仅支持上传到云端知识库）' })
    try {
      const result = await runLocalDirectoryScanBatch(
        targetDirectories,
        (directory, index) => scanLocalKnowledgeFiles([directory], `${scanId}:${index}`),
        (progress) => {
          setLocalScanProgress({
            completed: progress.completed,
            total: progress.total,
            filesFound: progress.filesFound,
          })
        },
      )

      if (result.updates.length > 0) {
        const cache = await writeLocalScanDirectoryCaches(result.updates)
        setLocalScanResults(cache.files)
        setLocalScanDirectoryCaches(cache.directories ?? [])
        setLocalScanCachedAt(cache.scannedAt)

        if (result.failed.length === 0) {
          setLocalScanFeedback({ kind: 'success', text: `扫描完成，本次发现 ${result.scannedFilesCount} 个文件` })
        } else {
          setLocalScanFeedback({
            kind: 'info',
            text: `已扫描 ${result.updates.length} 个目录（发现 ${result.scannedFilesCount} 个文件），其余 ${result.failed.length} 个目录需重新选择授权后扫描`,
          })
        }
        return
      }

      if (result.failed.length > 0 && result.failed.every((item) => item.permissionDenied)) {
        setLocalScanFeedback({
          kind: 'error',
          text: '当前目录尚未授权或授权已取消。可点击“扫描”重新选择目录，或在设置的“本机文件访问权限”中授权。',
        })
      } else if (result.failed.length > 0) {
        setLocalScanFeedback({ kind: 'error', text: result.failed[0].error })
      }
    } catch (err) {
      setLocalScanFeedback({ kind: 'error', text: getErrorMessage(err, '本地扫描失败') })
    } finally {
      localScanBusyRef.current = false
      setIsLocalScanning(false)
    }
  }

  const handleAuthorizeLocalScan = async () => {
    if (localScanBusyRef.current || isLocalScanning) return
    setLocalScanFeedback(null)
    try {
      const directories = await selectLocalScanDirectories()
      if (directories.length === 0) {
        setLocalScanFeedback({
          kind: 'info',
          text: isLocalScanAuthorized ? '未选择新目录，已保留当前扫描目录' : '未选择扫描目录',
        })
        return
      }

      directories.forEach((directory) => {
        sessionAuthorizedDirsRef.current.add(directory)
      })
      const plan = planLocalScanAfterDirectorySelect({
        selectedDirectories: directories,
        authorizedDirectories: localScanDirectories,
        directoryCaches: localScanDirectoryCaches,
      })
      if (!plan) return
      setPendingScanPlan(plan)
    } catch (err) {
      setLocalScanFeedback({ kind: 'error', text: getErrorMessage(err, '本地目录授权失败') })
    }
  }

  const handleCloseConfirmScanDialog = () => {
    if (isLocalScanning) return
    setPendingScanPlan(null)
  }

  const handleConfirmLocalScan = async () => {
    if (!pendingScanPlan || localScanBusyRef.current || isLocalScanning) return
    const plan = pendingScanPlan
    setPendingScanPlan(null)
    try {
      const authorization = await writeLocalScanAuthorization(plan.nextAuthorizedDirectories)
      setLocalScanDirectories(authorization.directories)
      setIsLocalScanAuthorized(authorization.directories.length > 0)
      await executeLocalScan(plan.directoriesToScan)
    } catch (err) {
      setLocalScanFeedback({ kind: 'error', text: getErrorMessage(err, '确认扫描失败') })
    }
  }

  const handleRequestDeleteDirectory = (directory: string) => {
    setDirectoryPendingDeletion(directory)
  }

  const handleCloseDeleteDirectoryDialog = () => {
    if (isDeletingDirectory) return
    setDirectoryPendingDeletion('')
  }

  const handleConfirmDeleteDirectory = async () => {
    if (!directoryPendingDeletion) return

    setIsDeletingDirectory(true)
    try {
      sessionAuthorizedDirsRef.current.delete(directoryPendingDeletion)
      const { authorization, cache } = await removeLocalScanDirectory(directoryPendingDeletion)
      setLocalScanDirectories(authorization.directories)
      setIsLocalScanAuthorized(authorization.directories.length > 0)
      setLocalScanDirectoryCaches(cache.directories ?? [])
      setLocalScanResults(cache.files)
      setLocalScanCachedAt(cache.files.length > 0 ? cache.scannedAt : '')
      setLocalScanFeedback({ kind: 'success', text: '扫描目录已删除' })
      setDirectoryPendingDeletion('')
    } catch (err) {
      setLocalScanFeedback({ kind: 'error', text: getErrorMessage(err, '删除扫描目录失败') })
    } finally {
      setIsDeletingDirectory(false)
    }
  }

  const handleOpenLocalPreview = (file: ScannedKnowledgeFile) => {
    const matchedKbs = getScannedFileKnowledgeBases(file, list, localUploadedRecords)
    setLocalPreviewFile(file)
    setLocalPreviewFeedback(null)
    setLocalPreviewKbId(matchedKbs[0]?.id ?? list[0]?.id ?? '')
  }

  const handleRevealLocalPreview = async () => {
    if (!localPreviewFile) return
    try {
      await revealLocalKnowledgeFile(localPreviewFile.path)
    } catch (err) {
      setLocalPreviewFeedback({ kind: 'error', text: getErrorMessage(err, '无法在访达中显示') })
    }
  }

  const handleCloseLocalPreview = () => {
    if (isLocalPreviewActionLocked) return
    setLocalPreviewFile(null)
    setLocalPreviewFeedback(null)
    setLocalPreviewKbId('')
  }

  const handleUploadLocalPreviewFile = async () => {
    if (isKnowledgeWriteDisabled) {
      setLocalPreviewFeedback({ kind: 'error', text: knowledgeWriteReason })
      return
    }
    if (!localPreviewFile) return
    if (!localPreviewTargetKb?.id) {
      setLocalPreviewFeedback({ kind: 'error', text: '请选择要上传到的知识库' })
      return
    }
    if (isLocalPreviewUploadedToTarget) {
      setLocalPreviewFeedback({ kind: 'info', text: '该文件已上传过，不能重复上传至同一知识库' })
      return
    }
    const previewFile = localPreviewFile
    const targetKb = localPreviewTargetKb

    setIsLocalPreviewUploading(true)
    setIsLocalPreviewUploaded(false)
    setLocalPreviewFeedback({ kind: 'info', text: `正在上传：${localPreviewFile.name}` })
    try {
      const b64 = await readFileAsBase64(previewFile.path)
      const binaryStr = atob(b64)
      const bytes = new Uint8Array(binaryStr.length)
      for (let index = 0; index < binaryStr.length; index += 1) {
        bytes[index] = binaryStr.charCodeAt(index)
      }
      const file = new File([bytes], previewFile.name, {
        type: getScannedFileMimeType(previewFile.name),
      })
      const uploadedDoc = await uploadKnowledgeFile(
        targetKb.id,
        file,
        undefined,
        previewFile.path,
        () => {
          setIsLocalPreviewUploaded(true)
          setLocalPreviewFeedback({ kind: 'success', text: '已上传' })
        },
        targetKb.source,
      )
      const uploadedRecords = await writeLocalUploadedRecord(previewFile, targetKb.id, uploadedDoc)
      setLocalUploadedRecords(uploadedRecords)
      setLocalPreviewFeedback({ kind: 'success', text: '上传成功' })
      await loadData({ silent: true })
    } catch (err) {
      setLocalPreviewFeedback({ kind: 'error', text: getErrorMessage(err, '上传失败') })
    } finally {
      setIsLocalPreviewUploading(false)
      setIsLocalPreviewUploaded(false)
    }
  }

  const handleCreateSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (isCreating) return
    const targetNas = sourceConfig.nas.find((item) => item.id === createNasId)
    if (!targetNas) {
      setCreateFeedback({ kind: 'error', text: '这个个人知识库服务已断开连接，请关闭后重新选择。' })
      return
    }
    if (!newKbName.trim()) {
      setCreateFeedback({ kind: 'error', text: '请输入知识库名称' })
      return
    }

    setIsCreating(true)
    setCreateFeedback({ kind: 'info', text: '创建中...' })
    try {
      const created = await createKnowledgeBase({
        name: newKbName.trim(),
        description: newKbDescription.trim(),
        source: 'local',
        nasId: targetNas.id,
        directory: newKbDirectory.trim() || '未分类',
        level: PERSONAL_KNOWLEDGE_LEVEL,
      })
      setNewKbName('')
      setNewKbDescription('')
      setCreateFeedback({ kind: 'success', text: '创建成功' })
      setIsCreateDialogOpen(false)
      await loadData({ silent: true })
      handleOpenDetail(created.id)
    } catch (err) {
      setCreateFeedback({ kind: 'error', text: getErrorMessage(err, '创建失败') })
    } finally {
      setIsCreating(false)
    }
  }

  useTopBarOverride(isLocalDocumentsPage && selectedLocalScanCategory ? {
    title: localPreviewFile ? localPreviewFile.name : '本地文档',
    backLabel: localPreviewFile ? selectedLocalScanCategory.label : '全部分类',
    onBack: localPreviewFile ? handleCloseLocalPreview : () => setLocalScanActiveCategory(''),
    breadcrumbs: [
      { label: '知识库', to: '/knowledge' },
      {
        label: '本地文档',
        onSelect: () => {
          if (localPreviewFile) handleCloseLocalPreview()
          if (!isLocalPreviewActionLocked) setLocalScanActiveCategory('')
        },
      },
      localPreviewFile
        ? { label: selectedLocalScanCategory.label, onSelect: handleCloseLocalPreview }
        : { label: selectedLocalScanCategory.label },
    ],
  } : null)

  useGlobalShortcutClose({
    active: localPreviewFile !== null,
    onClose: handleCloseLocalPreview,
  })
  useGlobalShortcutClose({
    active: isCreateDialogOpen,
    onClose: handleCloseCreateDialog,
  })
  useGlobalShortcutClose({
    active: pendingScanPlan !== null,
    onClose: handleCloseConfirmScanDialog,
  })
  useGlobalShortcutClose({
    active: connectTarget !== null,
    onClose: handleCloseConnect,
  })
  useGlobalShortcutClose({
    active: directoryPendingDeletion.length > 0,
    onClose: handleCloseDeleteDirectoryDialog,
  })

  return (
    <div className={`kb-page ${isLocalDocumentsPage ? 'kb-detail-page' : ''}`}>
      {isImportDialogOpen && <ImportDocDialog onClose={() => setIsImportDialogOpen(false)} onUploaded={() => void loadData({ silent: true })} />}
      <main
        className={`kb-main ${isLocalDocumentsPage ? 'kb-detail-main' : ''} ${isLocalDocumentsPage && (selectedLocalScanCategory || localPreviewFile) ? 'kb-local-fill' : ''}`}
        ref={mainRef}
      >
        {!isLocalDocumentsPage && <section className="kb-toolbar" aria-label="知识库页面操作">
          <p>统一管理企业知识，让聊天和自动化共用同一套资料。</p>

          <div className="kb-header-actions" aria-label="知识库操作">
              <>
                <button className="kb-header-action" onClick={() => setIsImportDialogOpen(true)} type="button" disabled={list.length === 0}>
                  <UploadCloud size={14} />上传文档
                </button>
                <button
                  className="kb-header-action"
                  disabled={isLoading || isRefreshing}
                  onClick={handleRefresh}
                  type="button"
                >
                  <RefreshCw size={13} strokeWidth={1.8} className={isRefreshing ? 'spinning' : undefined} />
                  刷新
                </button>
              </>
          </div>
        </section>}

        {/* The overview shows per-source errors on the cards; local documents has no cards. */}
        {!isLocalDocumentsPage ? (
          <KnowledgeSourceCards
            enterprise={enterpriseConnection}
            enterpriseIndex={sourceSummary?.enterprise ?? null}
            nas={nasViews}
            local={sourceSummary?.local ?? null}
            onConnectEnterprise={() => handleOpenConnect({ source: 'enterprise' })}
            onAddNas={() => handleOpenConnect({ source: 'local' })}
            onEditNas={(nasId) => handleOpenConnect({ source: 'local', nasId })}
            onCreateInNas={handleOpenCreateDialog}
            onOpenLocal={handleOpenLocalDocuments}
          />
        ) : sourceWarnings.map(message => <p key={message} className="kb-service-notice" role="status">{message}</p>)}

        {!isLocalDocumentsPage && personalWarning && (
          <p className="kb-source-warning" role="note"><TriangleAlert size={14} strokeWidth={1.9} />{personalWarning}</p>
        )}

        {isLocalDocumentsPage && loadError && (
          <RequestErrorState
            compact
            error={loadError}
            onRetry={() => void loadData()}
            retrying={isLoading}
          />
        )}

        {isLoading ? (
          <div className="kb-loading">正在加载知识库...</div>
        ) : loadError && !isLocalDocumentsPage ? (
          <RequestErrorState error={loadError} onRetry={() => void loadData()} />
        ) : (
          <div className="kb-home-stack">
            {!isLocalDocumentsPage && (
              <section className="kb-stats kb-command-stats" aria-label="知识库统计">
                {statItems.map((item) => (
                  <article key={item.label} className="kb-stat">
                    <span className={`kb-stat-icon ${item.tone}`}>
                      <StatIcon tone={item.tone} />
                    </span>
                    <strong>{item.value}</strong>
                    <span>{item.label}</span>
                  </article>
                ))}
              </section>
            )}

            <section className="kb-shell kb-home-shell">
              <aside className="kb-sidebar kb-home-library">
                {!isLocalDocumentsPage && <div className="kb-sidebar-header">
                  <div className="kb-sidebar-title">
                    <h2>知识库列表</h2>
                    <p>点击知识库进入详情页管理文档、员工和上传。</p>
                  </div>
                  <div className="kb-sidebar-header-actions">
                    <label className="kb-sidebar-search">
                      <Search size={14} strokeWidth={1.8} />
                      <input
                        value={knowledgeSearchText}
                        onChange={(e) => setKnowledgeSearchText(e.target.value)}
                        placeholder="搜索知识库"
                        type="search"
                      />
                    </label>
                    <span className="kb-sidebar-count">
                      {normalizedKnowledgeSearchText ? `${filteredList.length}/${list.length}` : list.length}
                    </span>
                    {/* 内容区右上角视图切换：列表 / 网格 */}
                    <KbViewToggle value={kbViewMode} onChange={handleChangeKbViewMode} />
                  </div>
                </div>}

                {!isLocalDocumentsPage && <div className="kb-category-bar" role="tablist" aria-label="知识库类型">
                  {([
                    ['all', '全部知识库', Database],
                    ['enterprise', '企业知识库', Building2],
                    ['local', '个人知识库', HardDrive],
                  ] as const).map(([value, label, Icon]) => (
                    <button key={value} type="button" role="tab" aria-selected={knowledgeCategory === value} className={knowledgeCategory === value ? 'active' : ''} onClick={() => { setKnowledgeCategory(value); setKnowledgeDirectory('全部目录') }}>
                      <Icon size={14} strokeWidth={1.8} />{label}<span>{value === 'all' ? list.length : list.filter((item) => item.source === value).length}</span>
                    </button>
                  ))}
                  <label className="kb-directory-select"><FolderTree size={14} /><span>目录</span><select value={knowledgeDirectory} onChange={(event) => setKnowledgeDirectory(event.target.value)}>{directories.map((directory) => <option key={directory} value={directory}>{directory}</option>)}</select></label>
                </div>}

                {!isLocalDocumentsPage && (filteredList.length > 0 ? (
                  // 根据 kbViewMode 切换列表 / 网格；列表结构保持不变，作为默认视图
                  kbViewMode === 'grid' ? (
                    <div className="kb-grid-list" onWheel={handleNestedListWheel}>
                      {groupedList.map(([directory, items]) => (
                        <section className="kb-directory-group" key={directory} aria-label={directory}>
                          <div className="kb-directory-group-title"><FolderTree size={13} />{directory}<span>{items.length}</span></div>
                          <div className="kb-directory-group-grid">{items.map((kb) => <KbGridCard key={kb.id} item={kb} onOpen={handleOpenDetail} />)}</div>
                        </section>
                      ))}
                    </div>
                  ) : (
                    <div className="kb-nav-list" onWheel={handleNestedListWheel}>
                      {groupedList.map(([directory, items]) => (
                        <section className="kb-directory-group" key={directory} aria-label={directory}>
                          <div className="kb-directory-group-title"><FolderTree size={13} />{directory}<span>{items.length}</span></div>
                          {items.map((kb) => <button key={kb.id} className="kb-nav-item" onClick={() => handleOpenDetail(kb.id)} type="button">
                            <span className="kb-nav-icon"><BookOpen size={16} strokeWidth={1.8} /></span>
                            <span className="kb-nav-text"><strong>{kb.name}</strong><small>{kb.description || '暂无知识库说明'}</small><em>{knowledgeBaseSourceLabel(kb)} · {knowledgeScopeLabel(kb)}</em></span>
                            <span className="kb-nav-count">{kb.docCount} 文档</span><span className="kb-nav-action"><ArrowRight size={14} strokeWidth={1.8} /></span>
                          </button>)}
                        </section>
                      ))}
                    </div>
                  )
                ) : (
                  <div className="kb-empty-state">
                    <BookOpen size={22} strokeWidth={1.7} />
                    <strong>{categorizedList.length > 0 ? '没有匹配结果' : '暂无知识库'}</strong>
                    <span>{categorizedList.length > 0
                      ? '换个关键词试试。'
                      : knowledgeListEmptyText(knowledgeCategory, { index: sourceSummary?.enterprise ?? null, connected: enterpriseConnection.state === 'connected' })}</span>
                  </div>
                ))}

                {isLocalDocumentsPage && !localPreviewFile && (
                <section className="kb-local-scan-panel" aria-label="本地文件扫描结果">
                  <div className="kb-panel-title">
                    <div>
                      <h3>本地文件扫描结果</h3>
                      <p>
                        {localScanCachedAt
                          ? `上次扫描：${formatLocalScanTime(localScanCachedAt)}`
                          : isLocalScanAuthorized
                            ? `已记录 ${localScanDirectories.length} 个扫描目录，访问权限可在设置中管理。`
                            : '默认不扫描本地文件，选择扫描目录并确认后才会读取。'}
                      </p>
                    </div>
                    <div className="kb-local-scan-toolbar">
                      <button
                        type="button"
                        className="kb-local-scan-auth"
                        onClick={handleAuthorizeLocalScan}
                        disabled={isLocalScanning}
                        title={localScanDirectories.length ? `已记录目录：\n${localScanDirectories.join('\n')}` : '选择目录并扫描'}
                      >
                        <ScanSearch size={15} strokeWidth={1.8} />
                        扫描
                      </button>
                    </div>
                  </div>

                  {localScanDirectories.length > 0 && (
                    <div className="kb-local-scan-dirs" aria-label="历史扫描目录">
                      <span>扫描目录</span>
                      <div>
                        {localScanDirectories.map((directory) => (
                          <span className="kb-local-scan-dir" key={directory}>
                            <code title={directory}>{directory}</code>
                            <button
                              type="button"
                              onClick={() => handleRequestDeleteDirectory(directory)}
                              aria-label={`删除扫描目录 ${directory}`}
                              title="删除扫描目录"
                            >
                              <Trash2 size={12} strokeWidth={1.9} />
                            </button>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  <FeedbackMessage feedback={localScanFeedback} className="kb-local-scan-feedback" />

                  {isLocalScanning && (
                    <div className="kb-local-scan-progress" role="status" aria-live="polite">
                      <div className="kb-local-scan-progress-head">
                        <span><LoaderCircle size={13} className="kb-local-scan-spinner" aria-hidden="true" />后台扫描进行中</span>
                        <strong>{localScanProgress.completed} / {localScanProgress.total} 个目录</strong>
                      </div>
                      <div className="kb-local-scan-progress-track" aria-hidden="true">
                        <span style={{ width: `${localScanProgress.total ? Math.round((localScanProgress.completed / localScanProgress.total) * 100) : 8}%` }} />
                      </div>
                      <small>已发现 {localScanProgress.filesFound} 个文件，你仍可继续浏览知识库。</small>
                    </div>
                  )}

                  {activeDirectoryFiles.length > 0 ? (
                    selectedLocalScanCategory ? (
                      <div className="kb-local-split">
                        <nav className="kb-local-split-nav" aria-label="文档分类">
                          {localScanCategories.map((category) => (
                            <button
                              key={category.key}
                              type="button"
                              className={`kb-local-split-item ${category.key === localScanActiveCategory ? 'active' : ''}`}
                              aria-current={category.key === localScanActiveCategory ? 'true' : undefined}
                              onClick={() => handleOpenLocalCategory(category.key)}
                            >
                              <span className="kb-local-category-icon">
                                <LocalCategoryIcon category={category.key} />
                              </span>
                              <span className="kb-local-split-item-text">
                                <strong>{category.label}</strong>
                                <small>{category.files.length} 个文件</small>
                              </span>
                            </button>
                          ))}
                        </nav>

                        <section className="kb-local-split-list" aria-label={`${selectedLocalScanCategory.label}文件列表`}>
                          <div className="kb-local-category-results-head">
                            <div>
                              <strong>{selectedLocalScanCategory.label}（{filteredLocalScanResults.length}）</strong>
                              <span>{selectedLocalScanCategory.description}</span>
                            </div>
                          </div>

                          <div className="kb-doc-list kb-local-scan-list" onWheel={handleNestedListWheel}>
                            {pagedLocalScanResults.map((file) => (
                              <div
                                key={file.path}
                                className="kb-doc-row kb-local-scan-row previewable"
                                onClick={() => handleOpenLocalPreview(file)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault()
                                    handleOpenLocalPreview(file)
                                  }
                                }}
                                role="button"
                                tabIndex={0}
                                title="点击预览文件"
                              >
                                <span className="kb-status">{getScannedFileTypeLabel(getScannedFileType(file.name))}</span>
                                {!isLocalSearchableFile(file.name) && (
                                  <span
                                    className="kb-status"
                                    title="该格式暂不支持员工对话检索（仅支持纯文本 Markdown/CSV 等），只能上传到云端知识库"
                                  >
                                    仅上传
                                  </span>
                                )}
                                <div className="kb-scan-file-info">
                                  <strong>{file.name}</strong>
                                  <span title={file.path}>{file.path}</span>
                                </div>
                                <span className="kb-scan-file-size">{formatPreviewSize(file.size)}</span>
                              </div>
                            ))}
                          </div>

                          <div className="kb-scan-pagination kb-local-scan-pagination">
                            <span>
                              第 {normalizedLocalScanPage} / {localScanPageCount} 页 · 共 {filteredLocalScanResults.length} 个
                            </span>
                            <div>
                              <button
                                type="button"
                                onClick={() => setLocalScanPage((page) => Math.max(1, page - 1))}
                                disabled={normalizedLocalScanPage <= 1}
                                aria-label="上一页"
                              >
                                <ChevronLeft size={14} strokeWidth={1.8} />
                              </button>
                              <button
                                type="button"
                                onClick={() => setLocalScanPage((page) => Math.min(localScanPageCount, page + 1))}
                                disabled={normalizedLocalScanPage >= localScanPageCount}
                                aria-label="下一页"
                              >
                                <ChevronRight size={14} strokeWidth={1.8} />
                              </button>
                            </div>
                          </div>
                        </section>
                      </div>
                    ) : (
                      <>
                        <div className="kb-local-category-grid" aria-label="文档自动分类">
                          {localScanCategories.map((category) => (
                            <button
                              key={category.key}
                              type="button"
                              className={`kb-local-category-card ${category.key === localScanActiveCategory ? 'active' : ''}`}
                              onClick={() => handleOpenLocalCategory(category.key)}
                            >
                              <span className="kb-local-category-head">
                                <span className="kb-local-category-icon">
                                  <LocalCategoryIcon category={category.key} />
                                </span>
                                <span>
                                  <strong>{category.label}</strong>
                                  <small>{category.files.length} 个文件</small>
                                </span>
                                <ChevronRight size={16} strokeWidth={1.8} />
                              </span>
                              <span className="kb-local-category-description">{category.description}</span>
                              <span className="kb-local-category-preview">
                                {category.files.slice(0, 3).map((file) => (
                                  <span key={file.path}>
                                    <em>{getScannedFileTypeLabel(getScannedFileType(file.name))}</em>
                                    <i title={file.name}>{file.name}</i>
                                    <span className="kb-local-file-tooltip" role="tooltip">
                                      <span><strong>文件名：</strong>{file.name}</span>
                                      <span><strong>文件大小：</strong>{formatPreviewSize(file.size)}</span>
                                      <span><strong>修改时间：</strong>{formatLocalFileModifiedAt(file.modified_at)}</span>
                                      <span><strong>本地路径：</strong>{getLocalFileDirectory(file.path)}</span>
                                    </span>
                                  </span>
                                ))}
                              </span>
                            </button>
                          ))}
                        </div>
                        <p className="kb-local-category-hint">选择一个分类，查看该分类下的全部文件。</p>
                      </>
                    )
                  ) : (
                    <div className="kb-empty-state">
                      <FolderSearch size={22} strokeWidth={1.7} />
                      <strong>暂无扫描结果</strong>
                      <span>{isLocalScanAuthorized ? '点击“扫描”选择目录并确认后即可更新扫描结果。' : '请点击“扫描”选择目录并确认扫描。'}</span>
                    </div>
                  )}
                </section>
                )}
                {isLocalDocumentsPage && localPreviewFile && (
                <section className="kb-local-preview-page" aria-labelledby="kb-local-preview-title">
                  <div className="kb-local-preview-header">
                    <div className="kb-local-preview-title">
                      <div className="kb-local-preview-file-kind">
                        <FileText size={14} strokeWidth={1.8} />
                        <span>{getScannedFileTypeLabel(getScannedFileType(localPreviewFile.name))}</span>
                        <span>{formatPreviewSize(localPreviewFile.size)}</span>
                      </div>
                      <h2 id="kb-local-preview-title" title={localPreviewFile.name}>{localPreviewFile.name}</h2>
                    </div>

                    <div className="kb-local-preview-meta">
                      <button
                        type="button"
                        className="kb-scan-preview-path"
                        onClick={() => void handleRevealLocalPreview()}
                        title={`在访达中显示\n${localPreviewFile.path}`}
                      >
                        <FolderSearch size={13} strokeWidth={1.8} />
                        <span>{localPreviewFile.path}</span>
                      </button>

                      <div className="kb-local-preview-actions">
                        <label className="kb-local-preview-kb">
                          <span>隶属知识库</span>
                          <select
                            value={localPreviewTargetKb?.id ?? ''}
                            onChange={(e) => setLocalPreviewKbId(e.target.value)}
                            disabled={isKnowledgeWriteDisabled || list.length === 0 || isLocalPreviewActionLocked}
                            title={isKnowledgeWriteDisabled ? knowledgeWriteReason : undefined}
                          >
                            {list.length > 0 ? (
                              list.map((kb) => (
                                <option key={kb.id} value={kb.id}>{knowledgeBaseSourceLabel(kb)} · {kb.name}</option>
                              ))
                            ) : (
                              <option value="">暂无知识库</option>
                            )}
                          </select>
                        </label>
  
                        <button
                          type="button"
                          className="kb-panel-action primary kb-local-preview-upload"
                          onClick={handleUploadLocalPreviewFile}
                          aria-describedby="kb-local-preview-write-disabled-reason"
                          disabled={isKnowledgeWriteDisabled || isLocalPreviewUploading || !localPreviewTargetKb?.id || isLocalPreviewUploadedToTarget}
                          title={isKnowledgeWriteDisabled ? knowledgeWriteReason : undefined}
                        >
                          <UploadCloud size={13} strokeWidth={1.8} />
                          {isLocalPreviewUploading
                            ? (isLocalPreviewUploaded ? '已上传' : '上传中')
                            : isLocalPreviewUploadedToTarget
                              ? '已上传'
                              : '上传'}
                        </button>
                      </div>
                    </div>
                  </div>

                  {(isKnowledgeWriteDisabled || localPreviewMatchedKbs.length > 0) && (
                    <div className="kb-local-preview-subbar">
                      {isKnowledgeWriteDisabled && (
                        <p id="kb-local-preview-write-disabled-reason" className="kb-inline-service-notice">
                          {knowledgeWriteReason}
                        </p>
                      )}

                      {localPreviewMatchedKbs.length > 0 && (
                        <div className="kb-local-preview-belongs">
                          已存在于：{localPreviewMatchedKbs.map((kb) => kb.name).join('、')}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="kb-local-preview-body">
                    <LocalFileWebview file={localPreviewFile} />
                  </div>

                  <FeedbackMessage feedback={localPreviewFeedback} className="kb-modal-toast" />
                </section>
                )}
              </aside>
            </section>

          </div>
        )}
      </main>

      {isCreateDialogOpen && (
        <div className="kb-modal-backdrop kb-create-modal-backdrop" onClick={handleCloseCreateDialog}>
          <section
            ref={createDialogRef}
            className="kb-modal kb-create-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="kb-create-title"
            aria-describedby="kb-create-description"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="kb-modal-header">
              <div>
                <h2 id="kb-create-title">新建个人知识库</h2>
                <p id="kb-create-description">知识库会建在下面这个个人知识库服务上，仅本人可见，可以授权给你的 AI 员工。企业资料请由管理员放到企业知识库。</p>
              </div>
              <button
                type="button"
                onClick={handleCloseCreateDialog}
                aria-label="关闭新建个人知识库弹层"
                aria-keyshortcuts="Meta+W Control+W"
                title="关闭新建个人知识库（⌘W / Ctrl+W）"
                disabled={isCreating}
              >
                <X size={14} strokeWidth={2} />
              </button>
            </div>

            <form className="kb-form-grid compact kb-create-modal-form" onSubmit={handleCreateSubmit}>
              <div className="kb-create-target">
                <HardDrive size={14} strokeWidth={1.8} />
                <span>创建到</span>
                <strong title={createNasView?.name || createNasView?.address}>{createNasView?.name || createNasView?.address}</strong>
                {createNasView?.name && <code title={createNasView.address}>{createNasView.address}</code>}
              </div>
              <label className="kb-field">
                <span>名称</span>
                <input value={newKbName} onChange={(e) => setNewKbName(e.target.value)} placeholder="必填" autoFocus data-dialog-initial-focus required disabled={isCreating} />
              </label>
              <label className="kb-field">
                <span>说明</span>
                <input value={newKbDescription} onChange={(e) => setNewKbDescription(e.target.value)} placeholder="选填" disabled={isCreating} />
              </label>
              <label className="kb-field">
                <span>目录名</span>
                <input value={newKbDirectory} onChange={(e) => setNewKbDirectory(e.target.value)} placeholder="例如：产品资料" maxLength={80} disabled={isCreating} />
              </label>
              <p className="kb-inline-service-notice">可见范围：仅本人。个人知识库服务只能新建私人知识库。</p>
              <div className="kb-form-actions kb-create-modal-actions">
                <button type="button" className="secondary" onClick={handleCloseCreateDialog} disabled={isCreating}>
                  取消
                </button>
                <button type="submit" disabled={isCreating || !newKbName.trim() || !createNasView}>
                  <Plus size={14} strokeWidth={1.8} />
                  {isCreating ? '创建中' : '创建'}
                </button>
              </div>
            </form>
            <FeedbackMessage feedback={createFeedback} className="kb-modal-toast" />
          </section>
        </div>
      )}

      {connectTarget && (
        <div className="kb-modal-backdrop kb-create-modal-backdrop" onClick={handleCloseConnect}>
          <section ref={sourceConfigDialogRef} className="kb-modal kb-create-modal kb-source-config-modal" role="dialog" aria-modal="true" aria-labelledby="kb-source-config-title" aria-describedby="kb-source-config-description" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
            <div className="kb-modal-header">
              <div>
                <h2 id="kb-source-config-title">{connectTarget.source === 'enterprise' ? '连接企业知识库' : connectTarget.nasId ? '修改个人知识库服务连接' : '添加个人知识库服务'}</h2>
                <p id="kb-source-config-description">
                  {connectTarget.source === 'enterprise'
                    ? '企业知识库由管理员在管理后台配置，部署在 Manager 或企业内网 NAS 时都无需你填写 NAS 地址。在这里连接 Manager 后，可以在列表中浏览企业文档；上传文档和员工授权需要 owner / enterprise_admin 角色。'
                    : connectTarget.nasId
                      ? '修改这个服务的名称、地址或令牌，其他服务不受影响。断开只移除本机的连接，不会删除服务上的知识库。'
                      : '个人知识库服务是你自己的 NAS 或自建服务，仅本人可见，可以连接多个。连接后，服务上已有的知识库会出现在列表中，也可在它那一行点「新建知识库」。'}
                  保存前会先验证能否连接，连不上不会保存。地址仅允许 HTTPS 或本机回环 HTTP。
                </p>
              </div>
              <button type="button" onClick={handleCloseConnect} aria-label="关闭连接弹层" disabled={isConnecting}><X size={14} strokeWidth={2} /></button>
            </div>
            <form className="kb-source-config-body" onSubmit={handleSubmitConnect}>
              <KnowledgeSourceFields source={connectTarget.source} draft={connectDraft} disabled={isConnecting} onChange={setConnectDraft} />
              {connectError && <p className="kb-source-config-error" role="alert">{connectError}</p>}
              <div className="kb-form-actions kb-create-modal-actions">
                {(connectTarget.source === 'enterprise' ? sourceConfig.enterpriseUrl.trim() : connectTarget.nasId) && (
                  <button type="button" className="danger kb-action-start" onClick={() => void handleDisconnectSource()} disabled={isConnecting}>
                    断开连接
                  </button>
                )}
                <button type="button" className="secondary" onClick={handleCloseConnect} disabled={isConnecting}>取消</button>
                <button type="submit" disabled={isConnecting || !connectDraft.url.trim()}>
                  {isConnecting ? <LoaderCircle size={14} strokeWidth={1.8} className="spinning" /> : <Check size={14} />}
                  {isConnecting ? '连接中' : connectTarget.source === 'local' && !connectTarget.nasId ? '连接并添加' : '保存并连接'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {pendingScanPlan && (
        <div className="kb-modal-backdrop kb-create-modal-backdrop" onClick={handleCloseConfirmScanDialog}>
          <section
            ref={confirmScanDialogRef}
            className="kb-modal kb-create-modal kb-confirm-scan-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="kb-confirm-scan-title"
            aria-describedby="kb-confirm-scan-description"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="kb-modal-header">
              <div>
                <h2 id="kb-confirm-scan-title">
                  {pendingScanPlan.mode === 'rescan' ? '确认重新扫描本地目录？' : '确认扫描本地目录？'}
                </h2>
                <p id="kb-confirm-scan-description">
                  {pendingScanPlan.mode === 'rescan'
                    ? '所选目录已有扫描记录。确认后将重新扫描并更新以下目录中的 DOCX、Markdown、PDF、CSV、PPT 文件，不会重复扫描其他未选目录。员工对话检索仅支持纯文本（Markdown/CSV 等），DOCX/PDF/PPT 仅支持上传。'
                    : '确认后将授权并扫描以下目录中的 DOCX、Markdown、PDF、CSV、PPT 文件，仅扫描本次待扫描目录，不会修改或自动上传原始文件。员工对话检索仅支持纯文本（Markdown/CSV 等），DOCX/PDF/PPT 仅支持上传。'}
                </p>
              </div>
              <button
                type="button"
                onClick={handleCloseConfirmScanDialog}
                aria-label="关闭确认扫描弹窗"
                disabled={isLocalScanning}
              >
                <X size={14} strokeWidth={2} />
              </button>
            </div>
            <div className="kb-confirm-scan-dirs" aria-label="本次待扫描目录">
              <span className="kb-confirm-scan-label">
                待扫描目录（{pendingScanPlan.directoriesToScan.length}）
              </span>
              <div className="kb-confirm-scan-list">
                {pendingScanPlan.directoriesToScan.map((directory) => (
                  <div className="kb-delete-directory-path kb-confirm-scan-path" key={directory} title={directory}>
                    {directory}
                  </div>
                ))}
              </div>
              {pendingScanPlan.skippedDirectories.length > 0 && (
                <p className="kb-confirm-scan-skip-note" role="note">
                  已自动跳过 {pendingScanPlan.skippedDirectories.length} 个已扫描或已包含的目录，避免重复扫描。
                </p>
              )}
            </div>
            <div className="kb-form-actions kb-create-modal-actions">
              <button type="button" className="secondary" onClick={handleCloseConfirmScanDialog} disabled={isLocalScanning}>
                取消
              </button>
              <button type="button" onClick={() => void handleConfirmLocalScan()} disabled={isLocalScanning}>
                <FolderSearch size={14} strokeWidth={1.8} />
                {isLocalScanning ? '扫描中' : '确认扫描'}
              </button>
            </div>
          </section>
        </div>
      )}

      {directoryPendingDeletion && (
        <div className="kb-modal-backdrop kb-create-modal-backdrop" onClick={handleCloseDeleteDirectoryDialog}>
          <section
            ref={deleteDirectoryDialogRef}
            className="kb-modal kb-create-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="kb-delete-directory-title"
            aria-describedby="kb-delete-directory-description"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="kb-modal-header">
              <div>
                <h2 id="kb-delete-directory-title">删除扫描目录？</h2>
                <p id="kb-delete-directory-description">
                  删除后将同时清除该目录下的全部扫描结果，此操作不会删除电脑中的原始文件。
                </p>
              </div>
              <button
                type="button"
                onClick={handleCloseDeleteDirectoryDialog}
                aria-label="关闭删除确认弹窗"
                disabled={isDeletingDirectory}
              >
                <X size={14} strokeWidth={2} />
              </button>
            </div>
            <div className="kb-delete-directory-path" title={directoryPendingDeletion}>
              {directoryPendingDeletion}
            </div>
            <div className="kb-form-actions kb-create-modal-actions">
              <button type="button" className="secondary" onClick={handleCloseDeleteDirectoryDialog} disabled={isDeletingDirectory}>
                取消
              </button>
              <button type="button" className="danger" onClick={handleConfirmDeleteDirectory} disabled={isDeletingDirectory}>
                <Trash2 size={14} strokeWidth={1.9} />
                {isDeletingDirectory ? '删除中' : '确认删除'}
              </button>
            </div>
          </section>
        </div>
      )}

    </div>
  )
}

function StatIcon({ tone }: { tone: StatItem['tone'] }) {
  if (tone === 'blue') return <Database size={17} strokeWidth={1.8} />
  if (tone === 'green') return <FileText size={17} strokeWidth={1.8} />
  if (tone === 'purple') return <Layers3 size={17} strokeWidth={1.8} />
  return <Activity size={17} strokeWidth={1.8} />
}

function LocalCategoryIcon({ category }: { category: LocalFileCategory['key'] }) {
  if (category === 'data') return <Database size={17} strokeWidth={1.8} />
  if (category === 'presentation' || category === 'solution') return <Layers3 size={17} strokeWidth={1.8} />
  if (category === 'document' || category === 'book' || category === 'courseware') {
    return <BookOpen size={17} strokeWidth={1.8} />
  }
  if (category === 'contract' || category === 'certificate') {
    return <ShieldCheck size={17} strokeWidth={1.8} />
  }
  if (category === 'form' || category === 'meeting' || category === 'summary') {
    return <FileText size={17} strokeWidth={1.8} />
  }
  if (category === 'receipt' || category === 'paper') {
    return <Layers3 size={17} strokeWidth={1.8} />
  }
  if (category === 'other') return <FolderSearch size={17} strokeWidth={1.8} />
  return <FileText size={17} strokeWidth={1.8} />
}

function getLocalFileCategory(fileName: string): LocalFileCategory['key'] {
  const normalizedName = fileName.toLowerCase()
  const type = getScannedFileType(fileName)

  if (matchesFileNameKeyword(normalizedName, [
    '合同', '协议', '契约', '条款', 'contract', 'agreement',
  ])) return 'contract'
  if (matchesFileNameKeyword(normalizedName, [
    '发票', '收据', '账单', '报销单', '凭证', '票据', 'invoice', 'receipt', 'bill',
  ])) return 'receipt'
  if (matchesFileNameKeyword(normalizedName, [
    '会议', '纪要', '议程', '会务', 'meeting', 'minutes', 'agenda',
  ])) return 'meeting'
  if (matchesFileNameKeyword(normalizedName, [
    '证明', '证书', '证件', '资质', '授权书', 'certificate', 'license', 'credential',
  ])) return 'certificate'
  if (matchesFileNameKeyword(normalizedName, [
    '论文', '期刊', '学位论文', '毕业论文', '文献', 'paper', 'thesis', 'dissertation', 'journal',
  ])) return 'paper'
  if (matchesFileNameKeyword(normalizedName, [
    '书籍', '图书', '电子书', '教材', '章节', 'ebook', 'textbook',
  ])) return 'book'
  if (matchesFileNameKeyword(normalizedName, [
    '课件', '课程', '教案', '讲义', '培训', 'lesson', 'courseware', 'course', 'training',
  ])) return 'courseware'
  if (matchesFileNameKeyword(normalizedName, [
    '表单', '申请表', '登记表', '报名表', '问卷', '清单', 'form', 'questionnaire', 'checklist',
  ])) return 'form'
  if (matchesFileNameKeyword(normalizedName, [
    '总结', '复盘', '周报', '月报', '季报', '年报', 'summary', 'review',
  ])) return 'summary'
  if (matchesFileNameKeyword(normalizedName, [
    '解决方案', '设计方案', '实施方案', '建设方案', '业务方案', '技术方案', '方案',
    'proposal', 'solution',
  ])) return 'solution'
  if (matchesFileNameKeyword(normalizedName, [
    '数据', '统计', '指标', '台账', '明细', 'dataset', 'data', 'history', 'statistics', 'metric',
  ])) return 'data'
  if (matchesFileNameKeyword(normalizedName, [
    '报告', '调研', '研究', '分析', '白皮书', 'report', 'research', 'analysis', 'brief',
  ])) return 'report'
  if (matchesFileNameKeyword(normalizedName, [
    '演示', '汇报', '路演', '宣讲', 'presentation', 'slides', 'pitch', 'deck',
  ])) return 'presentation'
  if (matchesFileNameKeyword(normalizedName, [
    '说明', '手册', '指南', '规范', '记录', '文档', 'manual', 'guide', 'readme', 'notes',
  ])) return 'document'

  if (type === 'csv') return 'data'
  if (type === 'pdf') return 'report'
  if (type === 'ppt' || type === 'pptx') return 'presentation'
  if (type === 'docx' || type === 'md') return 'document'
  return 'other'
}

function matchesFileNameKeyword(fileName: string, keywords: string[]) {
  return keywords.some((keyword) => fileName.includes(keyword))
}

function formatLocalFileModifiedAt(modifiedAt?: number) {
  if (!modifiedAt) return '暂无'
  const date = new Date(modifiedAt)
  if (Number.isNaN(date.getTime())) return '暂无'
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function getLocalFileDirectory(path: string) {
  const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return separatorIndex > 0 ? path.slice(0, separatorIndex) : path
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

function getLegacyLocalScanDirectoryCaches(files: ScannedKnowledgeFile[], scannedAt: string): LocalScanDirectoryCache[] {
  if (files.length === 0) return []
  return [{
    directory: LEGACY_LOCAL_SCAN_DIRECTORY,
    files,
    scannedAt,
  }]
}
