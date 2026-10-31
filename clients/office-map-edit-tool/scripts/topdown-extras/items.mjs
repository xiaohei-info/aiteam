// 俯视 · 轻立体 扩充图元：绿植与家具摆件。
//
// 与原 35 款（Sketch 导出）保持同一套语言：俯视顶面为主，2–3px 窄侧边 + 顶部 1px 高光 + 短接触阴影；
// 颜色全部取自原图元（盆栽叶色、沙发鼠尾草灰绿、橡木、象牙白）。每款只描述 SVG，PNG/@2x 与 style.json
// 条目由 scripts/build-topdown-extras.mjs 统一生成，这里不放任何位图。
//
// 叶片、羽叶、灌木团这类重复形状用固定种子的伪随机生成，重跑结果逐字节一致。

const r2 = (n) => Math.round(n * 100) / 100

/** 固定种子伪随机（mulberry32），保证同一份源码永远生成同一组 SVG */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PALETTE = {
  leafDark: '#547650',
  leaf1: '#607E5E',
  leaf2: '#708F66',
  leaf3: '#7F9C6F',
  leaf4: '#87A176',
  leaf5: '#8FA77A',
  leafLight: '#A9BF8E',
  vein: '#B8C79B',
  soil: '#6F6654',
  potClay: '#BEA284',
  ceramic: '#F5F3EF',
  ceramicSide: '#C4C0B8',
  shadow: '#35423E',
  woodSide: '#BDA587',
  wood: '#DBC3A3',
  woodStroke: '#C9AF8D',
  woodLight: '#F2E4CF',
  sage: '#82978B',
  sageDark: '#61796C',
  sageStroke: '#6F8578',
  sageLight: '#A4B4A8',
  sageHighlight: '#C6D1C6',
}

/** 接触阴影统一用深绿灰 + 透明度，和原盆栽一致 */
const SHADOW = `fill="${PALETTE.shadow}" fill-opacity=".1"`

const shadowDot = (cx, cy, r, opacity = 0.1) =>
  `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r)}" fill="${PALETTE.shadow}" fill-opacity="${opacity}"/>`

const polar = (cx, cy, angleDeg, dist) => {
  const a = (angleDeg * Math.PI) / 180
  return [r2(cx + Math.sin(a) * dist), r2(cy - Math.cos(a) * dist)]
}

const clampUnit = (v) => Math.min(0.999, Math.max(0, v))

/**
 * 叶片轮廓：底部在 (0,0)，叶尖在 (0,-len)，朝上。
 * notches 是沿叶长的裂口位置（0–1），龟背竹用来做「叶裂」，其他叶片传空数组。
 */
function leafPoints(len, wid, notches = [], depth = 0.55, steps = 30) {
  const half = (side) => {
    const out = []
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      let w = wid * Math.sin(Math.PI * Math.pow(t, 0.8))
      for (const c of notches) w *= 1 - depth * Math.exp(-(((t - c) / 0.03) ** 2))
      out.push([r2(side * w), r2(-len * t)])
    }
    return out
  }
  const right = half(1)
  const left = half(-1).toReversed()
  return [...right, ...left].map(([x, y]) => `${x},${y}`).join(' ')
}

function leaf({ x, y, angle, len, wid, fill, notches = [], depth, vein = PALETTE.vein, stroke = PALETTE.leafDark, rib = true }) {
  const points = leafPoints(len, wid, notches, depth)
  return `<g transform="translate(${r2(x)} ${r2(y)}) rotate(${r2(angle)})">` +
    `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-opacity=".55" stroke-width=".5" stroke-linejoin="round"/>` +
    (rib ? `<path d="M0,-1 L0,${r2(-len * 0.9)}" stroke="${vein}" stroke-opacity=".7" stroke-width=".7" stroke-linecap="round"/>` : '') +
    `</g>`
}

/** 圆形花盆：从上往下只露出盆沿和土面，后面被叶子盖住 */
function pot(cx, cy, r, rim, soil = PALETTE.soil) {
  return `<circle cx="${cx}" cy="${r2(cy + 1.5)}" r="${r}" fill="${rim === PALETTE.ceramic ? PALETTE.ceramicSide : '#9C8465'}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${rim}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${r2(r * 0.8)}" fill="${soil}"/>`
}

// ---------------------------------------------------------------- 绿植

