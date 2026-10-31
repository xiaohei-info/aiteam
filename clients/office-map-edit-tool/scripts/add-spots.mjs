import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { syncSpots, SPOT_SPEEDS, validateMap } from '../src/model.js'

// 把「自由活动目的地锚点」与房间「使用中」标记补进一张已经存在的地图。
// 只做加法：不动已有元素、房间、工位，适合给旧导出补字段。
//
//   node scripts/add-spots.mjs <map.json> [--write]
//
// 不带 --write 时只做 dry-run 打印，方便先看会加什么。

const [file, ...flags] = process.argv.slice(2)
if (!file) {
  console.error('用法：node scripts/add-spots.mjs <map.json> [--write]')
  process.exit(1)
}
const write = flags.includes('--write')

let map
let raw
{
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    console.error(`无法读取 ${file}：${error.message}`)
    process.exit(1)
  }
  try {
    map = JSON.parse(raw)
  } catch (error) {
    console.error(`${file} 不是合法 JSON：${error.message}`)
    process.exit(1)
  }
}
const before = {
  spots: map.spots?.length ?? 0,
  rooms: (map.rooms ?? []).length,
  occupied: (map.rooms ?? []).filter((r) => r.occupied === true).length,
}

syncSpots(map)
const aisle = map.layout?.mainAisle
const hasCorridor = (map.spots ?? []).some((s) => s.kind === 'corridor')
if (aisle && !hasCorridor) {
  for (const [label, ratio] of [['西', 0.22], ['中', 0.5], ['东', 0.78]]) {
    map.spots.push({
      id: `spot-corridor-${label}`, name: `中央走道（${label}）`, kind: 'corridor',
      x: Math.round(aisle.x + aisle.width * ratio), y: Math.round(aisle.y + aisle.height / 2),
      speed: SPOT_SPEEDS.corridor, stay: 6, enabled: true,
    })
  }
}
if (map.layout?.spawnPoint && !(map.spots ?? []).some((s) => s.name === '大厅通道')) {
  map.spots.push({
    id: 'spot-corridor-hall', name: '大厅通道', kind: 'corridor',
    x: map.layout.spawnPoint.x, y: map.layout.spawnPoint.y,
    speed: SPOT_SPEEDS.corridor, stay: 6, enabled: true,
  })
}
for (const room of map.rooms ?? []) if (room.type === 'meeting' && room.occupied === undefined) room.occupied = false

validateMap(map)

console.log(`活动点 ${before.spots} → ${map.spots.length}`)
for (const spot of map.spots) console.log(`  ${spot.kind.padEnd(9)} ${spot.name.padEnd(18)} (${spot.x},${spot.y}) ${spot.speed} px/s 停留 ${spot.stay}s ${spot.roomId ?? ''}`)
console.log(`房间 ${before.rooms} 个，使用中标记 ${before.occupied} → ${(map.rooms ?? []).filter((r) => r.occupied === true).length}`)

if (write) {
  await writeFile(file, `${JSON.stringify(map, null, 2)}\n`)
  console.log(`已写入 ${path.relative(process.cwd(), file)}`)
} else {
  console.log('（dry-run，加 --write 才会写回文件）')
}
