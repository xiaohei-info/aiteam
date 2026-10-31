import { useCallback, useEffect, useRef, useState } from 'react'
import { OfficeScene, type OfficeAgentConf } from '../../scene/office/OfficeScene'
import type { EmployeeAnchor } from '../../scene/office/officeMap/MapOfficeScene'
import { officeRuntime } from '../../scene/office/officeRuntime'
import { EmployeeBubble, type EmployeeBubbleInfo } from './EmployeeBubble'
import { globalActivityCollector, type ActivityLog } from '../../lib/globalActivityCollector'
import type { OfficeMap } from '../../scene/office/officeMap/types'

export interface OfficeMapInfo {
  id: string
  name: string
  width: number
  height: number
  elements: number
  seats: number
  rooms: { id: string; name: string; type?: string; capacity?: number }[]
  missingTextures: number
}

interface AgentConf {
  id: number | string
  name: string
  dept?: string
  role?: string
  status?: string
}

interface OfficeCanvasProps {
  /** 旧场景用的员工列表；地图场景的花名册由常驻运行时（OfficeRuntimeHost）维护 */
  agents?: AgentConf[]
  /** 手动指定背景 id，跳过按人数自动挑选（旧场景用） */
  backgroundId?: string
  /** 地图场景就绪后回传地图概览，供右侧介绍视图展示 */
  onMapReady?: (info: OfficeMapInfo) => void
  /** 点击气泡里的「对话」（仅地图场景） */
  onEmployeeChat?: (agent: Pick<OfficeAgentConf, 'id' | 'name'>) => void
  /** 给点中的员工补充气泡内容（岗位、介绍等）；不传则只显示名字 */
  describeEmployee?: (agent: Pick<OfficeAgentConf, 'id' | 'name'>) => Omit<EmployeeBubbleInfo, 'id' | 'name'>
}

/** 把地图场景回传的信息整理成右侧介绍视图要用的形状 */
function toMapInfo(map: OfficeMap, missingTextures: number): OfficeMapInfo {
  return {
    id: map.id,
    name: map.name,
    width: map.width,
    height: map.height,
    elements: map.elements.length,
    seats: map.seats?.length ?? 0,
    rooms: (map.rooms ?? []).map((room) => ({ id: room.id, name: room.name, type: room.type, capacity: room.capacity })),
    missingTextures,
  }
}

/** 新旧场景共用的最小接口，页面只依赖这些方法 */
interface SceneLike {
  playThinking(agentId: string | number): void
  playTalking(agentId: string | number): void
  playIdle(agentId: string | number): void
  /** 仅地图场景支持 */
  setEmployeePaused?(agentId: string | number, paused: boolean): boolean
  getEmployeeAnchor?(agentId: string | number): EmployeeAnchor | null
}

interface OpenBubble {
  employee: Pick<OfficeAgentConf, 'id' | 'name'>
  anchor: EmployeeAnchor
}

/**
 * 办公室画布。地图场景由常驻运行时持有（应用启动后员工就一直在走动），
 * 这里只把画布挂上来展示、卸载时挂回离屏容器；地图场景失败时回退到旧场景，旧场景随页面创建 / 销毁。
 */
