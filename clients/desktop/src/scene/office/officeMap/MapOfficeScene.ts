/**
 * MapOfficeScene —— 按 office-map/v1.1 地图 1:1 复刻编辑工具的显示效果。
 *
 * 与编辑工具一致的关键点：
 * 1. 地面按 128×128 原生尺寸平铺；
 * 2. 元素按 zIndex 从小到大绘制（地面 < 家具 < 员工 < 电脑/屏幕 < 椅子 < 墙 < 玻璃 < 接头 < 门）；
 * 3. 工位 = 工位桌 + 独立电脑 + 办公椅 + Spine 员工，锚点用 seatOffset / chairOffset / computerOffset；
 * 4. 电脑屏幕内容画在元素自带的 screen 矩形内，颜色随员工状态变化；
 * 5. 员工走动使用与编辑器相同的阻挡多边形与四邻域寻路。
 */
import 'pixi.js/unsafe-eval'
import { Application, Container, Graphics, Sprite, Text, Texture, Ticker, TilingSprite } from 'pixi.js'
import type { ChibiFacing } from '@/config/office/characters'
import { CHIBI_CHARACTER_SKINS } from '@/config/office/characters'
import { SpineCharacter } from '@/scene/office/SpineCharacter'
import { ensureOfficeSpine } from '@/scene/office/loadOfficeAssets'
import { loadOfficeMap } from './loadOfficeMap'
import {
  Navigator,
  type ObstacleSet,
  blockers,
  elementPoint,
  facingFromDelta,
  obstacleSet,
  pathLength,
  pointAtDistance,
  seatAnchors,
  type WalkMode,
} from './geometry'
import { LOCOMOTION, nextFacing, paceFactor } from './locomotion'
import { REROUTE_CLEARANCE, createWalkState, pathNearPeople, planWalkSamples, stepWalk, walkRank, type WalkState } from './walker'
import {
  CHAIR_TIMING,
  ChairAnimator,
  HANDLE,
  LEAVE_STEPS,
  PULL_STEPS,
  SEAT_STEPS,
  TUCK_STEPS,
  behindChairZ,
  chairGates,
  chairPoses,
  chairTravel,
  handPose,
  handleDuration,
  handleSteps,
  stepsDuration,
  type ChairPoses,
  type HandleKind,
} from './chair'
import { findFreePoint, isPointFree, type CrowdNeighbor } from './crowd'
import { assignSeats, meetingSeatingPlan, pickMeetingRoom, visitSpot } from './meeting'
import {
  DESTINATION_SPEEDS,
  type DestinationCategory,
  type DestinationConfig,
  type MapElement,
  type MapPoint,
  type MapRect,
  type MapSeat,
  type OfficeCollabIntent,
  type OfficeMap,
  type WanderState,
} from './types'
import { pointInRect, wanderDestinations } from './destinations'
import { SCREEN_SCENE_FPS, drawScreenScene } from './screenScenes'

export {
  DESTINATION_SPEEDS,
  type DestinationCategory,
  type DestinationConfig,
  type WanderState,
}

export interface ScreenContent {
  /** 屏幕主色基调；不传时按员工状态推断 */
  tone?: 'idle' | 'thinking' | 'talking' | 'error'
  /** 屏幕上显示的任务标题（第一行） */
  title?: string
  /** 后续行，最多显示 3 行 */
  lines?: string[]
  /** 0–1，画一条进度条 */
  progress?: number
}

export type EmployeeStatus = 'working' | 'ready' | 'offline' | 'thinking' | 'talking' | 'walking' | 'idle'

export interface MapOfficeAgent {
  id: string | number
  name: string
  status?: string
}

export interface MapOfficeSceneOptions {
  mapUrl: string
  /** 是否开启闲置员工自动漫步，默认 true */
  autoWander?: boolean
  /** 闲置员工漫步周期（秒），默认 30 */
  wanderInterval?: number
  onReady?: (info: { map: OfficeMap; missing: string[] }) => void
  /** 左键点击员工角色时回调；不传则角色不可点（不显示手型光标） */
  onEmployeeClick?: (agent: MapOfficeAgent) => void
  /** 房间「使用中」集合变化（会议开始/散会、外部调用 setRoomOccupied）时回调 */
  onRoomOccupancyChange?: (occupiedRoomIds: string[]) => void
  onError?: (error: Error) => void
}

interface ScreenNode {
  container: Container
  graphics: Graphics
  text: Text | null
}

/** 员工正在参与的协作：串门（visitor / host）或会议（member） */
interface SeatCollab {
  key: string
  role: 'visitor' | 'host' | 'member'
  /** 要去的站位；host 守在自己的工位，为 null */
  dest: MapPoint | null
  /** 到位后的朝向 */
  facing: ChibiFacing | null
  arrived: boolean
  /** 出发前的等待（秒）：会议成员错开起身；走不通时也用它做重试间隔 */
  startIn: number
}

interface ActiveCollab {
  intent: OfficeCollabIntent
  /** 参与者的座位 id；串门为 [visitor, host]，会议为全体成员 */
  seatIds: string[]
  roomId?: string
  state: 'active' | 'dismissing'
  /** 开始 / 开始散会的时刻（场景时钟，秒） */
  since: number
  /** 串门：host 是否已经转向 visitor */
  hostTurned?: boolean
}

/**
 * 经椅子侧门进出工位的一趟行程：
 * - leave：home → 侧门 → 目的地。人先留在椅背后面（zIndex 低于椅子）从侧面走出，到侧门后站定、面向椅子，
 *   抬手扶住并把椅子推回桌下，松手后再走；
 * - enter：起点 → 侧门 → home。到侧门后站定、面向椅子，抬手扶住把椅子从桌下拉出，松手后落到椅背后面，
 *   从侧面进到桌椅之间，坐下后椅子再连人一起挪回。
 */
interface GateTrip {
  role: 'leave' | 'enter'
  /** 侧门在路径点数组里的下标（由 planPath 给出，walkPath 据此保留这个拐点不被拉直） */
  gateIndex: number
  /** 侧门在采样路径上的里程（px），walkPath 算出 */
  at: number
  /** enter：椅子是否已拉出 */
  pulled: boolean
  /** 是否已经到过侧门（手扶椅子的动作已开始） */
  passed: boolean
}

/** 坐着时撑扶手起身 / 坐下：两臂撑开的进度 */
interface ArmrestState {
  t: number
  total: number
}

/** 站在侧门处手扶椅子的进度；期间人原地不动 */
interface HandleState {
  kind: HandleKind
  /** 已经过的时间（秒） */
  t: number
  /** 椅子是否已开始动 */
  moved: boolean
}

/** 工位的办公椅：节点 + 三个姿态（塞进桌下 / 落座 / 拉出）+ 位置动画 */
interface ChairRig {
  node: Container
  poses: ChairPoses
  /** 椅子精灵宽度（站位计算用） */
  width: number
  anim: ChairAnimator
}

interface SeatNode {
  seat: MapSeat
  desk: MapElement
  home: MapPoint
  approach: MapPoint | null
  /** 真实的 agent；没有 agent 的工位就是空位，不画员工 */
  agent: MapOfficeAgent | null
  character: SpineCharacter | null
  label: Container | null
  screen: ScreenNode | null
  baseZ: number
  /** 人在椅背后面走动（起身离座 / 回座进座）时的层级：盖住电脑 / 屏幕，仍在椅子之下，见 behindChairZ */
  behindChairZ: number
  /** 办公椅；没有椅子元素的工位为 null */
  chair: ChairRig | null
  status: EmployeeStatus
  screenContent: ScreenContent
  /** 屏幕动画上一次重画的帧号；帧号变了才重画（见 SCREEN_SCENE_FPS） */
  screenFrame: number
  /** 屏幕动画的相位偏移（秒）：让十台电脑不同步 */
  screenPhase: number
  walking: WalkState | null
  /** 本次行走经过椅子侧门的信息；没走侧门为 null */
  gate: GateTrip | null
  /** 正在侧门处手扶椅子；否则为 null */
  handle: HandleState | null
  /** 正在撑扶手起身 / 坐下；否则为 null */
  armrest: ArmrestState | null
  /** 回到工位 / 到达协作站位后、转身前的剩余停顿（秒），0 表示无 */
  settle: number
  /** 停顿结束后转向的方向 */
  settleFacing: ChibiFacing
  /** 当前速度向量（px/s），供其他人避让时外推位置 */
  vel: MapPoint
  /** 回工位没成功后的重试倒计时（秒） */
  retryIn: number
  /** 距离下次检查「前方路线是否擦过静止的人」的倒计时（秒），见 rerouteAroundPeople */
  rerouteIn: number
  /** 散会时按顺序离场的倒计时（秒），null 表示不在离场队列 */
  dismissIn: number | null
  /** 正在参与的协作；期间不自由活动 */
  collab: SeatCollab | null
  wander: WanderState | null
  /** 被页面暂停（弹出介绍气泡期间）：整个人和椅子原地冻结，计时器也不走 */
  paused: boolean
}

/** 员工在画布（宿主元素）里的包围盒，CSS 像素，供页面把气泡贴在头旁边 */
export interface EmployeeAnchor {
  x: number
  y: number
  width: number
  height: number
}

const TONES: Record<'idle' | 'thinking' | 'talking' | 'error', number> = {
  idle: 0x4ade80,
  thinking: 0x38bdf8,
  talking: 0xfbbf24,
  error: 0xf87171,
}

/** 与编辑工具一致：员工整体缩放 = 0.32 × (椅宽 × 1.1 / 200)，椅宽 = 桌宽 × 0.58 */
const CHAIR_TO_DESK_RATIO = 0.58
const CHARACTER_TO_CHAIR_RATIO = 1.1
const SPINE_REFERENCE_WIDTH = 200

/** setComputerScreenStatus 的状态枚举 → 屏幕标题 */
const SCREEN_STATUS_TITLE: Record<'working' | 'browsing' | 'coding' | 'idle', string> = {
  working: '处理任务中',
  browsing: '检索资料',
  coding: '编写代码',
  idle: '待命',
}
/** 编辑工具中的头顶标签偏移：seat.y - 118 × deskWidth / 144 */
const LABEL_LIFT = 118

