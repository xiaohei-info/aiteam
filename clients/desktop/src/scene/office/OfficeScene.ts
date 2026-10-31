import 'pixi.js/unsafe-eval'
import { Application, Container, Sprite, Texture } from 'pixi.js'
import {
  OFFICE_BACKGROUNDS,
  pickOfficeBackground,
  type OfficeBackground,
} from '@/config/office/backgrounds'
import {
  DEFAULT_SEAT_FACING,
  type ChibiFacing,
} from '@/config/office/characters'
import {
  getBackgroundTexture,
  getChairPngTexture,
  getComputerPngTexture,
  getDeskPngTexture,
  isSpineReady,
  loadOfficeSceneAssets,
} from '@/scene/office/loadOfficeAssets'
import { DeskChairEntity } from '@/scene/office/DeskChairEntity'

export interface OfficeAgentConf {
  id: number | string
  name: string
  dept?: string
  role?: string
  status?: string
}

interface SeatLayout {
  cols: number
  rows: number
  cellW: number
  cellH: number
  originX: number
  originY: number
  deskWidth: number
  chairWidth: number
}

type SeatSlot = {
  seatIndex: number
  x: number
  y: number
  agent: OfficeAgentConf
  facing: ChibiFacing
}

/** 员工运动状态 */
interface EmployeeMotionState {
  agentId: string | number
  isWalking: boolean
  targetX?: number
  targetY?: number
  lastActionTime: number
  idleCheckTimer?: ReturnType<typeof setTimeout>
}

/** 碰撞区域（矩形） */
interface CollisionRect {
  x: number
  y: number
  width: number
  height: number
}

export interface OfficeSceneOptions {
  /** 强制指定背景 id，跳过自动挑选 */
  backgroundId?: string
  onReady?: (bg: OfficeBackground) => void
}

/** 桌椅原图尺寸（public/assets/office/desk.png、chair.png） */
const DESK_PNG_SIZE = { w: 920, h: 582 }

/** 桌子在 cell 里占的宽度比例，其余为工位间通道 */
const DESK_CELL_FILL = 0.62
/** 椅子相对桌子的宽度比例 */
const CHAIR_TO_DESK_RATIO = 0.58

/**
 * 固定的开放办公区坐标（来自 10 人办公室布局设计）
 * 单位：像素，相对于 1254x1254 画布
 */
const HALL_AREA = {
  x: 120,
  y: 285,
  w: 820,
  h: 800,
}

const CANVAS_SIZE = { w: 1254, h: 1254 }

export class OfficeScene {
  private app: Application | null = null
  private world: Container | null = null
  private workstationLayer: Container | null = null

  private workstations: DeskChairEntity[] = []

  private seats: SeatSlot[] = []

  private readonly options: OfficeSceneOptions

  /** 员工运动状态映射 */
  private motionStates = new Map<string | number, EmployeeMotionState>()

  /** 桌椅碰撞区域 */
  private collisionRects: CollisionRect[] = []

  /** 办公区边界 */
  private hallBounds = {
    x: HALL_AREA.x,
    y: HALL_AREA.y,
    width: HALL_AREA.w,
    height: HALL_AREA.h,
  }

  constructor(options: OfficeSceneOptions = {}) {
    this.options = options
  }

  async init(
    container: HTMLElement,
    width: number,
    height: number,
    agents: OfficeAgentConf[],
  ): Promise<void> {
    console.log('[OfficeScene] init 开始，员工数量:', agents.length, agents)
    const app = new Application()
    await app.init({
      width,
      height,
      backgroundAlpha: 0,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    })
    this.app = app
    container.appendChild(app.canvas)
    ;(app.canvas as HTMLCanvasElement).style.display = 'block'

    const world = new Container()
    this.world = world
    app.stage.addChild(world)

    // 工位层：统一管理桌椅和员工
    this.workstationLayer = new Container()
    world.addChild(this.workstationLayer)

    const bg = this.pickBackground(agents.length)
    console.log('[OfficeScene] 选择的背景:', bg.id)
    await loadOfficeSceneAssets(bg.id)

    this.mountBackground(bg)

    const layout = this.buildLayoutInHall(agents.length)
    console.log('[OfficeScene] 布局信息:', layout)
    this.buildSeats(agents, layout)
    console.log('[OfficeScene] 座位数量:', this.seats.length)
    this.mountWorkstations(agents, layout)
    console.log('[OfficeScene] 工位数量:', this.workstations.length)

    this.fit(width, height)
    this.options.onReady?.(bg)
  }

