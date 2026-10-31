import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Navigator, blockers, clearSegment, findPath, isBlocked, obstacleSet } from '../src/scene/office/officeMap/geometry.ts'
import type { MapPoint, OfficeMap } from '../src/scene/office/officeMap/types.ts'

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
const nav = new Navigator(map, 'employee')
const polygons = blockers(map, 'employee')

/** 可复现的伪随机，保证失败时能重现 */
function rng(seed: number): () => number {
  let s = seed
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32
}

const square = (c: MapPoint, h = 8): MapPoint[] => [
  { x: c.x - h, y: c.y - h }, { x: c.x + h, y: c.y - h }, { x: c.x + h, y: c.y + h }, { x: c.x - h, y: c.y + h },
]

function samplePoints(count: number, random: () => number): MapPoint[] {
  const anchors = (map.spots ?? []).map((s) => ({ x: s.x, y: s.y }))
  const scattered = Array.from({ length: count }, () => ({ x: 20 + random() * (map.width - 40), y: 20 + random() * (map.height - 40) }))
  return [...anchors, ...scattered]
}

test('Navigator：点阻挡与线段通畅判定和 isBlocked / clearSegment 完全一致（含贴边与越界）', () => {
  const random = rng(7)
  const points = samplePoints(300, random)
  // 加几个贴着地图边界、恰好在半径临界值上的点
  points.push({ x: 12, y: 600 }, { x: 11.999, y: 600 }, { x: map.width - 12, y: 600 }, { x: 800, y: map.height - 12 }, { x: -5, y: -5 })
  for (const radius of [8, 9, 12]) {
    for (const p of points) {
      assert.equal(nav.isBlocked(p, radius), isBlocked(map, p, radius, 'employee', polygons), `isBlocked ${JSON.stringify(p)} r=${radius}`)
    }
    for (let i = 0; i < 400; i++) {
      const a = points[Math.floor(random() * points.length)]
      // 线段不要太长，覆盖网格边和视线拉直两种尺度
      const b = random() < 0.5 ? { x: a.x + (random() - 0.5) * 40, y: a.y + (random() - 0.5) * 40 } : points[Math.floor(random() * points.length)]
      assert.equal(
        nav.clearSegment(a, b, radius),
        clearSegment(map, a, b, radius, 'employee', polygons),
        `clearSegment ${JSON.stringify(a)}→${JSON.stringify(b)} r=${radius}`,
      )
    }
  }
})

test('Navigator：叠加临时障碍后的判定同样一致', () => {
  const random = rng(11)
  const points = samplePoints(80, random)
  for (let round = 0; round < 20; round++) {
    const extra = Array.from({ length: 1 + (round % 10) }, () => square(points[Math.floor(random() * points.length)]))
    const set = obstacleSet(extra)
    const all = [...polygons, ...extra]
    for (let i = 0; i < 60; i++) {
      const a = points[Math.floor(random() * points.length)]
      const b = { x: a.x + (random() - 0.5) * 80, y: a.y + (random() - 0.5) * 80 }
      assert.equal(nav.isBlocked(a, 12, set), isBlocked(map, a, 12, 'employee', all))
      assert.equal(nav.clearSegment(a, b, 12, set), clearSegment(map, a, b, 12, 'employee', all))
    }
  }
})

test('Navigator：findPath 与参考实现逐点一致（有无临时障碍、预热前后、不同半径）', () => {
  const random = rng(12345)
  const points = samplePoints(40, random)
  const cold = new Navigator(map, 'employee')
  const warm = new Navigator(map, 'employee')
  warm.warm([12, 8])
  let found = 0
  for (let i = 0; i < 60; i++) {
    const a = points[Math.floor(random() * points.length)]
    const b = points[Math.floor(random() * points.length)]
    const radius = [12, 8, 9][i % 3]
    const extra = Array.from({ length: i % 7 }, () => square(points[Math.floor(random() * points.length)]))
    const expected = findPath(map, a, b, radius, 'employee', extra)
    const set = extra.length ? obstacleSet(extra) : undefined
    assert.deepEqual(cold.findPath(a, b, radius, set), expected, `冷缓存 #${i}`)
    assert.deepEqual(warm.findPath(a, b, radius, set), expected, `预热后 #${i}`)
    // 同一个 Navigator 重复寻路：缓存不能把上一次的临时障碍带进下一次
    assert.deepEqual(warm.findPath(a, b, radius), findPath(map, a, b, radius, 'employee'), `无临时障碍 #${i}`)
    if (expected) found++
  }
  assert.ok(found > 10, `样本里应有足够多的可达路线，实际 ${found}`)
})
