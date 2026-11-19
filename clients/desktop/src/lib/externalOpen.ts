import { invoke, isTauri } from '@tauri-apps/api/core'

/**
 * 打开外部页面 / 在文件管理器中显示。
 *
 * 安全边界沿用现有 `open_portal_in_browser` 的风格：**不接受任意 URL**，只放行明确的平台主机
 * （当前只有 ClawHub）。名单在 Rust 侧再校验一次，前端校验只是先给出可读报错。
 */

/** 允许打开的外部平台主机（精确匹配，含端口无关）。 */
const ALLOWED_HOSTS = new Set(['clawhub.ai', 'www.clawhub.ai'])

export function isAllowedExternalUrl(raw: string): boolean {
  let url: URL
  try { url = new URL(raw) } catch { return false }
  if (url.protocol !== 'https:') return false
  return ALLOWED_HOSTS.has(url.hostname.toLowerCase())
}

/** 打开平台页面（如 ClawHub 技能页）；非 Tauri 环境退回新窗口。 */
export async function openExternalUrl(raw: string): Promise<void> {
  if (!isAllowedExternalUrl(raw)) throw new Error('不允许打开该地址')
  if (isTauri()) {
    await invoke<void>('open_external_url', { url: raw })
    return
  }
  window.open(raw, '_blank', 'noopener,noreferrer')
}

/** 在文件管理器中显示本机技能目录（macOS 为 Finder，Windows 为资源管理器）。 */
export async function revealInFileManager(path: string): Promise<void> {
  if (!path) throw new Error('没有可显示的本机目录')
  await invoke<void>('reveal_in_file_manager', { path })
}
