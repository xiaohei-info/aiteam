import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 回归：群聊输入框粘贴后发送按钮不可用。
// 根因是 MentionInput.handleInput 在 window.getSelection() 为 null / rangeCount 为 0 时
// 提前 return，跳过了末尾的 extract(el) + onChange，导致 mentionText 不更新、发送按钮一直禁用。
const source = readFileSync(new URL('../src/components/Chat/MentionInput.tsx', import.meta.url), 'utf8')
const start = source.indexOf('const handleInput = useCallback')
assert.ok(start > 0, '找不到 MentionInput.handleInput')
const body = source.slice(start, source.indexOf('}, [closeMenu, emit])', start))
const emitStart = source.indexOf('const emit = useCallback')
const emitBody = source.slice(emitStart, source.indexOf('}, [onChange])', emitStart))

test('handleInput 不再因 selection 缺失而提前 return', () => {
  assert.equal(
    body.includes('if (!sel || !sel.rangeCount) return'),
    false,
    'handleInput 仍以 selection 缺失为理由提前 return，粘贴后发送按钮会保持禁用',
  )
})

test('handleInput 始终用 extract 同步文本并回调 onChange', () => {
  // emit = extract + 空态标记 + onChange，所有改动内容的路径都经过它。
  assert.ok(emitStart > 0, '找不到 MentionInput.emit')
  assert.ok(emitBody.includes('const value = extract(el)'), 'emit 缺少 extract(el)')
  assert.ok(emitBody.includes('onChange(value.text, value.mentions)'), 'emit 缺少 onChange 回调')
  // 回调必须在函数末尾，不被任何 return 分支绕过
  assert.ok(body.trimEnd().endsWith('emit(el)'), 'emit(el) 应位于 handleInput 末尾')
})

test('selection 缺失时仍关闭 @ 菜单但不丢文本', () => {
  assert.ok(body.includes('const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null'))
  assert.ok(body.includes('} else {\n      closeMenu()\n    }'), 'selection 缺失分支应关闭 @ 菜单')
})

// 回归（PR #232 复核）：只贴图片时框内显示图片但发送键为灰。
// 根因是 handlePaste 在没有 text/plain 时不 preventDefault，浏览器默认粘贴把 <img> 塞进
// contenteditable；extract 只取文本，于是内容看得见却发不出去。
const pasteStart = source.indexOf('const handlePaste = useCallback')
assert.ok(pasteStart > 0, '找不到 MentionInput.handlePaste')
const pasteBody = source.slice(pasteStart, source.indexOf('}, [disabled, insertPlainText, showHint])', pasteStart))

test('handlePaste 先 preventDefault，再判断有没有纯文本', () => {
  const prevent = pasteBody.indexOf('e.preventDefault()')
  const plain = pasteBody.indexOf("getData('text/plain')")
  assert.ok(prevent > 0, 'handlePaste 缺少 e.preventDefault()')
  assert.ok(plain > 0, 'handlePaste 未读取 text/plain')
  assert.ok(prevent < plain, 'preventDefault 必须在读取剪贴板之前，否则图片会被默认粘贴塞进输入框')
})

test('没有纯文本时提示改用附件按钮而不是静默放行', () => {
  assert.ok(pasteBody.includes('carriesFiles(e.clipboardData)'), '应识别剪贴板里的图片/文件')
  assert.ok(pasteBody.includes('showHint('), '忽略图片时应给出提示')
})

test('拖入图片/文件同样被拦截', () => {
  const dropStart = source.indexOf('const handleDrop = useCallback')
  assert.ok(dropStart > 0, '缺少 onDrop 处理：拖入的图片会直接落进 contenteditable')
  const dropBody = source.slice(dropStart, source.indexOf('}, [disabled, insertPlainText, showHint])', dropStart))
  assert.ok(dropBody.includes('e.preventDefault()'), 'handleDrop 缺少 preventDefault')
  assert.ok(dropBody.includes('carriesFiles(e.dataTransfer)'), 'handleDrop 未拦截文件拖入')
  assert.ok(source.includes('onDrop={handleDrop}'), 'handleDrop 未挂到输入框上')
})

// 回归（PR #232 复核）：恢复草稿后光标在开头，新输入的字插在草稿前面。
test('setText 写入后把光标放到末尾', () => {
  const setTextStart = source.indexOf('setText: (text: string) => {')
  assert.ok(setTextStart > 0, '找不到 MentionInput.setText')
  const setTextBody = source.slice(setTextStart, source.indexOf('snapshot: () =>', setTextStart))
  assert.ok(setTextBody.includes('caretToEnd(el)'), 'setText 未把光标移到末尾，草稿恢复后输入会插在最前面')
})

test('程序化 focus 时光标不留在开头', () => {
  const focusStart = source.indexOf('focus: () => {')
  assert.ok(focusStart > 0, 'focus 句柄应显式处理光标位置')
  const focusBody = source.slice(focusStart, source.indexOf('setText: (text: string) =>', focusStart))
  assert.ok(focusBody.includes('caretToEnd(el)'), 'focus() 未在选区不在输入框内时把光标移到末尾')
})
