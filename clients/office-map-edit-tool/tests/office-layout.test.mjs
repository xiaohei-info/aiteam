import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createOfficeLayout } from '../src/office-layout.js'
import { validateMap, mapWarnings, elementConnectors, elementFootprints, isBlocked, findPath, clearSegment } from '../src/model.js'
const catalog = JSON.parse(await readFile(new URL('../assets/styles/topdown-soft/style.json', import.meta.url), 'utf8'))
const example = JSON.parse(await readFile(new URL('../examples/office-10-person.json', import.meta.url), 'utf8'))

test('checked-in example is reproducible, valid, component-based and portable through JSON', () => {
  assert.deepEqual(createOfficeLayout(catalog), example)
  assert.deepEqual(validateMap(JSON.parse(JSON.stringify(example))), example)
  assert.equal(example.schema, 'office-map/v1.1')
  assert.equal(example.background, null)
  assert.deepEqual(mapWarnings(example), [])
  assert.ok(example.assets.every(a => (a.src.startsWith('assets/styles/topdown-soft/') || a.src.startsWith('assets/aifred/office/')) && !a.src.includes('preview') && !a.src.includes('board')))
  assert.equal(example.elements.filter(e => example.assets.find(a => a.id === e.assetId)?.tileable).length, 7)
})

test('office has ten distinct workstation desks/chairs, three meeting rooms, one pantry and one restroom', () => {
  assert.equal(example.seats.length, 10)
  assert.equal(new Set(example.seats.map(s => s.deskElementId)).size, 10)
  assert.equal(new Set(example.seats.map(s => s.chairElementId)).size, 10)
  assert.equal(example.elements.filter(e => e.assetId === 'asset-desk-workstation-top').length, 10)
  assert.equal(example.elements.filter(e => e.assetId === 'asset-aifred-computer').length, 10)
  // 贴图基准 82.5×55（asset），图元默认放大 1.25×
  assert.deepEqual(example.assets.find(a => a.id === 'asset-aifred-computer'), { id: 'asset-aifred-computer', name: 'AIFred 原有电脑显示器', src: 'assets/aifred/office/office_computer_bg.png', category: '工位 · AIFred', width: 82.5, height: 55, tileable: false })
  assert.equal(example.elements.find(e => e.assetId === 'asset-aifred-computer').width, 82.5 * 1.25)
  assert.equal(example.elements.find(e => e.assetId === 'asset-aifred-computer').height, 55 * 1.25)
  assert.equal(new Set(example.seats.map(s => s.computerElementId)).size, 10)
  const meetings = example.rooms.filter(r => r.type === 'meeting')
  assert.equal(meetings.length, 3)
  assert.deepEqual(meetings.map(r => r.capacity), [4, 6, 4])
  assert.equal(example.rooms.filter(r => r.type === 'pantry').length, 1)
  assert.equal(example.rooms.filter(r => r.type === 'restroom').length, 1)
  assert.equal(example.elements.filter(e => e.assetId === 'asset-meeting-table-top').length, 3)
  assert.equal(example.elements.filter(e => e.assetId === 'asset-chair-top').length, 14)
  assert.equal(example.elements.filter(e => e.assetId === 'asset-aifred-chair').length, 10)
  assert.equal(example.seats.filter(s => s.employee?.enabled && s.employee.resourceId === 'aifred-chibi-stickers').length, 10)
  for (const id of ['toilet-top', 'coffee-counter-top', 'water-dispenser-top']) assert.equal(example.elements.filter(e => e.assetId === `asset-${id}`).length, 1)
  assert.equal(example.elements.filter(e => e.assetId === 'asset-basin-top').length, 2)
})

test('all six doorway frame endpoints touch an adjoining wall/glass endpoint and wall thickness stays fixed', () => {
  const doors = example.elements.filter(e => e.assetId.includes('door-open-'))
  assert.equal(doors.length, 6)
  for (const door of doors) {
    assert.equal(elementFootprints(door).length, 3)
    for (const port of elementConnectors(door)) assert.ok(example.elements.some(other => other.id !== door.id && elementConnectors(other).some(p => Math.hypot(p.x - port.x, p.y - port.y) < 1e-8)), door.name)
  }
  for (const e of example.elements) {
    if (e.geometry?.stretchAxis === 'x') assert.equal(e.height, e.geometry.height, e.name)
    if (e.geometry?.stretchAxis === 'y') assert.equal(e.width, e.geometry.width, e.name)
  }
})

