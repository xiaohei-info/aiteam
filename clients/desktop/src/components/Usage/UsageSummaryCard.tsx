/**
 * 员工详情与群聊详情共用的用量卡片：时间切换 + Token / 费用 / 执行 / 第四项四个数字。
 * 只负责展示；数据由 useUsageStatistics 读取。旧版 Agent 不支持时整张卡片隐藏。
 */
import type { ReactNode } from 'react'
import { BarChart3 } from 'lucide-react'
import type { UsageStatistics } from '../../api/agent/observations.types'
import type { UsageLoadState } from '../../hooks/useUsageStatistics'
import { describeUsageCost, describeUsageTokens, formatTokenCount } from '../../lib/usageSummary'
import { USAGE_RANGE_LABELS, type UsageRange } from '../../lib/usageWindow'
import './UsageSummaryCard.css'

export interface UsageMetric { label: string; value: string; title?: string }

interface UsageSummaryCardProps {
  title: string
  ranges: readonly UsageRange[]
  range: UsageRange
  onRangeChange: (range: UsageRange) => void
  state: UsageLoadState
  onRetry: () => void
  emptyText: string
  execution: Omit<UsageMetric, 'value'>
  fourth: (data: UsageStatistics) => UsageMetric
  footnote: string
  // 合计区下方的扩展内容，例如按成员拆分、解决率；仅有数据时显示。
  children?: (data: UsageStatistics) => ReactNode
}

export default function UsageSummaryCard({
  title, ranges, range, onRangeChange, state, onRetry, emptyText, execution, fourth, footnote, children,
}: UsageSummaryCardProps) {
  if (state.status === 'unsupported') return null
  const data = state.status === 'ready' ? state.data : null
  const empty = data !== null && data.execution_count === 0

  return (
    <section className="adp-card usc" aria-label={title}>
      <div className="adp-card-header">
        <BarChart3 size={13} strokeWidth={1.8} className="adp-card-icon" />
        <span className="adp-card-title">{title}</span>
        <div className="usc-ranges" role="radiogroup" aria-label="时间范围">
          {ranges.map((item) => (
            <button
              key={item}
              type="button"
              role="radio"
              aria-checked={item === range}
              className={item === range ? 'active' : undefined}
              onClick={() => onRangeChange(item)}
            >
              {USAGE_RANGE_LABELS[item]}
            </button>
          ))}
        </div>
      </div>

      {state.status === 'error' ? (
        <p className="usc-state" role="alert">
          用量暂不可用 · <button type="button" className="usc-retry" onClick={onRetry}>重试</button>
        </p>
      ) : empty ? (
        <p className="usc-state">{emptyText}</p>
      ) : (
        <UsageMetrics data={data} execution={execution} fourth={fourth} />
      )}

      {data && !empty && children?.(data)}
      <p className="usc-footnote">ⓘ {footnote}</p>
    </section>
  )
}

function UsageMetrics({ data, execution, fourth }: {
  data: UsageStatistics | null
  execution: Omit<UsageMetric, 'value'>
  fourth: (data: UsageStatistics) => UsageMetric
}) {
  if (!data) {
    return (
      <div className="usc-metrics" role="status" aria-label="正在读取用量">
        {[0, 1, 2, 3].map((index) => <div key={index} className="usc-metric"><span className="usc-skeleton" /><span className="usc-skeleton short" /></div>)}
      </div>
    )
  }
  const cost = describeUsageCost(data)
  const tokens = describeUsageTokens(data)
  const metrics: UsageMetric[] = [
    { label: 'Token', value: formatTokenCount(data.token_total), title: `${data.token_total.toLocaleString('zh-CN')} Token\n${tokens}` },
    { label: '费用', value: cost.value, title: cost.note ? `USD · ${cost.note}` : 'USD' },
    { label: execution.label, value: `${data.execution_count.toLocaleString('zh-CN')}`, title: execution.title },
    fourth(data),
  ]
  return (
    <>
      <div className="usc-metrics">
        {metrics.map((metric) => (
          <div key={metric.label} className="usc-metric" title={metric.title}>
            <strong className="font-number">{metric.value}</strong>
            <span>{metric.label}</span>
          </div>
        ))}
      </div>
      <p className="usc-detail">
        {tokens}
        {cost.note && <span className="usc-detail-note"> · {cost.note}</span>}
        {data.excluded_summary_count > 0 && <span className="usc-detail-note"> · {data.excluded_summary_count} 条摘要无法计入</span>}
      </p>
    </>
  )
}