function monstera() {
  const cx = 32, cy = 31
  const rand = rng(11)
  const colors = [PALETTE.leafDark, PALETTE.leaf1, PALETTE.leaf2, PALETTE.leaf3]
  const leaves = []
  for (let i = 0; i < 8; i++) {
    const angle = i * 45 + 12 + (rand() - 0.5) * 8
    const len = 25 + rand() * 3
    leaves.push({ angle, len, wid: 10.5 + rand() * 1.5, fill: colors[i % colors.length] })
  }
  // 暗的先画，亮的盖在上面
  leaves.sort((a, b) => colors.indexOf(a.fill) - colors.indexOf(b.fill))
  return shadowDot(cx, cy + 5, 26) + pot(cx, cy, 14, PALETTE.potClay) +
    leaves.map((l) => leaf({ x: cx, y: cy, angle: l.angle, len: l.len, wid: l.wid, fill: l.fill, notches: [0.36, 0.52, 0.68], depth: 0.6 })).join('') +
    [20, 150, 255].map((a, i) => leaf({ x: cx, y: cy, angle: a, len: 11, wid: 4.6, fill: i % 2 ? PALETTE.leaf5 : PALETTE.leaf4, notches: [0.5], depth: 0.4 })).join('') +
    `<circle cx="${cx}" cy="${cy}" r="2" fill="${PALETTE.leafLight}"/>`
}

function fern() {
  const cx = 28, cy = 27
  const rand = rng(23)
  let fronds = ''
  const count = 15
  for (let k = 0; k < count; k++) {
    const angle = (k * 360) / count + (rand() - 0.5) * 10
    const length = 21 + rand() * 4
    const [tx, ty] = polar(cx, cy, angle, length)
    fronds += `<path d="M${cx},${cy} L${tx},${ty}" stroke="${PALETTE.leafDark}" stroke-width=".9" stroke-linecap="round" stroke-opacity=".8"/>`
    const pairs = 8
    for (let i = 1; i <= pairs; i++) {
      const t = 0.2 + 0.8 * (i / pairs)
      const [px, py] = polar(cx, cy, angle, length * t)
      const size = 1 - (i / (pairs + 3)) * 0.8
      for (const side of [-1, 1]) {
        fronds += `<ellipse cx="${px}" cy="${py}" rx="${r2(1.5 * size + 0.3)}" ry="${r2(4 * size + 0.6)}" ` +
          `transform="rotate(${r2(angle + side * 62)} ${px} ${py}) translate(0 ${r2(-2.4 * size)})" fill="${(i + k) % 2 ? PALETTE.leaf2 : PALETTE.leaf4}"/>`
      }
    }
  }
  return shadowDot(cx, cy + 4, 22) + pot(cx, cy, 11, PALETTE.ceramic, '#6F7A6A') + fronds +
    `<circle cx="${cx}" cy="${cy}" r="2.2" fill="${PALETTE.leaf5}"/>`
}

function palm() {
  const cx = 32, cy = 31
  const rand = rng(37)
  const colors = [PALETTE.leafDark, PALETTE.leaf1, PALETTE.leaf2, PALETTE.leaf3]
  let leaves = ''
  const count = 10
  for (let i = 0; i < count; i++) {
    const angle = (i * 360) / count + (rand() - 0.5) * 12
    const len = 27 + rand() * 4
    const wid = 4.4 + rand() * 0.8
    const fill = colors[i % colors.length]
    leaves += leaf({ x: cx, y: cy, angle, len, wid, fill, rib: true })
    // 羽状小叶的斜纹：从叶脉向两侧斜向叶尖
    let hatch = ''
    for (let t = 0.2; t < 0.92; t += 0.07) {
      const y = -len * t
      const w = wid * Math.sin(Math.PI * Math.pow(t, 0.8)) * 0.85
      hatch += `M0,${r2(y)} L${r2(w)},${r2(y - 2.4)} M0,${r2(y)} L${r2(-w)},${r2(y - 2.4)} `
    }
    leaves += `<path transform="translate(${cx} ${cy}) rotate(${r2(angle)})" d="${hatch.trim()}" stroke="${PALETTE.leafLight}" stroke-opacity=".6" stroke-width=".55" fill="none" stroke-linecap="round"/>`
  }
  return shadowDot(cx, cy + 5, 26) + pot(cx, cy, 12, '#8D9892', '#5E665F') + leaves +
    `<circle cx="${cx}" cy="${cy}" r="2.4" fill="${PALETTE.leaf5}"/>`
}

