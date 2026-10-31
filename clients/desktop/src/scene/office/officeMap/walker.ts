/**
 * 单个员工沿路径走动的状态机（纯函数，不依赖 Pixi / DOM）。
 *
 * 场景（MapOfficeScene）负责把结果写到角色上，这里只管「怎么走」：
 * 路径整形 → 起身/转身停顿 → 加速/巡航/转弯放慢/收步 → 人与人的避让（crowd.ts）。
 * 拆成纯函数是为了能在 node 里用真实地图做多人走动仿真，验证不穿人、不死锁。
 */
import { pathLength, pointAtDistance, samplePath } from './geometry.ts'
import {
  LOCOMOTION,
  buildSpeedProfile,
  roundCorners,
  simplifyPath,
  speedLimitAt,
  stepSpeed,
} from './locomotion.ts'
import { CROWD, CROWD_TIGHT, SEPARATION, computeAvoidance, ghostThreshold, separationPush, type CrowdNeighbor } from './crowd.ts'
import type { MapPoint } from './types.ts'

export interface WalkState {
  samples: MapPoint[]
  /** 巡航速度（px/s，已含个体差异）：中途改道重新规划时沿用 */
  cruise: number
  /** 每个采样点的速度上限（曲率限速 + 终点减速） */
  profile: number[]
  distance: number
  /** 当前实际速度（px/s），由加减速积分得到 */
  speed: number
  total: number
  /** 迈步前的停顿（起身 / 转身），秒 */
  delay: number
  /** 距离允许再次转身的剩余时间，秒 */
  facingCooldown: number
  /** 横向让位偏移（px，行进方向右手边为正） */
  lateral: number
  /** 硬间距推开量（px，世界坐标）：被人挤到时累积，没人挤时回落；临近终点淡出 */
  nudge: MapPoint
  /** 连续被挡住的时间（秒） */
  blockedFor: number
  /**
   * 避让放宽等级：0 = 正常间距；1 = 挤一挤（间距收窄）；2 = 放弃避让、短暂穿过。
   * 被挡住超时才逐级升高，relaxFor 走完回到 0——保证窄道/门口绝不死锁，同时尽量不穿人。
   */
  relax: 0 | 1 | 2
  relaxFor: number
  /** 通行先后（先出发的数小，先走），窄处相遇时用来定谁让谁，见 crowd.ts；缺省不参与礼让 */
  rank?: number
}

/** 把寻路折线整形成可走的采样路径：拉直 → 拐角倒圆 → 等距采样 */
export function planWalkSamples(
  points: readonly MapPoint[],
  isClear: (a: MapPoint, b: MapPoint) => boolean,
): MapPoint[] {
  return samplePath(roundCorners(simplifyPath([...points], isClear), isClear), LOCOMOTION.sampleStep)
}

export function createWalkState(init: {
  samples: MapPoint[]
  cruise: number
  /** 起步速度：中途改道时沿用当前速度，从静止出发为 0 */
  speed?: number
  delay?: number
  /** 途中必须停住的采样点下标（到点后由调用方接管，停够了再继续走） */
  stops?: readonly number[]
  /** 通行先后：中途改道时沿用原来的，不然改道的人会被排到队尾 */
  rank?: number
  /**
   * 中途改道时沿用的「被挡住」进度：不沿用的话每次改道都把计时清零，
   * 被堵住的人改道得越勤，越攒不够「放宽避让」的时间，兜底就失效了
   */
  inherit?: Pick<WalkState, 'blockedFor' | 'relax' | 'relaxFor'>
}): WalkState {
  return {
    samples: init.samples,
    cruise: init.cruise,
    profile: buildSpeedProfile(init.samples, init.cruise, undefined, init.stops),
    distance: 0,
    speed: init.speed ?? 0,
    total: pathLength(init.samples),
    delay: init.delay ?? 0,
    facingCooldown: 0,
    lateral: 0,
    nudge: { x: 0, y: 0 },
    blockedFor: init.inherit?.blockedFor ?? 0,
    relax: init.inherit?.relax ?? 0,
    relaxFor: init.inherit?.relaxFor ?? 0,
    rank: init.rank,
  }
}

