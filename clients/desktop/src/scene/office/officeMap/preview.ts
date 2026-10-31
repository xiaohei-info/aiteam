/**
 * 地图场景的独立预览入口：只挂载 MapOfficeScene，用于在浏览器里核对
 * 「前端渲染是否与编辑工具 1:1」。由 scripts/build-office-map-preview.mjs 打包成
 * public/office-map-preview.js，配套页面是 public/office-map-preview.html。
 */
import { MapOfficeScene, type EmployeeStatus, type ScreenContent } from './MapOfficeScene'

const host = document.querySelector<HTMLElement>('#host')
const status = document.querySelector<HTMLElement>('#status')
const params = new URLSearchParams(location.search)
const mapUrl = params.get('map') ?? '/assets/office/map/office-10-person.json'

if (!host) throw new Error('预览页缺少 #host 容器')

const TONES: Array<NonNullable<ScreenContent['tone']>> = ['idle', 'thinking', 'talking']
/** ?demo=1 演示各状态与屏幕内容；?agents=N 指定只填充前 N 个工位（默认 0 = 全部空位） */
const DEMO = params.get('demo') === '1'

function demoStatus(index: number): EmployeeStatus {
  if (index % 5 === 0) return 'talking'
  if (index % 3 === 0) return 'thinking'
  return 'idle'
}

const requested = DEMO ? 10 : Number(params.get('agents') ?? '0')
const agentCount = Number.isFinite(requested) ? Math.max(0, Math.min(10, Math.trunc(requested))) : 0
const customStatus = params.get('status')
const requestedInterval = Number(params.get('wander_interval'))
const wanderInterval = Number.isFinite(requestedInterval) && requestedInterval > 0 ? requestedInterval : 30

const demoAgents = Array.from({ length: agentCount }, (_, index) => ({
  id: `demo-${index + 1}`,
  name: `演示员工${String(index + 1).padStart(2, '0')}`,
  status: DEMO ? demoStatus(index) : (customStatus ?? 'ready'),
}))

const scene = new MapOfficeScene({
  mapUrl,
  wanderInterval,
  onReady: ({ map, missing }) => {
    const seatIds = scene.seatIds
    if (DEMO) {
      seatIds.forEach((seatId, index) => {
        if (index >= agentCount) return
        scene.setScreenContent(seatId, { tone: TONES[index % TONES.length], progress: ((index % 10) + 1) / 10 })
      })
    }
    if (status) {
      const suffix = missing.length ? ` · missing ${missing.length}` : ''
      status.textContent = `ready · ${map.elements.length} elements · ${seatIds.length} seats · ${agentCount} agents${suffix}`
    }
    document.title = `ready:${seatIds.length}`
  },
  onEmployeeClick: (agent) => {
    if (status) status.textContent = `click: ${agent.name}`
    document.title = `click:${agent.name}`
  },
  onError: (error) => {
    if (status) status.textContent = `error: ${error.message}`
    document.title = `error:${error.message}`
  },
})

const { width, height } = host.getBoundingClientRect()
void scene.init(host, width, height, demoAgents)

window.addEventListener('resize', () => {
  const rect = host.getBoundingClientRect()
  scene.resize(rect.width, rect.height)
})

declare global {
  interface Window {
    officeMap?: MapOfficeScene
  }
}

// 调试句柄：便于在控制台里直接调用 setScreenContent / walkTo
window.officeMap = scene
