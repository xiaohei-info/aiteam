/**
 * 协作站位的纯函数（不依赖 Pixi / DOM，便于单测）：
 * - 会议室：识别房间里的会议椅 / 会议桌，按人数挑选空闲会议室，给成员分配座位；
 * - 串门：A @ B 时 A 站到 B 工位旁的哪个点、朝哪边。
 *
 * 椅子来自地图元素（asset 含 chair 且不是工位椅 aifred-chair，或名称带「座椅」），
 * 桌子来自 asset 含 meeting-table / 名称带「会议桌」；没有椅子的旧地图回退到房间里的 meeting 锚点，再回退到绕桌一圈。
 */
import type { ChibiFacing } from '@/config/office/characters'
import { facingFromDelta, isBlocked } from './geometry.ts'
import { findFreePoint, isPointFree } from './crowd.ts'
import { isRoomOccupied, pointInRect } from './destinations.ts'
import type { MapElement, MapPoint, MapRoom, OfficeMap } from './types.ts'

export interface MeetingSpot {
  point: MapPoint
  /** 入座后朝向（面向会议桌） */
  facing: ChibiFacing
  /** 来自哪个地图元素（椅子）；锚点/环形站位为空 */
  chairId?: string
}

export function isMeetingRoom(room: MapRoom): boolean {
  return room.type === 'meeting' || room.name.includes('会议')
}

function isMeetingChair(element: MapElement): boolean {
  const asset = element.assetId ?? ''
  if (/aifred/i.test(asset)) return false
  return /chair/i.test(asset) || (element.name ?? '').includes('座椅')
}

function isMeetingTable(element: MapElement): boolean {
  return /meeting-table/i.test(element.assetId ?? '') || (element.name ?? '').includes('会议桌')
}

/** 房间里的会议桌中心（多张桌子取平均），没有桌子取房间中心 */
export function meetingTableCenter(map: OfficeMap, room: MapRoom): MapPoint {
  const tables = map.elements.filter((e) => e.visible && isMeetingTable(e) && pointInRect(e, room.bounds))
  if (tables.length === 0) {
    return { x: room.bounds.x + room.bounds.width / 2, y: room.bounds.y + room.bounds.height / 2 }
  }
  return {
    x: tables.reduce((sum, t) => sum + t.x, 0) / tables.length,
    y: tables.reduce((sum, t) => sum + t.y, 0) / tables.length,
  }
}

/** 房间内所有座位：先椅子（面向桌子），再房间 meeting 锚点（离椅子 ≥ 36px 的才算新位置） */
export function meetingSpots(map: OfficeMap, room: MapRoom): MeetingSpot[] {
  const center = meetingTableCenter(map, room)
  const face = (point: MapPoint): ChibiFacing => facingFromDelta(center.x - point.x, center.y - point.y)

  const spots: MeetingSpot[] = map.elements
    .filter((e) => e.visible && isMeetingChair(e) && pointInRect(e, room.bounds))
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((chair) => ({ point: { x: chair.x, y: chair.y }, facing: face(chair), chairId: chair.id }))

  for (const spot of map.spots ?? []) {
    if (spot.enabled === false || spot.kind !== 'meeting') continue
    if (spot.roomId !== room.id && !pointInRect(spot, room.bounds)) continue
    if (spots.some((s) => Math.hypot(s.point.x - spot.x, s.point.y - spot.y) < 36)) continue
    spots.push({ point: { x: spot.x, y: spot.y }, facing: face(spot) })
  }
  return spots
}

/**
 * 给 headcount 个人排站位：座位够就用座位，不够的在房间里找空位站着（面向桌子）。
 * isBlockedAt 用于避开墙和家具；others 是已经被占用的点。
 */
export function meetingSeatingPlan(
  map: OfficeMap,
  room: MapRoom,
  headcount: number,
  isBlockedAt: (point: MapPoint) => boolean,
): MeetingSpot[] {
  const spots = meetingSpots(map, room).filter((spot) => !isBlockedAt(spot.point))
  const center = meetingTableCenter(map, room)
  const plan = spots.slice(0, headcount)
  const taken = plan.map((s) => s.point)
  // 溢出的人围着会议桌站；门口（approachPoint）要让出来，不然把进出的路堵死
  const door = room.approachPoint
  const unusable = (p: MapPoint) =>
    isBlockedAt(p) || !pointInRect(p, room.bounds) || (door !== undefined && Math.hypot(p.x - door.x, p.y - door.y) < 72)
  while (plan.length < headcount) {
    const free = findFreePoint(center, taken, unusable, 36, 220, 24)
    if (!free) break
    taken.push(free)
    plan.push({ point: free, facing: facingFromDelta(center.x - free.x, center.y - free.y) })
  }
  return plan
}

