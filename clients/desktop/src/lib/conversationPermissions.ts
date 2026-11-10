import type { ConversationWorkspaces, PermissionMode } from '../api/agent/types.ts'

/** 占位会话 emp_<员工 ID>：还没真正创建，也还没有添加任何目录。 */
export function isDraftConversation(conversationId: string): boolean {
  return conversationId.startsWith('emp_')
}

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  'read-only': '只读',
  'workspace-write': '工作区可写',
  'full-access': '完全访问',
}

/** 开启完全访问前需要逐项确认的授权内容；聊天页与自动化任务表单共用。 */
export const FULL_ACCESS_GRANTS = ['读取和修改工作区外的文件', '执行本机命令', '访问网络']

/** 权限按钮上的状态汇总：会话权限 + 本会话添加的目录数。 */
export function permissionSummary(mode: PermissionMode, enabledDirectoryCount: number): string {
  const label = PERMISSION_MODE_LABELS[mode] ?? PERMISSION_MODE_LABELS['read-only']
  return enabledDirectoryCount > 0 ? `${label} · ${enabledDirectoryCount} 个目录` : label
}

/**
 * 会话在受管根目录下的工作目录名。群聊成员共用一个目录；私聊优先取当前入口员工的，
 * 换过员工的旧私聊没有匹配时取仍在会话内的第一个。没有受管目录时为 null。
 */
export function conversationWorkspaceKey(item: ConversationWorkspaces | undefined, entryEmployeeId: string | null): string | null {
  const all = item?.workspaces ?? []
  const live = all.filter(workspace => !workspace.removed)
  const pool = live.length > 0 ? live : all
  const own = entryEmployeeId ? pool.find(workspace => workspace.employee_id === entryEmployeeId) : undefined
  return (own ?? pool[0])?.workspace_key ?? null
}
