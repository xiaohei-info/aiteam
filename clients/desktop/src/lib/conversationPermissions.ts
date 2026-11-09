import type { PermissionMode } from '../api/agent/types.ts'

/** 占位会话 emp_<员工 ID>：还没真正创建，也还没有添加任何目录。 */
export function isDraftConversation(conversationId: string): boolean {
  return conversationId.startsWith('emp_')
}

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  'read-only': '只读',
  'workspace-write': '工作区可写',
  'full-access': '完全访问',
}

/** 权限按钮上的状态汇总：会话权限 + 本会话添加的目录数。 */
export function permissionSummary(mode: PermissionMode, enabledDirectoryCount: number): string {
  const label = PERMISSION_MODE_LABELS[mode] ?? PERMISSION_MODE_LABELS['read-only']
  return enabledDirectoryCount > 0 ? `${label} · ${enabledDirectoryCount} 个目录` : label
}
