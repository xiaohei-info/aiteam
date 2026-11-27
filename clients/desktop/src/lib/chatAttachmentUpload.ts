import type { CachedFile } from './fileCache'
import type { MessageAttachment } from '../stores/chat'

/**
 * importing: still being copied into the conversation folder (no file yet, cannot be sent);
 * queued: copied, but the copy finished after the user switched away, so the upload starts when
 * the user comes back to that conversation (uploads are bound to the conversation on screen).
 */
export type AttachmentUploadStatus = 'importing' | 'queued' | 'uploading' | 'uploaded' | 'failed'

export interface AttachmentUploadState {
  clientId: string
  status: AttachmentUploadStatus
  attachmentId?: string
  error?: string
}

export interface UploadableChatFile extends CachedFile {
  upload?: AttachmentUploadState
}

/** A file that has a local path needs no upload: the message carries the path and the Agent reads it. */
export function isReferencedByPath(file: CachedFile): file is CachedFile & { path: string } {
  return typeof file.path === 'string' && file.path.length > 0
}

/** Ready to send straight away: an attachment by path is「uploaded」without an attachment ID. */
export function referenceAttachmentByPath(file: CachedFile, clientId: string): UploadableChatFile {
  const { upload: _previous, ...plain } = file as UploadableChatFile
  return { ...plain, upload: { clientId, status: 'uploaded' } }
}

export interface AttachmentPathRef {
  path: string
  name: string
}

export function referencedAttachmentPaths(files: readonly UploadableChatFile[]): AttachmentPathRef[] {
  return files.flatMap((file) =>
    file.upload?.status === 'uploaded' && !file.upload.attachmentId && isReferencedByPath(file)
      ? [{ path: file.path, name: file.name }]
      : [])
}

export function beginAttachmentUpload(
  file: CachedFile,
  clientId: string,
): UploadableChatFile {
  return {
    ...file,
    upload: { clientId, status: 'uploading' },
  }
}

/** Placeholder shown the moment an import starts, so a send or a conversation switch can see it. */
export function beginAttachmentImport(
  meta: { name: string; mime: string; size: number },
  clientId: string,
): UploadableChatFile {
  return {
    rel_path: '',
    asset_url: '',
    name: meta.name,
    size: meta.size,
    mime: meta.mime,
    upload: { clientId, status: 'importing' },
  }
}

export function queueAttachmentUpload(file: CachedFile, clientId: string): UploadableChatFile {
  return { ...file, upload: { clientId, status: 'queued' } }
}

export function isImportingAttachment(files: readonly UploadableChatFile[]): boolean {
  return files.some((file) => file.upload?.status === 'importing')
}

export function completeAttachmentUpload(
  file: UploadableChatFile,
  attachmentId: string,
): UploadableChatFile {
  if (!file.upload || !attachmentId) return file
  return {
    ...file,
    upload: {
      clientId: file.upload.clientId,
      status: 'uploaded',
      attachmentId,
    },
  }
}

export function failAttachmentUpload(
  file: UploadableChatFile,
  error: string,
): UploadableChatFile {
  if (!file.upload) return file
  return {
    ...file,
    upload: {
      clientId: file.upload.clientId,
      status: 'failed',
      error,
    },
  }
}

export function removeAttachmentUpload(
  files: readonly UploadableChatFile[],
  clientId: string,
): UploadableChatFile[] {
  return files.filter((file) => file.upload?.clientId !== clientId)
}

export function hasBlockingAttachmentUpload(files: readonly UploadableChatFile[]): boolean {
  return files.some((file) => file.upload?.status !== 'uploaded')
}

export function runWhenAttachmentsReady<T>(
  files: readonly UploadableChatFile[],
  requireUploaded: boolean,
  onReady: (readyFiles: UploadableChatFile[]) => T,
): T | undefined {
  // A file still being imported is not in the list yet as far as the message is concerned: never send without it.
  if (isImportingAttachment(files)) return undefined
  if (requireUploaded && hasBlockingAttachmentUpload(files)) return undefined
  return onReady([...files])
}

export function uploadedAttachmentIds(files: readonly UploadableChatFile[]): string[] {
  return files.flatMap((file) => {
    const id = file.upload?.status === 'uploaded' ? file.upload.attachmentId : undefined
    return id ? [id] : []
  })
}

/** Every file is either uploaded (has an attachment ID) or attached by path. */
export function areAttachmentsReady(files: readonly UploadableChatFile[]): boolean {
  return uploadedAttachmentIds(files).length + referencedAttachmentPaths(files).length === files.length
}

/** Stable identity of a message's attachments, for recognising a resend of the same message. */
export function attachmentKeys(files: readonly UploadableChatFile[]): string[] {
  return [...uploadedAttachmentIds(files), ...referencedAttachmentPaths(files).map((ref) => `path:${ref.path}`)]
}

export function uploadedMessageAttachments(files: readonly UploadableChatFile[]): MessageAttachment[] {
  return files.flatMap((file) => {
    if (file.upload?.status !== 'uploaded') return []
    const id = file.upload.attachmentId ?? (isReferencedByPath(file) ? `path:${file.path}` : undefined)
    if (!id) return []
    return [{
      id,
      ...(!file.upload.attachmentId && isReferencedByPath(file) ? { path: file.path } : {}),
      filename: file.name,
      name: file.name,
      mime_type: file.mime,
      byte_size: file.size,
      kind: file.mime.startsWith('image/') ? 'image' : 'file',
    }]
  })
}

export function attachmentErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return '附件上传失败，请重试'
}
