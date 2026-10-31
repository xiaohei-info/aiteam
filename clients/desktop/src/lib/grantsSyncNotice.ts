/** 部分同步提示里的员工名称：有本地投影时用展示名，否则退回员工 ID（从未同步过的员工没有投影）。 */
export function skippedEmployeeLabels(
  skippedIds: readonly string[],
  experts: readonly { employee_id: string; display_name?: unknown }[],
): string[] {
  const names = new Map(experts.map((expert) => [expert.employee_id, expert.display_name]))
  return skippedIds.map((id) => {
    const name = names.get(id)
    return typeof name === 'string' && name.trim() ? name.trim() : id
  })
}

/**
 * 重新同步后提示的新状态：返回 null 表示同步期间已登出或切换会话，丢弃结果；
 * 否则返回本次未更新的员工，空数组即完整同步、提示消失。
 */
export function grantsSyncRetryResult(requestToken: string, currentToken: string | null, skipped: readonly string[]): string[] | null {
  return currentToken === requestToken ? [...skipped] : null
}
