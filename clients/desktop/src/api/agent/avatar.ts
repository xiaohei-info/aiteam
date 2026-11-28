import type { BackendApiClient } from '../backend/client'

/**
 * 受保护头像内容：按文档契约走二进制请求，调用方不需要直连 URL。
 * `version` 透传头像 URL 上的缓存键（`?v=`），保证刚替换过的头像不被 HTTP 缓存挡回旧图。
 */
export function fetchEmployeeAvatarContent(client: BackendApiClient, employeeId: string, version?: string | null) {
  return client.request<Blob>({
    path: `/api/agent/employees/${encodeURIComponent(employeeId)}/avatar/content`,
    ...(version ? { query: { v: version } } : {}),
    binary: true,
    headers: { Accept: 'image/webp' },
  })
}

/** 人才市场模板头像：Agent 转拉 Manager，同样按 `?v=` 版本缓存。 */
export function fetchMarketplaceTemplateAvatarContent(client: BackendApiClient, templateId: string, version?: string | null) {
  return client.request<Blob>({
    path: `/api/agent/marketplace/templates/${encodeURIComponent(templateId)}/avatar/content`,
    ...(version ? { query: { v: version } } : {}),
    binary: true,
    headers: { Accept: 'image/webp' },
  })
}
