/**
 * 「已经装好了」不是失败，是状态。
 *
 * 安装技能 / MCP 时撞同名，服务端返回 409（`skill_exists` / `mcp_exists`）。以前界面把它当错误红字显示，
 * 语气生硬（「确认后覆盖」「未安装」）。实际上这个能力此刻就能用，所以这里把它识别出来，交给界面
 * 展示成中性的「已安装」状态，并把是否覆盖的决定权温和地留给用户。
 */

/** 409 且是同名已装的错误码。 */
/** 只认结构，不依赖 AgentApiError 的具体实现（测试与调用点都更省事）。 */
export interface AlreadyInstalledProblem { status?: number; code?: string; message?: string }

export function isAlreadyInstalledError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const problem = error as AlreadyInstalledProblem
  return problem.status === 409 && (problem.code === 'skill_exists' || problem.code === 'mcp_exists')
}

/** 批量安装结果里「已装」的条目也按状态看，不算失败。 */
export function isAlreadyInstalledResult(item: { ok: boolean; reason?: string }): boolean {
  return !item.ok && /已经装好了|已安装/.test(item.reason ?? '')
}

/**
 * 面向用户的说明。服务端的 detail 已经带版本，这里只在缺版本时兜底，不重复拼接。
 * 返回 null 表示这不是「已安装」，界面应照原样显示错误。
 */
export function alreadyInstalledText(error: unknown): string | null {
  if (!isAlreadyInstalledError(error)) return null
  const message = typeof (error as AlreadyInstalledProblem).message === 'string' ? (error as AlreadyInstalledProblem).message!.trim() : ''
  return message || '这个能力已经装好了，无需重复添加。'
}

/** 批量结果的汇总：已装的计入「已装」，不计入失败。 */
export function partitionInstallResults<T extends { ok: boolean; reason?: string }>(results: T[]): { installed: T[]; already: T[]; failed: T[] } {
  const installed: T[] = []
  const already: T[] = []
  const failed: T[] = []
  for (const item of results) {
    if (item.ok) installed.push(item)
    else if (isAlreadyInstalledResult(item)) already.push(item)
    else failed.push(item)
  }
  return { installed, already, failed }
}
