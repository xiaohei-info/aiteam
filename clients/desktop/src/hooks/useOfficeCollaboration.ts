/**
 * 办公室协作编排：群聊里 A @ B → A 走到 B 工位旁；多人同时协作 → 全员进会议室。
 *
 * 复用办公室已有的「进行中任务」集合：对每个进行中的会话订阅 SSE（同会话与 useOfficeMilestones 共用一条连接），
 * 把 mention_employee 的开始/结束翻译成协作信号（lib/officeCollaboration.ts），
 * 每秒按当前花名册对账一次，产出场景要执行的 OfficeCollabIntent[]。
 * 场景（MapOfficeScene.setCollaborations）自己对账执行，并负责会议室「使用中」状态。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { agentApi } from '../api/agent'
import { subscribeConversationEvents, type EventSubscription } from '../api/agent/events'
import {
  CollaborationTracker,
  buildMentionResolver,
  parseCollabSignal,
  parseReconciliationSignals,
  sameIntents,
  type OfficeCollabIntent,
  type RosterEntry,
} from '../lib/officeCollaboration'
import type { RunningTask } from './useOfficeMilestones'

const MAX_SUBSCRIPTIONS = 8
const TICK_MS = 1000

/**
 * 多人协作进会议室的入口开关：当前关闭（只保留串门）。
 * 会议的执行代码（lib/officeCollaboration.ts 的会议聚合、officeMap/meeting.ts、
 * MapOfficeScene.startMeeting / syncMeeting / 「使用中」状态）都还在，改成 true 即恢复。
 */
const MEETING_ENABLED = false

export interface CollabAgent {
  id: number | string
  name: string
}

export function useOfficeCollaboration(runningTasks: readonly RunningTask[], agents: readonly CollabAgent[]): OfficeCollabIntent[] {
  const trackerRef = useRef<CollaborationTracker | null>(null)
  if (!trackerRef.current) trackerRef.current = new CollaborationTracker({ meetingsEnabled: MEETING_ENABLED })
  const subsRef = useRef(new Map<string, EventSubscription>())
  const [intents, setIntents] = useState<OfficeCollabIntent[]>([])
  const [handles, setHandles] = useState<ReadonlyMap<string, string>>(() => new Map())

  // 被 @ 的引用可能是 handle，办公室员工列表里没有它，单独拉一次专家列表补上（失败时仍可按 id / 显示名解析）
  useEffect(() => {
    let cancelled = false
    agentApi.listExperts()
      .then(({ experts }) => {
        if (!cancelled) setHandles(new Map(experts.map((expert) => [expert.employee_id, expert.handle])))
      })
      .catch((error) => console.warn('[OfficeCollaboration] 专家列表加载失败，@ 仅按 id / 显示名解析', error))
    return () => { cancelled = true }
  }, [])

  const resolve = useMemo(() => {
    const roster: RosterEntry[] = agents.map((agent) => ({
      id: String(agent.id),
      name: agent.name,
      handle: handles.get(String(agent.id)),
    }))
    return buildMentionResolver(roster)
  }, [agents, handles])
  const resolveRef = useRef(resolve)
  resolveRef.current = resolve

  const conversationKey = [...new Set(runningTasks.map((task) => task.conversationId).filter((id): id is string => !!id))]
    .sort()
    .join('|')

  // 按进行中会话增删订阅：离开集合的会话把未结束的 @ 收尾，其余会话的在途信息不受影响
  useEffect(() => {
    const tracker = trackerRef.current!
    const subs = subsRef.current
    const wanted = new Set(conversationKey ? conversationKey.split('|') : [])
    for (const [conversationId, sub] of [...subs]) {
      if (wanted.has(conversationId)) continue
      sub.close()
      subs.delete(conversationId)
      tracker.closeConversation(conversationId, Date.now())
    }
    for (const conversationId of wanted) {
      if (subs.has(conversationId) || subs.size >= MAX_SUBSCRIPTIONS) continue
      subs.set(conversationId, subscribeConversationEvents({
        conversationId,
        onEvent: (event) => {
          const now = Date.now()
          const signal = parseCollabSignal(event, conversationId)
          if (signal) tracker.apply(signal, now)
          for (const seeded of parseReconciliationSignals(event, conversationId)) tracker.apply(seeded, now)
        },
      }))
    }
  }, [conversationKey])

  useEffect(() => () => {
    for (const sub of subsRef.current.values()) sub.close()
    subsRef.current.clear()
  }, [])

  // 对账：linger / 去抖都依赖时间，所以不能只在事件到达时算
  useEffect(() => {
    const tracker = trackerRef.current!
    const tick = () => {
      const next = tracker.plan(Date.now(), resolveRef.current)
      setIntents((prev) => (sameIntents(prev, next) ? prev : next))
    }
    tick()
    const timer = setInterval(tick, TICK_MS)
    return () => clearInterval(timer)
  }, [])

  return intents
}
