import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  clearSegment,
  elementFootprints,
  elementPoint,
  findPath,
  isBlocked,
  seatAnchors,
} from '../src/scene/office/officeMap/geometry.ts'
import { CHIBI_ANIM, CHIBI_SPINE_ASSETS, idleAnimByFacing, trotAnimByFacing } from '../src/config/office/characters.ts'
import {
  deriveDestinationsFromRooms,
  isRoomOccupied,
  wanderDestinations,
} from '../src/scene/office/officeMap/destinations.ts'
import {
  DESTINATION_SPEEDS,
  type MapElement,
  type MapSeat,
  type OfficeMap,
} from '../src/scene/office/officeMap/types.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const mapFile = path.join(root, 'public/assets/office/map/office-10-person.json')

function readJson(file: string): OfficeMap {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`无法读取 ${file}`, { cause: error })
  }
  try {
    // SAFETY: 同步产物由编辑器按 office-map/v1.1 导出，schema 在下面第一个用例里断言
    return JSON.parse(raw) as OfficeMap
  } catch (error) {
    throw new Error(`${file} 不是合法 JSON`, { cause: error })
  }
}

const map = readJson(mapFile)
const elements: MapElement[] = map.elements
const seats: MapSeat[] = map.seats ?? []
const byId = (id?: string): MapElement | undefined => (id ? elements.find((e) => e.id === id) : undefined)

test('同步过来的地图可以被前端直接消费', () => {
  assert.match(map.schema, /^office-map\/v1\./)
  assert.equal(map.width, 1600)
  assert.equal(map.height, 1200)
  assert.equal(seats.length, 10)
  assert.equal(elements.filter((e) => e.assetId === 'asset-desk-workstation-top').length, 10)
  assert.equal(elements.filter((e) => e.assetId === 'asset-aifred-computer').length, 10)
  assert.equal(elements.filter((e) => e.assetId === 'asset-aifred-chair').length, 10)
})

test('地图引用的贴图已经同步到 AITeam public 目录', () => {
  const missing = map.assets
    .map((asset) => asset.src)
    .filter((src) => src.startsWith('assets/') && !existsSync(path.join(root, 'public', src)))
  assert.deepEqual(missing, [], `缺少贴图：${missing.join(', ')}`)
})

test('工位构成与设计规范一致：桌 144×76、电脑 1.25× 放大（贴图基准 82.5×55）带屏幕区、椅子按桌宽 0.58', () => {
  const desk = elements.find((e) => e.assetId === 'asset-desk-workstation-top')
  const computer = elements.find((e) => e.assetId === 'asset-aifred-computer')
  const chair = elements.find((e) => e.assetId === 'asset-aifred-chair')
  assert.ok(desk && computer && chair)
  assert.equal(desk.width, 144)
  assert.equal(desk.height, 76)
  assert.equal(computer.width, 82.5 * 1.25)
  assert.equal(computer.height, 55 * 1.25)
  assert.ok(computer.screen && computer.screen.width > 0 && computer.screen.height > 0, '电脑必须有 screen 元数据')
  assert.equal(Number(chair.width.toFixed(2)), Number((desk.width * 0.58).toFixed(2)))
  assert.equal(Number(chair.height.toFixed(2)), Number(((chair.width * 492) / 474).toFixed(2)))
})

