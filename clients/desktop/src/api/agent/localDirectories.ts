import type { ServiceApiClient } from './client'

// 受控本地目录知识库：桌面端是唯一授权方。
// 目录凭原生选择器签发的一次性票据注册，Agent 永远不会通过 HTTP 拿到路径；
// 源文档正文不持久化，检索/读取都走实时的宿主授权桥接。
const base = '/api/agent/local-directories'

export const LOCAL_DIRECTORIES_PATH = base
export const LOCAL_DIRECTORY_CHALLENGES_PATH = `${base}/challenges`
export const LOCAL_DIRECTORY_CITATION_VERIFY_PATH = '/api/agent/local-directory-citations/{citation_id}/verify'

export interface LocalDirectoryBinding {
  employee_id: string
  enabled: boolean
  revision: number
}

export interface LocalDirectory {
  directory_id: string
  display_name: string
  path: string
  revision: number
  /** 'ready' 或具体不可用原因码（authorization_unavailable / unauthorized / …）。 */
  status: string
  bindings: LocalDirectoryBinding[]
}

export interface LocalDirectoryList {
  available: boolean
  formats: string[]
  directories: LocalDirectory[]
}

export interface RegisteredLocalDirectory {
  directory_id: string
  display_name: string
  canonical_path: string
  revision: number
  created_at: string
}

export interface LocalDirectoryBindingUpdate {
  employee_id: string
  directory_id: string
  enabled: boolean
  revision: number
}

export interface LocalDirectoryCitation {
  citation_id: string
  directory_id: string
  directory_display_name: string
  conversation_id: string
  employee_id: string
  turn_id: string
  title: string
  relative_path: string
  content_version: string
  snippet: string
  text: string
  offset: number
  next_offset: number | null
}

export function listLocalDirectories(client: ServiceApiClient): Promise<LocalDirectoryList> {
  return client.request<LocalDirectoryList>({ method: 'GET', path: base })
}

export function createLocalDirectoryChallenge(client: ServiceApiClient): Promise<string> {
  return client.request<{ challenge: string }>({ method: 'POST', path: LOCAL_DIRECTORY_CHALLENGES_PATH })
    .then(payload => payload.challenge)
}

export function registerLocalDirectory(client: ServiceApiClient, ticket: string): Promise<RegisteredLocalDirectory> {
  return client.request<RegisteredLocalDirectory>({ method: 'POST', path: base, body: { ticket } })
}

export function setLocalDirectoryBinding(
  client: ServiceApiClient,
  directoryId: string,
  employeeId: string,
  enabled: boolean,
  expectedRevision: number,
): Promise<LocalDirectoryBindingUpdate> {
  return client.request<LocalDirectoryBindingUpdate>({
    method: 'PUT',
    path: `${base}/${encodeURIComponent(directoryId)}/bindings/${encodeURIComponent(employeeId)}`,
    body: { enabled, expected_revision: expectedRevision },
  })
}

export function revokeLocalDirectory(client: ServiceApiClient, directoryId: string): Promise<{ revoked: boolean; directory_id: string }> {
  return client.request<{ revoked: boolean; directory_id: string }>({
    method: 'DELETE',
    path: `${base}/${encodeURIComponent(directoryId)}`,
  })
}

export function verifyLocalDirectoryCitation(client: ServiceApiClient, citationId: string, offset?: number): Promise<LocalDirectoryCitation> {
  return client.request<LocalDirectoryCitation>({
    method: 'POST',
    path: `/api/agent/local-directory-citations/${encodeURIComponent(citationId)}/verify`,
    body: offset === undefined ? {} : { offset },
  })
}

/** 运行时能力检测：旧版内嵌 Agent 不含本地目录接口时隐藏入口。 */
export async function supportsLocalDirectories(client: ServiceApiClient): Promise<boolean> {
  const schema = await client.request<{ paths?: Record<string, Record<string, unknown> | undefined> }>({ path: '/openapi.json', raw: true })
  return Boolean(schema.paths?.[LOCAL_DIRECTORIES_PATH]?.get)
}

/** 绑定并发冲突（409 local_directory_revision_conflict）识别。 */
export function isRevisionConflict(error: unknown): boolean {
  const candidate = error as { status?: number; code?: string }
  return candidate?.status === 409 || candidate?.code === 'local_directory_revision_conflict'
}