function bush() {
  const cx = 24, cy = 23
  const rand = rng(53)
  const dots = []
  for (let i = 0; i < 96; i++) {
    const a = rand() * Math.PI * 2
    const d = Math.sqrt(rand()) * 16.5
    const x = cx + Math.cos(a) * d
    const y = cy + Math.sin(a) * d
    // 左上受光：越靠左上越亮
    const light = clampUnit(0.5 - ((x - cx) + (y - cy)) / (2 * 18 * 1.6) + (rand() - 0.5) * 0.35)
    dots.push({ x, y, a: rand() * 180, light })
  }
  dots.sort((p, q) => p.light - q.light)
  const shades = [PALETTE.leafDark, PALETTE.leaf1, PALETTE.leaf2, PALETTE.leaf3, PALETTE.leaf4, PALETTE.leaf5]
  return shadowDot(cx, cy + 4, 20) +
    `<circle cx="${cx}" cy="${r2(cy + 1.2)}" r="19" fill="${PALETTE.leafDark}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="18.4" fill="${PALETTE.leaf1}"/>` +
    dots.map((d) => `<ellipse cx="${r2(d.x)}" cy="${r2(d.y)}" rx="3.4" ry="2.3" transform="rotate(${r2(d.a)} ${r2(d.x)} ${r2(d.y)})" fill="${shades[Math.min(shades.length - 1, Math.floor(d.light * shades.length))]}"/>`).join('') +
    `<path d="M12,14 C14,10.5 18,8.6 22,8.4" stroke="${PALETTE.leafLight}" stroke-opacity=".7" stroke-width="1.2" fill="none" stroke-linecap="round"/>`
}

function succulent() {
  const cx = 16, cy = 16
  const ring = (count, offset, len, wid, fill) =>
    Array.from({ length: count }, (_, i) =>
      leaf({ x: cx, y: cy, angle: offset + (i * 360) / count, len, wid, fill, rib: false, stroke: '#4F7049' })).join('')
  return shadowDot(cx, cy + 2.5, 14) +
    `<circle cx="${cx}" cy="${cy + 1}" r="12.5" fill="${PALETTE.ceramicSide}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="12.5" fill="${PALETTE.ceramic}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="10.6" fill="${PALETTE.soil}"/>` +
    ring(8, 0, 11, 3.6, PALETTE.leaf3) + ring(6, 30, 8, 3.2, PALETTE.leaf4) + ring(5, 12, 5, 2.4, PALETTE.leafLight) +
    `<circle cx="${cx}" cy="${cy}" r="1.5" fill="#D6E2B8"/>`
}

function cactus() {
  const cx = 16, cy = 16
  let ribs = ''
  let spines = ''
  for (let i = 0; i < 8; i++) {
    const [x1, y1] = polar(cx, cy, i * 45, 1.5)
    const [x2, y2] = polar(cx, cy, i * 45, 8)
    ribs += `M${x1},${y1} L${x2},${y2} `
    const [sx, sy] = polar(cx, cy, i * 45 + 22.5, 5.6)
    spines += `<circle cx="${sx}" cy="${sy}" r=".55" fill="${PALETTE.woodLight}"/>`
  }
  return shadowDot(cx, cy + 2.5, 14) +
    `<circle cx="${cx}" cy="${cy + 1}" r="12.5" fill="#9C8465"/>` +
    `<circle cx="${cx}" cy="${cy}" r="12.5" fill="${PALETTE.potClay}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="10" fill="${PALETTE.soil}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="8.4" fill="#5F8A5E"/>` +
    `<circle cx="${cx}" cy="${cy}" r="7.6" fill="#6A9468"/>` +
    `<path d="${ribs.trim()}" stroke="#8FB488" stroke-width=".8" stroke-linecap="round"/>` + spines +
    `<circle cx="${cx}" cy="${cy}" r="2.7" fill="#E8A9B4"/><circle cx="${cx}" cy="${cy}" r="1.1" fill="#F6D365"/>`
}

