/**
 * 从编辑工具 src/model.js 移植的几何与寻路纯函数。
 * 必须与编辑器保持一致，否则前端复刻的碰撞/通路会和编辑工具不同。
 */
import type { MapElement, MapPoint, MapRect, OfficeMap } from './types'

export type WalkMode = 'employee' | 'any'

export function elementPolygon(element: MapElement): MapPoint[] {
  const r = (element.rotation * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  const half = [
    [-element.width / 2, -element.height / 2],
    [element.width / 2, -element.height / 2],
    [element.width / 2, element.height / 2],
    [-element.width / 2, element.height / 2],
  ]
  return half.map(([x, y]) => ({
    x: element.x + x * c - y * s,
    y: element.y + x * s + y * c,
  }))
}

/** 把图元局部（基准尺寸或 geometry）坐标换算到世界坐标 */
export function elementPoint(
  element: MapElement,
  point: MapPoint,
  size: { width: number; height: number } = element.geometry ?? element,
): MapPoint {
  const x = (point.x / size.width) * element.width - element.width / 2
  const y = (point.y / size.height) * element.height - element.height / 2
  const r = (element.rotation * Math.PI) / 180
  return {
    x: element.x + x * Math.cos(r) - y * Math.sin(r),
    y: element.y + x * Math.sin(r) + y * Math.cos(r),
  }
}

/** 图元局部矩形（基准尺寸坐标）换算成世界多边形 */
export function localRectPoints(
  element: MapElement,
  rect: MapRect,
  size: { width: number; height: number } = element.geometry ?? element,
): MapPoint[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ].map((p) => elementPoint(element, p, size))
}

export function elementFootprints(element: MapElement): MapPoint[][] {
  if (!element.geometry?.footprints) return [elementPolygon(element)]
  return element.geometry.footprints.map((rect) => localRectPoints(element, rect))
}

export function segmentDistance(p: MapPoint, a: MapPoint, b: MapPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}

export function pointInPolygon(p: MapPoint, points: MapPoint[]): boolean {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]
    const b = points[j]
    if (segmentDistance(p, a, b) < 1e-7) return true
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

