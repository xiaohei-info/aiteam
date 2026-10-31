import { AIFRED_RESOURCE_ID, AIFRED_SKINS, EMPLOYEE_ANIMATIONS } from './aifred-resources.js'

export const SCHEMA = 'office-map/v1.1'
export const LEGACY_SCHEMA = 'office-map/v1'
export const uid = () => crypto.randomUUID()
export const clone = value => structuredClone(value)
export const zoneLabels = { 'employee-no-entry': '员工禁入区', 'walk-blocked': '行走禁区', spawn: '员工出生区' }
/** 自由活动目的地锚点的类型：决定默认步速与前端显示的标记配色 */
export const SPOT_KINDS = { pantry: '茶水间', restroom: '厕所', meeting: '会议室', corridor: '过道', custom: '自定义' }
/** 各类型默认步速（px/s），可被 spot.speed 覆盖 */
export const SPOT_SPEEDS = { pantry: 65, restroom: 85, meeting: 58, corridor: 45, custom: 60 }
/** 到达目的地后的默认停留时长（秒） */
export const SPOT_STAY = 8
export const spotSpeed = spot => typeof spot?.speed === 'number' ? spot.speed : (SPOT_SPEEDS[spot?.kind] ?? SPOT_SPEEDS.custom)
/** 某房间是否被标记为“使用中”（使用中时员工不能把该房间当作自由活动目的地） */
export const roomOccupied = room => room?.occupied === true

export function syncSpots(map) {
  map.spots ||= []
  const roomIds = new Set(map.spots.map(s => s.roomId).filter(Boolean))
  for (const room of map.rooms || []) {
    if (!['meeting', 'pantry', 'restroom', 'lounge'].includes(room.type) || roomIds.has(room.id)) continue
    const kind = SPOT_KINDS[room.type] ? room.type : 'custom'
    map.spots.push({
      // 按「类型 + 房间」生成稳定 id，样例地图可重复生成且便于 diff
      id: `spot-${kind}-${room.id}`, name: room.name, kind, roomId: room.id,
      x: room.approachPoint?.x ?? room.bounds.x + room.bounds.width / 2,
      y: room.approachPoint?.y ?? room.bounds.y + room.bounds.height / 2,
      speed: SPOT_SPEEDS[kind], stay: SPOT_STAY, enabled: true,
    })
  }
  return map
}

export const makeMap = (background = null) => ({
  schema: SCHEMA, id: uid(), name: background ? `${background} 人办公室` : '自定义办公室',
  coordinateSystem: { unit: 'px', origin: 'top-left', xAxis: 'right', yAxis: 'down', rotation: 'clockwise-degrees' },
  width: 1254, height: 1254, gridSize: 16, backgroundColor: '#c5c2ba',
  background: background ? { src: `assets/icon_office_${background}.png`, opacity: 1, visible: true } : null,
  assets: [], elements: [], zones: [], spots: [],
})