function hedgePlanter() {
  const rand = rng(71)
  const shades = [PALETTE.leaf1, PALETTE.leaf2, PALETTE.leaf3, PALETTE.leaf2, PALETTE.leaf4]
  let bushes = ''
  const centers = Array.from({ length: 9 }, (_, i) => 11 + i * 11.25)
  centers.forEach((x, i) => {
    const y = 14.5 + (rand() - 0.5) * 2.4
    bushes += `<circle cx="${r2(x)}" cy="${r2(y + 1)}" r="9.6" fill="${PALETTE.leafDark}"/>` +
      `<circle cx="${r2(x)}" cy="${r2(y)}" r="9.2" fill="${shades[i % shades.length]}"/>`
  })
  centers.forEach((x, i) => {
    const y = 14.5 + (rand() - 0.5) * 2.4
    bushes += `<circle cx="${r2(x - 1.6)}" cy="${r2(y - 2.2)}" r="5" fill="${PALETTE.leaf5}" fill-opacity=".75"/>` +
      `<circle cx="${r2(x - 2.4)}" cy="${r2(y - 3.2)}" r="1.9" fill="${PALETTE.leafLight}" fill-opacity=".8"/>`
    if (i % 2 === 0) bushes += `<circle cx="${r2(x + 3.6)}" cy="${r2(y + 2.8)}" r="1" fill="#E8C4C0"/>`
  })
  return `<rect x="0" y="2.5" width="112" height="29.5" rx="6" fill="${PALETTE.ceramicSide}"/>` +
    `<rect x="0.5" y="0.5" width="111" height="28" rx="5.5" fill="${PALETTE.ceramic}" stroke="#E2DED6"/>` +
    `<line x1="6" y1="2.2" x2="106" y2="2.2" stroke="#FFFFFF" stroke-opacity=".9"/>` +
    `<rect x="4" y="4" width="104" height="21" rx="4" fill="${PALETTE.soil}"/>` + bushes
}

// ---------------------------------------------------------------- 家具

function sageGradient(id) {
  return `<linearGradient id="${id}" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#9EAEA5"/><stop offset="100%" stop-color="${PALETTE.sage}"/></linearGradient>`
}

function armchair() {
  return `<defs>${sageGradient('seat')}</defs>` +
    `<rect x="0" y="3" width="72" height="69" rx="10" fill="${PALETTE.sageDark}"/>` +
    `<rect x="0.5" y="0.5" width="71" height="68" rx="10" fill="${PALETTE.sage}" stroke="${PALETTE.sageStroke}"/>` +
    `<rect x="2" y="2" width="68" height="15" rx="6" fill="${PALETTE.sageLight}"/>` +
    `<line x1="10" y1="5" x2="62" y2="5" stroke="${PALETTE.sageHighlight}"/>` +
    `<rect x="14" y="22" width="44" height="43" rx="7" fill="url(#seat)" stroke="#71887A"/>` +
    `<rect x="2" y="15" width="10" height="49" rx="4" fill="${PALETTE.sageLight}"/>` +
    `<rect x="60" y="15" width="10" height="49" rx="4" fill="${PALETTE.sageLight}"/>` +
    `<path d="M5,21 L5,57 M63,21 L63,57" stroke="${PALETTE.sageHighlight}"/>` +
    `<g transform="rotate(14 46 31)"><rect x="39" y="24" width="14" height="14" rx="3.5" fill="#C9AE6E"/><rect x="39.5" y="24.5" width="13" height="12.6" rx="3" fill="#E1C888"/><path d="M42,27 L50,27" stroke="#F2E2B4" stroke-width="1" stroke-linecap="round"/></g>`
}

function coffeeTable() {
  return shadowDot(32, 35, 29) +
    `<circle cx="32" cy="32" r="28" fill="${PALETTE.woodSide}"/>` +
    `<circle cx="32" cy="30" r="27.5" fill="${PALETTE.wood}" stroke="${PALETTE.woodStroke}"/>` +
    `<circle cx="32" cy="30" r="21.5" fill="none" stroke="#E8D4B6" stroke-width=".9"/>` +
    `<path d="M13,18 C16,11 22,7.4 29,6.6" stroke="${PALETTE.woodLight}" stroke-width="1.3" fill="none" stroke-linecap="round"/>` +
    `<g transform="rotate(-12 27 31)"><rect x="19" y="21" width="16" height="21" rx="1.6" fill="#6F8578"/><rect x="19" y="20.2" width="16" height="21" rx="1.6" fill="#8FA29B"/><rect x="20.4" y="21.6" width="13.2" height="18" rx="1" fill="#F5F3EF" fill-opacity=".9"/><path d="M19.6,22 L19.6,40" stroke="#6F8578" stroke-width="1.2"/><path d="M23,26 L31,26 M23,29 L29,29" stroke="#C4C0B8" stroke-width=".8"/></g>` +
    `<circle cx="42.5" cy="38.5" r="5" fill="${PALETTE.ceramicSide}"/><circle cx="42.5" cy="37.8" r="4.6" fill="${PALETTE.ceramic}" stroke="${PALETTE.ceramicSide}" stroke-width=".6"/>` +
    `<circle cx="42.5" cy="37.8" r="3.1" fill="#8A6F55"/><path d="M40.6,36.6 C41.3,35.8 42.4,35.5 43.4,35.7" stroke="#B89B7C" stroke-width=".7" fill="none"/>` +
    `<rect x="46.6" y="36.8" width="3.4" height="2" rx="1" fill="${PALETTE.ceramic}" stroke="${PALETTE.ceramicSide}" stroke-width=".5"/>`
}

