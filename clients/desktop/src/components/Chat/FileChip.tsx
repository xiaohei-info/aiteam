import { FileText, LoaderCircle, Music2, RotateCcw, Video, X } from 'lucide-react'
import { isImageMime, type CachedFile } from '../../lib/fileCache'
import type { AttachmentUploadStatus } from '../../lib/chatAttachmentUpload'

interface FileChipProps {
  file: CachedFile
  onRemove: () => void
  uploadStatus?: AttachmentUploadStatus
  uploadError?: string
  onRetry?: () => void
  disabled?: boolean
}

function FileTypeIcon({ mime }: { mime: string }) {
  const Icon = mime.startsWith('video/') ? Video : mime.startsWith('audio/') ? Music2 : FileText
  const bg = mime.startsWith('video/') ? 'var(--info)'
    : mime.startsWith('audio/') ? 'var(--warning)'
    : mime === 'application/pdf' ? 'var(--danger)'
    : 'var(--surface-4)'
  return (
    <span className="chat-file-chip-icon" style={{ background: bg }}>
      <Icon size={13} strokeWidth={1.8} aria-hidden="true" />
    </span>
  )
}

export function FileChip({ file, onRemove, uploadStatus, uploadError, onRetry, disabled }: FileChipProps) {
  const uploadLabel = uploadStatus === 'uploading'
    ? '正在上传'
    : uploadStatus === 'uploaded'
      ? '上传完成'
      : uploadStatus === 'failed'
        ? `上传失败${uploadError ? `：${uploadError}` : ''}`
        : '等待发送'

  return (
    <div
      className={`chat-file-chip${uploadStatus ? ` ${uploadStatus}` : ''}`}
      title={uploadStatus === 'failed' ? uploadError : undefined}
      role="group"
      aria-label={`${file.name}，${uploadLabel}`}
      aria-live="polite"
    >
      {isImageMime(file.mime)
        ? <img src={file.asset_url} className="chat-file-chip-thumb" alt="" />
        : <FileTypeIcon mime={file.mime} />}
      <span className="chat-file-chip-name">{file.name}</span>
      {uploadStatus === 'uploading' && <LoaderCircle className="chat-file-chip-spinner" size={13} aria-hidden="true" />}
      {uploadStatus === 'failed' && onRetry && (
        <button type="button" className="chat-file-chip-retry" onClick={onRetry} title="重试上传" aria-label={`重试上传 ${file.name}`} disabled={disabled}>
          <RotateCcw size={11} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
      <button type="button" className="chat-file-chip-remove" onClick={onRemove} title="移除附件" aria-label={`移除附件 ${file.name}`} disabled={disabled}>
        <X size={9} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </div>
  )
}
