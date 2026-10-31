import { SCHEMA, uid, clone, makeMap, validateMap, makeElement, elementPolygon, elementFootprints, templateOptions, snapToConnectors, syncSeats, syncSpots, pointInPolygon, isSimplePolygon, zoneLabels, SPOT_KINDS, SPOT_SPEEDS, SPOT_STAY, spotSpeed, mapWarnings, History } from './model.js'
import { loadStyles } from './library.js'
import { canSelect, rectHitsItem, groupRanges, moveLimits, clampDelta, normalizeRect } from './selection.js'
import { AIFRED_TEMPLATES, AIFRED_RESOURCE_ID, AIFRED_SKINS, AIFRED_COMPUTER_OFFSET, EMPLOYEE_ANIMATIONS, pickEmployeeSkin } from './aifred-resources.js'

const $ = id => document.getElementById(id)
const canvas = $('canvas'), ctx = canvas.getContext('2d'), wrap = $('canvas-wrap')
// selection 是选中对象的 id 列表，最后一项是「主选中」（属性面板展示它）；空数组表示未选中
let map = makeMap(), history = new History(map), selection = [], tool = 'select', category = '全部', placement = null
let camera = { x: 0, y: 0, scale: 0.5 }, viewport = { width: 1, height: 1 }, gesture = null, polygon = [], hover = null, space = false, preview = false
let pathStart = null, pathEnd = null, path = null, dirty = false, saveTimer, toastTimer, pathRequest = 0
let draftQueue = Promise.resolve(), revision = 0, savedRevision = 0
const images = new Map(), pendingImages = new Map(), failedImages = new Set()
const zoneColors = { 'walk-blocked': '#ec777d', 'employee-no-entry': '#e7b264', spawn: '#70bba4' }
/** 活动点标记配色（按类型），同时用于地图上的标记与属性面板 */
const spotColors = { pantry: '#d9a441', restroom: '#5aa9e6', meeting: '#8b7fd4', corridor: '#57b894', custom: '#b0b7c0' }
const ROOM_TYPES = { meeting: '会议室', pantry: '茶水间', restroom: '厕所', work: '工位区', lounge: '休息区' }
const navigationWorker = new Worker(new URL('./navigation-worker.js', import.meta.url), { type: 'module' })
navigationWorker.onmessage = event => {
  if (event.data.requestId !== pathRequest) return
  path = event.data.path
  toast(event.data.error || (path ? `路径可达 · ${path.length} 个路径点` : '无法到达：起终点在禁区、通道过窄，或被障碍隔断'))
  draw()
}
navigationWorker.onerror = () => toast('路径验证器加载失败，请刷新页面后重试')
const setHTML = (el, str) => {
  const parsed = new DOMParser().parseFromString(str, 'text/html')
  el.replaceChildren(...parsed.body.childNodes)
}

const styleStore = Object.create(null)

let employeeRuntime = null, employeeLoading = null, employeeFailed = false
function updateEmployees() {
  if (map.seats?.some(s => s.employee)) syncSeats(map)
  const visibleSeats = (map.seats || []).filter(s => s.employee?.enabled && map.elements.some(e => e.id === s.deskElementId && e.visible))
  if (!employeeRuntime && visibleSeats.length && !employeeLoading && !employeeFailed) {
    $('employee-status').textContent = '员工角色加载中…'
    employeeLoading = import(new URL('../assets/runtime/employees.js', import.meta.url).href).then(module => module.createEmployeeRuntime(draw)).then(runtime => { employeeRuntime = runtime; draw() }).catch(error => {
      employeeFailed = true; $('employee-status').textContent = '员工动画不可用'; $('employee-status').dataset.state = 'failed'
      toast(`员工动画加载失败：${error.message}。请先运行 npm install 和 npm run build:employees，其他编辑功能仍可使用。`)
    }).finally(() => { employeeLoading = null })
  }
  if (employeeRuntime) {
    employeeRuntime.sync(visibleSeats); employeeRuntime.pause(!$('animate-employees').checked)
    const stats = employeeRuntime.stats
    $('employee-status').textContent = `AIFred员工 ${stats.count}${visibleSeats.length > stats.limit ? ` / ${visibleSeats.length}（预览上限${stats.limit}）` : ''}`
    Object.assign($('employee-status').dataset, { state: 'ready', count: stats.count, frames: stats.frames, animations: JSON.stringify(stats.animations) })
  }
}
let catalog = []
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const number = (value, min, max) => Math.min(max, Math.max(min, Number(value)))
const itemById = id => map.elements.find(e => e.id === id) ?? map.zones.find(z => z.id === id) ?? map.spots?.find(s => s.id === id) ?? null
const selectedItems = () => selection.map(itemById).filter(Boolean)
const selected = () => selectedItems().at(-1) ?? null
/** 设置选中集合（自动去重、剔除已不存在的 id），不负责重绘 */
const select = ids => { selection = [...new Set(ids.filter(id => itemById(id)))] }
const isZone = item => item && Array.isArray(item.points)
const isSpot = item => !!item && !!map.spots?.includes(item)
function shapeOf(item) {
  if (isZone(item)) return item.points
  return isSpot(item) ? null : elementPolygon(item)
}
function accentOf(item) {
  if (isSpot(item)) return spotColors[item.kind] ?? spotColors.custom
  return isZone(item) ? zoneColors[item.type] : '#acb4bd'
}
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true }, 5000) }
function loadImage(src) {
  if (images.has(src)) return Promise.resolve(images.get(src))
  if (pendingImages.has(src)) return pendingImages.get(src)
  const pending = new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => { images.set(src, image); pendingImages.delete(src); draw(); resolve(image) }
    image.onerror = () => { pendingImages.delete(src); failedImages.add(src); draw(); reject(new Error('图片加载失败，请检查素材路径')) }
    image.src = src
  })
  pendingImages.set(src, pending)
  return pending
}
function requestImage(src) { if (!images.has(src) && !failedImages.has(src)) loadImage(src).catch(() => toast('部分图片加载失败，画布已标记；请重新上传或修正配置中的素材路径。')) }
function preload() { if (map.background) requestImage(map.background.src); map.assets.forEach(a => requestImage(a.src)) }

const dbPromise = new Promise((resolve, reject) => {
  const request = indexedDB.open('office-map-studio', 1)
  request.onupgradeneeded = () => request.result.createObjectStore('drafts')
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(new Error('浏览器草稿存储不可用'))
})
dbPromise.catch(() => {})
async function saveDraft(snapshot) {
  const db = await dbPromise
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', 'readwrite')
    tx.objectStore('drafts').put(snapshot, 'current')
    tx.oncomplete = resolve
    tx.onabort = tx.onerror = () => reject(new Error('草稿保存失败，请导出 JSON 备份'))
  })
}
function autosave() {
  const version = revision, snapshot = clone(map)
  $('save-status').textContent = '正在保存草稿…'
  draftQueue = draftQueue.catch(() => {}).then(() => saveDraft(snapshot)).then(() => {
    savedRevision = Math.max(savedRevision, version)
    if (version === revision) { dirty = false; $('save-status').textContent = '草稿已保存到本机' }
  }).catch(error => { $('save-status').textContent = '草稿未保存'; toast(error.message) })
}
function commit() {
  syncSeats(map); validateMap(map)
  history.push(map); revision++; dirty = true; path = null; pathStart = null; pathEnd = null; pathRequest++
  clearTimeout(saveTimer); saveTimer = setTimeout(autosave, 350)
  renderPanels(); draw()
}
function fit() { camera.scale = Math.min((viewport.width - 90) / map.width, (viewport.height - 70) / map.height); camera.scale = Math.max(0.035, camera.scale); camera.x = (viewport.width - map.width * camera.scale) / 2; camera.y = (viewport.height - map.height * camera.scale) / 2; draw() }
function zoom(factor, pivot = { x: viewport.width / 2, y: viewport.height / 2 }) {
  const world = { x: (pivot.x - camera.x) / camera.scale, y: (pivot.y - camera.y) / camera.scale }
  camera.scale = Math.max(0.035, Math.min(5, camera.scale * factor)); camera.x = pivot.x - world.x * camera.scale; camera.y = pivot.y - world.y * camera.scale; draw()
}
function position(event, snap = false) {
  const bounds = canvas.getBoundingClientRect()
  let x = (event.clientX - bounds.left - camera.x) / camera.scale, y = (event.clientY - bounds.top - camera.y) / camera.scale
  if (snap && $('snap').checked) { x = Math.round(x / map.gridSize) * map.gridSize; y = Math.round(y / map.gridSize) * map.gridSize }
  return { x: Math.max(0, Math.min(map.width, x)), y: Math.max(0, Math.min(map.height, y)) }
}
function polyPath(points) { ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath() }
function strokePoints(points, color, fill, dashed = false) {
  if (!points.length) return
  polyPath(points); if (fill) { ctx.fillStyle = fill; ctx.fill() }
  ctx.strokeStyle = color; ctx.lineWidth = 1.5 / camera.scale; ctx.setLineDash(dashed ? [6 / camera.scale, 4 / camera.scale] : []); ctx.stroke(); ctx.setLineDash([])
}
function drawScreenOverlay(ctx, seat, element) {
  // 屏幕区域来自元素自身的 screen 元数据（如 computer-top 图元），与图元图片分离，便于独立摆放到桌面右侧
  const screen = element.screen
  if (!screen) return
  const asset = map.assets.find(a => a.id === element.assetId)
  const baseW = asset?.width || element.width, baseH = asset?.height || element.height
  const kx = element.width / baseW, ky = element.height / baseH

  // drawElement 已经平移/旋转到元素坐标，这里不再重复变换
  ctx.save()
  ctx.globalAlpha = element.opacity

  const scale = kx
  const sw = screen.width * kx, sh = screen.height * ky
  const sx = -element.width / 2 + (screen.x + screen.width / 2) * kx
  const sy = -element.height / 2 + (screen.y + screen.height / 2) * ky

  // 1. 屏幕外框（仅覆盖显示器本身，不遮员工）
  ctx.fillStyle = '#0f172a'
  ctx.fillRect(sx - sw / 2, sy - sh / 2, sw, sh)

  // 2. 屏幕显示内容区（带轻微内边距和工作代码/图表/状态模拟）
  const iw = sw * 0.93, ih = sh * 0.86
  const gradient = ctx.createLinearGradient(sx - iw / 2, sy - ih / 2, sx + iw / 2, sy + ih / 2)
  gradient.addColorStop(0, '#1e293b')
  gradient.addColorStop(1, '#0f172a')
  ctx.fillStyle = gradient
  ctx.fillRect(sx - iw / 2, sy - ih / 2, iw, ih)

  // 3. 屏幕内容可视化（代码流/数据状态，发光青蓝或翠绿色）
  let stateColor = '#4ade80'
  if (seat.employee?.animation === 'thinking') {
    stateColor = '#38bdf8'
  } else if (seat.employee?.animation === 'talking') {
    stateColor = '#fbbf24'
  }
  const line = Math.max(0.8, ih * 0.1)
  ctx.fillStyle = stateColor
  // 屏幕顶部状态条
  ctx.fillRect(sx - iw / 2 + iw * 0.04, sy - ih / 2 + ih * 0.06, iw * 0.92, line * 0.7)

  // 屏幕上的工作内容模拟线（代码行/图表条）
  ctx.fillStyle = '#38bdf8'
  ctx.fillRect(sx - iw / 2 + iw * 0.06, sy - ih / 2 + ih * 0.28, iw * 0.6, line * 0.55)
  ctx.fillRect(sx - iw / 2 + iw * 0.06, sy - ih / 2 + ih * 0.45, iw * 0.75, line * 0.55)
  ctx.fillStyle = '#94a3b8'
  ctx.fillRect(sx - iw / 2 + iw * 0.06, sy - ih / 2 + ih * 0.62, iw * 0.45, line * 0.45)
  ctx.fillRect(sx - iw / 2 + iw * 0.06, sy - ih / 2 + ih * 0.78, iw * 0.55, line * 0.45)

  // 屏幕右侧迷你状态指示灯/图表块
  ctx.fillStyle = stateColor
  ctx.fillRect(sx + iw / 2 - iw * 0.14, sy - ih / 2 + ih * 0.28, iw * 0.08, ih * 0.4)

  // 4. 屏幕发光边框
  ctx.strokeStyle = '#38bdf866'
  ctx.lineWidth = Math.max(0.5, 1 * scale)
  ctx.strokeRect(sx - sw / 2, sy - sh / 2, sw, sh)

  ctx.restore()
}

