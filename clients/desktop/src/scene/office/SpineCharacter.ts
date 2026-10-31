import { Spine, type Bone, type IkConstraint } from '@esotericsoftware/spine-pixi-v8'
import { Container, Graphics, Rectangle, Ticker, type FederatedPointerEvent } from 'pixi.js'
import {
  CHIBI_ANIM,
  DEFAULT_SEAT_FACING,
  idleAnimByFacing,
  type ChibiCharacterSkin,
  type ChibiFacing,
} from '@/config/office/characters'
import {
  getSpineAtlasAlias,
  getSpineSkeletonAlias,
  isSpineReady,
} from '@/scene/office/loadOfficeAssets'
import { HAND, type HandPose } from '@/scene/office/officeMap/chair'
import {
  GAIT,
  armSign,
  gaitAmplitude,
  gaitCadence,
  gaitPose,
  kneeBend,
  legFit,
  walkDir,
} from '@/scene/office/officeMap/gait'

interface SpineCharacterOptions {
  skin: ChibiCharacterSkin
  facing?: ChibiFacing
  /** 相对基础尺寸的额外缩放（背景大小已归一化） */
  scale?: number
}

const BASE_SCALE = 0.32
const SHADOW = { w: 22, h: 6, y: 4 }
/** 未提供实时速度时（旧版 OfficeScene）走动的默认步速，px/s */
const DEFAULT_WALK_SPEED = 60
/** 速度/步态幅度的平滑速率（1/s） */
const RESPONSE = 12
/** 转向时步态收起再展开的时长（秒）：膝盖弯曲方向随朝向切换，必须在腿近乎伸直时换，否则会“翻膝” */
const TURN_DIP = 0.09
/** 点击命中区在站姿包围盒四周外扩的像素：角色只有几十 px 高，贴着轮廓太难点中 */
const HIT_PADDING = 6

interface GaitRig {
  hips: Bone
  body: Bone
  /** 髋关节所在骨骼（leg-l/leg-r，hips 的子骨骼）与大腿骨 */
  hip: { l: Bone; r: Bone }
  thigh: { l: Bone; r: Bone }
  target: { l: Bone; r: Bone }
  ik: { l: IkConstraint; r: IkConstraint }
  armUp: { l: Bone; r: Bone }
  armDown: { l: Bone; r: Bone }
  /** 腿长（大腿 + 小腿），骨架单位已含缩放，即像素 */
  legLength: number
}

/**
 * 步态做法（详见 officeMap/gait.ts）：
 * - 轨道 0 始终是对应朝向的 idle（或表情），负责上半身与基准站姿；
 * - 走路时不再播 trot（蹦跳小跑，对它做部分权重叠加会破坏大腿/小腿/膝盖的几何关系），
 *   而是在每帧 IK 解算之前改写髋部、足端目标点、IK 膝盖方向与摆臂：腿骨长度恒定，膝盖由 IK 求出；
 * - 步相位由走过的距离推进，起步/收步靠幅度平滑过渡；
 * - 每帧先把骨骼复位再叠加偏移，偏移才是「相对站姿」而不是逐帧累加。
 *   所以关闭 Spine 自带的 autoUpdate，改为自己驱动。
 */
export class SpineCharacter extends Container {
  private spine: Spine | null = null
  private rig: GaitRig | null = null
  private readonly shadow: Graphics
  private facing: ChibiFacing
  /** 步态实际使用的朝向：转向时先收起步态，腿伸直后再切换（见 TURN_DIP） */
  private gaitFacing: ChibiFacing
  private turnBlend = 1
  private baseAnim = ''
  private ready = false
  private ticking = false
  /** 目标移动速度（px/s），由场景每帧写入 */
  private gaitSpeed = 0
  /** 平滑后的速度，用来驱动步态幅度与步频 */
  private smoothSpeed = 0
  private phase: number = GAIT.startPhase
  /**
   * 当前运动语义。
   * 关键：朝向变化时不能无脑回到 idle，否则走动中一旦转向就会变成
   * “身体在滑行、双脚不动”（idle 动画里根本没有腿骨轨道）。
   */
  private motion: 'idle' | 'walking' | 'thinking' | 'talking' = 'idle'
  /** 手扶椅子等动作的手臂姿势（朝当前面向的方向抬手）；null = 不干预手臂 */
  private hands: HandPose | null = null
  private clickHandler: (() => void) | null = null

