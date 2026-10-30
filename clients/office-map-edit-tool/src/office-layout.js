import { makeMap, makeElement, templateOptions, syncSeats, syncSpots, validateMap, SPOT_SPEEDS } from './model.js'
import { AIFRED_TEMPLATES, AIFRED_RESOURCE_ID, AIFRED_CHAIR_WIDTH, AIFRED_CHAIR_HEIGHT, AIFRED_COMPUTER_OFFSET, pickEmployeeSkin } from './aifred-resources.js'

// Explicit component assembly, never a full-office background image.
// All dimensions are logical pixels, not a building-code scale.
export function createOfficeLayout(catalog) {
  const templates = new Map([...catalog.elements, ...AIFRED_TEMPLATES].map(a => [a.id, a]))
  const map = { ...makeMap(), id: 'office-10-person-topdown', name: '10人办公室 · 3会议室 / 茶水间 / 厕所', width: 1600, height: 1200, backgroundColor: '#eeede7', rooms: [], seats: [] }
  let sequence = 0
  function add(templateId, x, y, extra = {}) {
    const a = templates.get(templateId)
    if (!a) throw new Error(`缺少示例素材：${templateId}`)
    const assetId = `asset-${templateId}`
    if (!map.assets.some(asset => asset.id === assetId)) map.assets.push({ id: assetId, name: a.name, src: a.src, category: a.category, width: a.width, height: a.height, tileable: a.tileable ?? false })
    const width = extra.width ?? a.width * (a.defaultScale ?? 1), height = extra.height ?? a.height * (a.defaultScale ?? 1)
    const element = makeElement(extra.name || a.name, 'image', x + width / 2, y + height / 2, { ...templateOptions(a), assetId, id: `element-${String(++sequence).padStart(3, '0')}`, ...extra })
    map.elements.push(element)
    return element
  }
  function room(id, name, type, capacity, bounds, approachPoint, extra = {}) {
    map.rooms.push({ id: `room-${id}`, name, type, capacity, bounds, approachPoint, ...extra })
  }
  const floor = (id, x, y, width, height, name) => add(id, x, y, { width, height, name, locked: true })
  const hWall = (x, y, width, facing = 'down') => add(`wall-${facing}`, x, y, { width, zIndex: 20 })
  const vWall = (x, y, height, facing = 'right') => add(`wall-${facing}`, x, y, { height, zIndex: 20 })
  const glass = (x, y, width) => add('glass-up', x, y, { width, zIndex: 21 })
  const cap = (x, y) => add('wall-junction', x, y, { zIndex: 25 })
  const door = (id, x, y, name) => add(id, x, y, { name, zIndex: 30 })

  floor('floor-mineral', 48, 48, 1504, 1104, '主通道 / 浅灰矿物砖')
  floor('floor-oak', 48, 48, 432, 352, '会议室A / 木地板')
  floor('floor-oak', 496, 48, 544, 352, '会议室B / 木地板')
  floor('floor-oak', 1056, 48, 496, 352, '会议室C / 木地板')
  floor('floor-carpet', 48, 560, 1152, 592, '10人工位区 / 地毯')
  floor('floor-mineral', 1216, 568, 336, 264, '茶水间 / 地砖')
  floor('floor-mineral', 1216, 848, 336, 304, '厕所 / 地砖')

  hWall(48, 32, 1504)
  vWall(32, 48, 1104)
  vWall(1552, 48, 1104, 'left')
  hWall(48, 1152, 672, 'up')
  hWall(808, 1152, 744, 'up')
  add('wall-corner-down-right', 32, 32, { zIndex: 25 })
  add('wall-corner-down-left', 1552, 32, { zIndex: 25 })
  add('wall-corner-up-right', 32, 1152, { zIndex: 25 })
  add('wall-corner-up-left', 1552, 1152, { zIndex: 25 })
  const entrance = door('door-open-up', 720, 1080, '办公室入口 · 已打开')
  entrance.label = '入口'

  vWall(480, 48, 348)
  vWall(1040, 48, 348)
  cap(480, 32); cap(1040, 32)
  for (const x of [32, 480, 1040, 1552]) cap(x, 396)
  for (const [left, right, opening, name] of [[48, 480, 352, '会议室A'], [496, 1040, 864, '会议室B'], [1056, 1552, 1360, '会议室C']]) {
    glass(left, 400, opening - left)
    glass(opening + 88, 400, right - opening - 88)
    door('door-open-up', opening, 324, `${name}入口 · 已打开`)
  }
  room('meeting-a', '会议室 A', 'meeting', 4, { x: 48, y: 48, width: 432, height: 352 }, { x: 416, y: 360 }, { occupied: false })
  room('meeting-b', '会议室 B', 'meeting', 6, { x: 496, y: 48, width: 544, height: 352 }, { x: 928, y: 360 }, { occupied: false })
  room('meeting-c', '会议室 C', 'meeting', 4, { x: 1056, y: 48, width: 496, height: 352 }, { x: 1424, y: 360 }, { occupied: false })
  for (const [x, width, chairs, name] of [[136, 224, [152, 272], '会议室A'], [640, 256, [656, 752, 848], '会议室B'], [1152, 224, [1168, 1288], '会议室C']]) {
    add('meeting-table-top', x, 170, { width, name: `${name} / 会议桌` })
    for (const chairX of chairs) {
      add('chair-top', chairX, 90, { name: `${name} / 北侧座椅` })
      add('chair-top', chairX, 290, { rotation: 180, name: `${name} / 南侧座椅` })
    }
  }

  room('work', '独立工位区', 'work', 10, { x: 48, y: 560, width: 1152, height: 592 }, { x: 1104, y: 944 })
  // 工位 = 俯视工位桌（不含显示器）+ 桌面右侧独立电脑图元 + AIFred 办公椅与 Spine 员工
  for (let row = 0; row < 2; row++) for (let column = 0; column < 5; column++) {
    const index = row * 5 + column, number = String(index + 1).padStart(2, '0'), x = 96 + column * 192, y = row ? 876 : 700
    const deskTemplate = templates.get('desk-workstation-top'), deskHeight = deskTemplate.height
    const desk = add('desk-workstation-top', x, y, { name: `工位${number} / 工位桌`, label: number })
    const chair = add('aifred-chair', x + 72 - AIFRED_CHAIR_WIDTH / 2, y + deskHeight * 0.90 - AIFRED_CHAIR_HEIGHT * 0.36, { name: `工位${number} / AIFred办公椅` })
    const computer = add('aifred-computer', x + 6, y + 4, { name: `工位${number} / AIFred电脑显示器` })
    // 员工坐桌左、背对镜头（facing: back，不用正脸）；椅子在人身后往电脑对面偏左，遮半身露出整个头；头顶落在桌面范围内
    map.seats.push({ id: `seat-${number}`, name: `工位${number}`, deskElementId: desk.id, chairElementId: chair.id, computerElementId: computer.id, x: 0, y: 0, facing: 'back', seatOffset: { x: 0.18, y: 1.19 }, chairOffset: { x: 0.14, y: 1.14 }, computerOffset: { ...AIFRED_COMPUTER_OFFSET }, approachOffset: { x: 0.5, y: 1.7 }, employee: { resourceId: AIFRED_RESOURCE_ID, skin: pickEmployeeSkin(index), animation: 'idle', enabled: true, name: `员工${number}` } })
  }

  // Utility rooms share one solid divider; the toilet door opens inward/right.
  cap(1200, 552); cap(1552, 552)
  vWall(1200, 568, 376)
  vWall(1200, 1032, 120)
  cap(1200, 832); cap(1552, 832); cap(1200, 1152)
  hWall(1216, 832, 336)
  glass(1216, 556, 176); glass(1480, 556, 72)
  door('door-open-down', 1392, 552, '茶水间入口 · 已打开')
  door('door-open-right', 1200, 944, '厕所入口 · 已打开')
  room('pantry', '茶水间', 'pantry', 3, { x: 1216, y: 568, width: 336, height: 264 }, { x: 1416, y: 704 })
  room('restroom', '厕所', 'restroom', 1, { x: 1216, y: 848, width: 336, height: 304 }, { x: 1376, y: 1016 })
  add('coffee-counter-top', 1248, 624, { name: '茶水间 / 咖啡机与烧水壶' })
  add('cabinet-top', 1248, 784, { rotation: 180, name: '茶水间 / 储物柜' })
  add('basin-top', 1392, 784, { rotation: 180, name: '茶水间 / 清洗台' })
  add('water-dispenser-top', 1480, 776, { name: '茶水间 / 饮水机' })
  add('toilet-top', 1488, 872, { name: '厕所 / 座便器' })
  add('basin-top', 1248, 1096, { rotation: 180, name: '厕所 / 洗手台' })

  add('sofa-top', 96, 1040, { name: '公共区 / 等候沙发' })
  add('plant-top', 304, 1056, { name: '公共区 / 盆栽' })
  add('cabinet-top', 416, 1064, { name: '工位区 / 资料柜' })
  add('plant-top', 1096, 1088, { name: '主通道 / 盆栽' })
  add('plant-top', 1104, 576, { name: '主通道 / 盆栽' })

  // 绿植与摆件（扩充图元）。放在原有元素之后，已有元素的 id 不变。位置避开门洞/门扇摆动区、桌椅与行走通路。
  // 会议室：四角绿植 + 会议桌上的桌面摆件（多肉/仙人掌落在桌中线与桌端圆点之间）
  const corner = (templateId, x, y, name) => add(templateId, x, y, { name })
  corner('plant-monstera-top', 56, 52, '会议室A / 角落龟背竹'); corner('plant-palm-top', 408, 52, '会议室A / 角落散尾葵'); corner('plant-bush-top', 60, 344, '会议室A / 角落灌木')
  corner('plant-fern-top', 508, 56, '会议室B / 角落蕨类'); corner('plant-palm-top', 972, 52, '会议室B / 角落散尾葵'); corner('plant-bush-top', 508, 344, '会议室B / 角落灌木'); corner('plant-fern-top', 984, 336, '会议室B / 角落蕨类')
  corner('plant-monstera-top', 1064, 52, '会议室C / 角落龟背竹'); corner('plant-fern-top', 1488, 56, '会议室C / 角落蕨类'); corner('plant-palm-top', 1064, 334, '会议室C / 角落散尾葵'); corner('plant-bush-top', 1496, 344, '会议室C / 角落灌木')
  for (const [x, succulent, cactus, name] of [[136, 176, 288, '会议室A'], [640, 690, 814, '会议室B'], [1152, 1192, 1302, '会议室C']]) {
    corner('plant-succulent-top', succulent, 206, `${name} / 会议桌多肉`)
    corner('plant-cactus-top', cactus, 206, `${name} / 会议桌仙人掌`)
  }
  // 中央走道：北侧玻璃隔断下的绿篱花槽，避开三间会议室的门口
  for (const x of [96, 584, 1120]) corner('planter-hedge-top', x, 412, '主通道 / 绿篱花槽')
  // 工位区右侧阅读角：圆地毯 + 圆茶几 + 单人沙发（朝北）+ 边几台灯；北面是原有盆栽
  add('rug-round-top', 1060, 690, { name: '阅读角 / 圆形地毯' })
  add('coffee-table-top', 1076, 706, { name: '阅读角 / 圆茶几' })
  add('armchair-top', 1072, 800, { rotation: 180, name: '阅读角 / 单人沙发' })
  add('side-table-top', 1148, 812, { name: '阅读角 / 边几台灯' })
  // 工位区左下：落地灯、资料柜旁的打印机和垃圾桶；入口大厅的长凳
  add('floor-lamp-top', 58, 1062, { name: '公共区 / 落地灯' })
  add('printer-top', 544, 1064, { name: '工位区 / 打印机' })
  add('trash-bin-top', 610, 1086, { name: '工位区 / 垃圾桶' })
  add('bench-top', 872, 1112, { name: '入口大厅 / 长凳' })
  // 茶水间与厕所
  add('trash-bin-top', 1510, 588, { name: '茶水间 / 垃圾桶' })
  add('bench-top', 1474, 682, { rotation: 90, name: '茶水间 / 长凳' })
  add('plant-palm-top', 1480, 1076, { name: '厕所 / 散尾葵' })
  map.zones.push({ id: 'zone-spawn', name: '入口内侧 / 员工出生候选区', type: 'spawn', points: [{ x: 832, y: 1040 }, { x: 1056, y: 1040 }, { x: 1056, y: 1104 }, { x: 832, y: 1104 }], enabled: true, visible: false, locked: true })
  map.layout = { styleId: 'topdown-soft', occupants: 10, entrance: { x: 764, y: 1184 }, spawnPoint: { x: 944, y: 1072 }, mainAisle: { x: 48, y: 416, width: 1504, height: 136 }, notes: ['10个独立工位；会议室容量4/6/4不计入常驻工位。', '全部门为打开态，门洞与门扇占地分离。', '工位桌与电脑是分开的两个图元：员工坐桌左、独立电脑图元在桌右，屏幕区域可供后续显示工作内容；办公椅与员工动画复用AIFred现有资源，会议家具保留俯视素材；角色是演示员工，不连接账号或实时状态。', '像素布局用于软件编辑与寻路演示，未经建筑/消防/无障碍合规审查。'] }
  // 自由活动目的地锚点：先按房间自动生成（茶水间 / 厕所 / 会议室），再补过道与大厅锚点。
  // 这些锚点就是前端“闲置员工每 30 秒出门走走”的落点，均可在编辑器里拖动、改名、调步速或禁用。
  syncSpots(map)
  const aisle = map.layout.mainAisle
  for (const [label, ratio] of [['西', 0.22], ['中', 0.5], ['东', 0.78]]) {
    map.spots.push({ id: `spot-corridor-${label}`, name: `中央走道（${label}）`, kind: 'corridor', x: Math.round(aisle.x + aisle.width * ratio), y: Math.round(aisle.y + aisle.height / 2), speed: SPOT_SPEEDS.corridor, stay: 6, enabled: true })
  }
  map.spots.push({ id: 'spot-corridor-hall', name: '大厅通道', kind: 'corridor', x: map.layout.spawnPoint.x, y: map.layout.spawnPoint.y, speed: SPOT_SPEEDS.corridor, stay: 6, enabled: true })
  syncSeats(map)
  return validateMap(map)
}
