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

/** 首次检查前的随机延迟上限：许多成员同时上线（例如企业端重启后）时，错开对企业端的请求。 */
export const CAPABILITY_FIRST_CHECK_JITTER_MS = 60 * 1000

export function firstCheckDelay(random: () => number = Math.random, maxMs = CAPABILITY_FIRST_CHECK_JITTER_MS): number {
  return Math.floor(Math.max(0, Math.min(1, random())) * maxMs)
}

export type CapabilityCheckerDeps = {
  /** 同步专家配置（管理员配给专家的技能新版本随之下发）；失败自己吞掉。 */
  syncGrants: () => Promise<void>
  /** 有回复正在生成：同步会清掉旧版本技能文件，此时不同步。 */
  isReplying: () => boolean
  /** 读两个企业目录并更新红点。 */
  readCatalogs: () => Promise<void>
}

export type CapabilityChecker = {
  check: (options?: { syncGrants?: boolean }) => Promise<void>
  /** 因为正在回复而推迟了同步：回复结束后应立即补一次。 */
  hasDeferredSync: () => boolean
  reset: () => void
}

/**
 * 检查的排队规则：
 * - 同一时刻只跑一次；跑的过程中又来了「要同步」的请求，跑完接着补一次同步，不丢。
 * - 正在回复时跳过同步并记下，下一次检查（含回复结束后的补检查）先把它补上。
 */
export function createCapabilityChecker(deps: CapabilityCheckerDeps): CapabilityChecker {
  let inFlight: Promise<void> | null = null
  let queuedSync = false
  let deferredSync = false

  async function once(sync: boolean): Promise<void> {
    if (sync || deferredSync) {
      if (deps.isReplying()) deferredSync = true
      else {
        deferredSync = false
        await deps.syncGrants()
      }
    }
    await deps.readCatalogs()
  }

  return {
    check(options) {
      const sync = Boolean(options?.syncGrants)
      if (inFlight) {
        if (sync) queuedSync = true
        return inFlight
      }
      inFlight = (async () => {
        await once(sync)
        while (queuedSync) {
          queuedSync = false
          await once(true)
        }
      })().finally(() => { inFlight = null })
      return inFlight
    },
    hasDeferredSync: () => deferredSync,
    reset() {
      queuedSync = false
      deferredSync = false
    },
  }
}