/**
 * 写进人群快照的通行先后。起身 / 转身的停顿里（delay > 0）人还没迈步，和站着一样只能被别人绕，所以不排号。
 */
export function walkRank(walk: WalkState): number | undefined {
  return walk.delay > 0 ? undefined : walk.rank
}

export interface WalkEnv {
  selfId: string
  /** 其他角色（不含自己）的位置与速度 */
  neighbors: readonly CrowdNeighbor[]
  /** 静态阻挡检测：点是否落在墙/家具里 */
  isBlockedAt: (point: MapPoint) => boolean
}

export interface WalkStep {
  x: number
  y: number
  speed: number
  /** 是否已走到终点 */
  arrived: boolean
  /** 被人挡住、正在原地等待 */
  waiting: boolean
  /** 正在礼让：对方先走，自己侧身让到路边停下等 */
  yielding: boolean
}

/** 偏移被障碍逼退时每帧最多收回的距离（px）：约为正常步速每帧位移的 2.5 倍，肉眼不会当作瞬移 */
const RETREAT_PX = 2.5

function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t))
  return x * x * (3 - 2 * x)
}

/**
 * 走动中判定「路线擦过静止的人」的距离（px，到人中心）。
 * 必须小于重新规划后路线保证的净距：绕人的寻路把人当 16×16 的方块，净距 8px 时路线离人中心至少 16px，
 * 阈值再大就会出现「刚绕开又判定擦过，于是反复重新规划同一条路」。
 */
export const REROUTE_CLEARANCE = 15

/**
 * 前方 lookAhead 内的路线是否从某个人身边擦过（距离小于 clearance）。
 * 路线是出发时规划的，规划时还没到的人（后来才站到路上的）逐帧避让只能侧身绕或停下等；
 * 发现了就该趁早重新规划。终点附近的人不算（目的地本来就靠着人，重新规划也绕不开）。
 */
export function pathNearPeople(walk: WalkState, people: readonly MapPoint[], clearance: number, lookAhead = 140): boolean {
  if (!people.length || walk.samples.length < 2) return false
  const end = walk.samples[walk.samples.length - 1]
  const relevant = people.filter((p) => Math.hypot(p.x - end.x, p.y - end.y) > clearance)
  if (!relevant.length) return false
  const stop = Math.min(walk.total, walk.distance + lookAhead)
  for (let d = walk.distance; d <= stop; d += LOCOMOTION.sampleStep) {
    const { point } = pointAtDistance(walk.samples, d)
    if (relevant.some((p) => Math.hypot(p.x - point.x, p.y - point.y) < clearance)) return true
  }
  return false
}

/** 当前位置（含横向偏移），不推进状态 */
export function walkPosition(walk: WalkState): MapPoint {
  const { point } = pointAtDistance(walk.samples, walk.distance)
  const ahead = pointAtDistance(walk.samples, Math.min(walk.total, walk.distance + 8)).point
  return offsetPoint(point, ahead, walk)
}

function offsetPoint(point: MapPoint, ahead: MapPoint, walk: WalkState): MapPoint {
  return offsetBy(point, ahead, walk.lateral, walk.total - walk.distance)
}

/** 在路径点 point（朝向 ahead）上叠加横向偏移；remaining 为到终点的剩余路程，临近终点偏移淡出 */
function offsetBy(point: MapPoint, ahead: MapPoint, lateralOffset: number, remaining: number): MapPoint {
  if (lateralOffset === 0) return point
  const dx = ahead.x - point.x
  const dy = ahead.y - point.y
  const length = Math.hypot(dx, dy)
  if (length < 1e-6) return point
  const lateral = lateralOffset * smoothstep(remaining / CROWD.settleDistance)
  return { x: point.x - (dy / length) * lateral, y: point.y + (dx / length) * lateral }
}

/**
 * 前方探测距离（px）：让位偏移在这些位置也得站得住。
 * 路径贴墙转弯时，偏移要在到墙边之前就开始收，而不是到了跟前才一帧收回（那会瞬移或擦进墙里）。
 */