/**
 * 空位（没有 agent）的椅子往里收、贴着桌子放；有员工的工位保持地图里的 chairOffset 不变。
 * 只改 y（沿纵深收进去），x 沿用地图值。
 */
const EMPTY_CHAIR_TUCK_Y = 0.82

/** 串门 / 开会走向目的地的巡航步速（px/s） */
const COLLAB_SPEED = 64

/** 走动中检查「前方路线是否擦过静止的人」的间隔（秒） */
const REROUTE_INTERVAL = 0.4

/**
 * 单步时长上限（秒）：切回标签页 / 主线程卡一下后一帧可能经过几秒，
 * 按原样积分角色会一帧瞬移几百 px、避让与硬间距也都按错的步长算，所以按这个步长分小步推进。
 */
const MAX_FRAME_SECONDS = 0.05

/**
 * 一帧最多补算的时长（秒）：窗口最小化 / 被遮挡时 rAF 会停，恢复后按真实经过时间补推模拟，
 * 超出的部分丢弃（600 小步以内，避免恢复那一帧卡太久）。
 */
const MAX_CATCH_UP_SECONDS = 30

function samePoint(a: MapPoint | null, b: MapPoint | null, tolerance = 1): boolean {
  return !!a && !!b && Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance
}

export class MapOfficeScene {
  private app: Application | null = null
  private world: Container | null = null
  /** 家具与员工共用的可排序层：二者 zIndex 必须在同一层里比较，前后关系才和编辑器一致 */
  private sceneLayer: Container | null = null
  private map: OfficeMap | null = null
  private textures = new Map<string, Texture>()
  private seats = new Map<string, SeatNode>()
  /** 元素 id → 实际渲染节点，空位需要把椅子单独挪位 */
  private elementNodes = new Map<string, Container>()
  private agentToSeat = new Map<string, string>()
  /** 运行时「使用中」的房间 id（含地图里 occupied: true 的房间） */
  private occupiedRooms = new Set<string>()
  private roomBadgeLayer: Container | null = null
  private destroyed = false
  private autoWander = true
  private wanderInterval = 30
  private readonly options: MapOfficeSceneOptions
  private fitScale = 1
  /** 员工视角的寻路 / 碰撞加速器（墙、家具、禁区的包围盒与网格边缓存），init 时建好并预热 */
  private nav: Navigator | null = null
  /** 其他行走模式的加速器，第一次用到时才建 */
  private readonly extraNavs = new Map<WalkMode, Navigator>()
  /** 场景时钟（秒），用来给协作重试做退避 */
  private clock = 0
  private collabIntents: OfficeCollabIntent[] = []
  private activeCollabs = new Map<string, ActiveCollab>()
  private collabRetryAt = new Map<string, number>()
  private collabTick = 0
  /** 通行先后的取号机：每次出发领一个号，窄处相遇时号小的先走、号大的礼让（见 crowd.ts） */
  private walkTicket = 0
  /** 模拟时钟：与渲染（app.ticker）分开，画面不展示时也照常推进 */
  private simTicker: Ticker | null = null
  private simAt = 0
  /** 画面是否在展示；不展示时停掉渲染与 Spine 骨骼动画，只推进位置与状态 */
  private rendering = true

  /** 站位（目的地）能不能站：与寻路同样的 12px 净距 */
  private readonly spotBlocked = (point: MapPoint): boolean =>
    !this.nav || this.nav.isBlocked(point, 12)
  /** 让位后的点能不能站：比寻路宽松一点，窄过道里才有空间让 */
  private readonly dodgeBlocked = (point: MapPoint): boolean =>
    !this.nav || this.nav.isBlocked(point, 9)

  constructor(options: MapOfficeSceneOptions) {
    this.options = options
    this.autoWander = options.autoWander ?? true
    this.wanderInterval = options.wanderInterval ?? 30
  }

  get mapInfo(): OfficeMap | null {
    return this.map
  }

  get seatIds(): string[] {
    return [...this.seats.keys()]
  }

  async init(host: HTMLElement, width: number, height: number, agents: MapOfficeAgent[] = []): Promise<void> {
    this.destroyed = false
    try {
      const app = new Application()
      await app.init({
        width,
        height,
        backgroundAlpha: 0,
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      })
      if (this.destroyed) {
        app.destroy(true, { children: true })
        return
      }
      this.app = app
      host.appendChild(app.canvas)
      ;(app.canvas as HTMLCanvasElement).style.display = 'block'

      const { map, textures, missing } = await loadOfficeMap(this.options.mapUrl)
      if (this.destroyed || !this.app?.stage) return
      this.map = map
      // 寻路一次几十到几百毫秒会卡住渲染线程：静态障碍的边通不通在加载阶段算好（约 30ms），运行时只查表
      this.nav = new Navigator(map, 'employee')
      this.nav.warm([12, 8])
      this.textures = textures
      await ensureOfficeSpine()
      if (this.destroyed || !this.app?.stage) return

      const world = new Container()
      this.world = world
      app.stage.addChild(world)
      this.mountFloors(map, textures)
      this.mountElements(map, textures)
      this.mountPeople(map, agents)
      this.mountLabels()
      // 房间「使用中」标记层：建立后把地图里已经标为占用的房间画上徽标
      const badgeLayer = new Container()
      badgeLayer.sortableChildren = true
      world.addChild(badgeLayer)
      this.roomBadgeLayer = badgeLayer
      for (const room of map.rooms ?? []) if (room.occupied === true) this.occupiedRooms.add(room.id)
      this.paintRoomBadges()

      this.fit(width, height)
      const sim = new Ticker()
      sim.add(() => this.tick())
      this.simAt = performance.now()
      sim.start()
      this.simTicker = sim
      this.applyRendering()
      this.options.onReady?.({ map, missing })
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      console.error('[MapOfficeScene] 初始化失败', failure)
      this.options.onError?.(failure)
    }
  }

  resize(width: number, height: number): void {
    if (!this.app) return
    this.app.renderer.resize(width, height)
    this.fit(width, height)
  }

  /** 把画布挪到另一个宿主元素里（页面展示 / 离开时在页面与离屏容器之间搬动），场景状态不变 */
  attachCanvas(host: HTMLElement): void {
    const canvas = this.app?.canvas as HTMLCanvasElement | undefined
    if (canvas && canvas.parentElement !== host) host.appendChild(canvas)
  }

  /** 画面是否在展示：不展示时只停渲染，员工照常走动 / 漫步 / 协作 */
  setRendering(enabled: boolean): void {
    if (this.rendering === enabled) return
    this.rendering = enabled
    this.applyRendering()
  }

  private applyRendering(): void {
    if (!this.app || !this.simTicker) return
    for (const node of this.seats.values()) node.character?.setAnimating(this.rendering)
    if (this.rendering) {
      this.animateScreens()
      this.app.start()
    } else {
      this.app.stop()
    }
  }

  /** 后端状态更新（不换人）：只改屏幕基调，不重建场景，员工的位置与动作不受影响 */
  updateAgentStatuses(agents: readonly MapOfficeAgent[]): void {
    for (const agent of agents) {
      const node = this.nodeByAgent(agent.id)
      if (!node?.agent || node.agent.status === agent.status) continue
      node.agent.status = agent.status
      this.paintScreen(node)
    }
  }

  destroy(): void {
    this.destroyed = true
    this.simTicker?.destroy()
    this.simTicker = null
    this.seats.forEach((node) => {
      node.character?.destroySpine()
      node.character?.destroy()
    })
    this.seats.clear()
    this.agentToSeat.clear()
    this.elementNodes.clear()
    this.occupiedRooms.clear()
    this.activeCollabs.clear()
    this.collabRetryAt.clear()
    this.collabIntents = []
    this.roomBadgeLayer = null
    this.textures.clear()
    this.map = null
    this.nav = null
    this.extraNavs.clear()
    this.world = null
    this.sceneLayer = null
    this.app?.destroy(true, { children: true })
    this.app = null
  }

  // ---------------------------------------------------------------- 状态 / 交互 API

  /** 设置员工状态：决定播放入哪种动画 */
  setEmployeeStatus(seatId: string, status: EmployeeStatus): void {
    const node = this.seats.get(seatId)
    if (!node) return
    node.status = status
    this.applyAnimation(node)
    this.paintScreen(node)
  }

  /** 设置电脑屏幕里显示的内容（标题/行/进度/基调） */
  setScreenContent(seatId: string, content: ScreenContent): void {
    const node = this.seats.get(seatId)
    if (!node) return
    node.screenContent = content
    this.paintScreen(node)
  }

  /** 按 agent id 找座位后设置状态，便于页面直接用后端返回的 employee_id */
  setStatusByAgent(agentId: string | number, status: EmployeeStatus): void {
    const seatId = this.agentToSeat.get(String(agentId))
    if (seatId) this.setEmployeeStatus(seatId, status)
  }

  setScreenByAgent(agentId: string | number, content: ScreenContent): void {
    const seatId = this.agentToSeat.get(String(agentId))
    if (seatId) this.setScreenContent(seatId, content)
  }

