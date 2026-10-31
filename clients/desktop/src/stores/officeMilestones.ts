/**
 * 办公室关键节点全局状态：内存态为渲染源，localStorage 为当日持久化副本。
 * - upsert 后 debounce 落盘（工具连发不刷盘）
 * - usageVersion 在 agent_settled / 记录转终态时 +1，今日用量面板据此触发刷新
 * - resetIfNewDay 处理「应用挂着过夜」的跨天清空
 * - liveStatus 是高频帧（thinking/text delta）投影出的「正在进行」 ephemeral 状态，
 *   只存内存不落盘、不进节点时间线，任务转终态时清除
 */
import { create } from 'zustand'
import {
  loadMilestoneStorage,
  localDayKey,
  saveMilestoneStorage,
  upsertMilestone,
  type MilestoneLevel,
  type OfficeMilestone,
} from '../lib/officeMilestones'

export interface LiveStatus {
  label: string
  level: MilestoneLevel
  at: number
}

interface OfficeMilestoneStore {
  date: string
  items: OfficeMilestone[]
  lastEventIds: Record<string, string>
  /** conversationId → 实时状态（思考中/生成中/调工具），不落盘 */
  liveStatus: Record<string, LiveStatus>
  usageVersion: number
  upsert: (milestone: OfficeMilestone) => void
  setLastEventId: (conversationId: string, eventId: string) => void
  setLiveStatus: (conversationId: string, status: LiveStatus) => void
  clearLiveStatus: (conversationId: string) => void
  bumpUsage: () => void
  /** 日期不是今天时清空并返回 true */
  resetIfNewDay: () => boolean
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function schedulePersist(get: () => OfficeMilestoneStore) {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const { date, items, lastEventIds } = get()
    saveMilestoneStorage({ date, items, lastEventIds })
  }, 300)
}

const initial = typeof window === 'undefined'
  ? { date: localDayKey(), items: [], lastEventIds: {} }
  : loadMilestoneStorage()

export const useOfficeMilestoneStore = create<OfficeMilestoneStore>((set, get) => ({
  date: initial.date,
  items: initial.items,
  lastEventIds: initial.lastEventIds,
  liveStatus: {},
  usageVersion: 0,

  upsert: (milestone) => {
    if (get().resetIfNewDay()) {
      // 跨天清空后本条仍落入新的一天
    }
    set((state) => ({ items: upsertMilestone(state.items, milestone) }))
    schedulePersist(get)
  },

  setLastEventId: (conversationId, eventId) => {
    set((state) => ({ lastEventIds: { ...state.lastEventIds, [conversationId]: eventId } }))
    schedulePersist(get)
  },

  bumpUsage: () => set((state) => ({ usageVersion: state.usageVersion + 1 })),

  setLiveStatus: (conversationId, status) => {
    const prev = get().liveStatus[conversationId]
    // 同文案节流：500ms 内不重复 setState，避免 delta 帧引发渲染风暴
    if (prev && prev.label === status.label && status.at - prev.at < 500) return
    set((state) => ({ liveStatus: { ...state.liveStatus, [conversationId]: status } }))
  },

  clearLiveStatus: (conversationId) => {
    if (!(conversationId in get().liveStatus)) return
    set((state) => {
      const next = { ...state.liveStatus }
      delete next[conversationId]
      return { liveStatus: next }
    })
  },

  resetIfNewDay: () => {
    const today = localDayKey()
    if (get().date === today) return false
    const shape = { date: today, items: [], lastEventIds: {} }
    set({ ...shape })
    saveMilestoneStorage(shape)
    return true
  },
}))
