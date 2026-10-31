import test from 'node:test'
import assert from 'node:assert/strict'
import { safeSource, makeMap, makeElement, validateMap } from '../src/model.js'
import { loadStyles } from '../src/library.js'

test('runtime images allow local PNG/JPEG/WebP but reject SVG/JSON/script and remote sources', () => {
  for (const src of ['assets/desk.png', 'assets/photo.jpg', 'assets/photo.JPEG', 'assets/fixture.webp', 'data:image/png;base64,AAAA']) assert.equal(safeSource(src), true, src)
  for (const src of ['assets/icon.svg', 'assets/styles/styles.json', 'assets/run.js', 'assets/../private.png', 'https://remote/desk.png', 'data:image/svg+xml;base64,AAAA']) assert.equal(safeSource(src), false, src)
})

test('catalog JSON paths have a separate strict local policy and do not fetch unsafe sources', async () => {
  for (const unsafe of ['https://remote/style.json', 'assets/../private.json', 'assets/library.svg']) {
    const calls = []
    const result = await loadStyles(async p => { calls.push(p); return [{ id: 'test', name: 'test', path: unsafe }] })
    assert.deepEqual(calls, ['assets/styles/styles.json'])
    assert.equal(result.styles.length, 0); assert.equal(result.errors.length, 1)
  }
  const calls = []
  const result = await loadStyles(async p => { calls.push(p); return p === 'assets/styles/styles.json' ? [{ id: 'test', name: 'test', path: 'assets/styles/test/style.json' }] : { source: 'https://remote/samples.json' } })
  assert.equal(calls.length, 2); assert.equal(result.errors.length, 1)
})

test('wall thickness and connector side assignments are validated instead of silently distorted', () => {
  const map = makeMap(), wall = makeElement('wall', 'rect', 200, 200, { width: 160, height: 16, geometry: { width: 160, height: 16, stretchAxis: 'x', footprints: [{ x: 0, y: 0, width: 160, height: 16 }], connectors: { left: { x: 0, y: 8 } } } })
  map.elements.push(wall); validateMap(map)
  wall.height = 32; assert.throws(() => validateMap(map), /厚度/)
  wall.height = 16; wall.geometry.connectors.left = { x: 80, y: 0 }
  assert.throws(() => validateMap(map), /连接点/)
})
