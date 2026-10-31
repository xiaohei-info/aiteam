import type { CachedFile } from './fileCache'
import type { MessageAttachment } from '../stores/chat'

export type AttachmentUploadStatus = 'uploading' | 'uploaded' | 'failed'

export interface AttachmentUploadState {
  clientId: string
  status: AttachmentUploadStatus
  attachmentId?: string
  error?: string
}

export interface UploadableChatFile extends CachedFile {
  upload?: AttachmentUploadState
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
  if (requireUploaded && hasBlockingAttachmentUpload(files)) return undefined
  return onReady([...files])
}

export function uploadedAttachmentIds(files: readonly UploadableChatFile[]): string[] {
  return files.flatMap((file) => {
    const id = file.upload?.status === 'uploaded' ? file.upload.attachmentId : undefined
    return id ? [id] : []
  })
}

export function uploadedMessageAttachments(files: readonly UploadableChatFile[]): MessageAttachment[] {
  return files.flatMap((file) => {
    const id = file.upload?.status === 'uploaded' ? file.upload.attachmentId : undefined
    if (!id) return []
    return [{
      id,
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
