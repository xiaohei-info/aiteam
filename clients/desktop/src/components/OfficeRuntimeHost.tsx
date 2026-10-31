/**
 * 办公室常驻运行时的驱动（无界面）：登录后加载花名册、跟踪进行中任务与群聊 @ 协作，
 * 推给 officeRuntime，员工从应用启动起就一直在走动；办公室页面只负责展示。
 *
 * App 里按登录会话挂载（key = sessionGeneration）；卸载即退出登录：销毁场景、清空数据。
 */
import { useEffect, useRef, useState } from 'react'
import { useOfficeMilestones } from '../hooks/useOfficeMilestones'
import { useOfficeCollaboration } from '../hooks/useOfficeCollaboration'
import { globalActivityCollector, type ActivityLog } from '../lib/globalActivityCollector'
import { classifyRequestError } from '../lib/requestError'
import { fetchSharedOfficeMaps } from '../scene/office/officeMap/loadOfficeMap'
import { officeRuntime } from '../scene/office/officeRuntime'
import { useOfficeRuntimeStore } from '../stores/officeRuntime'
import { loadOfficeRoster, officeMapUrl } from '../pages/OfficeStatus/officeRoster'

export default function OfficeRuntimeHost() {
  const agents = useOfficeRuntimeStore((s) => s.agents)
  const loadAttempt = useOfficeRuntimeStore((s) => s.loadAttempt)
  const { runningTasks } = useOfficeMilestones()
  const collaborations = useOfficeCollaboration(runningTasks, agents)
  const [mapVersion, setMapVersion] = useState('')
  const lastUpdatedAtRef = useRef<string | null>(null)
  const mapUrl = officeMapUrl(mapVersion)

  useEffect(() => {
    useOfficeRuntimeStore.setState({ runningTasks })
  }, [runningTasks])

  // 花名册：登录后加载一次，页面展示时静默刷新；已有数据时刷新失败保留旧数据
  useEffect(() => {
    let cancelled = false
    if (!useOfficeRuntimeStore.getState().summary) useOfficeRuntimeStore.setState({ loading: true, error: null })
    loadOfficeRoster()
      .then(({ agents: next, summary }) => {
        if (!cancelled) useOfficeRuntimeStore.setState({ agents: next, summary, loading: false, error: null })
      })
      .catch((err) => {
        if (cancelled) return
        if (useOfficeRuntimeStore.getState().summary) {
          console.warn('[OfficeRuntime] 办公室状态刷新失败，保留上次数据', err)
          return
        }
        useOfficeRuntimeStore.setState({ loading: false, error: classifyRequestError(err, '办公室状态加载失败，请稍后重试。') })
      })
    return () => { cancelled = true }
  }, [loadAttempt])

  // 只跟随共用配置的更新时间热刷新（编辑器保存后），忽略其中的 activeFile，地图固定为商务风
  useEffect(() => {
    let cancelled = false
    const syncSharedMaps = async () => {
      const info = await fetchSharedOfficeMaps()
      if (cancelled) return
      if (lastUpdatedAtRef.current === null) {
        lastUpdatedAtRef.current = info.updatedAt
        return
      }
      if (info.updatedAt && info.updatedAt !== lastUpdatedAtRef.current) {
        lastUpdatedAtRef.current = info.updatedAt
        setMapVersion(info.updatedAt)
      }
    }
    void syncSharedMaps()
    const timer = setInterval(() => {
      void syncSharedMaps()
    }, 2500)
    const handleFocus = () => {
      void syncSharedMaps()
    }
    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleFocus)
    return () => {
      cancelled = true
      clearInterval(timer)
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleFocus)
    }
  }, [])

  // 花名册不变只更新状态（员工位置不动）；换人或地图更新才重建场景
  useEffect(() => {
    officeRuntime.sync(mapUrl, agents)
  }, [mapUrl, agents])

  useEffect(() => {
    officeRuntime.setCollaborations(collaborations)
  }, [collaborations])

  // 员工活动 → 动画；页面没打开时也照常记录到场景状态
  useEffect(() => {
    const handleActivity = (log: ActivityLog) => {
      const scene = officeRuntime.getScene()
      const agent = useOfficeRuntimeStore.getState().agents.find((a) => a.name === log.agent)
      if (!scene || !agent) return
      if (log.type === 'thinking') {
        scene.playThinking(agent.id)
      } else if (log.type === 'tool' || log.type === 'result') {
        scene.playTalking(agent.id)
      } else {
        scene.playIdle(agent.id)
      }
    }
    globalActivityCollector.addListener(handleActivity)
    return () => {
      globalActivityCollector.removeListener(handleActivity)
    }
  }, [])

  // 退出登录（或会话切换）：销毁场景、清空数据，下次登录重新开始
  useEffect(() => () => {
    officeRuntime.dispose()
    useOfficeRuntimeStore.setState({ agents: [], summary: null, loading: true, error: null, runningTasks: [] })
  }, [])

  return null
}
