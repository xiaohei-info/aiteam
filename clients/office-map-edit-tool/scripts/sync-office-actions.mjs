import { copyFile, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { addOfficeActions, removeOfficeActions, deriveOfficeAtlas, OFFICE_PROPS_PAGE } from '../src/office-actions.js'

// 把方向动作（坐下、喝茶等）打到桌面端自己的渲染骨骼上。
// 桌面端的 chibi-stickers-walk.json 与编辑器的不是同一份：它有正装皮肤（biz/shirt-tie-*）和自己的走路修正，
// 所以不能整份复制编辑器的派生文件，只在桌面端骨骼上先撤掉旧的方向动作、再重新追加。
// 图集同理：桌面端 chibi-stickers.atlas 多一页 chibi-biz.png，派生图集以它为底追加道具页。
//
// 用法：node scripts/sync-office-actions.mjs（npm run office:anim:desktop）

const here = fileURLToPath(new URL('..', import.meta.url))

export async function syncOfficeActionsToDesktop(desktopRoot = path.resolve(here, '../desktop')) {
  const dir = path.join(desktopRoot, 'public/assets/characters/chibi-stickers')
  const skeletonFile = path.join(dir, 'chibi-stickers-walk.json')
  let skeleton
  try {
    skeleton = JSON.parse(await readFile(skeletonFile, 'utf8'))
  } catch (error) {
    throw new Error(`无法读取桌面端骨骼 ${skeletonFile}：${error.message}`, { cause: error })
  }
  removeOfficeActions(skeleton)
  const count = addOfficeActions(skeleton)
  await writeFile(skeletonFile, JSON.stringify(skeleton))
  await writeFile(path.join(dir, 'chibi-stickers-office.atlas'), deriveOfficeAtlas(await readFile(path.join(dir, 'chibi-stickers.atlas'), 'utf8')))
  await copyFile(path.join(here, 'assets/aifred/characters/chibi-stickers', OFFICE_PROPS_PAGE), path.join(dir, OFFICE_PROPS_PAGE))
  return count
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const count = await syncOfficeActionsToDesktop()
    console.log(`桌面端骨骼已追加 ${count} 个方向动作，派生图集与道具图已写入`)
  } catch (error) {
    console.error(`方向动作同步失败：${error.message}`)
    process.exitCode = 1
  }
}