function cross(a: MapPoint, b: MapPoint, c: MapPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

export function segmentsIntersect(a: MapPoint, b: MapPoint, c: MapPoint, d: MapPoint): boolean {
  const v = [cross(a, b, c), cross(a, b, d), cross(c, d, a), cross(c, d, b)]
  if (v[0] * v[1] < 0 && v[2] * v[3] < 0) return true
  return (
    segmentDistance(a, c, d) < 1e-7 ||
    segmentDistance(b, c, d) < 1e-7 ||
    segmentDistance(c, a, b) < 1e-7 ||
    segmentDistance(d, a, b) < 1e-7
  )
}

/**
 * 阻挡多边形集合：所有 blocksMovement 元素的占地 + 启用的禁区。
 * mode 为 employee 时，employee-no-entry 也参与阻挡。
 */
export function blockers(map: OfficeMap, mode: WalkMode = 'employee'): MapPoint[][] {
  return [
    ...map.elements.filter((e) => e.blocksMovement).flatMap((e) => elementFootprints(e)),
    ...map.zones
      .filter((z) => z.enabled && (z.type === 'walk-blocked' || (mode === 'employee' && z.type === 'employee-no-entry')))
      .map((z) => z.points),
  ]
}

export function isBlocked(
  map: OfficeMap,
  p: MapPoint,
  radius = 8,
  mode: WalkMode = 'employee',
  polygons: MapPoint[][] = blockers(map, mode),
): boolean {
  if (p.x < radius || p.y < radius || p.x > map.width - radius || p.y > map.height - radius) return true
  return polygons.some(
    (poly) => pointInPolygon(p, poly) || poly.some((a, i) => segmentDistance(p, a, poly[(i + 1) % poly.length]) <= radius),
  )
}

export function clearSegment(
  map: OfficeMap,
  a: MapPoint,
  b: MapPoint,
  radius: number,
  mode: WalkMode = 'employee',
  polygons: MapPoint[][] = blockers(map, mode),
): boolean {
  if (isBlocked(map, a, radius, mode, polygons) || isBlocked(map, b, radius, mode, polygons)) return false
  return !polygons.some((poly) =>
    poly.some((c, i) => {
      const d = poly[(i + 1) % poly.length]
      return (
        segmentsIntersect(a, b, c, d) ||
        Math.min(segmentDistance(a, c, d), segmentDistance(b, c, d), segmentDistance(c, a, b), segmentDistance(d, a, b)) <=
          radius
      )
    }),
  )
}

/** 寻路网格步长与行列数：与编辑器一致，Navigator 的边缓存也据此编号 */
function gridLayout(map: OfficeMap): { step: number; cols: number; rows: number } {
  const step = Math.max(map.gridSize, Math.ceil(Math.max(map.width, map.height) / 160))
  return { step, cols: Math.ceil(map.width / step), rows: Math.ceil(map.height / step) }
}

/** 寻路搜索用到的三个判定；参考实现（findPath）与加速实现（Navigator）各给一份，BFS 本身只有一份 */
interface SearchProbe {
  blocked(p: MapPoint): boolean
  clear(a: MapPoint, b: MapPoint): boolean
  /** 网格上相邻两格（id → next，中心点 a → b）之间是否通畅 */
  edge(id: number, next: number, a: MapPoint, b: MapPoint): boolean
}

const UNSEEN = -2
const NO_PARENT = -1

/**
 * 保守四邻域 BFS：起终点各自接入周围 3×3 格里能直达的格子，格与格之间逐段精确检查。
 * 邻居顺序（左、右、上、下）与起终点接入顺序决定了同长路径里选哪一条，改动会让路线与编辑器不一致。
 */
function searchPath(map: OfficeMap, start: MapPoint, end: MapPoint, probe: SearchProbe): MapPoint[] | null {
  if (probe.blocked(start) || probe.blocked(end)) return null
  if (probe.clear(start, end)) return [start, end]

  const { step, cols, rows } = gridLayout(map)
  const point = (id: number): MapPoint => ({ x: ((id % cols) + 0.5) * step, y: (Math.floor(id / cols) + 0.5) * step })

  const attach = (p: MapPoint): number[] => {
    const candidates: number[] = []
    const x = Math.floor(p.x / step)
    const y = Math.floor(p.y / step)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (x + dx < 0 || x + dx >= cols || y + dy < 0 || y + dy >= rows) continue
        const id = (y + dy) * cols + (x + dx)
        if (probe.clear(p, point(id))) candidates.push(id)
      }
    }
    return candidates
  }

  const starts = attach(start)
  const ends = new Set(attach(end))
  // 每格最多入队一次，队列开满格子数即可；比 Map + 动态数组少很多分配
  const previous = new Int32Array(cols * rows).fill(UNSEEN)
  const queue = new Int32Array(cols * rows)
  let tail = 0
  for (const id of starts) {
    previous[id] = NO_PARENT
    queue[tail++] = id
  }

  for (let head = 0; head < tail; head++) {
    const id = queue[head]
    if (ends.has(id)) {
      const path: MapPoint[] = [end]
      for (let cursor = id; cursor !== NO_PARENT; cursor = previous[cursor]) path.push(point(cursor))
      path.push(start)
      return path.reverse()
    }
    const x = id % cols
    const y = (id - x) / cols
    for (let k = 0; k < 4; k++) {
      const nx = k === 0 ? x - 1 : k === 1 ? x + 1 : x
      const ny = k === 2 ? y - 1 : k === 3 ? y + 1 : y
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue
      const next = ny * cols + nx
      if (previous[next] !== UNSEEN || !probe.edge(id, next, point(id), point(next))) continue
      previous[next] = id
      queue[tail++] = next
    }
  }
  return null
}

/**
 * 保守四邻域寻路，逐段精确检查以防穿薄墙。
 * 与编辑器一致：找不到通路返回 null。
 * 这是不带缓存的参考实现；场景里每次起步都要寻路，走 Navigator（结果与这里逐点一致，快一到两个数量级）。
 */
export function findPath(
  map: OfficeMap,
  start: MapPoint,
  end: MapPoint,
  radius = 8,
  mode: WalkMode = 'employee',
  /** 临时障碍（例如没在走动的人），与墙、家具同样按 radius 留净距 */
  extra: readonly MapPoint[][] = [],
): MapPoint[] | null {
  const polygons = extra.length ? [...blockers(map, mode), ...extra] : blockers(map, mode)
  const clear = (a: MapPoint, b: MapPoint) => clearSegment(map, a, b, radius, mode, polygons)
  return searchPath(map, start, end, {
    blocked: (p) => isBlocked(map, p, radius, mode, polygons),
    clear,
    edge: (_id, _next, a, b) => clear(a, b),
  })
}

// ---------------------------------------------------------------- 加速版：包围盒剔除 + 静态边缓存

/** 包围盒外扩的容差：覆盖 pointInPolygon / segmentsIntersect 里 1e-7 的贴边判定 */
const BOX_EPSILON = 1e-6

