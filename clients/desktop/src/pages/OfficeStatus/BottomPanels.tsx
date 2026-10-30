/**
 * 办公室右侧信息栏，纵向堆叠进行中任务（含关键节点）、运营统计和定时会话摘要。
 * 页面是「左 2/3 地图 + 右 1/3 状态栏」的格局，所以这里用纵向排布而不是横向三栏。
 *
 * 进行中任务：work-records outcome='active' 投影 + 每条任务最新节点（SSE 实时）。
 * 节点时间线：今日关键节点流（localStorage 当日持久化，跨天自动清空）。
 * work-records 无 progress 字段，运行中任务展示「已运行时长」，不虚构百分比。
 *
 * @注意 newLogIdx 控制最新日志条目的高亮入场动画，400ms 后由父组件重置为 null。
 */
import { useEffect, useMemo, useState } from 'react'
import { panelTitleStyle, sidebarPanelStyle, type Stat, type Log } from './constants'
import type { OfficeMilestone } from '../../lib/officeMilestones'
import type { RunningTask } from '../../hooks/useOfficeMilestones'
import type { LiveStatus } from '../../stores/officeMilestones'

function formatElapsed(startedAt: string | null, now: number): string {
  if (!startedAt) return '—'
  const ms = now - Date.parse(startedAt)
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const totalSeconds = Math.floor(ms / 1000)
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0')
  const ss = String(totalSeconds % 60).padStart(2, '0')
  const hh = Math.floor(totalSeconds / 3600)
  return hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`
}

function formatClock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const levelColor: Record<OfficeMilestone['level'], string> = {
  info: 'var(--text-secondary)',
  warn: '#ffaa44',
  action: '#ff6666',
}

export function BottomPanels({ runningTasks, milestones, liveStatus, stats, logs, newLogIdx, onOpenConversation }: {
  runningTasks: RunningTask[]
  milestones: OfficeMilestone[]
  liveStatus: Record<string, LiveStatus>
  stats: Stat[]
  logs: Log[]
  newLogIdx: number | null
  /** action 级节点（等待审批）点击跳转所属会话；审批决策只能在对话内进行 */
  onOpenConversation?: (conversationId: string) => void
}) {
  // 运行时长本地走时；无运行中任务时停在最近一次渲染值
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (runningTasks.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [runningTasks.length])

  const latestNodeByTask = useMemo(() => {
    const map = new Map<string, OfficeMilestone>()
    for (const m of milestones) {
      // milestones 按时间升序，后面的覆盖前面的
      if (m.workId) map.set(m.workId, m)
      map.set(m.conversationId, m)
    }
    return map
  }, [milestones])

  const timeline = useMemo(() => milestones.slice(-30).reverse(), [milestones])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: '0 0 auto' }}>
      {/* 进行中任务 */}
      <div style={{ ...sidebarPanelStyle, display: 'flex', flexDirection: 'column' }}>
        <div style={panelTitleStyle}>🔥 进行中任务</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', maxHeight: 220 }}>
          {runningTasks.length === 0 ? (
            <div style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
              当前没有进行中的任务
            </div>
          ) : runningTasks.map((t) => {
            const live = t.conversationId ? liveStatus[t.conversationId] : undefined
            const node = latestNodeByTask.get(t.id) ?? (t.conversationId ? latestNodeByTask.get(t.conversationId) : undefined)
            // 优先级：实时状态（思考中/生成中/调工具） > 最近持久化节点
            const statusText = live?.label ?? node?.label
            const statusLevel = live?.level ?? node?.level ?? 'info'
            return (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{
                  width: 22, height: 22, borderRadius: 4,
                  background: 'var(--surface-2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, flexShrink: 0,
                }}>
                  ⚙️
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-primary)', fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {t.name}
                  </div>
                  <div style={{ fontSize: 8, color: 'var(--text-muted)', fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {t.agent} · 已运行 {formatElapsed(t.startedAt, now)}
                    {statusText ? ` · ${statusText}` : ''}
                  </div>
                </div>
                <div style={{
                  width: 6, height: 6, borderRadius: '50%', flexShrink: 0, marginRight: 10,
                  background: statusLevel === 'action' ? '#ff6666' : statusLevel === 'warn' ? '#ffaa44' : '#4488ff',
                }} />
              </div>
            )
          })}
        </div>
      </div>

      {/* 关键节点时间线（今日） */}
      <div style={{ ...sidebarPanelStyle, display: 'flex', flexDirection: 'column', maxHeight: 200 }}>
        <div style={panelTitleStyle}>🧭 关键节点（今日）</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, overflowY: 'auto', minHeight: 0 }}>
          {timeline.length === 0 ? (
            <div style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
              今日暂无关键节点
            </div>
          ) : timeline.map((m) => (
            <div key={m.key} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span style={{ fontSize: 8, color: 'var(--text-muted)', fontFamily: 'monospace', flexShrink: 0 }}>{formatClock(m.at)}</span>
              <span style={{ fontSize: 9, color: 'var(--brand)', fontFamily: 'monospace', flexShrink: 0 }}>{m.employee}</span>
              {m.level === 'action' && onOpenConversation ? (
                <button
                  type="button"
                  onClick={() => onOpenConversation(m.conversationId)}
                  title="点击前往会话处理审批"
                  style={{ fontSize: 9, color: levelColor[m.level], fontFamily: 'monospace', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline' }}
                >
                  {m.label} →
                </button>
              ) : (
                <span style={{ fontSize: 9, color: levelColor[m.level], fontFamily: 'monospace' }}>{m.label}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 当前场景统计 */}
      <div style={sidebarPanelStyle}>
        <div style={panelTitleStyle}>📊 当前场景</div>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(stats.length, 1)}, minmax(0, 1fr))`, gap: 8 }}>
          {stats.length === 0 ? (
            <div style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
              统计数据未提供
            </div>
          ) : stats.map(s => (
            <div key={s.label} style={{
              background: 'var(--surface-2)', borderRadius: 4,
              padding: '8px 10px', textAlign: 'center',
            }}>
              <div style={{ fontSize: 18, color: 'var(--brand)', fontFamily: 'monospace', fontWeight: 'bold' }}>{s.value}</div>
              <div style={{ fontSize: 8, color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 定时会话摘要 */}
      <div style={{ ...sidebarPanelStyle, display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 140 }}>
        <div style={panelTitleStyle}>⚡ 定时会话摘要</div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5, overflowY: 'auto', minHeight: 0 }}>
          {logs.length === 0 ? (
            <div style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
              暂无真实活动记录
            </div>
          ) : logs.map((log, i) => (
            <div key={`${log.time}-${log.agent}-${i}`} style={{
              display: 'flex', gap: 8, alignItems: 'baseline',
              animation: i === newLogIdx ? 'logSlideIn 0.35s ease-out' : undefined,
            }}>
              <span style={{ fontSize: 8, color: 'var(--text-muted)', fontFamily: 'monospace', flexShrink: 0 }}>{log.time}</span>
              <span style={{ fontSize: 9, color: 'var(--brand)', fontFamily: 'monospace', flexShrink: 0 }}>{log.agent}</span>
              <span style={{ fontSize: 9, color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{log.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
