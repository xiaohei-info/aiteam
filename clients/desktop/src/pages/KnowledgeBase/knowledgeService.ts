import type { KbFile, KnowledgeBase } from './types'

// The single NAS saved before multi-NAS keeps this id, so its `local:<id>` keys stay valid.
export const LEGACY_NAS_ID = 'default'

export type KnowledgeSource = 'enterprise' | 'local'
/** One connected service: the Manager, or one of several NAS connections. */
export type KnowledgeEndpoint = { source: 'enterprise' } | { source: 'local'; nasId: string }
export const ENTERPRISE_ENDPOINT: KnowledgeEndpoint = { source: 'enterprise' }
export function nasEndpoint(nasId: string): KnowledgeEndpoint {
  return { source: 'local', nasId }
}
export function sameEndpoint(left: KnowledgeEndpoint, right: KnowledgeEndpoint): boolean {
  return left.source === 'enterprise' ? right.source === 'enterprise' : right.source === 'local' && left.nasId === right.nasId
}
export function knowledgeSourceLabel(source?: KnowledgeSource): string {
  return source === 'local' ? '个人' : '企业'
}
/** `个人·家里 NAS` when the library knows its service, so several personal services stay distinguishable. */
export function knowledgeBaseSourceLabel(base: Pick<KnowledgeBase, 'source' | 'sourceName'>): string {
  return base.source === 'local' && base.sourceName ? `个人·${base.sourceName}` : knowledgeSourceLabel(base.source)
}
/** One entry per configured connection; `error` is absent when it listed successfully. */
export interface KnowledgeSourceResult {
  endpoint: KnowledgeEndpoint
  error?: string
}
export type KnowledgeSourceConnection =
  | { state: 'unconfigured' }
  | { state: 'checking' | 'connected'; address: string }
  | { state: 'error'; address: string; message: string }
// A saved URL without a listing result yet is still being checked.
export function knowledgeSourceConnection(url: string, result?: KnowledgeSourceResult): KnowledgeSourceConnection {
  const trimmed = url.trim()
  if (!trimmed) return { state: 'unconfigured' }
  const address = trimmed.replace(/^https?:\/\//u, '')
  if (!result) return { state: 'checking', address }
  return result.error ? { state: 'error', address, message: result.error } : { state: 'connected', address }
}
// Enterprise libraries follow Manager role permissions. Personal services only allow `private`;
// team or enterprise rows still read but are marked for migration. A row without a level is left to the service.
export function knowledgeScopeLabel(base: Pick<KnowledgeBase, 'source' | 'level'>): string {
  if (base.source !== 'local') return '按岗位权限'
  if (base.level === 'team') return '团队级·待迁移'
  if (base.level === 'enterprise') return '企业级·待迁移'
  return '仅本人'
}
export const REMOVED_DEVICE_KNOWLEDGE_REASON = '本机副本知识库已移除。你仍可扫描和预览本地文件；员工目录检索尚未开放。'
export type KnowledgeRequest = (endpoint: KnowledgeEndpoint, path: string, init?: RequestInit) => Promise<unknown>
export const MANAGER_UPLOAD_LIMIT = 4 * 1024 * 1024
const MANAGER_SPACES = '/api/manager/knowledge-spaces'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('知识库服务返回了无效数据')
  return value as Record<string, unknown>
}
function text(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback }
function unwrap(value: unknown): Record<string, unknown> | unknown[] {
  const envelope = record(value)
  const data = 'data' in envelope ? envelope.data : envelope
  return Array.isArray(data) ? data : record(data)
}
function items(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const data = unwrap(value)
  if (Array.isArray(data)) return data
  const wrapped = record(data)
  if (Array.isArray(wrapped.items)) return wrapped.items
  throw new Error('知识库服务返回了无效列表')
}

