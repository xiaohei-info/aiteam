import {
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  Presentation,
  RotateCcw,
  type LucideIcon,
} from 'lucide-react'
import { getKnowledgeFilePreviewUrlResult } from './api'
import { Img } from 'react-image'
import type { KbFile } from './types'
import { getErrorTooltipText, normalizeStatusClass } from './utils'

interface KbDocumentGridCardProps {
  file: KbFile
  justUploaded?: boolean
  isRetrying: boolean
  isWriteDisabled: boolean
  writeDisabledReason: string
  onOpen: (file: KbFile) => void
  onRetry: (file: KbFile) => void
}

interface FileVisual {
  Icon: LucideIcon
  label: string
  isImage: boolean
}

function getFileExtension(file: KbFile): string {
  const name = file.fileName || file.name
  const extension = name.split('.').pop()?.toLowerCase()
  return extension && extension !== name.toLowerCase() ? extension : ''
}

function getFileVisual(file: KbFile): FileVisual {
  const extension = getFileExtension(file)
  const mimeType = file.mimeType?.toLowerCase() ?? ''
  const label = (file.type || extension || mimeType.split('/').pop() || 'file').toUpperCase()
  if (mimeType.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'].includes(extension)) {
    return { Icon: FileImage, label, isImage: true }
  }
  if (['csv', 'xls', 'xlsx'].includes(extension) || mimeType.includes('spreadsheet')) {
    return { Icon: FileSpreadsheet, label, isImage: false }
  }
  if (['ppt', 'pptx'].includes(extension) || mimeType.includes('presentation')) {
    return { Icon: Presentation, label, isImage: false }
  }
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(extension) || mimeType.includes('zip')) {
    return { Icon: FileArchive, label, isImage: false }
  }
  return { Icon: FileText, label, isImage: false }
}

export default function KbDocumentGridCard({
  file,
  justUploaded = false,
  isRetrying,
  isWriteDisabled,
  writeDisabledReason,
  onOpen,
  onRetry,
}: KbDocumentGridCardProps) {
  const { Icon, label, isImage } = getFileVisual(file)
  const previewResult = isImage
    ? getKnowledgeFilePreviewUrlResult(file)
    : { url: null, error: null }
  const previewUrl = previewResult.url
  const errorTooltip = getErrorTooltipText(file.status, file.errorMessage)
  const canShowThumbnail = Boolean(previewUrl)
  const canRetry = file.canRetry === true && !file.recoveryRequired
  const fallbackIcon = <Icon size={34} strokeWidth={1.5} />

  return (
    <article className={`kb-document-grid-card ${justUploaded ? 'uploaded' : ''}`}>
      <button
        type="button"
        className="kb-document-grid-card-main"
        onClick={() => onOpen(file)}
        aria-label={`预览文件 ${file.name}`}
      >
        <span
          className={`kb-document-grid-preview ${canShowThumbnail ? 'image' : ''}`}
          title={previewResult.error ?? undefined}
        >
          {previewUrl ? (
            <Img src={previewUrl} alt="" loader={fallbackIcon} unloader={fallbackIcon} />
          ) : (
            fallbackIcon
          )}
          <span className="kb-document-grid-type">{label}</span>
          {previewResult.error && (
            <span className="kb-sr-only">缩略图未加载：{previewResult.error}</span>
          )}
        </span>
        <span className="kb-document-grid-name" title={file.name}>{file.name}</span>
        <span className="kb-document-grid-time">更新于 {file.uploadedAt || '—'}</span>
      </button>

      <div className="kb-document-grid-footer">
        <span
          className={`kb-status ${normalizeStatusClass(file.status)} ${errorTooltip ? 'has-tooltip' : ''}`}
          title={errorTooltip}
          role="status"
          aria-label={`文件状态：${file.status || 'unknown'}${errorTooltip ? `，${errorTooltip}` : ''}`}
        >
          {file.status || 'unknown'}
        </span>
        {canRetry && (
          <button
            type="button"
            className="kb-document-grid-retry"
            onClick={() => onRetry(file)}
            aria-describedby="kb-detail-write-disabled-reason"
            aria-label={`重试入库 ${file.name}`}
            disabled={isWriteDisabled || isRetrying}
            title={isWriteDisabled ? writeDisabledReason : undefined}
          >
            <RotateCcw size={12} strokeWidth={1.8} aria-hidden="true" />
            {isRetrying ? '重试中' : '重试'}
          </button>
        )}
      </div>
    </article>
  )
}
