import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { patchOfficeAnimation, officeAnimationDiff, hasOfficeAnimationPatch, TYPING_ANIMATION } from '../src/work-anim.js'

// 生成「办公室渲染派生骨骼」：AIFred 原骨架保持 byte-exact 不动，这里输出派生文件
// chibi-stickers-walk.json（沿用历史文件名），内容 = 原骨架 + 工作打字动画 emotes/typing
// （见 src/work-anim.js）。走路动画保持原样，不再做膝盖取反（原因见 work-anim.js 顶部注释）。
// 供编辑器与 AIFred 前端渲染时使用，两边必须一致。
//
// 用法：node scripts/build-office-anim.mjs（npm run office:anim）

const source = new URL('../assets/aifred/characters/chibi-stickers/chibi-stickers.json', import.meta.url)
const output = new URL('../assets/aifred/characters/chibi-stickers/chibi-stickers-walk.json', import.meta.url)

let original
{
  let raw
  try {
    raw = await readFile(source, 'utf8')
  } catch (error) {
    console.error(`无法读取原骨架 ${source.pathname}：${error.message}`)
    process.exit(1)
  }
  try {
    original = JSON.parse(raw)
  } catch (error) {
    console.error(`原骨架 JSON 解析失败：${error.message}`)
    process.exit(1)
  }
}

let patched, stats
try {
  ({ patched, stats } = patchOfficeAnimation(original))
} catch (error) {
  console.error(`办公室动画补丁失败：${error.message}`)
  process.exit(1)
}

const expected = [TYPING_ANIMATION]
const changed = [...new Set(officeAnimationDiff(original, patched))].sort()
if (JSON.stringify(changed) !== JSON.stringify(expected)) {
  console.error(`只应新增 ${TYPING_ANIMATION}，实际改动：${changed.join(', ') || '无'}`)
  process.exit(1)
}
if (!hasOfficeAnimationPatch(patched)) {
  console.error('补丁标记缺失，补丁未生效')
  process.exit(1)
}

const serialized = `${JSON.stringify(patched)}\n`
await writeFile(output, serialized)
const sha = (text) => createHash('sha256').update(text).digest('hex')
console.log(`原骨架 chibi-stickers.json sha256=${sha(JSON.stringify(original)).slice(0, 16)}…（保持原样）`)
console.log(`派生骨骼 chibi-stickers-walk.json sha256=${sha(serialized).slice(0, 16)}… bytes=${serialized.length}`)
console.log(
  `新增 ${TYPING_ANIMATION}（${stats.typingTracks} 条骨骼轨道 / ${stats.typingKeys} 个关键帧）；其余动画与骨架结构逐字节一致`,
)