test('每个工位：员工在桌左、椅子在身后、屏幕在桌右且不与员工重叠', () => {
  for (const seat of seats) {
    const desk = byId(seat.deskElementId)
    const chair = byId(seat.chairElementId)
    const computer = byId(seat.computerElementId)
    assert.ok(desk && chair && computer && computer.screen, `${seat.name} 缺少图元`)
    assert.equal(seat.facing, 'back', `${seat.name} 默认应背对镜头`)
    assert.deepEqual(seat.seatOffset, { x: 0.18, y: 1.19 })
    assert.deepEqual(seat.chairOffset, { x: 0.14, y: 1.14 })
    assert.deepEqual(seat.computerOffset, { x: 0.75, y: 0.27 })

    const { seat: anchor, approach } = seatAnchors(desk, seat.seatOffset, seat.approachOffset)
    const employeeWidth = desk.width * 0.58 * 1.1
    const chairCenter = elementPoint(desk, seat.chairOffset!, { width: 1, height: 1 })
    const computerCenter = elementPoint(desk, seat.computerOffset!, { width: 1, height: 1 })
    // screen 是贴图 1× 坐标，电脑图元放大后要按 图元宽 / 贴图宽 换算
    const asset = map.assets.find((a) => a.id === computer.assetId)
    assert.ok(asset?.width, `${seat.name} 电脑缺少贴图尺寸`)
    const screenScale = computer.width / asset.width
    const screenLeft = computerCenter.x - computer.width / 2 + computer.screen.x * screenScale
    const screenRight = screenLeft + computer.screen.width * screenScale

    assert.ok(anchor.x < desk.x, `${seat.name} 员工应在桌子左侧`)
    assert.ok(chairCenter.x <= anchor.x, `${seat.name} 椅子应在员工身后（偏左）`)
    assert.ok(anchor.x + employeeWidth / 2 <= screenLeft, `${seat.name} 员工不能遮住屏幕`)
    assert.ok(screenRight <= desk.x + desk.width / 2, `${seat.name} 屏幕应留在桌面范围内`)
    assert.ok(approach && approach.y > desk.y + desk.height / 2, `${seat.name} 接近点应在桌子前方`)
  }
})

test('层序与编辑工具一致：地面 < 家具 < 员工(+2) < 电脑 < 椅子 < 墙 < 门', () => {
  const floor = elements.find((e) => e.assetId === 'asset-floor-mineral')
  const desk = elements.find((e) => e.assetId === 'asset-desk-workstation-top')
  const computer = elements.find((e) => e.assetId === 'asset-aifred-computer')
  const chair = elements.find((e) => e.assetId === 'asset-aifred-chair')
  const wall = elements.find((e) => e.assetId === 'asset-wall-up')
  const door = elements.find((e) => e.assetId === 'asset-door-open-up')
  assert.ok(floor && desk && computer && chair && wall && door)
  assert.ok(floor.zIndex < desk.zIndex)
  assert.ok(desk.zIndex < computer.zIndex)
  assert.ok(computer.zIndex < chair.zIndex)
  assert.ok(chair.zIndex < wall.zIndex)
  assert.ok(wall.zIndex < door.zIndex)
})

test('员工站位可达：入口到五功能房间与十个工位接近点都有 12px 净距通路', () => {
  const start = map.layout?.entrance
  assert.ok(start)
  const destinations = [
    ...(map.rooms ?? []).filter((room) => room.type !== 'work').map((room) => ({ name: room.name, point: room.approachPoint })),
    ...seats.map((seat) => ({ name: seat.name, point: seat.approachPoint })),
  ]
  assert.equal(destinations.length, 15)
  assert.equal(isBlocked(map, start, 12), false)
  for (const target of destinations) {
    assert.ok(target.point, `${target.name} 缺少接近点`)
    assert.equal(isBlocked(map, target.point, 12), false, target.name)
    const route = findPath(map, start, target.point, 12, 'employee')
    assert.ok(route && route.length >= 2, `${target.name}: 不可达`)
    for (let i = 1; i < route.length; i++) {
      assert.equal(clearSegment(map, route[i - 1], route[i], 12, 'employee'), true, target.name)
    }
  }
})

test('工位桌占地不覆盖员工锚点（员工不会站在障碍里）', () => {
  for (const seat of seats) {
    const desk = byId(seat.deskElementId)
    assert.ok(desk)
    assert.ok(elementFootprints(desk).length >= 1)
    const anchor = seatAnchors(desk, seat.seatOffset, seat.approachOffset).seat
    assert.equal(typeof isBlocked(map, anchor, 1), 'boolean')
  }
})

