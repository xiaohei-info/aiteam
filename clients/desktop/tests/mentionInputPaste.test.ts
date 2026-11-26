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
const pasteBody = source.slice(pasteStart, source.indexOf('}, [disabled, takeTransfer])', pasteStart))

test('handlePaste 先 preventDefault，再交给 takeTransfer', () => {
  const prevent = pasteBody.indexOf('e.preventDefault()')
  const take = pasteBody.indexOf("takeTransfer(el, e.clipboardData, 'paste')")
  assert.ok(prevent > 0, 'handlePaste 缺少 e.preventDefault()，图片会被默认粘贴塞进输入框')
  assert.ok(take > prevent, 'preventDefault 必须在处理剪贴板之前')
})

// 复核意见（PR #232）：图片/文件的粘贴与拖入要和点击「+ 导入」一样处理；
// 图文同时存在时一起进来，图/文件在原位置留名称占位（用户 2026-11-26 要求）。
const takeStart = source.indexOf('const takeTransfer = useCallback')
assert.ok(takeStart > 0, '找不到 MentionInput.takeTransfer')
const takeBody = source.slice(takeStart, source.indexOf('}, [insertPlainText, onFiles, showHint])', takeStart))

test('图文一起进来：文字（含占位）插入输入框，图片/文件交给 onFiles', () => {
  assert.ok(takeBody.includes('composePaste('), '应由 composePaste 生成带占位的文字和附件列表')
  assert.ok(takeBody.includes("htmlToParts(data.getData('text/html')"), '应读取 HTML 以确定图片在文字中的位置')
  assert.ok(takeBody.includes('if (composed.text) insertPlainText(el, composed.text, at)'), '文字没插入输入框')
  assert.ok(takeBody.includes('onFiles?.(composed.files)'), '图片/文件没交给附件导入')
  assert.ok(!takeBody.slice(takeBody.indexOf('if (composed.text)')).includes('return'), '有文字时不能提前返回而丢掉图片')
  assert.ok(source.includes('onFiles?: (files: File[]) => void'), 'MentionInput 缺少 onFiles 入参')
})

test('源应用没把图片放进剪贴板（飞书）时要提示单独复制图片', () => {
  assert.ok(takeBody.includes('if (composed.unavailable > 0)'))
})

test('只有网址的图片会去取，取不到要提示', () => {
  assert.ok(takeBody.includes('fetchImage(src, name)'))
  assert.ok(takeBody.includes('showHint(`有 ${missed} 张图片'), '取不到的图片不能静默丢掉')
})

test('没有 onFiles（宿主未接附件）时提示改用附件按钮，并且不留空占位', () => {
  assert.ok(takeBody.includes('if (hasAttachments && !onFiles)'))
  assert.ok(takeBody.includes('showHint('))
  assert.ok(takeBody.includes(".replace(/\\[(?:图片|文件)：[^\\]]*\\]/g, '')"), '无附件能力时应去掉占位')
})

test('拖入走同一条路径，文字落在松手位置', () => {
  const dropStart = source.indexOf('const handleDrop = useCallback')
  assert.ok(dropStart > 0, '缺少 onDrop 处理：拖入的图片会直接落进 contenteditable')
  const dropBody = source.slice(dropStart, source.indexOf('}, [disabled, takeTransfer])', dropStart))
  assert.ok(dropBody.includes('e.preventDefault()'), 'handleDrop 缺少 preventDefault')
  assert.ok(dropBody.includes("takeTransfer(el, e.dataTransfer, 'drop', dropRange(e.clientX, e.clientY))"))
  assert.ok(source.includes('onDrop={handleDrop}'), 'handleDrop 未挂到输入框上')
  assert.ok(source.includes('caretRangeFromPoint'), '缺少 WebKit 的落点计算')
  assert.ok(source.includes('at.collapse(true)'), '落点应折叠成插入点，不能替换选中的文字')
  assert.ok(source.includes('onDragOver={handleDragOver}'), '缺少 onDragOver，拖入会被浏览器直接拒掉')
})

test('拖文件：WebKit 拖动途中只给 types=Files，也要接住', () => {
  const helper = readFileSync(new URL('../src/components/Chat/clipboardContent.ts', import.meta.url), 'utf8')
  assert.ok(helper.includes(".includes('Files')"), 'carriesFiles 应识别 types 里的 Files')
})

test('拖到输入栏其他位置也算拖入；拖到窗口别处不会打开文件替换页面', () => {
  const bar = readFileSync(new URL('../src/components/Chat/ChatInputBar.tsx', import.meta.url), 'utf8')
  assert.ok(bar.includes('onDrop={handleBarDrop}') && bar.includes('onDragOver={handleBarDragOver}'))
  assert.ok(bar.includes('if (e.defaultPrevented ||'), '输入框已处理过的拖放不能重复导入')
  const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
  assert.ok(main.includes("for (const type of ['dragover', 'drop'] as const)"), '缺少窗口级拖放兜底')
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
