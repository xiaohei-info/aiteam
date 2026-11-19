/**
 * `capability_install` 审批的摘要解析。
 *
 * Agent 在审批摘要里放的是 `capability_install: {json}`：
 * - MCP：完整地址、模型写的名称与理由；
 * - 技能：企业技能目录里的名称与版本；
 * 以及与已装同名能力冲突时要替换的条目（replaces）。弹窗据此专门渲染，
 * 保证 URL 完整显示、主机名突出；冲突时由用户选择覆盖、改名（仅 MCP）或取消。
 */
export interface CapabilityInstallPreview {
  kind: 'mcp' | 'skill'
  ref: string
  displayName: string
  /** MCP 地址；技能为空。 */
  url: string
  /** 地址拆分：主机名单独突出，其余部分弱化显示。 */
  host: string
  before: string
  after: string
  /** 技能版本；MCP 为空。 */
  version: string
  reason: string
  /** 来源：platform_catalog 平台目录 / enterprise_catalog 企业自建技能 / user_url 手动地址；旧版 Agent 为空。 */
  source: string
  /** 来源是平台目录：弹窗可提供「以后直接安装」。 */
  platform: boolean
  /** MCP 鉴权方式（MCP 鉴权 2026-11-18）：oauth 批准后到服务方网页登录；bearer 在弹窗里填令牌。旧版 Agent 为 none。 */
  auth: 'none' | 'oauth' | 'bearer'
  /** oauth：服务方登录页主机名。 */
  authHost: string
  /** bearer：携带令牌的请求头名；空 = Authorization: Bearer。 */
  authHeader: string
  replaces?: { displayName: string; url: string; version: string }
}

const PREFIX = 'capability_install:'
const REF_RE = /^[a-z][a-z0-9_-]{0,63}$/
const text = (value: unknown) => (typeof value === 'string' ? value : '')

export function parseCapabilityInstall(toolName: string, summary: string): CapabilityInstallPreview | null {
  if (toolName !== 'capability_install' || !summary.startsWith(PREFIX)) return null
  try {
    const data = JSON.parse(summary.slice(PREFIX.length).trim()) as Record<string, unknown>
    const kind = data.kind === 'skill' ? 'skill' : 'mcp'
    const raw = data.replaces as { display_name?: unknown; url?: unknown; version?: unknown } | undefined
    const replaces = raw && typeof raw === 'object'
      ? { replaces: { displayName: text(raw.display_name), url: text(raw.url), version: text(raw.version) } }
      : {}
    const source = text(data.source)
    const auth = kind === 'mcp' && (data.auth === 'oauth' || data.auth === 'bearer') ? data.auth : 'none'
    const base = {
      kind, ref: text(data.ref), displayName: text(data.display_name), reason: text(data.reason), version: text(data.version), source,
      platform: source === 'platform_catalog', auth, authHost: text(data.auth_host), authHeader: text(data.auth_header), ...replaces,
    } as const
    if (kind === 'skill') return base.ref ? { ...base, url: '', host: '', before: '', after: '' } : null
    if (typeof data.url !== 'string' || !data.url) return null
    const url = new URL(data.url)
    const at = data.url.indexOf(url.host)
    return {
      ...base,
      url: data.url,
      host: url.host,
      before: at >= 0 ? data.url.slice(0, at) : '',
      after: at >= 0 ? data.url.slice(at + url.host.length) : data.url,
    }
  } catch {
    return null
  }
}

/**
 * 该来源是否允许成员勾「本会话不再询问」。
 * 外部来源（ClawHub / 网址 / 粘贴）不允许：新技能安装每次都问（设计 2026-11-19 §3.2）。
 */
export function sessionGrantAllowed(install: CapabilityInstallPreview | null): boolean {
  if (!install || install.kind !== 'skill') return false
  return install.source === 'platform_catalog' || install.source === 'enterprise_catalog'
}

/** 改名安装的新标识：小写字母开头，只含小写字母、数字、- 或 _，且不能与原标识相同。返回错误文案，合法返回 null。 */
export function renameProblem(value: string, current: string): string | null {
  const ref = value.trim()
  if (!ref) return '请输入新的标识'
  if (!REF_RE.test(ref)) return '以小写字母开头，只能包含小写字母、数字、- 或 _，最长 64 个字符'
  if (ref === current) return '新标识不能与已安装的相同'
  return null
}