  resize(width: number, height: number): void {
    if (!this.app) return
    this.app.renderer.resize(width, height)
    this.fit(width, height)
  }

  destroy(): void {
    // 清理所有空闲检测定时器
    this.motionStates.forEach((state) => {
      if (state.idleCheckTimer) {
        clearTimeout(state.idleCheckTimer)
      }
    })
    this.motionStates.clear()
    this.collisionRects = []

    this.workstations.forEach((w) => w.destroy())
    this.workstations = []
    this.workstationLayer = null
    this.world = null
    this.seats = []
    this.app?.destroy(true, { children: true })
    this.app = null
  }

  private pickBackground(agentCount: number): OfficeBackground {
    if (this.options.backgroundId) {
      const hit = OFFICE_BACKGROUNDS.find((b) => b.id === this.options.backgroundId)
      if (hit) return hit
    }
    return pickOfficeBackground(agentCount)
  }

  private mountBackground(bg: OfficeBackground) {
    if (!this.world) return
    const tex = getBackgroundTexture(bg.id) ?? Texture.EMPTY
    const sprite = new Sprite(tex)
    sprite.anchor.set(0, 0)
    sprite.width = bg.imageSize.w
    sprite.height = bg.imageSize.h
    this.world.addChildAt(sprite, 0)
  }

  /**
   * 在固定的开放办公区（hall）内自动排布工位阵列。
   * - 桌宽 = cell 宽 × DESK_CELL_FILL，其余为工位间通道
   * - 优先横向排列，避免单个工位落单在角落
   */
  private buildLayoutInHall(agentCount: number): SeatLayout {
    const areaW = HALL_AREA.w
    const areaH = HALL_AREA.h
    const originX = HALL_AREA.x
    const originY = HALL_AREA.y

    const total = Math.max(agentCount, 1)

    // 优化布局：优先横向排列，避免单个落单
    let cols: number
    let rows: number

    if (total <= 4) {
      // 1-4 人：横向一排
      cols = total
      rows = 1
    } else if (total <= 8) {
      // 5-8 人：每排 4 人
      cols = 4
      rows = Math.ceil(total / cols)
    } else if (total <= 12) {
      // 9-12 人：每排 4 人
      cols = 4
      rows = Math.ceil(total / cols)
    } else {
      // 13+ 人：根据空间自动计算，但确保紧凑
      const deskAspect = DESK_PNG_SIZE.w / DESK_PNG_SIZE.h
      const cellAspect = deskAspect / DESK_CELL_FILL
      const rawCols = Math.sqrt((total * areaW * cellAspect) / areaH)
      cols = Math.max(3, Math.min(total, Math.round(rawCols) || 3))
      rows = Math.ceil(total / cols)
    }

    const cellW = areaW / cols
    const cellH = areaH / rows
    const deskWidth = cellW * DESK_CELL_FILL
    const chairWidth = deskWidth * CHAIR_TO_DESK_RATIO

    return { cols, rows, cellW, cellH, originX, originY, deskWidth, chairWidth }
  }

  private buildSeats(agents: OfficeAgentConf[], layout: SeatLayout) {
    const seats: SeatSlot[] = []
    agents.forEach((agent, i) => {
      const col = i % layout.cols
      const row = Math.floor(i / layout.cols)
      const x = layout.originX + layout.cellW * (col + 0.5)
      const y = layout.originY + layout.cellH * (row + 0.5)
      seats.push({
        seatIndex: i,
        x,
        y,
        agent,
        facing: DEFAULT_SEAT_FACING,
      })
    })
    this.seats = seats
  }

