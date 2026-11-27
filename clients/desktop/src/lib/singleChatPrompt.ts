import { referencedAttachmentPaths, type AttachmentPathRef, type UploadableChatFile } from './chatAttachmentUpload.ts'

export interface SingleChatPromptBody {
  text: string
  attachment_ids?: string[]
  attachment_paths?: AttachmentPathRef[]
}

type SubmitPrompt = (
  conversationId: string,
  body: SingleChatPromptBody,
  idempotencyKey: string,
) => Promise<unknown>

export function buildSingleChatPrompt(
  text: string,
  files: readonly UploadableChatFile[],
): SingleChatPromptBody {
  const attachmentIds = files.flatMap((file) => {
    const id = file.upload?.status === 'uploaded' ? file.upload.attachmentId : undefined
    return id ? [id] : []
  })
  const attachmentPaths = referencedAttachmentPaths(files)
  if (attachmentIds.length + attachmentPaths.length !== files.length) {
    throw new Error('附件尚未全部上传成功')
  }
  return {
    text,
    ...(attachmentIds.length > 0 ? { attachment_ids: attachmentIds } : {}),
    ...(attachmentPaths.length > 0 ? { attachment_paths: attachmentPaths } : {}),
  }
}

export async function submitSingleChatPrompt(
  conversationId: string,
  text: string,
  files: readonly UploadableChatFile[],
  idempotencyKey: string,
  submitPrompt: SubmitPrompt,
): Promise<void> {
  await submitPrompt(
    conversationId,
    buildSingleChatPrompt(text, files),
    idempotencyKey,
  )
}
