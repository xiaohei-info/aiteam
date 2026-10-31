import { useEffect, useRef, useState } from 'react'
import { agentApi, AgentApiError } from '../api/agent'
import type { UsageStatisticsQuery } from '../api/agent/observations'
import type { UsageOutcomes, UsageStatistics } from '../api/agent/observations.types'
import { usageRangeWindow, type UsageRange } from '../lib/usageWindow'
import { useOfficeMilestoneStore } from '../stores/officeMilestones'

export type UsageLoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: UsageStatistics }
  | { status: 'error' }
  // 旧版随包 Agent：没有该接口（404），或不认识 conversation_id / group_by（422 invalid_query）。
  | { status: 'unsupported' }

export type UsageScope = Pick<UsageStatisticsQuery, 'employee_id' | 'conversation_id' | 'group_by'>

const USAGE_CACHE_MS = 60_000

function isUnsupported(error: unknown): boolean {
  return error instanceof AgentApiError && (error.status === 404 || (error.status === 422 && error.code === 'invalid_query'))
}

/**
 * 详情面板的用量：切换时间范围时才请求，每个范围的结果缓存 60 秒；打开期间 60 秒轮询，
 * 员工回复结束（usageVersion 递增）时立即刷新。刷新期间保留上次的数字，不闪回骨架。
 */
export function useUsageStatistics(scope: UsageScope | null, range: UsageRange) {
  const usageVersion = useOfficeMilestoneStore((s) => s.usageVersion)
  const cache = useRef(new Map<string, { data: UsageStatistics; at: number }>())
  // 早于该时刻的缓存视为过期：usageVersion 递增或点「重试」后必须重新请求。
  const staleBefore = useRef(0)
  const seenVersion = useRef(usageVersion)
  const [state, setState] = useState<UsageLoadState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const scopeKey = scope ? JSON.stringify(scope) : null

  useEffect(() => {
    if (!scopeKey) return undefined
    if (seenVersion.current !== usageVersion) { seenVersion.current = usageVersion; staleBefore.current = Date.now() }
    const query = JSON.parse(scopeKey) as UsageScope
    const cacheKey = `${scopeKey}|${range}`
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      const cached = cache.current.get(cacheKey)
      const age = cached ? Date.now() - cached.at : Infinity
      if (cached && cached.at > staleBefore.current && age < USAGE_CACHE_MS) {
        setState({ status: 'ready', data: cached.data })
        timer = setTimeout(() => void refresh(), USAGE_CACHE_MS - age)
        return
      }
      if (cached) setState({ status: 'ready', data: cached.data })
      else setState((current) => current.status === 'unsupported' ? current : { status: 'loading' })
      try {
        // 每次请求重算时间窗：跨天、跨小时后随之滚动。
        const data = await agentApi.getUsageStatistics({ ...query, ...usageRangeWindow(range) }, controller.signal)
        if (controller.signal.aborted) return
        cache.current.set(cacheKey, { data, at: Date.now() })
        setState({ status: 'ready', data })
      } catch (error) {
        if (controller.signal.aborted) return
        if (isUnsupported(error)) { setState({ status: 'unsupported' }); return }
        if (!cached) setState({ status: 'error' })
      }
      timer = setTimeout(() => void refresh(), USAGE_CACHE_MS)
    }
    void refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [scopeKey, range, usageVersion, attempt])

  const retry = () => { staleBefore.current = Date.now(); setAttempt((value) => value + 1) }
  return { state, retry }
}

/** 员工的段落解决率；旧版 Agent 没有该接口或请求失败时为 null，卡片隐藏这一行。 */
export function useUsageOutcomes(employeeId: string | null, range: UsageRange): UsageOutcomes | null {
  const usageVersion = useOfficeMilestoneStore((s) => s.usageVersion)
  const [outcomes, setOutcomes] = useState<UsageOutcomes | null>(null)

  useEffect(() => { setOutcomes(null) }, [employeeId, range])
  useEffect(() => {
    if (!employeeId) return undefined
    const controller = new AbortController()
    agentApi.getUsageOutcomes({ employee_id: employeeId, ...usageRangeWindow(range) }, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setOutcomes(result) })
      .catch(() => { if (!controller.signal.aborted) setOutcomes(null) })
    return () => controller.abort()
  }, [employeeId, range, usageVersion])

  return outcomes
}