function sideTable() {
  return `<rect x="0" y="2" width="40" height="37" rx="4" fill="${PALETTE.woodSide}"/>` +
    `<rect x="0.5" y="0.5" width="39" height="35" rx="3.5" fill="${PALETTE.wood}" stroke="${PALETTE.woodStroke}"/>` +
    `<line x1="4" y1="2.4" x2="36" y2="2.4" stroke="${PALETTE.woodLight}"/>` +
    `<circle cx="20.6" cy="19.4" r="11.5" ${SHADOW}/>` +
    `<circle cx="20" cy="18" r="11.5" fill="#E9DDC1" stroke="#D2C29E"/>` +
    `<circle cx="20" cy="18" r="8" fill="#F6EDD6"/>` +
    `<path d="M20,18 L20,7 M20,18 L31,18 M20,18 L20,29 M20,18 L9,18" stroke="#E2D3AF" stroke-width=".6"/>` +
    `<circle cx="20" cy="18" r="2.4" fill="#CFB18D"/>` +
    `<path d="M12.6,12.4 C14.4,9.8 17.2,8.4 20,8.2" stroke="#FFFFFF" stroke-opacity=".85" stroke-width="1" fill="none" stroke-linecap="round"/>`
}

function sideboard() {
  const books = [
    ['#8FA29B', 0], ['#C9AE6E', 1.2], ['#B88E86', 2.2], ['#6F8578', 3.2],
  ].map(([fill, lift], i) => `<rect x="${r2(10 + lift)}" y="${r2(8.6 + i * 3.4 - lift * 0.4)}" width="${r2(22 - i * 1.4)}" height="3" rx=".8" fill="${fill}" stroke="#35423E" stroke-opacity=".15" stroke-width=".4"/>`).join('')
  return `<rect x="0" y="2.5" width="128" height="29.5" rx="3.5" fill="${PALETTE.woodSide}"/>` +
    `<rect x="0.5" y="0.5" width="127" height="28" rx="3" fill="${PALETTE.wood}" stroke="${PALETTE.woodStroke}"/>` +
    `<line x1="5" y1="2.5" x2="123" y2="2.5" stroke="${PALETTE.woodLight}"/>` +
    `<path d="M0,25.5 L128,25.5 M64,25.5 L64,31" stroke="#A98F6C"/>` +
    `<path d="M8,12.5 L120,12.5" stroke="#B79A79" stroke-opacity=".2"/>` +
    // 书堆
    `<rect x="9" y="8" width="24" height="14" rx="1.5" ${SHADOW}/>` + books +
    // 花瓶 + 枝叶
    shadowDot(61.5, 16, 7) +
    `<circle cx="60" cy="13.6" r="5.6" fill="${PALETTE.ceramic}" stroke="${PALETTE.ceramicSide}" stroke-width=".6"/><circle cx="60" cy="13.6" r="3.4" fill="#6F7A6A"/>` +
    leaf({ x: 60, y: 13.6, angle: -35, len: 9, wid: 2.6, fill: PALETTE.leaf3, rib: false }) +
    leaf({ x: 60, y: 13.6, angle: 28, len: 10, wid: 2.8, fill: PALETTE.leaf2, rib: false }) +
    leaf({ x: 60, y: 13.6, angle: 150, len: 8, wid: 2.4, fill: PALETTE.leaf4, rib: false }) +
    // 相框：只看得到立着的细边与相纸顶面
    `<rect x="86" y="9.5" width="20" height="3.4" rx=".8" fill="#6F6654"/><rect x="86.6" y="10" width="18.8" height="1.5" rx=".5" fill="#F5F3EF"/>` +
    `<rect x="112" y="9.6" width="9" height="9" rx="2" fill="${PALETTE.ceramicSide}"/><rect x="112" y="8.8" width="9" height="9" rx="2" fill="${PALETTE.ceramic}" stroke="${PALETTE.ceramicSide}" stroke-width=".5"/><circle cx="116.5" cy="13.3" r="2.4" fill="#B6D1D6"/>`
}

