/**
 * 员工之间的碰撞避让（纯函数，不依赖 Pixi / DOM，便于单测与无头仿真）。
 *
 * 寻路（geometry.findPath）只躲墙和家具，不知道别人在哪。这里在「沿路径行走」之上叠加人与人的避让，
 * 不改路径本身，只做两件事：
 * 1. 横向让位：路径前方有人（站着或迎面走来）时，在路径侧边错开一个身位，让过去再回到路径上。
 *    迎面相遇统一靠自己的右手边，双方各让一半，像真人那样擦肩而过；站着的人从空的那一侧绕；
 * 2. 礼让：两侧都没有空间（窄过道、门口）时，按「先来后到」定先后——后出发的侧身让到路边停下等，
 *    先出发的直接过去，而不是双方同时刹停、面对面僵持；站着的人没有先后，只能绕或等；
 * 3. 减速/等待：实在让不开就先停下来等，等不到就允许短暂穿过，绝不死锁。
 *
 * 坐标系：地图像素，x 向右、y 向下。「右手边」指角色行进方向的右侧：
 * 向右走时右手边是屏幕下方，法线 = (-ty, tx)。
 */
import type { MapPoint } from './types.ts'

export interface CrowdTuning {
  clearance: number
  lookAhead: number
  behind: number
  predict: number
  maxDodge: number
  lateralRate: number
  leftPenalty: number
  brakeGain: number
  ghostAfter: number
  ghostSpread: number
  ghostFor: number
  settleDistance: number
}

export const CROWD: Readonly<CrowdTuning> = {
  /** 两人中心点的最小舒适距离（px）：两个身位 */
  clearance: 24,
  /** 向前探测距离（px） */
  lookAhead: 76,
  /** 身后多远内的人仍算「并排」，避免擦着肩膀走（px） */
  behind: 10,
  /** 对移动中的人，再按这个时间（秒）外推位置一并避让 */
  predict: 0.5,
  /** 最大横向让位（px） */
  maxDodge: 40,
  /** 横向让位的移动速度（px/s） */
  lateralRate: 90,
  /** 往左绕比往右绕多付的代价（px）：迎面相遇时双方都偏右，才能错开 */
  leftPenalty: 8,
  /** 前方被挡住时的制动增益（1/s）：限速 = 距离余量 × 增益 */
  brakeGain: 2.2,
  /** 被挡住后多久放弃避让、短暂穿过（秒）；再按身份加一点随机，避免双方同时放弃 */
  ghostAfter: 2.4,
  ghostSpread: 1.2,
  /** 放弃避让后无视他人的时长（秒） */
  ghostFor: 2.2,
  /** 终点前多少 px 内把横向偏移收回 0，保证停在预留的站位上 */
  settleDistance: 28,
}

/** 窄处实在让不开时的「挤一挤」参数：间距收到两人刚好不重叠，允许绕得更远 */
export const CROWD_TIGHT: Readonly<CrowdTuning> = { ...CROWD, clearance: 14, maxDodge: 56 }

export interface CrowdNeighbor {
  id: string
  x: number
  y: number
  /** 当前速度向量（px/s），静止为 0 */
  vx: number
  vy: number
  /**
   * 走动中的通行先后（先出发的数小，先走）。没在走（站着、坐着、起身 / 手扶椅子中）为 undefined：
   * 他们不会让位，只能被别人绕开。
   */
  rank?: number
}

export interface CrowdSelf {
  id: string
  /** 路径上的当前点（不含横向偏移） */
  x: number
  y: number
  /** 路径切线（单位向量） */
  tx: number
  ty: number
  /** 当前横向偏移（右手边为正） */
  lateral: number
  /** 当前沿路径前进的速度（px/s） */
  speed: number
  /** 自己的通行先后，含义同 CrowdNeighbor.rank；缺省则不参与礼让（行为同没有先后时一样） */
  rank?: number
}

export interface Avoidance {
  /** 想要的横向偏移（右手边为正） */
  lateralTarget: number
  /** 避让带来的速度上限（px/s），Infinity 表示不限 */
  speedLimit: number
  /** 两侧都没有空位，只能等 */
  blocked: boolean
  /** 正在礼让：对方先走，自己侧身让到路边停下等 */
  yielding: boolean
}

/** 与对方的通行先后：mine = 我先走（对方该让我），theirs = 对方先走（我让），none = 没有先后（对方站着或没排号） */
type Precedence = 'mine' | 'theirs' | 'none'

interface Threat {
  s: number
  c: number
  precedence: Precedence
}

function precedenceOf(self: CrowdSelf, other: CrowdNeighbor): Precedence {
  if (self.rank === undefined || other.rank === undefined) return 'none'
  return hasRightOfWay(self.rank, self.id, other.rank, other.id) ? 'mine' : 'theirs'
}