function drawElement(e) {
  if (!e.visible) return
  ctx.save(); ctx.translate(e.x, e.y); ctx.rotate(e.rotation * Math.PI / 180); ctx.globalAlpha = e.opacity
  if (e.kind === 'rect') { ctx.fillStyle = e.color; ctx.fillRect(-e.width / 2, -e.height / 2, e.width, e.height) }
  else {
    const asset = map.assets.find(a => a.id === e.assetId), image = asset && images.get(asset.src)
    if (image && asset.tileable) {
      ctx.save(); ctx.translate(-e.width / 2, -e.height / 2)
      ctx.fillStyle = ctx.createPattern(image, 'repeat'); ctx.fillRect(0, 0, e.width, e.height)
      ctx.restore()
    } else if (image) ctx.drawImage(image, -e.width / 2, -e.height / 2, e.width, e.height)
    else { ctx.fillStyle = '#75474c'; ctx.fillRect(-e.width / 2, -e.height / 2, e.width, e.height); ctx.fillStyle = '#ffffff'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('素材待加载', 0, 0) }
  }
  if (e.screen) drawScreenOverlay(ctx, map.seats?.find(s => s.computerElementId === e.id), e)
  ctx.restore()
}
function draw() {
  updateEmployees()
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, viewport.width, viewport.height)
  ctx.save(); ctx.translate(camera.x, camera.y); ctx.scale(camera.scale, camera.scale)
  ctx.fillStyle = map.backgroundColor; ctx.fillRect(0, 0, map.width, map.height)
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, map.width, map.height); ctx.clip()
  if (map.background?.visible && images.has(map.background.src)) { ctx.globalAlpha = map.background.opacity; ctx.drawImage(images.get(map.background.src), 0, 0, map.width, map.height); ctx.globalAlpha = 1 }
  const renderItems = map.elements.map(e => ({ element: e, z: e.zIndex }))
  for (const seat of map.seats || []) {
    const desk = map.elements.find(e => e.id === seat.deskElementId)
    if (desk?.visible && seat.employee?.enabled) renderItems.push({ employee: seat, element: desk, z: desk.zIndex + 2 })
  }
  for (const entry of renderItems.sort((a, b) => a.z - b.z)) {
    if (entry.employee) employeeRuntime?.draw(ctx, entry.employee, entry.element)
    else drawElement(entry.element)
  }
  ctx.textAlign = 'left'; ctx.fillStyle = '#35423e'; ctx.font = `600 ${Math.max(18, 11 / camera.scale)}px sans-serif`
  for (const room of map.rooms || []) ctx.fillText(`${room.name}${room.type === 'meeting' || room.type === 'work' ? ` · ${room.capacity} 人` : ''}`, room.bounds.x + 16, room.bounds.y + 30)
  // 房间「使用中」标记：占用中的房间不允许作为自由活动目的地
  for (const room of map.rooms || []) {
    if (!room.occupied) continue
    const text = '使用中'
    ctx.font = `700 ${Math.max(13, 10 / camera.scale)}px sans-serif`
    const w = ctx.measureText(text).width + 16 / camera.scale, h = 21 / camera.scale
    const x = room.bounds.x + room.bounds.width - w - 12 / camera.scale, y = room.bounds.y + 12 / camera.scale
    ctx.fillStyle = '#d94f4f'; ctx.fillRect(x, y, w, h)
    ctx.fillStyle = '#ffffff'; ctx.fillText(text, x + 8 / camera.scale, y + h * 0.74)
  }
  // 自由活动目的地锚点
  for (const spot of map.spots || []) {
    const room = spot.roomId ? map.rooms?.find(r => r.id === spot.roomId) : null
    const usable = spot.enabled !== false && !room?.occupied
    ctx.globalAlpha = usable ? 1 : 0.35
    const color = spotColors[spot.kind] ?? spotColors.custom
    const radius = Math.max(6, 5 / camera.scale)
    ctx.beginPath(); ctx.arc(spot.x, spot.y, radius, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 2 / camera.scale; ctx.strokeStyle = '#fff'; ctx.stroke()
    ctx.beginPath(); ctx.arc(spot.x, spot.y, radius * 2.1, 0, Math.PI * 2); ctx.strokeStyle = color + 'aa'; ctx.lineWidth = 1.2 / camera.scale; ctx.stroke()
    if (!preview) {
      ctx.textAlign = 'center'; ctx.font = `${Math.max(11, 9 / camera.scale)}px sans-serif`
      const label = usable ? spot.name : `${spot.name}${spot.enabled === false ? '（已禁用）' : '（使用中）'}`
      const w = ctx.measureText(label).width + 10 / camera.scale, top = spot.y + radius * 2.4
      ctx.fillStyle = '#ffffffe6'; ctx.fillRect(spot.x - w / 2, top, w, 17 / camera.scale)
      ctx.fillStyle = '#35423e'; ctx.fillText(label, spot.x, top + 12.5 / camera.scale)
    }
    ctx.globalAlpha = 1
  }
  ctx.textAlign = 'center'; ctx.font = `${Math.max(12, 9 / camera.scale)}px sans-serif`
  for (const e of map.elements) if (e.visible && e.label) {
    const seat = map.seats?.find(s => s.deskElementId === e.id && s.employee?.enabled)
    const label = seat ? `${e.label} · ${seat.employee.name}` : e.label
    const x = seat?.x ?? e.x, y = seat ? seat.y - 118 * e.width / 144 : e.y
    const w = ctx.measureText(label).width + 10; ctx.fillStyle = '#ffffffe0'; ctx.fillRect(x - w / 2, y - 9, w, 18); ctx.fillStyle = '#35423e'; ctx.fillText(label, x, y + 4)
  }
  if (!preview && $('footprints').checked) for (const e of map.elements.filter(e => e.visible && e.blocksMovement)) for (const points of elementFootprints(e)) strokePoints(points, '#2b8c66', '#2b8c6610', true)
  if ($('grid').checked && !preview && map.gridSize * camera.scale >= 6) {
    ctx.beginPath(); for (let x = 0; x <= map.width; x += map.gridSize) { ctx.moveTo(x, 0); ctx.lineTo(x, map.height) } for (let y = 0; y <= map.height; y += map.gridSize) { ctx.moveTo(0, y); ctx.lineTo(map.width, y) }
    ctx.strokeStyle = '#202a342c'; ctx.lineWidth = 0.6 / camera.scale; ctx.stroke()
  }
  if (!preview) for (const zone of map.zones.filter(z => z.visible)) {
    const color = zoneColors[zone.type]; ctx.globalAlpha = zone.enabled ? 1 : 0.35
    strokePoints(zone.points, color, color + '32', !zone.enabled)
    ctx.font = `${11 / camera.scale}px sans-serif`; ctx.fillStyle = '#172026'; ctx.textAlign = 'left'
    const p = zone.points[0], width = ctx.measureText(zone.name).width + 12 / camera.scale
    ctx.fillStyle = color; ctx.fillRect(p.x, p.y, width, 21 / camera.scale); ctx.fillStyle = '#172026'; ctx.fillText(zone.name, p.x + 6 / camera.scale, p.y + 14 / camera.scale)
  }
  ctx.globalAlpha = 1
  if (!preview) {
    const items = selectedItems(), primary = selected()
    for (const item of items) {
      const points = shapeOf(item)
      if (isSpot(item)) { ctx.beginPath(); ctx.arc(item.x, item.y, 14 / camera.scale, 0, Math.PI * 2); ctx.strokeStyle = '#ffe0a0'; ctx.lineWidth = 2 / camera.scale; ctx.stroke() }
      else strokePoints(points, item.locked ? '#9aa3ad' : '#ffe0a0', null, item.locked)
    }
    // 多选时额外画一个整体包围框，提示拖动会一起移动
    if (items.length > 1) {
      const ranges = groupRanges(items), pad = 6 / camera.scale
      const x = Math.min(...ranges.map(r => r.loX)) - pad, y = Math.min(...ranges.map(r => r.loY)) - pad
      const w = Math.max(...ranges.map(r => r.hiX)) + pad - x, h = Math.max(...ranges.map(r => r.hiY)) + pad - y
      ctx.save(); ctx.setLineDash([8 / camera.scale, 5 / camera.scale]); ctx.strokeStyle = '#8ab4f8'; ctx.lineWidth = 1.2 / camera.scale
      ctx.strokeRect(x, y, w, h); ctx.restore()
    }
    // 只有单选时才提供角点缩放 / 顶点编辑把手，避免批量拖拽时误改尺寸
    if (items.length === 1 && primary && !primary.locked && !isSpot(primary)) for (const p of shapeOf(primary)) { const size = 7 / camera.scale; ctx.fillStyle = '#24292f'; ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size); ctx.strokeStyle = '#ffe0a0'; ctx.lineWidth = 1 / camera.scale; ctx.strokeRect(p.x - size / 2, p.y - size / 2, size, size) }
  }
  if (polygon.length) {
    strokePoints([...polygon, ...(hover ? [hover] : [])], zoneColors[$('zone-type').value], '#e7b26420', true)
    for (const p of polygon) { ctx.beginPath(); ctx.arc(p.x, p.y, 4 / camera.scale, 0, Math.PI * 2); ctx.fillStyle = '#ffe0a0'; ctx.fill() }
  }
  if (gesture?.type === 'rect') strokePoints(rectPoints(gesture.start, gesture.end), zoneColors[$('zone-type').value], '#e7b26425', true)
  if (gesture?.type === 'marquee') {
    const rect = normalizeRect(gesture.start, gesture.end)
    const previewed = itemsInRect(rect)
    for (const item of previewed) if (!gesture.base.includes(item.id)) strokePoints(shapeOf(item) ?? [], '#8ab4f8', null, true)
    ctx.save(); ctx.fillStyle = '#8ab4f822'; ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
    ctx.strokeStyle = '#8ab4f8'; ctx.lineWidth = 1.2 / camera.scale; ctx.setLineDash([6 / camera.scale, 4 / camera.scale])
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height); ctx.restore()
  }
  if (placement && hover && !preview) {
    const candidate = makeElement(placement.name, placement.kind, hover.x, hover.y, templateOptions(placement))
    const p = $('snap').checked ? snapToConnectors(candidate, map.elements, 12 / camera.scale) : hover
    ctx.save()
    ctx.globalAlpha = 0.65
    const img = placement.src && images.get(placement.src)
    if (img) {
      ctx.drawImage(img, p.x - placement.width / 2, p.y - placement.height / 2, placement.width, placement.height)
    } else {
      ctx.fillStyle = placement.color || '#e5bc73'
      ctx.fillRect(p.x - placement.width / 2, p.y - placement.height / 2, placement.width, placement.height)
    }
    ctx.strokeStyle = '#0284c7'
    ctx.lineWidth = 1.5 / camera.scale
    ctx.strokeRect(p.x - placement.width / 2, p.y - placement.height / 2, placement.width, placement.height)
    ctx.restore()
  }
  if (path) { ctx.beginPath(); path.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.strokeStyle = '#46d3ac'; ctx.lineWidth = 3 / camera.scale; ctx.stroke() }
  for (const [p, label, color] of [[pathStart, '起', '#46d3ac'], [pathEnd, '终', '#f1c67b']]) if (p) {
    ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(9 / camera.scale, Number($('agent-radius').value)), 0, Math.PI * 2); ctx.fillStyle = color + '66'; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 2 / camera.scale; ctx.stroke(); ctx.font = `${11 / camera.scale}px sans-serif`; ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.fillText(label, p.x, p.y + 4 / camera.scale)
  }
  ctx.restore(); ctx.strokeStyle = '#6d747d'; ctx.lineWidth = 1 / camera.scale; ctx.strokeRect(0, 0, map.width, map.height); ctx.restore()
  $('zoom-label').textContent = `${Math.round(camera.scale * 100)}%`
  $('object-count').textContent = `${map.width} × ${map.height} px · ${map.elements.length} 个元素 · ${map.zones.length} 个区域 · ${map.spots?.length ?? 0} 个活动点`
  $('selection-status').textContent = selection.length ? `已选 ${selection.length} 个对象` : ''
}