  constructor(private readonly options: SpineCharacterOptions) {
    super()
    this.facing = options.facing ?? DEFAULT_SEAT_FACING
    this.gaitFacing = this.facing
    this.shadow = new Graphics()
    this.shadow.ellipse(0, SHADOW.y, SHADOW.w, SHADOW.h)
    this.shadow.fill({ color: 0x000000, alpha: 0.12 })
    this.addChild(this.shadow)
    this.on('pointertap', this.handleTap)
    this.tryCreateSpine()
  }

  get isReady(): boolean {
    return this.ready
  }

  get currentFacing(): ChibiFacing {
    return this.facing
  }

  setFacing(facing: ChibiFacing) {
    if (facing === this.facing) return
    this.facing = facing
    this.reapplyMotion()
  }

  /**
   * 手臂动作（握椅子）：侧身站着、面向椅子时，两只手朝面向的方向抬起 angle 度，weight 控制抬手 / 放下的过渡。
   * 只在左右朝向下有意义（正 / 背面看不出前伸），传 null 恢复自然下垂。
   */
  setHands(pose: HandPose | null) {
    this.hands = pose && pose.weight > 0 ? { ...pose } : null
  }

  /**
   * 让角色可以被左键点击（触屏 / 触控笔的点按同样算）；传 null 取消。
   * 命中区取站姿下 Spine 包围盒再外扩 HIT_PADDING，量一次后固定：走动 / 挥手时肢体轮廓在变，
   * 命中区跟着变的话，点同一个位置会忽中忽不中。Spine 没建起来（无包围盒）时保持不可点。
   */
  setClickable(handler: (() => void) | null) {
    this.clickHandler = handler
    const bounds = handler && this.spine ? this.spine.getLocalBounds() : null
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      this.clickHandler = null
      this.eventMode = 'passive'
      this.cursor = 'default'
      this.hitArea = null
      return
    }
    this.eventMode = 'static'
    this.cursor = 'pointer'
    this.hitArea = new Rectangle(
      bounds.x - HIT_PADDING,
      bounds.y - HIT_PADDING,
      bounds.width + HIT_PADDING * 2,
      bounds.height + HIT_PADDING * 2,
    )
  }

  private readonly handleTap = (event: FederatedPointerEvent) => {
    // pointertap 对鼠标的任意键都会触发；只响应左键
    if (event.pointerType === 'mouse' && event.button !== 0) return
    this.clickHandler?.()
  }

  /** 场景每帧写入实时速度（px/s）；0 表示停下，步态会平滑收回站姿 */
  setLocomotionSpeed(speed: number) {
    this.gaitSpeed = Math.max(0, speed)
  }

  /** 按当前运动语义重放动画（换向时保持“走着”的状态） */
  private reapplyMotion() {
    switch (this.motion) {
      case 'thinking':
        this.playThinking()
        break
      case 'talking':
        this.playTalking()
        break
      default:
        // walking 与 idle 的底层都是对应朝向的站姿；腿部步态在 tick 的 IK 阶段叠加
        this.setBase(idleAnimByFacing(this.facing), 0.15)
    }
  }

  playAnimation(name: string, loop = true) {
    if (!this.spine || !this.ready) return
    if (!this.spine.skeleton.data.findAnimation(name)) {
      // 未找到动画：回退到 idle
      this.playIdle()
      return
    }
    if (this.baseAnim === name) return
    this.baseAnim = name
    const entry = this.spine.state.setAnimation(0, name, loop)
    if (entry) entry.mixDuration = 0.2
  }

  private setBase(name: string, mixDuration: number) {
    if (!this.spine || !this.ready || this.baseAnim === name) return
    if (!this.spine.skeleton.data.findAnimation(name)) return
    this.baseAnim = name
    const entry = this.spine.state.setAnimation(0, name, true)
    if (entry) entry.mixDuration = mixDuration
  }

  playIdle() {
    this.motion = 'idle'
    this.gaitSpeed = 0
    this.playAnimation(idleAnimByFacing(this.facing), true)
  }

  playThinking() {
    this.motion = 'thinking'
    this.gaitSpeed = 0
    this.playAnimation(CHIBI_ANIM.thinking, true)
  }

  playTalking() {
    this.motion = 'talking'
    this.gaitSpeed = 0
    this.playAnimation(CHIBI_ANIM.wave, true)
  }

  /**
   * 播放走动动画（根据当前朝向）。
   * 传入速度时按速度换算步幅与步频；不传则用默认步速（旧版场景没有逐帧速度）。
   */
  playWalking(speed: number = DEFAULT_WALK_SPEED) {
    this.motion = 'walking'
    this.gaitSpeed = Math.max(0, speed)
    this.setBase(idleAnimByFacing(this.facing), 0.15)
  }

  destroySpine() {
    this.stopTicking()
    if (this.spine) {
      this.spine.destroy()
      this.spine = null
    }
    this.rig = null
    this.ready = false
  }

  override destroy(options?: Parameters<Container['destroy']>[0]) {
    this.stopTicking()
    super.destroy(options)
  }

  private readonly onTick = (ticker: Ticker) => {
    this.tick(ticker.deltaMS / 1000)
  }

  /**
   * 是否逐帧驱动骨骼动画：画面不展示时关掉省 CPU（位置 / 朝向由场景照常更新），
   * 重新打开时立即按当前状态摆一次姿势。
   */
  setAnimating(enabled: boolean) {
    if (!enabled) {
      this.stopTicking()
      return
    }
    if (this.ticking || !this.spine || !this.ready) return
    Ticker.shared.add(this.onTick)
    this.ticking = true
    this.tick(0)
  }

  private stopTicking() {
    if (!this.ticking) return
    Ticker.shared.remove(this.onTick)
    this.ticking = false
  }

  private tick(deltaSeconds: number) {
    const spine = this.spine
    if (!spine || !this.ready) return
    const dt = Math.min(Math.max(deltaSeconds, 0), 0.1)
    this.advanceGait(dt)
    // 每帧先复位骨骼：步态偏移是「相对站姿」叠加的，不复位就会逐帧累加
    spine.skeleton.setBonesToSetupPose()
    spine.update(dt)
  }

  /** 平滑速度 → 步态幅度；按步频推进相位；转向时把步态收起再换向 */
  private advanceGait(dt: number) {
    const target = this.motion === 'walking' ? this.gaitSpeed : 0
    this.smoothSpeed += (target - this.smoothSpeed) * (1 - Math.exp(-dt * RESPONSE))
    if (this.smoothSpeed < 0.3 && target === 0) this.smoothSpeed = 0

    const amp = gaitAmplitude(this.smoothSpeed)
    if (amp <= 0) {
      // 站定：下一次从「一脚在髋下、一脚摆过」的相位起步
      this.phase = GAIT.startPhase
      this.gaitFacing = this.facing
      this.turnBlend = 1
      return
    }
    if (this.rig) this.phase = (this.phase + gaitCadence(this.smoothSpeed, amp, this.rig.legLength) * dt) % 1

    const turning = this.gaitFacing !== this.facing
    const step = dt / TURN_DIP
    this.turnBlend = turning ? Math.max(0, this.turnBlend - step) : Math.min(1, this.turnBlend + step)
    if (turning && this.turnBlend <= 0) this.gaitFacing = this.facing
  }

  /** 在 Spine 解算世界变换之前，把步态姿势叠加到站姿上 */
  private readonly applyGait = () => {
    const rig = this.rig
    if (!rig) return
    this.applyHands(rig)
    const amp = gaitAmplitude(this.smoothSpeed) * this.turnBlend
    if (amp <= 0) return
    const facing = this.gaitFacing
    const pose = gaitPose(this.phase, facing, amp)
    const L = rig.legLength

    rig.hips.x += pose.hipsX * L
    rig.hips.y += pose.hipsY * L
    rig.body.rotation -= walkDir(facing) * pose.lean

    const swing = walkDir(facing) !== 0 ? GAIT.armSwing : GAIT.armSwingDepth
    for (const side of ['l', 'r'] as const) {
      const target = rig.target[side]
      target.x += pose.legs[side].x * L
      target.y += pose.legs[side].y * L
      // 正/背面：腿保持笔直、按髋到足端的距离沿腿长缩短（子骨骼继承缩放，IK 按缩短后的长度求解）
      const chord = Math.hypot(target.x - (rig.hips.x + rig.hip[side].x), target.y - (rig.hips.y + rig.hip[side].y))
      rig.thigh[side].scaleX *= legFit(facing, chord, L)
      // IK 全程满权重：腿骨长度恒定，膝盖弯向行进方向
      rig.ik[side].mix = 1
      rig.ik[side].bendDirection = kneeBend(facing, side)
      rig.armUp[side].rotation += armSign(facing, side) * swing * pose.arm[side]
      rig.armDown[side].rotation += armSign(facing, side) * GAIT.elbow * pose.elbow[side]
    }
  }

  /** 握椅子：侧身时两只手朝面向的方向抬起（主手高、另一只略低）；正 / 背面时两臂撑开。在步态之前叠加，站定时也生效 */
  private applyHands(rig: GaitRig) {
    const hands = this.hands
    if (!hands) return
    if (walkDir(this.facing) === 0) {
      // 正 / 背面：两臂向两侧撑开（撑着扶手起身 / 坐下）；同一个旋转符号对左右臂都是向外
      for (const side of ['l', 'r'] as const) rig.armUp[side].rotation += HAND.armrest * hands.weight
      return
    }
    for (const side of ['l', 'r'] as const) {
      const lag = side === 'r' ? 0 : HAND.offHandLag
      const sign = armSign(this.facing, side)
      rig.armUp[side].rotation += sign * Math.max(0, hands.angle - lag) * hands.weight
      rig.armDown[side].rotation += sign * HAND.elbow * hands.weight
    }
  }

  private buildRig(spine: Spine): GaitRig | null {
    const sk = spine.skeleton
    const bone = (name: string) => sk.findBone(name)
    const ik = (name: string) => sk.findIkConstraint(name)
    const hips = bone('hips')
    const body = bone('body-up')
    const thighL = bone('leg-up-l')
    const shinL = bone('leg-down-l')
    const rig = {
      hips,
      body,
      hip: { l: bone('leg-l'), r: bone('leg-r') },
      thigh: { l: thighL, r: bone('leg-up-r') },
      target: { l: bone('leg-target-l'), r: bone('leg-target-r') },
      ik: { l: ik('leg-target-l'), r: ik('leg-target-r') },
      armUp: { l: bone('arm-up-l'), r: bone('arm-up-r') },
      armDown: { l: bone('arm-down-l'), r: bone('arm-down-r') },
    }
    const all = [hips, body, thighL, shinL, ...Object.values(rig.hip), ...Object.values(rig.thigh), ...Object.values(rig.target), ...Object.values(rig.ik), ...Object.values(rig.armUp), ...Object.values(rig.armDown)]
    if (all.some((item) => !item)) {
      console.error('[SpineCharacter] 骨架缺少步态所需的骨骼/IK，回退为纯站姿')
      return null
    }
    return { ...rig, legLength: thighL!.data.length + shinL!.data.length } as GaitRig
  }

  private tryCreateSpine() {
    if (!isSpineReady()) return
    const skeletonAlias = getSpineSkeletonAlias()
    const atlasAlias = getSpineAtlasAlias()
    if (!skeletonAlias || !atlasAlias) return

    try {
      const spine = Spine.from({
        skeleton: skeletonAlias,
        atlas: atlasAlias,
        scale: BASE_SCALE * (this.options.scale ?? 1),
        autoUpdate: false,
      })
      if (spine.skeleton.data.findSkin(this.options.skin)) {
        spine.skeleton.setSkinByName(this.options.skin)
        spine.skeleton.setSlotsToSetupPose()
      }
      spine.state.data.defaultMix = 0.2
      this.rig = this.buildRig(spine)
      spine.beforeUpdateWorldTransforms = this.applyGait
      this.spine = spine
      this.addChild(spine)
      this.ready = true
      this.playIdle()
      Ticker.shared.add(this.onTick)
      this.ticking = true
      // 首帧立即摆好姿势，避免挂到舞台上的第一帧是 setup pose
      this.tick(0)
    } catch (err) {
      console.error('[SpineCharacter] Spine 创建失败', err)
      this.ready = false
    }
  }
}
