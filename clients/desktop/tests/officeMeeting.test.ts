import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { blockers, findPath, isBlocked, seatAnchors } from '../src/scene/office/officeMap/geometry.ts'
import { pointInRect } from '../src/scene/office/officeMap/destinations.ts'
import {
  assignSeats,
  VISIT_LEFT_GAPS,
  isMeetingRoom,
  meetingSeatingPlan,
  meetingSpots,
  meetingTableCenter,
  pickMeetingRoom,
  visitSpot,
} from '../src/scene/office/officeMap/meeting.ts'
import type { MapPoint, MapRoom, OfficeMap } from '../src/scene/office/officeMap/types.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

function readMap(): OfficeMap {
  const file = path.join(root, 'public/assets/office/map/office-10-person.json')
  try {
    // SAFETY: 同步产物由编辑器按 office-map/v1.1 导出，schema 在 officeMapScene.test.ts 里断言
    return JSON.parse(readFileSync(file, 'utf8')) as OfficeMap
  } catch (error) {
    throw new Error(`无法读取 ${file}`, { cause: error })
  }
}

const map = readMap()
const polygons = blockers(map, 'employee')
const blockedAt = (p: MapPoint) => isBlocked(map, p, 12, 'employee', polygons)
const room = (id: string): MapRoom => {
  const found = map.rooms?.find((r) => r.id === id)
  assert.ok(found, `地图缺少房间 ${id}`)
  return found
}
const none = new Set<string>()

test('会议室识别：只认会议类房间', () => {
  const meetingRooms = (map.rooms ?? []).filter(isMeetingRoom).map((r) => r.id)
  assert.deepEqual(meetingRooms, ['room-meeting-a', 'room-meeting-b', 'room-meeting-c'])
})

test('会议座位：来自会议椅，面向会议桌；不把工位椅当会议椅', () => {
  const a = meetingSpots(map, room('room-meeting-a'))
  const chairs = a.filter((s) => s.chairId)
  assert.equal(chairs.length, 4, '会议室 A 有 4 把会议椅')
  assert.ok(chairs.every((s) => !s.chairId?.includes('aifred')))
  const center = meetingTableCenter(map, room('room-meeting-a'))
  for (const spot of chairs) {
    // 北侧椅子在桌子上方，面向桌子 = 面朝镜头（front）；南侧反之
    assert.equal(spot.facing, spot.point.y < center.y ? 'front' : 'back')
  }
  assert.equal(meetingSpots(map, room('room-meeting-b')).filter((s) => s.chairId).length, 6)
})

test('选会议室：够坐的里选最小的；没空房选不了；占用的不选', () => {
  assert.equal(pickMeetingRoom(map, 2, none)?.id, 'room-meeting-a')
  assert.equal(pickMeetingRoom(map, 5, none)?.id, 'room-meeting-b', '5 人只有 B 够坐')
  assert.equal(pickMeetingRoom(map, 9, none)?.id, 'room-meeting-b', '都坐不下时选最大的，多出来的站着')
  assert.equal(pickMeetingRoom(map, 3, new Set(['room-meeting-a']))?.id, 'room-meeting-c')
  assert.equal(pickMeetingRoom(map, 3, new Set(['room-meeting-a', 'room-meeting-b', 'room-meeting-c'])), null)
})

test('选会议室：地图静态标记「使用中」的房间也不选', () => {
  const copy: OfficeMap = { ...map, rooms: map.rooms?.map((r) => (r.id === 'room-meeting-a' ? { ...r, occupied: true } : r)) }
  assert.equal(pickMeetingRoom(copy, 2, none)?.id, 'room-meeting-c')
})

test('座位方案：不重叠、不进障碍、都在房间内；座位不够时溢出的人围桌站着并让开门口', () => {
  for (const [id, headcount] of [['room-meeting-a', 3], ['room-meeting-b', 6], ['room-meeting-b', 9], ['room-meeting-c', 4]] as const) {
    const meetingRoom = room(id)
    const plan = meetingSeatingPlan(map, meetingRoom, headcount, blockedAt)
    assert.equal(plan.length, headcount, `${id} ${headcount} 人`)
    for (const spot of plan) {
      assert.ok(!blockedAt(spot.point), `${id} 站位 ${JSON.stringify(spot.point)} 落在障碍里`)
      assert.ok(pointInRect(spot.point, meetingRoom.bounds), `${id} 站位在房间外`)
      if (!spot.chairId && meetingRoom.approachPoint) {
        assert.ok(Math.hypot(spot.point.x - meetingRoom.approachPoint.x, spot.point.y - meetingRoom.approachPoint.y) >= 72 || headcount <= meetingRoom.capacity, '溢出的人不挡门口')
      }
    }
    for (let i = 0; i < plan.length; i++) {
      for (let j = i + 1; j < plan.length; j++) {
        assert.ok(Math.hypot(plan[i].point.x - plan[j].point.x, plan[i].point.y - plan[j].point.y) >= 30, `${id} 两个站位挨得太近`)
      }
    }
  }
})

test('每个工位的接近点到每间会议室的每个座位都有通路（人一定走得进去）', () => {
  for (const meetingRoom of (map.rooms ?? []).filter(isMeetingRoom)) {
    const plan = meetingSeatingPlan(map, meetingRoom, 9, blockedAt)
    for (const seat of map.seats ?? []) {
      const from = seat.approachPoint
      assert.ok(from)
      for (const spot of plan) {
        assert.ok(findPath(map, from, spot.point, 12), `${seat.id} → ${meetingRoom.id} ${JSON.stringify(spot.point)} 没有通路`)
      }
    }
  }
})

