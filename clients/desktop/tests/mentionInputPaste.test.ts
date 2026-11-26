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
const pasteBody = source.slice(pasteStart, source.indexOf('}, [disabled, insertPlainText, takeFiles])', pasteStart))

test('handlePaste 先 preventDefault，再判断有没有纯文本', () => {
  const prevent = pasteBody.indexOf('e.preventDefault()')
  const plain = pasteBody.indexOf("getData('text/plain')")
  assert.ok(prevent > 0, 'handlePaste 缺少 e.preventDefault()')
  assert.ok(plain > 0, 'handlePaste 未读取 text/plain')
  assert.ok(prevent < plain, 'preventDefault 必须在读取剪贴板之前，否则图片会被默认粘贴塞进输入框')
})

// 复核意见（PR #232）：图片/文件的粘贴与拖入要和点击「+ 导入」一样处理，不能无脑拦截。
const takeStart = source.indexOf('const takeFiles = useCallback')
assert.ok(takeStart > 0, '找不到 MentionInput.takeFiles')
const takeBody = source.slice(takeStart, source.indexOf('}, [onFiles, showHint])', takeStart))

test('粘贴的图片/文件交给 onFiles，而不是丢掉', () => {
  assert.ok(pasteBody.includes("takeFiles(e.clipboardData, 'paste')"), 'handlePaste 未把剪贴板里的文件交给附件导入')
  assert.ok(takeBody.includes('onFiles(files)'), 'takeFiles 未回调 onFiles')
  assert.ok(source.includes('onFiles?: (files: File[]) => void'), 'MentionInput 缺少 onFiles 入参')
})

test('文本和图片同时存在时只贴文字，没有文字时才作附件', () => {
  const insert = pasteBody.indexOf('insertPlainText(el, pasted)')
  const take = pasteBody.indexOf('takeFiles(')
  assert.ok(insert > 0 && take > insert, '应先判断文字：有文字只插入文字，之后才轮到附件')
  const textBranch = pasteBody.slice(pasteBody.indexOf('if (pasted) {'), take)
  assert.ok(textBranch.includes('return'), '有文字时应直接返回，不能把同一次粘贴里的图片也加成附件')
})

test('没有 onFiles（宿主未接附件）时才提示改用附件按钮', () => {
  assert.ok(takeBody.includes('if (onFiles && files.length > 0)'), '应优先走 onFiles')
  assert.ok(takeBody.includes('showHint('), '宿主没接 onFiles 时应给出提示，不能静默丢弃')
})

test('拖入图片/文件走同一条附件路径', () => {
  const dropStart = source.indexOf('const handleDrop = useCallback')
  assert.ok(dropStart > 0, '缺少 onDrop 处理：拖入的图片会直接落进 contenteditable')
  const dropBody = source.slice(dropStart, source.indexOf('}, [disabled, insertPlainText, takeFiles])', dropStart))
  assert.ok(dropBody.includes('e.preventDefault()'), 'handleDrop 缺少 preventDefault')
  assert.ok(dropBody.includes("takeFiles(e.dataTransfer, 'drop')"), 'handleDrop 未把拖入的文件交给附件导入')
  assert.ok(source.includes('onDrop={handleDrop}'), 'handleDrop 未挂到输入框上')
  // 拖入的文字落在松手位置，不替换当前选中内容。
  assert.ok(dropBody.includes('dropRange(e.clientX, e.clientY)'), '拖入的文字应插到松手位置')
  assert.ok(source.includes('caretRangeFromPoint'), '缺少 WebKit 的落点计算')
  assert.ok(source.includes('at.collapse(true)'), '落点应折叠成插入点，不能替换选中的文字')
  // 不阻止 dragover 的默认行为，浏览器根本不会触发 drop。
  assert.ok(source.includes('onDragOver={handleDragOver}'), '缺少 onDragOver，拖入会被浏览器直接拒掉')
})

test('附件导入走与点击附件按钮相同的上传路径', () => {
  const bar = readFileSync(new URL('../src/components/Chat/ChatInputBar.tsx', import.meta.url), 'utf8')
  const importStart = bar.indexOf('const handleImportFiles = useCallback')
  assert.ok(importStart > 0, 'ChatInputBar 缺少 handleImportFiles')
  const importBody = bar.slice(importStart, bar.indexOf('}, [handleUploadFile, onImportFile, onUploadFile])', importStart))
  assert.ok(importBody.includes('await onImportFile(file)'), '未把粘贴/拖入的文件缓存成 CachedFile')
  // handlePickFile 的分支：有上传回调就上传，否则直接进待发送列表。
  assert.ok(importBody.includes('if (onUploadFile) handleUploadFile(cached)'), '导入未复用点击附件按钮的上传路径')
  assert.ok(importBody.includes('setPendingFiles((previous) => [...previous, cached])'), '无上传回调时应直接进待发送附件列表')
  assert.ok(bar.includes('onFiles={onImportFile && !isInteractionDisabled ? handleImportFiles : undefined}'), '未把 onFiles 接到 MentionInput')
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
