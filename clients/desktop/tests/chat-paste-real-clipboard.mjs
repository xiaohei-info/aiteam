// 「粘贴后发送键变灰」的真实剪贴板冒烟：单聊 textarea 与群聊 contentEditable 各一次。
//
// 与 chat-paste-browser-smoke.mjs 的区别：
//  - 前者派发合成 ClipboardEvent（只走组件 onPaste 处理器）；
//  - 本脚本先用 navigator.clipboard.writeText 写入系统剪贴板，再用 CDP 的
//    Input.dispatchKeyEvent({ commands: ['paste'] }) 触发**真实粘贴命令**，
//    因而同时覆盖「浏览器默认插入 HTML → onInput → extract」这条路径。
//
// 依赖：Vite http://127.0.0.1:1437 + Chrome CDP http://127.0.0.1:9238
// 用法：node tests/chat-paste-real-clipboard.mjs [label]
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const origin = 'http://127.0.0.1:1437'
const label = process.argv[2] ?? 'real-clipboard'
const output = path.resolve('output/chat-paste-smoke', label)
await mkdir(output, { recursive: true })
const pause = ms => new Promise(r => setTimeout(r, ms))
const pasted = '第一行\n第二行 汇总成三点'

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
async function until(expression) {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(expression)) return
    await pause(100)
  }
  throw new Error(`UI not ready: ${expression}`)
}

await send('Runtime.enable')
await send('Page.enable')
// headless 下 document 默认不 focused，clipboard.writeText 会抛 NotAllowedError。
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Browser.grantPermissions', { origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] })

const composerState = `(() => {
  const textarea = document.querySelector('textarea')
  const editable = document.querySelector('[contenteditable="true"]')
  const buttons = [...document.querySelectorAll('button')]
  const sendButton = buttons.find(button => button.getAttribute('aria-label') === '发送消息'
    || (button.getAttribute('aria-label') ?? '').startsWith('加入待发送队列'))
  return {
    hasTextarea: !!textarea,
    hasEditable: !!editable,
    text: textarea ? textarea.value : (editable?.innerText ?? null),
    sendDisabled: sendButton?.disabled ?? null,
  }
})()`

/** 写入系统剪贴板（同时带 text/html + text/plain，模拟从网页/文档复制）→ 聚焦 → 真实 Cmd+V。 */
async function realPaste(selector) {
  await evaluate(`(async () => {
    const html = '<div>第一行</div><div>第二行 <span style="color:red">汇总成三点</span></div>'
    const text = ${JSON.stringify(pasted)}
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })])
    return true
  })()`)
  await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); return document.activeElement === el })()`)
  await send('Page.bringToFront')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 4, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 9, commands: ['paste'] })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 4, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 9 })
  await pause(500)
}

async function run(mode, selector, screenshot) {
  await send('Page.navigate', { url: `${origin}/tests/chat-paste-smoke.html?mode=${mode}&case=realPaste` })
  await until('window.__ready === true')
  await pause(300)
  const before = await evaluate(composerState)
  assert.equal(before.sendDisabled, true, `${mode}: 空输入框发送键应为禁用`)
  await realPaste(selector)
  const after = await evaluate(composerState)
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(output, `${screenshot}.png`), Buffer.from(data, 'base64'))
  return { before, after }
}

const single = await run('single', 'textarea', 'single-chat')
assert.equal(single.before.hasTextarea, true, '单聊应为受控 textarea')
assert.equal(single.before.hasEditable, false, '单聊不应出现 contentEditable')
assert.equal(single.after.sendDisabled, false, '单聊：真实粘贴后发送键应可用')
assert.ok((single.after.text ?? '').includes('第一行') && (single.after.text ?? '').includes('第二行'), `单聊 textarea 应包含粘贴内容，实际：${single.after.text}`)

const group = await run('group', '[contenteditable="true"]', 'group-chat')
assert.equal(group.before.hasEditable, true, '群聊应为 contentEditable')
assert.equal(group.after.sendDisabled, false, '群聊：真实粘贴后发送键应可用')
assert.ok((group.after.text ?? '').includes('第一行') && (group.after.text ?? '').includes('第二行'), `群聊输入框应包含粘贴内容，实际：${group.after.text}`)
assert.ok(!(group.after.text ?? '').includes('color:red'), '群聊不应把富文本样式带进输入框')

console.log(JSON.stringify({ single, group }, null, 2))
console.log(`screenshots: ${output}`)
socket.close()