  /**
   * 挂载工位实体（桌椅 + 员工 + 名片）
   */
  private mountWorkstations(agents: OfficeAgentConf[], layout: SeatLayout) {
    if (!this.workstationLayer) {
      console.error('[OfficeScene] workstationLayer 不存在')
      return
    }
    void agents // agents 参数通过 this.seats 访问，避免 lint 警告

    const deskTex = getDeskPngTexture()
    const chairTex = getChairPngTexture()
    const computerTex = getComputerPngTexture()
    console.log('[OfficeScene] 桌椅电脑纹理详情:', {
      deskTex: !!deskTex,
      chairTex: !!chairTex,
      computerTex: !!computerTex,
      computerTexWidth: computerTex?.width,
      computerTexHeight: computerTex?.height,
    })
    if (!deskTex || !chairTex) {
      console.warn('[OfficeScene] 桌椅纹理未加载，无法渲染工位')
      return
    }

    const enableSpine = isSpineReady()
    console.log('[OfficeScene] Spine 是否就绪:', enableSpine)
    if (!enableSpine) {
      console.warn('[OfficeScene] Spine 资源未就绪，使用占位符渲染员工')
    }

    console.log('[OfficeScene] 开始创建工位，座位数:', this.seats.length)
    for (const seat of this.seats) {
      const workstation = new DeskChairEntity({
        seatIndex: seat.seatIndex,
        employeeName: seat.agent.name,
        employeeRole: seat.agent.role || seat.agent.dept || '员工',
        deskWidth: layout.deskWidth,
        deskTexture: deskTex,
        chairTexture: chairTex,
        computerTexture: computerTex ?? undefined,
        facing: seat.facing,
        enableSpine,
      })
      workstation.position.set(seat.x, seat.y)
      console.log(`[OfficeScene] 工位 ${seat.seatIndex} 位置:`, seat.x, seat.y)
      this.workstations.push(workstation)
      this.workstationLayer.addChild(workstation)

      // 初始化电脑屏幕状态为日常办公
      workstation.setComputerScreenStatus('working')

      // 初始化员工运动状态
      this.motionStates.set(seat.agent.id, {
        agentId: seat.agent.id,
        isWalking: false,
        lastActionTime: Date.now(),
      })

      // 计算桌椅碰撞区域（简化为矩形）
      const deskHeight = layout.deskWidth * (DESK_PNG_SIZE.h / DESK_PNG_SIZE.w)
      this.collisionRects.push({
        x: seat.x - layout.deskWidth / 2,
        y: seat.y - deskHeight * 0.5,
        width: layout.deskWidth,
        height: deskHeight,
      })
    }
    console.log('[OfficeScene] 工位创建完成，总数:', this.workstations.length)

    // 启动所有员工的空闲检测
    this.seats.forEach((seat) => {
      this.startIdleCheck(seat.agent.id)
    })
  }

  private fit(width: number, height: number) {
    if (!this.world) return
    // 使用固定画布尺寸进行缩放
    const scale = Math.min(width / CANVAS_SIZE.w, height / CANVAS_SIZE.h)
    const offsetX = (width - CANVAS_SIZE.w * scale) / 2
    const offsetY = (height - CANVAS_SIZE.h * scale) / 2
    this.world.scale.set(scale)
    this.world.position.set(offsetX, offsetY)
  }

  /**
   * 根据员工 ID 获取对应工位，可用于触发动画
   */
  getWorkstation(agentId: string | number): DeskChairEntity | undefined {
    const seat = this.seats.find((s) => s.agent.id === agentId)
    if (!seat) return undefined
    return this.workstations[seat.seatIndex]
  }

  /**
   * 让指定员工播放思考动画
   */
  playThinking(agentId: string | number) {
    this.getWorkstation(agentId)?.playThinking()
    this.resetIdleCheck(agentId)
  }

  /**
   * 让指定员工播放说话动画
   */
  playTalking(agentId: string | number) {
    this.getWorkstation(agentId)?.playTalking()
    this.resetIdleCheck(agentId)
  }

  /**
   * 让指定员工恢复空闲动画
   */
  playIdle(agentId: string | number) {
    this.getWorkstation(agentId)?.playIdle()
    this.resetIdleCheck(agentId)
  }