export function safeSource(src) {
  return typeof src === 'string' && (/^assets\/[a-zA-Z0-9_./-]+\.(png|jpe?g|webp)$/i.test(src) && !src.split('/').includes('..') || /^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(src))
}
const finite = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max
const fail = message => { throw new Error(message) }
export function validateMap(input) {
  if (!input || ![SCHEMA, LEGACY_SCHEMA].includes(input.schema)) fail('不支持的配置版本，需要 office-map/v1 或 v1.1')
  if (typeof input.id !== 'string' || !input.id || input.id.length > 200) fail('地图 ID 无效')
  if (typeof input.name !== 'string' || input.name.length > 120) fail('地图名称无效')
  if (!finite(input.width, 128, 8192) || !finite(input.height, 128, 8192)) fail('地图宽高必须在 128–8192 像素之间')
  if (!finite(input.gridSize, 8, 128)) fail('网格尺寸必须在 8–128 之间')
  if (input.coordinateSystem?.unit !== 'px' || input.coordinateSystem?.origin !== 'top-left' || input.coordinateSystem?.xAxis !== 'right' || input.coordinateSystem?.yAxis !== 'down' || input.coordinateSystem?.rotation !== 'clockwise-degrees') fail('坐标系不兼容')
  if (!/^#[0-9a-f]{6}$/i.test(input.backgroundColor)) fail('地图底色无效')
  if (input.background && (!safeSource(input.background.src) || !finite(input.background.opacity, 0, 1) || typeof input.background.visible !== 'boolean')) fail('底图配置无效')
  for (const field of ['elements', 'zones', 'assets']) if (!Array.isArray(input[field]) || input[field].length > 2000) fail(`${field} 数量超过限制或格式无效`)
  for (const field of ['rooms', 'seats', 'spots']) if (input[field] !== undefined && (!Array.isArray(input[field]) || input[field].length > 2000)) fail(`${field} 格式或数量无效`)
  const ids = new Set()
  for (const item of [...input.assets, ...input.elements, ...input.zones, ...(input.rooms || []), ...(input.seats || []), ...(input.spots || [])]) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)) fail('元素、区域或素材 ID 缺失或重复')
    ids.add(item.id)
    if (typeof item.name !== 'string' || item.name.length > 120) fail('元素名称无效')
  }
  for (const asset of input.assets) {
    if (!safeSource(asset.src)) fail('素材仅支持项目 assets 路径或内嵌 PNG / JPEG / WebP')
    if (asset.width !== undefined && !finite(asset.width, 1, 8192) || asset.height !== undefined && !finite(asset.height, 1, 8192)) fail('素材默认尺寸无效')
    if (asset.tileable !== undefined && typeof asset.tileable !== 'boolean') fail('素材平铺属性无效')
  }
  const assetIds = new Set(input.assets.map(a => a.id))
  for (const e of input.elements) {
    if (!['rect', 'image'].includes(e.kind) || (e.kind === 'image' && !assetIds.has(e.assetId))) fail('元素类型或素材引用无效')
    if (!finite(e.x, 0, input.width) || !finite(e.y, 0, input.height) || !finite(e.width, 1, 8192) || !finite(e.height, 1, 8192) || !finite(e.rotation, -360, 360) || !finite(e.opacity, 0, 1)) fail('元素位置、尺寸或透明度无效')
    if (!/^#[0-9a-f]{6}$/i.test(e.color) || !finite(e.zIndex, -10000, 10000)) fail('元素颜色或图层无效')
    for (const key of ['visible', 'locked', 'blocksMovement']) if (typeof e[key] !== 'boolean') fail('元素状态无效')
    if (e.label !== undefined && (typeof e.label !== 'string' || e.label.length > 120)) fail('元素标签无效')
    if (e.screen !== undefined) {
      const s = e.screen
      if (!s || !finite(s.x, 0, e.width) || !finite(s.y, 0, e.height) || !finite(s.width, 0.001, e.width) || !finite(s.height, 0.001, e.height) || s.x + s.width > e.width || s.y + s.height > e.height) fail('屏幕区域无效')
    }
    if (e.geometry !== undefined) {
      if (input.schema === LEGACY_SCHEMA) fail('独立占地需要 office-map/v1.1')
      const g = e.geometry
      if (!g || !finite(g.width, 1, 8192) || !finite(g.height, 1, 8192)) fail('占地基准尺寸无效')
      if (g.stretchAxis !== undefined && !['x', 'y'].includes(g.stretchAxis)) fail('延伸方向无效')
      if (g.stretchAxis === 'x' && e.height !== g.height || g.stretchAxis === 'y' && e.width !== g.width) fail('墙体只能沿长度延伸，不能缩放厚度')
      if (g.footprints !== undefined && (!Array.isArray(g.footprints) || !g.footprints.length || g.footprints.length > 32)) fail('地面占地格式无效')
      for (const r of g.footprints || []) if (!r || !finite(r.x, 0, g.width) || !finite(r.y, 0, g.height) || !finite(r.width, 0.001, g.width) || !finite(r.height, 0.001, g.height) || r.x + r.width > g.width || r.y + r.height > g.height) fail('地面占地超出素材')
      if (g.connectors !== undefined && (!g.connectors || typeof g.connectors !== 'object' || Array.isArray(g.connectors))) fail('连接点格式无效')
      for (const [key, p] of Object.entries(g.connectors || {})) if (!['left', 'right', 'top', 'bottom'].includes(key) || !p || !finite(p.x, 0, g.width) || !finite(p.y, 0, g.height) || key === 'left' && p.x !== 0 || key === 'right' && p.x !== g.width || key === 'top' && p.y !== 0 || key === 'bottom' && p.y !== g.height) fail('连接点无效')
    }
  }
  const roomIds = new Set((input.rooms || []).map(r => r.id))
  for (const room of input.rooms || []) {
    const b = room.bounds
    if (!['meeting', 'pantry', 'restroom', 'work', 'lounge'].includes(room.type) || !b || !finite(b.x, 0, input.width) || !finite(b.y, 0, input.height) || !finite(b.width, 1, input.width) || !finite(b.height, 1, input.height) || b.x + b.width > input.width || b.y + b.height > input.height || !Number.isInteger(room.capacity) || !finite(room.capacity, 0, 1000)) fail('房间配置无效')
    if (room.approachPoint && (!finite(room.approachPoint.x, 0, input.width) || !finite(room.approachPoint.y, 0, input.height))) fail('房间接近点无效')
    if (room.occupied !== undefined && typeof room.occupied !== 'boolean') fail('房间「使用中」标记必须是布尔值')
  }
  for (const spot of input.spots || []) {
    if (input.schema === LEGACY_SCHEMA) fail('自由活动目的地需要 office-map/v1.1')
    if (!Object.hasOwn(SPOT_KINDS, spot.kind)) fail('活动点类型无效')
    if (!finite(spot.x, 0, input.width) || !finite(spot.y, 0, input.height)) fail('活动点坐标超出地图')
    if (spot.speed !== undefined && !finite(spot.speed, 5, 300)) fail('活动点步速必须在 5–300 px/s')
    if (spot.stay !== undefined && !finite(spot.stay, 0, 600)) fail('活动点停留时长必须在 0–600 秒')
    if (typeof spot.enabled !== 'boolean') fail('活动点启用状态无效')
    if (spot.roomId !== undefined && !roomIds.has(spot.roomId)) fail('活动点引用的房间不存在')
  }
  const elementIds = new Set(input.elements.map(e => e.id)), occupiedDesks = new Set()
  for (const seat of input.seats || []) {
    if (occupiedDesks.has(seat.deskElementId)) fail('同一工位桌不能重复绑定员工座位')
    occupiedDesks.add(seat.deskElementId)
    if (seat.employee !== undefined) {
      const emp = seat.employee
      if (input.schema === LEGACY_SCHEMA) fail('员工动画绑定需要 office-map/v1.1')
      if (!emp || emp.resourceId !== AIFRED_RESOURCE_ID || !AIFRED_SKINS.includes(emp.skin) || !Object.hasOwn(EMPLOYEE_ANIMATIONS, emp.animation) || typeof emp.enabled !== 'boolean' || typeof emp.name !== 'string' || emp.name.length > 60) fail('员工角色资源、皮肤或动画配置无效')
      if (!seat.seatOffset) fail('员工角色需要工位局部锚点')
    }
    if (seat.chairOffset && (!finite(seat.chairOffset.x, -5, 5) || !finite(seat.chairOffset.y, -5, 5))) fail('工位座椅相对位置无效')
    if (seat.chairElementId !== undefined && !elementIds.has(seat.chairElementId)) fail('工位座椅引用无效')
    if (seat.computerOffset && (!finite(seat.computerOffset.x, -5, 5) || !finite(seat.computerOffset.y, -5, 5))) fail('工位电脑相对位置无效')
    if (seat.computerElementId !== undefined && !elementIds.has(seat.computerElementId)) fail('工位电脑引用无效')
    if (!elementIds.has(seat.deskElementId) || !finite(seat.x, 0, input.width) || !finite(seat.y, 0, input.height) || !['front', 'back', 'left', 'right'].includes(seat.facing)) fail('工位配置无效')
    for (const key of ['seatOffset', 'approachOffset']) {
      const p = seat[key]
      if (p && (!finite(p.x, -5, 5) || !finite(p.y, -5, 5))) fail('工位相对位置无效')
    }
    if (seat.approachPoint && (!finite(seat.approachPoint.x, 0, input.width) || !finite(seat.approachPoint.y, 0, input.height))) fail('工位接近点无效')
  }
  for (const z of input.zones) {
    if (!zoneLabels[z.type] || !Array.isArray(z.points) || z.points.length < 3 || z.points.length > 500 || !isSimplePolygon(z.points)) fail('区域需为至少三个顶点的非自交多边形')
    if (typeof z.enabled !== 'boolean' || typeof z.visible !== 'boolean' || typeof z.locked !== 'boolean') fail('区域状态无效')
    for (const p of z.points) if (!finite(p.x, 0, input.width) || !finite(p.y, 0, input.height)) fail('区域顶点超出地图')
  }
  return clone(input)
}