  /**
   * 让员工沿给定折线走动；返回是否接受。
   * 折线先拉直、拐角倒圆（均做碰撞校验），再按速度曲线行走（详见 walker.ts）：
   * 原地起身/转身 → 加速 → 巡航 → 转弯放慢 → 收步停下；沿途遇到其他员工会让位、减速或等待。
   * speed 为巡航速度，每人有 ±10% 个体差异。
   */
  walkPath(seatId: string, points: MapPoint[], speed = 60, radius = 12, trip: Pick<GateTrip, 'role' | 'gateIndex'> | null = null): boolean {
    const node = this.seats.get(seatId)
    const map = this.map
    if (!node?.character || !map || points.length < 2) return false
    // 拉直路径时也要避开没在走动的人，否则刚绕开的路线又被拉直穿过去
    const nav = this.nav
    if (!nav) return false
    const resting = this.restingObstacles(seatId)
    const isClear = (a: MapPoint, b: MapPoint) => nav.clearSegment(a, b, radius, resting)
    const cruise = speed * paceFactor(seatId)

    // 中途改道：保留当前速度继续走；从静止出发：先起身（在工位：抽椅子）或先转身，再迈步
    const previous = node.walking
    const seated = !previous && samePoint(node.home, this.currentPoint(node), 2)
    // 侧门这个拐点必须保留（不能被拉直 / 倒圆穿过椅子），所以以它为界分两段整形
    const gated = !!node.chair && !!trip && trip.gateIndex >= 1 && trip.gateIndex <= points.length - 2 && (trip.role === 'enter' || seated)
    let samples: MapPoint[]
    let gate: GateTrip | null = null
    // 侧门处要停住扶椅子：速度曲线在这个采样点降到 0
    const stops: number[] = []
    if (gated && trip) {
      const lead = planWalkSamples(points.slice(0, trip.gateIndex + 1), isClear)
      const rest = planWalkSamples(points.slice(trip.gateIndex), isClear)
      samples = [...lead, ...rest.slice(1)]
      stops.push(lead.length - 1)
      gate = { role: trip.role, gateIndex: trip.gateIndex, at: pathLength(lead), pulled: false, passed: false }
    } else {
      samples = planWalkSamples(points, isClear)
    }
    const walking = createWalkState({
      samples,
      cruise,
      speed: previous ? Math.min(previous.speed, cruise) : 0,
      delay: previous ? 0 : seated ? (node.chair ? CHAIR_TIMING.leaveWalkAt : LOCOMOTION.standUpDelay) : LOCOMOTION.turnDelay,
      stops,
      // 中途改道沿用原来的号，不然被叫去串门的人会被排到队尾、一路都在让别人
      rank: previous?.rank ?? ++this.walkTicket,
      inherit: previous ?? undefined,
    })
    this.cancelHandle(node)
    node.walking = walking
    node.gate = gate
    node.settle = 0
    node.status = 'walking'
    if (seated) {
      // 还坐在椅子后面：先把椅子拉出，椅子拉开后（delay 走完）再转向迈步；
      // 走侧门时人一直留在椅背后面，从侧面走出来才站到椅子前面
      if (gate) this.chairPlay(node, PULL_STEPS)
      else if (node.chair) this.chairPlay(node, LEAVE_STEPS)
      // 起身：双手撑着扶手把椅子往后蹬开
      if (node.chair) this.startArmrest(node, walking.delay)
    } else {
      node.character.zIndex = 40
      this.steer(node, walking, true)
      // 改道离开（回座途中又被叫走）：椅子还拉在外面就推回桌下
      if (gate?.role !== 'enter' && node.chair && !this.chairAt(node, 'tucked')) this.chairPlay(node, TUCK_STEPS)
    }
    this.applyAnimation(node)
    return true
  }

  /** 沿地图可行走区域寻路到目标点，然后走过去 */
  walkTo(seatId: string, target: MapPoint, speed = 60, radius = 12, mode: WalkMode = 'employee'): boolean {
    const node = this.seats.get(seatId)
    if (!node || !this.map) return false
    const start = this.currentPoint(node)
    // 让位后站得离墙近，12px 净距下起点可能就被判阻挡：退一步用 8px 再试一次
    for (const r of radius > 8 ? [radius, 8] : [radius]) {
      const plan = this.planPath(seatId, start, target, r, mode)
      if (plan) return this.walkPath(seatId, plan.path, speed, r, plan.trip)
    }
    return false
  }

  /**
   * 没在走动的人（坐着、站着聊天、开会）占的位置：路线要绕开，不能从他们身上穿过去。
   * 每人一个小方块，加上寻路的净距后离中心约 20px；走动中的人由逐帧避让处理，不在这里。
   */
  private restingPolygons(excludeSeatId: string): MapPoint[][] {
    const half = 8
    return this.restingPoints(excludeSeatId).map(({ x, y }) => [
      { x: x - half, y: y - half },
      { x: x + half, y: y - half },
      { x: x + half, y: y + half },
      { x: x - half, y: y + half },
    ])
  }

  /** 没在迈步的人（含起身 / 转身停顿中）的位置 */
  private restingPoints(excludeSeatId: string): MapPoint[] {
    const points: MapPoint[] = []
    for (const node of this.seats.values()) {
      if (node.seat.id === excludeSeatId || !node.character) continue
      if (node.walking && node.walking.delay <= 0) continue
      points.push(this.currentPoint(node))
    }
    return points
  }

  /** 静止的人的临时障碍集（带包围盒）；没有人时返回 undefined，调用方直接走静态障碍的快路径 */
  private restingObstacles(excludeSeatId: string): ObstacleSet | undefined {
    const polygons = this.restingPolygons(excludeSeatId)
    return polygons.length ? obstacleSet(polygons) : undefined
  }

  private navigatorFor(mode: WalkMode): Navigator {
    if (mode === 'employee' && this.nav) return this.nav
    let nav = this.extraNavs.get(mode)
    if (!nav) {
      // SAFETY: pathAround 只在 map 已加载时调用，调用方已经检查过
      nav = new Navigator(this.map as OfficeMap, mode)
      this.extraNavs.set(mode, nav)
    }
    return nav
  }

  /** 先找绕开静止的人的路线；绕不开（通道被堵死、起终点贴着人）就退回只躲墙和家具的路线，宁可擦肩也不走不通 */
  private pathAround(seatId: string, start: MapPoint, target: MapPoint, radius: number, mode: WalkMode, strict = false): MapPoint[] | null {
    const map = this.map
    if (!map) return null
    const nav = this.navigatorFor(mode)
    const resting = this.restingObstacles(seatId)
    const around = resting ? nav.findPath(start, target, radius, resting) : null
    if (around && around.length >= 2) return around
    // strict：中途重新规划只为绕开人，绕不开就别换路线（普通路线本来就是穿过去的那条）
    if (strict && resting) return null
    const plain = nav.findPath(start, target, radius)
    return plain && plain.length >= 2 ? plain : null
  }

  /**
   * 路线规划（含进出工位的侧门）：
   * - 从自己工位出发：先走到椅子侧门（人从椅子侧面出来），再从那里去目的地；
   * - 回自己的工位：先走到椅子侧门，再从侧面进到桌椅之间；
   * - 其他：直接寻路。两侧都走不通（贴墙 / 被人占 / 绕不过去）就退回直接寻路。
   */
  private planPath(
    seatId: string,
    start: MapPoint,
    target: MapPoint,
    radius: number,
    mode: WalkMode,
    strict = false,
  ): { path: MapPoint[]; trip: Pick<GateTrip, 'role' | 'gateIndex'> | null } | null {
    const node = this.seats.get(seatId)
    if (node?.chair) {
      const atHome = samePoint(node.home, start, 2)
      const toHome = samePoint(node.home, target, 2)
      if (atHome && !toHome) {
        for (const gate of this.gateCandidates(node, target)) {
          const rest = this.pathAround(seatId, gate, target, radius, mode, strict)
          if (rest) return { path: [{ ...start }, ...rest], trip: { role: 'leave', gateIndex: 1 } }
        }
      } else if (!atHome && toHome) {
        for (const gate of this.gateCandidates(node, start)) {
          const lead = this.pathAround(seatId, start, gate, radius, mode, strict)
          if (lead) return { path: [...lead, { ...node.home }], trip: { role: 'enter', gateIndex: lead.length - 1 } }
        }
      }
    }
    const path = this.pathAround(seatId, start, target, radius, mode, strict)
    return path ? { path, trip: null } : null
  }

  /**
   * 走的途中前方路线擦过静止的人 → 重新规划绕开他们。
   * 路线是出发时规划的，出发后才站到路上的人（刚走到茶水间 / 厕所站定的同事）规划时并不存在，
   * 逐帧避让只能侧身挤过去或停下等；趁还有距离时换一条绕开的路，比到了跟前再让更顺。
   * 只在确实找得到绕开的路线时才换；椅子动作进行中和「离开途中还没走出侧门」时不动，免得打乱动作。
   */
  private rerouteAroundPeople(node: SeatNode, walking: WalkState, deltaSeconds: number): void {
    node.rerouteIn -= deltaSeconds
    if (node.rerouteIn > 0) return
    node.rerouteIn = REROUTE_INTERVAL
    const gate = node.gate
    if (node.handle || walking.delay > 0 || (gate && (gate.role === 'leave' ? !gate.passed : gate.passed))) return
    const people = this.restingPoints(node.seat.id)
    if (!pathNearPeople(walking, people, REROUTE_CLEARANCE)) return

    const end = walking.samples[walking.samples.length - 1]
    const start = this.currentPoint(node)
    // walkPath 会再乘一遍个体步速系数，这里先除掉，保持原来的巡航速度
    const speed = walking.cruise / paceFactor(node.seat.id)
    for (const radius of [12, 8]) {
      const plan = this.planPath(node.seat.id, start, end, radius, 'employee', true)
      if (plan && this.walkPath(node.seat.id, plan.path, speed, radius, plan.trip)) return
    }
    // 绕不开：原路线照走，由逐帧避让处理，隔久一点再试
    node.rerouteIn = REROUTE_INTERVAL * 4
  }

  /** 椅子左右侧门里站得下的，没人占的优先，再按离 toward 的远近排序 */
  private gateCandidates(node: SeatNode, toward: MapPoint): MapPoint[] {
    const chair = node.chair
    if (!chair) return []
    const gates = chairGates(chair.poses.seated, chair.width, node.home.y)
    const others = this.occupiedPoints(node.seat.id)
    const usable = [gates.left, gates.right].filter((gate) => !this.spotBlocked(gate))
    const nearer = (a: MapPoint, b: MapPoint) => Math.hypot(a.x - toward.x, a.y - toward.y) - Math.hypot(b.x - toward.x, b.y - toward.y)
    const free = usable.filter((gate) => isPointFree(gate, others, 24)).sort(nearer)
    const taken = usable.filter((gate) => !free.includes(gate)).sort(nearer)
    return [...free, ...taken]
  }