test('employee sits on the desk left and the separate computer screen stays clear on the right', () => {
  for (const seat of example.seats) {
    const desk = example.elements.find(e => e.id === seat.deskElementId)
    const computer = example.elements.find(e => e.id === seat.computerElementId)
    assert.ok(computer, `${seat.name} 缺少电脑图元`)
    assert.ok(computer.screen, `${seat.name} 电脑图元缺少 screen 元数据`)
    assert.ok(seat.facing === 'back', `${seat.name} 应背对镜头（不显示正脸）`)
    assert.ok(seat.x < desk.x - desk.width * 0.1, `${seat.name} 员工应在桌子左侧`)
    const employeeRight = seat.x + desk.width * 0.58 * 1.1 / 2
    // screen 是贴图 1× 坐标，图元放大后按 图元宽 / 贴图宽 换算
    const computerAsset = example.assets.find(a => a.id === computer.assetId), k = computer.width / computerAsset.width
    const screenLeft = computer.x - computer.width / 2 + computer.screen.x * k
    assert.ok(employeeRight <= screenLeft, `${seat.name} 员工不能遮挡屏幕`)
    const screenRight = screenLeft + computer.screen.width * k
    assert.ok(screenRight <= desk.x + desk.width / 2, `${seat.name} 屏幕应留在桌面范围内`)
  }
})

test('greenery and props: counts, meeting-table decor, corner plants clear the doors, hedges stay off door openings', () => {
  const byAsset = id => example.elements.filter(e => e.assetId === id)
  const overlaps = (a, b, pad = 0) => Math.abs(a.x - b.x) < (a.width + b.width) / 2 + pad && Math.abs(a.y - b.y) < (a.height + b.height) / 2 + pad
  const counts = {
    'asset-plant-monstera-top': 2, 'asset-plant-palm-top': 4, 'asset-plant-fern-top': 3, 'asset-plant-bush-top': 3,
    'asset-plant-succulent-top': 3, 'asset-plant-cactus-top': 3, 'asset-planter-hedge-top': 3,
    'asset-rug-round-top': 1, 'asset-coffee-table-top': 1, 'asset-armchair-top': 1, 'asset-side-table-top': 1,
    'asset-floor-lamp-top': 1, 'asset-printer-top': 1, 'asset-trash-bin-top': 2, 'asset-bench-top': 2,
  }
  for (const [assetId, count] of Object.entries(counts)) assert.equal(byAsset(assetId).length, count, assetId)
  assert.equal(example.elements.length, 104 + Object.values(counts).reduce((sum, n) => sum + n, 0))

  // 每张会议桌上：1 盆多肉 + 1 盆仙人掌，落在桌面内、图层高于桌面、不阻挡行走
  const decor = [...byAsset('asset-plant-succulent-top'), ...byAsset('asset-plant-cactus-top')]
  for (const table of byAsset('asset-meeting-table-top')) {
    const onTable = decor.filter(p => Math.abs(p.x - table.x) + p.width / 2 <= table.width / 2 && Math.abs(p.y - table.y) + p.height / 2 <= table.height / 2)
    assert.deepEqual(onTable.map(p => p.assetId).sort(), ['asset-plant-cactus-top', 'asset-plant-succulent-top'], table.name)
    for (const p of onTable) { assert.ok(p.zIndex > table.zIndex, p.name); assert.equal(p.blocksMovement, false, p.name) }
  }

  // 会议室角落绿植不进入任何门的 88×88 范围（含门扇摆动区）
  const doors = example.elements.filter(e => e.assetId.includes('door-open-'))
  const corners = example.elements.filter(e => e.name.includes('角落'))
  assert.equal(corners.length, 11)
  for (const plant of corners) for (const door of doors) assert.equal(overlaps(plant, door, 8), false, `${plant.name} 挡住了 ${door.name}`)

  // 走道上的绿篱花槽离三间会议室的门口至少 24px，不堵住出门的路
  const meetingDoors = doors.filter(d => /^会议室.入口/.test(d.name))
  assert.equal(meetingDoors.length, 3)
  for (const hedge of byAsset('asset-planter-hedge-top')) for (const door of meetingDoors) {
    assert.ok(Math.abs(hedge.x - door.x) >= (hedge.width + door.width) / 2 + 24, `${hedge.name}@${hedge.x} 离 ${door.name} 太近`)
  }

  // 地毯是地面装饰：在地面之上、家具之下，可以走上去
  const rug = byAsset('asset-rug-round-top')[0]
  assert.ok(rug.zIndex > -100 && rug.zIndex < 0 && rug.blocksMovement === false)
})

test('entrance reaches all five functional rooms and all ten seat approach points with 12px clearance', () => {
  const start = example.layout.entrance
  const destinations = [...example.rooms.filter(r => r.type !== 'work').map(r => ({ name: r.name, point: r.approachPoint })), ...example.seats.map(s => ({ name: s.name, point: s.approachPoint }))]
  assert.equal(destinations.length, 15)
  assert.equal(isBlocked(example, example.layout.spawnPoint, 12), false)
  for (const target of destinations) {
    assert.equal(isBlocked(example, target.point, 12), false, target.name)
    const path = findPath(example, start, target.point, 12, 'employee')
    assert.ok(path && path.length >= 2, `${target.name}: unreachable`)
    for (let i = 1; i < path.length; i++) assert.equal(clearSegment(example, path[i - 1], path[i], 12, 'employee'), true, target.name)
  }
})
