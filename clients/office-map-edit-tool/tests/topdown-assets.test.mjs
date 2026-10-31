import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

import { ITEMS } from '../scripts/topdown-extras/items.mjs'
import { catalogEntry, orderElements, serializeStyle, svgDocument } from '../scripts/build-topdown-extras.mjs'

const directory = new URL('../assets/styles/topdown-soft/', import.meta.url)
const EXTRA_IDS = ITEMS.map(item => item.id)
const catalog = JSON.parse(readFileSync(new URL('style.json', directory), 'utf8'))

// Minimal decoder for Sketch's non-interlaced, 8-bit RGB/RGBA PNG exports.
// Kept dependency-free; decoded pixels make transparent connection gaps testable.
function png(filename) {
  const input = readFileSync(new URL(filename, directory))
  assert.deepEqual(input.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  let width, height, channels
  const compressed = []
  for (let offset = 8; offset < input.length;) {
    const size = input.readUInt32BE(offset)
    const type = input.toString('ascii', offset + 4, offset + 8)
    const data = input.subarray(offset + 8, offset + 8 + size)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      assert.equal(data[8], 8, 'Expected 8-bit PNG')
      assert.ok([2, 6].includes(data[9]), 'Expected RGB or RGBA')
      assert.equal(data[10], 0); assert.equal(data[11], 0); assert.equal(data[12], 0)
      channels = data[9] === 2 ? 3 : 4
    }
    if (type === 'IDAT') compressed.push(data)
    offset += size + 12
    if (type === 'IEND') break
  }
  const raw = inflateSync(Buffer.concat(compressed))
  const stride = width * channels
  assert.equal(raw.length, (stride + 1) * height)
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    assert.ok(filter <= 4, 'Unknown PNG filter')
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x
      const left = x >= channels ? pixels[at - channels] : 0
      const up = y > 0 ? pixels[at - stride] : 0
      const upperLeft = x >= channels && y > 0 ? pixels[at - stride - channels] : 0
      let prediction = 0
      if (filter === 1) prediction = left
      if (filter === 2) prediction = up
      if (filter === 3) prediction = Math.floor((left + up) / 2)
      if (filter === 4) {
        const p = left + up - upperLeft
        const distances = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upperLeft)]
        prediction = distances[0] <= distances[1] && distances[0] <= distances[2] ? left : distances[1] <= distances[2] ? up : upperLeft
      }
      pixels[at] = (raw[y * (stride + 1) + x + 1] + prediction) & 255
    }
  }
  return {
    width, height, pixels,
    pixel(x, y) {
      const at = (y * width + x) * channels
      return [pixels[at], pixels[at + 1], pixels[at + 2], channels === 4 ? pixels[at + 3] : 255]
    },
  }
}

const contains = (rectangle, point) => point.x >= rectangle.x && point.x <= rectangle.x + rectangle.width && point.y >= rectangle.y && point.y <= rectangle.y + rectangle.height

test('topdown catalog has 52 unique assets (35 original + 17 extras) with valid local geometry', () => {
  assert.equal(catalog.elements.length, 52)
  assert.equal(new Set(catalog.elements.map(e => e.id)).size, 52)
  for (const e of catalog.elements) {
    assert.ok(e.width > 0 && e.height > 0)
    assert.equal(e.src, `assets/styles/topdown-soft/${e.id}.png`)
    for (const r of e.footprints || []) {
      assert.ok(r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0)
      assert.ok(r.x + r.width <= e.width && r.y + r.height <= e.height)
    }
    for (const p of Object.values(e.connectors || {})) {
      assert.ok(p.x >= 0 && p.x <= e.width && p.y >= 0 && p.y <= e.height)
      assert.ok(p.x === 0 || p.x === e.width || p.y === 0 || p.y === e.height)
    }
    if (e.screen) {
      assert.ok(e.screen.x >= 0 && e.screen.y >= 0 && e.screen.width > 0 && e.screen.height > 0)
      assert.ok(e.screen.x + e.screen.width <= e.width && e.screen.y + e.screen.height <= e.height)
    }
  }
  const desk = catalog.elements.find(e => e.id === 'desk-workstation-top')
  const computer = catalog.elements.find(e => e.id === 'computer-top')
  assert.equal(desk.blocksMovement, true)
  assert.equal(desk.footprints.length, 1)
  assert.equal(computer.blocksMovement, false)
  assert.ok(computer.screen.width < computer.width && computer.screen.height < computer.height, '显示器屏幕必须小于图元本体')
})

