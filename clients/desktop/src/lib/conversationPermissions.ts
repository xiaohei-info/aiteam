import type { ConversationMetadata } from '../api/agent/types.ts'

/**
 * 目录检索对哪个员工生效：占位会话 emp_<id> 直接取 id，已建会话取元数据里的入口员工。
 * 私聊的 kind 有 'chat'（手动新建）和 'private'（自动化任务），统一只排除群聊，与服务端判定一致。
 */
export function directoryEmployeeIdOf(conversationId: string, metadata: Pick<ConversationMetadata, 'kind' | 'entry_employee_id'> | null): string | null {
  if (conversationId.startsWith('emp_')) return conversationId.slice(4)
  return metadata && metadata.kind !== 'group' ? metadata.entry_employee_id : null
}

/** 权限按钮上的状态汇总：会话权限 + 对当前员工开启的检索目录数，两项设置各自独立。 */
export function permissionSummary(fullAccess: boolean, enabledDirectoryCount: number): string {
  const mode = fullAccess ? '完全访问' : '只读'
  return enabledDirectoryCount > 0 ? `${mode} · ${enabledDirectoryCount} 个目录` : mode
}
