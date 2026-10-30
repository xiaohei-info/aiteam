/**
 * 自由活动目的地推导（纯函数，不依赖 Pixi / DOM，便于单测）。
 *
 * 规则：
 * 1. 地图里有 `spots` 锚点（编辑器可自定义）时，只用锚点；
 * 2. 锚点被禁用、绑定房间「使用中」、或落脚点落在「使用中」的房间范围内 → 不作为目的地；
 * 3. 旧地图没有 anchors 时，回退到按房间类型 + 主通道推导（保持向后兼容）。
 */
import { DESTINATION_SPEEDS, type DestinationConfig, type MapPoint, type MapRect, type MapRoom, type MapSpot, type OfficeMap } from './types.ts'

export function pointInRect(point: MapPoint, rect: MapRect): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height
}

/** 房间是否使用中：运行时集合与地图静态标记任一命中即算占用 */
export function isRoomOccupied(room: MapRoom, occupiedRooms: ReadonlySet<string> = new Set()): boolean {
  return room.occupied === true || occupiedRooms.has(room.id)
}

/** 锚点是否不可用（所在房间使用中） */
export function isSpotBlocked(spot: MapSpot, rooms: readonly MapRoom[] = [], occupiedRooms: ReadonlySet<string> = new Set()): boolean {
  if (spot.roomId) {
    const bound = rooms.find((room) => room.id === spot.roomId)
    if (bound && isRoomOccupied(bound, occupiedRooms)) return true
  }
  return rooms.some((room) => isRoomOccupied(room, occupiedRooms) && pointInRect(spot, room.bounds))
}

/** 当前可用的自由活动目的地 */
export function wanderDestinations(map: OfficeMap, occupiedRooms: ReadonlySet<string> = new Set()): DestinationConfig[] {
  const rooms = map.rooms ?? []
  const spots = map.spots ?? []

  if (spots.length) {
    return spots
      .filter((spot) => spot.enabled !== false && !isSpotBlocked(spot, rooms, occupiedRooms))
      .map((spot) => ({
        type: spot.kind,
        name: spot.name,
        point: { x: spot.x, y: spot.y },
        speed: spot.speed ?? DESTINATION_SPEEDS[spot.kind] ?? DESTINATION_SPEEDS.custom,
        stay: spot.stay,
        roomId: spot.roomId,
      }))
  }

  return deriveDestinationsFromRooms(map, occupiedRooms)
}

/** 旧地图兼容：按房间类型与主通道推导目的地 */
export function deriveDestinationsFromRooms(map: OfficeMap, occupiedRooms: ReadonlySet<string> = new Set()): DestinationConfig[] {
  const destinations: DestinationConfig[] = []

  for (const room of map.rooms ?? []) {
    if (isRoomOccupied(room, occupiedRooms)) continue
    const point = room.approachPoint ?? {
      x: room.bounds.x + room.bounds.width / 2,
      y: room.bounds.y + room.bounds.height / 2,
    }
    if (room.type === 'restroom' || room.name.includes('厕') || room.name.includes('卫生间') || room.name.includes('洗手间')) {
      destinations.push({ type: 'restroom', name: room.name, point, speed: DESTINATION_SPEEDS.restroom, roomId: room.id })
    } else if (room.type === 'pantry' || room.name.includes('茶水') || room.name.includes('咖啡')) {
      destinations.push({ type: 'pantry', name: room.name, point, speed: DESTINATION_SPEEDS.pantry, roomId: room.id })
    } else if (room.type === 'meeting' || room.name.includes('会议')) {
      destinations.push({ type: 'meeting', name: room.name, point, speed: DESTINATION_SPEEDS.meeting, roomId: room.id })
    }
  }

  const aisle = map.layout?.mainAisle
  if (aisle) {
    destinations.push(
      { type: 'corridor', name: '中央走道（西）', point: { x: Math.round(aisle.x + aisle.width * 0.22), y: Math.round(aisle.y + aisle.height * 0.5) }, speed: DESTINATION_SPEEDS.corridor },
      { type: 'corridor', name: '中央走道（中）', point: { x: Math.round(aisle.x + aisle.width * 0.5), y: Math.round(aisle.y + aisle.height * 0.5) }, speed: DESTINATION_SPEEDS.corridor },
      { type: 'corridor', name: '中央走道（东）', point: { x: Math.round(aisle.x + aisle.width * 0.78), y: Math.round(aisle.y + aisle.height * 0.5) }, speed: DESTINATION_SPEEDS.corridor },
    )
  }
  if (map.layout?.spawnPoint) {
    destinations.push({ type: 'corridor', name: '大厅通道', point: map.layout.spawnPoint, speed: DESTINATION_SPEEDS.corridor })
  }

  return destinations
}
