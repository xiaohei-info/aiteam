import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 回归：群聊输入框粘贴后发送按钮不可用。
// 根因是 MentionInput.handleInput 在 window.getSelection() 为 null / rangeCount 为 0 时
// 提前 return，跳过了末尾的 extract(el) + onChange，导致 mentionText 不更新、发送按钮一直禁用。
const source = readFileSync(new URL('../src/components/Chat/MentionInput.tsx', import.meta.url), 'utf8')
const start = source.indexOf('const handleInput = useCallback')
assert.ok(start > 0, '找不到 MentionInput.handleInput')
const body = source.slice(start, source.indexOf('}, [closeMenu, onChange])', start))

test('handleInput 不再因 selection 缺失而提前 return', () => {
  assert.equal(
    body.includes('if (!sel || !sel.rangeCount) return'),
    false,
    'handleInput 仍以 selection 缺失为理由提前 return，粘贴后发送按钮会保持禁用',
  )
})

test('handleInput 始终用 extract 同步文本并回调 onChange', () => {
  assert.ok(body.includes('const { text, mentions } = extract(el)'), '缺少 extract(el)')
  assert.ok(body.includes('onChange(text, mentions)'), '缺少 onChange 回调')
  // 回调必须在函数末尾，不被任何 return 分支绕过
  assert.ok(body.trimEnd().endsWith('onChange(text, mentions)'), 'onChange 回调应位于 handleInput 末尾')
})

test('selection 缺失时仍关闭 @ 菜单但不丢文本', () => {
  assert.ok(body.includes('const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null'))
  assert.ok(body.includes('} else {\n      closeMenu()\n    }'), 'selection 缺失分支应关闭 @ 菜单')
})