/**
 * 按人数挑会议室：只考虑空闲的会议室；够坐的里选最小的（别用大会议室开小会），
 * 都坐不下就选最大的（多出来的站着）；tie 时离成员重心近的优先。没有空闲会议室返回 null。
 */
export function pickMeetingRoom(
  map: OfficeMap,
  headcount: number,
  occupied: ReadonlySet<string>,
  members: readonly MapPoint[] = [],
): MapRoom | null {
  const free = (map.rooms ?? []).filter((room) => isMeetingRoom(room) && !isRoomOccupied(room, occupied))
  if (free.length === 0) return null
  // 容量以地图里的 capacity 为准；会议桌两端的锚点只是溢出时的站位，不算座位
  const seats = (room: MapRoom) => (room.capacity > 0 ? room.capacity : meetingSpots(map, room).length)
  const centroid = members.length
    ? { x: members.reduce((s, p) => s + p.x, 0) / members.length, y: members.reduce((s, p) => s + p.y, 0) / members.length }
    : null
  const distance = (room: MapRoom) => {
    const point = room.approachPoint ?? { x: room.bounds.x + room.bounds.width / 2, y: room.bounds.y + room.bounds.height / 2 }
    return centroid ? Math.hypot(point.x - centroid.x, point.y - centroid.y) : 0
  }
  const fits = free.filter((room) => seats(room) >= headcount)
  const pool = fits.length ? fits : free
  return [...pool].sort((a, b) => {
    if (fits.length) {
      if (seats(a) !== seats(b)) return seats(a) - seats(b)
    } else if (seats(a) !== seats(b)) {
      return seats(b) - seats(a)
    }
    return distance(a) - distance(b) || a.id.localeCompare(b.id)
  })[0]
}

/**
 * 成员 → 座位的贪心匹配：按「人到座位」的距离从近到远逐对确定，减少交叉走动。
 * 返回与 members 同序的站位。
 */
export function assignSeats<T extends { id: string; from: MapPoint }>(
  members: readonly T[],
  spots: readonly MeetingSpot[],
): Map<string, MeetingSpot> {
  const pairs: { id: string; spot: number; d: number }[] = []
  for (const member of members) {
    spots.forEach((spot, index) => {
      pairs.push({ id: member.id, spot: index, d: Math.hypot(spot.point.x - member.from.x, spot.point.y - member.from.y) })
    })
  }
  pairs.sort((a, b) => a.d - b.d || a.id.localeCompare(b.id) || a.spot - b.spot)
  const result = new Map<string, MeetingSpot>()
  const used = new Set<number>()
  for (const pair of pairs) {
    if (result.has(pair.id) || used.has(pair.spot)) continue
    result.set(pair.id, spots[pair.spot])
    used.add(pair.spot)
  }
  return result
}

/** 站在椅子左边时，离椅子精灵左边缘的距离候选（px，由近到远）；有第二位访客时依次往左排 */
export const VISIT_LEFT_GAPS: readonly number[] = [8, 16, 26, 38, 52]

export interface VisitHost {
  home: MapPoint
  approach: MapPoint | null
  /** 主人的椅子（世界坐标中心 + 精灵宽度）；有就站在它左边，没有就退回工位接近点 */
  chair?: { x: number; y: number; width: number } | null
}

/**
 * 串门站位：A @ B 时，A 站到 B 的椅子左边（屏幕左侧，与 B 同一排），面向 B。
 * - 先试紧挨椅子左边缘的位置，被占 / 在障碍里（最左一列贴墙时）就依次往更左的位置试；
 * - 左边实在站不下（或没有椅子信息）才退回原来的工位接近点（过道），再挪到最近的空位；
 * others = 已被占用的点（别人的站位和位置），挑不到空位返回 null。
 */
export function visitSpot(
  map: OfficeMap,
  host: VisitHost,
  others: readonly MapPoint[],
  isBlockedAt: (point: MapPoint) => boolean = (p) => isBlocked(map, p, 12),
): MeetingSpot | null {
  const face = (point: MapPoint): ChibiFacing => facingFromDelta(host.home.x - point.x, host.home.y - point.y)
  if (host.chair) {
    const edge = host.chair.x - host.chair.width / 2
    for (const gap of VISIT_LEFT_GAPS) {
      const point = { x: edge - gap, y: host.home.y }
      if (!isBlockedAt(point) && isPointFree(point, others, 28)) return { point, facing: face(point) }
    }
  }
  const desired = host.approach ?? { x: host.home.x + 46, y: host.home.y + 40 }
  const point = findFreePoint(desired, others, isBlockedAt, 28, 96, 16)
  if (!point) return null
  return { point, facing: face(point) }
}