function bench() {
  return `<defs>${sageGradient('cushion')}</defs>` +
    `<rect x="0" y="3" width="112" height="33" rx="6.5" fill="${PALETTE.woodSide}"/>` +
    `<rect x="0.5" y="0.5" width="111" height="31" rx="6" fill="${PALETTE.wood}" stroke="${PALETTE.woodStroke}"/>` +
    `<line x1="8" y1="2.6" x2="104" y2="2.6" stroke="${PALETTE.woodLight}"/>` +
    `<rect x="6" y="5" width="100" height="22" rx="5" fill="url(#cushion)" stroke="#71887A"/>` +
    `<path d="M39,6.5 L39,25.5 M73,6.5 L73,25.5" stroke="#71887A" stroke-opacity=".7"/>` +
    `<path d="M10,7.8 L102,7.8" stroke="${PALETTE.sageHighlight}" stroke-opacity=".9"/>` +
    `<path d="M0,30.5 L112,30.5" stroke="#A98F6C" stroke-opacity=".7"/>`
}

// ---------------------------------------------------------------- 摆件 / 设施

function rugRect() {
  let fringe = ''
  for (let y = 10; y <= 86; y += 4) fringe += `M0.5,${y} L4,${y} M140,${y} L143.5,${y} `
  // 6 个菱形（宽 12、间距 16）总宽 92，以地毯中线 x=72 居中，落在虚线内框 20–124 之内
  const diamonds = Array.from({ length: 6 }, (_, i) => {
    const x = 26 + i * 16
    return `<path d="M${x},48 L${x + 6},41 L${x + 12},48 L${x + 6},55 Z" fill="${i % 2 ? '#D1C3A8' : '#B9C7BC'}" fill-opacity=".85"/>`
  }).join('')
  return `<rect x="4" y="0.5" width="136" height="95" rx="12" fill="#D9CFBC"/>` +
    `<rect x="7.5" y="4" width="129" height="88" rx="9" fill="none" stroke="#C2B49A" stroke-width="1.6"/>` +
    `<rect x="14" y="10.5" width="116" height="75" rx="6" fill="#E6DECE" stroke="#CDBFA6" stroke-width=".8"/>` +
    `<rect x="20" y="16.5" width="104" height="63" rx="3" fill="none" stroke="#C2B49A" stroke-opacity=".7" stroke-width=".8" stroke-dasharray="3 2.4"/>` +
    diamonds +
    `<path d="M28,28 L116,28 M28,68 L116,68" stroke="#CDBFA6" stroke-width=".8"/>` +
    `<path d="${fringe.trim()}" stroke="#C2B49A" stroke-width=".9" stroke-linecap="round"/>`
}

function rugRound() {
  const petals = Array.from({ length: 12 }, (_, i) => {
    const [x, y] = polar(48, 48, i * 30, 27)
    return `<ellipse cx="${x}" cy="${y}" rx="2.4" ry="5.2" transform="rotate(${i * 30} ${x} ${y})" fill="#9FB3A5" fill-opacity=".75"/>`
  }).join('')
  return `<circle cx="48" cy="48" r="47.5" fill="#B9C7BC"/>` +
    `<circle cx="48" cy="48" r="43" fill="none" stroke="#E4E9E2" stroke-width="2"/>` +
    `<circle cx="48" cy="48" r="38.5" fill="#D7E0D6" stroke="#9FB3A5" stroke-width=".8"/>` +
    petals +
    `<circle cx="48" cy="48" r="17" fill="#E4E9E2" stroke="#9FB3A5" stroke-width=".8"/>` +
    `<circle cx="48" cy="48" r="11" fill="#B9C7BC"/>` +
    `<circle cx="48" cy="48" r="4.2" fill="#E4E9E2"/>`
}

