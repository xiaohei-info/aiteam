import type { KbFile, KnowledgeBase, LocalScanAuthorization, LocalScanCache, LocalScanDirectoryCache, LocalUploadedKnowledgeRecord, ScannedKnowledgeFile } from './types.ts'
import { getErrorMessage, isHiddenLocalKnowledgePath, isSameScannedDoc, isSupportedLocalKnowledgeFileName } from './utils.ts'

const LOCAL_SCAN_CACHE_KEY = 'aifred:knowledge-local-scan-cache:v1'
const LOCAL_SCAN_AUTH_KEY = 'aifred:knowledge-local-scan-authorized:v1'
const LOCAL_UPLOADED_CACHE_KEY = 'aifred:knowledge-local-uploaded:v1'
const LOCAL_SCAN_STORE_FILE = 'knowledge-local-scan.json'
const LEGACY_LOCAL_SCAN_DIRECTORY = '历史缓存'

export interface LocalScanConfirmationPlan {
  source: 'select' | 'manual'
  mode: 'new' | 'rescan'
  selectedDirectories: string[]
  directoriesToScan: string[]
  skippedDirectories: string[]
  nextAuthorizedDirectories: string[]
}

export interface LocalDirectoryScanBatchResult {
  updates: Array<{ directory: string; files: ScannedKnowledgeFile[] }>
  failed: Array<{ directory: string; error: string; permissionDenied: boolean }>
  scannedFilesCount: number
}

export function normalizeLocalScanDirectoryPath(rawPath: string) {
  const trimmed = rawPath.trim()
  if (!trimmed) return ''
  if (trimmed === '/' || trimmed === '\\' || /^[a-zA-Z]:[\\/]$/.test(trimmed)) {
    return trimmed
  }
  return trimmed.replace(/[\\/]+$/, '')
}

export function isSameOrSubdirectory(candidate: string, parent: string) {
  const normalizedCandidate = normalizeLocalScanDirectoryPath(candidate)
  const normalizedParent = normalizeLocalScanDirectoryPath(parent)
  if (!normalizedCandidate || !normalizedParent) return false
  if (normalizedCandidate === normalizedParent) return true
  if (normalizedParent === '/') {
    return normalizedCandidate.startsWith('/')
  }
  if (/^[a-zA-Z]:[\\/]$/.test(normalizedParent)) {
    return (
      normalizedCandidate.slice(0, 2).toLowerCase() === normalizedParent.slice(0, 2).toLowerCase()
      && (normalizedCandidate[2] === '/' || normalizedCandidate[2] === '\\')
    )
  }
  return (
    normalizedCandidate.startsWith(`${normalizedParent}/`)
    || normalizedCandidate.startsWith(`${normalizedParent}\\`)
  )
}

export function collapseOverlappingDirectories(directories: unknown[]) {
  const normalized = normalizeLocalScanDirectories(directories)
  return normalized.filter(
    (dir) => !normalized.some((other) => other !== dir && isSameOrSubdirectory(dir, other)),
  )
}

function isDirectoryCoveredByCache(directory: string, directoryCaches: LocalScanDirectoryCache[]) {
  const normalizedDir = normalizeLocalScanDirectoryPath(directory)
  if (!normalizedDir) return false
  return directoryCaches.some(
    (cache) =>
      cache.directory
      && cache.directory !== LEGACY_LOCAL_SCAN_DIRECTORY
      && Boolean(cache.scannedAt)
      && isSameOrSubdirectory(normalizedDir, cache.directory),
  )
}

function isDirectoryCoveredByList(directory: string, list: Iterable<string>) {
  const normalizedDir = normalizeLocalScanDirectoryPath(directory)
  if (!normalizedDir) return false
  for (const item of list) {
    if (isSameOrSubdirectory(normalizedDir, item)) {
      return true
    }
  }
  return false
}

