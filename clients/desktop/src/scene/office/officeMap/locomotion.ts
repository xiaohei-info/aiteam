/**
 * 员工走动的「拟人化」纯函数（不依赖 Pixi / DOM，便于单测）。
 *
 * 编辑器同款寻路（geometry.findPath）给出的是四邻域网格折线：直角拐弯、锯齿状斜走。
 * 这里在它的结果上做表现层处理，不改变寻路本身：
 * 1. simplifyPath：视线拉直，去掉网格锯齿，只保留真正需要绕障的拐点；
 * 2. roundCorners：拐点切成圆弧（仍做碰撞校验，贴墙处退回直角）；
 * 3. buildSpeedProfile：按曲率限速 + 终点前减速，配合运行时的起步加速，形成「起步—巡航—转弯放慢—收步」；
 * 4. nextFacing：朝向带滞回，斜走时不会左右/上下来回抽搐；
 * 腿部步态（膝盖/大腿/小腿的运动）见 gait.ts。
 */
import type { ChibiFacing } from '@/config/office/characters'
import { pointAtDistance } from './geometry.ts'
import type { MapPoint } from './types.ts'

export const LOCOMOTION = {
  /** 起步加速度（px/s²）：约 0.4 秒迈开到巡航速度 */
  accel: 150,
  /** 收步减速度（px/s²） */
  decel: 170,
  /** 转弯允许的向心加速度（px/s²），越小拐弯越慢 */
  lateralAccel: 140,
  /** 终点前的最低速度，保证一定能走到 */
  minSpeed: 8,
  /** 拐角圆弧半径（px） */
  cornerRadius: 22,
  /** 朝向按前方多远的点计算（px），提前一点转身更像人 */
  lookAhead: 12,
  /** 朝向切换到另一轴所需的优势比 */
  facingRatio: 1.3,
  /** 两次转身最短间隔（秒） */
  facingHold: 0.2,
  /** 动画采样步长（px） */
  sampleStep: 6,
  /** 从座位起身到迈步的停顿（秒） */
  standUpDelay: 0.45,
  /** 普通起步前先转身的停顿（秒） */
  turnDelay: 0.18,
  /** 回到座位后转身面向电脑前的停顿（秒） */
  settleDelay: 0.25,
} as const

/** 视线拉直：从当前锚点出发尽量连到最远的可直达点 */
export function simplifyPath(points: MapPoint[], isClear: (a: MapPoint, b: MapPoint) => boolean): MapPoint[] {
  if (points.length <= 2) return points.map((p) => ({ ...p }))
  const out: MapPoint[] = [{ ...points[0] }]
  let anchor = 0
  while (anchor < points.length - 1) {
    let next = anchor + 1
    while (next + 1 < points.length && isClear(points[anchor], points[next + 1])) next++
    out.push({ ...points[next] })
    anchor = next
  }
  return out
}

function bezier(a: MapPoint, b: MapPoint, c: MapPoint, t: number): MapPoint {
  const u = 1 - t
  return { x: u * u * a.x + 2 * u * t * b.x + t * t * c.x, y: u * u * a.y + 2 * u * t * b.y + t * t * c.y }
}

/** 拐角倒圆：每个中间拐点替换为二次贝塞尔；碰撞校验不过时缩半径重试，仍不过就保留直角 */
export function roundCorners(
  points: MapPoint[],
  isClear: (a: MapPoint, b: MapPoint) => boolean,
  radius: number = LOCOMOTION.cornerRadius,
): MapPoint[] {
  if (points.length <= 2) return points.map((p) => ({ ...p }))
  const out: MapPoint[] = [{ ...points[0] }]
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1]
    const b = points[i]
    const c = points[i + 1]
    const ab = Math.hypot(b.x - a.x, b.y - a.y)
    const bc = Math.hypot(c.x - b.x, c.y - b.y)
    let arc: MapPoint[] | null = null
    for (let r = Math.min(radius, ab / 2, bc / 2); r >= 4 && !arc; r /= 2) {
      const p1 = { x: b.x + ((a.x - b.x) / ab) * r, y: b.y + ((a.y - b.y) / ab) * r }
      const p2 = { x: b.x + ((c.x - b.x) / bc) * r, y: b.y + ((c.y - b.y) / bc) * r }
      const count = Math.max(3, Math.ceil(r / 4))
      const candidate = Array.from({ length: count + 1 }, (_, k) => bezier(p1, b, p2, k / count))
      if (candidate.every((p, k) => k === 0 || isClear(candidate[k - 1], p))) arc = candidate
    }
    out.push(...(arc ?? [{ ...b }]))
  }
  out.push({ ...points[points.length - 1] })
  return out
}

