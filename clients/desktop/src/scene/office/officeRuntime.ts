/**
 * 办公室常驻运行时：登录后就建好地图场景并一直推进模拟（漫步 / 串门 / 回座），
 * 不依赖办公室页面是否打开。
 *
 * - 页面展示时：attach 把画布挂进页面宿主，开启渲染；
 * - 页面离开时：detach 把画布挪回离屏容器，只停渲染与骨骼动画，位置与状态照常推进；
 * - 花名册（id / 姓名 / 顺序）不变时只更新状态，不重建场景，员工位置不会被重置。
 *
 * 由 OfficeRuntimeHost（应用外壳里的无界面组件）驱动 sync / setCollaborations。
 */
import { MapOfficeScene, type MapOfficeAgent } from './officeMap/MapOfficeScene'
import type { OfficeCollabIntent, OfficeMap } from './officeMap/types'

/** 离屏时的画布尺寸：只决定页面首次挂上前的缓冲区大小，挂上后按宿主尺寸 resize */
const STASH_SIZE = { width: 960, height: 600 }

export interface OfficeRuntimeView {
  onReady?: (info: { map: OfficeMap; missing: string[] }) => void
  onEmployeeClick?: (agent: MapOfficeAgent) => void
  /** 地图场景初始化失败；页面据此回退到旧场景 */
  onError?: (error: Error) => void
}

/** 座位按花名册顺序分配：id、姓名或顺序变了才需要重建场景 */
function rosterKey(agents: readonly MapOfficeAgent[]): string {
  return agents.map((agent) => `${agent.id}\u0000${agent.name}`).join('\u0001')
}

class OfficeRuntime {
  private scene: MapOfficeScene | null = null
  private ready = false
  private failure: Error | null = null
  private readyInfo: { map: OfficeMap; missing: string[] } | null = null
  private mapUrl: string | null = null
  private key = ''
  private agents: MapOfficeAgent[] = []
  private collaborations: readonly OfficeCollabIntent[] = []
  private stash: HTMLDivElement | null = null
  private host: HTMLElement | null = null
  private size = STASH_SIZE
  private view: OfficeRuntimeView | null = null
  /** 每次重建 / 销毁加一，旧场景迟到的回调据此丢弃 */
  private generation = 0

  /** 按最新地图与花名册对齐场景：不换人只改状态，换人或换地图才重建 */
  sync(mapUrl: string, agents: readonly MapOfficeAgent[]): void {
    // 场景保存的是副本：updateAgentStatuses 靠比较新旧 status 判断要不要重画
    this.agents = agents.map((agent) => ({ ...agent }))
    const key = rosterKey(agents)
    if (mapUrl === this.mapUrl && key === this.key) {
      if (this.ready) this.scene?.updateAgentStatuses(this.agents)
      return
    }
    this.teardown()
    this.mapUrl = mapUrl
    this.key = key
    if (agents.length === 0) return

    const generation = this.generation
    const scene = new MapOfficeScene({
      mapUrl,
      onReady: (info) => {
        if (generation === this.generation) this.readyInfo = info
      },
      onEmployeeClick: (agent) => {
        if (generation === this.generation) this.view?.onEmployeeClick?.(agent)
      },
      onError: (error) => {
        if (generation !== this.generation) return
        this.failure = error
        this.view?.onError?.(error)
      },
    })
    this.scene = scene
    const target = this.host ?? this.ensureStash()
    void scene.init(target, this.size.width, this.size.height, this.agents.map((agent) => ({ ...agent }))).then(() => {
      if (generation !== this.generation || this.failure) return
      this.ready = true
      scene.updateAgentStatuses(this.agents)
      scene.setCollaborations(this.collaborations)
      this.applyView()
      if (this.host && this.readyInfo) this.view?.onReady?.(this.readyInfo)
    })
  }

  /** 协作意图（串门 / 会议）；场景没就绪时先记下，就绪后应用 */
  setCollaborations(intents: readonly OfficeCollabIntent[]): void {
    this.collaborations = intents
    if (this.ready) this.scene?.setCollaborations(intents)
  }

  /** 页面展示：画布挂到宿主上并开始渲染 */
  attach(host: HTMLElement, width: number, height: number, view: OfficeRuntimeView): void {
    this.host = host
    this.size = { width, height }
    this.view = view
    if (this.failure) {
      view.onError?.(this.failure)
      return
    }
    this.applyView()
    if (this.ready && this.readyInfo) view.onReady?.(this.readyInfo)
  }

  /** 页面离开：画布挪回离屏容器，只停渲染，模拟继续 */
  detach(host: HTMLElement): void {
    if (this.host !== host) return
    this.host = null
    this.view = null
    this.applyView()
  }

  resize(width: number, height: number): void {
    this.size = { width, height }
    if (this.ready && this.host) this.scene?.resize(width, height)
  }

  /** 已就绪的场景（供页面暂停员工、取气泡锚点、播放活动动画）；没就绪返回 null */
  getScene(): MapOfficeScene | null {
    return this.ready ? this.scene : null
  }

  /** 退出登录：销毁场景并清空状态，下次登录重新开始 */
  dispose(): void {
    this.teardown()
    this.mapUrl = null
    this.key = ''
    this.agents = []
    this.collaborations = []
  }

  private applyView(): void {
    const scene = this.scene
    if (!scene || !this.ready) return
    if (this.host) {
      scene.attachCanvas(this.host)
      scene.resize(this.size.width, this.size.height)
      scene.setRendering(true)
    } else {
      scene.attachCanvas(this.ensureStash())
      scene.setRendering(false)
    }
  }

  private teardown(): void {
    this.generation += 1
    this.scene?.destroy()
    this.scene = null
    this.ready = false
    this.failure = null
    this.readyInfo = null
  }

  /** 离屏容器：不挂进文档，画布在这里时不参与布局也不渲染 */
  private ensureStash(): HTMLDivElement {
    if (!this.stash) this.stash = document.createElement('div')
    return this.stash
  }
}

export const officeRuntime = new OfficeRuntime()