function floorLamp() {
  return shadowDot(16, 19, 13) +
    `<circle cx="16" cy="16.5" r="12" fill="#D2C29E"/>` +
    `<circle cx="16" cy="15.5" r="12" fill="#E9DDC1" stroke="#D2C29E"/>` +
    `<circle cx="16" cy="15.5" r="8" fill="#F6EDD6"/>` +
    `<path d="M16,15.5 L16,7.5 M16,15.5 L24,15.5 M16,15.5 L16,23.5 M16,15.5 L8,15.5" stroke="#E2D3AF" stroke-width=".6"/>` +
    `<circle cx="16" cy="15.5" r="2.4" fill="#B9A57F"/>` +
    `<path d="M8.6,10.4 C10.2,8 12.8,6.6 15.6,6.4" stroke="#FFFFFF" stroke-opacity=".85" stroke-width="1" fill="none" stroke-linecap="round"/>`
}

function trashBin() {
  return shadowDot(12, 14, 10.4, 0.12) +
    `<circle cx="12" cy="12" r="10" fill="#858E88"/>` +
    `<circle cx="12" cy="11.2" r="10" fill="#9AA39D" stroke="#858E88" stroke-width=".6"/>` +
    `<circle cx="12" cy="11.2" r="8.4" fill="#B8C0BB"/>` +
    `<circle cx="12" cy="11.4" r="6.8" fill="#6F7873"/>` +
    `<path d="M7.4,9.4 C8.2,7.8 9.6,6.9 11.2,6.7" stroke="#8C9590" stroke-width="1" fill="none" stroke-linecap="round"/>` +
    `<circle cx="10.2" cy="11.4" r="1.9" fill="#F5F3EF"/><circle cx="14.4" cy="12.8" r="1.5" fill="#E2DED6"/>` +
    `<path d="M6,4.8 C7.4,3.4 9.2,2.6 11,2.5" stroke="#FFFFFF" stroke-opacity=".6" stroke-width="1" fill="none" stroke-linecap="round"/>`
}

function printer() {
  return `<rect x="0" y="3" width="56" height="45" rx="6.5" fill="${PALETTE.ceramicSide}"/>` +
    `<rect x="0.5" y="0.5" width="55" height="43" rx="6" fill="${PALETTE.ceramic}" stroke="#E2DED6"/>` +
    `<rect x="5" y="4" width="46" height="24" rx="3.5" fill="#E9EEEC" stroke="#D6DCD9"/>` +
    `<rect x="8" y="7" width="40" height="18" rx="2.5" fill="#D9E8E8"/>` +
    `<path d="M13,24 L23,8 M22,24 L32,8" stroke="#FFFFFF" stroke-opacity=".7" stroke-width="2" stroke-linecap="round"/>` +
    `<rect x="5" y="31" width="28" height="8.5" rx="2.2" fill="#708780"/>` +
    `<rect x="7" y="32.6" width="11" height="5.3" rx="1" fill="#B6D1D6"/>` +
    `<circle cx="22.6" cy="35.3" r="1.5" fill="#CFB18D"/><circle cx="27.4" cy="35.3" r="1.5" fill="#B6D1D6"/>` +
    `<rect x="36.6" y="30.8" width="15" height="11" rx="1.5" ${SHADOW}/>` +
    `<rect x="36" y="29.4" width="15" height="11" rx="1.5" fill="#FFFFFF" stroke="#D6D2CA" stroke-width=".6"/>` +
    `<path d="M38.4,32.6 L48.6,32.6 M38.4,35 L46.6,35 M38.4,37.4 L47.6,37.4" stroke="#C9D2CF" stroke-width=".8" stroke-linecap="round"/>`
}

/**
 * 条目字段与 style.json 一致：id / name / category / width / height / blocksMovement / footprints，
 * 可选 zIndex / notes。svg() 返回 <svg> 内部内容，外壳由构建脚本统一生成。
 */
