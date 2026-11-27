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

/**
 * Adding several files at once (a paste, a multi-file drop): every file gets its chip right away,
 * before the first copy starts. Their ids are handed out here so all of them can be pinned to the
 * conversation they were added to — a conversation switch during the first copy must not move the
 * ones still to come to whatever conversation is on screen by then.
 */
export function planAttachmentImports(
  metas: readonly { name: string; mime: string; size: number }[],
  newClientId: () => string = () => crypto.randomUUID(),
): { clientId: string; placeholder: UploadableChatFile }[] {
  return metas.map((meta) => {
    const clientId = newClientId()
    return { clientId, placeholder: beginAttachmentImport(meta, clientId) }
  })
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

/**
 * Why adding a file failed, in words the user can act on. The host's reason (Rust `invoke` rejects
 * with a plain string, so it is not an Error) beats a bare「请重试」: a file over the limit will
 * never succeed on a retry, and the user needs to know which limit it hit.
 */
export function importErrorMessage(name: string, error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error ?? '')).trim()
  const overCacheLimit = raw.match(/larger than (\d+) MB/i)
  if (overCacheLimit) return `“${name}”超过 ${overCacheLimit[1]} MB 上限，无法添加`
  if (/exceeds maximum size|exceeds the materialization limit|超过 5 ?MiB/i.test(raw)) {
    return `“${name}”超过 5 MB 上限，无法添加`
  }
  if (raw.includes('Not a regular file')) return `“${name}”是文件夹，不能作为附件；请拖入文件`
  return raw ? `添加“${name}”失败：${raw}` : `添加“${name}”失败，请重试`
}

/** Agent 拒绝按路径引用的附件时的错误码；detail 已写明原因和文件名。 */
const ATTACHMENT_REJECTION_CODES = new Set([
  'attachment_not_found',
  'attachment_not_a_file',
  'attachment_in_credential_folder',
  'attachment_has_hard_links',
  'attachment_path_changed',
])

/**
 * 附件被拒时给用户看的文字：说明原因和是哪个文件，并告诉用户移除它再发；
 * 不是附件问题时返回 null，由页面显示通用文字。
 */
export function attachmentSendFailure(error: unknown): string | null {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown }
  if (typeof code !== 'string') return null
  if (ATTACHMENT_REJECTION_CODES.has(code)) {
    const reason = typeof message === 'string' ? message.trim().replace(/[。.]+$/u, '') : ''
    return `${reason || '有附件无法使用'}。请移除这个附件后重新发送。`
  }
  if (code === 'invalid_attachment_paths' || code === 'too_many_attachments') return '附件信息有误，请移除附件后重新发送。'
  return null
}