export function elementPolygon(e) {
  const r = e.rotation * Math.PI / 180
  const c = Math.cos(r), s = Math.sin(r)
  return [[-e.width / 2, -e.height / 2], [e.width / 2, -e.height / 2], [e.width / 2, e.height / 2], [-e.width / 2, e.height / 2]].map(([x, y]) => ({ x: e.x + x * c - y * s, y: e.y + x * s + y * c }))
}
export function elementPoint(e, point, size = e.geometry || e) {
  const x = point.x / size.width * e.width - e.width / 2
  const y = point.y / size.height * e.height - e.height / 2
  const r = e.rotation * Math.PI / 180
  return { x: e.x + x * Math.cos(r) - y * Math.sin(r), y: e.y + x * Math.sin(r) + y * Math.cos(r) }
}
export function elementFootprints(e) {
  if (!e.geometry?.footprints) return [elementPolygon(e)]
  return e.geometry.footprints.map(r => [[r.x, r.y], [r.x + r.width, r.y], [r.x + r.width, r.y + r.height], [r.x, r.y + r.height]].map(([x, y]) => elementPoint(e, { x, y })))
}
export function elementConnectors(e) {
  const normals = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] }
  const r = e.rotation * Math.PI / 180
  return Object.entries(e.geometry?.connectors || {}).map(([key, p]) => {
    const [x, y] = normals[key]
    return { ...elementPoint(e, p), normal: { x: x * Math.cos(r) - y * Math.sin(r), y: x * Math.sin(r) + y * Math.cos(r) } }
  })
}
export function snapToConnectors(candidate, elements, tolerance = 12) {
  let best = tolerance, offset = null
  const ports = elementConnectors(candidate)
  for (const target of elements) {
    if (target.id === candidate.id || !target.visible) continue
    for (const a of ports) for (const b of elementConnectors(target)) {
      if (a.normal.x * b.normal.x + a.normal.y * b.normal.y > -0.95) continue
      const distance = Math.hypot(a.x - b.x, a.y - b.y)
      if (distance < best) { best = distance; offset = { x: b.x - a.x, y: b.y - a.y } }
    }
  }
  return { x: candidate.x + (offset?.x || 0), y: candidate.y + (offset?.y || 0) }
}
export function templateOptions(asset) {
  // defaultScale：素材基准尺寸（asset.width/height，screen 矩形的坐标系）与放置时的默认图元尺寸不同时使用
  const scale = asset.defaultScale ?? 1
  const options = { width: asset.width * scale, height: asset.height * scale, color: asset.color || '#e7e3db', opacity: asset.opacity ?? 1, zIndex: asset.zIndex ?? 0, blocksMovement: asset.blocksMovement ?? false }
  if (asset.screen) options.screen = clone(asset.screen)
  if (asset.footprints || asset.connectors) {
    const geometry = { width: asset.width, height: asset.height }
    if (asset.footprints) geometry.footprints = asset.footprints
    if (asset.connectors) geometry.connectors = asset.connectors
    if (asset.stretchAxis) geometry.stretchAxis = asset.stretchAxis
    options.geometry = clone(geometry)
  }
  return options
}
export function syncSeats(map) {
  for (const seat of map.seats || []) {
    const desk = map.elements.find(e => e.id === seat.deskElementId)
    if (!desk) continue
    if (seat.chairElementId && !map.elements.some(e => e.id === seat.chairElementId)) delete seat.chairElementId
    if (seat.computerElementId && !map.elements.some(e => e.id === seat.computerElementId)) delete seat.computerElementId
    if (seat.seatOffset) Object.assign(seat, elementPoint(desk, seat.seatOffset, { width: 1, height: 1 }))
    if (seat.approachOffset) seat.approachPoint = elementPoint(desk, seat.approachOffset, { width: 1, height: 1 })
    if (!seat.employee) seat.facing = ['back', 'right', 'front', 'left'][((Math.round(desk.rotation / 90) % 4) + 4) % 4]
    if (seat.chairOffset && seat.chairElementId) {
      const chair = map.elements.find(e => e.id === seat.chairElementId)
      if (chair) {
        Object.assign(chair, elementPoint(desk, seat.chairOffset, { width: 1, height: 1 }))
        chair.rotation = desk.rotation
        chair.width = desk.width * 0.58; chair.height = chair.width * 492 / 474
      }
    }
    if (seat.computerOffset && seat.computerElementId) {
      const computer = map.elements.find(e => e.id === seat.computerElementId)
      if (computer) {
        Object.assign(computer, elementPoint(desk, seat.computerOffset, { width: 1, height: 1 }))
        computer.rotation = desk.rotation
      }
    }
  }
}
export function segmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}
export function pointInPolygon(p, points) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j]
    if (segmentDistance(p, a, b) < 1e-7) return true
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
function intersects(a, b, c, d) {
  const v = [cross(a, b, c), cross(a, b, d), cross(c, d, a), cross(c, d, b)]
  if (v[0] * v[1] < 0 && v[2] * v[3] < 0) return true
  return segmentDistance(a, c, d) < 1e-7 || segmentDistance(b, c, d) < 1e-7 || segmentDistance(c, a, b) < 1e-7 || segmentDistance(d, a, b) < 1e-7
}
/** 轴对齐矩形与任意多边形是否重叠（顶点包含、边相交、边界接触都算命中）；用于框选与区域/限制区命中判定。 */
export function rectIntersectsPolygon(rect, points) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0) || !Array.isArray(points) || points.length < 3) return false
  const x2 = rect.x + rect.width, y2 = rect.y + rect.height
  const corners = [{ x: rect.x, y: rect.y }, { x: x2, y: rect.y }, { x: x2, y: y2 }, { x: rect.x, y: y2 }]
  if (points.some(p => p.x >= rect.x && p.x <= x2 && p.y >= rect.y && p.y <= y2)) return true
  if (corners.some(p => pointInPolygon(p, points))) return true
  return points.some((a, i) => {
    const b = points[(i + 1) % points.length]
    return corners.some((c, j) => intersects(a, b, c, corners[(j + 1) % corners.length]))
  })
}
export function isSimplePolygon(points) {
  if (!Array.isArray(points) || points.length < 3 || points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length]
    if (Math.hypot(a.x - b.x, a.y - b.y) < 0.1) return false
    area += a.x * b.y - b.x * a.y
    for (let j = i + 1; j < points.length; j++) {
      if (j === i + 1 || i === 0 && j === points.length - 1) continue
      if (intersects(a, b, points[j], points[(j + 1) % points.length])) return false
    }
  }
  return Math.abs(area) > 1
}
export function blockers(map, mode = 'employee') {
  return [
    ...map.elements.filter(e => e.blocksMovement).flatMap(elementFootprints),
    ...map.zones.filter(z => z.enabled && (z.type === 'walk-blocked' || mode === 'employee' && z.type === 'employee-no-entry')).map(z => z.points),
  ]
}
export function isBlocked(map, p, radius = 8, mode = 'employee', polygons = blockers(map, mode)) {
  if (p.x < radius || p.y < radius || p.x > map.width - radius || p.y > map.height - radius) return true
  return polygons.some(poly => pointInPolygon(p, poly) || poly.some((a, i) => segmentDistance(p, a, poly[(i + 1) % poly.length]) <= radius))
}
export function clearSegment(map, a, b, radius, mode, polygons = blockers(map, mode)) {
  if (isBlocked(map, a, radius, mode, polygons) || isBlocked(map, b, radius, mode, polygons)) return false
  return !polygons.some(poly => poly.some((c, i) => {
    const d = poly[(i + 1) % poly.length]
    return intersects(a, b, c, d) || Math.min(segmentDistance(a, c, d), segmentDistance(b, c, d), segmentDistance(c, a, b), segmentDistance(d, a, b)) <= radius
  }))
}