/** 一组阻挡多边形与各自的包围盒（minX, minY, maxX, maxY 依次排布） */
export interface ObstacleSet {
  readonly polygons: readonly MapPoint[][]
  readonly boxes: Float64Array
}

export function obstacleSet(polygons: readonly MapPoint[][]): ObstacleSet {
  const boxes = new Float64Array(polygons.length * 4)
  polygons.forEach((poly, i) => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of poly) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
    boxes.set([minX, minY, maxX, maxY], i * 4)
  })
  return { polygons, boxes }
}

/** 点是否落在某个多边形里或离其边不超过 radius（isBlocked 的多边形部分，先按包围盒剔除） */
function pointBlockedBy(set: ObstacleSet, p: MapPoint, radius: number): boolean {
  const pad = radius + BOX_EPSILON
  const { polygons, boxes } = set
  for (let i = 0; i < polygons.length; i++) {
    const k = i * 4
    if (p.x < boxes[k] - pad || p.x > boxes[k + 2] + pad || p.y < boxes[k + 1] - pad || p.y > boxes[k + 3] + pad) continue
    const poly = polygons[i]
    if (pointInPolygon(p, poly) || poly.some((a, j) => segmentDistance(p, a, poly[(j + 1) % poly.length]) <= radius)) return true
  }
  return false
}

/** 线段是否碰到某个多边形的边或离其边不超过 radius（clearSegment 的多边形部分，先按包围盒剔除） */
function segmentBlockedBy(set: ObstacleSet, a: MapPoint, b: MapPoint, radius: number): boolean {
  const pad = radius + BOX_EPSILON
  const minX = Math.min(a.x, b.x) - pad
  const maxX = Math.max(a.x, b.x) + pad
  const minY = Math.min(a.y, b.y) - pad
  const maxY = Math.max(a.y, b.y) + pad
  const { polygons, boxes } = set
  for (let i = 0; i < polygons.length; i++) {
    const k = i * 4
    if (boxes[k + 2] < minX || boxes[k] > maxX || boxes[k + 3] < minY || boxes[k + 1] > maxY) continue
    const poly = polygons[i]
    const hit = poly.some((c, j) => {
      const d = poly[(j + 1) % poly.length]
      return (
        segmentsIntersect(a, b, c, d) ||
        Math.min(segmentDistance(a, c, d), segmentDistance(b, c, d), segmentDistance(c, a, b), segmentDistance(d, a, b)) <= radius
      )
    })
    if (hit) return true
  }
  return false
}

function inBounds(map: OfficeMap, p: MapPoint, radius: number): boolean {
  return !(p.x < radius || p.y < radius || p.x > map.width - radius || p.y > map.height - radius)
}

/** 某个半径下，寻路网格每条边（右、下各一条）的通畅缓存：0 = 没算过，1 = 通，2 = 不通 */
type EdgeCache = Uint8Array

/**
 * 同一张地图上反复寻路 / 碰撞检测的加速器，结果与 isBlocked / clearSegment / findPath 完全一致。
 *
 * 慢在哪：地图上有一百多个阻挡多边形，网格 BFS 每探一条边都要对全部多边形逐边计算，
 * 一次寻路几十到几百毫秒，且在渲染线程同步执行 —— 员工一起步就掉帧。这里做两件事：
 * 1. 包围盒剔除：一条 16px 的网格边只可能碰到附近的几个多边形；
 * 2. 静态边缓存：墙和家具不会动，网格边通不通按（半径）只算一次；
 *    会动的「临时障碍」（静止的人）数量很少，每次单独叠加判断。
 */
export class Navigator {
  // 不用构造函数参数属性：测试用 node 的 strip-types 直接跑 .ts，不支持这种语法
  readonly map: OfficeMap
  readonly mode: WalkMode
  readonly polygons: MapPoint[][]
  private readonly statics: ObstacleSet
  private readonly grid: { step: number; cols: number; rows: number }
  private readonly edgeCaches = new Map<number, EdgeCache>()

  constructor(map: OfficeMap, mode: WalkMode = 'employee') {
    this.map = map
    this.mode = mode
    this.polygons = blockers(map, mode)
    this.statics = obstacleSet(this.polygons)
    this.grid = gridLayout(map)
  }

  isBlocked(p: MapPoint, radius = 8, extra?: ObstacleSet): boolean {
    return !inBounds(this.map, p, radius) || pointBlockedBy(this.statics, p, radius) || (!!extra && pointBlockedBy(extra, p, radius))
  }

