import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { makeMap, makeElement, validateMap, templateOptions, elementPoint, elementFootprints, isBlocked, clearSegment, snapToConnectors, syncSeats } from '../src/model.js'
import { loadStyles } from '../src/library.js'
const catalog = JSON.parse(await readFile(new URL('../assets/styles/topdown-soft/style.json', import.meta.url), 'utf8'))
const template = id => catalog.elements.find(a => a.id === id)
const instance = (id, x = 200, y = 200, extra = {}) => makeElement(id, 'rect', x, y, { ...templateOptions(template(id)), ...extra })

 test('legacy v1 imports remain compatible but cannot silently carry v1.1 footprints', async () => {
  const legacy = JSON.parse(await readFile(new URL('../examples/office-map.example.json', import.meta.url), 'utf8'))
  assert.equal(validateMap(legacy).schema, 'office-map/v1')
  const map = makeMap(); map.elements.push(instance('plant-top'))
  assert.deepEqual(validateMap(JSON.parse(JSON.stringify(map))), map)
  assert.throws(() => validateMap({ ...map, schema: 'office-map/v1' }), /v1.1/)
  map.elements[0].geometry.footprints[0].width = 100
  assert.throws(() => validateMap(map), /占地/)
})

test('plant foliage does not enlarge physical footprint; scaling and rotation transform local geometry', () => {
  const map = makeMap(); const plant = instance('plant-top', 200, 200, { width: 112, height: 112 }); map.elements.push(plant)
  assert.equal(isBlocked(map, { x: 154, y: 200 }, 0), false)
  assert.equal(isBlocked(map, { x: 200, y: 200 }, 0), true)
  const e = instance('door-open-right', 300, 300, { rotation: 90, width: 176 })
  const p = elementPoint(e, { x: 20, y: 10 })
  map.elements.push(e)
  assert.ok(elementFootprints(e).some(poly => poly.length === 4))
  assert.equal(isBlocked(map, p, 0), true)
})

test('all four open doors leave walkable voids while closed leaves block', () => {
  for (const [id, point] of Object.entries({ 'door-open-up': { x: 44, y: 80 }, 'door-open-down': { x: 44, y: 8 }, 'door-open-right': { x: 8, y: 44 }, 'door-open-left': { x: 80, y: 44 }, 'door-closed-horizontal': { x: 44, y: 8 }, 'door-closed-vertical': { x: 8, y: 44 } })) {
    const map = makeMap(); const door = instance(id); map.elements.push(door)
    assert.equal(isBlocked(map, elementPoint(door, point), 8), id.includes('closed'), id)
  }
  const map = makeMap(); map.elements.push(instance('door-open-down'))
  assert.equal(clearSegment(map, { x: 200, y: 140 }, { x: 200, y: 210 }, 8), true)
  map.elements = [instance('door-closed-horizontal', 200, 164)]
  assert.equal(clearSegment(map, { x: 200, y: 140 }, { x: 200, y: 210 }, 8), false)
})

test('connector snapping aligns exact contacts after extension and rotation', () => {
  const wall = instance('wall-down', 80, 8)
  const candidate = instance('wall-down', 250, 10)
  assert.deepEqual(snapToConnectors(candidate, [wall], 20), { x: 240, y: 8 })
  assert.deepEqual(snapToConnectors(candidate, [wall], 5), { x: 250, y: 10 })
  const long = instance('wall-down', 160, 8, { width: 320 })
  assert.deepEqual(snapToConnectors(instance('wall-down', 410, 10), [long], 20), { x: 400, y: 8 })
  const vertical = instance('wall-down', 100, 100, { rotation: 90 })
  const next = instance('wall-down', 103, 270, { rotation: 90 })
  const result = snapToConnectors(next, [vertical], 20)
  assert.ok(Math.abs(result.x - 100) < 1e-8 && Math.abs(result.y - 260) < 1e-8)
  assert.deepEqual(snapToConnectors(candidate, [{ ...wall, visible: false }], 20), { x: 250, y: 10 })
})

test('seat positions and approach points follow their referenced desk', () => {
  const map = makeMap(), desk = instance('desk-top', 400, 400)
  map.elements.push(desk)
  map.seats = [{ id: 'seat-one', name: '工位01', deskElementId: desk.id, x: 0, y: 0, facing: 'back', seatOffset: { x: 0.5, y: 1.5 }, approachOffset: { x: 0.5, y: 2.3 } }]
  syncSeats(map)
  assert.deepEqual({ x: map.seats[0].x, y: map.seats[0].y }, { x: 400, y: 480 })
  desk.rotation = 180; desk.x = 500; syncSeats(map)
  assert.ok(Math.abs(map.seats[0].x - 500) < 1e-8 && Math.abs(map.seats[0].y - 320) < 1e-8)
  assert.equal(map.seats[0].facing, 'front')
  validateMap(map)
  map.seats[0].deskElementId = 'missing'
  assert.throws(() => validateMap(map), /工位/)
})

test('style index discovers all four libraries and carries native floor tiling and geometry', async () => {
  const result = await loadStyles(async p => JSON.parse(await readFile(new URL(`../${p}`, import.meta.url), 'utf8')))
  assert.deepEqual(result.errors, [])
  assert.equal(result.styles.length, 4)
  const active = result.styles.find(s => s.default)
  assert.equal(active.id, 'topdown-soft')
  assert.equal(active.items.filter(a => a.tileable).length, 3)
  assert.equal(result.styles.find(s => s.id === 'classic-cutout').items.length, 28)
  assert.equal(result.styles.find(s => s.id === 'flat-blueprint').items.length, 5)
  assert.equal(templateOptions(active.items.find(a => a.id === 'door-open-up')).geometry.footprints.length, 3)
})
