/**
 * 办公椅的抽拉动作（纯函数 / 小状态机，不依赖 Pixi / DOM，便于单测）。
 *
 * 椅子有三个位置，都在「桌 → 椅」这条线上：
 * - tucked：塞进桌下（空位 / 员工离开后的样子）；
 * - seated：员工落座时的位置（地图里椅子元素本来的位置）；
 * - pulled：从落座位置再往外拉出一截，人才进得去 / 出得来。
 *
 * 人和椅子都不能互相穿过，所以进出工位都走椅子的「侧门」（gate：椅子左 / 右侧紧邻的站位）：
 * - 离开：椅子拉出（人还在桌椅之间，被椅背挡住下半身）→ 人从侧面走出到 gate → 走出椅子范围后把椅子推回桌下；
 * - 进入：人走到 gate → 椅子拉出 → 人从侧面进到桌椅之间并转身朝向电脑 → 椅子连人往桌子挪回落座位置。
 * 员工与椅子的前后遮挡（人在椅背后面时 zIndex 低于椅子，走出侧门后再抬到椅子前面）由场景按 gate 处理。
 */
import type { MapPoint } from './types.ts'

export interface ChairPoses {
  seated: MapPoint
  pulled: MapPoint
  tucked: MapPoint
}

export type ChairPoseName = keyof ChairPoses
export type ChairEase = 'out' | 'inOut'

export interface ChairStep {
  /** 等多久再开始这一步（秒，从上一步结束算起） */
  wait: number
  to: ChairPoseName
  duration: number
  ease: ChairEase
}

export const CHAIR = {
  /** 椅子从落座位置再往外拉多远（px）：只要够人从椅背后面出来就行，拉太多椅子晃得太明显 */
  pullDistance: 10,
  /** 侧门到椅子精灵边缘的距离（px）：人体（含大头）要完全错开椅背 */
  gateMargin: 10,
} as const

/** 拉出：用力一拉、自然滑停 */
export const PULL_STEPS: readonly ChairStep[] = [{ wait: 0, to: 'pulled', duration: 0.32, ease: 'out' }]

/** 放回桌下：人走出椅子范围后，稍等一下再推回去 */
export const TUCK_STEPS: readonly ChairStep[] = [{ wait: 0.15, to: 'tucked', duration: 0.5, ease: 'inOut' }]

/** 坐下后连人带椅挪回落座位置 */
export const SEAT_STEPS: readonly ChairStep[] = [{ wait: 0, to: 'seated', duration: 0.45, ease: 'inOut' }]

/** 没有侧门可走时（两侧都被墙 / 人占住）的退路：拉出 → 等人走开 → 推回桌下 */
export const LEAVE_STEPS: readonly ChairStep[] = [
  { wait: 0, to: 'pulled', duration: 0.32, ease: 'out' },
  { wait: 0.55, to: 'tucked', duration: 0.5, ease: 'inOut' },
]

/** 员工动作相对于椅子动作开始的时刻（秒） */
export const CHAIR_TIMING = {
  /** 离开：椅子拉出后，员工从这一刻起转身迈步 */
  leaveWalkAt: 0.4,
  /** 没有侧门的退路：到椅前后，椅子拉出到位再转身坐下 */
  enterSitAt: 0.4,
} as const

export interface ChairGates {
  left: MapPoint
  right: MapPoint
}

/** 椅子左右两侧的侧门：与员工落座位置同一排（y 取工位位置），在椅子精灵边缘外 margin 处 */
export function chairGates(chair: MapPoint, chairWidth: number, rowY: number, margin: number = CHAIR.gateMargin): ChairGates {
  return {
    left: { x: chair.x - chairWidth / 2 - margin, y: rowY },
    right: { x: chair.x + chairWidth / 2 + margin, y: rowY },
  }
}

/**
 * 手扶着椅子操作（在侧门处进行）：人站到椅子侧面、面向椅子，
 * 抬手握住椅子 → 椅子动（拉出 / 推回桌下，手跟着走）→ 松手放下。
 * - pull：回座时把椅子从桌下拉出来；
 * - tuck：离开时把椅子推回桌下。
 */
export type HandleKind = 'pull' | 'tuck'

export const HANDLE = {
  /** 抬手握住椅子（同时转身面向椅子）的时间（秒） */
  raise: 0.2,
  /** 椅子到位后松手放下的时间（秒） */
  release: 0.18,
} as const

/** 手扶着椅子时的椅子动作：手已经握住，不用再等 */
export const HANDLE_PULL_STEPS: readonly ChairStep[] = [{ wait: 0, to: 'pulled', duration: 0.32, ease: 'out' }]
export const HANDLE_TUCK_STEPS: readonly ChairStep[] = [{ wait: 0, to: 'tucked', duration: 0.45, ease: 'inOut' }]

export function handleSteps(kind: HandleKind): readonly ChairStep[] {
  return kind === 'pull' ? HANDLE_PULL_STEPS : HANDLE_TUCK_STEPS
}

/** 整个手扶动作的时长（秒） */
export function handleDuration(kind: HandleKind): number {
  return HANDLE.raise + stepsDuration(handleSteps(kind)) + HANDLE.release
}

/**
 * 手臂前伸角度（度，相对自然下垂；朝椅子方向抬起为正）。
 * 手握在椅子侧面，椅子在桌下（偏上）时手抬得高，拉出来（偏下）时手落低，手始终够在椅子上。
 */
export const HAND = {
  tucked: 74,
  pulled: 32,
  /** 握椅子时肘部前屈（度） */
  elbow: 12,
  /** 另一只手比主手低多少（度）：两只手一高一低，扶着椅背而不是并排举着 */
  offHandLag: 14,
  /** 背对镜头坐着时，起身 / 坐下撑扶手：两臂向两侧撑开的角度（度） */
  armrest: 30,
} as const

