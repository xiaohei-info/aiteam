import { useEffect, useState } from 'react'
import { agentApi } from '../api/agent'
import { groupSkillStates, type SkillStateGroups } from '../lib/skillReadiness'
import type { SkillDetail } from '../lib/skillDisplay'

/** 员工技能在本机的三种状态；查询失败或旧版 Agent 没给就返回 null（不提示，不影响页面）。 */
export function useEmployeeSkillStates(employeeId: string | null | undefined, details?: readonly SkillDetail[] | null): SkillStateGroups | null {
  const [groups, setGroups] = useState<SkillStateGroups | null>(null)
  useEffect(() => {
    setGroups(null)
    if (!employeeId) return undefined
    let alive = true
    agentApi.getExpertReadiness(employeeId)
      .then((readiness) => { if (alive && readiness.skills) setGroups(groupSkillStates(readiness.skills, details)) })
      .catch(() => {})
    return () => { alive = false }
    // details 只用于取展示名，员工换了才重新查
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId])
  return groups
}
