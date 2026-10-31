import { AgentApiError } from '../../api/agent'

/** 桌面原生选择器（Tauri invoke）返回的错误码 → 中文提示。 */
export function invokeErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (raw === 'cancelled') return '已取消：未选择任何目录。'
  if (raw === 'citation_expired') return '授权挑战已过期，请重试。'
  if (raw === 'authorization_unavailable') return '桌面授权桥接不可用，请重启应用后再试。'
  if (raw === 'source_overlaps_runtime') return '所选目录位于系统目录或本应用的运行/数据目录内，不能授权。请选择其他位置；磁盘根目录和用户主目录本身可以授权，但这些受保护目录会被自动排除。'
  if (raw === 'unauthorized') return '应用尚未授权访问该目录，请先在文件访问授权中允许后重试。'
  if (raw.includes('不支持此平台')) return '本地目录检索目前仅支持 macOS。'
  return raw || '操作失败，请重试。'
}

/** 把本地目录接口的鉴权类错误转成可行动的中文提示，避免只显示英文 detail 或静默失败。
 * 后端多种原因都返回 local_directory_unauthorized（身份未验签、员工已下架、授权版本变化等），提示不能断定是哪一种。 */
export function localDirectoryApiErrorText(error: unknown): string {
  if (error instanceof AgentApiError) {
    if (error.status === 403 && error.code === 'local_directory_unauthorized') {
      return '暂无权限访问本地目录：登录身份未通过验签，或员工、目录授权已变化。请重新登录或重新授权目录后重试；若仍失败，请检查本机 Agent 是否启用了开发认证（AITEAM_AGENT_DEV_AUTH=true）。'
    }
    if (error.status === 401 && error.code === 'unauthenticated') {
      return '尚未登录或登录已过期，请先登录后再使用本地目录检索。'
    }
  }
  return error instanceof Error ? error.message : '本地目录读取失败'
}

const STATUS_LABELS: Record<string, string> = {
  ready: '可用',
  authorization_unavailable: '桌面授权桥接不可用',
  unauthorized: '授权已失效',
  source_changed: '目录身份已变化',
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? `不可用（${status}）`
}