function switchStyle(styleId) {
  if (!styleStore[styleId]) return
  const conf = styleStore[styleId]
  setTool('select')
  catalog = [...conf.items, ...AIFRED_TEMPLATES]
  if ($('style-select')) $('style-select').value = styleId
  if ($('style-desc')) $('style-desc').textContent = conf.desc
  if ($('hint-desc')) $('hint-desc').textContent = conf.hint
  category = '全部'
  renderLibrary()
}

function renderLibrary() {
  const custom = map.assets.filter(a => a.category === '自定义').map(a => ({ ...a, kind: 'image', width: a.width || 100, height: a.height || 100 }))
  const allItems = [...catalog, ...custom]
  const uniqueCategories = ['全部', ...new Set(allItems.map(a => a.category).filter(Boolean))]
  if (!uniqueCategories.includes(category)) category = '全部'

  $('categories').replaceChildren(...uniqueCategories.map(c => {
    const button = document.createElement('button'); button.textContent = c; button.dataset.category = c
    button.classList.toggle('active', category === c); button.onclick = () => { category = c; renderLibrary() }
    return button
  }))
  const query = $('asset-search').value.trim().toLowerCase()
  const items = allItems.filter(a => (category === '全部' || a.category === category) && a.name.toLowerCase().includes(query))
  $('asset-list').replaceChildren(...items.map(a => {
    const button = document.createElement('button'); button.className = 'asset-item'; button.classList.toggle('active', placement?.id === a.id)
    button.dataset.asset = a.id; button.title = `${a.name}：点击后在画布放置`
    const preview = document.createElement('div'); preview.className = 'asset-preview'
    if (a.src) { const img = document.createElement('img'); img.src = a.src; img.alt = a.name; img.loading = 'lazy'; preview.append(img) }
    else { const swatch = document.createElement('div'); swatch.className = 'shape-swatch'; swatch.style.backgroundColor = a.color; preview.append(swatch) }
    const name = document.createElement('span'); name.textContent = a.name
    const hint = document.createElement('small'); hint.textContent = '图像素材'
    if (a.category === '原图样板') hint.textContent = '原图裁切 · 带背景'
    else if (a.tileable) hint.textContent = '连续平铺地面'
    else if (a.geometry || a.footprints) hint.textContent = '俯视图元 · 独立占地'
    else if (a.kind === 'rect') hint.textContent = '可调尺寸与颜色'
    button.append(preview, name, hint)
    button.onclick = () => { placement = a; if (a.src) requestImage(a.src); setTool('place'); renderLibrary() }
    return button
  }))
  if (!items.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '当前风格下没有匹配素材，可切换风格或上传自定义图片。'; $('asset-list').append(empty) }
}
function showPanel(panel) {
  document.querySelectorAll('[data-panel]').forEach(b => b.classList.toggle('active', b.dataset.panel === panel))
  for (const name of ['properties', 'layers', 'map']) $(`${name}-panel`).hidden = name !== panel
  document.querySelector('.workspace').classList.add('show-inspector')
}
function setTool(next) {
  if (gesture) cancelGesture()
  tool = next; polygon = []; if (next !== 'place') placement = null
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool))
  const hints = { select: '单击选择 · ⇧/⌘ 点击加选或减选 · 空白处拖动框选 · 拖动任意选中项整体移动 · ⌘ A 全选', pan: '拖动画布平移 · 滚轮缩放', rect: '按住拖动绘制区域 · 在上方选择区域类型', polygon: '逐点绘制 · 点击首点或 Enter 完成 · Esc 取消', path: '依次点击起点与终点，检查禁区是否阻断通路', place: `点击放置「${placement?.name}」 · Esc 返回选择`, spot: '点击放置自由活动目的地锚点 · 已放好的锚点可直接拖动 · Esc 返回选择' }
  // 状态栏一行放不下长提示，只保留最常用的几个动作
  const briefs = { select: '选择 · ⇧/⌘ 加选 · 拖动框选' }
  const crosshair = ['rect', 'polygon', 'path', 'place', 'spot'].includes(next)
  $('canvas-hint').textContent = hints[tool]; $('mode-label').textContent = briefs[tool] ?? hints[tool]
  canvas.style.cursor = next === 'pan' ? 'grab' : crosshair ? 'crosshair' : 'default'; draw()
}
/** 批量选择属性面板：列出选中项，提供复制/删除/锁定，单个元素仍可点开单独编辑 */
function renderMultiProperties() {
  const items = selectedItems(), locked = items.filter(item => item.locked).length
  const kindLabel = item => {
    if (isSpot(item)) return '活动点'
    return isZone(item) ? '区域' : '元素'
  }
  const rows = items.slice(0, 80).map(item => `<div class="manage-row"><span class="legend" style="background:${accentOf(item)}"></span><button class="layer-name" data-multi-select="${escape(item.id)}" title="只选中这一个">${escape(item.name)}</button><span class="manage-meta">${kindLabel(item)}${item.locked ? ' · 锁定' : ''}</span></div>`).join('')
  setHTML($('properties-panel'), `<div class="selection-title"><h2>已选 ${items.length} 个对象</h2><span>批量编辑</span></div>
    <p class="muted">拖动任意一个选中对象即可整体移动；方向键微调，按住 ⇧ 按网格步进。只框选到对象被矩形碰到的一部分也会选中。</p>
    ${locked ? `<p class="muted">其中 ${locked} 个为锁定对象，不会被拖动，也不会被框选带走。</p>` : ''}
    <div class="button-row"><button id="duplicate">复制</button><button id="delete" class="danger">删除</button></div>
    <div class="button-row"><button id="lock-selection">锁定所选</button><button id="unlock-selection">解锁所选</button></div>
    <h3>选中清单 · ${items.length}</h3><div class="manage-list">${rows}${items.length > 80 ? '<p class="muted">仅列出前 80 个。</p>' : ''}</div>
    <button id="clear-selection" class="full-button">取消选择</button>`)
  $('duplicate').onclick = duplicate; $('delete').onclick = removeSelected
  $('lock-selection').onclick = () => setLocked(true); $('unlock-selection').onclick = () => setLocked(false)
  $('clear-selection').onclick = () => { select([]); renderPanels(); draw() }
  $('properties-panel').querySelectorAll('[data-multi-select]').forEach(b => b.onclick = () => { select([b.dataset.multiSelect]); renderPanels(); draw() })
}
/** 全选：只选画布上可选中（可见且未锁定）的对象 */
function selectAll() {
  select([...(map.spots || []), ...map.zones, ...map.elements].filter(canSelect).map(item => item.id))
  renderPanels(); draw()
  toast(selection.length ? `已选中 ${selection.length} 个对象` : '没有可全选的对象（都被隐藏或锁定）')
}
/** 批量设置锁定状态；锁定后对象在画布上不可选中 */
function setLocked(locked) {
  const items = selectedItems()
  if (!items.length) return
  const before = clone(map)
  for (const item of items) item.locked = locked
  try { validateMap(map); commit(); toast(locked ? `已锁定 ${items.length} 个对象，画布上不再可选中` : `已解锁 ${items.length} 个对象`) } catch (error) { map = before; renderPanels(); draw(); toast(error.message) }
}
function field(label, key, value, type = 'number', extra = '') { return `<label>${label}<input data-field="${key}" type="${type}" value="${escape(value)}" ${extra}></label>` }
function renderProperties() {
  if (selection.length > 1) { renderMultiProperties(); return }
  const item = selected()
  if (item && isSpot(item)) { renderSpotProperties(item); return }
  if (!item) {
    setHTML($('properties-panel'), '<div class="empty-selection"><h3>让办公室按你的方式生长</h3><p class="muted">选择画布上的元素或区域，编辑位置、尺寸、外观和通行规则。</p><div class="shortcut-list"><p>选择 / 平移 <kbd>V / H</kbd></p><p>加选 / 减选 <kbd>⇧ 或 ⌘ 点击</kbd></p><p>框选多个 <kbd>空白处拖动</kbd></p><p>全选 <kbd>⌘ A</kbd></p><p>矩形 / 多边形 <kbd>R / P</kbd></p><p>验证行走路径 <kbd>T</kbd></p><p>复制 / 删除 <kbd>⌘ D / Delete</kbd></p><p>撤销 / 重做 <kbd>⌘ Z / ⇧ ⌘ Z</kbd></p><p>导出配置 <kbd>⌘ S</kbd></p></div><p class="muted">员工禁入区限制员工进入；行走禁区阻止所有移动路径穿越。隐藏图层不会停用通行规则；锁定对象在画布上不可选中。</p></div>')
    return
  }
  const zone = isZone(item)
  setHTML($('properties-panel'), `<div class="selection-title"><h2>${zone ? '区域属性' : '元素属性'}</h2><span>${zone ? zoneLabels[item.type] : item.kind === 'image' ? '图像' : '基础形状'}</span></div>${field('名称', 'name', item.name, 'text', 'maxlength="120"')}
    ${zone ? `<label>区域规则<select data-field="type">${Object.entries(zoneLabels).map(([key, name]) => `<option value="${key}" ${item.type === key ? 'selected' : ''}>${name}</option>`).join('')}</select></label><p class="muted">拖动角点调整边界，拖动内部移动整个区域。出生区用于标记候选出生范围，不会覆盖禁区规则。</p><label style="margin-top:14px">顶点坐标 / px<textarea id="zone-points" spellcheck="false">${escape(JSON.stringify(item.points.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })), null, 2))}</textarea></label><button id="apply-points" class="full-button">应用顶点坐标</button>` : `<div class="field-pair">${field('中心 X', 'x', Math.round(item.x), 'number', `min="0" max="${map.width}"`)}${field('中心 Y', 'y', Math.round(item.y), 'number', `min="0" max="${map.height}"`)}</div><div class="field-pair">${field('宽度', 'width', Math.round(item.width), 'number', `min="1" max="8192" ${item.geometry?.stretchAxis === 'y' ? 'disabled' : ''}`)}${field('高度', 'height', Math.round(item.height), 'number', `min="1" max="8192" ${item.geometry?.stretchAxis === 'x' ? 'disabled' : ''}`)}</div><div class="field-pair">${field('旋转 / °', 'rotation', item.rotation, 'number', 'min="-360" max="360"')}${field('图层顺序', 'zIndex', item.zIndex, 'number', 'min="-10000" max="10000"')}</div>${field('透明度', 'opacity', item.opacity, 'number', 'min="0" max="1" step="0.05"')}${item.kind === 'rect' ? field('填充颜色', 'color', item.color, 'color') : '<p class="muted">旋转仅调整画面方向，不会生成物件的其他视角。</p>'}`}
    <h3>行为与状态</h3><label class="check-label"><input data-field="${zone ? 'enabled' : 'blocksMovement'}" type="checkbox" ${item[zone ? 'enabled' : 'blocksMovement'] ? 'checked' : ''}>${zone ? '启用区域规则' : item.geometry ? `作为行走障碍（${item.geometry.footprints?.length || 1} 块地面占地）` : '作为行走障碍（按旋转后的矩形占地）'}</label>
    <label class="check-label"><input data-field="visible" type="checkbox" ${item.visible ? 'checked' : ''}>显示图层</label><label class="check-label"><input data-field="locked" type="checkbox" ${item.locked ? 'checked' : ''}>锁定（画布不可选中）</label>${item.locked ? '<p class="muted">已锁定：画布上无法点选、框选或拖动。取消勾选即可解锁。</p>' : ''}
    <div class="button-row"><button id="duplicate">复制</button><button id="delete" class="danger">删除</button></div><div class="selection-id">ID ${escape(item.id)}</div>`)
  $('properties-panel').querySelectorAll('[data-field]').forEach(input => {
    if (item.locked && input.dataset.field !== 'locked' && input.dataset.field !== 'visible') input.disabled = true
    input.onchange = () => {
      const key = input.dataset.field, value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value
      const before = clone(item); item[key] = value
      try { validateMap(map); commit() } catch (error) { Object.assign(item, before); syncSeats(map); renderProperties(); toast(error.message) }
    }
  })
  if (zone) {
    $('zone-points').disabled = item.locked; $('apply-points').disabled = item.locked
    $('apply-points').onclick = () => { const before = clone(item.points); try { item.points = JSON.parse($('zone-points').value); validateMap(map); commit() } catch (error) { item.points = before; toast(`顶点无效：${error.message}`) } }
  }
  $('duplicate').onclick = duplicate; $('delete').onclick = removeSelected
  if (!zone) renderEmployeeProperties(item)
}
/** 活动点（自由活动目的地锚点）属性面板 */
function renderSpotProperties(item) {
  const room = item.roomId ? map.rooms?.find(r => r.id === item.roomId) : null
  const options = (values, chosen) => Object.entries(values).map(([value, label]) => `<option value="${escape(value)}" ${value === chosen ? 'selected' : ''}>${escape(label)}</option>`).join('')
  setHTML($('properties-panel'), `<div class="selection-title"><h2>活动点属性</h2><span>${SPOT_KINDS[item.kind] ?? '自定义'}</span></div>
    <label>名称<input data-spot="name" type="text" value="${escape(item.name)}" maxlength="120"></label>
    <label>类型<select data-spot="kind">${options(SPOT_KINDS, item.kind)}</select></label>
    <div class="field-pair"><label>坐标 X<input data-spot="x" type="number" value="${Math.round(item.x)}" min="0" max="${map.width}"></label><label>坐标 Y<input data-spot="y" type="number" value="${Math.round(item.y)}" min="0" max="${map.height}"></label></div>
    <div class="field-pair"><label>步速 / px·s⁻¹<input data-spot="speed" type="number" value="${spotSpeed(item)}" min="5" max="300"></label><label>停留 / 秒<input data-spot="stay" type="number" value="${item.stay ?? SPOT_STAY}" min="0" max="600"></label></div>
    <label>绑定房间<select data-spot="roomId"><option value="">不绑定</option>${(map.rooms || []).map(r => `<option value="${escape(r.id)}" ${item.roomId === r.id ? 'selected' : ''}>${escape(r.name)}</option>`).join('')}</select></label>
    <label class="check-label"><input data-spot="enabled" type="checkbox" ${item.enabled ? 'checked' : ''}>启用（员工可以来这里自由活动）</label>
    ${room ? `<label class="check-label"><input id="spot-room-occupied" type="checkbox" ${room.occupied ? 'checked' : ''}>房间正在使用（使用中时员工不会进入）</label>` : ''}
    <p class="muted">踱步目的地：闲置员工每隔 30 秒左右会挑一个启用的活动点走过去，停留后返回工位。步速按目的地区分：厕所 &gt; 茶水间 &gt; 会议室 &gt; 过道。拖动标记可直接改位置。</p>
    <div class="button-row"><button id="duplicate">复制</button><button id="delete" class="danger">删除</button></div><div class="selection-id">ID ${escape(item.id)}</div>`)
  for (const input of $('properties-panel').querySelectorAll('[data-spot]')) input.onchange = () => {
    const key = input.dataset.spot, before = clone(item)
    const value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value
    if (key === 'roomId') { if (value) item.roomId = value; else delete item.roomId } else item[key] = value
    try { validateMap(map); commit(); renderPanels() } catch (error) { Object.assign(item, before); renderProperties(); toast(error.message) }
  }
  const occupied = $('spot-room-occupied')
  if (occupied) occupied.onchange = () => {
    const before = clone(room); room.occupied = occupied.checked
    try { validateMap(map); commit(); renderPanels(); toast(room.occupied ? `${room.name} 已标记使用中，员工自由活动不会进入` : `${room.name} 已恢复空闲`) } catch (error) { Object.assign(room, before); renderPanels(); toast(error.message) }
  }
  $('duplicate').onclick = duplicate; $('delete').onclick = removeSelected
}

