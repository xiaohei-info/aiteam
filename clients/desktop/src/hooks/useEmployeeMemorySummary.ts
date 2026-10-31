import { useCallback, useEffect, useState } from 'react'
import { agentApi } from '../api/agent'
import type { EmployeeMemorySummary } from '../api/agent/employeeMemories'
import { describeMemoryProblem } from '../lib/employeeMemory'

export type MemorySummaryState =
  | { status: 'loading' }
  | { status: 'ready'; data: EmployeeMemorySummary }
  | { status: 'error' }
  // 旧版随包 Agent 没有记忆路由:员工详情隐藏「查看全部」。
  | { status: 'unsupported' }

/** 员工记忆条数(scope=mine);employeeId 为 null 时不请求。删除后调用 reload 刷新。 */
export function useEmployeeMemorySummary(employeeId: string | null) {
  const [state, setState] = useState<MemorySummaryState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => { setState({ status: 'loading' }) }, [employeeId])
  useEffect(() => {
    if (!employeeId) return undefined
    const controller = new AbortController()
    agentApi.getEmployeeMemorySummary(employeeId, 'mine', controller.signal)
      .then((data) => { if (!controller.signal.aborted) setState({ status: 'ready', data }) })
      .catch((error) => {
        if (controller.signal.aborted) return
        setState(describeMemoryProblem(error).kind === 'unsupported' ? { status: 'unsupported' } : { status: 'error' })
      })
    return () => controller.abort()
  }, [employeeId, attempt])

  const reload = useCallback(() => setAttempt((value) => value + 1), [])
  return { state, reload }
}
