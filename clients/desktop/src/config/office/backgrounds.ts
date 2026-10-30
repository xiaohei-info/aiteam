/**
 * 办公区底图注册表：新增底图只需追加一条记录。
 * `maxAgents` 用于自动挑选合适的底图（第一个 `agents.length <= maxAgents` 命中）。
 * `deskArea` 与 `seatGrid` 使用归一化坐标（0–1，相对图片），
 * 场景运行时把它换算成像素以放置工位。
 */

export interface NormalizedRect {
  x: number
  y: number
  w: number
  h: number
}

export interface SeatGrid {
  cols: number
  rows: number
}

export interface OfficeBackground {
  id: string
  label: string
  /** 触发条件：员工数 ≤ maxAgents 时命中该底图 */
  maxAgents: number
  /** 静态资源 URL（相对 public/） */
  src: string
  /** 底图原始像素尺寸，用于坐标换算 */
  imageSize: { w: number; h: number }
  /** 工位可放置的归一化范围区域（后续可由用户精调） */
  deskArea: NormalizedRect
  /** 工位网格尺寸（初值：能覆盖 maxAgents 的最小网格） */
  seatGrid: SeatGrid
}

export const OFFICE_BACKGROUNDS: OfficeBackground[] = [
  {
    id: 'office-10',
    label: '≤10 人办公区',
    maxAgents: 10,
    src: '/assets/office/icon_office_10.png',
    imageSize: { w: 1254, h: 1254 },
    // 初值：图片中部矩形区域 —— 用户后续精调
    deskArea: { x: 0.22, y: 0.32, w: 0.56, h: 0.46 },
    seatGrid: { cols: 4, rows: 3 },
  },
  {
    id: 'office-50',
    label: '≤50 人办公区',
    maxAgents: 50,
    src: '/assets/office/icon_office_50.png',
    imageSize: { w: 1254, h: 1254 },
    deskArea: { x: 0.18, y: 0.28, w: 0.64, h: 0.54 },
    seatGrid: { cols: 8, rows: 6 },
  },
]

export function pickOfficeBackground(agentCount: number): OfficeBackground {
  const sorted = [...OFFICE_BACKGROUNDS].sort((a, b) => a.maxAgents - b.maxAgents)
  return (
    sorted.find((bg) => agentCount <= bg.maxAgents) ??
    sorted[sorted.length - 1] ??
    OFFICE_BACKGROUNDS[0]
  )
}
