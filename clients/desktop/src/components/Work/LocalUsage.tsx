import { useEffect, useState } from 'react'
import { agentApi } from '../../api/agent'
import type { UsageStatistics } from '../../api/agent/observations.types'
import { formatUsdDecimal } from '../../lib/workRecords'
import { useAgentAuthStore } from '../../stores/agentAuth'

export default function LocalUsage({ employeeId }: { employeeId?: string }) {
  const identity = useAgentAuthStore(state => state.token)
  const [usage, setUsage] = useState<UsageStatistics | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    setUsage(null); setError('')
    const refresh = async () => {
      try {
        const result = await agentApi.getUsageStatistics({ employee_id: employeeId }, controller.signal)
        if (!controller.signal.aborted) { setUsage(result); setError('') }
      } catch { if (!controller.signal.aborted) setError('本机用量暂不可用') }
      finally { if (!controller.signal.aborted) timer = setTimeout(refresh, 10000) }
    }
    void refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [identity, employeeId, attempt])
  return <section className="p-4 text-xs" aria-label="本机执行统计">
    <h3 className="mb-2 text-sm">本机执行统计 · 全部留存小时摘要</h3>
    {error ? <p role="alert">{error} <button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></p> : !usage ? <p role="status">正在读取统计…</p> : <>
      <div className="flex flex-wrap gap-5"><span>员工执行次数 <strong>{usage.execution_count}</strong></span><span>Token <strong>{usage.token_total}</strong></span><span>总费用 <strong>{formatUsdDecimal(usage.cost_total)}</strong></span></div>
      {usage.cost_total === null && <p className="mt-2">已知费用小计 {formatUsdDecimal(usage.known_cost_total)}；{usage.unpriced_execution_count} 次执行未定价</p>}
      {usage.excluded_summary_count > 0 && <p>有 {usage.excluded_summary_count} 条摘要无法计入统计</p>}
      <p className="text-txt-muted mt-2">仅当前成员、当前设备已记录的员工执行；群投递可能触发多次执行。</p>
    </>}
  </section>
}