function renderEmployeeProperties(item) {
  const panel = $('properties-panel'), seat = map.seats?.find(s => s.deskElementId === item.id)
  const source = map.assets.find(a => a.id === item.assetId)?.src || ''
  if (!seat && !source.endsWith('desk-workstation-top.png') && !source.endsWith('aifred/office/desk.png')) return
  const section = document.createElement('div'); panel.append(section)
  if (!seat?.employee) {
    const button = document.createElement('button'); button.id = 'bind-employee'; button.className = 'full-button'; button.textContent = '绑定 AIFred 动画员工'; button.disabled = item.locked
    button.onclick = () => {
      map.schema = SCHEMA; map.seats ||= []
      const next = seat || { id: uid(), name: `工位${map.seats.length + 1}`, deskElementId: item.id, x: item.x, y: item.y, facing: 'back', seatOffset: { x: 0.18, y: 1.19 }, approachOffset: { x: 0.5, y: 1.7 } }
      next.employee = { resourceId: AIFRED_RESOURCE_ID, skin: pickEmployeeSkin(map.seats.length), animation: 'idle', enabled: true, name: `员工${map.seats.length + 1}` }
      if (!seat) map.seats.push(next)
      commit()
    }
    section.append(button); return
  }
  const options = (values, chosen) => Object.entries(values).map(([value, label]) => `<option value="${escape(value)}" ${value === chosen ? 'selected' : ''}>${escape(label)}</option>`).join('')
  setHTML(section, `<h3>AIFred 员工预览</h3><label>演示姓名<input id="employee-name" value="${escape(seat.employee.name)}" maxlength="60"></label><label>现有角色皮肤<select id="employee-skin">${options(Object.fromEntries(AIFRED_SKINS.map(s => [s, s])), seat.employee.skin)}</select></label><label>朝向<select id="employee-facing">${options({ front: '正面', back: '背面', left: '向左', right: '向右' }, seat.facing)}</select></label><label>动画<select id="employee-animation">${options(EMPLOYEE_ANIMATIONS, seat.employee.animation)}</select></label><label class="check-label"><input id="employee-enabled" type="checkbox" ${seat.employee.enabled ? 'checked' : ''}>显示员工</label><p class="muted">复用 AIFred 现有 Spine 角色，不连接真实账号。原地走动只是动画预览，不会改变位置。</p>`)
  for (const [id, key] of [['employee-name', 'name'], ['employee-skin', 'skin'], ['employee-facing', 'facing'], ['employee-animation', 'animation'], ['employee-enabled', 'enabled']]) {
    const input = $(id); input.disabled = item.locked
    input.onchange = () => {
      const before = clone(seat)
      if (key === 'facing') seat.facing = input.value
      else seat.employee[key] = input.type === 'checkbox' ? input.checked : input.value
      try { commit() } catch (error) { Object.assign(seat, before); renderPanels(); toast(error.message) }
    }
  }
}
function renderLayers() {
  const all = [...map.zones].reverse().concat([...map.elements].sort((a, b) => b.zIndex - a.zIndex))
  const lockedCount = all.filter(item => item.locked).length
  setHTML($('layers-panel'), `<h3>图层列表 · ${all.length}</h3><p class="muted" style="margin-bottom:15px">上层优先显示。隐藏只影响画面，通行规则继续生效；锁定对象在画布上不可选中，也不会被框选带走。</p>` + (lockedCount ? `<button id="unlock-all" class="full-button">解锁全部 ${lockedCount} 个锁定对象</button>` : '') + all.map(item => `<div class="layer-row ${selection.includes(item.id) ? 'selected' : ''}"><span class="legend" style="background:${isZone(item) ? zoneColors[item.type] : '#acb4bd'}"></span><button class="layer-name" data-select="${escape(item.id)}">${escape(item.name)}</button><button class="layer-toggle" data-visible="${escape(item.id)}" title="切换显示">${item.visible ? '显' : '隐'}</button><button class="layer-toggle" data-lock="${escape(item.id)}" title="切换锁定">${item.locked ? '锁' : '开'}</button></div>`).join(''))
  $('layers-panel').querySelectorAll('[data-select]').forEach(b => b.onclick = () => { select([b.dataset.select]); renderPanels(); draw() })
  for (const [attr, key] of [['visible', 'visible'], ['lock', 'locked']]) $('layers-panel').querySelectorAll(`[data-${attr}]`).forEach(b => b.onclick = () => { const item = all.find(i => i.id === b.dataset[attr]); item[key] = !item[key]; commit() })
  const unlockAll = $('unlock-all')
  if (unlockAll) unlockAll.onclick = () => {
    const before = clone(map)
    for (const item of all) item.locked = false
    try { validateMap(map); commit(); toast(`已解锁 ${lockedCount} 个对象，可以在画布上重新选中`) } catch (error) { map = before; renderPanels(); draw(); toast(error.message) }
  }
}
function renderPanels() {
  $('map-name').value = map.name; $('map-width').value = map.width; $('map-height').value = map.height; $('grid-size').value = map.gridSize; $('map-color').value = map.backgroundColor
  $('background-select').value = !map.background ? 'none' : /icon_office_10/.test(map.background.src) ? '10' : /icon_office_50/.test(map.background.src) ? '50' : 'custom'
  $('background-opacity').value = map.background?.opacity ?? 1; $('background-opacity').disabled = !map.background
  $('undo').disabled = history.index === 0; $('redo').disabled = history.index === history.items.length - 1
  renderProperties(); renderLayers(); renderManageLists()
}

