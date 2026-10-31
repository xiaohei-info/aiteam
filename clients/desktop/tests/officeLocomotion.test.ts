import assert from 'node:assert/strict'
import test from 'node:test'
import type { MapPoint } from '../src/scene/office/officeMap/types.ts'
import { pathLength, samplePath } from '../src/scene/office/officeMap/geometry.ts'
import {
  LOCOMOTION,
  buildSpeedProfile,
  nextFacing,
  paceFactor,
  roundCorners,
  simplifyPath,
  speedLimitAt,
  stepSpeed,
} from '../src/scene/office/officeMap/locomotion.ts'

const open = () => true

/** 网格寻路常见的锯齿：沿对角线交替走一格右、一格下 */
function staircase(steps: number, size = 16): MapPoint[] {
  const points: MapPoint[] = [{ x: 0, y: 0 }]
  for (let i = 0; i < steps; i++) {
    const last = points[points.length - 1]
    points.push(i % 2 === 0 ? { x: last.x + size, y: last.y } : { x: last.x, y: last.y + size })
  }
  return points
}

test('视线拉直：开阔区域的锯齿折线收成一条直线', () => {
  const simplified = simplifyPath(staircase(10), open)
  assert.equal(simplified.length, 2)
  assert.deepEqual(simplified[1], { x: 80, y: 80 })
})

test('视线拉直：被挡住时保留绕行拐点', () => {
  // 禁止直接从起点连到 (80,0) 以外的点，模拟墙角
  const points = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 40 }, { x: 80, y: 80 }]
  const isClear = (a: MapPoint, b: MapPoint) => a.x === b.x || a.y === b.y
  assert.deepEqual(simplifyPath(points, isClear), [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 80 }])
})

test('拐角倒圆：直角拐点变成圆弧，路径更短且端点不变', () => {
  const corner = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]
  const rounded = roundCorners(corner, open)
  assert.ok(rounded.length > corner.length)
  assert.deepEqual(rounded[0], corner[0])
  assert.deepEqual(rounded[rounded.length - 1], corner[2])
  assert.ok(pathLength(rounded) < pathLength(corner))
  assert.ok(!rounded.some((p) => p.x === 100 && p.y === 0), '不应再经过尖角')
})

test('拐角倒圆：圆弧碰撞时退回原来的直角', () => {
  const corner = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]
  const axisOnly = (a: MapPoint, b: MapPoint) => a.x === b.x || a.y === b.y
  assert.deepEqual(roundCorners(corner, axisOnly), corner)
})

test('速度曲线：终点为 0、转弯处放慢、直道保持巡航', () => {
  const route = roundCorners([{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 300 }], open)
  const samples = samplePath(route, LOCOMOTION.sampleStep)
  const profile = buildSpeedProfile(samples, 85)
  assert.equal(profile[profile.length - 1], 0)
  assert.equal(profile[5], 85, '直道上应保持巡航速度')
  const cornerIndex = samples.findIndex((p) => p.x > 285 && p.y > 0 && p.y < 15)
  assert.ok(cornerIndex > 0 && profile[cornerIndex] < 85, '拐角处应低于巡航速度')
  for (let i = 1; i < profile.length; i++) {
    const ds = Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y)
    assert.ok(profile[i - 1] <= Math.sqrt(profile[i] ** 2 + 2 * LOCOMOTION.decel * ds) + 1e-6, '减速不应超过制动能力')
  }
})

test('速度积分：从静止平滑起步，最终一定走到终点', () => {
  const samples = samplePath([{ x: 0, y: 0 }, { x: 200, y: 0 }], LOCOMOTION.sampleStep)
  const profile = buildSpeedProfile(samples, 60)
  const total = pathLength(samples)
  let speed = 0
  let distance = 0
  let peak = 0
  let frames = 0
  const dt = 1 / 60
  while (distance < total && frames < 60 * 30) {
    const before = speed
    speed = stepSpeed(speed, speedLimitAt(samples, profile, distance), dt)
    assert.ok(speed - before <= LOCOMOTION.accel * dt + 1e-6, '加速度不应超过上限')
    distance = Math.min(total, distance + speed * dt)
    peak = Math.max(peak, speed)
    frames++
  }
  assert.equal(distance, total)
  assert.ok(peak > 55 && peak <= 60 + 1e-6, `巡航速度应接近 60，实际 ${peak}`)
  assert.ok(speed < 20, `到达时应已减速，实际 ${speed}`)
})

test('朝向滞回：接近 45° 斜走时不来回切换', () => {
  assert.equal(nextFacing('right', 10, 11), 'right')
  assert.equal(nextFacing('front', 11, 10), 'front')
  assert.equal(nextFacing('right', 5, 20), 'front')
  assert.equal(nextFacing('front', 20, -5), 'right')
  assert.equal(nextFacing('back', -20, 2), 'left')
  assert.equal(nextFacing('left', 0, 0), 'left')
})

test('个体步速差异稳定且在 ±10% 内', () => {
  const seeds = ['seat-1', 'seat-2', 'seat-3', 'seat-4', 'seat-5']
  const factors = seeds.map(paceFactor)
  assert.deepEqual(factors, seeds.map(paceFactor))
  assert.ok(factors.every((f) => f >= 0.9 && f <= 1.1))
  assert.ok(new Set(factors).size > 1)
})
