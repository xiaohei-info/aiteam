/**
 * office-map/v1.1 地图契约（编辑器导出的子集）。
 * 只声明前端渲染与寻路需要的字段，未列出的字段会被忽略而不是报错。
 */
import type { ChibiCharacterSkin, ChibiFacing } from '@/config/office/characters'

export interface MapPoint {
  x: number
  y: number
}

export interface MapRect {
  x: number
  y: number
  width: number
  height: number
}

export interface MapPolygon {
  id: string
  name: string
  type: 'walk-blocked' | 'employee-no-entry' | 'spawn'
  points: MapPoint[]
  enabled: boolean
  visible: boolean
  locked: boolean
}

export interface MapGeometry {
  width: number
  height: number
  stretchAxis?: 'x' | 'y'
  footprints?: MapRect[]
  connectors?: Partial<Record<'left' | 'right' | 'top' | 'bottom', MapPoint>>
}

export interface MapElement {
  id: string
  name: string
  kind: 'rect' | 'image'
  assetId?: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  opacity: number
  color: string
  zIndex: number
  visible: boolean
  locked: boolean
  blocksMovement: boolean
  label?: string
  geometry?: MapGeometry
  /** 可显示内容的屏幕区域（图元 1× 局部坐标） */
  screen?: MapRect
}

export interface MapAsset {
  id: string
  name: string
  src: string
  category?: string
  width?: number
  height?: number
  tileable?: boolean
}

export type EmployeeAnimation = 'idle' | 'thinking' | 'talking' | 'walking'

export interface MapEmployee {
  resourceId: string
  skin: ChibiCharacterSkin
  animation: EmployeeAnimation
  enabled: boolean
  name: string
}

export interface MapSeat {
  id: string
  name: string
  deskElementId: string
  chairElementId?: string
  computerElementId?: string
  x: number
  y: number
  facing: ChibiFacing
  seatOffset?: MapPoint
  chairOffset?: MapPoint
  computerOffset?: MapPoint
  approachOffset?: MapPoint
  approachPoint?: MapPoint
  employee?: MapEmployee
}

export interface MapRoom {
  id: string
  name: string
  type: 'meeting' | 'pantry' | 'restroom' | 'work' | 'lounge'
  capacity: number
  bounds: MapRect
  approachPoint?: MapPoint
  /** 房间正在使用中（使用中时员工自由活动不会进入） */
  occupied?: boolean
}

export interface MapLayout {
  entrance?: MapPoint
  spawnPoint?: MapPoint
  occupants?: number
  mainAisle?: MapRect
  notes?: string[]
}

export interface OfficeMap {
  schema: string
  id: string
  name: string
  width: number
  height: number
  gridSize: number
  backgroundColor: string
  background: { src: string; opacity: number; visible: boolean } | null
  assets: MapAsset[]
  elements: MapElement[]
  zones: MapPolygon[]
  rooms?: MapRoom[]
  seats?: MapSeat[]
  spots?: MapSpot[]
  layout?: MapLayout
}

export type DestinationCategory = 'restroom' | 'pantry' | 'meeting' | 'corridor' | 'custom'

export interface DestinationConfig {
  type: DestinationCategory
  name: string
  point: MapPoint
  speed: number
  /** 停留时长（秒），来自地图 spot.stay */
  stay?: number
  /** 绑定房间 id（用于「使用中」的房间禁止进入） */
  roomId?: string
}

/** 地图中的自由活动目的地锚点（编辑器可自定义） */
export interface MapSpot {
  id: string
  name: string
  kind: DestinationCategory
  x: number
  y: number
  speed?: number
  stay?: number
  enabled?: boolean
  roomId?: string
}

/**
 * 根据目的地类型设置的默认步速（px/s）。
 * 地图 spot.speed 优先，缺省时用这里的值。
 */
export const DESTINATION_SPEEDS: Record<DestinationCategory | 'return', number> = {
  restroom: 85,
  pantry: 65,
  meeting: 58,
  corridor: 45,
  custom: 60,
  return: 60,
}

export interface WanderState {
  /** 距离下一次漫步的倒计时（秒） */
  timer: number
  /** 当前阶段 */
  phase: 'idle_at_seat' | 'walking_to' | 'staying' | 'returning'
  /** 在目的地停留倒计时（秒） */
  stayDuration: number
  /** 当前目的地 */
  destination?: DestinationConfig
  /** 实际站位：目的地被别人占了就挪到旁边的空位，其他人挑站位时要避开它 */
  stand?: MapPoint
}

/**
 * 办公室里的协作意图（由群聊里的 @ 派生，场景只管执行）：
 * - visit：visitor 走到 host 的工位旁交流；
 * - meeting：members 全部进入一间会议室，期间该会议室标记「使用中」。
 * 成员 id 与 MapOfficeAgent.id（employee_id）一致。
 */
export type OfficeCollabIntent =
  | { kind: 'visit'; key: string; visitor: string; host: string }
  | { kind: 'meeting'; key: string; members: string[] }