  /**
   * 员工的实时位置：就是角色当前的坐标（含避让产生的横向偏移）。
   * 不能用 home 代替——员工在茶水间/会议室时，起点必须是当前站位，否则寻路会瞬间“传送”回工位。
   */
  private currentPoint(node: SeatNode): MapPoint {
    if (node.character) return { x: node.character.x, y: node.character.y }
    return { ...node.home }
  }

  /** 走回自己的工位 */
  returnToSeat(seatId: string, speed = 60): boolean {
    const node = this.seats.get(seatId)
    if (!node) return false
    if (samePoint(node.home, this.currentPoint(node))) {
      this.stopWalking(seatId)
      return true
    }
    return this.walkTo(seatId, node.home, speed)
  }

  stopWalking(seatId: string): void {
    const node = this.seats.get(seatId)
    if (!node) return
    node.walking = null
    node.gate = null
    this.cancelHandle(node)
    node.settle = 0
    node.vel = { x: 0, y: 0 }
    if (node.character) {
      node.character.setLocomotionSpeed(0)
      node.character.position.set(node.home.x, node.home.y)
      node.character.zIndex = node.baseZ
      node.character.setFacing('back')
      node.seat.facing = 'back'
    }
    if (node.chair) {
      node.chair.anim.snap(node.chair.poses.seated)
      node.chair.node.position.set(node.chair.poses.seated.x, node.chair.poses.seated.y)
    }
    if (node.label) {
      node.label.position.set(node.home.x, node.home.y - (LABEL_LIFT * node.desk.width) / 144)
    }
    node.status = 'idle'
    if (node.wander) {
      node.wander.phase = 'idle_at_seat'
      node.wander.timer = this.wanderInterval
    }
    this.applyAnimation(node)
  }

  /**
   * 暂停 / 恢复某个员工（按 agent id）：暂停时原地站定，步态平滑收回站姿，
   * 恢复后从原状态接着走。没有这个员工（或空位）返回 false。
   */
  setEmployeePaused(agentId: string | number, paused: boolean): boolean {
    const node = this.nodeByAgent(agentId)
    if (!node?.character) return false
    node.paused = paused
    node.vel.x = 0
    node.vel.y = 0
    if (paused) node.character.setLocomotionSpeed(0)
    return true
  }

  /** 员工当前在宿主元素里的包围盒（CSS 像素）；没有这个员工返回 null */
  getEmployeeAnchor(agentId: string | number): EmployeeAnchor | null {
    const character = this.nodeByAgent(agentId)?.character
    if (!character || !character.isReady) return null
    const bounds = character.getBounds()
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
  }

  private nodeByAgent(agentId: string | number): SeatNode | undefined {
    const seatId = this.agentToSeat.get(String(agentId))
    return seatId ? this.seats.get(seatId) : undefined
  }

  /** 开启或关闭闲置员工自动漫步 */
  setAutoWander(enabled: boolean): void {
    this.autoWander = enabled
  }

  /** 设置闲置员工漫步周期（秒，最少 5 秒） */
  setWanderInterval(seconds: number): void {
    this.wanderInterval = Math.max(5, seconds)
  }

  seatPoint(seatId: string): MapPoint | null {
    const node = this.seats.get(seatId)
    if (!node) return null
    return { ...this.currentPoint(node) }
  }

  // ---------------------------------------------------------------- 与旧 OfficeScene 对齐的便捷方法

  /** 让指定员工播放思考动画 */
  playThinking(agentId: string | number): void {
    this.setStatusByAgent(agentId, 'thinking')
  }

  /** 让指定员工播放挥手/说话动画 */
  playTalking(agentId: string | number): void {
    this.setStatusByAgent(agentId, 'talking')
  }

  /** 让指定员工恢复待机动画 */
  playIdle(agentId: string | number): void {
    this.setStatusByAgent(agentId, 'idle')
  }

  /**
   * 设置电脑屏幕内容：既可以用这里的状态枚举，也能直接传 ScreenContent。
   * 枚举只是把员工状态映射到屏幕基调 + 一行标题，真实项目可以传任务标题与进度。
   */
  setComputerScreenStatus(agentId: string | number, status: 'working' | 'browsing' | 'coding' | 'idle' | ScreenContent): void {
    if (typeof status === 'string') {
      const tone: ScreenContent['tone'] = status === 'coding' ? 'thinking' : status === 'browsing' ? 'talking' : 'idle'
      this.setScreenByAgent(agentId, { tone, title: SCREEN_STATUS_TITLE[status] })
      return
    }
    this.setScreenByAgent(agentId, status)
  }

  // ---------------------------------------------------------------- 渲染

  private mountFloors(map: OfficeMap, textures: Map<string, Texture>): void {
    if (!this.world) return
    const layer = new Container()
    layer.sortableChildren = true
    this.world.addChild(layer)
    for (const element of map.elements) {
      if (!element.visible || element.kind !== 'image') continue
      const asset = map.assets.find((a) => a.id === element.assetId)
      const texture = asset ? textures.get(asset.src) : undefined
      if (!asset?.tileable || !texture) continue
      const tile = new TilingSprite({ texture, width: element.width, height: element.height })
      tile.position.set(element.x - element.width / 2, element.y - element.height / 2)
      tile.alpha = element.opacity
      tile.zIndex = element.zIndex
      layer.addChild(tile)
    }
  }

  private mountElements(map: OfficeMap, textures: Map<string, Texture>): void {
    if (!this.world) return
    const layer = new Container()
    layer.sortableChildren = true
    this.world.addChild(layer)
    this.sceneLayer = layer

    for (const element of map.elements) {
      if (!element.visible) continue
      if (element.kind === 'rect') {
        const rect = new Graphics().rect(0, 0, element.width, element.height).fill({ color: element.color })
        rect.pivot.set(element.width / 2, element.height / 2)
        rect.position.set(element.x, element.y)
        rect.rotation = (element.rotation * Math.PI) / 180
        rect.alpha = element.opacity
        rect.zIndex = element.zIndex
        layer.addChild(rect)
        this.elementNodes.set(element.id, rect)
        continue
      }
      const asset = map.assets.find((a) => a.id === element.assetId)
      const texture = asset ? textures.get(asset.src) : undefined
      if (asset?.tileable) {
        // 地面已在 mountFloors 用 TilingSprite 处理
        const tile = new TilingSprite({ texture: texture ?? Texture.EMPTY, width: 1, height: 1 })
        tile.visible = false
        layer.addChild(tile)
        continue
      }
      const sprite = new Sprite(texture ?? Texture.EMPTY)
      sprite.anchor.set(0.5)
      sprite.position.set(element.x, element.y)
      sprite.rotation = (element.rotation * Math.PI) / 180
      sprite.width = element.width
      sprite.height = element.height
      sprite.alpha = element.opacity
      sprite.zIndex = element.zIndex
      if (!texture) {
        const fallback = new Graphics().rect(-element.width / 2, -element.height / 2, element.width, element.height).fill({ color: 0x75474c, alpha: 0.6 })
        fallback.position.set(element.x, element.y)
        fallback.rotation = (element.rotation * Math.PI) / 180
        fallback.zIndex = element.zIndex
        layer.addChild(fallback)
        this.elementNodes.set(element.id, fallback)
        continue
      }
      layer.addChild(sprite)
      this.elementNodes.set(element.id, sprite)
    }
  }

  private mountPeople(map: OfficeMap, agents: MapOfficeAgent[]): void {
    if (!this.world) return
    // 关键：员工必须和家具放在同一个可排序层里，否则整层压在元素之上，
    // 椅子（zIndex 12）就盖不住员工（desk.zIndex + 2），和编辑器的前后关系不一致。
    const layer = this.sceneLayer ?? this.world
    if (layer === this.world) layer.sortableChildren = true

    for (const seat of map.seats ?? []) {
      const desk = map.elements.find((e) => e.id === seat.deskElementId)
      if (!desk) continue
      const { seat: home, approach } = seatAnchors(desk, seat.seatOffset, seat.approachOffset)
      const agent = agents[this.seats.size] ?? null
      const wander: WanderState | null = agent
        ? {
            // 错开初始倒计时：各闲置员工错峰出行，避免同一秒集体起立
            timer: (this.seats.size * 9) % this.wanderInterval + 5,
            phase: 'idle_at_seat',
            stayDuration: 0,
          }
        : null

      const node: SeatNode = {
        seat,
        desk,
        home,
        approach,
        agent,
        character: null,
        label: null,
        screen: this.mountScreen(map, seat),
        baseZ: desk.zIndex + 2,
        behindChairZ: behindChairZ(
          desk.zIndex + 2,
          map.elements.find((e) => e.id === seat.computerElementId)?.zIndex,
          map.elements.find((e) => e.id === seat.chairElementId)?.zIndex,
        ),
        chair: null,
        status: 'idle',
        screenContent: {},
        screenFrame: -1,
        screenPhase: this.seats.size * 1.37,
        walking: null,
        gate: null,
        handle: null,
        armrest: null,
        settle: 0,
        settleFacing: 'back',
        vel: { x: 0, y: 0 },
        retryIn: 0,
        rerouteIn: 0,
        dismissIn: null,
        collab: null,
        wander,
        paused: false,
      }

      // 只给真实员工创建角色；没有 agent 的工位保持空位（只剩桌子/显示器/椅子）
      if (agent) {
        const character = new SpineCharacter({
          skin: seat.employee?.skin ?? CHIBI_CHARACTER_SKINS[0],
          facing: seat.facing as ChibiFacing,
          scale: (CHAIR_TO_DESK_RATIO * desk.width * CHARACTER_TO_CHAIR_RATIO) / SPINE_REFERENCE_WIDTH,
        })
        character.position.set(home.x, home.y)
        character.zIndex = node.baseZ
        layer.addChild(character)
        node.character = character
        if (this.options.onEmployeeClick) character.setClickable(() => this.options.onEmployeeClick?.(agent))
        this.agentToSeat.set(String(agent.id), seat.id)
      }

      node.status = 'idle'
      this.seats.set(seat.id, node)
      node.chair = this.buildChair(desk, seat, !!agent)
      this.applyAnimation(node)
      this.paintScreen(node)
    }
  }

