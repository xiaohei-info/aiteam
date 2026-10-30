// 生成「俯视 · 轻立体」扩充图元（绿植 / 家具摆件）：
//   1. 按 scripts/topdown-extras/items.mjs 写出 <id>.svg
//   2. 用 Chrome 无头把每个 SVG 光栅成带透明通道的 <id>.png（1×）与 <id>@2x.png（2×），画布尺寸 = 图元尺寸，不自动裁切
//   3. 把图元元数据并入 assets/styles/topdown-soft/style.json（已有同 id 条目会被替换，重复运行结果不变）
//
// 用法：node scripts/build-topdown-extras.mjs
// 需要本机 Chrome；路径不在默认位置时设置 CHROME_PATH。
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ITEMS } from './topdown-extras/items.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const styleDir = path.join(root, 'assets/styles/topdown-soft')
const styleFile = path.join(styleDir, 'style.json')
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)

function chromePath() {
  const found = CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
  if (!found) throw new Error('找不到 Chrome，请设置 CHROME_PATH')
  return found
}

export function svgDocument(item) {
  const { id, width, height } = item
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg width="${width}px" height="${height}px" viewBox="0 0 ${width} ${height}" version="1.1" xmlns="http://www.w3.org/2000/svg">\n` +
    `    <title>${id}</title>\n` +
    `    <g id="Office-v2-/-${id}" stroke="none" fill="none" fill-rule="evenodd" stroke-width="1">${item.svg()}</g>\n` +
    `</svg>\n`
}

/** 整批图元放进同一个页面里，用 canvas 光栅后一次性取回 data URL，避免逐张起浏览器和截图裁切 */
async function rasterize(documents) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'topdown-extras-'))
  try {
    const page = path.join(work, 'render.html')
    const payload = JSON.stringify(documents).replaceAll('<', '\\u003c')
    await writeFile(page, `<!doctype html><meta charset="utf-8"><pre id="out">pending</pre><script>
const documents = ${payload};
const render = (doc, scale) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = doc.width * scale; canvas.height = doc.height * scale;
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    resolve(canvas.toDataURL('image/png'));
  };
  img.onerror = () => reject(new Error('SVG 解析失败：' + doc.id));
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(doc.svg);
});
(async () => {
  const out = {};
  for (const doc of documents) out[doc.id] = { 1: await render(doc, 1), 2: await render(doc, 2) };
  document.getElementById('out').textContent = JSON.stringify(out);
})().catch((error) => { document.getElementById('out').textContent = 'ERROR ' + error.message; });
</script>`)
    const dom = execFileSync(chromePath(), ['--headless=new', '--disable-gpu', '--virtual-time-budget=20000', '--dump-dom', `file://${page}`], {
      encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    })
    const match = dom.match(/<pre id="out">([^<]*)<\/pre>/)
    if (!match || match[1].startsWith('ERROR') || match[1] === 'pending') throw new Error(`光栅化失败：${match?.[1] ?? '没有输出'}`)
    return JSON.parse(match[1])
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/**
 * style.json 的既有排版：文件头 2 空格缩进，elements 里一个图元一行（4 空格缩进、紧凑 JSON），
 * 不同分组之间空一行。沿用这个排版，新增图元时 diff 只多出对应的行，不会把整个文件重排。
 */
const GROUP_ORDER = ['地面', 'wall', 'glass', '连接件', '家具', '绿植', '设施', '摆件', '门']
/** 「建筑」类里墙与玻璃各自成组，其余按 category 分组 */
const groupOf = (element) => (element.category === '建筑' ? element.id.split('-')[0] : element.category)
const groupRank = (element) => {
  const rank = GROUP_ORDER.indexOf(groupOf(element))
  return rank === -1 ? GROUP_ORDER.length : rank
}

/** 按分组顺序稳定排序：组内保持原有顺序，新图元落进各自的分组 */
export function orderElements(elements) {
  return elements
    .map((element, index) => ({ element, index }))
    .sort((a, b) => groupRank(a.element) - groupRank(b.element) || a.index - b.index)
    .map(({ element }) => element)
}

export function serializeStyle(style) {
  const placeholder = '__ELEMENTS__'
  const head = JSON.stringify({ ...style, elements: placeholder }, null, 2)
  const rows = style.elements.map((element, index) => {
    const separator = index === 0 ? '' : groupOf(style.elements[index - 1]) === groupOf(element) ? '\n' : '\n\n'
    return `${separator}    ${JSON.stringify(element)}${index === style.elements.length - 1 ? '' : ','}`
  }).join('')
  return `${head.replace(`"${placeholder}"`, `[\n${rows}\n  ]`)}\n`
}

const dataUrlToBuffer = (url) => Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64')

export function catalogEntry(item) {
  const entry = {
    id: item.id, name: item.name, category: item.category, kind: 'image',
    src: `assets/styles/topdown-soft/${item.id}.png`, width: item.width, height: item.height, blocksMovement: item.blocksMovement,
  }
  if (item.footprints) entry.footprints = item.footprints
  if (item.zIndex !== undefined) entry.zIndex = item.zIndex
  if (item.notes) entry.notes = item.notes
  return entry
}

async function main() {
  const ids = new Set(ITEMS.map((item) => item.id))
  if (ids.size !== ITEMS.length) throw new Error('图元 id 重复')
  const documents = ITEMS.map((item) => ({ id: item.id, width: item.width, height: item.height, svg: svgDocument(item) }))
  const rasters = await rasterize(documents)
  for (const doc of documents) {
    await writeFile(path.join(styleDir, `${doc.id}.svg`), doc.svg)
    await writeFile(path.join(styleDir, `${doc.id}.png`), dataUrlToBuffer(rasters[doc.id][1]))
    await writeFile(path.join(styleDir, `${doc.id}@2x.png`), dataUrlToBuffer(rasters[doc.id][2]))
  }
  const style = JSON.parse(await readFile(styleFile, 'utf8'))
  style.elements = orderElements([...style.elements.filter((element) => !ids.has(element.id)), ...ITEMS.map(catalogEntry)])
  await writeFile(styleFile, serializeStyle(style))
  console.log(`Generated ${ITEMS.length} topdown extras (SVG + PNG + @2x); catalog now has ${style.elements.length} elements.`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`topdown extras generation failed: ${error.message}`)
    process.exitCode = 1
  })
}