// Scope IDs in the UI so IDs from the Manager and from each NAS can never collide.
// encodeURIComponent escapes ':', so `local:<nas>:<id>` and legacy `local:<id>` stay unambiguous.
export function knowledgeKey(endpoint: KnowledgeEndpoint, id: string): string {
  if (endpoint.source === 'enterprise') return `enterprise:${encodeURIComponent(id)}`
  return endpoint.nasId === LEGACY_NAS_ID
    ? `local:${encodeURIComponent(id)}`
    : `local:${encodeURIComponent(endpoint.nasId)}:${encodeURIComponent(id)}`
}
export function knowledgeTarget(key: string, fallback: KnowledgeSource = 'enterprise'): { endpoint: KnowledgeEndpoint; id: string } {
  // Old desktop links must never fall through to a remote knowledge service.
  if (key.startsWith('device:')) throw new Error(REMOVED_DEVICE_KNOWLEDGE_REASON)
  if (key.startsWith('enterprise:')) return { endpoint: ENTERPRISE_ENDPOINT, id: decodeURIComponent(key.slice('enterprise:'.length)) }
  if (key.startsWith('local:')) {
    const rest = key.slice('local:'.length)
    const separator = rest.indexOf(':')
    return separator < 0
      ? { endpoint: nasEndpoint(LEGACY_NAS_ID), id: decodeURIComponent(rest) }
      : { endpoint: nasEndpoint(decodeURIComponent(rest.slice(0, separator))), id: decodeURIComponent(rest.slice(separator + 1)) }
  }
  return { endpoint: fallback === 'local' ? nasEndpoint(LEGACY_NAS_ID) : ENTERPRISE_ENDPOINT, id: key }
}
export function validateKnowledgeUpload(file: Pick<File, 'name' | 'size'>, source: KnowledgeSource): void {
  if (!file.name.trim() || file.size <= 0) throw new Error('不能上传空文件')
  if (source === 'enterprise' && file.size > MANAGER_UPLOAD_LIMIT) throw new Error('Manager 单个文档不能超过 4 MiB')
}

export function normalizeKnowledgeDocument(value: unknown, key: string): KbFile {
  const row = record(value)
  const id = text(row.id)
  const name = text(row.display_name, text(row.name, text(row.file_name)))
  if (!id || !name) throw new Error('知识库服务返回了无效文档')
  const bytes = typeof row.file_size === 'number' ? row.file_size : typeof row.fileSize === 'number' ? row.fileSize : undefined
  return {
    id, name, knowledgeBaseId: key,
    assetId: text(row.assetId, id),
    type: text(row.type, text(row.file_name, name).split('.').pop()?.toLowerCase() ?? ''),
    size: text(row.size, bytes === undefined ? '—' : `${(bytes / 1024).toFixed(1)} KB`),
    uploadedAt: text(row.created_at, text(row.uploadedAt)),
    fileName: text(row.file_name, text(row.fileName, name)),
    mimeType: text(row.file_type, text(row.mimeType)), fileSize: bytes,
    status: text(row.status, 'uploaded'),
    canRetry: typeof row.can_retry === 'boolean' ? row.can_retry : typeof row.canRetry === 'boolean' ? row.canRetry : undefined,
    canDelete: typeof row.can_delete === 'boolean' ? row.can_delete : typeof row.canDelete === 'boolean' ? row.canDelete : undefined,
    recoveryRequired: row.recovery_required === true || row.recoveryRequired === true,
    errorMessage: text(row.error_message, text(row.errorMessage)),
    chunks: typeof row.chunks === 'number' ? row.chunks : undefined,
  }
}

