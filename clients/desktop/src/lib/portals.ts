import { invoke, isTauri } from '@tauri-apps/api/core'

export interface Portal {
  key: string
  name: string
  url: string
  summary: string
  features: string[]
}

// Keep in sync with PORTALS in src-tauri/src/external_links.rs.
export const PORTALS: readonly Portal[] = [
  {
    key: 'taiyi-ops',
    name: '太乙统一运营端',
    url: 'http://121.40.78.201:8781/',
    summary: '平台运营与配置',
    features: ['开通企业账号', '配置专家与解决方案', '配置大模型'],
  },
  {
    key: 'enterprise-admin',
    name: '企业后台管理端',
    url: 'http://121.40.78.201:8782/',
    summary: '企业管理与资产',
    features: ['招募专家', '应用解决方案', '企业内部账号管理', '企业记忆与知识库管理', '充值与消费情况'],
  },
  {
    key: 'agent-user',
    name: '用户智能体端',
    url: 'http://121.40.78.201:8783/',
    summary: '数字员工协作',
    features: ['数字员工私聊', '群聊与协作', '用量信息'],
  },
]

// Reject anything that is not a plain http(s) URL pointing at one of the known portal origins.
export function safePortalUrl(raw: string): string {
  let url: URL
  let knownOrigins: string[]
  try {
    url = new URL(raw)
    knownOrigins = PORTALS.map(item => new URL(item.url).origin)
  } catch {
    throw new Error('不允许打开该地址')
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password
    || !knownOrigins.includes(url.origin)) {
    throw new Error('不允许打开该地址')
  }
  return url.href
}

export async function openPortal(key: string): Promise<void> {
  // Resolve against the fixed list so only known portal URLs can ever be opened.
  const portal = PORTALS.find(item => item.key === key)
  if (!portal) throw new Error('未知的入口')
  if (isTauri()) {
    await invoke<void>('open_portal_in_browser', { key: portal.key })
    return
  }
  const opened = window.open(safePortalUrl(portal.url), '_blank', 'noopener,noreferrer')
  if (!opened) throw new Error('浏览器拦截了新窗口，请允许弹窗后重试。')
}
