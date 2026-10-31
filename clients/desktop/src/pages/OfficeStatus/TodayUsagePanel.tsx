/**
 * 今日消耗面板：GET /api/agent/usage/statistics，窗口 = 本地当日。
 * 服务端约束：window_start/window_end 必须 UTC 整点对齐，否则 422 —— 窗口由 lib/usageWindow 的 todayWindow() 计算，
 * 与员工详情、群聊详情的「今日」同一口径。
 * 刷新：60s 慢轮询 + usageVersion（agent_settled / 任务转终态）触发即时刷新。
 * 口径：member_local（当前成员 · 当前设备），UI 明确标注，不虚构总价。
 */
import { useEffect, useMemo, useState } from 'react'
import { agentApi } from '../../api/agent'
import type { UsageStatistics } from '../../api/agent/observations.types'
import { todayWindow } from '../../lib/usageWindow'
import { formatUsdDecimal } from '../../lib/workRecords'
import { useOfficeMilestoneStore } from '../../stores/officeMilestones'
import { panelTitleStyle, sidebarPanelStyle } from './constants'

function todayLabel(): string {
  const now = new Date()
  return `${now.getMonth() + 1}/${now.getDate()}`
}

const tokenFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

const statValueStyle: React.CSSProperties = {
  fontSize: 18, color: 'var(--brand)', fontFamily: 'monospace', fontWeight: 'bold',
}
const statLabelStyle: React.CSSProperties = {
  fontSize: 8, color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: 2,
}
const cellStyle: React.CSSProperties = {
  background: 'var(--surface-2)', borderRadius: 4, padding: '8px 10px', textAlign: 'center',
}

export function TodayUsagePanel() {
  const usageVersion = useOfficeMilestoneStore((s) => s.usageVersion)
  const [usage, setUsage] = useState<UsageStatistics | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // 每次渲染重算成本极低；usage 刷新触发渲染时日签自然滚动到新的一天
  const dayLabel = todayLabel()

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        // 每次刷新重算：跨天/小时推进后窗口随之滚动
        const result = await agentApi.getUsageStatistics(todayWindow(), controller.signal)
        if (!controller.signal.aborted) { setUsage(result); setError(false) }
      } catch {
        if (!controller.signal.aborted) setError(true)
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 60_000)
      }
    }
    void refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [usageVersion, attempt])

  const successRate = useMemo(() => {
    if (!usage || usage.execution_count === 0) return null
    return Math.round((usage.succeeded_count / usage.execution_count) * 100)
  }, [usage])

  return (
    <div style={sidebarPanelStyle}>
      <div style={panelTitleStyle}>💰 今日消耗（{dayLabel}）</div>
      {error ? (
        <div style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
          今日用量暂不可用{' '}
          <button type="button" onClick={() => setAttempt((v) => v + 1)} style={{ fontSize: 9, cursor: 'pointer' }}>
            重试
          </button>
        </div>
      ) : !usage ? (
        <div style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'monospace' }} role="status">
          正在读取今日用量…
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div style={cellStyle}>
              <div style={statValueStyle} title={usage.token_total.toLocaleString()}>
                {tokenFormatter.format(usage.token_total).replace('K', 'k')}
              </div>
              <div style={statLabelStyle}>Token</div>
            </div>
            <div style={cellStyle}>
              <div style={statValueStyle}>{formatUsdDecimal(usage.cost_total)}</div>
              <div style={statLabelStyle}>费用 USD</div>
            </div>
            <div style={cellStyle}>
              <div style={statValueStyle}>{usage.execution_count}</div>
              <div style={statLabelStyle}>执行次数</div>
            </div>
            <div style={cellStyle}>
              <div style={statValueStyle}>{successRate === null ? '—' : `${successRate}%`}</div>
              <div style={statLabelStyle}>成功率</div>
            </div>
          </div>
          {usage.cost_total === null && (
            <div style={{ fontSize: 8, color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: 6 }}>
              已知费用小计 {formatUsdDecimal(usage.known_cost_total)}；{usage.unpriced_execution_count} 次执行未定价
            </div>
          )}
          <div style={{ fontSize: 8, color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: 6 }}>
            口径：当前成员 · 当前设备 · 按 UTC 小时聚合
          </div>
        </>
      )}
    </div>
  )
}