export function createKnowledgeService(request: KnowledgeRequest) {
  async function listSource(endpoint: KnowledgeEndpoint): Promise<KnowledgeBase[]> {
    const { source } = endpoint
    const rows = items(await request(endpoint, source === 'enterprise' ? MANAGER_SPACES : '/api/knowledge-bases'))
    return Promise.all(rows.map(async value => {
      const row = record(value)
      const id = text(row.knowledge_space_id, text(row.id, text(row.knowledge_base_id)))
      const name = text(row.display_name, text(row.name, text(row.title)))
      if (!id || !name) throw new Error('知识库服务返回了无效知识库')
      const key = knowledgeKey(endpoint, id)
      let documents = Array.isArray(row.files) ? row.files : []
      let bindings = Array.isArray(row.employeeBindings) ? row.employeeBindings : []
      if (source === 'enterprise') {
        const path = `${MANAGER_SPACES}/${encodeURIComponent(id)}`
        const [docs, links] = await Promise.all([request(endpoint, `${path}/documents`), request(endpoint, `${path}/bindings`)])
        documents = items(docs)
        bindings = items(links).map(record).filter(link => link.resource_type === 'expert').map(link => ({ employeeId: link.resource_id, displayName: link.resource_id }))
      }
      const files = documents.map(doc => normalizeKnowledgeDocument(doc, key)).filter(doc => doc.status !== 'deleted')
      return {
        id: key, name, source, nasId: endpoint.source === 'local' ? endpoint.nasId : undefined, icon: source === 'local' ? '▣' : '▦',
        description: text(row.description), status: text(row.status, 'active'), files,
        docCount: source === 'enterprise' ? files.length : typeof row.doc_count === 'number' ? row.doc_count : typeof row.docCount === 'number' ? row.docCount : files.length,
        updatedAt: text(row.updated_at, text(row.updatedAt, text(row.created_at))),
        updatedFilesToday: typeof row.updated_files_today === 'number' ? row.updated_files_today : undefined,
        uploadedUsersToday: typeof row.uploaded_users_today === 'number' ? row.uploaded_users_today : undefined,
        directory: text(row.directory, '未分类'),
        level: source === 'enterprise' || row.level === 'enterprise' ? 'enterprise' as const : row.level === 'private' || row.level === 'team' ? row.level : undefined,
        employeeBindings: bindings.map(record).filter(link => typeof link.employeeId === 'string').map(link => ({ employeeId: text(link.employeeId), displayName: text(link.displayName, text(link.employeeId)) })),
      }
    }))
  }

  async function upload(key: string, file: File, displayName?: string, source?: KnowledgeSource): Promise<KbFile> {
    const target = knowledgeTarget(key, source)
    validateKnowledgeUpload(file, target.endpoint.source)
    let path: string
    let body: BodyInit
    if (target.endpoint.source === 'enterprise') {
      path = `${MANAGER_SPACES}/${encodeURIComponent(target.id)}/documents`
      const form = new FormData()
      form.append('file', file, displayName?.trim() || file.name)
      body = form
    } else {
      path = `/api/knowledge-bases/${encodeURIComponent(target.id)}/documents`
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
      body = JSON.stringify({ name: displayName?.trim() || file.name, mime_type: file.type, size: file.size, content_base64: btoa(binary) })
    }
    return normalizeKnowledgeDocument(unwrap(await request(target.endpoint, path, { method: 'POST', body })), knowledgeKey(target.endpoint, target.id))
  }

  async function bind(key: string, employeeId: string): Promise<void> {
    const { endpoint, id } = knowledgeTarget(key)
    if (endpoint.source === 'enterprise') {
      await request(endpoint, `${MANAGER_SPACES}/${encodeURIComponent(id)}/bindings`, { method: 'POST', body: JSON.stringify({ knowledge_space_id: id, resource_type: 'expert', resource_id: employeeId }) })
    } else {
      // NAS exposes replacement semantics. Preserve all current associations on this same NAS.
      const bases = await listSource(endpoint)
      const linked = bases.filter(base => base.employeeBindings?.some(link => link.employeeId === employeeId)).map(base => knowledgeTarget(base.id).id)
      await request(endpoint, `/api/knowledge-permissions/${encodeURIComponent(employeeId)}`, { method: 'PUT', body: JSON.stringify({ knowledge_base_ids: [...new Set([...linked, id])] }) })
    }
  }

  async function retry(key: string, file: KbFile): Promise<KbFile> {
    const { endpoint, id } = knowledgeTarget(key)
    if (file.recoveryRequired || file.canRetry === false) throw new Error('该文档当前不能重试，请等待服务端对账或处理完成')
    const prefix = endpoint.source === 'enterprise' ? MANAGER_SPACES : '/api/knowledge-bases'
    const data = unwrap(await request(endpoint, `${prefix}/${encodeURIComponent(id)}/documents/${encodeURIComponent(file.assetId ?? file.id)}/retry`, { method: 'POST' }))
    // Manager retry returns an ingestion job, not a document.
    if (endpoint.source === 'enterprise') {
      const docs = items(await request(endpoint, `${prefix}/${encodeURIComponent(id)}/documents`))
      const doc = docs.map(value => normalizeKnowledgeDocument(value, key)).find(item => item.id === file.id)
      if (!doc) throw new Error('重试已提交，但文档状态未能刷新，请刷新列表')
      return doc
    }
    return normalizeKnowledgeDocument(data, key)
  }
  return { listSource, upload, bind, retry }
}

export interface UploadBatchResult<T> { uploaded: KbFile[]; failed: Array<{ item: T; error: string }> }
export async function uploadKnowledgeBatch<T extends { file: File }>(
  files: readonly T[], upload: (item: T) => Promise<KbFile>, onProgress: (index: number, total: number) => void,
): Promise<UploadBatchResult<T>> {
  const result: UploadBatchResult<T> = { uploaded: [], failed: [] }
  for (const [index, item] of files.entries()) {
    onProgress(index + 1, files.length)
    try { result.uploaded.push(await upload(item)) }
    catch (error) { result.failed.push({ item, error: error instanceof Error ? error.message : '上传失败' }) }
  }
  return result
}
