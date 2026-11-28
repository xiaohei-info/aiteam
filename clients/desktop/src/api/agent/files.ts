/**
 * 会话级本地附件 / 产物接口。
 *
 * FredServer 路由:
 *   GET/POST/DELETE /api/agent/conversations/:id/attachments[/:file_id]
 *   GET/POST/DELETE /api/agent/conversations/:id/artifacts[/:file_id]
 *
 * 与旧栈差异:附件与会话强绑定,必须先建会话,再上传,再在 prompt 里引用 attachment_ids。
 * 单文件解码后 ≤5 MiB,MIME 走 server 白名单(见 FILE_MIME_TYPES / IMAGE_MIME_TYPES)。
 */
import type { AgentApiClient } from './client'
import type { LocalFileMetadata, LocalFileUploadRequest, Page } from './types'

type FileKind = 'attachment' | 'artifact'

function segment(kind: FileKind): string {
  return kind === 'artifact' ? 'artifacts' : 'attachments'
}

export interface ListFilesResult {
  files: LocalFileMetadata[]
  page: Page
}

export async function listFiles(
  client: AgentApiClient,
  conversationId: string,
  kind: FileKind = 'attachment',
): Promise<ListFilesResult> {
  const payload = await client.request<{ data: LocalFileMetadata[]; page: Page }>({
    method: 'GET',
    path: `/api/agent/conversations/${encodeURIComponent(conversationId)}/${segment(kind)}`,
    raw: true,
  })
  return {
    files: payload.data ?? [],
    page: payload.page ?? { next_cursor: null, has_more: false },
  }
}

export interface AttachmentRef {
  id: string
  name: string
  mime_type: string
  byte_size: number
  path: string
  created_at: string
}

/**
 * 按路径引用的附件清单（GET /api/agent/conversations/:id/attachment-refs）。
 * 历史消息里的附件只有 ref ID 和文件名，本机位置由 Agent 保存，按 ID 取回——
 * 同一会话发过同名的不同文件也不会串。
 */
export async function listAttachmentRefs(
  client: AgentApiClient,
  conversationId: string,
): Promise<AttachmentRef[]> {
  const payload = await client.request<{ data: AttachmentRef[] }>({
    method: 'GET',
    path: `/api/agent/conversations/${encodeURIComponent(conversationId)}/attachment-refs`,
    raw: true,
  })
  return payload.data ?? []
}

export function uploadFile(
  client: AgentApiClient,
  conversationId: string,
  kind: FileKind,
  file: LocalFileUploadRequest,
): Promise<LocalFileMetadata> {
  return client.request<LocalFileMetadata>({
    method: 'POST',
    path: `/api/agent/conversations/${encodeURIComponent(conversationId)}/${segment(kind)}`,
    body: file,
  })
}

// 下载由 agentApi.downloadFile 使用同一会话文件路由及 Bearer 身份。
export function deleteFile(
  client: AgentApiClient,
  conversationId: string,
  kind: FileKind,
  fileId: string,
): Promise<{ deleted: boolean; id: string }> {
  return client.request({
    method: 'DELETE',
    path: `/api/agent/conversations/${encodeURIComponent(conversationId)}/${segment(kind)}/${encodeURIComponent(fileId)}`,
  })
}
