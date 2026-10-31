/**
 * 办公室常驻数据：花名册、汇总、进行中任务、协作意图、地图地址。
 *
 * 由 OfficeRuntimeHost 在登录后加载并持续更新（页面没打开时员工也在走动），
 * 办公室页面只读取这里的数据；关键节点与实时状态仍在 officeMilestones store。
 */
import { create } from 'zustand'
import type { OfficeSceneSummary } from '../api/agent/types'
import type { RunningTask } from '../hooks/useOfficeMilestones'
import type { RequestErrorInfo } from '../lib/requestError'
import type { OfficeAgentConf } from '../pages/OfficeStatus/officeRoster'

interface OfficeRuntimeState {
  agents: OfficeAgentConf[]
  summary: OfficeSceneSummary | null
  /** 首次加载中（还没有任何数据）；页面展示时的静默刷新不置 true */
  loading: boolean
  error: RequestErrorInfo | null
  runningTasks: RunningTask[]
  /** 自增即触发一次重新加载花名册 */
  loadAttempt: number
  /** 页面重试（出错后）：清掉错误并显示加载态 */
  retry: () => void
  /** 页面展示时静默刷新：保留现有数据，花名册不变时员工位置不受影响 */
  refresh: () => void
}

export const useOfficeRuntimeStore = create<OfficeRuntimeState>((set) => ({
  agents: [],
  summary: null,
  loading: true,
  error: null,
  runningTasks: [],
  loadAttempt: 0,
  retry: () => set((state) => ({ loading: true, error: null, loadAttempt: state.loadAttempt + 1 })),
  refresh: () => set((state) => ({ loadAttempt: state.loadAttempt + 1 })),
}))