export interface HandPose {
  /** 0 = 手自然下垂，1 = 完全握住椅子 */
  weight: number
  /** 主手前伸角度（度） */
  angle: number
}

/** 椅子在「桌下 → 拉出」这条线上走了多少（0 = 桌下，1 = 拉出），超出范围取边界 */
export function chairTravel(pos: MapPoint, poses: ChairPoses): number {
  const dx = poses.pulled.x - poses.tucked.x
  const dy = poses.pulled.y - poses.tucked.y
  const length2 = dx * dx + dy * dy
  if (length2 < 1e-9) return 0
  return Math.max(0, Math.min(1, ((pos.x - poses.tucked.x) * dx + (pos.y - poses.tucked.y) * dy) / length2))
}

export function handAngle(travel: number): number {
  const t = Math.max(0, Math.min(1, travel))
  return HAND.tucked + (HAND.pulled - HAND.tucked) * t
}

function smooth(t: number): number {
  const x = Math.max(0, Math.min(1, t))
  return x * x * (3 - 2 * x)
}

/**
 * 手扶椅子动作第 t 秒的手臂姿势：先抬手（权重 0 → 1），椅子动的整段保持握住并跟着椅子走，最后松手（1 → 0）。
 * travel 是椅子当前位置（chairTravel），手的角度随它变化。
 */
export function handPose(kind: HandleKind, t: number, travel: number): HandPose {
  const move = stepsDuration(handleSteps(kind))
  let weight = 1
  if (t < HANDLE.raise) weight = smooth(t / HANDLE.raise)
  else if (t > HANDLE.raise + move) weight = 1 - smooth((t - HANDLE.raise - move) / HANDLE.release)
  return { weight, angle: handAngle(travel) }
}

export function stepsDuration(steps: readonly ChairStep[]): number {
  return steps.reduce((sum, step) => sum + step.wait + step.duration, 0)
}

/**
 * 人在椅背后面走动时的层级：起身离座走向侧门、回座时从侧门进到桌椅之间。
 * 这时人已经离开座位、站在桌前，要盖住桌上的电脑 / 屏幕（屏幕层级 = 电脑 + 1），
 * 但仍在椅背后面（被椅子挡住下半身），所以取「落座层级与屏幕」之上、椅子之下的中点。
 * 坐稳以后仍用落座层级（和编辑器的前后关系一致）。夹不出这样的区间（没有椅子 / 椅子不在屏幕之上）时退回落座层级。
 */
export function behindChairZ(seatedZ: number, computerZ: number | undefined, chairZ: number | undefined): number {
  if (computerZ === undefined || chairZ === undefined) return seatedZ
  const floor = Math.max(seatedZ, computerZ + 1)
  return chairZ > floor ? floor + (chairZ - floor) / 2 : seatedZ
}

/** 由落座位置与塞进桌下的位置推出三个姿态；拉出方向 = 桌下 → 落座 的延长线 */
export function chairPoses(seated: MapPoint, tucked: MapPoint, pullDistance: number = CHAIR.pullDistance): ChairPoses {
  const dx = seated.x - tucked.x
  const dy = seated.y - tucked.y
  const length = Math.hypot(dx, dy)
  const ux = length > 1e-6 ? dx / length : 0
  const uy = length > 1e-6 ? dy / length : 1
  return {
    seated: { ...seated },
    tucked: { ...tucked },
    pulled: { x: seated.x + ux * pullDistance, y: seated.y + uy * pullDistance },
  }
}

function ease(kind: ChairEase, p: number): number {
  const t = Math.max(0, Math.min(1, p))
  // out：先快后慢（用力一拉、自然滑停）；inOut：缓起缓停（推回去）
  return kind === 'out' ? 1 - (1 - t) ** 3 : 0.5 - Math.cos(Math.PI * t) / 2
}

interface ActiveStep {
  wait: number
  duration: number
  ease: ChairEase
  to: MapPoint
  from: MapPoint
}

/**
 * 椅子位置的步骤播放器。
 * play() 总是从椅子「当前所在」继续，所以动作被打断（比如还没坐稳又要走）也不会瞬移。
 */
export class ChairAnimator {
  pos: MapPoint
  private queue: ActiveStep[] = []
  private t = 0

  constructor(start: MapPoint) {
    this.pos = { ...start }
  }

  get busy(): boolean {
    return this.queue.length > 0
  }

  play(steps: readonly ChairStep[], poses: ChairPoses): void {
    this.queue = steps.map((step) => ({
      wait: step.wait,
      duration: step.duration,
      ease: step.ease,
      to: { ...poses[step.to] },
      from: { x: 0, y: 0 },
    }))
    this.t = 0
    if (this.queue.length) this.queue[0].from = { ...this.pos }
  }

  /** 立即停在某个位置并取消排队中的动作 */
  snap(point: MapPoint): void {
    this.queue = []
    this.t = 0
    this.pos = { ...point }
  }

  update(deltaSeconds: number): void {
    let left = Math.max(0, deltaSeconds)
    while (this.queue.length) {
      const step = this.queue[0]
      const total = step.wait + step.duration
      const take = Math.min(left, total - this.t)
      this.t += take
      left -= take
      const progress = step.duration > 0 ? (this.t - step.wait) / step.duration : 1
      const e = ease(step.ease, progress)
      this.pos = { x: step.from.x + (step.to.x - step.from.x) * e, y: step.from.y + (step.to.y - step.from.y) * e }
      if (this.t < total - 1e-9) return
      this.pos = { ...step.to }
      this.queue.shift()
      this.t = 0
      if (this.queue.length) this.queue[0].from = { ...this.pos }
      if (left <= 0) return
    }
  }
}