/**
 * 每个采样点的速度上限：min(巡航, 曲率限速)，再从终点倒推减速曲线（终点速度为 0）。
 * 起步加速不放在这里，由运行时按当前速度累加，否则起点上限为 0 会原地卡住。
 */
export function buildSpeedProfile(samples: MapPoint[], cruise: number, tuning = LOCOMOTION, stops: readonly number[] = []): number[] {
  const n = samples.length
  const limit = new Array<number>(n).fill(cruise)
  for (let i = 1; i < n - 1; i++) {
    const a = samples[i - 1]
    const b = samples[i]
    const c = samples[i + 1]
    const h1 = Math.atan2(b.y - a.y, b.x - a.x)
    const h2 = Math.atan2(c.y - b.y, c.x - b.x)
    let turn = Math.abs(h2 - h1)
    if (turn > Math.PI) turn = 2 * Math.PI - turn
    const ds = (Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y)) / 2
    if (turn > 1e-3 && ds > 1e-6) limit[i] = Math.min(cruise, Math.sqrt(tuning.lateralAccel / (turn / ds)))
  }
  if (n) limit[n - 1] = 0
  // 途中必须停住的点（如椅子侧门：要站定了才能扶椅子）：速度上限为 0，前面按制动曲线提前收步
  for (const index of stops) if (index >= 0 && index < n) limit[index] = 0
  for (let i = n - 2; i >= 0; i--) {
    const ds = Math.hypot(samples[i + 1].x - samples[i].x, samples[i + 1].y - samples[i].y)
    limit[i] = Math.min(limit[i], Math.sqrt(limit[i + 1] ** 2 + 2 * tuning.decel * ds))
  }
  return limit
}

/** 按已走距离插值速度上限 */
export function speedLimitAt(samples: MapPoint[], profile: number[], distance: number): number {
  if (!samples.length) return 0
  const { index } = pointAtDistance(samples, distance)
  if (index <= 0) return profile[0] ?? 0
  const a = samples[index - 1]
  const b = samples[index]
  let before = 0
  for (let i = 1; i < index; i++) before += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y)
  const length = Math.hypot(b.x - a.x, b.y - a.y)
  const t = length > 0 ? Math.max(0, Math.min(1, (distance - before) / length)) : 1
  return profile[index - 1] + (profile[index] - profile[index - 1]) * t
}

/**
 * 运行时速度积分：加速追赶上限，超出上限按更强的制动收回。
 * 返回新的速度，至少为 minSpeed（只要还没到终点）。
 */
export function stepSpeed(current: number, limit: number, deltaSeconds: number, tuning = LOCOMOTION): number {
  const target = Math.max(tuning.minSpeed, limit)
  if (current < target) return Math.min(target, current + tuning.accel * deltaSeconds)
  return Math.max(target, current - tuning.decel * 1.5 * deltaSeconds)
}

/** 带滞回的朝向：只有另一轴明显占优时才切换，避免斜走时来回抽搐 */
export function nextFacing(current: ChibiFacing, dx: number, dy: number, ratio: number = LOCOMOTION.facingRatio): ChibiFacing {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax < 1e-6 && ay < 1e-6) return current
  const horizontal = current === 'left' || current === 'right'
  const useHorizontal = horizontal ? ax * ratio >= ay : ax > ay * ratio
  if (useHorizontal) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'front' : 'back'
}

/** 每位员工固定的步速系数（0.9–1.1），同一座位每次一致，避免全员齐步走 */
export function paceFactor(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  return 0.9 + ((h >>> 0) % 1000) / 1000 * 0.2
}
