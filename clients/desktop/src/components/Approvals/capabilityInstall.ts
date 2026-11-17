/**
 * `capability_install` 审批的摘要解析。
 *
 * Agent 在审批摘要里放的是 `capability_install: {json}`：完整地址、模型写的名称与理由，
 * 以及要替换的已装能力。弹窗据此专门渲染，保证 URL 完整显示、主机名突出，不被名称和理由挤出视野。
 */
export interface CapabilityInstallPreview {
  ref: string
  displayName: string
  url: string
  /** 地址拆分：主机名单独突出，其余部分弱化显示。 */
  host: string
  before: string
  after: string
  reason: string
  replaces?: { displayName: string; url: string }
}

const PREFIX = 'capability_install:'

export function parseCapabilityInstall(toolName: string, summary: string): CapabilityInstallPreview | null {
  if (toolName !== 'capability_install' || !summary.startsWith(PREFIX)) return null
  try {
    const data = JSON.parse(summary.slice(PREFIX.length).trim()) as Record<string, unknown>
    if (typeof data.url !== 'string' || !data.url) return null
    const url = new URL(data.url)
    const at = data.url.indexOf(url.host)
    const replaces = data.replaces as { display_name?: unknown; url?: unknown } | undefined
    return {
      ref: typeof data.ref === 'string' ? data.ref : '',
      displayName: typeof data.display_name === 'string' ? data.display_name : '',
      url: data.url,
      host: url.host,
      before: at >= 0 ? data.url.slice(0, at) : '',
      after: at >= 0 ? data.url.slice(at + url.host.length) : data.url,
      reason: typeof data.reason === 'string' ? data.reason : '',
      ...(replaces && typeof replaces.url === 'string'
        ? { replaces: { displayName: typeof replaces.display_name === 'string' ? replaces.display_name : '', url: replaces.url } }
        : {}),
    }
  } catch {
    return null
  }
}
