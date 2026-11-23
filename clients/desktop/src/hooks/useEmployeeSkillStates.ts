import { useEffect, useMemo, useState } from 'react'
import { agentApi } from '../api/agent'
import type { SkillReadinessItem } from '../api/agent/experts'
import { groupSkillStates, type SkillStateGroups } from '../lib/skillReadiness'
import type { SkillDetail } from '../lib/skillDisplay'

/**
 * 员工技能在本机的三种状态；查询失败或旧版 Agent 没给就返回 null（不提示，不影响页面）。
 * 只按员工查询一次就绪数据；展示名（details）后到也会按它重新分组，不会停留在内部标识。
 */
export function useEmployeeSkillStates(employeeId: string | null | undefined, details?: readonly SkillDetail[] | null): SkillStateGroups | null {
  const [skills, setSkills] = useState<SkillReadinessItem[] | null>(null)
  useEffect(() => {
    setSkills(null)
    if (!employeeId) return undefined
    let alive = true
    agentApi.getExpertReadiness(employeeId)
      .then((readiness) => { if (alive && readiness.skills) setSkills(readiness.skills) })
      .catch(() => {})
    return () => { alive = false }
  }, [employeeId])
  return useMemo(() => (skills ? groupSkillStates(skills, details) : null), [skills, details])
}
