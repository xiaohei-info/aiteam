/**
 * 员工详情「用量」卡片：今日 / 近 7 天 / 全部，解决率来自 GET /api/agent/usage/outcomes。
 */
import { useEffect, useMemo, useState } from 'react'
import { useUsageOutcomes, useUsageStatistics } from '../../hooks/useUsageStatistics'
import { describeResolution, usageSuccessRate } from '../../lib/usageSummary'
import type { UsageRange } from '../../lib/usageWindow'
import UsageSummaryCard from './UsageSummaryCard'

const EMPLOYEE_RANGES: readonly UsageRange[] = ['today', 'week', 'all']
const EMPTY_TEXT: Record<UsageRange, string> = {
  today: '今天还没有使用这位员工',
  week: '近 7 天还没有使用这位员工',
  all: '还没有使用这位员工',
}

export default function EmployeeUsageCard({ employeeId }: { employeeId: string }) {
  const [range, setRange] = useState<UsageRange>('today')
  useEffect(() => { setRange('today') }, [employeeId])
  const scope = useMemo(() => ({ employee_id: employeeId }), [employeeId])
  const { state, retry } = useUsageStatistics(scope, range)
  const outcomes = useUsageOutcomes(employeeId, range)
  const resolution = outcomes ? describeResolution(outcomes) : null

  return (
    <UsageSummaryCard
      title="用量"
      ranges={EMPLOYEE_RANGES}
      range={range}
      onRangeChange={setRange}
      state={state}
      onRetry={retry}
      emptyText={EMPTY_TEXT[range]}
      execution={{ label: '执行', title: '员工执行次数，不是消息条数' }}
      fourth={(data) => {
        const rate = usageSuccessRate(data)
        return { label: '成功率', value: rate === null ? '—' : `${rate}%`, title: `成功 ${data.succeeded_count} 次 · 未成功 ${data.non_success_count} 次` }
      }}
      footnote="仅统计你在这台设备上的使用 · 按小时汇总 · USD"
    >
      {() => resolution && (
        <div className="usc-resolution">
          <span>解决率</span>
          <strong className="font-number">{resolution.value}</strong>
          <span>{resolution.detail}</span>
        </div>
      )}
    </UsageSummaryCard>
  )
}