test('the 17 extras (plants, furniture, props) follow the placement conventions', () => {
  const extras = catalog.elements.filter(e => EXTRA_IDS.includes(e.id))
  assert.equal(extras.length, 17)
  assert.deepEqual([...new Set(extras.map(e => e.category))].sort(), ['家具', '摆件', '绿植', '设施'])
  for (const e of extras) {
    if (e.blocksMovement) assert.ok(e.footprints?.length, `${e.id}: 阻挡行走的图元必须有地面占地`)
    else assert.equal(e.footprints, undefined, `${e.id}: 不阻挡行走的图元不该带占地`)
  }
  // 地毯是地面装饰：压在地面（-100）之上、家具（0）之下，并且可以走上去
  for (const id of ['rug-rect-top', 'rug-round-top']) {
    const rug = catalog.elements.find(e => e.id === id)
    assert.equal(rug.blocksMovement, false)
    assert.ok(rug.zIndex > -100 && rug.zIndex < 0, `${id}: zIndex ${rug.zIndex}`)
  }
  // 桌面小摆件要盖在桌面（0）和电脑（6）上，但仍在办公椅（12）之下
  for (const id of ['plant-succulent-top', 'plant-cactus-top']) {
    const item = catalog.elements.find(e => e.id === id)
    assert.equal(item.blocksMovement, false)
    assert.ok(item.zIndex > 6 && item.zIndex < 12, `${id}: zIndex ${item.zIndex}`)
  }
  // 绿植按花盆 / 树冠内圈占地，叶片外沿不扩大占地
  for (const id of ['plant-top', 'plant-monstera-top', 'plant-fern-top', 'plant-palm-top', 'plant-bush-top']) {
    const plant = catalog.elements.find(e => e.id === id)
    const [foot] = plant.footprints
    assert.ok(foot.width < plant.width && foot.height < plant.height, `${id}: 占地应小于叶片外框`)
  }
})

test('extras are reproducible: committed SVG and style.json match scripts/build-topdown-extras.mjs', () => {
  for (const item of ITEMS) {
    assert.equal(readFileSync(new URL(`${item.id}.svg`, directory), 'utf8'), svgDocument(item), `${item.id}.svg 与生成脚本不一致，请重新运行 node scripts/build-topdown-extras.mjs`)
    assert.deepEqual(catalog.elements.find(e => e.id === item.id), catalogEntry(item), item.id)
  }
  assert.equal(readFileSync(new URL('style.json', directory), 'utf8'), serializeStyle(catalog), 'style.json 排版应与既有格式一致')
  assert.deepEqual(orderElements(catalog.elements), catalog.elements, 'style.json 的图元应按分组顺序排列')
})

test('all assets have non-empty PNG, 2x PNG and vector SVG exports', () => {
  for (const e of catalog.elements) {
    const one = png(`${e.id}.png`), two = png(`${e.id}@2x.png`)
    assert.deepEqual([one.width, one.height], [e.width, e.height], e.id)
    assert.deepEqual([two.width, two.height], [e.width * 2, e.height * 2], e.id)
    let visible = false
    for (let y = 0; y < one.height; y++) for (let x = 0; x < one.width; x++) if (one.pixel(x, y)[3] > 0) visible = true
    assert.ok(visible, `${e.id}: blank image`)
    const svg = readFileSync(new URL(`${e.id}.svg`, directory), 'utf8')
    assert.match(svg, /<svg\b/)
    assert.doesNotMatch(svg, /<image\b/, `${e.id}: expected editable vectors, not embedded raster`)
  }
})

test('four-facing wall and glass contact edges have no transparent inset or repeated end cap', () => {
  for (const material of ['wall', 'glass']) for (const facing of ['up', 'down', 'left', 'right']) {
    const name = `${material}-${facing}`
    const image = png(`${name}.png`)
    const horizontal = ['up', 'down'].includes(facing)
    for (let i = 0; i < (horizontal ? image.height : image.width); i++) {
      const first = horizontal ? image.pixel(0, i) : image.pixel(i, 0)
      const last = horizontal ? image.pixel(image.width - 1, i) : image.pixel(i, image.height - 1)
      assert.ok(first[3] > 0 && last[3] > 0, `${name}: transparent contact edge`)
      assert.deepEqual(first, last, `${name}: mismatched contact edges`)
    }
  }
})

test('opposite wall and glass facing variants are visually distinct', () => {
  for (const material of ['wall', 'glass']) {
    assert.notDeepEqual(png(`${material}-up.png`).pixels, png(`${material}-down.png`).pixels)
    assert.notDeepEqual(png(`${material}-left.png`).pixels, png(`${material}-right.png`).pixels)
  }
})

test('all three floor tiles are opaque to the edge', () => {
  for (const e of catalog.elements.filter(e => e.tileable)) {
    const image = png(`${e.id}.png`)
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) assert.equal(image.pixel(x, y)[3], 255, e.id)
  }
})

test('door artwork and footprint metadata distinguish open voids from closed leaves', () => {
  const probes = {
    'door-open-up': {x:44,y:80}, 'door-open-down': {x:44,y:8},
    'door-open-right': {x:8,y:44}, 'door-open-left': {x:80,y:44},
    'door-closed-horizontal': {x:44,y:8}, 'door-closed-vertical': {x:8,y:44},
  }
  for (const [id, point] of Object.entries(probes)) {
    const e = catalog.elements.find(e => e.id === id)
    const image = png(`${id}.png`)
    const closed = e.state === 'closed'
    assert.equal(image.pixel(point.x, point.y)[3] > 0, closed, id)
    assert.equal(e.footprints.some(r => contains(r, point)), closed, id)
    assert.equal(e.clearOpening, 72)
  }
})