export const ITEMS = [
  // ---- 绿植
  {
    id: 'plant-monstera-top', name: '俯视龟背竹', category: '绿植', width: 64, height: 64,
    blocksMovement: true, footprints: [{ x: 17, y: 16, width: 30, height: 30 }],
    notes: '地面占地以花盆为准，叶片不扩大占地。', svg: monstera,
  },
  {
    id: 'plant-fern-top', name: '俯视蕨类盆栽', category: '绿植', width: 56, height: 56,
    blocksMovement: true, footprints: [{ x: 16, y: 15, width: 24, height: 24 }],
    notes: '地面占地以花盆为准，叶片不扩大占地。', svg: fern,
  },
  {
    id: 'plant-palm-top', name: '俯视散尾葵', category: '绿植', width: 64, height: 64,
    blocksMovement: true, footprints: [{ x: 20, y: 19, width: 24, height: 24 }],
    notes: '地面占地以花盆为准，叶片不扩大占地。', svg: palm,
  },
  {
    id: 'plant-bush-top', name: '俯视球形灌木', category: '绿植', width: 48, height: 48,
    blocksMovement: true, footprints: [{ x: 10, y: 9, width: 28, height: 28 }],
    notes: '地面占地取树冠内圈，外沿叶片不扩大占地。', svg: bush,
  },
  {
    id: 'plant-succulent-top', name: '俯视多肉（桌面）', category: '绿植', width: 32, height: 32,
    blocksMovement: false, zIndex: 7,
    notes: '桌面小摆件：图层高于桌面（0）和电脑（6），不阻挡行走。', svg: succulent,
  },
  {
    id: 'plant-cactus-top', name: '俯视仙人掌（桌面）', category: '绿植', width: 32, height: 32,
    blocksMovement: false, zIndex: 7,
    notes: '桌面小摆件：图层高于桌面（0）和电脑（6），不阻挡行走。', svg: cactus,
  },
  {
    id: 'planter-hedge-top', name: '俯视绿篱花槽', category: '绿植', width: 112, height: 32,
    blocksMovement: true, footprints: [{ x: 0, y: 0, width: 112, height: 30 }],
    notes: '长条花槽，可当半高隔断；横向摆放，旋转 90° 作纵向。', svg: hedgePlanter,
  },
  // ---- 家具
  {
    id: 'armchair-top', name: '俯视单人沙发', category: '家具', width: 72, height: 72,
    blocksMovement: true, footprints: [{ x: 0, y: 0, width: 72, height: 70 }], svg: armchair,
  },
  {
    id: 'coffee-table-top', name: '俯视圆茶几', category: '家具', width: 64, height: 64,
    blocksMovement: true, footprints: [{ x: 4, y: 2, width: 56, height: 56 }], svg: coffeeTable,
  },
  {
    id: 'side-table-top', name: '俯视边几台灯', category: '家具', width: 40, height: 40,
    blocksMovement: true, footprints: [{ x: 0, y: 0, width: 40, height: 37 }], svg: sideTable,
  },
  {
    id: 'sideboard-top', name: '俯视矮柜（带摆件）', category: '家具', width: 128, height: 32,
    blocksMovement: true, footprints: [{ x: 0, y: 0, width: 128, height: 29 }], svg: sideboard,
  },
  {
    id: 'bench-top', name: '俯视长凳', category: '家具', width: 112, height: 36,
    blocksMovement: true, footprints: [{ x: 0, y: 0, width: 112, height: 33 }], svg: bench,
  },
  // ---- 摆件 / 设施
  {
    id: 'rug-rect-top', name: '俯视方形地毯', category: '摆件', width: 144, height: 96,
    blocksMovement: false, zIndex: -90,
    notes: '地面装饰：图层在地面（-100）之上、家具（0）之下，不阻挡行走。', svg: rugRect,
  },
  {
    id: 'rug-round-top', name: '俯视圆形地毯', category: '摆件', width: 96, height: 96,
    blocksMovement: false, zIndex: -90,
    notes: '地面装饰：图层在地面（-100）之上、家具（0）之下，不阻挡行走。', svg: rugRound,
  },
  {
    id: 'floor-lamp-top', name: '俯视落地灯', category: '摆件', width: 32, height: 32,
    blocksMovement: true, footprints: [{ x: 9, y: 8, width: 14, height: 14 }],
    notes: '地面占地取灯杆底座，灯罩不扩大占地。', svg: floorLamp,
  },
  {
    id: 'trash-bin-top', name: '俯视垃圾桶', category: '摆件', width: 24, height: 24,
    blocksMovement: true, footprints: [{ x: 2, y: 1, width: 20, height: 20 }], svg: trashBin,
  },
  {
    id: 'printer-top', name: '俯视打印机', category: '设施', width: 56, height: 48,
    blocksMovement: true, footprints: [{ x: 0, y: 0, width: 56, height: 44 }], svg: printer,
  },
]
