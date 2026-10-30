/**
 * 员工步态（纯函数，不依赖 Pixi / Spine，便于单测与无头校验）。
 *
 * 为什么不直接播 trot 动画：trot 是双脚同时落地的蹦跳小跑，IK 的 mix 在 1↔0 之间来回切、
 * 切到 0 时由 FK 旋转接管，正面/背面的腿只靠缩放大腿（0.745–1.308）。对它做部分权重叠加，
 * 会得到「半 IK 半 FK + 大腿被拉伸」，膝盖与小腿的几何关系就乱了。
 *
 * 这里改为纯 IK 驱动：腿骨长度恒定，只摆脚（IK 目标点）与髋部，膝盖由 IK 求出且弯向行进方向，
 * 步相位由「走过的距离」决定，脚步与位移同步。所有长度都以「腿长（大腿+小腿）」为单位，
 * 与骨架缩放无关；调用方乘上实际腿长即可。
 *
 * 坐标：屏幕坐标系，x 向右、y 向上（与 Spine 一致）。facing 取屏幕朝向：right = 向屏幕右走。
 */
import type { ChibiFacing } from '@/config/office/characters'

export const GAIT = {
  /** 站立相占整个周期的比例（>0.5 才有双脚同时着地的阶段） */
  stance: 0.6,
  /** 站立相内脚相对髋部的前后行程，占腿长（侧向） */
  stride: 0.72,
  /** 正/背面的纵深行程，占腿长（屏幕上只表现为脚上下错开一点） */
  depthStride: 0.16,
  /** 摆动相抬脚高度，占腿长（侧向）。短腿角色抬得太低在 1× 下读不出「抬腿」 */
  lift: 0.26,
  /** 正/背面的抬脚高度：只表现为腿的透视缩短，不宜太大 */
  depthLift: 0.14,
  /** 正/背面腿最多缩短到原长的多少（透视缩短，不再让膝盖往两侧弯） */
  minLegScale: 0.72,
  /** 髋部下沉（占腿长）：中站立最高、双支撑最低。下沉量要保证站立脚始终够得着 IK 目标 */
  hipDropHigh: 0.035,
  hipDropLow: 0.085,
  /** 正/背面行走时髋部左右摆向支撑腿，占腿长 */
  sway: 0.03,
  /** 摆臂幅度（度）。侧向是肩关节前后摆；正/背面只剩很小的平面内摆动 */
  armSwing: 24,
  armSwingDepth: 4,
  /** 前摆时肘部弯曲（度） */
  elbow: 26,
  /** 身体前倾（度），随速度增加 */
  lean: 3.5,
  /** 周期起点：左腿中站立附近（脚在髋下），右腿正在摆过——从静止迈出第一步最自然 */
  startPhase: 0.3,
  /** 每秒周期数（1 周期 = 左右各一步）上下限；小个子短腿本来就是碎步，但不能糊成一团 */
  minCadence: 0.9,
  maxCadence: 2.3,
  /** 站立脚允许比理想不打滑多滑多少（>1：步频低于不打滑所需，脚略有拖滑，换取不像碎步狂奔） */
  slipAllowance: 1.15,
  /** 速度 → 步幅/权重的参考速度（px/s） */
  refSpeed: 50,
  /** 低于该速度步态完全收起（px/s），到 fullSpeed 完全展开 */
  gateFrom: 2,
  gateTo: 18,
} as const

export interface FootOffset {
  /** 相对站姿的位移（腿长的倍数） */
  x: number
  y: number
}

export interface GaitPose {
  hipsX: number
  hipsY: number
  /** 身体前倾（度，正 = 朝行进方向倾），仅侧向 */
  lean: number
  legs: { l: FootOffset; r: FootOffset }
  /** 手臂前摆量 -1..1（正 = 朝行进方向摆），左右手反相 */
  arm: { l: number; r: number }
  /** 肘部前屈量 0..1 */
  elbow: { l: number; r: number }
}