export function OfficeCanvas({ agents, backgroundId, onMapReady, onEmployeeChat, describeEmployee }: OfficeCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const legacyRef = useRef<OfficeScene | null>(null)
  const legacyReadyRef = useRef(false)
  const mapReadyRef = useRef(onMapReady)
  mapReadyRef.current = onMapReady
  const chatRef = useRef(onEmployeeChat)
  chatRef.current = onEmployeeChat
  const describeRef = useRef(describeEmployee)
  describeRef.current = describeEmployee
  const [bubble, setBubble] = useState<OpenBubble | null>(null)
  const bubbleRef = useRef<OpenBubble | null>(null)
  bubbleRef.current = bubble
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 })
  const [mode, setMode] = useState<'map' | 'legacy'>('map')
  const modeRef = useRef(mode)
  modeRef.current = mode

  /** 当前可交互的场景：地图模式取常驻运行时（未就绪为 null），旧模式取本页创建的场景 */
  const currentScene = useCallback((): SceneLike | null => {
    if (modeRef.current === 'map') return officeRuntime.getScene()
    return legacyReadyRef.current ? legacyRef.current : null
  }, [])

  /** 关闭气泡并让员工继续活动 */
  const closeBubble = useCallback(() => {
    const open = bubbleRef.current
    if (!open) return
    bubbleRef.current = null
    currentScene()?.setEmployeePaused?.(open.employee.id, false)
    setBubble(null)
  }, [currentScene])

  const openBubble = useCallback((agent: Pick<OfficeAgentConf, 'id' | 'name'>) => {
    const scene = currentScene()
    const anchor = scene?.getEmployeeAnchor?.(agent.id)
    if (!scene || !anchor) return
    const previous = bubbleRef.current
    if (previous && previous.employee.id !== agent.id) scene.setEmployeePaused?.(previous.employee.id, false)
    scene.setEmployeePaused?.(agent.id, true)
    openedAtRef.current = performance.now()
    // 暂停后站姿会平滑收回，包围盒随之微调；下一帧再量一次，气泡贴得更准
    const next = { employee: agent, anchor }
    bubbleRef.current = next
    setBubble(next)
    requestAnimationFrame(() => {
      const current = bubbleRef.current
      if (!current || current.employee.id !== agent.id) return
      const fresh = currentScene()?.getEmployeeAnchor?.(agent.id)
      if (fresh) setBubble({ employee: agent, anchor: fresh })
    })
  }, [currentScene])
  const openedAtRef = useRef(0)
  const openBubbleRef = useRef(openBubble)
  openBubbleRef.current = openBubble

  /** 画面缩放后员工的屏幕位置变了，气泡跟着重新贴 */
  const reanchorBubble = useCallback(() => {
    const open = bubbleRef.current
    const anchor = open && currentScene()?.getEmployeeAnchor?.(open.employee.id)
    if (open && anchor) setBubble({ employee: open.employee, anchor })
  }, [currentScene])

  // 地图模式：把常驻场景的画布挂到本页；卸载时挂回离屏容器，员工继续走动
  useEffect(() => {
    const host = hostRef.current
    if (!host || mode !== 'map') return
    let attached = false
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      if (width <= 0 || height <= 0) return
      setFrameSize({ width, height })
      if (!attached) {
        attached = true
        officeRuntime.attach(host, width, height, {
          onReady: ({ map, missing }) => {
            // 场景就绪 / 重建：旧场景上的气泡已失效
            bubbleRef.current = null
            setBubble(null)
            mapReadyRef.current?.(toMapInfo(map, missing.length))
          },
          onEmployeeClick: (agent) => openBubbleRef.current(agent),
          onError: (error) => {
            console.warn('[OfficeCanvas] 地图场景初始化失败，回退到旧场景', error)
            setMode('legacy')
          },
        })
        return
      }
      officeRuntime.resize(width, height)
      reanchorBubble()
    })
    ro.observe(host)
    return () => {
      ro.disconnect()
      // 离开页面时气泡关掉，被暂停的员工要接着走
      const open = bubbleRef.current
      if (open) officeRuntime.getScene()?.setEmployeePaused(open.employee.id, false)
      bubbleRef.current = null
      setBubble(null)
      officeRuntime.detach(host)
    }
  }, [mode, reanchorBubble])

  // 旧场景：随页面创建 / 销毁，agents 变化时重建让姓名 / 状态贴到对应工位
  useEffect(() => {
    const host = hostRef.current
    if (!host || mode !== 'legacy') return
    let cancelled = false
    let scene: OfficeScene | null = null
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      if (width <= 0 || height <= 0) return
      setFrameSize({ width, height })
      if (scene) {
        scene.resize(width, height)
        return
      }
      const created = new OfficeScene({ backgroundId })
      scene = created
      legacyRef.current = created
      void created.init(host, width, height, (agents ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        dept: a.dept,
        role: a.role,
        status: a.status,
      }))).then(() => {
        if (!cancelled) legacyReadyRef.current = true
      })
    })
    ro.observe(host)
    return () => {
      cancelled = true
      ro.disconnect()
      legacyReadyRef.current = false
      legacyRef.current = null
      scene?.destroy()
      bubbleRef.current = null
      setBubble(null)
    }
  }, [agents, backgroundId, mode])

  // 点空白处 / 别处、按 Esc → 关掉气泡。用 click 而不是 pointerdown：
  // 点另一个员工时场景的 pointertap 先于 click 打开新气泡，这里靠时间戳跳过同一次点击，避免闪一下
  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (!bubbleRef.current) return
      if (performance.now() - openedAtRef.current < 150) return
      if (event.target instanceof Element && event.target.closest('[data-office-bubble]')) return
      closeBubble()
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeBubble()
    }
    document.addEventListener('click', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('click', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [closeBubble])

  // 旧场景的活动动画（地图场景的由 OfficeRuntimeHost 常驻监听）
  useEffect(() => {
    if (mode !== 'legacy') return
    const handleActivity = (log: ActivityLog) => {
      const scene = legacyReadyRef.current ? legacyRef.current : null
      const agent = agents?.find((a) => a.name === log.agent)
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
  }, [agents, mode])

  const bubbleInfo: EmployeeBubbleInfo | null = bubble
    ? { id: bubble.employee.id, name: bubble.employee.name, ...describeRef.current?.(bubble.employee) }
    : null

  return (
    <div
      style={{ flex: 1, minHeight: 0, width: '100%', position: 'relative', overflow: 'hidden' }}
    >
      <div
        ref={hostRef}
        className="office-canvas-host"
        style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#0f1117' }}
      />
      {bubble && bubbleInfo && (
        <EmployeeBubble
          employee={bubbleInfo}
          anchor={bubble.anchor}
          bounds={frameSize}
          onChat={() => {
            const employee = bubble.employee
            closeBubble()
            chatRef.current?.(employee)
          }}
        />
      )}
    </div>
  )
}