const AHEAD_PROBES = [14, 28, 42]

function aheadFree(walk: WalkState, lateralOffset: number, isBlockedAt: (point: MapPoint) => boolean): boolean {
  for (const k of AHEAD_PROBES) {
    const distance = Math.min(walk.total, walk.distance + k)
    const point = pointAtDistance(walk.samples, distance).point
    const next = pointAtDistance(walk.samples, Math.min(walk.total, distance + 8)).point
    if (isBlockedAt(offsetBy(point, next, lateralOffset, walk.total - distance))) return false
  }
  return true
}

/**
 * 把想要的横向偏移限制到「前方 AHEAD_PROBES 处都站得住」的最大值（保持方向，逐档缩小到 0）。
 * 只改目标；偏移本身仍按 lateralRate 平滑跟随，所以前方有墙时是提前、平滑地收回。
 * 与 computeAvoidance 里「候选让位点不可站就排除」不同：这里不会让别人觉得无处可让而停下等待。
 */
function clampLateralAhead(walk: WalkState, target: number, isBlockedAt: (point: MapPoint) => boolean): number {
  let value = target
  for (let i = 0; i < 6 && Math.abs(value) > 0.5 && !aheadFree(walk, value, isBlockedAt); i++) value *= 0.6
  return Math.abs(value) > 0.5 ? value : 0
}