  clearSegment(a: MapPoint, b: MapPoint, radius: number, extra?: ObstacleSet): boolean {
    return this.staticClear(a, b, radius) && (!extra || this.extraClear(a, b, radius, extra))
  }

  findPath(start: MapPoint, end: MapPoint, radius = 8, extra?: ObstacleSet): MapPoint[] | null {
    const cache = this.edgeCache(radius)
    return searchPath(this.map, start, end, {
      blocked: (p) => this.isBlocked(p, radius, extra),
      clear: (a, b) => this.clearSegment(a, b, radius, extra),
      edge: (id, next, a, b) => {
        const slot = Math.min(id, next) * 2 + (Math.abs(id - next) === 1 ? 0 : 1)
        let state = cache[slot]
        if (state === 0) {
          state = this.staticClear(a, b, radius) ? 1 : 2
          cache[slot] = state
        }
        return state === 1 && (!extra || this.extraClear(a, b, radius, extra))
      },
    })
  }

  /** 把这些半径的网格边一次算完。放在场景加载阶段做，运行时第一次寻路就不用现算 */
  warm(radii: readonly number[]): void {
    const { cols, rows, step } = this.grid
    const center = (x: number, y: number): MapPoint => ({ x: (x + 0.5) * step, y: (y + 0.5) * step })
    for (const radius of radii) {
      const cache = this.edgeCache(radius)
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const id = y * cols + x
          const here = center(x, y)
          if (x + 1 < cols && cache[id * 2] === 0) cache[id * 2] = this.staticClear(here, center(x + 1, y), radius) ? 1 : 2
          if (y + 1 < rows && cache[id * 2 + 1] === 0) cache[id * 2 + 1] = this.staticClear(here, center(x, y + 1), radius) ? 1 : 2
        }
      }
    }
  }

  private edgeCache(radius: number): EdgeCache {
    let cache = this.edgeCaches.get(radius)
    if (!cache) {
      cache = new Uint8Array(this.grid.cols * this.grid.rows * 2)
      this.edgeCaches.set(radius, cache)
    }
    return cache
  }

  private staticClear(a: MapPoint, b: MapPoint, radius: number): boolean {
    if (!inBounds(this.map, a, radius) || !inBounds(this.map, b, radius)) return false
    return !pointBlockedBy(this.statics, a, radius) && !pointBlockedBy(this.statics, b, radius) && !segmentBlockedBy(this.statics, a, b, radius)
  }

  /** 临时障碍的部分（边界已由静态部分检查过） */
  private extraClear(a: MapPoint, b: MapPoint, radius: number, extra: ObstacleSet): boolean {
    return !pointBlockedBy(extra, a, radius) && !pointBlockedBy(extra, b, radius) && !segmentBlockedBy(extra, a, b, radius)
  }
}

export interface SeatAnchors {
  seat: MapPoint
  approach: MapPoint | null
}

/** 由桌面元素 + seatOffset/approachOffset 解出员工与接近点的世界坐标 */
export function seatAnchors(desk: MapElement, seatOffset?: MapPoint, approachOffset?: MapPoint): SeatAnchors {
  return {
    seat: seatOffset ? elementPoint(desk, seatOffset, { width: 1, height: 1 }) : { x: desk.x, y: desk.y },
    approach: approachOffset ? elementPoint(desk, approachOffset, { width: 1, height: 1 }) : null,
  }
}

/** 把一段路径按固定步长细分，便于匀速动画 */
export function samplePath(points: MapPoint[], step: number): MapPoint[] {
  if (points.length < 2) return [...points]
  const out: MapPoint[] = [{ ...points[0] }]
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const distance = Math.hypot(b.x - a.x, b.y - a.y)
    const count = Math.max(1, Math.ceil(distance / step))
    for (let k = 1; k <= count; k++) out.push({ x: a.x + ((b.x - a.x) * k) / count, y: a.y + ((b.y - a.y) * k) / count })
  }
  return out
}

/** 朝向：与 AIFred 一致，dx>0 → right，dy>0 → front */
export function facingFromDelta(dx: number, dy: number): 'front' | 'back' | 'left' | 'right' {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'front' : 'back'
}

export function pathLength(points: MapPoint[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  return total
}

/** 按已走距离在路径上取点 */
export function pointAtDistance(points: MapPoint[], distance: number): { point: MapPoint; index: number } {
  if (!points.length) return { point: { x: 0, y: 0 }, index: 0 }
  let remaining = distance
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (remaining <= length) {
      const t = length === 0 ? 0 : remaining / length
      return { point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, index: i }
    }
    remaining -= length
  }
  return { point: points[points.length - 1], index: points.length - 1 }
}