  /**
   * 设置指定员工的电脑屏幕状态
   */
  setComputerScreenStatus(
    agentId: string | number,
    status: 'working' | 'browsing' | 'coding' | 'idle'
  ) {
    this.getWorkstation(agentId)?.setComputerScreenStatus(status)
  }

  /**
   * 启动空闲检测定时器
   */
  private startIdleCheck(agentId: string | number) {
    const state = this.motionStates.get(agentId)
    if (!state) return

    // 清除旧定时器
    if (state.idleCheckTimer) {
      clearTimeout(state.idleCheckTimer)
    }

    // 10秒后触发走动
    state.idleCheckTimer = setTimeout(() => {
      this.triggerRandomWalk(agentId)
    }, 10000)
  }

  /**
   * 重置空闲检测（当员工有新指令时调用）
   */
  private resetIdleCheck(agentId: string | number) {
    const state = this.motionStates.get(agentId)
    if (!state) return

    state.lastActionTime = Date.now()
    state.isWalking = false

    // 重新启动定时器
    this.startIdleCheck(agentId)
  }

  /**
   * 触发员工随机走动
   */
  private triggerRandomWalk(agentId: string | number) {
    const state = this.motionStates.get(agentId)
    const workstation = this.getWorkstation(agentId)
    if (!state || !workstation) return

    // 生成随机目标点（在办公区内且避开桌椅）
    const target = this.findRandomWalkablePoint()
    if (!target) {
      // 找不到合适的点，稍后重试
      this.startIdleCheck(agentId)
      return
    }

    state.isWalking = true
    state.targetX = target.x
    state.targetY = target.y

    // 获取员工当前的世界坐标
    const currentPos = workstation.getCharacterWorldPosition()
    const dx = target.x - currentPos.x
    const dy = target.y - currentPos.y

    // 计算朝向
    let facing: ChibiFacing = 'front'
    if (Math.abs(dx) > Math.abs(dy)) {
      facing = dx > 0 ? 'right' : 'left'
    } else {
      facing = dy > 0 ? 'front' : 'back'
    }

    workstation.setFacing(facing)
    workstation.playWalking()

    // 简单的移动动画（使用线性插值）
    const duration = 2000 // 2秒移动时间
    const startTime = Date.now()
    const startX = currentPos.x
    const startY = currentPos.y

    const animate = () => {
      if (!state.isWalking || !workstation) return

      const elapsed = Date.now() - startTime
      const progress = Math.min(elapsed / duration, 1)

      // 计算新的世界坐标
      const newWorldX = startX + (target.x - startX) * progress
      const newWorldY = startY + (target.y - startY) * progress

      // 转换为相对于工位的坐标
      const relativeX = newWorldX - workstation.x
      const relativeY = newWorldY - workstation.y

      // 只移动员工角色，桌椅保持不动
      workstation.setCharacterPosition(relativeX, relativeY)

      if (progress < 1) {
        requestAnimationFrame(animate)
      } else {
        // 移动完成，恢复空闲状态
        state.isWalking = false
        workstation.playIdle()
        this.startIdleCheck(agentId)
      }
    }

    requestAnimationFrame(animate)
  }

  /**
   * 查找随机的可行走点（避开桌椅）
   */
  private findRandomWalkablePoint(): { x: number; y: number } | null {
    const maxAttempts = 20
    const margin = 50 // 边界留白

    for (let i = 0; i < maxAttempts; i++) {
      const x =
        this.hallBounds.x + margin + Math.random() * (this.hallBounds.width - margin * 2)
      const y =
        this.hallBounds.y + margin + Math.random() * (this.hallBounds.height - margin * 2)

      // 检查是否与桌椅碰撞
      if (!this.isPointInCollision(x, y)) {
        return { x, y }
      }
    }

    return null
  }

  /**
   * 检查点是否与桌椅碰撞
   */
  private isPointInCollision(x: number, y: number): boolean {
    const padding = 30 // 碰撞检测留白，避免贴得太近

    for (const rect of this.collisionRects) {
      if (
        x >= rect.x - padding &&
        x <= rect.x + rect.width + padding &&
        y >= rect.y - padding &&
        y <= rect.y + rect.height + padding
      ) {
        return true
      }
    }

    return false
  }
}