  /**
   * 办公椅：落座位置就是地图里椅子元素的位置，塞进桌下的位置沿「桌→椅」方向收进 EMPTY_CHAIR_TUCK_Y。
   * 没有分配 agent 的空工位，椅子一直塞在桌下（无人空位状态）；有员工的工位椅子在落座位置
   * （留出员工落座与后脑露出的空间），员工起身 / 落座时再抽出 / 推回，见 chair.ts。
   */
  private buildChair(desk: MapElement, seat: MapSeat, occupied: boolean): ChairRig | null {
    if (!seat.chairElementId || !this.map) return null
    const node = this.elementNodes.get(seat.chairElementId)
    const element = this.map.elements.find((e) => e.id === seat.chairElementId)
    if (!node || !element) return null
    const tucked = elementPoint(
      desk,
      { x: seat.chairOffset?.x ?? 0.14, y: EMPTY_CHAIR_TUCK_Y },
      { width: 1, height: 1 },
    )
    const poses = chairPoses({ x: element.x, y: element.y }, tucked)
    const anim = new ChairAnimator(occupied ? poses.seated : poses.tucked)
    node.position.set(anim.pos.x, anim.pos.y)
    return { node, poses, width: element.width, anim }
  }

  private chairPlay(node: SeatNode, steps: Parameters<ChairAnimator['play']>[0]): void {
    node.chair?.anim.play(steps, node.chair.poses)
  }

  /** 椅子是否已经停在某个姿态上（不在动） */
  private chairAt(node: SeatNode, pose: keyof ChairPoses): boolean {
    const chair = node.chair
    if (!chair || chair.anim.busy) return false
    return Math.hypot(chair.anim.pos.x - chair.poses[pose].x, chair.anim.pos.y - chair.poses[pose].y) < 1
  }

  /** 椅子离落座位置还有多远（px）：坐下时据此判断要不要把椅子推回去 */
  private chairOffSeat(node: SeatNode): boolean {
    const chair = node.chair
    return !!chair && Math.hypot(chair.anim.pos.x - chair.poses.seated.x, chair.anim.pos.y - chair.poses.seated.y) > 1
  }

  private mountScreen(map: OfficeMap, seat: MapSeat): ScreenNode | null {
    if (!this.world || !seat.computerElementId) return null
    const computer = map.elements.find((e) => e.id === seat.computerElementId)
    const screen = computer?.screen
    if (!computer || !screen) return null
    return this.createScreenNode(map, computer, screen)
  }

  private createScreenNode(map: OfficeMap, computer: MapElement, screenRect: MapRect): ScreenNode | null {
    if (!this.world) return null
    // 屏幕内容与电脑图元同层、zIndex 略高，保证它在椅子/墙之下，和编辑器一致
    const layer = this.sceneLayer ?? this.world
    if (layer === this.world) layer.sortableChildren = true
    const asset = map.assets.find((a) => a.id === computer.assetId)
    const baseWidth = asset?.width ?? computer.width
    const baseHeight = asset?.height ?? computer.height
    const scaleX = computer.width / baseWidth
    const scaleY = computer.height / baseHeight

    const local: MapRect = {
      x: -computer.width / 2 + screenRect.x * scaleX,
      y: -computer.height / 2 + screenRect.y * scaleY,
      width: screenRect.width * scaleX,
      height: screenRect.height * scaleY,
    }

    const container = new Container()
    container.position.set(computer.x, computer.y)
    container.rotation = (computer.rotation * Math.PI) / 180
    container.alpha = computer.opacity
    container.zIndex = computer.zIndex + 1
    const graphics = new Graphics()
    container.addChild(graphics)

    const text = new Text({
      text: '',
      style: {
        fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif',
        fontSize: Math.max(4, local.height * 0.17),
        fill: 0xdff7f0,
        wordWrap: true,
        wordWrapWidth: local.width * 0.86,
        lineHeight: Math.max(5, local.height * 0.2),
      },
    })
    text.position.set(local.x + local.width * 0.07, local.y + local.height * 0.26)
    const mask = new Graphics().rect(local.x, local.y, local.width, local.height).fill({ color: 0xffffff })
    text.mask = mask
    container.addChild(mask)
    container.addChild(text)

    layer.addChild(container)
    return { container, graphics, text }
  }
  private mountLabels(): void {
    if (!this.world) return
    const layer = new Container()
    layer.sortableChildren = true
    this.world.addChild(layer)

    for (const node of this.seats.values()) {
      // 只给真实员工显示姓名，不带工位编号；空位不画标签
      const label = node.agent?.name ?? ''
      if (!label) continue
      const text = new Text({
        text: label,
        style: {
          fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif',
          fontSize: 11,
          fill: 0x35423e,
        },
      })
      const background = new Graphics()
      const width = text.width + 10
      background.roundRect(-width / 2, -9, width, 18, 4).fill({ color: 0xffffff, alpha: 0.88 })
      const container = new Container()
      container.addChild(background)
      container.addChild(text)
      text.anchor.set(0.5)
      container.position.set(node.home.x, node.home.y - (LABEL_LIFT * node.desk.width) / 144)
      container.zIndex = 100
      layer.addChild(container)
      node.label = container
    }
  }

  // ---------------------------------------------------------------- 每帧

  /** 按真实经过时间推进模拟：分 MAX_FRAME_SECONDS 小步，单帧最多补 MAX_CATCH_UP_SECONDS；屏幕只在展示时重画 */
  private tick(): void {
    const now = performance.now()
    let remaining = Math.min((now - this.simAt) / 1000, MAX_CATCH_UP_SECONDS)
    this.simAt = now
    while (remaining > 1e-6 && !this.destroyed) {
      const step = Math.min(remaining, MAX_FRAME_SECONDS)
      this.update(step)
      remaining -= step
    }
    if (this.rendering && !this.destroyed) this.animateScreens()
  }

  private update(deltaSeconds: number): void {
    if (!deltaSeconds) return
    this.clock += deltaSeconds
    // 每帧开头的快照：所有人（含坐着的）都是别人的障碍，速度用于外推迎面而来的人
    const crowd: CrowdNeighbor[] = []
    for (const node of this.seats.values()) {
      if (!node.character) continue
      // 在走的人带着号参与礼让；站着、坐着、起身 / 手扶椅子的人没有号，只会被别人绕开
      const rank = node.walking && !node.handle && !node.paused ? walkRank(node.walking) : undefined
      crowd.push({ id: node.seat.id, x: node.character.x, y: node.character.y, vx: node.vel.x, vy: node.vel.y, rank })
    }

    for (const node of this.seats.values()) {
      if (node.paused) {
        // 冻结：不推进行走 / 停顿 / 椅子 / 漫步，速度清零让别人把他当作站着的人绕开
        node.vel.x = 0
        node.vel.y = 0
        continue
      }
      if (node.walking && node.character) {
        this.advanceWalk(node, node.walking, deltaSeconds, crowd)
      } else if (node.character) {
        node.vel.x = 0
        node.vel.y = 0
        if (node.settle > 0) {
          // 站定后稍顿再转身（回工位转向电脑 / 到协作站位转向对方），而不是落脚瞬间原地翻转
          node.settle -= deltaSeconds
          if (node.settle <= 0) {
            node.settle = 0
            node.seat.facing = node.settleFacing
            node.character.setFacing(node.settleFacing)
            // 回到工位：转身坐下——人在椅背后面（被椅背遮住下半身），椅子连人一起挪回落座位置
            if (samePoint(node.home, { x: node.character.x, y: node.character.y }, 6)) {
              node.character.zIndex = node.baseZ
              if (this.chairOffSeat(node)) {
                this.chairPlay(node, SEAT_STEPS)
                this.startArmrest(node, stepsDuration(SEAT_STEPS))
              }
            }
          }
        }
      }

      if (node.chair?.anim.busy) {
        node.chair.anim.update(deltaSeconds)
        node.chair.node.position.set(node.chair.anim.pos.x, node.chair.anim.pos.y)
      }
      this.updateArmrest(node, deltaSeconds)

      this.updateDismiss(node, deltaSeconds)
      this.updateWander(node, deltaSeconds)
      this.retryReturn(node, deltaSeconds)
    }
    this.updateCollabs(deltaSeconds)
  }

  private advanceWalk(node: SeatNode, walking: WalkState, deltaSeconds: number, crowd: readonly CrowdNeighbor[]): void {
    const character = node.character
    if (!character) return
    walking.facingCooldown = Math.max(0, walking.facingCooldown - deltaSeconds)
    // 站在侧门处手扶椅子：人原地不动，由 updateHandle 推进
    if (node.handle) {
      this.updateHandle(node, walking, deltaSeconds)
      return
    }
    this.rerouteAroundPeople(node, walking, deltaSeconds)
    // 改道会换掉 node.walking：后面这一帧接着用新的状态
    walking = node.walking ?? walking
    const standing = walking.delay > 0
    const from = { x: character.x, y: character.y }
    const step = stepWalk(walking, deltaSeconds, { selfId: node.seat.id, neighbors: crowd, isBlockedAt: this.dodgeBlocked })
    if (standing) {
      // 起身 / 转身的停顿：原地不动，步态收起
      character.setLocomotionSpeed(0)
      node.vel.x = 0
      node.vel.y = 0
      if (walking.delay <= 0) {
        // 停顿结束，转向行进方向；走侧门离开时人还在椅背后面（但已离座，要盖住电脑 / 屏幕），要走出侧门才站到椅子前面
        character.zIndex = node.gate?.role === 'leave' ? node.behindChairZ : 40
        this.steer(node, walking, true)
      }
      return
    }

    character.position.set(step.x, step.y)
    node.vel.x = (step.x - from.x) / deltaSeconds
    node.vel.y = (step.y - from.y) / deltaSeconds
    character.setLocomotionSpeed(step.speed)
    if (node.label) {
      node.label.position.set(step.x, step.y - (LABEL_LIFT * node.desk.width) / 144)
    }
    this.steer(node, walking, false)
    this.updateGateTrip(node, walking)
    if (step.arrived) this.finishWalk(node)
  }

