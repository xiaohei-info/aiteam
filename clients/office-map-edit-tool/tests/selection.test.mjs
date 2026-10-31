import test from 'node:test'
import assert from 'node:assert/strict'
import { canSelect, rectHitsItem, groupRanges, moveLimits, clampDelta, normalizeRect } from '../src/selection.js'
import { makeElement, elementPolygon, rectIntersectsPolygon } from '../src/model.js'

const rect = (x, y, width, height) => ({ x, y, width, height })
const square = (x, y, size) => [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }]

test('框选矩形与多边形：相交、包含、被包含、分离、退化都判定正确', () => {
  const box = square(0, 0, 100)
  assert.equal(rectIntersectsPolygon(rect(20, 20, 10, 10), box), true, '矩形完全在多边形内')
  assert.equal(rectIntersectsPolygon(rect(-50, -50, 200, 200), box), true, '矩形完全包住多边形')
  assert.equal(rectIntersectsPolygon(rect(95, 20, 60, 60), box), true, '矩形压住多边形右边')
  assert.equal(rectIntersectsPolygon(rect(100, 100, 10, 10), box), true, '只在角点接触也算命中')
  assert.equal(rectIntersectsPolygon(rect(101, 101, 10, 10), box), false)
  assert.equal(rectIntersectsPolygon(rect(0, 0, 0, 10), box), false, '零面积矩形不命中')
  assert.equal(rectIntersectsPolygon(rect(20, 20, 10, 10), [{ x: 0, y: 0 }, { x: 1, y: 0 }]), false, '顶点不足不成多边形')
  // 斜向细长条穿过矩形，顶点都在矩形外、矩形角点也在条带外，只能靠边相交判定
  const band = (y) => [{ x: -50, y }, { x: 50, y }, { x: 50, y: y + 1 }, { x: -50, y: y + 1 }]
  assert.equal(rectIntersectsPolygon(rect(0, 0, 10, 10), band(4.5)), true)
  assert.equal(rectIntersectsPolygon(rect(0, 0, 10, 10), band(20)), false)
})

test('锁定与隐藏对象不可选中，活动点按锚点命中', () => {
  assert.equal(canSelect({ visible: true, locked: false }), true)
  assert.equal(canSelect({ visible: true, locked: true }), false, '锁定对象不可选中')
  assert.equal(canSelect({ visible: false }), false, '隐藏对象不可框选')
  assert.equal(canSelect({ x: 10, y: 10 }), true, '活动点没有 visible/locked 字段时默认可选')
  assert.equal(canSelect({ x: 10, y: 10, locked: true }), false)
  assert.equal(rectHitsItem(rect(0, 0, 20, 20), { x: 10, y: 10 }), true)
  assert.equal(rectHitsItem(rect(0, 0, 20, 20), { x: 30, y: 10 }), false)
  assert.equal(rectHitsItem(rect(0, 0, 20, 20), {}), false)
})

test('旋转元素的框选按旋转后的实际占地判定', () => {
  const desk = makeElement('桌', 'rect', 100, 100, { width: 80, height: 40, rotation: 90 })
  const polygon = elementPolygon(desk)
  assert.equal(rectHitsItem(rect(90, 60, 20, 20), { polygon }), true)
  assert.equal(rectHitsItem(rect(105, 60, 5, 5), { polygon }), true, '只框住一部分也算命中')
  assert.equal(rectHitsItem(rect(90, 145, 10, 10), { polygon }), false)
  assert.equal(rectHitsItem(rect(70, 90, 5, 20), { polygon }), false)
})

test('批量移动的整体范围保持相对位置并限制在地图内', () => {
  const ranges = groupRanges([{ x: 10, y: 10 }, { x: 100, y: 50 }, { points: [{ x: 200, y: 200 }, { x: 260, y: 240 }] }])
  assert.deepEqual(ranges, [
    { loX: 10, hiX: 10, loY: 10, hiY: 10 },
    { loX: 100, hiX: 100, loY: 50, hiY: 50 },
    { loX: 200, hiX: 260, loY: 200, hiY: 240 },
  ])
  const limits = moveLimits(ranges, 400, 400)
  assert.deepEqual(limits, { dxMin: -10, dxMax: 140, dyMin: -10, dyMax: 160 })
  assert.equal(clampDelta(500, limits.dxMin, limits.dxMax), 140)
  assert.equal(clampDelta(-999, limits.dxMin, limits.dxMax), -10)
  assert.deepEqual(moveLimits([], 400, 400), { dxMin: -Infinity, dxMax: Infinity, dyMin: -Infinity, dyMax: Infinity })
})

test('单个对象的移动范围与旧版逐元素夹紧完全一致', () => {
  for (const [x, y, width, height, dx, dy] of [[0, 0, 400, 400, -40, 900], [30, 30, 400, 400, 1000, -1000], [399, 399, 400, 400, 50, 50]]) {
    const limits = moveLimits(groupRanges([{ x, y }]), width, height)
    assert.equal(clampDelta(dx, limits.dxMin, limits.dxMax) + 0, Math.max(0, Math.min(width, x + dx)) - x + 0)
    assert.equal(clampDelta(dy, limits.dyMin, limits.dyMax) + 0, Math.max(0, Math.min(height, y + dy)) - y + 0)
  }
})

test('对象比地图还大时位移退回下界而不是反向弹回', () => {
  const limits = moveLimits([{ loX: -100, hiX: 500, loY: 0, hiY: 10 }], 400, 400)
  assert.equal(limits.dxMin, 100); assert.equal(limits.dxMax, -100)
  assert.equal(limits.dyMin + 0, 0); assert.equal(limits.dyMax, 390)
  assert.equal(clampDelta(0, limits.dxMin, limits.dxMax), 100)
  assert.equal(clampDelta(500, limits.dxMin, limits.dxMax), 100)
})

test('反向拖动框选时矩形被归一化', () => {
  assert.deepEqual(normalizeRect({ x: 100, y: 80 }, { x: 20, y: 30 }), { x: 20, y: 30, width: 80, height: 50 })
  assert.deepEqual(normalizeRect({ x: 5, y: 5 }, { x: 5, y: 5 }), { x: 5, y: 5, width: 0, height: 0 })
})
