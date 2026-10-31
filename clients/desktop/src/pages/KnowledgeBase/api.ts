import { invoke } from '@tauri-apps/api/core'
import { invokeWithFileAccess } from '../../lib/fileAccess'
import { backendApi } from '../../api/backend'
import { AgentApiError } from '../../api/agent'
import { assertSecureApiUrl } from '../../api/urlSecurity'
import { findKnowledgeFileLocalPath as findStoredKnowledgeFileLocalPath } from './localKnowledgeStore'
import type { KbFile, KnowledgeBase, KnowledgeDocumentPreview, KnowledgeEmployee, KnowledgeFilePreview, KnowledgeSearchResult, ScannedKnowledgeFile } from './types'
import { getPathFileName, isKnowledgeUploadCandidate } from './utils'
import { nasDisplayName, normalizeUrl, readKnowledgeSourceConfig } from './knowledgeSourceConfig'
import {
  ENTERPRISE_ENDPOINT,
  createKnowledgeService,
  knowledgeKey,
  knowledgeTarget,
  nasEndpoint,
  type KnowledgeEndpoint,
  type KnowledgeSource,
  type KnowledgeSourceResult,
} from './knowledgeService'
import { pickAgentFetch } from '../../api/agent/runtime'
import { PERSONAL_KNOWLEDGE_LEVEL, assertPersonalKnowledgeLevel } from './knowledgeSourceGroups'


export interface KnowledgeUploadSelection {
  file: File
  localPath: string
}

const UPLOAD_DIALOG_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'csv',
  'json',
  'log',
  'html',
  'htm',
  'doc',
  'docx',
  'pdf',
  'ppt',
  'pptx',
  'zip',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'bmp',
  'svg',
]

const KB_DISABLED_MSG = '尚未连接知识库服务，请先连接企业知识库或添加个人知识库服务。'
const NAS_REMOVED_MSG = '这台个人知识库服务已断开连接，请在知识库首页重新添加后再操作。'

function endpointConfig(endpoint: KnowledgeEndpoint) {
  const config = readKnowledgeSourceConfig()
  if (endpoint.source === 'enterprise') return { baseUrl: normalizeUrl(config.enterpriseUrl), token: config.enterpriseToken, message: KB_DISABLED_MSG }
  const nas = config.nas.find(item => item.id === endpoint.nasId)
  return { baseUrl: nas ? normalizeUrl(nas.url) : '', token: nas?.token ?? '', message: NAS_REMOVED_MSG }
}

function sourcePath(baseUrl: string, path: string) {
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
}

export async function requestKnowledgeSource<T>(endpoint: KnowledgeEndpoint, path: string, init?: RequestInit): Promise<T> {
  const { baseUrl, token, message } = endpointConfig(endpoint)
  if (!baseUrl) throw new AgentApiError(message, 412, { code: 'knowledge_source_unconfigured' })
  return requestKnowledgeAddress<T>(baseUrl, token, path, init)
}

async function requestKnowledgeAddress<T>(baseUrl: string, token: string, path: string, init?: RequestInit): Promise<T> {
  try { assertSecureApiUrl(baseUrl, '知识库服务') } catch (error) { throw new AgentApiError(error instanceof Error ? error.message : '知识库服务地址不安全', 0, { code: 'client_insecure_api_url' }) }
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  if (typeof init?.body === 'string') headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const fetchImpl = await pickAgentFetch()
  const response = await fetchImpl(sourcePath(baseUrl, path), { ...init, headers, redirect: 'error', signal: init?.signal ?? AbortSignal.timeout(60_000) })
  const payload = await response.json().catch(() => null) as unknown
  if (!response.ok) {
    const problem = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    const detail = problem.detail ?? problem.message
    const message = typeof detail === 'string' ? detail : `知识库服务请求失败（${response.status}）`
    throw new AgentApiError(message, response.status)
  }
  return payload as T
}

const knowledgeService = createKnowledgeService(requestKnowledgeSource)