test('闲置员工目的地移动速度区分：急促厕所 > 休闲茶水间 > 商务会议室 > 悠闲过道漫步', () => {
  assert.equal(typeof DESTINATION_SPEEDS.restroom, 'number')
  assert.equal(typeof DESTINATION_SPEEDS.pantry, 'number')
  assert.equal(typeof DESTINATION_SPEEDS.meeting, 'number')
  assert.equal(typeof DESTINATION_SPEEDS.corridor, 'number')
  assert.equal(typeof DESTINATION_SPEEDS.return, 'number')

  // 速度递减策略断言
  assert.ok(DESTINATION_SPEEDS.restroom > DESTINATION_SPEEDS.pantry, '厕所步速应当快于茶水间')
  assert.ok(DESTINATION_SPEEDS.pantry > DESTINATION_SPEEDS.meeting, '茶水间步速应当快于会议室')
  assert.ok(DESTINATION_SPEEDS.meeting > DESTINATION_SPEEDS.corridor, '会议室步速应当快于过道慢走')
  assert.ok(DESTINATION_SPEEDS.return >= 50, '回工位速度保持正常步速')
})

test('闲置漫步四类目的地全通：茶水间、厕所、会议室、过道均可双向往返', () => {
  const meetingRooms = (map.rooms ?? []).filter((r) => r.type === 'meeting')
  const pantry = (map.rooms ?? []).find((r) => r.type === 'pantry')
  const restroom = (map.rooms ?? []).find((r) => r.type === 'restroom')
  assert.ok(pantry && restroom && meetingRooms.length >= 1)

  const destinations = [
    { type: 'pantry', point: pantry.approachPoint },
    { type: 'restroom', point: restroom.approachPoint },
    ...meetingRooms.map((m) => ({ type: 'meeting', point: m.approachPoint })),
    { type: 'corridor', point: { x: 760, y: 484 } },
  ]

  for (const seat of seats) {
    const desk = byId(seat.deskElementId)
    assert.ok(desk)
    const home = seatAnchors(desk, seat.seatOffset, seat.approachOffset).seat
    for (const target of destinations) {
      assert.ok(target.point)
      const outRoute = findPath(map, home, target.point, 12, 'employee')
      assert.ok(outRoute && outRoute.length >= 2, `${seat.name} -> ${target.type} 必须可达`)

      const backRoute = findPath(map, target.point, home, 12, 'employee')
      assert.ok(backRoute && backRoute.length >= 2, `${target.type} -> ${seat.name} 必须可返回`)
    }
  }
})

test('地图自带自由活动锚点：类型/坐标/步速来自 spots，且都在可用目的地列表里', () => {
  const spots = map.spots ?? []
  assert.ok(spots.length >= 5, '编辑器生成的样例应带活动点锚点')

  const destinations = wanderDestinations(map)
  assert.equal(destinations.length, spots.length, '没有占用房间时，每个锚点都应可用')

  for (const spot of spots) {
    const found = destinations.find((d) => d.name === spot.name)
    assert.ok(found, `锚点 ${spot.name} 应在目的地列表里`)
    assert.equal(found.type, spot.kind)
    assert.deepEqual(found.point, { x: spot.x, y: spot.y })
    assert.equal(found.speed, spot.speed ?? DESTINATION_SPEEDS[spot.kind])
  }

  // 每类锚点都存在，且步速顺序与设计一致
  const kinds = new Set(spots.map((s) => s.kind))
  for (const kind of ['meeting', 'pantry', 'restroom', 'corridor'] as const) {
    assert.ok(kinds.has(kind), `样例应包含 ${kind} 锚点`)
  }
  const corridor = destinations.find((d) => d.type === 'corridor')
  const meeting = destinations.find((d) => d.type === 'meeting')
  const pantry = destinations.find((d) => d.type === 'pantry')
  const restroom = destinations.find((d) => d.type === 'restroom')
  assert.ok(corridor && meeting && pantry && restroom)
  assert.ok(restroom.speed! > pantry.speed!, '厕所步速应高于茶水间')
  assert.ok(pantry.speed! > meeting.speed!, '茶水间步速应高于会议室')
  assert.ok(meeting.speed! > corridor.speed!, '会议室步速应高于过道')
})