/** 地图设置面板里的「房间与自由活动」清单 */
function renderManageLists() {
  const rooms = map.rooms || []
  setHTML($('rooms-list'), rooms.length
    ? rooms.map(r => `<div class="manage-row"><span class="legend" style="background:${r.occupied ? '#d94f4f' : '#acb4bd'}"></span><span class="manage-name">${escape(r.name)}</span><span class="manage-meta">${ROOM_TYPES[r.type] ?? r.type}${r.capacity ? ` · ${r.capacity} 人` : ''}</span><label class="check-label"><input type="checkbox" data-room-occupied="${escape(r.id)}" ${r.occupied ? 'checked' : ''}>使用中</label></div>`).join('')
    : '<p class="muted">当前地图没有房间。房间由样例生成或用墙壁自行围合后声明。</p>')
  for (const input of $('rooms-list').querySelectorAll('[data-room-occupied]')) input.onchange = () => {
    const room = rooms.find(r => r.id === input.dataset.roomOccupied)
    const before = clone(room); room.occupied = input.checked
    try { validateMap(map); commit(); toast(room.occupied ? `${room.name} 已标记使用中，员工自由活动不会进入` : `${room.name} 已恢复空闲`) } catch (error) { Object.assign(room, before); renderPanels(); toast(error.message) }
  }

  const spots = map.spots || []
  setHTML($('spots-list'), spots.length
    ? `<h4>活动点 · ${spots.length}</h4>` + spots.map(s => `<div class="manage-row ${selection.includes(s.id) ? 'selected' : ''}"><span class="legend" style="background:${spotColors[s.kind] ?? spotColors.custom}"></span><button class="layer-name" data-spot-select="${escape(s.id)}">${escape(s.name)}</button><span class="manage-meta">${SPOT_KINDS[s.kind] ?? s.kind} · ${spotSpeed(s)} px/s</span><button class="layer-toggle" data-spot-toggle="${escape(s.id)}">${s.enabled ? '启' : '禁'}</button></div>`).join('')
    : '<p class="muted">还没有活动点。点「按房间生成活动点」，或用工具栏的「活动点」在画布上点击放置。</p>')
  $('spots-list').querySelectorAll('[data-spot-select]').forEach(b => b.onclick = () => { select([b.dataset.spotSelect]); showPanel('properties'); renderPanels(); draw() })
  $('spots-list').querySelectorAll('[data-spot-toggle]').forEach(b => b.onclick = () => { const spot = spots.find(s => s.id === b.dataset.spotToggle); spot.enabled = !spot.enabled; commit() })
}
/** 复制选中的全部对象；绑定工位的椅子/电脑会一并复制并重新指向副本 */
function duplicate() {
  const items = selectedItems()
  if (!items.length) return
  if (items.every(item => item.locked)) { toast('锁定对象不能复制，请先在「图层」面板解锁'); return }
  const sources = items.filter(item => !item.locked)
  const before = clone(map), previousSelection = [...selection]
  try {
    // 整组统一位移一个网格步长，保持相对位置；已贴边时退化为不位移
    const ranges = groupRanges(sources)
    const step = { x: Math.max(0, Math.min(map.gridSize, map.width - Math.max(...ranges.map(r => r.hiX)))), y: Math.max(0, Math.min(map.gridSize, map.height - Math.max(...ranges.map(r => r.hiY)))) }
    const idMap = new Map(), copies = sources.map(source => {
      const copy = clone(source); copy.id = uid(); copy.name = `${copy.name.slice(0, 115)} 副本`; copy.locked = false
      idMap.set(source.id, copy.id)
      return { source, copy }
    })
    for (const { source, copy } of copies) {
      if (isZone(source)) copy.points = copy.points.map(p => ({ x: p.x + step.x, y: p.y + step.y }))
      else { copy.x = Math.min(map.width, copy.x + step.x); copy.y = Math.min(map.height, copy.y + step.y) }
      if (isSpot(source)) map.spots.push(copy)
      else if (isZone(source)) map.zones.push(copy)
      else { copy.zIndex = Math.min(10000, copy.zIndex + 1); if (copy.label) copy.label = `${copy.label.slice(0, 115)} 副本`; map.elements.push(copy) }
    }
    for (const { source, copy } of copies) {
      if (isZone(source) || isSpot(source)) continue
      const seat = map.seats?.find(s => s.deskElementId === source.id)
      if (!seat) continue
      const next = { ...clone(seat), id: uid(), name: `${seat.name.slice(0, 115)} 副本`, deskElementId: copy.id }
      for (const key of ['chairElementId', 'computerElementId']) {
        const bound = seat[key]
        if (!bound) continue
        if (idMap.has(bound)) { next[key] = idMap.get(bound); continue }
        const original = map.elements.find(e => e.id === bound)
        if (!original) { delete next[key]; continue }
        const elementCopy = { ...clone(original), id: uid(), name: `${original.name.slice(0, 115)} 副本`, x: original.x + step.x, y: original.y + step.y, locked: false }
        map.elements.push(elementCopy); idMap.set(bound, elementCopy.id); next[key] = elementCopy.id
      }
      map.seats.push(next)
    }
    select(copies.map(({ copy }) => copy.id))
    commit()
  } catch (error) { map = before; selection = previousSelection; renderPanels(); draw(); toast(`无法复制：${error.message}`) }
}
function removeSelected() {
  const items = selectedItems()
  if (!items.length) return
  const removable = items.filter(item => !item.locked)
  if (!removable.length) { toast('所选对象均已锁定，请先解锁'); return }
  if (removable.length < items.length) toast(`已跳过 ${items.length - removable.length} 个锁定对象`)
  const ids = new Set(removable.map(item => item.id))
  map.elements = map.elements.filter(e => !ids.has(e.id))
  map.zones = map.zones.filter(z => !ids.has(z.id))
  map.spots = (map.spots || []).filter(s => !ids.has(s.id))
  // 工位桌椅与员工座位由 seats 推导，删掉工位桌时同步清理座位
  if (map.seats) map.seats = map.seats.filter(s => !ids.has(s.deskElementId))
  select([])
  commit()
}
function rectPoints(a, b) { return [{ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, { x: Math.max(a.x, b.x), y: Math.min(a.y, b.y) }, { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) }, { x: Math.min(a.x, b.x), y: Math.max(a.y, b.y) }] }
function addZone(points) {
  if (!isSimplePolygon(points)) { toast('区域需要至少三个不共线的顶点，边界不能交叉'); return false }
  const type = $('zone-type').value
  const zone = { id: uid(), name: `${zoneLabels[type]} ${map.zones.filter(z => z.type === type).length + 1}`, type, points: clone(points), enabled: true, visible: true, locked: false }
  map.zones.push(zone); select([zone.id]); polygon = []; commit(); showPanel('properties'); return true
}
function hit(p, includeLocked = false) {
  const usable = item => item.visible !== false && (includeLocked || canSelect(item))
  const spot = map.spots?.find(s => usable(s) && Math.hypot(s.x - p.x, s.y - p.y) <= 14 / camera.scale)
  if (spot) return spot
  const list = [...map.zones].reverse().concat([...map.elements].sort((a, b) => b.zIndex - a.zIndex))
  return list.find(item => usable(item) && pointInPolygon(p, isZone(item) ? item.points : elementPolygon(item)))
}

