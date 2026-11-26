// 单聊/群聊输入框统一（方案 A）浏览器冒烟：两种模式跑同一组用例，验证同一个 MentionInput 的行为一致。
//
// 覆盖：占位文字、输入与发送键使能、Shift+Enter 换行 / Enter 发送、输入法合成期间回车不发送、
//      撤销、清空后占位恢复、长文本高度封顶且发送键可点、切会话草稿不串、发送失败原样放回、
//      群聊 @ chip 提交 mentions / 单聊不弹 @ 菜单、真实剪贴板粘贴（text/html + text/plain）。
//
// 依赖：Vite http://127.0.0.1:1437 + Chrome CDP http://127.0.0.1:9238
// 用法：node tests/chat-composer-unified-smoke.mjs [label]
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const origin = 'http://127.0.0.1:1437'
const label = process.argv[2] ?? 'unified'
const output = path.resolve('output/chat-composer-smoke', label)
await mkdir(output, { recursive: true })
const pause = ms => new Promise(r => setTimeout(r, ms))

const targets = await (await fetch('http://127.0.0.1:9238/json/list')).json()
const page = targets.find(t => t.type === 'page')
assert.ok(page, 'Chrome CDP 未就绪（需要 --remote-debugging-port=9238）')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej })
const pending = new Map()
let sequence = 0
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)) }, 20_000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
socket.onmessage = event => {
  const data = JSON.parse(event.data)
  const request = pending.get(data.id)
  if (!request) return
  pending.delete(data.id)
  clearTimeout(request.timer)
  if (data.error) request.reject(new Error(JSON.stringify(data.error)))
  else request.resolve(data.result)
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}
async function until(expression, message = expression) {
  for (let i = 0; i < 60; i++) {
    if (await evaluate(expression)) return
    await pause(50)
  }
  throw new Error(`UI not ready: ${message}`)
}
const key = (type, k, extra = {}) => send('Input.dispatchKeyEvent', { type, key: k, code: k === 'Enter' ? 'Enter' : undefined, windowsVirtualKeyCode: k === 'Enter' ? 13 : undefined, ...extra })
async function press(k, extra = {}) {
  await key('keyDown', k, extra)
  await key('keyUp', k, { modifiers: extra.modifiers })
  await pause(60)
}
async function type(text) {
  await send('Input.insertText', { text })
  await pause(60)
}
async function command(name, k, code, vk) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 4, key: k, code, windowsVirtualKeyCode: vk, commands: [name] })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 4, key: k, code, windowsVirtualKeyCode: vk })
  await pause(80)
}
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(output, `${name}.png`), Buffer.from(data, 'base64'))
}

const state = `(() => {
  const el = document.querySelector('[role="textbox"]')
  const send = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '发送消息')
  const rect = send?.getBoundingClientRect()
  const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null
  return {
    textareas: document.querySelectorAll('textarea').length,
    editables: document.querySelectorAll('[contenteditable="true"]').length,
    text: el?.innerText ?? null,
    placeholderShown: el ? getComputedStyle(el, '::before').content.includes(el.dataset.placeholder) : null,
    height: el ? Math.round(el.getBoundingClientRect().height) : null,
    sendDisabled: send?.disabled ?? null,
    sendHit: !!(hit && send && send.contains(hit)),
    focused: document.activeElement === el,
    listbox: !!document.querySelector('[role="listbox"]'),
    chips: el ? el.querySelectorAll('.mention-chip').length : 0,
    hint: document.querySelector('.mention-input-hint')?.textContent ?? null,
    attachments: Array.from(document.querySelectorAll('.chat-file-chip-name'), n => n.textContent),
    imported: window.__imported,
    ariaAutocomplete: el?.getAttribute('aria-autocomplete') ?? null,
    sent: window.__sent,
    // 草稿里的 mentionSnapshot 是 DOM 节点，不能按值回传：只取文字和 chip 数量。
    drafts: Object.fromEntries(Object.entries(window.__drafts).map(([id, draft]) => [id, {
      text: draft?.text ?? '',
      mentionChips: Array.from(draft?.mentionSnapshot ?? []).filter(node => node.classList?.contains?.('mention-chip')).length,
    }])),
  }
})()`
const read = () => evaluate(state)