  /** 走到椅子侧门：站定，开始手扶椅子（离开 = 推回桌下，回座 = 从桌下拉出），见 GateTrip */
  private updateGateTrip(node: SeatNode, walking: WalkState): void {
    const trip = node.gate
    if (!trip || !node.chair || !node.character || trip.passed || walking.distance < trip.at) return
    trip.passed = true
    this.startHandle(node, walking, trip.role === 'leave' ? 'tuck' : 'pull')
  }

  /** 面向椅子站定：人从椅背后面 / 过道走到椅子侧面，转向椅子，准备抬手 */
  private startHandle(node: SeatNode, walking: WalkState, kind: HandleKind): void {
    const character = node.character
    const chair = node.chair
    if (!character || !chair) return
    walking.speed = 0
    node.vel.x = 0
    node.vel.y = 0
    node.handle = { kind, t: 0, moved: false }
    if (kind === 'pull' && node.gate) node.gate.pulled = true
    // 站在椅子的左边就面朝右，站在右边就面朝左；人要在椅子前面（zIndex 高于椅子）才看得见手
    const facing: ChibiFacing = character.x < chair.poses.seated.x ? 'right' : 'left'
    node.seat.facing = facing
    character.setFacing(facing)
    character.zIndex = 40
    character.setLocomotionSpeed(0)
  }

  /** 推进手扶动作：抬手 → 椅子动（手跟着椅子走）→ 松手 → 继续走 */
  private updateHandle(node: SeatNode, walking: WalkState, deltaSeconds: number): void {
    const handle = node.handle
    const character = node.character
    const chair = node.chair
    if (!handle || !character || !chair) return
    handle.t += deltaSeconds
    character.setLocomotionSpeed(0)
    if (!handle.moved && handle.t >= HANDLE.raise) {
      handle.moved = true
      this.chairPlay(node, handleSteps(handle.kind))
    }
    character.setHands(handPose(handle.kind, handle.t, chairTravel(chair.anim.pos, chair.poses)))
    if (handle.t < handleDuration(handle.kind)) return

    node.handle = null
    character.setHands(null)
    walking.speed = 0
    // 离开：已经站在椅子外面，继续在前面走；回座：接着要走进椅背后面，落到椅子后面（仍在电脑 / 屏幕之上，坐稳后才回落座层级）
    character.zIndex = handle.kind === 'pull' ? node.behindChairZ : 40
    this.steer(node, walking, true)
  }

  /** 手扶动作被打断（改道 / 强制回座）：手放下，椅子留在当前位置由后续动作接着处理 */
  private cancelHandle(node: SeatNode): void {
    if (!node.handle && !node.armrest) return
    node.handle = null
    node.armrest = null
    node.character?.setHands(null)
  }

  /** 坐着时的撑扶手动作：两臂撑开再收回，持续 total 秒（人背对镜头，手臂向两侧撑出） */
  private startArmrest(node: SeatNode, total: number): void {
    if (total <= 0 || !node.character) return
    node.armrest = { t: 0, total }
  }

  private updateArmrest(node: SeatNode, deltaSeconds: number): void {
    const armrest = node.armrest
    if (!armrest || !node.character) return
    armrest.t += deltaSeconds
    if (armrest.t >= armrest.total) {
      node.armrest = null
      node.character.setHands(null)
      return
    }
    // 先撑开、中间保持、最后收回：sin 形包络
    node.character.setHands({ weight: Math.sin((Math.PI * armrest.t) / armrest.total), angle: 0 })
  }

  private finishWalk(node: SeatNode): void {
    const character = node.character
    if (!character) return
    const trip = node.gate
    node.walking = null
    node.gate = null
    node.vel.x = 0
    node.vel.y = 0
    character.setLocomotionSpeed(0)
    const at = { x: character.x, y: character.y }
    if (samePoint(node.home, at, 2)) {
      character.zIndex = node.baseZ
      node.settleFacing = 'back'
      if (node.chair && !trip?.pulled && this.chairOffSeat(node) && !this.chairAt(node, 'pulled')) {
        // 没走侧门（退路）：到椅前先把椅子从桌下拉出来，拉开后再转身坐下
        this.chairPlay(node, PULL_STEPS)
        node.settle = CHAIR_TIMING.enterSitAt
      } else {
        node.settle = LOCOMOTION.settleDelay
      }
    } else {
      character.zIndex = 40
      if (node.collab?.dest && samePoint(node.collab.dest, at, 6)) this.markArrived(node)
    }
    node.status = 'idle'
    this.applyAnimation(node)
  }

  /**
   * 朝向取前方 lookAhead 处的方向（提前转身），并带滞回与最短间隔，斜走时不会来回抽搐。
   * force = 起步时直接对准第一段方向。
   */
  private steer(node: SeatNode, walking: WalkState, force: boolean): void {
    const character = node.character
    if (!character) return
    const here = pointAtDistance(walking.samples, walking.distance).point
    const ahead = pointAtDistance(walking.samples, walking.distance + LOCOMOTION.lookAhead).point
    const dx = ahead.x - here.x
    const dy = ahead.y - here.y
    if (Math.hypot(dx, dy) < 1e-6) return
    const current = character.currentFacing
    const facing = force ? facingFromDelta(dx, dy) : nextFacing(current, dx, dy)
    if (facing === current || (!force && walking.facingCooldown > 0)) return
    node.seat.facing = facing
    character.setFacing(facing)
    walking.facingCooldown = LOCOMOTION.facingHold
  }

  /**
   * 闲置状态下的自动漫步状态机：
   * - 员工在闲置状态（ready / idle / 非 working）下，每 30 秒移动一下位置
   * - 目的地：茶水间、厕所、会议室、过道等
   * - 根据目的地设置不同的移动速度（厕所 85、茶水间 65、会议室 58、过道 45、回座 60）
   * - 到达目的地后停留 8 秒休闲，随后走回工位继续待命
   * - 一旦员工变为 working 或被指派任务，立刻返回工位
   */
  private updateWander(node: SeatNode, deltaSeconds: number): void {
    if (!this.autoWander || !node.wander || !node.character || !this.map) return
    // 正在串门 / 开会：行程由协作接管，不自由活动，也不被「非闲置→回工位」拉走
    if (node.collab) return

    // 员工若非闲置状态（如 working 或正在播特定表情），不能溜达
    const isIdle =
      (node.agent?.status === 'ready' || node.agent?.status === 'idle' || !node.agent?.status) &&
      node.status !== 'thinking' &&
      node.status !== 'talking'

    if (!isIdle) {
      // 员工被派活/离线时立刻往回走；已在工位或已在返程则不重复触发
      if (node.wander.phase !== 'returning' && !samePoint(node.home, this.currentPoint(node))) {
        node.wander.phase = 'returning'
        this.returnToSeat(node.seat.id, DESTINATION_SPEEDS.return)
      }
      return
    }

    switch (node.wander.phase) {
      case 'idle_at_seat': {
        node.wander.timer -= deltaSeconds
        if (node.wander.timer <= 0) {
          this.triggerWander(node)
        }
        break
      }
      case 'walking_to': {
        if (!node.walking) {
          // 到达目的地，按锚点配置的停留时长休息（缺省 8 秒）
          node.wander.phase = 'staying'
          node.wander.stayDuration = node.wander.destination?.stay ?? 8
          node.character.playIdle()
        }
        break
      }
      case 'staying': {
        node.wander.stayDuration -= deltaSeconds
        if (node.wander.stayDuration <= 0) {
          // 停留结束，走回工位
          node.wander.phase = 'returning'
          this.walkTo(node.seat.id, node.home, DESTINATION_SPEEDS.return)
        }
        break
      }
      case 'returning': {
        // 没走回工位（被打断 / 路径失败）时由 retryReturn 重试，这里只处理「已经回到」
        const seating = node.settle > 0 || !!node.chair?.anim.busy
        if (!node.walking && !seating && samePoint(node.home, this.currentPoint(node), 6)) {
          node.character.position.set(node.home.x, node.home.y)
          // 已回到工位，重置 30 秒计时器
          // 转身面向电脑由 update 里的 settle 停顿处理
          node.wander.phase = 'idle_at_seat'
          node.wander.timer = this.wanderInterval
          node.character.zIndex = node.baseZ
          node.character.playIdle()
          if (node.label) {
            node.label.position.set(node.home.x, node.home.y - (LABEL_LIFT * node.desk.width) / 144)
          }
        }
        break
      }
    }
  }

  private triggerWander(node: SeatNode): void {
    if (!node.wander || !node.character || !this.map) return
    const destinations = this.getWanderDestinations()
    if (destinations.length === 0) {
      node.wander.timer = this.wanderInterval
      return
    }

    // 尽量挑选与上一次不同类型的目的地
    const prevType = node.wander.destination?.type
    const categories: DestinationCategory[] = ['pantry', 'restroom', 'meeting', 'corridor']
    const otherCategories = categories.filter((c) => c !== prevType)
    const targetCategory = otherCategories[Math.floor(Math.random() * otherCategories.length)]

    const candidates = destinations.filter((d) => d.type === targetCategory)
    const pool = candidates.length > 0 ? candidates : destinations
    const dest = pool[Math.floor(Math.random() * pool.length)]

    const start = this.currentPoint(node)

    // 目的地已经有人（站着或正往那儿走）就挪到旁边的空位，不然两个人会叠在同一个点上
    const stand = findFreePoint(dest.point, this.occupiedPoints(node.seat.id), this.spotBlocked, 28, 96, 16)
    const plan = stand ? this.planPath(node.seat.id, start, stand, 12, 'employee') : null
    if (stand && plan) {
      node.wander.phase = 'walking_to'
      node.wander.destination = dest
      node.wander.stand = stand
      this.walkPath(node.seat.id, plan.path, dest.speed, 12, plan.trip)
    } else {
      // 路径不可达时 5 秒后重试
      node.wander.timer = 5
    }
  }