/** 框选命中：返回矩形接触到的可选对象（锁定与隐藏对象不在内），最后一个元素为最上层 */
function itemsInRect(rect) {
  const found = []
  for (const spot of map.spots || []) if (canSelect(spot) && rectHitsItem(rect, { x: spot.x, y: spot.y })) found.push(spot)
  for (const zone of map.zones) if (canSelect(zone) && rectHitsItem(rect, { polygon: zone.points })) found.push(zone)
  for (const element of [...map.elements].sort((a, b) => a.zIndex - b.zIndex)) if (canSelect(element) && rectHitsItem(rect, { polygon: elementPolygon(element) })) found.push(element)
  return found
}

/**
 * 生成整组移动手势：只复制元素/区域/锚点自身。
 * 工位椅与电脑、员工锚点由 syncSeats 从工位桌推导，所以跟着工位桌一起走，不需要单独移动。
 */
function moveGesture(start) {
  const entries = selectedItems().filter(canSelect).map(item => ({ id: item.id, item: clone(item) }))
  if (!entries.length) return null
  return { type: 'move', start, before: clone(map), entries, limits: moveLimits(groupRanges(entries.map(entry => entry.item)), map.width, map.height) }
}

/** 新增一个自由活动目的地锚点（默认类型取自工具栏的下拉框） */
function addSpot(p) {
  const before = clone(map), previousSelection = [...selection]
  try {
    map.schema = SCHEMA
    map.spots ||= []
    const kind = $('spot-kind').value
    const x = Math.round(p.x), y = Math.round(p.y)
    const matchedRoom = (map.rooms || []).find(r => r.type !== 'work' && r.bounds && x >= r.bounds.x && x <= r.bounds.x + r.bounds.width && y >= r.bounds.y && y <= r.bounds.y + r.bounds.height)
    const spot = {
      id: uid(), name: `${SPOT_KINDS[kind] ?? '活动点'} ${map.spots.filter(s => s.kind === kind).length + 1}`,
      kind, x, y, speed: SPOT_SPEEDS[kind] ?? SPOT_SPEEDS.custom, stay: SPOT_STAY, enabled: true,
    }
    if (matchedRoom) spot.roomId = matchedRoom.id
    map.spots.push(spot)
    select([spot.id])
    validateMap(map); commit(); showPanel('properties')
  } catch (error) { map = before; selection = previousSelection; renderPanels(); draw(); toast(`无法放置活动点：${error.message}`) }
}
function place(p) {
  const asset = placement
  if (!asset) return
  const before = clone(map), previousSelection = [...selection]
  try {
    const options = templateOptions(asset)
    if (asset.kind === 'image') {
      let definition = map.assets.find(a => a.src === asset.src)
      if (!definition) { definition = { id: uid(), name: asset.name, src: asset.src, category: asset.category, width: asset.width, height: asset.height, tileable: asset.tileable ?? false }; map.assets.push(definition) }
      options.assetId = definition.id; requestImage(asset.src)
    }
    const element = makeElement(asset.name, asset.kind, p.x, p.y, options)
    if ($('snap').checked) Object.assign(element, snapToConnectors(element, map.elements, 12 / camera.scale))
    map.schema = SCHEMA
    map.elements.push(element)
    if (asset.id === 'desk-workstation-top' || asset.id === 'aifred-desk') {
      map.seats ||= []
      const chairTemplate = AIFRED_TEMPLATES.find(t => t.id === 'aifred-chair')
      let chairAsset = map.assets.find(a => a.src === chairTemplate.src)
      if (!chairAsset) { chairAsset = { id: uid(), name: chairTemplate.name, src: chairTemplate.src, category: chairTemplate.category }; map.assets.push(chairAsset) }
      const chair = makeElement(chairTemplate.name, 'image', p.x, p.y, { ...templateOptions(chairTemplate), assetId: chairAsset.id })
      map.elements.push(chair); requestImage(chairTemplate.src)
      let computer
      if (asset.id === 'desk-workstation-top') {
        const computerTemplate = AIFRED_TEMPLATES.find(t => t.id === 'aifred-computer')
        let computerAsset = map.assets.find(a => a.src === computerTemplate.src)
        if (!computerAsset) { computerAsset = { id: uid(), name: computerTemplate.name, src: computerTemplate.src, category: computerTemplate.category, width: computerTemplate.width, height: computerTemplate.height }; map.assets.push(computerAsset) }
        computer = makeElement(computerTemplate.name, 'image', p.x, p.y, { ...templateOptions(computerTemplate), assetId: computerAsset.id })
        map.elements.push(computer); requestImage(computerTemplate.src)
      }
      const index = map.seats.length, name = `工位${index + 1}`
      element.label = String(index + 1).padStart(2, '0')
      const seat = { id: uid(), name, deskElementId: element.id, chairElementId: chair.id, x: p.x, y: p.y, facing: 'back', seatOffset: { x: 0.18, y: 1.19 }, chairOffset: { x: 0.14, y: 1.14 }, approachOffset: { x: 0.5, y: 1.7 }, employee: { resourceId: AIFRED_RESOURCE_ID, skin: pickEmployeeSkin(index), animation: 'idle', enabled: true, name: `员工${index + 1}` } }
      if (computer) { seat.computerElementId = computer.id; seat.computerOffset = { ...AIFRED_COMPUTER_OFFSET } }
      map.seats.push(seat)
    }
    select([element.id]); commit(); showPanel('properties')
  } catch (error) { map = before; selection = previousSelection; renderPanels(); draw(); toast(`无法放置：${error.message}`) }
}
function cancelGesture() { if (gesture?.before) map = gesture.before; gesture = null; renderPanels(); draw() }
canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 && event.button !== 1) return
  event.preventDefault(); canvas.focus(); canvas.setPointerCapture(event.pointerId)
  const p = position(event, true), raw = position(event)
  if (tool === 'pan' || space || event.button === 1 || preview) { gesture = { type: 'pan', screen: { x: event.clientX, y: event.clientY }, camera: { ...camera } }; return }
  if (tool === 'place') { place(p); return }
  if (tool === 'spot') { addSpot(p); return }
  if (tool === 'rect') { gesture = { type: 'rect', start: p, end: p }; return }
  if (tool === 'polygon') {
    if (polygon.length >= 3 && Math.hypot(raw.x - polygon[0].x, raw.y - polygon[0].y) < 10 / camera.scale) { addZone(polygon); return }
    if (!polygon.length || Math.hypot(p.x - polygon.at(-1).x, p.y - polygon.at(-1).y) > 0.1) polygon.push(p)
    draw(); return
  }
  if (tool === 'path') {
    if (!pathStart || pathEnd) { pathStart = raw; pathEnd = null; path = null; pathRequest++; toast('起点已设置，请点击终点') }
    else {
      pathEnd = raw; toast('正在验证路径…')
      navigationWorker.postMessage({ requestId: ++pathRequest, map: { width: map.width, height: map.height, gridSize: map.gridSize, elements: map.elements, zones: map.zones }, start: pathStart, end: pathEnd, radius: Number($('agent-radius').value), mode: $('path-mode').value })
    }
    draw(); return
  }
  const primary = selected()
  if (selection.length === 1 && primary && !primary.locked && !isSpot(primary)) {
    const corners = isZone(primary) ? primary.points : elementPolygon(primary)
    const vertex = corners.findIndex(c => Math.hypot(c.x - raw.x, c.y - raw.y) <= 9 / camera.scale)
    if (vertex >= 0) { gesture = { type: isZone(primary) ? 'vertex' : 'resize', vertex, before: clone(map), item: clone(primary), start: p }; return }
  }
  const additive = event.shiftKey || event.metaKey || event.ctrlKey
  const over = hit(raw, true), target = over && canSelect(over) ? over : null
  if (target) {
    // ⇧/⌘ 点击：加选或减选，不进入拖动
    if (additive) { select(selection.includes(target.id) ? selection.filter(id => id !== target.id) : [...selection, target.id]); renderPanels(); draw(); return }
    // 点中已在选区内的对象时保留整组，便于整组拖动
    if (!selection.includes(target.id)) select([target.id])
    renderPanels(); showPanel('properties'); draw()
    gesture = moveGesture(p)
    return
  }
  // 空白处按下开始框选；over 是锁定对象时只用于给出提示，不会选中
  gesture = { type: 'marquee', start: raw, end: raw, additive, base: [...selection], blocked: over?.locked ? over : null }
  draw()
})
canvas.addEventListener('pointermove', event => {
  hover = position(event, true); const raw = position(event)
  $('coordinates').textContent = `X ${Math.round(raw.x)} · Y ${Math.round(raw.y)}`
  if (!gesture) { if (polygon.length || placement) draw(); return }
  if (gesture.type === 'pan') { camera.x = gesture.camera.x + event.clientX - gesture.screen.x; camera.y = gesture.camera.y + event.clientY - gesture.screen.y }
  else if (gesture.type === 'rect') gesture.end = hover
  else if (gesture.type === 'marquee') gesture.end = raw
  else if (gesture.type === 'vertex' || gesture.type === 'resize') {
    const item = selected(), original = gesture.item
    if (!item) return
    if (gesture.type === 'vertex') item.points[gesture.vertex] = { ...hover }
    else {
      const r = -original.rotation * Math.PI / 180, x = hover.x - original.x, y = hover.y - original.y
      item.width = Math.min(8192, Math.max(4, Math.abs(x * Math.cos(r) - y * Math.sin(r)) * 2)); item.height = Math.min(8192, Math.max(4, Math.abs(x * Math.sin(r) + y * Math.cos(r)) * 2))
      if (item.geometry?.stretchAxis === 'x') item.height = original.height
      if (item.geometry?.stretchAxis === 'y') item.width = original.width
    }
  } else if (gesture.type === 'move') {
    // 整体位移统一夹紧：所有选中对象都不越出地图，相互位置保持不变
    const dx = clampDelta(hover.x - gesture.start.x, gesture.limits.dxMin, gesture.limits.dxMax)
    const dy = clampDelta(hover.y - gesture.start.y, gesture.limits.dyMin, gesture.limits.dyMax)
    for (const entry of gesture.entries) {
      const item = itemById(entry.id), original = entry.item
      if (!item) continue
      if (isZone(item)) item.points = original.points.map(p => ({ x: p.x + dx, y: p.y + dy }))
      else if (isSpot(item)) { item.x = Math.round(original.x + dx); item.y = Math.round(original.y + dy) }
      else { item.x = original.x + dx; item.y = original.y + dy }
    }
    // 单选普通元素时保留端点吸附；整体移动不做吸附，避免整组被一个元素带偏
    const single = gesture.entries.length === 1 ? itemById(gesture.entries[0].id) : null
    if (single && !isZone(single) && !isSpot(single) && $('snap').checked) Object.assign(single, snapToConnectors(single, map.elements, 12 / camera.scale))
  }
  draw()
})
canvas.addEventListener('pointerup', () => {
  if (!gesture) return
  const finished = gesture; gesture = null
  if (finished.type === 'rect') { const points = rectPoints(finished.start, finished.end); if (Math.abs(finished.start.x - finished.end.x) >= 3 && Math.abs(finished.start.y - finished.end.y) >= 3) addZone(points) }
  else if (finished.type === 'marquee') {
    const rect = normalizeRect(finished.start, finished.end)
    if (rect.width < 3 && rect.height < 3) {
      // 视作单击空白：清空选择；原本没选中任何东西又点到锁定对象时，提示到图层解锁
      if (!finished.additive) select([])
      if (finished.blocked && !finished.base.length) toast(`「${finished.blocked.name}」已锁定，画布上不可选中；可在「图层」面板解锁`)
    } else {
      const ids = itemsInRect(rect).map(item => item.id)
      select(finished.additive ? [...finished.base, ...ids] : ids)
      if (ids.length) { showPanel('properties'); toast(`框选到 ${ids.length} 个对象`) }
    }
    renderPanels()
  }
  else if (finished.before) { try { validateMap(map); commit() } catch (error) { map = finished.before; renderPanels(); toast(error.message) } }
  draw()
})
canvas.addEventListener('pointercancel', cancelGesture)
canvas.addEventListener('dblclick', () => { if (tool === 'polygon' && polygon.length >= 3) addZone(polygon) })
canvas.addEventListener('wheel', event => { event.preventDefault(); const rect = canvas.getBoundingClientRect(); zoom(Math.exp(-event.deltaY * 0.0015), { x: event.clientX - rect.left, y: event.clientY - rect.top }) }, { passive: false })
canvas.addEventListener('contextmenu', event => event.preventDefault())

