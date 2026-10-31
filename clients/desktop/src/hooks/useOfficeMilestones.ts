/**
 * 办公室关键节点编排：
 * 1. 以今日窗口的 work-records 为权威兜底（5s 水位轮询由 useWorkRecords 内置）；
 * 2. 对每条 outcome='active' 的记录按其 conversation_id 建立 SSE 订阅（同会话自动复用），
 *    断线用持久化的 lastEventId 游标续读；
 * 3. 记录转终态时补 record_done 节点并触发今日用量刷新（SSE 漏报也能收敛）；
 * 4. 午夜定时器跨天清空；并发订阅数封顶，超出退化为仅轮询展示。
 */
import { useEffect, useMemo, useRef } from 'react'
import { subscribeConversationEvents } from '../api/agent/events'
import type { WorkRecord } from '../api/agent/observations.types'
import { mapSseToMilestone } from '../lib/officeMilestones'
import { useOfficeMilestoneStore } from '../stores/officeMilestones'
import { useWorkRecords } from './useWorkRecords'

const MAX_SSE_SUBSCRIPTIONS = 8

export interface RunningTask {
  id: string
  conversationId: string | null
  name: string
  agent: string
  startedAt: string | null
}

function toRunningTask(record: WorkRecord): RunningTask {
  return {
    id: record.id,
    conversationId: record.conversation_id || null,
    name: record.task_summary ?? record.conversation_title ?? '未命名任务',
    agent: record.employee_display_name,
    startedAt: record.started_at ?? record.occurred_at,
  }
}

/**
 * 本地当日 [0 点, 次日 0 点) 窗口。
 * 服务端强制成对 window_start/window_end（单传 422，见 work-record-schemas "成对提供"）；
 * work-records 接受精确时间，无需像 usage 统计那样 UTC 整点对齐。
 */
function todayWindow(): { start: string; end: string } {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return { start: start.toISOString(), end: end.toISOString() }
}

export function useOfficeMilestones() {
  const { start: windowStart, end: windowEnd } = useMemo(todayWindow, [])
  const { records } = useWorkRecords(undefined, windowStart, windowEnd)
  const upsert = useOfficeMilestoneStore((s) => s.upsert)
  const setLastEventId = useOfficeMilestoneStore((s) => s.setLastEventId)
  const bumpUsage = useOfficeMilestoneStore((s) => s.bumpUsage)
  const milestones = useOfficeMilestoneStore((s) => s.items)
  const terminalSeenRef = useRef(new Set<string>())

  const runningTasks = useMemo(
    () => records.filter((r) => r.outcome === 'active').map(toRunningTask),
    [records],
  )

  // 记录转终态 → 补节点 + 刷新用量（幂等：record_done 键唯一，terminalSeen 防重复 bump）
  useEffect(() => {
    for (const record of records) {
      if (record.outcome === 'active') continue
      if (terminalSeenRef.current.has(record.id)) continue
      terminalSeenRef.current.add(record.id)
      upsert({
        key: `${record.conversation_id}:${record.id}:done`,
        at: record.ended_at ?? record.updated_at,
        employee: record.employee_display_name,
        employeeId: record.employee_id,
        conversationId: record.conversation_id,
        kind: 'record_done',
        label: record.outcome === 'succeeded' ? '任务完成' : record.outcome === 'error' ? '任务失败' : record.outcome === 'aborted' ? '任务已中止' : '任务结束',
        level: record.outcome === 'error' ? 'warn' : 'info',
        done: true,
      })
      bumpUsage()
    }
  }, [records, upsert, bumpUsage])

  // active 任务 → SSE 订阅生命周期
  const subscriptionKey = runningTasks
    .map((t) => t.conversationId)
    .filter((id): id is string => !!id)
    .sort()
    .join('|')
  useEffect(() => {
    if (!subscriptionKey) return
    const store = useOfficeMilestoneStore.getState()
    const tasks = records
      .filter((r) => r.outcome === 'active' && r.conversation_id)
      .slice(0, MAX_SSE_SUBSCRIPTIONS)
    const subs = tasks.map((record) => {
      const conversationId = record.conversation_id
      const fallback = {
        employee: record.employee_display_name,
        employeeId: record.employee_id,
        conversationId,
      }
      return subscribeConversationEvents({
        conversationId,
        after: store.lastEventIds[conversationId] ?? null,
        onEvent: (evt, eventId) => {
          if (eventId) setLastEventId(conversationId, eventId)
          const milestone = mapSseToMilestone(evt, eventId, fallback)
          if (milestone) upsert(milestone)
          if (!('type' in evt)) return
          // 高频帧 → 内存态实时状态（思考中/生成中/调工具），不落盘不进时间线
          const now = Date.now()
          const setLive = useOfficeMilestoneStore.getState().setLiveStatus
          const clearLive = useOfficeMilestoneStore.getState().clearLiveStatus
          switch (evt.type) {
            case 'message_update': {
              const sub = evt.assistantMessageEvent?.type
              if (sub === 'thinking_start' || sub === 'thinking_delta') {
                setLive(conversationId, { label: '正在思考…', level: 'info', at: now })
              } else if (sub === 'text_start' || sub === 'text_delta') {
                setLive(conversationId, { label: '正在生成回复…', level: 'info', at: now })
              } else if (sub === 'toolcall_start' || sub === 'toolcall_delta') {
                setLive(conversationId, { label: '正在准备工具调用…', level: 'info', at: now })
              }
              break
            }
            case 'tool_execution_start':
              setLive(conversationId, { label: `调用工具 ${evt.toolName ?? ''}`.trim(), level: 'info', at: now })
              break
            case 'approval_required':
              // 办公室只展示状态；审批决策在所属对话内进行（ChatApprovalBanner）
              setLive(conversationId, { label: '等待人工审批', level: 'action', at: now })
              break
            case 'agent_end':
            case 'agent_settled':
              clearLive(conversationId)
              break
            default:
              break
          }
          if (evt.type === 'agent_settled') bumpUsage()
        },
      })
    })
    return () => subs.forEach((sub) => sub.close())
    // subscriptionKey 派生自 records；records 变化时重建与清理由依赖覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriptionKey, upsert, setLastEventId, bumpUsage])

  // 任务离开 active 集合时清除其实时状态（SSE 漏报终态也能收敛）
  useEffect(() => {
    const activeConvs = new Set(
      runningTasks.map((t) => t.conversationId).filter((id): id is string => !!id),
    )
    for (const conv of Object.keys(useOfficeMilestoneStore.getState().liveStatus)) {
      if (!activeConvs.has(conv)) useOfficeMilestoneStore.getState().clearLiveStatus(conv)
    }
  }, [runningTasks])

  // 午夜清空（应用挂着过夜）
  useEffect(() => {
    const now = new Date()
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5)
    const timer = setTimeout(() => {
      useOfficeMilestoneStore.getState().resetIfNewDay()
    }, nextMidnight.getTime() - now.getTime())
    return () => clearTimeout(timer)
  }, [milestones.length])

  const liveStatus = useOfficeMilestoneStore((s) => s.liveStatus)
  return { runningTasks, milestones, liveStatus }
}