/** Conservative 4-neighbor navigation; exact segment checks prevent tunneling through thin walls. */
export function findPath(map, start, end, radius = 8, mode = 'employee') {
  const polygons = blockers(map, mode)
  if (isBlocked(map, start, radius, mode, polygons) || isBlocked(map, end, radius, mode, polygons)) return null
  if (clearSegment(map, start, end, radius, mode, polygons)) return [start, end]
  const step = Math.max(map.gridSize, Math.ceil(Math.max(map.width, map.height) / 160))
  const cols = Math.ceil(map.width / step), rows = Math.ceil(map.height / step)
  const point = id => ({ x: (id % cols + 0.5) * step, y: (Math.floor(id / cols) + 0.5) * step })
  const attach = p => {
    const candidates = []
    const x = Math.floor(p.x / step), y = Math.floor(p.y / step)
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (x + dx < 0 || x + dx >= cols || y + dy < 0 || y + dy >= rows) continue
      const id = (y + dy) * cols + x + dx
      if (clearSegment(map, p, point(id), radius, mode, polygons)) candidates.push(id)
    }
    return candidates
  }
  const starts = attach(start), ends = new Set(attach(end))
  const queue = [...starts], previous = new Map(starts.map(id => [id, null]))
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]
    if (ends.has(id)) {
      const path = [end]
      for (let cursor = id; cursor !== null; cursor = previous.get(cursor)) path.push(point(cursor))
      path.push(start)
      return path.reverse()
    }
    const x = id % cols, y = Math.floor(id / cols)
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue
      const next = ny * cols + nx
      if (previous.has(next) || !clearSegment(map, point(id), point(next), radius, mode, polygons)) continue
      previous.set(next, id); queue.push(next)
    }
  }
  return null
}
export function makeElement(name, kind, x, y, options = {}) {
  return { id: uid(), name, kind, x, y, width: 120, height: 80, rotation: 0, opacity: 1, color: '#e7e3db', zIndex: 0, visible: true, locked: false, blocksMovement: false, ...options }
}
export function mapWarnings(map) {
  const warnings = []
  for (const e of map.elements) if (elementPolygon(e).some(p => p.x < 0 || p.y < 0 || p.x > map.width || p.y > map.height)) warnings.push(`「${e.name}」有部分超出地图`)
  if (map.background && !map.zones.some(z => z.enabled && z.type === 'walk-blocked')) warnings.push('底图不会自动产生碰撞，请沿墙壁和家具绘制禁区')
  if (!map.zones.some(z => z.enabled && z.type === 'spawn')) warnings.push('尚未设置员工出生区')
  for (const z of map.zones.filter(z => z.enabled && z.type === 'spawn')) {
    const center = z.points.reduce((a, p) => ({ x: a.x + p.x / z.points.length, y: a.y + p.y / z.points.length }), { x: 0, y: 0 })
    if (isBlocked(map, center)) warnings.push(`「${z.name}」的中心落在禁区或障碍中`)
  }
  return warnings
}
export class History {
  constructor(map) { this.items = [clone(map)]; this.index = 0 }
  push(map) {
    if (JSON.stringify(this.items[this.index]) === JSON.stringify(map)) return
    this.items.splice(this.index + 1); this.items.push(clone(map))
    if (this.items.length > 60) this.items.shift()
    this.index = this.items.length - 1
  }
  undo() { if (this.index > 0) this.index--; return clone(this.items[this.index]) }
  redo() { if (this.index < this.items.length - 1) this.index++; return clone(this.items[this.index]) }
}