async function open(mode, variant = 'dock', height = 900) {
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `${origin}/tests/chat-composer-smoke.html?mode=${mode}&variant=${variant}` })
  await until('window.__ready === true && !!document.querySelector(\'[role="textbox"]\')')
  await pause(200)
  await evaluate(`document.querySelector('[role="textbox"]').focus()`)
}

async function clearAll() {
  await command('selectAll', 'a', 'KeyA', 65)
  await press('Backspace', { windowsVirtualKeyCode: 8, code: 'Backspace' })
}

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
await send('Browser.grantPermissions', { origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] })

const report = {}
for (const mode of ['single', 'group']) {
  const r = report[mode] = {}
  await open(mode)

  // 1. 同一个组件：无 textarea、只有一个 contentEditable；空态占位 + 发送键禁用
  let s = await read()
  assert.equal(s.textareas, 0, `${mode}: 不应再有 textarea`)
  assert.equal(s.editables, 1, `${mode}: 应只有一个 contentEditable`)
  assert.equal(s.placeholderShown, true, `${mode}: 空输入框应显示占位`)
  assert.equal(s.sendDisabled, true, `${mode}: 空输入框发送键应禁用`)
  assert.equal(s.ariaAutocomplete, mode === 'group' ? 'list' : null, `${mode}: aria-autocomplete`)
  r.minHeight = s.height
  await screenshot(`${mode}-empty`)

  // 2. 输入 → 发送键可用；Shift+Enter 换行；Enter 发送并清空
  await type('你好')
  s = await read()
  assert.equal(s.sendDisabled, false, `${mode}: 输入后发送键应可用`)
  assert.equal(s.placeholderShown, false, `${mode}: 有内容时不显示占位`)
  await press('Enter', { modifiers: 8, commands: ['insertLineBreak'] })
  await type('世界')
  await press('Enter')
  s = await read()
  assert.equal(s.sent.at(-1)?.text, '你好\n世界', `${mode}: Shift+Enter 应换行、Enter 应发送，实际 ${JSON.stringify(s.sent.at(-1))}`)
  assert.equal(s.sent.at(-1)?.employeeId, mode === 'single' ? 'employee-1' : null, `${mode}: 单聊按默认员工路由`)
  assert.equal(s.text.trim(), '', `${mode}: 发送后应清空`)
  assert.equal(s.placeholderShown, true, `${mode}: 发送后占位恢复`)
  assert.equal(s.sendDisabled, true, `${mode}: 发送后发送键禁用`)

  // 3. 输入法合成期间回车不发送、不丢字
  const sentBefore = s.sent.length
  await send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
  await pause(60)
  await press('Enter', { keyCode: 229, windowsVirtualKeyCode: 229 })
  s = await read()
  assert.equal(s.sent.length, sentBefore, `${mode}: 合成期间回车不应发送`)
  await send('Input.insertText', { text: '你' })
  await pause(80)
  s = await read()
  assert.ok(s.text.includes('你'), `${mode}: 合成提交后应保留文字，实际 ${s.text}`)
  assert.equal(s.sendDisabled, false, `${mode}: 合成提交后发送键可用`)

  // 4. 撤销
  await type('abc')
  await command('undo', 'z', 'KeyZ', 90)
  s = await read()
  assert.ok(!s.text.includes('abc'), `${mode}: Cmd+Z 应撤销最近输入，实际 ${s.text}`)

  // 5. 全删后占位恢复、发送键禁用（contentEditable 会留下占位 <br>，不能靠 :empty）
  await clearAll()
  s = await read()
  assert.equal(s.text.trim(), '', `${mode}: 全删后应为空`)
  assert.equal(s.placeholderShown, true, `${mode}: 全删后应恢复占位`)
  assert.equal(s.sendDisabled, true, `${mode}: 全删后发送键禁用`)

  // 6. 长文本：高度封顶 240，内部滚动，发送键仍在可视区且能被真实点击命中
  for (let i = 1; i <= 20; i++) {
    await type(`第 ${i} 行很长的内容用于验证高度自适应`)
    if (i < 20) await press('Enter', { modifiers: 8, commands: ['insertLineBreak'] })
  }
  s = await read()
  assert.equal(s.height, 240, `${mode}: 长文本高度应封顶 240，实际 ${s.height}`)
  assert.equal(s.sendHit, true, `${mode}: 长文本时发送键应能被点中`)
  r.maxHeight = s.height
  await screenshot(`${mode}-long`)
  await clearAll()
  s = await read()
  assert.equal(s.height, r.minHeight, `${mode}: 清空后高度回到最小值`)

  // 7. 切会话草稿不串
  await type('会话一的草稿')
  await evaluate(`window.__setConv('conversation-2')`)
  await pause(150)
  s = await read()
  assert.equal(s.text.trim(), '', `${mode}: 切到新会话输入框应为空，实际 ${s.text}`)
  assert.equal(s.drafts['conversation-1']?.text, '会话一的草稿', `${mode}: 原会话草稿应被保存`)
  await evaluate(`window.__setConv('conversation-1')`)
  await pause(150)
  s = await read()
  assert.equal(s.text, '会话一的草稿', `${mode}: 切回后草稿恢复，实际 ${s.text}`)
  assert.equal(s.sendDisabled, false, `${mode}: 草稿恢复后发送键可用`)

  // 8. @ 成员：群聊插 chip 并提交 mentions；单聊不弹菜单
  await evaluate(`document.querySelector('[role="textbox"]').focus()`)
  await clearAll()
  await type('请 @数')
  s = await read()
  assert.equal(s.listbox, mode === 'group', `${mode}: @ 菜单仅群聊出现`)
  if (mode === 'group') {
    await press('Enter')
    await type('看一下')
    s = await read()
    assert.equal(s.chips, 1, '群聊: 应插入 @ chip')
    await screenshot('group-mention')
  }

  // 9. 发送失败原样放回（含 chip）
  await evaluate(`window.__failNext = true`)
  const beforeFail = (await read()).text
  await press('Enter')
  await pause(150)
  s = await read()
  assert.equal(s.text, beforeFail, `${mode}: 发送失败应放回原内容，实际 ${s.text}`)
  assert.equal(s.chips, mode === 'group' ? 1 : 0, `${mode}: 放回后 chip 数量不变`)
  assert.equal(s.sendDisabled, false, `${mode}: 放回后发送键可用`)
  await press('Enter')
  s = await read()
  if (mode === 'group') assert.deepEqual(s.sent.at(-1)?.mentions, ['analyst'], '群聊: 提交应携带 mentions')
  else assert.equal(s.sent.at(-1)?.text, '请 @数', '单聊: @ 只是普通文字')

  // 10. 真实剪贴板粘贴（网页复制：text/html + text/plain）
  await evaluate(`(async () => {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob(['<div>第一行</div><div>第二行 <span style="color:red">汇总</span></div>'], { type: 'text/html' }),
      'text/plain': new Blob(['第一行\\n第二行 汇总'], { type: 'text/plain' }),
    })])
  })()`)
  await evaluate(`document.querySelector('[role="textbox"]').focus()`)
  await command('paste', 'v', 'KeyV', 86)
  await pause(200)
  s = await read()
  assert.equal(s.text, '第一行\n第二行 汇总', `${mode}: 粘贴应得到两行纯文本，实际 ${JSON.stringify(s.text)}`)
  assert.equal(s.sendDisabled, false, `${mode}: 粘贴后发送键可用`)
  await screenshot(`${mode}-pasted`)

  // 11. 粘贴图片：当作附件收下（和点击「+ 导入」一样），不堆进输入框
  await evaluate(`document.querySelector('[role="textbox"]').focus()`)
  await clearAll()
  await evaluate(`(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 8
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#e89a2e'
    ctx.fillRect(0, 0, 8, 8)
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'))
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  })()`)
  await command('paste', 'v', 'KeyV', 86)
  await pause(200)
  s = await read()
  const pastedImages = await evaluate(`document.querySelector('[role="textbox"]').querySelectorAll('img').length`)
  assert.equal(pastedImages, 0, `${mode}: 粘贴图片不应进输入框`)
  assert.equal(s.text.trim(), '', `${mode}: 粘贴图片后输入框应仍为空，实际 ${JSON.stringify(s.text)}`)
  assert.equal(s.hint, null, `${mode}: 图片已收下为附件，不应再提示改用附件按钮，实际 ${JSON.stringify(s.hint)}`)
  assert.equal(s.imported.length, 1, `${mode}: 粘贴的图片应走附件导入，实际 ${JSON.stringify(s.imported)}`)
  assert.equal(s.imported[0].mime, 'image/png', `${mode}: 导入的应是 PNG，实际 ${JSON.stringify(s.imported[0])}`)
  assert.ok(s.imported[0].size > 0, `${mode}: 导入的图片字节不应为空`)
  assert.equal(s.attachments.length, 1, `${mode}: 附件区应出现一个文件，实际 ${JSON.stringify(s.attachments)}`)
  assert.equal(s.sendDisabled, false, `${mode}: 只有附件没有文字时也应可发送`)
  await screenshot(`${mode}-image-paste-attached`)

  // 11b. 拖入文件：同样进附件区，不落进 contenteditable
  await evaluate(`(() => {
    const box = document.querySelector('[role="textbox"]')
    const file = new File(['hello drop'], 'dropped.txt', { type: 'text/plain' })
    const dt = new DataTransfer()
    dt.items.add(file)
    box.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    box.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  })()`)
  await pause(250)
  s = await read()
  assert.equal(s.imported.length, 2, `${mode}: 拖入的文件应走附件导入，实际 ${JSON.stringify(s.imported)}`)
  assert.equal(s.imported[1].name, 'dropped.txt', `${mode}: 拖入文件名应保留，实际 ${JSON.stringify(s.imported[1])}`)
  assert.equal(s.text.trim(), '', `${mode}: 拖入文件不应写进输入框，实际 ${JSON.stringify(s.text)}`)
  assert.equal(s.attachments.length, 2, `${mode}: 附件区应有两个文件，实际 ${JSON.stringify(s.attachments)}`)
  await screenshot(`${mode}-file-drop-attached`)
  await clearAll()
  await evaluate(`document.querySelectorAll('.chat-file-chip-remove').forEach(b => b.click())`)
  await pause(150)

  // 12. 恢复草稿后光标在末尾（旧行为：新输入的字插在草稿前面）
  await clearAll()
  await type('草稿头')
  await evaluate(`window.__setConv('conversation-2')`)
  await pause(150)
  await evaluate(`window.__setConv('conversation-1')`)
  await pause(150)
  await evaluate(`document.querySelector('[role="textbox"]').focus()`)
  await type('尾')
  s = await read()
  assert.equal(s.text, '草稿头尾', `${mode}: 草稿恢复后光标应在末尾，实际 ${JSON.stringify(s.text)}`)
  await clearAll()
  await evaluate(`window.__drafts['conversation-1'] = undefined`)

  // 13. 群聊草稿里的 @ 成员切会话后仍然生效（旧行为：只存纯文本，切回来 @ 退化成普通文字）
  if (mode === 'group') {
    await evaluate(`document.querySelector('[role="textbox"]').focus()`)
    await clearAll()
    await type('请 @数')
    await press('Enter')
    await type('汇总一下')
    assert.equal((await read()).chips, 1, '群聊: 草稿用例前应有 1 个 chip')
    await evaluate(`window.__setConv('conversation-2')`)
    await pause(150)
    s = await read()
    assert.equal(s.drafts['conversation-1']?.mentionChips, 1, '群聊: 草稿应保存 @ 成员标签')
    await evaluate(`window.__setConv('conversation-1')`)
    await pause(150)
    s = await read()
    assert.equal(s.chips, 1, `群聊: 切回后 @ chip 应还在，实际 ${s.chips}`)
    await screenshot('group-mention-draft-restored')
    await press('Enter')
    s = await read()
    assert.deepEqual(s.sent.at(-1)?.mentions, ['analyst'], '群聊: 草稿恢复后提交仍应携带 mentions')
    await evaluate(`window.__drafts['conversation-1'] = undefined`)
  }

  r.sent = s.sent
}

// 小窗口 + 新会话页（hero）视觉
await open('single', 'dock', 640)
await screenshot('single-small-window')
await open('single', 'hero')
let hero = await read()
assert.equal(hero.placeholderShown, true, 'hero: 占位显示')
await screenshot('single-hero-empty')
await type('帮我整理本周周报')
hero = await read()
assert.equal(hero.sendDisabled, false, 'hero: 输入后发送键可用')
await screenshot('single-hero-typed')

console.log(JSON.stringify(report, null, 2))
console.log(`screenshots: ${output}`)
socket.close()
