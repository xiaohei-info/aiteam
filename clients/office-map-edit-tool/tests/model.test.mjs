import test from 'node:test'
import assert from 'node:assert/strict'
import { makeMap, validateMap, makeElement, elementPolygon, pointInPolygon, isSimplePolygon, isBlocked, clearSegment, findPath, History, safeSource, mapWarnings } from '../src/model.js'

const rectangle = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
function zone(map, type, points) { const z = { id: crypto.randomUUID(), name: '测试区域', type, points, enabled: true, visible: true, locked: false }; map.zones.push(z); return z }
function smallMap() { return { ...makeMap(null), width: 400, height: 400, gridSize: 16 } }

test('JSON round trip preserves position, rotation, polygons, assets and flags', () => {
  const map = smallMap()
  map.assets.push({ id: 'asset-1', name: '桌子', src: 'assets/desk.png' })
  map.elements.push(makeElement('桌子', 'image', 100, 120, { assetId: 'asset-1', rotation: 45, zIndex: 3, locked: true, blocksMovement: true }))
  zone(map, 'employee-no-entry', rectangle(200, 200, 40, 60))
  assert.deepEqual(validateMap(JSON.parse(JSON.stringify(map))), map)
})
test('import rejects unsupported versions, missing assets, unsafe URLs and NaN', () => {
  const map = smallMap()
  assert.throws(() => validateMap({ ...map, schema: 'other' }), /版本/)
  assert.throws(() => validateMap({ ...map, width: NaN }), /宽高/)
  map.elements.push(makeElement('missing', 'image', 20, 20, { assetId: 'missing' }))
  assert.throws(() => validateMap(map), /素材引用/)
  for (const src of ['javascript:alert(1)', 'https://remote/asset.png', 'assets/../private.png', 'data:image/svg+xml;base64,PHN2Zz4=']) assert.equal(safeSource(src), false)
  assert.equal(safeSource('data:image/png;base64,AAAA'), true)
})
test('duplicate IDs and out of bounds zone vertices are rejected', () => {
  const map = smallMap(), a = zone(map, 'walk-blocked', rectangle(10, 10, 20, 20))
  map.zones.push(structuredClone(a)); assert.throws(() => validateMap(map), /重复/)
  map.zones.pop(); a.points[0].x = -1; assert.throws(() => validateMap(map), /超出/)
})
test('polygon edges count as inside; self-intersections and repeated edges are invalid', () => {
  assert.equal(pointInPolygon({ x: 10, y: 15 }, rectangle(10, 10, 20, 20)), true)
  assert.equal(isSimplePolygon([{ x: 0, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }, { x: 20, y: 0 }]), false)
  assert.equal(isSimplePolygon([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]), false)
  assert.equal(isSimplePolygon(rectangle(0, 0, 20, 20)), true)
})
test('employee no-entry differs from physical walking restrictions', () => {
  const map = smallMap(), p = { x: 120, y: 120 }
  const z = zone(map, 'employee-no-entry', rectangle(100, 100, 60, 60))
  assert.equal(isBlocked(map, p, 0, 'employee'), true)
  assert.equal(isBlocked(map, p, 0, 'general'), false)
  z.visible = false; assert.equal(isBlocked(map, p, 0, 'employee'), true)
  z.enabled = false; assert.equal(isBlocked(map, p, 0, 'employee'), false)
  z.enabled = true; z.type = 'walk-blocked'; assert.equal(isBlocked(map, p, 0, 'general'), true)
})
test('hidden blocking furniture still blocks; decorative furniture does not', () => {
  const map = smallMap(), e = makeElement('wall', 'rect', 100, 100, { width: 50, height: 20, rotation: 90, visible: false, blocksMovement: true })
  map.elements.push(e)
  const polygon = elementPolygon(e)
  assert.equal(Math.round(polygon[0].x), 110)
  assert.equal(isBlocked(map, { x: 100, y: 120 }, 0), true)
  e.blocksMovement = false; assert.equal(isBlocked(map, { x: 100, y: 120 }, 0), false)
})
test('navigation routes around obstacles and every segment respects clearance', () => {
  const map = smallMap()
  zone(map, 'walk-blocked', rectangle(180, 70, 40, 240))
  const start = { x: 70, y: 180 }, end = { x: 330, y: 180 }
  const path = findPath(map, start, end, 8)
  assert.ok(path && path.length > 2)
  assert.deepEqual(path[0], start); assert.deepEqual(path.at(-1), end)
  for (let i = 1; i < path.length; i++) assert.equal(clearSegment(map, path[i - 1], path[i], 8, 'employee'), true)
})
test('thin walls cannot be skipped between navigation grid centers', () => {
  const map = smallMap()
  zone(map, 'walk-blocked', rectangle(199, 0, 1, 400))
  assert.equal(findPath(map, { x: 80, y: 200 }, { x: 320, y: 200 }, 0), null)
})
test('blocked endpoints, boundary clearance and narrow corridors reject movement', () => {
  const map = smallMap()
  zone(map, 'walk-blocked', rectangle(180, 0, 40, 192))
  zone(map, 'walk-blocked', rectangle(180, 208, 40, 192))
  assert.equal(findPath(map, { x: 80, y: 200 }, { x: 320, y: 200 }, 9), null)
  assert.ok(findPath(map, { x: 80, y: 200 }, { x: 320, y: 200 }, 5))
  assert.equal(findPath(map, { x: 190, y: 100 }, { x: 320, y: 200 }, 0), null)
  assert.equal(isBlocked(map, { x: 2, y: 60 }, 8), true)
})
test('spawn zones do not override blocked zones', () => {
  const map = smallMap()
  zone(map, 'spawn', rectangle(100, 100, 60, 60))
  zone(map, 'walk-blocked', rectangle(100, 100, 60, 60))
  assert.equal(isBlocked(map, { x: 120, y: 120 }), true)
  assert.ok(mapWarnings(map).some(w => w.includes('中心')))
})
test('undo/redo snapshots are isolated, divergent edits discard redo history', () => {
  const map = smallMap(), history = new History(map)
  map.name = 'second'; history.push(map); map.name = 'third'; history.push(map)
  const previous = history.undo(); assert.equal(previous.name, 'second'); previous.name = 'mutated'
  assert.equal(history.redo().name, 'third')
  history.undo(); history.push({ ...map, name: 'new branch' }); assert.equal(history.redo().name, 'new branch')
})
