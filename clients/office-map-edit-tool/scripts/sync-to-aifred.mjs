import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// 把编辑器样板地图与它引用的俯视素材同步到同级 clients/desktop 桌面端，供办公室页面 1:1 复刻渲染。
// AIFred 自有素材（chair.png / office_computer_bg.png）不复制，直接指向桌面端已有的 assets/office 文件。

const here = fileURLToPath(new URL('..', import.meta.url))
const aifredRoot = path.resolve(here, '../desktop')
const sourceMap = path.join(here, 'examples/office-10-person.json')
const targetRoot = path.join(aifredRoot, 'public/assets/office')
const targetTopdown = path.join(targetRoot, 'topdown')
const targetMap = path.join(targetRoot, 'map')
// 办公室渲染派生骨骼（原骨架 + 打字动画）：编辑器生成后同步给前端，两边渲染必须一致
const walkSkeleton = path.join(here, 'assets/aifred/characters/chibi-stickers/chibi-stickers-walk.json')
const targetWalkSkeleton = path.join(aifredRoot, 'public/assets/characters/chibi-stickers/chibi-stickers-walk.json')

const REWRITES = [
  [/^assets\/styles\/topdown-soft\//, 'assets/office/topdown/'],
  [/^assets\/aifred\/office\//, 'assets/office/'],
]

function rewriteSrc(src) {
  for (const [pattern, replacement] of REWRITES) if (pattern.test(src)) return src.replace(pattern, replacement)
  return src
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    throw new Error(`无法读取地图 ${file}: ${error.message}`)
  }
}

async function main() {
  const map = await readJson(sourceMap)
  await mkdir(targetTopdown, { recursive: true })
  await mkdir(path.dirname(targetWalkSkeleton), { recursive: true })
  await copyFile(walkSkeleton, targetWalkSkeleton)
  console.log('已同步行走骨骼 chibi-stickers-walk.json（原骨架 + 打字动画）')
  await mkdir(targetMap, { recursive: true })

  const provenance = []
  const missing = []
  for (const asset of map.assets) {
    const target = rewriteSrc(asset.src)
    if (target === asset.src && asset.src.startsWith('assets/aifred/office/')) {
      const buffer = await readFile(path.join(aifredRoot, 'public', asset.src))
      provenance.push({ source: asset.src, target: asset.src, bytes: buffer.length, sha256: sha256(buffer), mode: 'aifred-existing' })
      asset.src = target
      continue
    }
    const from = path.join(here, asset.src)
    const to = path.join(aifredRoot, 'public', target)
    try {
      const buffer = await readFile(from)
      await mkdir(path.dirname(to), { recursive: true })
      await copyFile(from, to)
      provenance.push({ source: asset.src, target, bytes: buffer.length, sha256: sha256(buffer), mode: 'copied' })
      asset.src = target
    } catch (error) {
      missing.push(`${asset.src}: ${error.message}`)
    }
  }
  if (missing.length) throw new Error(`同步失败，缺少素材：\n${missing.join('\n')}`)

  map.name = `${map.name}（AIFred 前端）`
  const mapTarget = path.join(targetMap, 'office-10-person.json')
  await writeFile(mapTarget, `${JSON.stringify(map, null, 2)}\n`)
  const mapBytes = await readFile(mapTarget)

  await writeFile(path.join(targetMap, 'manifest.json'), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'office-map-edit-tool/examples/office-10-person.json',
    map: { target: 'assets/office/map/office-10-person.json', bytes: mapBytes.length, sha256: sha256(mapBytes) },
    schema: map.schema,
    elements: map.elements.length,
    seats: map.seats.length,
    provenance,
  }, null, 2)}\n`)

  console.log(`Synced ${provenance.length} assets + map (${map.elements.length} elements, ${map.seats.length} seats) to ${path.relative(process.cwd(), targetRoot)}`)
}

await main()