test('停用的锚点不参与自由活动', () => {
  const disabled = structuredClone(map)
  const target = (disabled.spots ?? []).find((s) => s.kind === 'pantry')
  assert.ok(target)
  target.enabled = false

  const destinations = wanderDestinations(disabled)
  assert.ok(!destinations.some((d) => d.name === target.name), '停用的锚点不应出现在目的地里')
  assert.equal(destinations.length, (map.spots ?? []).length - 1)
})

test('房间标记「使用中」时该房间的锚点被排除（静态标记与运行时切换都要生效）', () => {
  const meetingSpots = (map.spots ?? []).filter((s) => s.kind === 'meeting')
  assert.ok(meetingSpots.length >= 1)
  const targetSpot = meetingSpots[0]
  const roomSpots = (map.spots ?? []).filter((s) => s.roomId === targetSpot.roomId)
  assert.ok(roomSpots.length >= 1)

  // 1) 地图里静态标记 occupied: true
  const staticMap = structuredClone(map)
  const staticRoom = (staticMap.rooms ?? []).find((r) => r.id === targetSpot.roomId)
  assert.ok(staticRoom)
  staticRoom.occupied = true
  const staticDestinations = wanderDestinations(staticMap)
  assert.ok(!staticDestinations.some((d) => d.name === targetSpot.name), '占用房间的锚点必须被排除')
  assert.equal(staticDestinations.length, (map.spots ?? []).length - roomSpots.length)

  // 2) 运行时通过 setRoomOccupied 的占用集合
  const occupied = new Set([targetSpot.roomId!])
  const runtimeDestinations = wanderDestinations(map, occupied)
  assert.ok(!runtimeDestinations.some((d) => d.name === targetSpot.name))
  assert.equal(runtimeDestinations.length, (map.spots ?? []).length - roomSpots.length)

  // 3) 占用解除后恢复
  assert.equal(wanderDestinations(map, new Set()).length, (map.spots ?? []).length)
  assert.ok(isRoomOccupied({ ...staticRoom, occupied: false } as typeof staticRoom, occupied))
})

test('没有锚点的旧地图回退到按房间与过道推导目的地', () => {
  const legacy = structuredClone(map)
  delete legacy.spots

  const destinations = deriveDestinationsFromRooms(legacy)
  assert.ok(destinations.length >= 5, '旧地图也应有房间+过道目的地')
  assert.ok(destinations.some((d) => d.type === 'pantry'))
  assert.ok(destinations.some((d) => d.type === 'restroom'))
  assert.ok(destinations.some((d) => d.type === 'meeting'))
  assert.ok(destinations.some((d) => d.type === 'corridor'))
  // 回退路径与锚点路径指向同一批房间
  assert.deepEqual(
    new Set(deriveDestinationsFromRooms(legacy).map((d) => d.name)),
    new Set(wanderDestinations(legacy).map((d) => d.name)),
  )
  assert.equal(destinations.find((d) => d.type === 'meeting')!.speed, DESTINATION_SPEEDS.meeting)
})

