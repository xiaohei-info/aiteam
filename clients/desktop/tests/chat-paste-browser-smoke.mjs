// 群聊输入框「粘贴后发送按钮变灰」的真浏览器冒烟验证。
// 依赖：Vite 开发服务器 http://127.0.0.1:1437 + Chrome CDP http://127.0.0.1:9238。
// 用法：node tests/chat-paste-browser-smoke.mjs [label]   截图输出到 output/chat-paste-smoke/<label>/
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const origin = 'http://127.0.0.1:1437'
const label = process.argv[2] ?? 'current'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function ready(url) {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(url)
      if (response.ok) return response
    } catch {}
    await pause(100)
  }
  throw new Error(`Service not ready: ${url}`)
}

await ready(origin)
const targets = await (await ready('http://127.0.0.1:9238/json/list')).json()
const page = targets.find(target => target.type === 'page')
assert.ok(page)
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
const pending = new Map()
const consoleErrors = []
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
  if (data.id) {
    const request = pending.get(data.id)
    if (!request) return
    pending.delete(data.id)
    clearTimeout(request.timer)
    if (data.error) request.reject(new Error(JSON.stringify(data.error)))
    else request.resolve(data.result)
  }
  if (data.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text)
  }
  if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') {
    consoleErrors.push(data.params.args.map(arg => arg.value ?? arg.description ?? '').join(' '))
  }
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

const output = path.resolve('output/chat-paste-smoke', label)
await mkdir(output, { recursive: true })
await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(output, `${name}.png`), Buffer.from(data, 'base64'))
}

/** 聚焦群聊 contentEditable 并派发一次真实 paste 事件（带 text/plain + 富文本 text/html）。 */
const pasteScript = (richText) => `(() => {
  const el = document.querySelector('[contenteditable="true"]')
  if (!el) throw new Error('contentEditable not found')
  el.focus()
  const dt = new DataTransfer()
  dt.setData('text/plain', ${JSON.stringify(richText)})
  dt.setData('text/html', '<div>第一行</div><div>第二行 <span style="color:red">@数据分析师</span></div>')
  const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
  el.dispatchEvent(event)
  return true
})()`

const composerState = `(() => {
  const el = document.querySelector('[contenteditable="true"]')
  const buttons = [...document.querySelectorAll('button')]
  const send = buttons.find(button => button.getAttribute('aria-label') === '发送消息'
    || (button.getAttribute('aria-label') ?? '').startsWith('加入待发送队列'))
  const rect = send?.getBoundingClientRect()
  return {
    editableText: el?.innerText ?? null,
    editableChildren: el?.children.length ?? null,
    draft: (window.__drafts ?? []).at(-1) ?? null,
    sendDisabled: send?.disabled ?? null,
    sendLabel: send?.getAttribute('aria-label') ?? null,
    sendVisible: rect ? rect.width > 0 && rect.height > 0 : false,
  }
})()`

async function runGroupPasteCase(name, pasted) {
  await send('Page.navigate', { url: `${origin}/tests/chat-paste-smoke.html?mode=group&case=${name}` })
  await until('window.__ready === true')
  await pause(300)
  assert.equal(await evaluate(`document.querySelector('[contenteditable="true"]') !== null`), true)
  // 先把输入框聚焦，模拟真实「鼠标点进输入框再粘贴」。
  await evaluate(`(() => { const el = document.querySelector('[contenteditable="true"]'); el.focus(); return document.activeElement === el })()`)
  const before = await evaluate(composerState)
  assert.equal(before.sendDisabled, true, `${name}: 空输入框发送键应为禁用`)
  await evaluate(pasteScript(pasted))
  await pause(300)
  const after = await evaluate(composerState)
  await shot(name)
  return { before, after }
}

const results = {}
results.multiline = await runGroupPasteCase('multiline', '第一行\n第二行 @数据分析师')
assert.equal(results.multiline.after.sendDisabled, false, '多行富文本粘贴后发送键应可用')
assert.ok((results.multiline.after.editableText ?? '').includes('第一行'), `输入框应包含粘贴文本，实际：${results.multiline.after.editableText}`)
assert.ok((results.multiline.after.editableText ?? '').includes('第二行'), '输入框应包含第二行')
assert.ok(!(results.multiline.after.editableText ?? '').includes('color:red'), '粘贴不应把富文本样式带进输入框')

results.singleLine = await runGroupPasteCase('singleLine', '单行粘贴内容')
assert.equal(results.singleLine.after.sendDisabled, false, '单行粘贴后发送键应可用')
assert.ok((results.singleLine.after.editableText ?? '').includes('单行粘贴内容'), `单行输入框应包含粘贴文本，实际：${results.singleLine.after.editableText}`)
assert.equal((results.singleLine.after.sendLabel ?? '').includes('发送'), true, '发送按钮应可见可用')

results.chinesePunctuation = await runGroupPasteCase('chinesePunctuation', '请把 @数据分析师 的结论\n· 汇总成三点')
assert.equal(results.chinesePunctuation.after.sendDisabled, false, '中文富文本粘贴后发送键应可用')

assert.deepEqual(consoleErrors, [], `页面不应有控制台错误：${consoleErrors.join('\n')}`)
console.log(JSON.stringify(results, null, 2))
console.log(`screenshots: ${output}`)
socket.close()
