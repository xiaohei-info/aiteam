/**
 * 将服务端返回的头像地址转换为可直接用于 img.src 的 URL。
 *
 * Manager/Agent 的头像字段可能只返回路径，例如
 * `/api/agent/employees/:employee_id/avatar/content`；这类路径必须补上
 * 实际服务域名，不能让浏览器按当前前端页面地址解析。
 */
export function resolveAvatarUrl(
  avatarUrl: string | null | undefined,
  baseUrl: string,
): string | null {
  const value = avatarUrl?.trim()
  if (!value) return null

  // Keep absolute and protocol-relative CDN URLs intact. URL-like data/blob
  // values are also valid image sources and must not receive the API host.
  if (/^(?:https?:|data:|blob:|\/\/)/i.test(value)) {
    if (/^\/\//.test(value)) {
      return `https:${value}`
    }
    return value
  }

  const base = baseUrl.trim().replace(/\/+$/, '')
  if (!base) return value
  return `${base}/${value.replace(/^\/+/, '')}`
}