async function imageFile(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) throw new Error('请选择不超过 8 MB 的 PNG、JPEG 或 WebP 图片')
  const src = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('文件读取失败')); reader.readAsDataURL(file) })
  const image = await loadImage(src)
  if (image.naturalWidth > 8192 || image.naturalHeight > 8192) throw new Error('图片边长不能超过 8192 像素')
  return { src, width: image.naturalWidth, height: image.naturalHeight }
}
// 当前关联的共用目录配置文件名；新建地图时为 null，点击保存会提示输入文件名
let currentFile = 'office-10-person.json'

function sanitizeFileName(raw) {
  const trimmed = String(raw || '').trim()
  if (!trimmed) throw new Error('请输入保存文件名')
  const stem = trimmed
    .replace(/\.office-map\.json$/i, '')
    .replace(/\.json$/i, '')
    .replace(/[<>:"/\\|?*]/g, '-')
    .trim()
  if (!stem || stem === '.' || stem === '..' || stem.toLowerCase() === 'manifest') {
    throw new Error('无效的文件名')
  }
  return `${stem}.json`
}

function updateFileIndicator() {
  const badge = $('current-file-badge')
  if (badge) {
    badge.textContent = currentFile ? currentFile : '新建布局（未命名文件）'
    badge.dataset.mode = currentFile ? 'file' : 'new'
  }
  const sel = $('shared-map-select')
  if (!sel) return
  if (currentFile && [...sel.options].some(o => o.value === currentFile)) {
    sel.value = currentFile
  } else if (!currentFile) {
    sel.value = ''
  }
}

async function refreshSharedMaps(selectedFile = currentFile) {
  const sel = $('shared-map-select')
  if (!sel) return null
  try {
    const info = await fetchJSON('/__office-editor/api/maps')
    const options = []
    if (!selectedFile) {
      const blankOpt = document.createElement('option')
      blankOpt.value = ''
      blankOpt.textContent = '新建未命名布局…'
      options.push(blankOpt)
    }
    for (const item of info.files || []) {
      const opt = document.createElement('option')
      opt.value = item.file
      opt.textContent = `${item.file}（${item.name}）`
      options.push(opt)
    }
    if (selectedFile && !options.some(o => o.value === selectedFile)) {
      const customOpt = document.createElement('option')
      customOpt.value = selectedFile
      customOpt.textContent = `${selectedFile}（待保存）`
      options.push(customOpt)
    }
    sel.replaceChildren(...options)
    sel.value = selectedFile || ''
    return info
  } catch {
    return null
  }
}

function promptSaveFileName(defaultName) {
  const dialog = $('save-name-dialog')
  const input = $('save-file-input')
  const form = $('save-name-form')
  const cancelBtn = $('save-name-cancel')
  if (!dialog || typeof dialog.showModal !== 'function' || !input || !form || !cancelBtn) {
    const value = window.prompt('请输入新建布局的保存文件名（将保存至共用目录 assets/office/map/）：', defaultName)
    return Promise.resolve(value ? value.trim() : null)
  }
  return new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      form.removeEventListener('submit', onSubmit)
      cancelBtn.removeEventListener('click', onCancel)
      dialog.removeEventListener('close', onClose)
      if (dialog.open) dialog.close()
      resolve(value)
    }
    const onSubmit = event => {
      event.preventDefault()
      const val = input.value.trim()
      if (!val) return
      finish(val)
    }
    const onCancel = () => finish(null)
    const onClose = () => finish(null)
    form.addEventListener('submit', onSubmit)
    cancelBtn.addEventListener('click', onCancel)
    dialog.addEventListener('close', onClose)
    input.value = defaultName
    dialog.showModal()
    input.focus()
    const dotIndex = defaultName.toLowerCase().endsWith('.json') ? defaultName.length - 5 : defaultName.length
    input.setSelectionRange(0, Math.max(0, dotIndex))
  })
}

function reset(next, nextFile = currentFile) {
  cancelGesture()
  currentFile = nextFile
  map = next
  history = new History(map)
  selection = []
  path = pathStart = pathEnd = null
  pathRequest++
  setTool('select')
  revision++
  dirty = true
  updateFileIndicator()
  autosave()
  preload()
  renderPanels()
  renderLibrary()
  fit()
}

async function prepareExportPayload() {
  validateMap(map)
  const output = clone(map)
  if ($('embed-assets').checked) {
    const embed = async src => {
      if (src.startsWith('data:')) return src
      const image = await loadImage(src), surface = document.createElement('canvas')
      surface.width = image.naturalWidth; surface.height = image.naturalHeight; surface.getContext('2d').drawImage(image, 0, 0)
      return surface.toDataURL('image/png')
    }
    if (output.background) output.background.src = await embed(output.background.src)
    for (const asset of output.assets) asset.src = await embed(asset.src)
  }
  return output
}

