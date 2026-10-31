import type { UploadableChatFile } from './chatAttachmentUpload'

export interface SingleChatPromptBody {
  text: string
  attachment_ids?: string[]
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
  if (attachmentIds.length !== files.length) {
    throw new Error('附件尚未全部上传成功')
  }
  return {
    text,
    ...(attachmentIds.length > 0 ? { attachment_ids: attachmentIds } : {}),
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