export function planLocalScanAfterDirectorySelect(params: {
  selectedDirectories: string[]
  authorizedDirectories: string[]
  directoryCaches: LocalScanDirectoryCache[]
}): LocalScanConfirmationPlan | null {
  const normalizedSelected = normalizeLocalScanDirectories(params.selectedDirectories)
  if (normalizedSelected.length === 0) return null

  const collapsedSelected = collapseOverlappingDirectories(normalizedSelected)
  const collapsedDuplicates = normalizedSelected.filter((dir) => !collapsedSelected.includes(dir))

  const unscannedSelected = collapsedSelected.filter(
    (dir) => !isDirectoryCoveredByCache(dir, params.directoryCaches),
  )
  const alreadyScannedSelected = collapsedSelected.filter(
    (dir) => isDirectoryCoveredByCache(dir, params.directoryCaches),
  )

  const nextAuthorizedDirectories = collapseOverlappingDirectories([
    ...params.authorizedDirectories,
    ...collapsedSelected,
  ])

  if (unscannedSelected.length > 0) {
    return {
      source: 'select',
      mode: 'new',
      selectedDirectories: normalizedSelected,
      directoriesToScan: unscannedSelected,
      skippedDirectories: normalizeLocalScanDirectories([
        ...collapsedDuplicates,
        ...alreadyScannedSelected,
      ]),
      nextAuthorizedDirectories,
    }
  }

  return {
    source: 'select',
    mode: 'rescan',
    selectedDirectories: normalizedSelected,
    directoriesToScan: collapsedSelected,
    skippedDirectories: normalizeLocalScanDirectories(collapsedDuplicates),
    nextAuthorizedDirectories,
  }
}

export function planManualLocalScan(params: {
  authorizedDirectories: string[]
  directoryCaches: LocalScanDirectoryCache[]
  sessionAuthorizedDirectories?: Iterable<string>
}): LocalScanConfirmationPlan | null {
  const normalizedAuthorized = normalizeLocalScanDirectories(params.authorizedDirectories)
  if (normalizedAuthorized.length === 0) return null

  const collapsedAuthorized = collapseOverlappingDirectories(normalizedAuthorized)
  const collapsedDuplicates = normalizedAuthorized.filter((dir) => !collapsedAuthorized.includes(dir))

  const unscanned = collapsedAuthorized.filter(
    (dir) => !isDirectoryCoveredByCache(dir, params.directoryCaches),
  )
  const alreadyScanned = collapsedAuthorized.filter(
    (dir) => isDirectoryCoveredByCache(dir, params.directoryCaches),
  )

  if (unscanned.length > 0) {
    return {
      source: 'manual',
      mode: 'new',
      selectedDirectories: unscanned,
      directoriesToScan: unscanned,
      skippedDirectories: normalizeLocalScanDirectories([
        ...collapsedDuplicates,
        ...alreadyScanned,
      ]),
      nextAuthorizedDirectories: collapsedAuthorized,
    }
  }

  const sessionDirs = params.sessionAuthorizedDirectories
    ? normalizeLocalScanDirectories([...params.sessionAuthorizedDirectories])
    : []
  const sessionCovered = sessionDirs.length > 0
    ? collapsedAuthorized.filter((dir) => isDirectoryCoveredByList(dir, sessionDirs))
    : []
  const directoriesToScan = sessionCovered.length > 0 ? sessionCovered : collapsedAuthorized
  const inactivePreviousDirs = sessionCovered.length > 0
    ? collapsedAuthorized.filter((dir) => !sessionCovered.includes(dir))
    : []

  return {
    source: 'manual',
    mode: 'rescan',
    selectedDirectories: directoriesToScan,
    directoriesToScan,
    skippedDirectories: normalizeLocalScanDirectories([
      ...collapsedDuplicates,
      ...inactivePreviousDirs,
    ]),
    nextAuthorizedDirectories: collapsedAuthorized,
  }
}

export function isLocalScanPermissionError(message: string) {
  return /File access denied|Select the file or directory in the system picker first|目录访问权限已失效/i.test(message)
}

export async function runLocalDirectoryScanBatch(
  directories: string[],
  scanDirectory: (directory: string, index: number, total: number) => Promise<ScannedKnowledgeFile[]>,
  onProgress?: (progress: { completed: number; total: number; filesFound: number; directory: string }) => void,
): Promise<LocalDirectoryScanBatchResult> {
  const targetDirectories = collapseOverlappingDirectories(directories)
  const updates: Array<{ directory: string; files: ScannedKnowledgeFile[] }> = []
  const failed: Array<{ directory: string; error: string; permissionDenied: boolean }> = []
  let scannedFilesCount = 0

  for (const [index, directory] of targetDirectories.entries()) {
    try {
      const rawFiles = await scanDirectory(directory, index, targetDirectories.length)
      const files = dedupeScannedFiles(rawFiles, directory)
      updates.push({ directory, files })
      scannedFilesCount += files.length
    } catch (err) {
      const error = getErrorMessage(err, '本地扫描失败')
      failed.push({
        directory,
        error,
        permissionDenied: isLocalScanPermissionError(error),
      })
    }
    onProgress?.({
      completed: index + 1,
      total: targetDirectories.length,
      filesFound: scannedFilesCount,
      directory,
    })
  }

  return {
    updates,
    failed,
    scannedFilesCount,
  }
}