  /**
   * 获取可用的自由活动目的地：
   * 优先使用地图里由编辑器自定义的 spots 锚点，“使用中”的房间会被排除；
   * 旧地图没有锚点时回退到按房间与过道推导。详见 destinations.ts。
   */
  getWanderDestinations(): DestinationConfig[] {
    if (!this.map) return []
    return wanderDestinations(this.map, this.occupiedRooms)
  }

  /**
   * 运行时切换房间「使用中」状态（后端可接会议室预定/真实会议中）。
   * 使用中的房间不再作为自由活动目的地；已经在路上或已进入的员工会立即返回工位。
   */
  setRoomOccupied(roomId: string, occupied: boolean): void {
    if (!this.map) return
    const room = this.map.rooms?.find((r) => r.id === roomId)
    if (!room) return
    room.occupied = occupied
    if (occupied) this.occupiedRooms.add(roomId)
    else this.occupiedRooms.delete(roomId)

    if (occupied) {
      for (const node of this.seats.values()) {
        const destination = node.wander?.destination
        // 正在协作的人是被召来开会的，不是闲逛撞上的
        if (!destination || !node.character || node.collab) continue
        const headingThere = destination.roomId === roomId || pointInRect(destination.point, room.bounds)
        if (!headingThere) continue
        const inside = pointInRect({ x: node.character.x, y: node.character.y }, room.bounds)
        if (node.wander) node.wander.phase = 'returning'
        if (inside || node.walking) this.walkTo(node.seat.id, node.home, DESTINATION_SPEEDS.return)
      }
    }
    this.paintRoomBadges()
    this.options.onRoomOccupancyChange?.(this.occupiedRoomIds)
  }

  /** 当前被标记「使用中」的房间 id */
  get occupiedRoomIds(): string[] {
    return [...this.occupiedRooms]
  }

  // ---------------------------------------------------------------- 协作：串门 / 开会 / 回座

  /**
   * 设置当前应有的协作（由群聊 @ 派生，见 lib/officeCollaboration.ts）。
   * 场景自己对账：新出现的开始行动，消失的散场回座，会议成员增加时补位。
   * - visit：visitor 走到 host 工位旁，两人面对面；
   * - meeting：成员全部进入一间空闲会议室，期间该房间标「使用中」，散会后释放。
   */
  setCollaborations(intents: readonly OfficeCollabIntent[]): void {
    this.collabIntents = [...intents]
    this.collabTick = 0
  }

  /** 正在进行（含散场中）的协作 key */
  get collaborationKeys(): string[] {
    return [...this.activeCollabs.keys()]
  }

  /** 其他人的位置与协作目标点：挑站位时要避开，免得两个人约到同一个点 */
  private occupiedPoints(excludeSeatId?: string): MapPoint[] {
    const points: MapPoint[] = []
    for (const node of this.seats.values()) {
      if (node.seat.id === excludeSeatId || !node.character) continue
      points.push(this.currentPoint(node))
      if (node.collab?.dest) points.push(node.collab.dest)
      const wander = node.wander
      if (wander?.stand && (wander.phase === 'walking_to' || wander.phase === 'staying')) points.push(wander.stand)
    }
    return points
  }

  private freeSeatNode(agentId: string): SeatNode | null {
    const seatId = this.agentToSeat.get(agentId)
    const node = seatId ? this.seats.get(seatId) : undefined
    return node?.character && !node.collab ? node : null
  }

  private assignCollab(node: SeatNode, collab: SeatCollab): void {
    node.collab = collab
    node.dismissIn = null
    node.retryIn = 0
    // 正在逛（路上）的人立刻改道，不用等倒计时
    if (node.walking && collab.dest) {
      collab.startIn = 0
      this.walkTo(node.seat.id, collab.dest, COLLAB_SPEED)
    }
  }

  private updateCollabs(deltaSeconds: number): void {
    if (!this.map) return
    for (const collab of this.activeCollabs.values()) {
      for (const seatId of collab.seatIds) {
        const node = this.seats.get(seatId)
        const mine = node?.collab
        if (node && mine && mine.key === collab.intent.key) this.driveCollabMember(node, mine, collab, deltaSeconds)
      }
      if (collab.state === 'dismissing') this.finishDismiss(collab)
      else if (collab.intent.kind === 'visit' && !collab.hostTurned) this.turnHostToVisitor(collab)
    }
    this.collabTick -= deltaSeconds
    if (this.collabTick > 0) return
    this.collabTick = 0.5
    this.reconcileCollabs()
  }

  /** 逐帧推进一个协作成员：等待出发 → 走向站位（走不通 1.5 秒重试）→ 到位 */
  private driveCollabMember(node: SeatNode, mine: SeatCollab, collab: ActiveCollab, deltaSeconds: number): void {
    if (collab.state !== 'active' || mine.arrived || !mine.dest || !node.character || node.walking) return
    if (samePoint(mine.dest, this.currentPoint(node), 8)) {
      this.markArrived(node)
      return
    }
    if (mine.startIn > 0) {
      mine.startIn -= deltaSeconds
      return
    }
    if (!this.walkTo(node.seat.id, mine.dest, COLLAB_SPEED)) mine.startIn = 1.5
  }

  private markArrived(node: SeatNode): void {
    const mine = node.collab
    if (!mine || mine.arrived) return
    mine.arrived = true
    if (mine.facing) {
      // 站定后顿一下再转向对方 / 会议桌
      node.settleFacing = mine.facing
      node.settle = Math.max(node.settle, LOCOMOTION.settleDelay)
    }
  }

  /** 访客到了、主人也在工位上：主人从电脑前转过来面对访客 */
  private turnHostToVisitor(collab: ActiveCollab): void {
    const [visitorId, hostId] = collab.seatIds
    const visitor = this.seats.get(visitorId)
    const host = this.seats.get(hostId)
    if (!visitor?.character || !host?.character || !visitor.collab?.arrived || !host.collab?.arrived) return
    if (visitor.collab.key !== collab.intent.key || host.collab.key !== collab.intent.key) return
    host.settleFacing = facingFromDelta(visitor.character.x - host.character.x, visitor.character.y - host.character.y)
    host.settle = 0.3
    collab.hostTurned = true
  }

  private reconcileCollabs(): void {
    const wanted = new Map(this.collabIntents.map((intent) => [intent.key, intent]))
    for (const collab of [...this.activeCollabs.values()]) {
      const intent = wanted.get(collab.intent.key)
      if (!intent) {
        if (collab.state === 'active') this.dismissCollab(collab)
      } else if (collab.state === 'active') {
        this.syncMeeting(collab, intent)
      }
    }
    for (const intent of wanted.values()) {
      if (this.activeCollabs.has(intent.key)) continue
      if ((this.collabRetryAt.get(intent.key) ?? 0) > this.clock) continue
      // 暂时办不成（没有空闲会议室 / 人还在别的协作里）：稍后再试，不丢
      if (!this.startCollab(intent)) this.collabRetryAt.set(intent.key, this.clock + 1.5)
      else this.collabRetryAt.delete(intent.key)
    }
    for (const key of [...this.collabRetryAt.keys()]) if (!wanted.has(key)) this.collabRetryAt.delete(key)
  }

  private startCollab(intent: OfficeCollabIntent): boolean {
    return intent.kind === 'visit' ? this.startVisit(intent) : this.startMeeting(intent)
  }

  private startVisit(intent: Extract<OfficeCollabIntent, { kind: 'visit' }>): boolean {
    const map = this.map
    if (!map) return false
    const visitor = this.freeSeatNode(intent.visitor)
    const host = this.freeSeatNode(intent.host)
    if (!visitor || !host || visitor === host) return false
    // 站到主人椅子的左边
    const chair = host.chair ? { x: host.chair.poses.seated.x, y: host.chair.poses.seated.y, width: host.chair.width } : null
    const spot = visitSpot(map, { home: host.home, approach: host.approach, chair }, this.occupiedPoints(visitor.seat.id), this.spotBlocked)
    if (!spot) return false

    const hostAtDesk = samePoint(host.home, this.currentPoint(host), 6)
    this.assignCollab(visitor, { key: intent.key, role: 'visitor', dest: spot.point, facing: spot.facing, arrived: false, startIn: 0 })
    // 主人不在工位（在茶水间等）就先叫回来，访客到了才有人可聊
    this.assignCollab(host, {
      key: intent.key,
      role: 'host',
      dest: hostAtDesk ? null : { ...host.home },
      facing: 'back',
      arrived: hostAtDesk,
      startIn: 0,
    })
    this.activeCollabs.set(intent.key, { intent, seatIds: [visitor.seat.id, host.seat.id], state: 'active', since: this.clock })
    return true
  }

  private startMeeting(intent: Extract<OfficeCollabIntent, { kind: 'meeting' }>): boolean {
    const map = this.map
    if (!map) return false
    const nodes = [...new Set(intent.members)].map((id) => this.freeSeatNode(id)).filter((node): node is SeatNode => !!node)
    if (nodes.length < 2) return false
    const room = pickMeetingRoom(map, nodes.length, this.occupiedRooms, nodes.map((node) => this.currentPoint(node)))
    if (!room) return false
    const plan = meetingSeatingPlan(map, room, nodes.length, this.spotBlocked)
    if (plan.length < 2) return false

    // 站位不够（房间太挤）时，多出来的人留在工位，不硬塞
    const attending = nodes.slice(0, plan.length)
    const assigned = assignSeats(attending.map((node) => ({ id: node.seat.id, from: this.currentPoint(node) })), plan)
    attending.forEach((node, index) => {
      const spot = assigned.get(node.seat.id)
      if (!spot) return
      this.assignCollab(node, { key: intent.key, role: 'member', dest: spot.point, facing: spot.facing, arrived: false, startIn: index * 0.3 })
    })
    this.activeCollabs.set(intent.key, {
      intent,
      seatIds: attending.map((node) => node.seat.id),
      roomId: room.id,
      state: 'active',
      since: this.clock,
    })
    // 先把人定下来再标记房间：setRoomOccupied 会召回在里面闲逛的人，但放过被召来开会的
    this.setRoomOccupied(room.id, true)
    return true
  }