/** 通行先后：数小者先走；数相同按 id 定，保证双方各自算出来的结论互补 */
export function hasRightOfWay(selfRank: number, selfId: string, otherRank: number, otherId: string): boolean {
  return selfRank !== otherRank ? selfRank < otherRank : selfId < otherId
}

/** 字符串哈希到 [0,1)：同一个人每次一样，用于打散「同时放弃避让」 */
export function idUnit(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return ((h >>> 0) % 1000) / 1000
}

/** 该员工被挡住多久后放弃避让（秒） */
export function ghostThreshold(id: string, tuning: Readonly<CrowdTuning> = CROWD): number {
  return tuning.ghostAfter + idUnit(id) * tuning.ghostSpread
}

/**
 * 在候选横向位置里挑一个：离当前偏移近、不往左绕（迎面时双方都偏右才能错开）、
 * 与所有威胁保持 clearance、且站得住。没有就返回 null。
 */
function pickLateral(
  relevant: readonly Threat[],
  currentLateral: number,
  walkable: (lateral: number) => boolean,
  tuning: Readonly<CrowdTuning>,
): number | null {
  const clr = tuning.clearance
  const free = (lat: number): boolean => relevant.every((t) => lat <= t.c - clr || lat >= t.c + clr)
  const candidates = new Set<number>([0])
  for (const t of relevant) {
    candidates.add(t.c + clr + 1)
    candidates.add(t.c - clr - 1)
  }
  let best: number | null = null
  let bestCost = Infinity
  for (const lat of candidates) {
    if (Math.abs(lat) > tuning.maxDodge || !free(lat) || !walkable(lat)) continue
    const cost = Math.abs(lat - currentLateral) + (lat < 0 ? tuning.leftPenalty : 0) + (lat !== 0 ? 1 : 0)
    if (cost < bestCost) {
      bestCost = cost
      best = lat
    }
  }
  return best
}

/**
 * 计算本帧的避让：想要的横向偏移与速度上限。
 * @param isBlockedAt 静态阻挡检测（墙、家具）：让位后的点不能站进障碍里
 */
export function computeAvoidance(
  self: CrowdSelf,
  neighbors: readonly CrowdNeighbor[],
  isBlockedAt: (point: MapPoint) => boolean,
  tuning: Readonly<CrowdTuning> = CROWD,
): Avoidance {
  const nx = -self.ty
  const ny = self.tx
  const clr = tuning.clearance
  const threats: Threat[] = []

  for (const other of neighbors) {
    if (other.id === self.id) continue
    // 同向、速度不比我慢的人在前面带路：不用绕，跟着走就行（太近了才算威胁）
    const along = other.vx * self.tx + other.vy * self.ty
    const ahead = (other.x - self.x) * self.tx + (other.y - self.y) * self.ty
    if (along > 10 && along >= self.speed * 0.8 && ahead > clr) continue
    const precedence = precedenceOf(self, other)
    const samples = [
      { x: other.x, y: other.y },
      { x: other.x + other.vx * tuning.predict, y: other.y + other.vy * tuning.predict },
    ]
    for (const p of samples) {
      const dx = p.x - self.x
      const dy = p.y - self.y
      const s = dx * self.tx + dy * self.ty
      if (s < -tuning.behind || s > tuning.lookAhead) continue
      threats.push({ s, c: dx * nx + dy * ny, precedence })
    }
  }

  // 只有侧向范围与「路径中线 ~ 当前位置」重叠的人才构成威胁
  const lo = Math.min(0, self.lateral) + 0.5
  const hi = Math.max(0, self.lateral) - 0.5
  const relevant = threats.filter((t) => t.c - clr < Math.max(hi, lo) && t.c + clr > Math.min(hi, lo))
  if (relevant.length === 0) return { lateralTarget: 0, speedLimit: Infinity, blocked: false, yielding: false }

  const walkable = (lat: number): boolean => !isBlockedAt({ x: self.x + nx * lat, y: self.y + ny * lat })
  const best = pickLateral(relevant, self.lateral, walkable, tuning)

  // 正在拐出让位的途中：离对方还近就先放慢，别一头撞上去
  const nearest = relevant.reduce((min, t) => Math.min(min, Math.max(0, t.s)), Infinity)
  const settlingLimit = (target: number): number =>
    Math.abs(target - self.lateral) > 4 && nearest < clr * 1.6 ? 28 : Infinity
  if (best !== null) {
    return { lateralTarget: best, speedLimit: settlingLimit(best), blocked: false, yielding: false }
  }

  // 正常间距下没有空位
  const inLane = relevant.filter((t) => Math.abs(t.c - self.lateral) < clr)
  const lane = inLane.length ? inLane : relevant
  const gap = lane.reduce((min, t) => Math.min(min, t.s), Infinity)
  const brake = (standoff: number): number => Math.max(0, gap - clr * standoff) * tuning.brakeGain

  // 挡路的都是走动中的人：按先来后到礼让，而不是双方同时刹停僵持。
  // 双方都按「挤一挤」的间距找空档；先走的直接过去，后走的让到路边停下等对方过完。
  if (lane.every((t) => t.precedence !== 'none')) {
    const squeeze = pickLateral(
      relevant,
      self.lateral,
      walkable,
      { ...tuning, clearance: Math.min(clr, CROWD_TIGHT.clearance), maxDodge: Math.max(tuning.maxDodge, CROWD_TIGHT.maxDodge) },
    )
    const lateralTarget = squeeze ?? self.lateral
    if (lane.some((t) => t.precedence === 'theirs')) {
      return { lateralTarget, speedLimit: brake(0.95), blocked: true, yielding: true }
    }
    // 对方该让我：有空档就不减速；连挤的空档都没有，就靠近到贴脸前停住，并计入等待（超时仍会放宽，不死锁）
    return {
      lateralTarget,
      speedLimit: squeeze !== null ? settlingLimit(squeeze) : brake(0.7),
      blocked: squeeze === null,
      yielding: false,
    }
  }

  // 挡路的有站着不动的人（或没排号）：只能停在对方前面等
  return { lateralTarget: self.lateral, speedLimit: brake(0.95), blocked: true, yielding: false }
}

