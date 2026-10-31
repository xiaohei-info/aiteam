import type { WheelEvent } from 'react'
import type { KbFile, ScannedKnowledgeFile } from './types.ts'

export interface Feedback {
  kind: 'info' | 'success' | 'error'
  text: string
}

export interface UploadPreview {
  key: string
  name: string
  size: string
  type: string
  isImage: boolean
  url?: string
}

export function isSameScannedDoc(file: KbFile, scannedFile: ScannedKnowledgeFile) {
  return (file.name === scannedFile.name || file.fileName === scannedFile.name) && file.fileSize === scannedFile.size
}

export function getScannedFileType(fileName: string) {
  return fileName.split('.').pop()?.toLowerCase() || 'file'
}

/** 员工对话检索（Agent local_dir_search）当前支持的纯文本格式，与 Agent 侧 FORMATS 对齐。
 * 超出此集合的文件（DOCX/PDF/PPT 等）仅支持上传到云端知识库，无法被本地目录检索命中。 */
export const LOCAL_SEARCHABLE_EXTENSIONS = new Set(['md', 'csv', 'txt', 'markdown', 'json', 'log'])

export function isLocalSearchableFile(fileName: string) {
  return LOCAL_SEARCHABLE_EXTENSIONS.has(getScannedFileType(fileName))
}

export function getPathFileName(path: string) {
  return path.split(/[\\/]/).pop() || path
}

export function isTransientKnowledgeFileName(fileName: string) {
  const name = getPathFileName(fileName).trim()
  if (!name) return true
  return name.startsWith('~$')
    || name.startsWith('.')
    || name.startsWith('._')
    || name.endsWith('.tmp')
    || name.endsWith('.temp')
}

function stripMacPrivatePrefix(path: string) {
  return path.replace(/^\/private(?=\/(?:var|tmp)(?:\/|$))/, '')
}

export function isHiddenLocalKnowledgePath(path: string, rootDirectory?: string) {
  let targetPath = path
  if (rootDirectory) {
    const normalizedPath = stripMacPrivatePrefix(path.replace(/\\/g, '/'))
    const normalizedRoot = stripMacPrivatePrefix(rootDirectory.trim().replace(/\\/g, '/').replace(/\/+$/, ''))
    if (normalizedRoot && normalizedPath === normalizedRoot) {
      return false
    }
    if (normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)) {
      targetPath = normalizedPath.slice(normalizedRoot.length + 1)
    }
  }
  return targetPath
    .split(/[\\/]/)
    .filter(Boolean)
    .some((segment) => segment.startsWith('.') || segment.startsWith('._'))
}

export function isSupportedLocalKnowledgeFileName(fileName: string) {
  if (isTransientKnowledgeFileName(fileName)) return false
  const type = getScannedFileType(fileName)
  return type === 'docx'
    || type === 'md'
    || type === 'pdf'
    || type === 'csv'
    || type === 'ppt'
    || type === 'pptx'
}

export function isKnowledgeUploadCandidate(file: Pick<File, 'name' | 'size'>) {
  if (isTransientKnowledgeFileName(file.name)) return false
  if (getScannedFileType(file.name) === 'docx' && file.size < 1024) return false
  return true
}

export function getScannedFileTypeLabel(type: string) {
  if (type === 'md') return 'MD'
  return type.toUpperCase()
}

export function getScannedFileTypePriority(type: string) {
  if (type === 'docx') return 1
  if (type === 'md') return 2
  if (type === 'pdf') return 3
  if (type === 'csv') return 4
  if (type === 'ppt' || type === 'pptx') return 5
  return 10
}

export function getScannedFileMimeType(fileName: string) {
  const ext = getScannedFileType(fileName)
  if (ext === 'md') return 'text/markdown'
  if (ext === 'csv') return 'text/csv'
  if (ext === 'pdf') return 'application/pdf'
  if (ext === 'ppt') return 'application/vnd.ms-powerpoint'
  if (ext === 'pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  return 'application/octet-stream'
}

export function normalizeStatusClass(status?: string) {
  if (status === 'ready' || status === 'done' || status === 'active') return 'ready'
  if (status === 'error' || status === 'failed') return 'error'
  if (status === 'ingesting') return 'ingesting'
  return ''
}

export function getErrorTooltipText(status?: string, reason?: string) {
  return normalizeStatusClass(status) === 'error' && reason ? reason : undefined
}

export function getFeedbackDismissDelay(feedback: Feedback | null, isBusy: boolean) {
  if (!feedback) return 0
  if (feedback.kind === 'info' && isBusy) return 0
  return feedback.kind === 'error' ? 4000 : 2000
}

export function normalizeWheelDeltaY(event: WheelEvent<HTMLElement>) {
  if (event.deltaMode === 1) return event.deltaY * 16
  if (event.deltaMode === 2) return event.deltaY * event.currentTarget.clientHeight
  return event.deltaY
}

export function getErrorMessage(err: unknown, fallback: string) {
  const responseData = (err as { response?: { data?: { message?: string; error?: string } } }).response?.data
  if (typeof err === 'string' && err.trim()) return err
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message
  }
  return responseData?.message || responseData?.error || (err instanceof Error ? err.message : fallback)
}

export function getUploadPreviewKey(file: File, index: number) {
  return `${file.name}-${file.size}-${file.lastModified}-${index}`
}

export function isPreviewImage(file: File) {
  return file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(file.name)
}

export function getUploadPreviewType(file: File) {
  if (file.type) return file.type
  const ext = file.name.split('.').pop()
  return ext ? ext.toUpperCase() : '文件'
}

export function formatPreviewSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
