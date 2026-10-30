import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = path.resolve(root, '../desktop')
const target = path.join(root, 'assets/aifred')
try {
  const files = ['assets/office/desk.png', 'assets/office/chair.png', 'assets/office/office_computer_bg.png']
  const characterDirectory = 'assets/characters/chibi-stickers'
  const characterFiles = await readdir(path.join(source, 'public', characterDirectory))
  files.push(...characterFiles.filter(name => /\.(png|json|atlas)$/.test(name)).sort().map(name => `${characterDirectory}/${name}`))
  const provenance = []
  for (const file of files) {
    const from = path.join(source, 'public', file)
    const relative = file.slice('assets/'.length)
    const to = path.join(target, relative)
    await mkdir(path.dirname(to), { recursive: true })
    await copyFile(from, to)
    const data = await readFile(from)
    provenance.push({ source: `AITeam/public/${file}`, target: `assets/aifred/${relative}`, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length })
  }
  const registry = await readFile(path.join(source, 'src/config/office/characters.ts'), 'utf8')
  const skinsBlock = registry.match(/CHIBI_CHARACTER_SKINS\s*=\s*\[([^\]]+)\]/)?.[1]
  const skins = [...(skinsBlock || '').matchAll(/'([^']+)'/g)].map(match => match[1])
  const skeleton = JSON.parse(await readFile(path.join(target, 'characters/chibi-stickers/chibi-stickers.json'), 'utf8'))
  if (skins.length !== 9 || skins.some(name => !skeleton.skins.some(s => s.name === name))) throw new Error('AIFred皮肤注册表与骨架不匹配')
  const manifest = { id: 'aifred-chibi-stickers', sourceProject: 'AITeam (AIFred frontend)', skeleton: 'assets/aifred/characters/chibi-stickers/chibi-stickers.json', atlas: 'assets/aifred/characters/chibi-stickers/chibi-stickers.atlas', skins, spineVersion: skeleton.skeleton.spine, animations: Object.keys(skeleton.animations), provenance }
  await writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`Synced ${files.length} original AIFred files and ${skins.length} character skins; source files unchanged.`)
} catch (error) {
  console.error(`AIFred asset sync failed: ${error.message}`)
  process.exitCode = 1
}