/** 点周围 minDistance 内没有任何人 */
export function isPointFree(point: MapPoint, others: readonly MapPoint[], minDistance = CROWD.clearance): boolean {
  return others.every((o) => Math.hypot(o.x - point.x, o.y - point.y) >= minDistance)
}

/**
 * 找离 desired 最近的、没人占用且不在障碍里的站位。
 * 以 desired 为圆心一圈圈向外找（步长 step，逐圈 8/12/16 个方向）。
 */
export function findFreePoint(
  desired: MapPoint,
  others: readonly MapPoint[],
  isBlockedAt: (point: MapPoint) => boolean,
  minDistance = CROWD.clearance,
  maxRadius = 96,
  step = 16,
): MapPoint | null {
  const ok = (p: MapPoint) => !isBlockedAt(p) && isPointFree(p, others, minDistance)
  if (ok(desired)) return { ...desired }
  for (let radius = step; radius <= maxRadius; radius += step) {
    const count = Math.max(8, Math.round((2 * Math.PI * radius) / step))
    for (let k = 0; k < count; k++) {
      const angle = (2 * Math.PI * k) / count
      const p = { x: desired.x + Math.cos(angle) * radius, y: desired.y + Math.sin(angle) * radius }
      if (ok(p)) return p
    }
  }
  return null
}

/**
 * 硬间距约束：预判式让位（computeAvoidance）只是「尽量躲开」，两人同时往对方让的方向躲时仍会叠上。
 * 这一层兜底：任何两人间距小于 minSeparation 就沿连线推开，保证不会叠在一起。
 * 对方静止（站着 / 坐着 / 在等）推满，对方也在动则各推一半（双方都按同一份快照算，合起来正好推开）。
 */
export const SEPARATION = {
  /** 正常最小间距（px）：略大于角色身宽，肩并肩擦过去不穿模 */
  normal: 17,
  /** 窄处「挤一挤」时的最小间距（px） */
  tight: 13,
  /** 每秒最多修正多少 px：避免被一把「弹开」 */
  rate: 150,
  /** 没有人挤时推开量回落的速率（1/s） */
  decay: 3,
  /** 推开量上限（px） */
  max: 36,
  /** 放弃避让（穿过）时推开量收回的速率（1/s） */
  release: 10,
} as const

export function separationPush(
  at: MapPoint,
  selfId: string,
  neighbors: readonly CrowdNeighbor[],
  minSeparation: number,
  heading: MapPoint = { x: 0, y: 1 },
): MapPoint {
  let x = 0
  let y = 0
  for (const other of neighbors) {
    if (other.id === selfId) continue
    const dx = at.x - other.x
    const dy = at.y - other.y
    const distance = Math.hypot(dx, dy)
    if (distance >= minSeparation) continue
    const share = Math.hypot(other.vx, other.vy) < 3 ? 1 : 0.5
    // 完全重合时没有连线方向：推向自己行进方向的右手边
    const ux = distance < 1e-3 ? -heading.y : dx / distance
    const uy = distance < 1e-3 ? heading.x : dy / distance
    x += ux * (minSeparation - distance) * share
    y += uy * (minSeparation - distance) * share
  }
  return { x, y }
}
