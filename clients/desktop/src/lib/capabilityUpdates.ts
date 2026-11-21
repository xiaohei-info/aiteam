/**
 * 能力更新红点（设计「技能MCP命名空间出处与更新提示」§4.5b）：
 * 统计企业目录里本机已装、且企业发布了新版本的技能 / MCP；决定什么时候再查一次。
 * 只是本机主动拉企业目录，企业端不向用户电脑推送。
 */
import type { CatalogMcp, InstallableSkill } from '../api/agent/types'

export type CapabilityUpdateCounts = { skills: number; mcps: number }

/** 状态由本机 Agent 算好：update = 本机装的是旧版本。只数本机确实装过的条目。 */
export function countCapabilityUpdates(
  skills: readonly Pick<InstallableSkill, 'state' | 'local_ref'>[],
  mcps: readonly Pick<CatalogMcp, 'state'>[],
): CapabilityUpdateCounts {
  return {
    skills: skills.filter((item) => item.state === 'update' && Boolean(item.local_ref)).length,
    mcps: mcps.filter((item) => item.state === 'update').length,
  }
}

/** 定时检查间隔：10 分钟。 */
export const CAPABILITY_CHECK_INTERVAL_MS = 10 * 60 * 1000
/** 切回窗口时最短间隔：1 分钟内来回切换不重复请求。 */
export const CAPABILITY_FOCUS_MIN_GAP_MS = 60 * 1000

export function shouldCheckOnFocus(lastCheckedAt: number | null, now: number, minGapMs = CAPABILITY_FOCUS_MIN_GAP_MS): boolean {
  return lastCheckedAt === null || now - lastCheckedAt >= minGapMs
}

/** 侧栏 / 分栏标题上红点的读屏文案。 */
export function capabilityUpdateLabel(count: number): string {
  return `${count} 项有更新`
}