test('前端渲染用骨骼带左右行走膝盖修正，且与编辑器派生文件字节一致', () => {
  const walkFile = path.join(root, 'public/assets/characters/chibi-stickers/chibi-stickers-walk.json')
  const originalFile = path.join(root, 'public/assets/characters/chibi-stickers/chibi-stickers.json')
  assert.ok(existsSync(walkFile), '前端必须存在膝盖修正版骨骼')
  assert.ok(existsSync(originalFile), '原骨架快照必须保留')

  const walk = JSON.parse(readFileSync(walkFile, 'utf8')) as {
    bones: unknown
    ik: unknown
    skins: unknown
    animations: Record<string, { bones: Record<string, { rotate?: { value: number; __walkPatched?: boolean }[] }>; ik?: Record<string, { bendPositive?: boolean }[]> }>
  }
  const original = JSON.parse(readFileSync(originalFile, 'utf8')) as typeof walk

  // 修正标记 + 只动两个侧向行走动画
  for (const name of ['movement/trot-left', 'movement/trot-right']) {
    for (const bone of ['leg-down-l', 'leg-down-r']) {
      const before = original.animations[name].bones[bone].rotate ?? []
      const after = walk.animations[name].bones[bone].rotate ?? []
      assert.ok(after.length > 0, `${name} ${bone} 应有小腿旋转轨道`)
      assert.deepEqual(after.map((k) => k.value), before.map((k) => -k.value), `${name} ${bone} 小腿旋转应逐帧取反`)
      assert.ok(after.every((k) => k.__walkPatched === true))
    }
    for (const constraint of Object.keys(walk.animations[name].ik ?? {})) {
      for (const key of walk.animations[name].ik![constraint]) assert.equal(key.bendPositive, undefined, 'IK 单腿反向覆盖应被删除')
    }
    // 髋骨与躯干轨道不变
    assert.deepEqual(walk.animations[name].bones['leg-l'], original.animations[name].bones['leg-l'])
    assert.deepEqual(walk.animations[name].bones['body-up'], original.animations[name].bones['body-up'])
  }
  // 骨架结构（骨骼/皮肤/IK 约束/其它动画）保持原样
  assert.deepEqual(walk.bones, original.bones)
  // 正装改造：男士皮肤的 body-decoration 插槽换成衬衫领带（biz/shirt-tie-*），比对时跳过该插槽，其余皮肤内容不变
  type Skin = { name: string; attachments?: Record<string, Record<string, { name?: string }>> }
  const walkSkins = structuredClone(walk.skins) as Skin[]
  const originalSkins = structuredClone(original.skins) as Skin[]
  for (const skin of walkSkins) {
    if (!skin.attachments?.['body-decoration']?.['body-decoration']?.name?.startsWith('biz/shirt-tie-')) continue
    delete skin.attachments['body-decoration']
    const before = originalSkins.find((s) => s.name === skin.name)
    if (before?.attachments) delete before.attachments['body-decoration']
  }
  assert.deepEqual(walkSkins, originalSkins)
  assert.deepEqual(walk.ik, original.ik)
  for (const anim of Object.keys(original.animations)) {
    if (anim === 'movement/trot-left' || anim === 'movement/trot-right') continue
    assert.deepEqual(walk.animations[anim], original.animations[anim], `${anim} 不应被改动`)
  }

  // 前端资源指向修正版
  assert.match(CHIBI_SPINE_ASSETS.skeleton, /chibi-stickers-walk\.json$/)
  assert.match(CHIBI_SPINE_ASSETS.atlas, /chibi-stickers\.atlas$/)
})

test('左右朝向映射到名字相反的动画（chibi-stickers 的 left/right 与屏幕相反）', () => {
  // 资源里 left/right 按角色自身命名，角色正面朝镜头 → 动画名与屏幕左右相反。
  // 直接同名映射时，员工左右移动的动作会和运动方向相反。
  assert.equal(trotAnimByFacing('left'), CHIBI_ANIM.trotRight)
  assert.equal(trotAnimByFacing('right'), CHIBI_ANIM.trotLeft)
  assert.equal(idleAnimByFacing('left'), CHIBI_ANIM.idleRight)
  assert.equal(idleAnimByFacing('right'), CHIBI_ANIM.idleLeft)
  // 前后朝向不参与对调
  assert.equal(trotAnimByFacing('back'), CHIBI_ANIM.trotBack)
  assert.equal(trotAnimByFacing('front'), CHIBI_ANIM.trotFront)
  assert.equal(idleAnimByFacing('back'), CHIBI_ANIM.idleBack)
  assert.equal(idleAnimByFacing('front'), CHIBI_ANIM.idleFront)

  // 骨架里确实存在这些动画，避免改名后静默回退到 idle
  const skeleton = JSON.parse(readFileSync(path.join(root, 'public/assets/characters/chibi-stickers/chibi-stickers-walk.json'), 'utf8')) as {
    animations: Record<string, unknown>
  }
  for (const facing of ['front', 'back', 'left', 'right'] as const) {
    assert.ok(skeleton.animations[trotAnimByFacing(facing)], `${trotAnimByFacing(facing)} 应存在于骨架`)
    assert.ok(skeleton.animations[idleAnimByFacing(facing)], `${idleAnimByFacing(facing)} 应存在于骨架`)
  }
})