test('入座分配：一人一座、不重复，近的人坐近的位置', () => {
  const plan = meetingSeatingPlan(map, room('room-meeting-b'), 4, blockedAt)
  const members = [
    { id: 'west', from: { x: 560, y: 360 } },
    { id: 'east', from: { x: 860, y: 360 } },
    { id: 'mid1', from: { x: 700, y: 360 } },
    { id: 'mid2', from: { x: 780, y: 360 } },
  ]
  const assigned = assignSeats(members, plan)
  assert.equal(assigned.size, 4)
  assert.equal(new Set([...assigned.values()].map((s) => `${s.point.x},${s.point.y}`)).size, 4)
  // 西边的人不该被派到比东边的人更远的东侧座位
  assert.ok(assigned.get('west')!.point.x <= assigned.get('east')!.point.x)
})

/** 工位 → visitSpot 需要的主人信息（含椅子） */
function hostOf(seatIndex: number) {
  const seat = map.seats?.[seatIndex]
  assert.ok(seat, `地图缺少工位 ${seatIndex}`)
  const desk = map.elements.find((e) => e.id === seat.deskElementId)
  const chairEl = map.elements.find((e) => e.id === seat.chairElementId)
  assert.ok(desk && chairEl, `${seat.id} 缺少桌子或椅子`)
  const anchors = seatAnchors(desk, seat.seatOffset, seat.approachOffset)
  const chair = { x: chairEl.x, y: chairEl.y, width: chairEl.width }
  return { seat, chairEl, chair, host: { home: anchors.seat, approach: anchors.approach, chair } }
}

test('串门站位：A @ B 时站在 B 的椅子左边——同一排、紧挨椅子左缘、面向 B', () => {
  for (let i = 0; i < (map.seats?.length ?? 0); i++) {
    const { seat, chairEl, host } = hostOf(i)
    const spot = visitSpot(map, host, [], blockedAt)
    assert.ok(spot, `${seat.id} 没有串门站位`)
    const leftEdge = chairEl.x - chairEl.width / 2
    assert.ok(spot.point.x < leftEdge, `${seat.id} 站位 x=${spot.point.x} 不在椅子左边（椅子左缘 ${leftEdge}）`)
    assert.ok(leftEdge - spot.point.x <= 20, `${seat.id} 离椅子太远：${leftEdge - spot.point.x}px`)
    assert.equal(spot.point.y, host.home.y, `${seat.id} 应与主人同一排`)
    assert.ok(!blockedAt(spot.point), `${seat.id} 站位落在障碍里`)
    assert.equal(spot.facing, 'right', `${seat.id} 站在主人左边，应面朝右（面向主人）`)
  }
})

test('串门站位：第二位访客接着往左排，不叠在第一位身上；最左一列贴墙左边放不下时才退回过道', () => {
  for (let i = 0; i < (map.seats?.length ?? 0); i++) {
    const { seat, chair, host } = hostOf(i)
    const leftEdge = chair.x - chair.width / 2
    const first = visitSpot(map, host, [], blockedAt)
    assert.ok(first)
    const second = visitSpot(map, host, [first.point], blockedAt)
    assert.ok(second, `${seat.id} 第二位访客没有位置`)
    assert.ok(Math.hypot(second.point.x - first.point.x, second.point.y - first.point.y) >= 28, `${seat.id} 两位访客挨得太近`)
    assert.ok(!blockedAt(second.point))
    if (second.point.x >= leftEdge) {
      // 没排在椅子左侧 = 左边确实没有第二个位置了（贴墙 / 离第一位太近）
      const leftStillFree = VISIT_LEFT_GAPS.some((gap) => {
        const point = { x: leftEdge - gap, y: host.home.y }
        return !blockedAt(point) && Math.hypot(point.x - first.point.x, point.y - first.point.y) >= 28
      })
      assert.equal(leftStillFree, false, `${seat.id} 左边明明还有位置，却把第二位安排到了椅子右边 / 过道`)
    }
  }
  // 中间的工位左边宽敞，第二位一定在左边继续排
  const { chair, host } = hostOf(2)
  const first = visitSpot(map, host, [], blockedAt)
  assert.ok(first)
  const second = visitSpot(map, host, [first.point], blockedAt)
  assert.ok(second && second.point.x < first.point.x && second.point.y === first.point.y)
  assert.ok(second.point.x < chair.x - chair.width / 2)
})

test('串门站位：椅子左边整片站不下时，退回工位接近点（过道）而不是没位置', () => {
  const { chair, host } = hostOf(1)
  const leftOfChair = (p: MapPoint) => p.x < chair.x - chair.width / 2 + 1 && Math.abs(p.y - host.home.y) < 30
  const spot = visitSpot(map, host, [], (p) => blockedAt(p) || leftOfChair(p))
  assert.ok(spot, '退路也站不下')
  assert.ok(Math.hypot(spot.point.x - (host.approach?.x ?? 0), spot.point.y - (host.approach?.y ?? 0)) < 1, '应退回接近点')
})

test('串门站位：没有椅子信息时与原来一致（站工位接近点，面向主人工位）', () => {
  const { host } = hostOf(0)
  const spot = visitSpot(map, { home: host.home, approach: host.approach }, [], blockedAt)
  assert.ok(spot && host.approach)
  assert.ok(Math.hypot(spot.point.x - host.approach.x, spot.point.y - host.approach.y) < 1)
  const dx = host.home.x - spot.point.x
  const dy = host.home.y - spot.point.y
  assert.equal(spot.facing, Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'front' : 'back')
})
