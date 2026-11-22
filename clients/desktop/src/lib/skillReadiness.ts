import type { SkillReadinessItem } from '../api/agent/experts'
import { skillDisplayName, type SkillDetail } from './skillDisplay.ts'

/** 员工技能在本机的三种状态：可用 / 企业已移除 / 暂时不可用（设计 2026-11-22 §3.4）。 */
export interface SkillStateGroups {
  available: string[]
  removed: string[]
  unavailable: Array<{ name: string; why: string }>
}

// Agent 给出的原因代码 → 用户能看懂的说明。没收录的统一说「暂时不可用」。
const UNAVAILABLE_WHY: Record<string, string> = {
  skill_disabled: '企业已停用',
  skill_unfinished: '企业还没配置完成',
  skill_missing: '还没同步到本机，请稍后刷新',
}

export function groupSkillStates(skills: readonly SkillReadinessItem[] | undefined, details?: readonly SkillDetail[] | null): SkillStateGroups {
  const groups: SkillStateGroups = { available: [], removed: [], unavailable: [] }
  const seen = new Set<string>()
  for (const item of skills ?? []) {
    const name = skillDisplayName(item.ref, details)
    if (seen.has(name)) continue
    seen.add(name)
    if (item.status === 'ready') groups.available.push(name)
    else if (item.reason === 'skill_removed') groups.removed.push(name)
    else groups.unavailable.push({ name, why: UNAVAILABLE_WHY[item.reason ?? ''] ?? '暂时不可用' })
  }
  return groups
}

/** 有用不了的技能才需要提示；全部可用时不多说。 */
export function hasSkillProblems(groups: SkillStateGroups): boolean {
  return groups.removed.length > 0 || groups.unavailable.length > 0
}