/** 行进方向：屏幕 x 的符号；正/背面为 0（纵深） */
export function walkDir(facing: ChibiFacing): -1 | 0 | 1 {
  if (facing === 'right') return 1
  if (facing === 'left') return -1
  return 0
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function wrap(phase: number): number {
  return phase - Math.floor(phase)
}

/**
 * 单脚的周期轨迹（p ∈ [0,1)）。
 * fwd：脚相对髋部的前后位置，+0.5（最前）→ -0.5（最后）；lift：离地高度 0..1。
 *
 * 站立相：脚贴地，以身体前进的速度匀速后移（-1/stance），不打滑；
 * 摆动相：Hermite 曲线从最后摆到最前，起止速度与站立相衔接（落脚时脚仍在向后），
 *         抬脚按 sin 抬起落下，峰值略靠前（先抬后落）。
 */
export function footCycle(p: number, stance: number = GAIT.stance): { fwd: number; lift: number } {
  const q = wrap(p)
  if (q < stance) return { fwd: 0.5 - q / stance, lift: 0 }
  const u = (q - stance) / (1 - stance)
  const groundSpeed = -(1 - stance) / stance
  const u2 = u * u
  const u3 = u2 * u
  const h00 = 2 * u3 - 3 * u2 + 1
  const h10 = u3 - 2 * u2 + u
  const h01 = -2 * u3 + 3 * u2
  const h11 = u3 - u2
  const fwd = h00 * -0.5 + h10 * groundSpeed + h01 * 0.5 + h11 * groundSpeed
  return { fwd, lift: Math.sin(Math.PI * Math.pow(u, 0.8)) }
}

/** 髋部下沉权重：双支撑（两脚都着地、跨得最开）最低 = 1，中站立最高 = 0 */
function hipLow(phase: number): number {
  return 0.5 * (1 + Math.cos(4 * Math.PI * (phase - 0.05)))
}

/**
 * 步态姿势。phase ∈ [0,1)；amp ∈ [0,1] 为幅度（0 = 站姿，用于起步/收步的平滑过渡）。
 * 左腿相位 = phase，右腿相位 = phase + 0.5。
 */
export function gaitPose(phase: number, facing: ChibiFacing, amp = 1): GaitPose {
  const dir = walkDir(facing)
  const side = dir !== 0
  const reach = side ? GAIT.stride : GAIT.depthStride
  const cl = footCycle(phase)
  const cr = footCycle(phase + 0.5)

  // 侧向：脚沿 x 前后摆，抬脚沿 y；正面朝镜头走时「向前」是屏幕向下，背面是向上，只在 y 上错开
  const foot = (c: { fwd: number; lift: number }): FootOffset => {
    if (side) return { x: dir * c.fwd * reach * amp, y: c.lift * GAIT.lift * amp }
    const depthSign = facing === 'front' ? -1 : 1
    return { x: 0, y: (depthSign * c.fwd * reach + c.lift * GAIT.depthLift) * amp }
  }

  const low = hipLow(phase)
  const hipsY = -(GAIT.hipDropHigh + (GAIT.hipDropLow - GAIT.hipDropHigh) * low) * amp
  const hipsX = side ? 0 : GAIT.sway * Math.cos(2 * Math.PI * (phase - GAIT.startPhase)) * amp

  // 对侧手臂与腿同步前摆：左腿在前 ↔ 右臂在前（用一次谐波近似腿的前后位置）
  const swing = Math.cos(2 * Math.PI * phase)
  const armL = -swing
  const armR = swing
  return {
    hipsX,
    hipsY,
    lean: side ? GAIT.lean * amp : 0,
    legs: { l: foot(cl), r: foot(cr) },
    arm: { l: armL * amp, r: armR * amp },
    elbow: { l: Math.max(0, armL) * amp, r: Math.max(0, armR) * amp },
  }
}

/**
 * 正/背面的腿长适配。朝镜头（或背对镜头）走时，抬起的那条腿真实的弯曲发生在纵深方向，
 * 二维 IK 只能把膝盖弯向左右，会得到罗圈腿；所以这两个朝向改为「腿保持笔直、沿腿长方向缩短」，
 * 即原动画用大腿缩放表现的透视缩短。侧向仍由 IK 弯膝，返回 1。
 * @param chord 髋关节到足端目标的距离
 * @param legLength 腿长（大腿 + 小腿）
 */
export function legFit(facing: ChibiFacing, chord: number, legLength: number): number {
  if (walkDir(facing) !== 0 || legLength <= 0) return 1
  return Math.max(GAIT.minLegScale, Math.min(1, chord / legLength))
}

/**
 * IK 膝盖方向。左右腿骨架是镜像的：同一个 bendDirection 下 l 腿膝盖朝屏幕 +x、r 腿朝 -x
 * （由 chibi-stickers-walk.json 实测）。
 * 侧向：膝盖朝行进方向（l = dir，r = -dir）。正/背面：腿已按 legFit 缩短到几乎伸直，取 +1（略朝外）。
 */
export function kneeBend(facing: ChibiFacing, leg: 'l' | 'r'): 1 | -1 {
  const dir = walkDir(facing)
  if (dir === 0) return 1
  return leg === 'l' ? (dir as 1 | -1) : ((-dir) as 1 | -1)
}

/**
 * 手臂旋转符号：arm-holder-l 带 scaleY=-1，同一旋转值下左右臂方向相反
 * （实测：arm-up 转 +20°，l 手腕朝屏幕 -x、r 手腕朝 +x）。
 * 返回「前摆」所需的旋转符号：向右走时 l 为负、r 为正，向左走反过来。
 */
export function armSign(facing: ChibiFacing, arm: 'l' | 'r'): number {
  const dir = walkDir(facing)
  if (dir === 0) return arm === 'l' ? 1 : -1
  return arm === 'l' ? -dir : dir
}

/** 步态展开程度 0..1：低速时收起，避免刚起步/快停下时原地乱抖 */
export function gaitGate(speed: number): number {
  return smoothstep(GAIT.gateFrom, GAIT.gateTo, speed)
}

/** 步幅随速度：慢走碎步小、快走步子大 */
export function gaitAmplitude(speed: number): number {
  return gaitGate(speed) * (0.55 + 0.45 * Math.min(1, speed / GAIT.refSpeed))
}

/**
 * 步频（周期/秒）。理想不打滑时 步频 = 速度 / 单周期脚行程，但骨架腿太短（约身高 1/4），
 * 不打滑会变成每秒 4 步以上的碎步。这里允许一定拖滑，并给步频封顶。
 * @param speed 像素速度
 * @param legLengthPx 实际腿长（像素）
 */
export function gaitCadence(speed: number, amp: number, legLengthPx: number): number {
  if (speed <= 0 || amp <= 0 || legLengthPx <= 0) return GAIT.minCadence
  const stridePx = (GAIT.stride * amp * legLengthPx) / GAIT.stance
  const noSlip = speed / (stridePx * GAIT.slipAllowance)
  return Math.max(GAIT.minCadence, Math.min(GAIT.maxCadence, noSlip))
}