/** 推进一帧 */
export function stepWalk(walk: WalkState, deltaSeconds: number, env: WalkEnv): WalkStep {
  if (walk.delay > 0) {
    walk.delay -= deltaSeconds
    const at = walkPosition(walk)
    return { x: at.x, y: at.y, speed: 0, arrived: false, waiting: false, yielding: false }
  }

  const here = pointAtDistance(walk.samples, walk.distance).point
  const ahead = pointAtDistance(walk.samples, Math.min(walk.total, walk.distance + 8)).point
  const tx = ahead.x - here.x
  const ty = ahead.y - here.y
  const tl = Math.hypot(tx, ty)

  const profileLimit = speedLimitAt(walk.samples, walk.profile, walk.distance)
  let avoidLimit = Infinity
  let lateralTarget = 0
  let blocked = false
  let yielding = false
  walk.relaxFor = Math.max(0, walk.relaxFor - deltaSeconds)
  if (walk.relaxFor <= 0) walk.relax = 0
  if (tl > 1e-6 && walk.relax < 2) {
    const avoidance = computeAvoidance(
      { id: env.selfId, x: here.x, y: here.y, tx: tx / tl, ty: ty / tl, lateral: walk.lateral, speed: walk.speed, rank: walk.rank },
      env.neighbors,
      env.isBlockedAt,
      walk.relax === 1 ? CROWD_TIGHT : CROWD,
    )
    lateralTarget = avoidance.lateralTarget
    blocked = avoidance.blocked
    yielding = avoidance.yielding
    avoidLimit = avoidance.speedLimit
  }

  if (avoidLimit < LOCOMOTION.minSpeed) {
    // 避让要求停下：不走 stepSpeed 的最低速度保底，按制动减速到位（终点前的收步仍保留最低速度，确保能走到）
    walk.speed = Math.max(Math.min(avoidLimit, profileLimit), walk.speed - LOCOMOTION.decel * 1.5 * deltaSeconds)
  } else {
    walk.speed = stepSpeed(walk.speed, Math.min(profileLimit, avoidLimit), deltaSeconds)
  }
  walk.distance = Math.min(walk.total, walk.distance + walk.speed * deltaSeconds)

  const waiting = blocked && walk.speed < 3
  if (waiting) {
    walk.blockedFor += deltaSeconds
    if (walk.blockedFor >= ghostThreshold(env.selfId)) {
      walk.relax = Math.min(2, walk.relax + 1) as 1 | 2
      walk.relaxFor = CROWD.ghostFor
      walk.blockedFor = 0
    }
  } else {
    walk.blockedFor = Math.max(0, walk.blockedFor - deltaSeconds * 2)
  }

  // 横向偏移平滑跟随目标（目标先按前方障碍收窄）
  lateralTarget = clampLateralAhead(walk, lateralTarget, env.isBlockedAt)
  const lastLateral = walk.lateral
  const lastNudge = { x: walk.nudge.x, y: walk.nudge.y }
  const maxShift = CROWD.lateralRate * deltaSeconds
  walk.lateral += Math.max(-maxShift, Math.min(maxShift, lateralTarget - walk.lateral))
  const nextHere = pointAtDistance(walk.samples, walk.distance).point
  const nextAhead = pointAtDistance(walk.samples, Math.min(walk.total, walk.distance + 8)).point
  // 越靠近终点越淡出：最后一定精确落在终点上（场景据此判断「是否回到工位」）
  const fade = smoothstep((walk.total - walk.distance) / CROWD.settleDistance)
  const place = (): MapPoint => {
    const base = offsetPoint(nextHere, nextAhead, walk)
    return { x: base.x + walk.nudge.x * fade, y: base.y + walk.nudge.y * fade }
  }
  let at = place()

  // 硬间距：已经「穿过」档不再约束，否则被堵死时没有出口
  if (walk.relax < 2) {
    const heading = tl > 1e-6 ? { x: tx / tl, y: ty / tl } : undefined
    const push = separationPush(at, env.selfId, env.neighbors, walk.relax === 1 ? SEPARATION.tight : SEPARATION.normal, heading)
    const magnitude = Math.hypot(push.x, push.y)
    if (magnitude > 1e-6) {
      const k = Math.min(1, (SEPARATION.rate * deltaSeconds) / magnitude)
      walk.nudge.x += push.x * k
      walk.nudge.y += push.y * k
      const size = Math.hypot(walk.nudge.x, walk.nudge.y)
      if (size > SEPARATION.max) {
        walk.nudge.x *= SEPARATION.max / size
        walk.nudge.y *= SEPARATION.max / size
      }
    } else {
      const keep = Math.exp(-SEPARATION.decay * deltaSeconds)
      walk.nudge.x *= keep
      walk.nudge.y *= keep
    }
    at = place()
  } else {
    // 「穿过」档不再被硬间距约束，推开量快速（但不是瞬间）收回，避免一帧瞬移
    const keep = Math.exp(-SEPARATION.release * deltaSeconds)
    walk.nudge.x *= keep
    walk.nudge.y *= keep
    at = place()
  }

  // 让位 / 推开后的点若落进障碍：先放弃这一帧新增的偏移（偏移每帧最多增长几像素，不会瞬移）；
  // 还不行说明是路径自己转到了障碍旁，偏移按固定速率收回（每帧至多 RETREAT_PX），
  // 宁可短暂贴着墙边的安全余量，也不一帧收回十几像素造成瞬移
  if (env.isBlockedAt(at) && (walk.lateral !== 0 || walk.nudge.x !== 0 || walk.nudge.y !== 0)) {
    walk.lateral = lastLateral
    walk.nudge.x = lastNudge.x
    walk.nudge.y = lastNudge.y
    at = place()
    if (env.isBlockedAt(at)) {
      // 让位偏移与推开偏移共用同一份每帧回收预算：先收让位偏移，剩下的再收推开偏移，
      // 两者各收一份会在同一帧叠出 4–5px 的位移
      let budget = RETREAT_PX
      const lateralStep = Math.min(Math.abs(walk.lateral), budget)
      walk.lateral -= Math.sign(walk.lateral) * lateralStep
      budget -= lateralStep
      const size = Math.hypot(walk.nudge.x, walk.nudge.y)
      if (budget > 1e-9 && size > 1e-6) {
        const k = Math.max(0, size - budget) / size
        walk.nudge.x *= k
        walk.nudge.y *= k
      }
      at = place()
    }
  }

  return { x: at.x, y: at.y, speed: walk.speed, arrived: walk.distance >= walk.total, waiting, yielding: yielding && waiting }
}