function normalizeKnowledgeBase(raw: unknown, source: KnowledgeSource): KnowledgeBase | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const id = typeof value.id === 'string' ? value.id : typeof value.knowledge_base_id === 'string' ? value.knowledge_base_id : ''
  const name = typeof value.name === 'string' ? value.name : typeof value.title === 'string' ? value.title : ''
  if (!id || !name) return null
  const files = Array.isArray(value.files) ? value.files as KbFile[] : []
  return {
    id, name,
    icon: typeof value.icon === 'string' ? value.icon : source === 'local' ? '⌂' : '▦',
    description: typeof value.description === 'string' ? value.description : '',
    status: typeof value.status === 'string' ? value.status : 'active',
    docCount: typeof value.doc_count === 'number' ? value.doc_count : typeof value.docCount === 'number' ? value.docCount : files.length,
    updatedAt: typeof value.updated_at === 'string' ? value.updated_at : typeof value.updatedAt === 'string' ? value.updatedAt : '',
    progress: typeof value.progress === 'number' ? value.progress : undefined,
    files,
    source,
    directory: typeof value.directory === 'string' ? value.directory : typeof value.catalog === 'string' ? value.catalog : '未分类',
    level: value.level === 'private' || value.level === 'team' || value.level === 'enterprise' ? value.level : undefined,
    accessPolicy: value.access_policy === 'private' || value.access_policy === 'team' || value.access_policy === 'enterprise' ? value.access_policy : 'team',
    updatedFilesToday: typeof value.updated_files_today === 'number' ? value.updated_files_today : undefined,
    uploadedUsersToday: typeof value.uploaded_users_today === 'number' ? value.uploaded_users_today : undefined,
  }
}

/**
 * Lists a draft address without saving it, so a failing address never replaces a
 * working connection. Throws the service error; resolves with the library count.
 */
export async function probeKnowledgeSource(source: KnowledgeSource, url: string, token: string): Promise<number> {
  const baseUrl = normalizeUrl(url)
  const probe = createKnowledgeService((_endpoint, path, init) => requestKnowledgeAddress(baseUrl, token.trim(), path, init))
  return (await probe.listSource(source === 'enterprise' ? ENTERPRISE_ENDPOINT : nasEndpoint('probe'))).length
}

export async function fetchKnowledgeBases(
  onWarnings?: (messages: string[]) => void,
  onSourceResults?: (results: KnowledgeSourceResult[]) => void,
): Promise<KnowledgeBase[]> {
  const config = readKnowledgeSourceConfig()
  const connections: Array<{ endpoint: KnowledgeEndpoint; label: string; sourceName?: string }> = [
    ...(normalizeUrl(config.enterpriseUrl) ? [{ endpoint: ENTERPRISE_ENDPOINT, label: '企业知识库' }] : []),
    ...config.nas.map(nas => ({ endpoint: nasEndpoint(nas.id), label: `个人知识库·${nasDisplayName(nas)}`, sourceName: nasDisplayName(nas) })),
  ]
  const bases: KnowledgeBase[] = []
  const warnings: string[] = []
  const sourceResults: KnowledgeSourceResult[] = []
  const results = await Promise.allSettled(connections.map(({ endpoint }) => knowledgeService.listSource(endpoint)))
  results.forEach((result, index) => {
    const { endpoint, label, sourceName } = connections[index]
    if (result.status === 'fulfilled') {
      bases.push(...result.value.map(base => (sourceName ? { ...base, sourceName } : base)))
      sourceResults.push({ endpoint })
      return
    }
    const message = result.reason instanceof Error ? result.reason.message : '读取失败'
    warnings.push(`${label}：${message}`)
    sourceResults.push({ endpoint, error: message })
  })
  onWarnings?.(warnings)
  onSourceResults?.(sourceResults)
  if (warnings.length && bases.length === 0 && results.every(result => result.status === 'rejected')) throw new Error(warnings.join('；'))
  return bases
}

