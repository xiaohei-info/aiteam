/**
 * 能力更新检查（设计「技能MCP命名空间出处与更新提示」§4.5b）。
 * 侧栏「能力」和能力页「MCP」「技能」标题的红点都读这里；能力页读到目录后也写回这里，两处数字一致。
 * 检查 = 本机主动向企业端拉：先同步专家配置（管理员配给专家的技能新版本随之下发），再读两个企业目录。
 */
import { create } from 'zustand'
import { agentApi } from '../api/agent'
import type { CatalogMcp, InstallableSkill } from '../api/agent/types'
import { countCapabilityUpdates, createCapabilityChecker } from '../lib/capabilityUpdates'
import { useAgentAuthStore } from './agentAuth'
import { useChatStore } from './chat'

type CapabilityUpdatesState = {
  skillUpdates: number
  mcpUpdates: number
  lastCheckedAt: number | null
  /** 能力页读到目录后调用，红点跟页面上的「有更新」保持一致。 */
  setCatalog: (skills: readonly InstallableSkill[], mcps: readonly CatalogMcp[]) => void
  /** syncGrants：顺带同步专家配置。启动时登录刚同步过，不必再做。 */
  check: (options?: { syncGrants?: boolean }) => Promise<void>
  /** 因为正在回复推迟了同步：回复结束后补一次。 */
  hasDeferredSync: () => boolean
  reset: () => void
}

export const useCapabilityUpdatesStore = create<CapabilityUpdatesState>((set) => {
  const checker = createCapabilityChecker({
    syncGrants: async () => {
      const auth = useAgentAuthStore.getState()
      const memberId = auth.claims?.user_id
      if (!auth.tenantId || !memberId) return
      await agentApi.syncGrants({ tenant_id: auth.tenantId, member_id: memberId }).catch(() => undefined)
    },
    isReplying: () => useChatStore.getState().generatingConvIds.size > 0,
    readCatalogs: async () => {
      const generation = useAgentAuthStore.getState().sessionGeneration
      const [skills, mcps] = await Promise.allSettled([agentApi.listInstallableSkills(), agentApi.listInstallableMcpServers()])
      if (useAgentAuthStore.getState().sessionGeneration !== generation) return
      // 读不到的一侧保留上次的数字：企业端暂时不可达不该让红点忽闪。
      set((state) => ({
        skillUpdates: skills.status === 'fulfilled' ? countCapabilityUpdates(skills.value, []).skills : state.skillUpdates,
        mcpUpdates: mcps.status === 'fulfilled' ? countCapabilityUpdates([], mcps.value).mcps : state.mcpUpdates,
        lastCheckedAt: Date.now(),
      }))
    },
  })
  return {
    skillUpdates: 0,
    mcpUpdates: 0,
    lastCheckedAt: null,
    setCatalog: (skills, mcps) => {
      const counts = countCapabilityUpdates(skills, mcps)
      set({ skillUpdates: counts.skills, mcpUpdates: counts.mcps, lastCheckedAt: Date.now() })
    },
    check: (options) => checker.check(options),
    hasDeferredSync: () => checker.hasDeferredSync(),
    reset: () => {
      checker.reset()
      set({ skillUpdates: 0, mcpUpdates: 0, lastCheckedAt: null })
    },
  }
})
