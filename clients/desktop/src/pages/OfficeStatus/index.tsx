import { useEffect, useState, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { type Log, type Stat } from './constants'
import { OfficeCanvas } from './OfficeCanvas'
import { BottomPanels } from './BottomPanels'
import { TodayUsagePanel } from './TodayUsagePanel'
import { useChatStore } from '../../stores/chat'
import { useOfficeMilestoneStore } from '../../stores/officeMilestones'
import { useOfficeRuntimeStore } from '../../stores/officeRuntime'
import { openEmployeeChat } from '../../lib/openEmployeeChat'
import { agentApi } from '../../api/agent'
import { isTauri } from '../../api/agent/runtime'
import RequestErrorState from '../../components/RequestState/RequestErrorState'
import { buildOfficeEditorUrl, openOfficeMapEditor } from '../../scene/office/officeMap/loadOfficeMap'
import { OFFICE_MAP_FILE } from './officeRoster'

export default function OfficeStatus() {
  const navigate = useNavigate()
  const [logs, setLogs] = useState<Log[]>([])
  const newLogIdx = null
  // 花名册 / 汇总 / 进行中任务由 OfficeRuntimeHost 登录后加载并持续更新（页面没打开时员工也在走动），
  // 加载失败、真实空态与加载态严格分开，不使用 mock（见 officeRoster.ts）
  const agents = useOfficeRuntimeStore((s) => s.agents)
  const summary = useOfficeRuntimeStore((s) => s.summary)
  const loading = useOfficeRuntimeStore((s) => s.loading)
  const error = useOfficeRuntimeStore((s) => s.error)
  const runningTasks = useOfficeRuntimeStore((s) => s.runningTasks)
  const retry = useOfficeRuntimeStore((s) => s.retry)
  // 今日关键节点（SSE 实时，localStorage 当日持久化）与实时状态
  const milestones = useOfficeMilestoneStore((s) => s.items)
  const liveStatus = useOfficeMilestoneStore((s) => s.liveStatus)
  const activeMapFile = OFFICE_MAP_FILE
  const { workbenchEmployees } = useChatStore()

  // 页面展示时静默刷新一次（首次加载还在进行时不打断）；花名册不变时员工位置不受影响
  useEffect(() => {
    const state = useOfficeRuntimeStore.getState()
    if (!state.loading) state.refresh()
  }, [])

  // 气泡里的介绍来自员工画像（persona），没有则退回岗位 / 当前任务
  const describeEmployee = (agent: { id: number | string }) => {
    const profile = workbenchEmployees.find((employee) => employee.employeeId === String(agent.id))
    const conf = agents.find((item) => item.id === agent.id)
    return {
      subtitle: [conf?.role, conf?.dept].filter(Boolean).join(' · ') || undefined,
      intro: profile?.persona?.trim() || undefined,
    }
  }

  // 与组织架构页的「对话」一致：打开该员工最近的会话，没有则新建
  const handleChatWithEmployee = (agent: { id: number | string; name?: string }) => {
    const employeeId = String(agent.id)
    const displayName = workbenchEmployees.find((employee) => employee.employeeId === employeeId)?.displayName ?? agent.name ?? '助手'
    openEmployeeChat({ employeeId, displayName }, navigate).catch((err) => {
      console.error('[OfficeStatus] open chat failed:', err)
      window.alert(err instanceof Error ? `发起对话失败：${err.message}` : '发起对话失败，请稍后重试')
    })
  }

  const stats: Stat[] = summary ? [
    { label: '员工总数', value: String(summary.total) },
    { label: '工作中', value: String(summary.working) },
    { label: '空闲', value: String(summary.ready) },
  ] : []
  const onlineCount = summary ? summary.working + summary.ready : null

  const handleOpenEditor = (event: MouseEvent<HTMLAnchorElement>) => {
    if (isTauri()) {
      event.preventDefault()
      void openOfficeMapEditor(activeMapFile)
    }
  }

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const feed = await agentApi.getOfficeFeed()
        if (!cancelled) setLogs(feed.events.map(event => ({ time: '', agent: event.title, text: event.schedule?.enabled ? '已启用会话定时执行' : '会话定时摘要' })))
      } catch { if (!cancelled) setLogs([{ time: '', agent: '', text: '定时会话摘要暂不可用' }]) }
      finally { if (!cancelled) timer = setTimeout(refresh, 15000) }
    }
    void refresh()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [])

  return (
    <div style={{ height: '100%', overflow: 'hidden', background: 'var(--surface-0)', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div data-tauri-drag-region style={{
        background: 'var(--surface-1)', borderBottom: '3px solid var(--border)',
        padding: '8px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--brand)', fontFamily: 'monospace', letterSpacing: '0.15em' }}>
            ▶ 办公室动态
          </div>
          <div style={{ fontSize: 7, color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: 3 }}>
            {loading
              ? '正在加载员工状态'
              : error
                ? '员工状态不可用'
                : `FLOOR 1 — ${onlineCount ?? 0} AGENTS ONLINE`}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <a
            href={buildOfficeEditorUrl(activeMapFile)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleOpenEditor}
            data-testid="office-map-editor-entry"
            title="在浏览器打开办公室地图编辑器（共用 JSON 目录）"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px solid color-mix(in srgb, var(--brand) 45%, var(--border))',
              background: 'color-mix(in srgb, var(--brand) 14%, var(--surface-2))',
              color: 'var(--brand)',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'monospace',
              textDecoration: 'none',
              cursor: 'pointer',
            }}
          >
            <span>✎ 编辑办公室</span>
          </a>
        </div>
      </div>

      {loading ? (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-secondary)' }} role="status">
          正在加载办公室状态…
        </div>
      ) : error ? (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 24 }}>
          <RequestErrorState
            error={error}
            onRetry={retry}
            retrying={loading}
          />
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 10, padding: 10 }}>
          {agents.length > 0 ? (
            <div style={{ flex: 2, minWidth: 0, display: 'flex', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
              <OfficeCanvas agents={agents} onEmployeeChat={handleChatWithEmployee} describeEmployee={describeEmployee} />
            </div>
          ) : (
            <div style={{ flex: 2, minWidth: 0, display: 'grid', placeItems: 'center', color: 'var(--text-secondary)' }}>
              当前没有可展示的 AI 员工
            </div>
          )}

          <aside
            style={{
              flex: 1, minWidth: 300, maxWidth: 460, minHeight: 0,
              display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto',
            }}
          >
            <TodayUsagePanel />
            <BottomPanels
              runningTasks={runningTasks}
              milestones={milestones}
              liveStatus={liveStatus}
              stats={stats}
              logs={logs}
              newLogIdx={newLogIdx}
              onOpenConversation={(id) => navigate(`/chat/${encodeURIComponent(id)}`)}
            />
          </aside>
        </div>
      )}

      <style>{`
        @keyframes logSlideIn {
          from { transform: translateY(-100%); opacity: 0; }
          to   { transform: translateY(0);     opacity: 1; }
        }
      `}</style>
    </div>
  )
}
