import type { BackendApiClient } from '../backend/client'

export interface EmployeeAvatarUpdate {
  employee_id: string
  avatar_url: string | null
  version: number
  updated_at: string
}

export interface EmployeeAvatarPayload {
  filename: string
  mime_type: 'image/jpeg' | 'image/png' | 'image/webp'
  data: string
}

export function updateEmployeeAvatar(client: BackendApiClient, employeeId: string, body: EmployeeAvatarPayload) {
  return client.request<EmployeeAvatarUpdate>({
    method: 'POST',
    path: `/api/agent/employees/${encodeURIComponent(employeeId)}/avatar`,
    body,
  })
}

/**
 * 受保护头像内容：按文档契约走二进制请求，调用方不需要直连 URL。
 * `version` 透传头像 URL 上的缓存键（`?v=`），保证刚替换过的头像不被 HTTP 缓存挡回旧图。
 */
export function fetchEmployeeAvatarContent(client: BackendApiClient, employeeId: string, version?: string | null) {
  return client.request<Blob>({
    path: `/api/agent/employees/${encodeURIComponent(employeeId)}/avatar/content`,
    ...(version ? { query: { v: version } } : {}),
    binary: true,
    headers: { Accept: 'image/*' },
  })
}