  /** 会议进行中有新成员加入（又 @ 了一个人）：补一个座位叫过来 */
  private syncMeeting(collab: ActiveCollab, intent: OfficeCollabIntent): void {
    const map = this.map
    if (intent.kind !== 'meeting' || !collab.roomId || !map) return
    const room = map.rooms?.find((r) => r.id === collab.roomId)
    if (!room) return
    const fresh = [...new Set(intent.members)]
      .map((id) => this.freeSeatNode(id))
      .filter((node): node is SeatNode => !!node && !collab.seatIds.includes(node.seat.id))
    if (fresh.length === 0) return
    // 座位方案对同一房间是确定的：前 N 个座位已被现有成员占用，新人取后面的
    const plan = meetingSeatingPlan(map, room, collab.seatIds.length + fresh.length, this.spotBlocked).slice(collab.seatIds.length)
    const joining = fresh.slice(0, plan.length)
    const assigned = assignSeats(joining.map((node) => ({ id: node.seat.id, from: this.currentPoint(node) })), plan)
    for (const node of joining) {
      const spot = assigned.get(node.seat.id)
      if (!spot) continue
      this.assignCollab(node, { key: intent.key, role: 'member', dest: spot.point, facing: spot.facing, arrived: false, startIn: 0 })
      collab.seatIds.push(node.seat.id)
    }
    collab.intent = intent
  }

  /** 协作结束：按顺序离场回座（会议隔一会儿走一个，串门的先道别再走） */
  private dismissCollab(collab: ActiveCollab): void {
    collab.state = 'dismissing'
    collab.since = this.clock
    collab.seatIds.forEach((seatId, index) => {
      const node = this.seats.get(seatId)
      if (!node?.collab || node.collab.key !== collab.intent.key) return
      const settled = node.collab.arrived
      if (collab.intent.kind === 'visit') node.dismissIn = node.collab.role === 'host' ? 1.2 : settled ? 0.8 : 0
      else node.dismissIn = settled ? 0.4 + index * 0.6 : 0
    })
  }

  private updateDismiss(node: SeatNode, deltaSeconds: number): void {
    if (node.dismissIn === null) return
    node.dismissIn -= deltaSeconds
    if (node.dismissIn <= 0) this.releaseCollab(node)
  }

  /** 解除协作：走回工位，恢复自由活动（回座后由漫步状态机接手） */
  private releaseCollab(node: SeatNode): void {
    node.collab = null
    node.dismissIn = null
    node.retryIn = 0
    if (!node.character) return
    if (node.wander) {
      node.wander.phase = 'returning'
      node.wander.timer = this.wanderInterval
    }
    if (samePoint(node.home, this.currentPoint(node), 6)) {
      node.settleFacing = 'back'
      node.settle = LOCOMOTION.settleDelay
    } else if (!this.walkTo(node.seat.id, node.home, DESTINATION_SPEEDS.return)) {
      node.retryIn = 1.5
    }
  }

  /** 散场收尾：人都离开了（或超时）才释放会议室，「使用中」标记跟着消失 */
  private finishDismiss(collab: ActiveCollab): void {
    const pending = collab.seatIds.some((seatId) => this.seats.get(seatId)?.collab?.key === collab.intent.key)
    if (pending) return
    const room = collab.roomId ? this.map?.rooms?.find((r) => r.id === collab.roomId) : undefined
    if (room) {
      const stillInside = collab.seatIds.some((seatId) => {
        const node = this.seats.get(seatId)
        return !!node?.character && pointInRect(this.currentPoint(node), room.bounds)
      })
      if (stillInside && this.clock - collab.since < 45) return
      this.setRoomOccupied(room.id, false)
    }
    this.activeCollabs.delete(collab.intent.key)
  }

  /** 没走回工位（路径暂时不通 / 被人堵住）时隔一会儿再试，保证最终一定回得去 */
  private retryReturn(node: SeatNode, deltaSeconds: number): void {
    if (node.collab || node.walking || !node.character || node.wander?.phase !== 'returning') return
    if (samePoint(node.home, this.currentPoint(node), 6)) return
    node.retryIn -= deltaSeconds
    if (node.retryIn > 0) return
    node.retryIn = 1.5
    this.walkTo(node.seat.id, node.home, DESTINATION_SPEEDS.return)
  }

  /** 在占用中的房间右上角画「使用中」标记，与编辑器显示一致 */
  private paintRoomBadges(): void {
    const rooms = this.map?.rooms ?? []
    if (!this.roomBadgeLayer) return
    const layer = this.roomBadgeLayer
    layer.removeChildren().forEach((child: Container) => child.destroy())
    for (const room of rooms) {
      if (room.occupied !== true) continue
      const text = new Text({
        text: '使用中',
        style: { fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif', fontSize: 12, fill: 0xffffff },
      })
      const padding = 8
      const width = text.width + padding * 2
      const height = text.height + 6
      const background = new Graphics()
        .roundRect(0, 0, width, height, 4)
        .fill({ color: 0xd94f4f, alpha: 0.95 })
      const badge = new Container()
      badge.addChild(background)
      badge.addChild(text)
      text.position.set(padding, 3)
      badge.position.set(room.bounds.x + room.bounds.width - width - 12, room.bounds.y + 12)
      badge.zIndex = 26
      layer.addChild(badge)
    }
  }

  /**
   * 后端状态只驱动显示器屏幕基调与右侧列表，不直接改变身体动画：
   * 工位默认保持背对镜头的待机姿态（与编辑器一致），需要表情动画时显式调 setEmployeeStatus。
   */
  private toneFromAgentStatus(status?: string): ScreenContent['tone'] | null {
    switch (status) {
      case 'working':
        return 'thinking'
      case 'ready':
        return 'talking'
      case 'offline':
        return 'error'
      default:
        return null
    }
  }

  private applyAnimation(node: SeatNode): void {
    const character = node.character
    if (!character) return
    // 不做整体半透明：编辑器里的员工始终是实色，离线只体现在屏幕基调与右侧列表
    if (node.status === 'walking') {
      character.playWalking(node.walking?.speed ?? 0)
      return
    }
    switch (node.status) {
      case 'thinking':
        character.playThinking()
        break
      case 'talking':
        character.playTalking()
        break
      default:
        character.playIdle()
        break
    }
  }

  private paintScreen(node: SeatNode): void {
    const screen = node.screen
    if (!screen || !this.map) return
    const computer = this.map.elements.find((e) => e.id === node.seat.computerElementId)
    const rect = computer?.screen
    const asset = this.map.assets.find((a) => a.id === computer?.assetId)
    if (!computer || !rect) return
    const scaleX = computer.width / (asset?.width ?? computer.width)
    const scaleY = computer.height / (asset?.height ?? computer.height)
    const local: MapRect = {
      x: -computer.width / 2 + rect.x * scaleX,
      y: -computer.height / 2 + rect.y * scaleY,
      width: rect.width * scaleX,
      height: rect.height * scaleY,
    }
    const content = node.screenContent
    const g = screen.graphics
    g.clear()
    // 无人工位的电脑保持黑屏：不画任何工作内容
    if (!node.agent) {
      g.rect(local.x, local.y, local.width, local.height).fill({ color: 0x05070a })
      if (screen.text) {
        screen.text.text = ''
        screen.text.visible = false
      }
      return
    }
    const tone = content.tone ?? this.toneFromAgentStatus(node.agent.status) ?? this.toneFromStatus(node.status)
    g.rect(local.x, local.y, local.width, local.height).fill({ color: 0x0f172a })

    const innerWidth = local.width * 0.93
    const innerHeight = local.height * 0.86
    drawScreenScene(
      g,
      {
        x: local.x + (local.width - innerWidth) / 2,
        y: local.y + (local.height - innerHeight) / 2,
        width: innerWidth,
        height: innerHeight,
      },
      {
        tone,
        color: TONES[tone],
        t: this.clock + node.screenPhase,
        progress: content.progress,
        textOverlay: !!(content.title || content.lines?.length),
      },
    )

    if (screen.text) {
      const lines = [content.title, ...(content.lines ?? []).slice(0, 3)].filter((item): item is string => !!item)
      screen.text.text = lines.join('\n')
      screen.text.visible = lines.length > 0
    }
  }

  /** 屏幕动画按固定帧率重画：阶梯式更新更像老显示器，也省掉每帧重建 Graphics */
  private animateScreens(): void {
    const frame = Math.floor(this.clock * SCREEN_SCENE_FPS)
    for (const node of this.seats.values()) {
      if (!node.screen || !node.agent || node.screenFrame === frame) continue
      node.screenFrame = frame
      this.paintScreen(node)
    }
  }

  private toneFromStatus(status: EmployeeStatus): 'idle' | 'thinking' | 'talking' | 'error' {
    if (status === 'thinking') return 'thinking'
    if (status === 'talking') return 'talking'
    if (status === 'offline') return 'error'
    return 'idle'
  }

  // ---------------------------------------------------------------- 视图缩放

  private fit(width: number, height: number): void {
    if (!this.world || !this.map) return
    const scale = Math.min(width / this.map.width, height / this.map.height)
    this.fitScale = scale
    this.world.scale.set(scale)
    this.world.position.set((width - this.map.width * scale) / 2, (height - this.map.height * scale) / 2)
  }

  /** 暴露给页面的：把画布坐标换算成地图坐标（例如点击寻路） */
  screenToMap(clientX: number, clientY: number): MapPoint | null {
    if (!this.app || !this.map) return null
    const rect = (this.app.canvas as HTMLCanvasElement).getBoundingClientRect()
    return {
      x: (clientX - rect.left - this.world!.position.x) / this.fitScale,
      y: (clientY - rect.top - this.world!.position.y) / this.fitScale,
    }
  }

  get blockersForDebug(): MapPoint[][] {
    return this.map ? blockers(this.map) : []
  }
}
