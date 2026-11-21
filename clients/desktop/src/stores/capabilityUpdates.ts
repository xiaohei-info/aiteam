/**
 * 能力更新检查（设计「技能MCP命名空间出处与更新提示」§4.5b）。
 * 侧栏「能力」和能力页「MCP」「技能」标题的红点都读这里；能力页读到目录后也写回这里，两处数字一致。
 * 检查 = 本机主动向企业端拉：先同步专家配置（管理员配给专家的技能新版本随之下发），再读两个企业目录。
 */
import { create } from 'zustand'
import { agentApi } from '../api/agent'
import type { CatalogMcp, InstallableSkill } from '../api/agent/types'
import { countCapabilityUpdates } from '../lib/capabilityUpdates'
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
  reset: () => void
}

let inFlight: Promise<void> | null = null

export const useCapabilityUpdatesStore = create<CapabilityUpdatesState>((set) => ({
  skillUpdates: 0,
  mcpUpdates: 0,
  lastCheckedAt: null,
  setCatalog: (skills, mcps) => {
    const counts = countCapabilityUpdates(skills, mcps)
    set({ skillUpdates: counts.skills, mcpUpdates: counts.mcps, lastCheckedAt: Date.now() })
  },
  check: (options) => {
    if (inFlight) return inFlight
    const run = async () => {
      const auth = useAgentAuthStore.getState()
      const generation = auth.sessionGeneration
      const tenantId = auth.tenantId
      const memberId = auth.claims?.user_id
      // 有回复正在生成时不同步专家配置：同步会清掉旧版本技能文件，留给下一次检查。
      const replying = useChatStore.getState().generatingConvIds.size > 0
      if (options?.syncGrants && tenantId && memberId && !replying) {
        await agentApi.syncGrants({ tenant_id: tenantId, member_id: memberId }).catch(() => undefined)
      }
      const [skills, mcps] = await Promise.allSettled([agentApi.listInstallableSkills(), agentApi.listInstallableMcpServers()])
      if (useAgentAuthStore.getState().sessionGeneration !== generation) return
      // 读不到的一侧保留上次的数字：企业端暂时不可达不该让红点忽闪。
      set((state) => ({
        skillUpdates: skills.status === 'fulfilled' ? countCapabilityUpdates(skills.value, []).skills : state.skillUpdates,
        mcpUpdates: mcps.status === 'fulfilled' ? countCapabilityUpdates([], mcps.value).mcps : state.mcpUpdates,
        lastCheckedAt: Date.now(),
      }))
    }
    inFlight = run().finally(() => { inFlight = null })
    return inFlight
  },
  reset: () => set({ skillUpdates: 0, mcpUpdates: 0, lastCheckedAt: null }),
}))