async function saveMap() {
  try {
    validateMap(map)
    let targetFile = currentFile
    if (!targetFile) {
      const suggested = `${(map.name || 'office-custom').replace(/[\\/:*?"<>|]/g, '-')}.json`
      const entered = await promptSaveFileName(suggested)
      if (!entered) return
      targetFile = sanitizeFileName(entered)
    }
    if ($('save-map')) $('save-map').disabled = true
    const output = await prepareExportPayload()
    const response = await fetch('/__office-editor/api/maps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: targetFile, map: output, setActive: true }),
    })
    const result = await response.json()
    if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`)
    currentFile = result.file
    const nextUrl = new URL(window.location.href)
    nextUrl.searchParams.set('file', currentFile)
    window.history.replaceState(null, '', nextUrl)
    updateFileIndicator()
    await refreshSharedMaps(currentFile)
    savedRevision = revision
    dirty = false
    clearTimeout(saveTimer)
    await saveDraft(clone(map)).catch(() => {})
    $('save-status').textContent = `已保存至 ${currentFile}`
    toast(`已保存配置文件：${currentFile}（与 AIFred 办公室共用目录已同步）`)
  } catch (error) {
    toast(`保存失败：${error.message}`)
  } finally {
    if ($('save-map')) $('save-map').disabled = false
  }
}

async function exportMap() {
  try {
    $('export-map').disabled = true
    const output = await prepareExportPayload()
    const blob = new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' })
    if (blob.size > 40 * 1024 * 1024) throw new Error('配置超过 40 MB，请减少素材或取消内嵌图片后导出')
    const link = document.createElement('a'), url = URL.createObjectURL(blob)
    link.href = url; link.download = `${map.name.replace(/[\\/:*?"<>|]/g, '-') || 'office'}.office-map.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    autosave(); toast(`已导出配置 · ${map.elements.length} 个元素 / ${map.zones.length} 个区域`)
  } catch (error) { toast(`导出失败：${error.message}`) } finally { $('export-map').disabled = false }
}
function performHistory(direction) { cancelGesture(); map = history[direction](); selection = []; path = pathStart = pathEnd = null; pathRequest++; polygon = []; revision++; dirty = true; autosave(); preload(); renderPanels(); renderLibrary(); draw() }
document.querySelectorAll('[data-tool]').forEach(button => button.onclick = () => { if (preview) togglePreview(); setTool(button.dataset.tool) })
document.querySelectorAll('[data-panel]').forEach(button => button.onclick = () => showPanel(button.dataset.panel))
$('undo').onclick = () => performHistory('undo'); $('redo').onclick = () => performHistory('redo')
$('fit').onclick = fit; $('zoom-in').onclick = () => zoom(1.2); $('zoom-out').onclick = () => zoom(1 / 1.2)
$('grid').onchange = draw; $('footprints').onchange = draw; $('animate-employees').onchange = draw; $('zone-type').onchange = draw; $('asset-search').oninput = renderLibrary
$('map-name').onchange = () => { map.name = $('map-name').value.trim() || '未命名地图'; commit() }
for (const [id, key] of [['map-width', 'width'], ['map-height', 'height'], ['grid-size', 'gridSize'], ['map-color', 'backgroundColor']]) $(id).onchange = () => {
  const previous = map[key]; map[key] = key === 'backgroundColor' ? $(id).value : Number($(id).value)
  try { validateMap(map); commit(); if (key === 'width' || key === 'height') fit() } catch (error) { map[key] = previous; renderPanels(); toast(error.message) }
}
$('background-select').onchange = () => { const value = $('background-select').value; if (value === 'custom') return; map.background = value === 'none' ? null : { src: `assets/icon_office_${value}.png`, opacity: 1, visible: true }; preload(); commit() }
$('background-opacity').oninput = () => { if (map.background) { map.background.opacity = Number($('background-opacity').value); draw() } }
$('background-opacity').onchange = commit
for (const id of ['path-mode', 'agent-radius']) $(id).onchange = () => {
  $('agent-radius').value = String(Number.isFinite(Number($('agent-radius').value)) ? number($('agent-radius').value, 0, 64) : 8)
  path = pathStart = pathEnd = null; pathRequest++; draw()
}
$('validate-map').onclick = () => { try { validateMap(map); const warnings = mapWarnings(map); $('validation-result').textContent = warnings.length ? warnings.map(w => `• ${w}`).join('\n') : '配置结构正常。请使用测路工具验证关键通道。' } catch (error) { $('validation-result').textContent = error.message } }
$('new-map').onclick = () => {
  if (confirm('新建空白地图？当前地图草稿将被替换，建议先保存或导出 JSON。')) {
    reset(makeMap(null), null)
    void refreshSharedMaps(null)
    toast('已新建空白布局，点击「保存」时将提示输入保存文件名')
  }
}
$('sync-spots').onclick = () => {
  const before = clone(map)
  try {
    const added = (() => { const size = map.spots?.length ?? 0; syncSpots(map); return (map.spots?.length ?? 0) - size })()
    validateMap(map); commit(); toast(added ? `已按房间新增 ${added} 个活动点` : '每个房间都已有对应活动点')
  } catch (error) { map = before; renderPanels(); draw(); toast(`生成失败：${error.message}`) }
}
$('load-office-example').onclick = async () => {
  if ((map.elements.length || map.zones.length) && !confirm('加载10人工位、3会议室、1茶水间、1厕所示例？当前草稿会被替换，请先导出备份。')) return
  try { const next = validateMap(await fetchJSON('examples/office-10-person.json')); if (preview) togglePreview(); reset(next, currentFile || 'office-10-person.json'); switchStyle('topdown-soft'); toast('已加载10人办公室，所有房间与工位均可继续编辑') } catch (error) { toast(`示例加载失败：${error.message}`) }
}
if ($('save-map')) $('save-map').onclick = saveMap
if ($('shared-map-select')) {
  $('shared-map-select').onchange = async event => {
    const targetFile = event.target.value
    if (!targetFile) return
    try {
      const result = await fetchJSON(`/__office-editor/api/maps/${encodeURIComponent(targetFile)}`)
      const next = validateMap(result.map)
      if (preview) togglePreview()
      reset(next, result.file)
      const nextUrl = new URL(window.location.href)
      nextUrl.searchParams.set('file', result.file)
      window.history.replaceState(null, '', nextUrl)
      await fetch('/__office-editor/api/active-map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: result.file }),
      }).catch(() => {})
      toast(`已切换至共用目录配置：${result.file}`)
    } catch (error) {
      toast(`加载共用配置失败：${error.message}`)
      updateFileIndicator()
    }
  }
}
$('export-map').onclick = exportMap; $('import-map').onclick = () => $('map-file').click()
$('map-file').onchange = async event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return
  try {
    if (file.size > 40 * 1024 * 1024) throw new Error('配置文件不能超过 40 MB')
    const next = validateMap(JSON.parse(await file.text()))
    const importedFile = sanitizeFileName(file.name)
    if (confirm(`导入「${next.name}」并替换当前地图草稿？`)) {
      reset(next, importedFile)
      void refreshSharedMaps(importedFile)
      toast(`配置已导入（关联文件：${importedFile}），点击「保存」将直接更新该文件`)
    }
  } catch (error) { toast(`导入失败：${error.message}`) }
}
$('upload-asset').onclick = () => $('asset-file').click()
$('asset-file').onchange = async event => {
  const files = [...event.target.files]; event.target.value = ''
  for (const file of files) { try { const image = await imageFile(file); const scale = Math.min(1, 180 / Math.max(image.width, image.height)); map.assets.push({ id: uid(), name: file.name.replace(/\.[^.]+$/, '').slice(0, 120), category: '自定义', src: image.src, width: Math.round(image.width * scale), height: Math.round(image.height * scale) }); commit() } catch (error) { toast(error.message) } }
  category = '自定义'; renderLibrary()
}
$('upload-background').onclick = () => $('background-file').click()
$('background-file').onchange = async event => { const file = event.target.files[0]; event.target.value = ''; if (!file) return; try { const image = await imageFile(file); map.background = { src: image.src, opacity: 1, visible: true }; commit(); toast('底图已更新，按当前画布尺寸显示') } catch (error) { toast(error.message) } }
function togglePreview() { preview = !preview; if (preview) setTool('pan'); $('preview').classList.toggle('active', preview); $('preview').textContent = preview ? '退出预览' : '预览'; $('canvas-hint').textContent = preview ? '地图预览 · 拖动平移 · 滚轮缩放 · 点击退出预览继续编辑' : '拖动平移 · 滚轮缩放'; draw() }
$('preview').onclick = togglePreview
window.addEventListener('keydown', event => {
  if (event.target.closest('input,select,textarea,[contenteditable]')) return
  const mod = event.metaKey || event.ctrlKey
  if (event.code === 'Space') { event.preventDefault(); space = true; return }
  if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); saveMap(); return }
  if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); performHistory(event.shiftKey ? 'redo' : 'undo'); return }
  if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); performHistory('redo'); return }
  if (mod && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicate(); return }
  if (mod && event.key.toLowerCase() === 'a') { event.preventDefault(); if (!preview) selectAll(); return }
  if (event.key === 'Escape') { cancelGesture(); polygon = []; placement = null; if (preview) togglePreview(); setTool('select'); document.querySelector('.workspace').classList.remove('show-inspector'); return }
  if (event.key === 'Enter' && tool === 'polygon') { event.preventDefault(); addZone(polygon); return }
  if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); if (!preview) removeSelected(); return }
  const shortcuts = { v: 'select', h: 'pan', r: 'rect', p: 'polygon', t: 'path', a: 'spot' }
  if (!mod && shortcuts[event.key.toLowerCase()]) { if (preview) togglePreview(); setTool(shortcuts[event.key.toLowerCase()]); return }
  if (!preview && selection.length && event.key.startsWith('Arrow')) {
    const movable = selectedItems().filter(canSelect)
    if (!movable.length) return
    event.preventDefault(); const step = event.shiftKey ? map.gridSize : 1, before = clone(map)
    const limits = moveLimits(groupRanges(movable), map.width, map.height)
    const dx = clampDelta(event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0, limits.dxMin, limits.dxMax)
    const dy = clampDelta(event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0, limits.dyMin, limits.dyMax)
    for (const item of movable) {
      if (isZone(item)) item.points = item.points.map(p => ({ x: p.x + dx, y: p.y + dy })); else { item.x += dx; item.y += dy }
    }
    try { validateMap(map); commit() } catch { map = before; renderPanels(); draw() }
  }
})
window.addEventListener('keyup', event => { if (event.code === 'Space') space = false })
window.addEventListener('blur', () => { space = false; if (gesture) cancelGesture() })
window.addEventListener('pagehide', () => employeeRuntime?.destroy())
window.addEventListener('beforeunload', event => { if (dirty && revision > savedRevision) { event.preventDefault(); event.returnValue = '' } })
document.addEventListener('visibilitychange', () => { if (document.hidden && dirty) { clearTimeout(saveTimer); autosave() } })

// Mobile widths expose the inspector through one compact toolbar action.
const inspectButton = document.createElement('button'); inspectButton.textContent = '属性面板'; inspectButton.onclick = () => document.querySelector('.workspace').classList.toggle('show-inspector')
const media = matchMedia('(max-width:850px)'); const updateInspectorToggle = () => { inspectButton.hidden = !media.matches }; media.addEventListener('change', updateInspectorToggle); updateInspectorToggle(); document.querySelector('.toolbar').append(inspectButton)
let initializedSize = false
new ResizeObserver(entries => {
  const { width, height } = entries[0].contentRect; viewport = { width, height }
  const ratio = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio)
  if (!initializedSize && width && height) { fit(); initializedSize = true } else draw()
}).observe(wrap)

async function fetchJSON(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} · HTTP ${response.status}`)
  return response.json()
}
async function start() {
  try {
    const { styles, errors } = await loadStyles(fetchJSON)
    for (const style of styles) styleStore[style.id] = style
    $('style-select').replaceChildren(...styles.map(style => {
      const option = document.createElement('option'); option.value = style.id; option.textContent = style.name; return option
    }))
    $('style-select').onchange = e => switchStyle(e.target.value)
    switchStyle((styles.find(s => s.default) || styles[0])?.id)
    if (errors.length) toast(`部分风格未加载：${errors.join('；')}`)
  } catch (error) { toast(`素材库加载失败：${error.message}`) }
  const urlFile = new URLSearchParams(window.location.search).get('file')
  const inAifred = window.location.pathname.startsWith('/office-editor')
  const sharedInfo = await refreshSharedMaps(urlFile || currentFile)
  let restored = false
  if (urlFile || inAifred) {
    const targetFile = urlFile || sharedInfo?.activeFile || 'office-10-person.json'
    try {
      const result = await fetchJSON(`/__office-editor/api/maps/${encodeURIComponent(targetFile)}`)
      if (revision === 0) {
        map = validateMap(result.map)
        currentFile = result.file
        history = new History(map)
        restored = true
        updateFileIndicator()
        await refreshSharedMaps(currentFile)
        $('save-status').textContent = `已加载共用配置 · ${currentFile}`
      }
    } catch (error) {
      toast(`加载共用配置失败，将回退本机草稿：${error.message}`)
    }
  }
  if (!restored) {
    try {
      const db = await dbPromise
      const stored = await new Promise((resolve, reject) => { const tx = db.transaction('drafts'); const request = tx.objectStore('drafts').get('current'); request.onsuccess = () => resolve(request.result); request.onerror = reject })
      if (stored && revision === 0) {
        map = validateMap(stored); restored = true
        if (!map.elements.length && !map.zones.length && /icon_office_10/.test(map.background?.src || '')) map.background = null
        history = new History(map); $('save-status').textContent = '已恢复本机草稿 · 可点击10人样例切换'
      }
    } catch { $('save-status').textContent = '草稿无法恢复，请导入配置'; toast('无法读取本机草稿，请使用 JSON 导入恢复') }
  }
  if (!restored && revision === 0) {
    try {
      const example = validateMap(await fetchJSON('examples/office-10-person.json'))
      if (revision === 0) { map = example; history = new History(map); revision++; dirty = true; autosave() }
    } catch (error) { toast(`示例未加载，已保留空白画布：${error.message}`) }
  }
  updateFileIndicator(); preload(); renderLibrary(); renderPanels(); setTool('select'); fit()
}
renderPanels(); setTool('select'); start()