export async function createKnowledgeBase(params: { name: string; description: string; source?: KnowledgeSource; nasId?: string; directory?: string; level?: string }): Promise<KnowledgeBase> {
  const source = params.source ?? 'local'
  if (source === 'enterprise') throw new Error('企业知识库由管理员在管理后台配置，无需在客户端新建。')
  const level = params.level ?? PERSONAL_KNOWLEDGE_LEVEL
  // Personal services have no server-side level rule; refuse team/enterprise before any request.
  assertPersonalKnowledgeLevel(level)
  // Several NAS may be connected; never guess which one receives the library.
  const connected = readKnowledgeSourceConfig().nas
  const nas = params.nasId ? connected.find(item => item.id === params.nasId) : connected.length === 1 ? connected[0] : undefined
  if (!nas) {
    throw new AgentApiError(
      params.nasId ? NAS_REMOVED_MSG : connected.length ? '已连接多台 NAS，请选择要创建到哪一台。' : KB_DISABLED_MSG,
      412,
      { code: 'knowledge_source_unconfigured' },
    )
  }
  const endpoint = nasEndpoint(nas.id)
  const payload = await requestKnowledgeSource<unknown>(endpoint, '/api/knowledge-bases', { method: 'POST', body: JSON.stringify({
    name: params.name, description: params.description || null, directory: params.directory || '未分类', level,
  }) })
  const item = normalizeKnowledgeBase((payload && typeof payload === 'object' && 'data' in payload) ? (payload as { data: unknown }).data : payload, source)
  if (!item) throw new AgentApiError('知识库服务返回了无效数据', 502, { code: 'knowledge_invalid_response' })
  return { ...item, id: knowledgeKey(endpoint, item.id), nasId: nas.id, sourceName: nasDisplayName(nas) }
}

export async function fetchKnowledgeEmployees(): Promise<KnowledgeEmployee[]> {
  // 复用新栈的授权专家投影(grants/experts),字段映射保持不变。
  const { experts } = await backendApi.listExperts()
  return experts.filter((employee) => !employee.revoked).map((employee) => ({
    employeeId: employee.employee_id,
    displayName: employee.display_name || employee.employee_id,
    roleName: employee.role_title ?? '',
    status: employee.status,
  }))
}

export async function uploadKnowledgeFile(
  kbId: string,
  file: File,
  _displayName?: string,
  _localPath?: string,
  _onUploaded?: () => void,
  source: KnowledgeSource = 'enterprise',
): Promise<KbFile> {
  const item = await knowledgeService.upload(kbId, file, _displayName, source)
  _onUploaded?.()
  return item
}

export async function retryKnowledgeDocument(kbId: string, file: KbFile): Promise<KbFile> {
  return knowledgeService.retry(kbId, file)
}

export async function searchKnowledgeBase(kbId: string, query: string): Promise<KnowledgeSearchResult> {
  const { endpoint, id } = knowledgeTarget(kbId)
  if (endpoint.source === 'enterprise') throw new Error('Manager 管理接口不提供全文检索，请在员工对话中使用知识检索工具。')
  const payload = await requestKnowledgeSource<unknown>(endpoint, `/api/knowledge-bases/${encodeURIComponent(id)}/search?q=${encodeURIComponent(query)}`)
  return (payload && typeof payload === 'object' && 'data' in payload ? (payload as { data: KnowledgeSearchResult }).data : payload) as KnowledgeSearchResult
}

export async function updateEmployeeKnowledgeBases(employeeId: string, knowledgeBaseIds: string[]): Promise<void> {
  // Validate all targets before any write, including stale device IDs from old links.
  knowledgeBaseIds.forEach(key => knowledgeTarget(key))
  for (const key of knowledgeBaseIds) {
    await knowledgeService.bind(key, employeeId)
  }
}

// 8783 未定义可用的知识文档预览接口；不再按任意 previewUrl 请求远端。
export function getKnowledgeFilePreviewUrlResult(_file: KbFile): { url: string | null; error: string | null } {
  return { url: null, error: '当前服务未开放知识文档预览，请使用本地文件预览。' }
}