export async function selectLocalScanDirectories() {
  const { selectFileAccessDirectories } = await import('../../lib/fileAccess')
  const selection = await selectFileAccessDirectories()
  return normalizeLocalScanDirectories(selection.directories)
}

export async function readLocalScanAuthorization(): Promise<LocalScanAuthorization | null> {
  const store = await loadLocalScanStore()
  if (store) {
    try {
      const stored = normalizeLocalScanAuthorization(await store.get<unknown>(LOCAL_SCAN_AUTH_KEY))
      if (stored) return stored
    } catch {
      // fall through to localStorage fallback
    }
  }

  const raw = readLocalStorageValue(LOCAL_SCAN_AUTH_KEY)
  if (!raw) return null
  try {
    return normalizeLocalScanAuthorization(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

export async function writeLocalScanAuthorization(directories: string[]) {
  const authorization: LocalScanAuthorization = {
    directories: normalizeLocalScanDirectories(directories),
    authorizedAt: new Date().toISOString(),
  }

  writeLocalStorageValue(LOCAL_SCAN_AUTH_KEY, JSON.stringify(authorization))

  const store = await loadLocalScanStore()
  if (store) {
    try {
      await store.set(LOCAL_SCAN_AUTH_KEY, authorization)
      await store.save()
    } catch {
      // localStorage fallback already updated
    }
  }

  return authorization
}

export async function readLocalScanCache(): Promise<LocalScanCache | null> {
  const store = await loadLocalScanStore()
  if (store) {
    try {
      const stored = normalizeLocalScanCache(await store.get<Partial<LocalScanCache>>(LOCAL_SCAN_CACHE_KEY))
      if (stored) return stored
    } catch {
      // fall through to localStorage fallback
    }
  }

  const raw = readLocalStorageValue(LOCAL_SCAN_CACHE_KEY)
  if (!raw) return null
  try {
    return normalizeLocalScanCache(JSON.parse(raw) as Partial<LocalScanCache>)
  } catch {
    return null
  }
}

export async function writeLocalScanCache(files: ScannedKnowledgeFile[]) {
  const scannedAt = new Date().toISOString()
  const cache: LocalScanCache = { files: dedupeScannedFiles(files), scannedAt, directories: [] }
  await saveLocalScanCache(cache)
  return scannedAt
}

export async function writeLocalScanDirectoryCaches(
  updates: Array<{ directory: string; files: ScannedKnowledgeFile[] }>,
) {
  const current = await readLocalScanCache()
  const scannedAt = new Date().toISOString()
  const byDirectory = new Map<string, LocalScanDirectoryCache>()

  const currentDirectories = current?.directories?.length
    ? current.directories
    : current?.files.length
      ? [{ directory: LEGACY_LOCAL_SCAN_DIRECTORY, files: current.files, scannedAt: current.scannedAt }]
      : []

  currentDirectories.forEach((item) => {
    const normalizedDir = item.directory === LEGACY_LOCAL_SCAN_DIRECTORY
      ? LEGACY_LOCAL_SCAN_DIRECTORY
      : normalizeLocalScanDirectoryPath(item.directory)
    if (!normalizedDir) return
    byDirectory.set(normalizedDir, {
      ...item,
      directory: normalizedDir,
    })
  })

  updates.forEach((update) => {
    const normalizedDir = normalizeLocalScanDirectoryPath(update.directory)
    if (!normalizedDir) return
    const nextFiles = dedupeScannedFiles(update.files, normalizedDir)

    for (const [existingDir, existingCache] of [...byDirectory.entries()]) {
      if (existingDir === LEGACY_LOCAL_SCAN_DIRECTORY || existingDir === normalizedDir) continue
      if (isSameOrSubdirectory(existingDir, normalizedDir)) {
        // Parent directory scan supersedes child directory cache
        byDirectory.delete(existingDir)
      } else if (isSameOrSubdirectory(normalizedDir, existingDir)) {
        // Refreshing a subdirectory updates matching files inside the cached parent directory
        const remainingParentFiles = existingCache.files.filter(
          (file) => !isSameOrSubdirectory(file.path, normalizedDir),
        )
        byDirectory.set(existingDir, {
          ...existingCache,
          files: dedupeScannedFiles([...remainingParentFiles, ...nextFiles], existingDir),
          scannedAt,
        })
      }
    }

    byDirectory.set(normalizedDir, {
      directory: normalizedDir,
      files: nextFiles,
      scannedAt,
    })
  })

  const directories = [...byDirectory.values()]
    .filter((item) => item.directory)
    .sort((a, b) => a.directory.localeCompare(b.directory, 'zh-Hans-CN'))
  const cache = buildLocalScanCache(directories, scannedAt)
  await saveLocalScanCache(cache)
  return cache
}

export async function removeLocalScanDirectory(directory: string) {
  const normalizedTarget = normalizeLocalScanDirectoryPath(directory)
  const [authorization, currentCache] = await Promise.all([
    readLocalScanAuthorization(),
    readLocalScanCache(),
  ])
  const nextDirectories = (authorization?.directories ?? []).filter(
    (item) => normalizeLocalScanDirectoryPath(item) !== normalizedTarget,
  )
  const nextAuthorization = await writeLocalScanAuthorization(nextDirectories)
  const remainingCaches = (currentCache?.directories ?? []).filter(
    (item) => !isSameOrSubdirectory(item.directory, normalizedTarget),
  )
  const cache = buildLocalScanCache(
    remainingCaches,
    remainingCaches.length > 0 ? new Date().toISOString() : '',
  )
  await saveLocalScanCache(cache)

  return {
    authorization: nextAuthorization,
    cache,
  }
}

async function saveLocalScanCache(cache: LocalScanCache) {
  writeLocalStorageValue(LOCAL_SCAN_CACHE_KEY, JSON.stringify(cache))
  const store = await loadLocalScanStore()
  if (store) {
    try {
      await store.set(LOCAL_SCAN_CACHE_KEY, cache)
      await store.save()
    } catch {
      // localStorage fallback already updated
    }
  }
}

export async function readLocalUploadedRecords(): Promise<LocalUploadedKnowledgeRecord[]> {
  const store = await loadLocalScanStore()
  if (store) {
    try {
      const stored = normalizeLocalUploadedRecords(await store.get<unknown>(LOCAL_UPLOADED_CACHE_KEY))
      if (stored.length > 0) return stored
    } catch {
      // fall through to localStorage fallback
    }
  }

  const raw = readLocalStorageValue(LOCAL_UPLOADED_CACHE_KEY)
  if (!raw) return []
  try {
    return normalizeLocalUploadedRecords(JSON.parse(raw) as unknown)
  } catch {
    return []
  }
}

export async function writeLocalUploadedRecord(file: ScannedKnowledgeFile, kbId: string, uploadedDoc?: KbFile) {
  const records = await readLocalUploadedRecords()
  const fileKey = getLocalUploadedFileKey(file)
  const uploadedAt = new Date().toISOString()
  const existing = records.find((record) => record.fileKey === fileKey)
  const nextRecords = normalizeLocalUploadedRecords([
    ...records.filter((record) => record.fileKey !== fileKey),
    {
      fileKey,
      name: file.name,
      path: file.path,
      size: file.size,
      knowledgeBaseIds: [
        ...new Set([
          ...(existing?.knowledgeBaseIds ?? []),
          kbId,
        ]),
      ],
      uploadedAt,
      documentId: uploadedDoc?.id || existing?.documentId,
      assetId: uploadedDoc?.assetId || existing?.assetId,
    },
  ])

  writeLocalStorageValue(LOCAL_UPLOADED_CACHE_KEY, JSON.stringify(nextRecords))

  const store = await loadLocalScanStore()
  if (store) {
    try {
      await store.set(LOCAL_UPLOADED_CACHE_KEY, nextRecords)
      await store.save()
    } catch {
      // localStorage fallback already updated
    }
  }

  return nextRecords
}

export async function findKnowledgeFileLocalPath(file: KbFile, kbId: string): Promise<string | null> {
  if (file.localPath) return file.localPath

  const [scanCache, uploadedRecords] = await Promise.all([
    readLocalScanCache(),
    readLocalUploadedRecords(),
  ])
  const record = findLocalUploadedRecordForFile(file, kbId, uploadedRecords)
  if (record?.path) return record.path

  const scannedFile = scanCache?.files.find((item) => isSameLocalFile(item, file))
  return scannedFile?.path ?? null
}

export function dedupeScannedFiles(files: ScannedKnowledgeFile[], rootDirectory?: string) {
  const byPath = new Map<string, ScannedKnowledgeFile>()
  files.forEach((file) => {
    if (
      file.path
      && isScannedKnowledgeFile(file)
      && isSupportedLocalKnowledgeFileName(file.name)
      && !isHiddenLocalKnowledgePath(file.path, rootDirectory)
    ) {
      byPath.set(file.path, file)
    }
  })
  return [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

export function getScannedFileKnowledgeBases(
  file: ScannedKnowledgeFile,
  list: KnowledgeBase[],
  uploadedRecords: LocalUploadedKnowledgeRecord[],
) {
  return list.filter((kb) => isScannedFileUploadedToKnowledgeBase(file, kb, uploadedRecords))
}

export function isScannedFileUploadedToKnowledgeBase(
  file: ScannedKnowledgeFile,
  kb: KnowledgeBase,
  uploadedRecords: LocalUploadedKnowledgeRecord[],
) {
  if (isScannedFileInKnowledgeBase(file, kb)) return true
  return uploadedRecords.some((record) => (
    record.fileKey === getLocalUploadedFileKey(file) && record.knowledgeBaseIds.includes(kb.id)
  ))
}

export function formatLocalScanTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function normalizeLocalScanAuthorization(value: unknown): LocalScanAuthorization | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<LocalScanAuthorization>
  if (!Array.isArray(record.directories)) return null

  const directories = normalizeLocalScanDirectories(record.directories)
  if (directories.length === 0) return null

  return {
    directories,
    authorizedAt: typeof record.authorizedAt === 'string' ? record.authorizedAt : '',
  }
}

function normalizeLocalScanDirectories(value: unknown[]) {
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => normalizeLocalScanDirectoryPath(item))
        .filter(Boolean),
    ),
  ]
}

function normalizeLocalScanCache(value: Partial<LocalScanCache> | null | undefined): LocalScanCache | null {
  if (!value || typeof value.scannedAt !== 'string') return null
  const directories = Array.isArray(value.directories)
    ? normalizeLocalScanDirectoryCaches(value.directories)
    : []
  if (directories.length > 0) {
    return buildLocalScanCache(directories, value.scannedAt)
  }

  if (!Array.isArray(value.files)) return null
  return {
    files: dedupeScannedFiles(value.files.filter(isScannedKnowledgeFile)),
    scannedAt: value.scannedAt,
    directories: [],
  }
}

function normalizeLocalScanDirectoryCaches(value: unknown[]): LocalScanDirectoryCache[] {
  return value
    .map((item) => {
      const record = item as Partial<LocalScanDirectoryCache>
      if (typeof record.directory !== 'string' || !Array.isArray(record.files)) return null
      const directory = record.directory === LEGACY_LOCAL_SCAN_DIRECTORY
        ? LEGACY_LOCAL_SCAN_DIRECTORY
        : normalizeLocalScanDirectoryPath(record.directory)
      if (!directory) return null
      const files = dedupeScannedFiles(
        record.files.filter(isScannedKnowledgeFile),
        directory === LEGACY_LOCAL_SCAN_DIRECTORY ? undefined : directory,
      )
      return {
        directory,
        files,
        scannedAt: typeof record.scannedAt === 'string' ? record.scannedAt : '',
      }
    })
    .filter((item): item is LocalScanDirectoryCache => Boolean(item))
}

function buildLocalScanCache(directories: LocalScanDirectoryCache[], fallbackScannedAt: string): LocalScanCache {
  const scannedAt = getLatestScannedAt(directories) || fallbackScannedAt
  const byPath = new Map<string, ScannedKnowledgeFile>()
  directories.forEach((item) => {
    const validFiles = dedupeScannedFiles(
      item.files,
      item.directory === LEGACY_LOCAL_SCAN_DIRECTORY ? undefined : item.directory,
    )
    validFiles.forEach((file) => {
      byPath.set(file.path, file)
    })
  })
  return {
    directories,
    files: [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
    scannedAt,
  }
}

function getLatestScannedAt(directories: LocalScanDirectoryCache[]) {
  return directories.reduce((latest, item) => {
    if (!item.scannedAt) return latest
    if (!latest) return item.scannedAt
    return new Date(item.scannedAt).getTime() > new Date(latest).getTime() ? item.scannedAt : latest
  }, '')
}

function normalizeLocalUploadedRecords(value: unknown): LocalUploadedKnowledgeRecord[] {
  if (!Array.isArray(value)) return []

  const byFileKey = new Map<string, LocalUploadedKnowledgeRecord>()
  value.forEach((item) => {
    const record = item as Partial<LocalUploadedKnowledgeRecord>
    const normalized = normalizeLocalUploadedRecord(record)
    if (!normalized) return

    const existing = byFileKey.get(normalized.fileKey)
    if (!existing) {
      byFileKey.set(normalized.fileKey, normalized)
      return
    }

    byFileKey.set(normalized.fileKey, {
      ...existing,
      knowledgeBaseIds: [...new Set([...existing.knowledgeBaseIds, ...normalized.knowledgeBaseIds])],
      uploadedAt: normalized.uploadedAt || existing.uploadedAt,
      documentId: normalized.documentId || existing.documentId,
      assetId: normalized.assetId || existing.assetId,
    })
  })

  return [...byFileKey.values()]
}

function normalizeLocalUploadedRecord(record: Partial<LocalUploadedKnowledgeRecord>) {
  if (
    typeof record.fileKey !== 'string'
    || typeof record.name !== 'string'
    || typeof record.path !== 'string'
    || typeof record.size !== 'number'
    || !Array.isArray(record.knowledgeBaseIds)
  ) {
    return null
  }

  return {
    fileKey: record.fileKey,
    name: record.name,
    path: record.path,
    size: record.size,
    knowledgeBaseIds: [...new Set(record.knowledgeBaseIds.filter((id): id is string => typeof id === 'string' && id.length > 0))],
    uploadedAt: typeof record.uploadedAt === 'string' ? record.uploadedAt : '',
    documentId: typeof record.documentId === 'string' ? record.documentId : undefined,
    assetId: typeof record.assetId === 'string' ? record.assetId : undefined,
  }
}

function findLocalUploadedRecordForFile(
  file: KbFile,
  kbId: string,
  records: LocalUploadedKnowledgeRecord[],
) {
  return records.find((record) => (
    record.knowledgeBaseIds.includes(kbId)
    && (
      (file.id && record.documentId === file.id)
      || (file.assetId && record.assetId === file.assetId)
      || isSameLocalRecord(record, file)
    )
  ))
}

function isScannedFileInKnowledgeBase(file: ScannedKnowledgeFile, kb: KnowledgeBase) {
  return kb.files.some((kbFile) => isSameScannedDoc(kbFile, file))
}

function isSameLocalRecord(record: LocalUploadedKnowledgeRecord, file: KbFile) {
  return record.size === (file.fileSize ?? -1)
    && (record.name === file.name || record.name === file.fileName)
}

function isSameLocalFile(scannedFile: ScannedKnowledgeFile, file: KbFile) {
  return scannedFile.size === (file.fileSize ?? -1)
    && (scannedFile.name === file.name || scannedFile.name === file.fileName)
}

function getLocalUploadedFileKey(file: ScannedKnowledgeFile) {
  return `${file.path}::${file.name}::${file.size}`
}

function isScannedKnowledgeFile(value: unknown): value is ScannedKnowledgeFile {
  const file = value as ScannedKnowledgeFile
  return typeof file?.name === 'string' && typeof file.path === 'string' && typeof file.size === 'number'
}

async function loadLocalScanStore() {
  if (!isTauriRuntime()) return null
  try {
    const { load: loadStore } = await import('@tauri-apps/plugin-store')
    return await loadStore(LOCAL_SCAN_STORE_FILE)
  } catch {
    return null
  }
}

const memoryStorageFallback = new Map<string, string>()

function readLocalStorageValue(key: string) {
  if (canUseLocalStorage()) {
    try {
      const value = window.localStorage.getItem(key)
      if (value !== null) return value
    } catch {
      // fall through to in-memory fallback
    }
  }
  return memoryStorageFallback.get(key) ?? null
}

function writeLocalStorageValue(key: string, value: string) {
  memoryStorageFallback.set(key, value)
  if (!canUseLocalStorage()) return
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // ignore fallback persistence failures
  }
}

function canUseLocalStorage() {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
  } catch {
    return false
  }
}

function isTauriRuntime() {
  return typeof window !== 'undefined'
    && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
}