export function getKnowledgeFilePreviewUrl(file: KbFile): string | null {
  return getKnowledgeFilePreviewUrlResult(file).url
}

export async function fetchKnowledgeFilePreview(file: KbFile): Promise<KnowledgeDocumentPreview> {
  if (!file.knowledgeBaseId) throw new Error('文档来源缺失，请刷新知识库后重试。')
  const { endpoint } = knowledgeTarget(file.knowledgeBaseId)
  if (endpoint.source === 'enterprise') throw new Error('Manager 暂未开放文档预览，请使用本地原文件预览。')
  const payload = await requestKnowledgeSource<unknown>(endpoint, `/api/knowledge-documents/${encodeURIComponent(file.id)}/preview`)
  return (payload && typeof payload === 'object' && 'data' in payload ? (payload as { data: KnowledgeDocumentPreview }).data : payload) as KnowledgeDocumentPreview
}

export async function findKnowledgeFileLocalPath(file: KbFile, kbId: string): Promise<string | null> {
  return findStoredKnowledgeFileLocalPath(file, kbId)
}

export async function openLocalKnowledgeFile(path: string): Promise<void> {
  await invokeWithFileAccess('open_local_file', { path }, path)
}

export async function revealLocalKnowledgeFile(path: string): Promise<void> {
  await invokeWithFileAccess('reveal_local_file', { path }, path)
}

function base64ToBlob(base64: string, contentType: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new Blob([bytes], { type: contentType })
}

function inferMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase()
  if (ext === 'md' || ext === 'markdown') return 'text/markdown'
  if (ext === 'json') return 'application/json'
  if (ext === 'csv') return 'text/csv'
  if (ext === 'html' || ext === 'htm') return 'text/html'
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (ext === 'pdf') return 'application/pdf'
  if (ext === 'zip') return 'application/zip'
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'bmp') return 'image/bmp'
  if (ext === 'svg') return 'image/svg+xml'
  return 'application/octet-stream'
}

export async function scanLocalKnowledgeFiles(extraDirs?: string[], scanId?: string): Promise<ScannedKnowledgeFile[]> {
  return invokeWithFileAccess<ScannedKnowledgeFile[]>('scan_local_knowledge_files', { extraDirs: extraDirs ?? [], scanId: scanId ?? null }, extraDirs?.[0] ?? '')
}

export async function selectKnowledgeUploadFiles(): Promise<KnowledgeUploadSelection[]> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    multiple: true,
    filters: [
      {
        name: '知识库支持文件',
        extensions: UPLOAD_DIALOG_EXTENSIONS,
      },
    ],
    title: '选择上传到知识库的文件',
  })
  const paths = normalizeDialogSelection(selected).filter((path) => isKnowledgeUploadCandidate({
    name: getPathFileName(path),
    size: Number.MAX_SAFE_INTEGER,
  }))

  const selections: KnowledgeUploadSelection[] = []
  for (const localPath of paths) {
    const name = getPathFileName(localPath)
    const base64 = await readFileAsBase64(localPath)
    const blob = base64ToBlob(base64, inferMimeType(name))
    const file = new File([blob], name, { type: blob.type || inferMimeType(name) })
    if (isKnowledgeUploadCandidate(file)) {
      selections.push({ file, localPath })
    }
  }
  return selections
}

export async function readFileAsBase64(path: string): Promise<string> {
  return invokeWithFileAccess<string>('read_file_as_base64', { path }, path)
}

export async function previewLocalKnowledgeFile(path: string): Promise<KnowledgeFilePreview> {
  return invokeWithFileAccess<KnowledgeFilePreview>('preview_local_knowledge_file', { path }, path)
}

export async function previewKnowledgeFileContent(
  name: string,
  fileType: string,
  dataBase64: string,
): Promise<KnowledgeFilePreview> {
  return invoke<KnowledgeFilePreview>('preview_knowledge_file_content', { name, fileType, dataBase64 })
}

function normalizeDialogSelection(value: string | string[] | null) {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}
