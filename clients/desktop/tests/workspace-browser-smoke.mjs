// Run against Vite on :1437 and Chrome CDP on :9238. All business responses are mocked.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const origin = 'http://127.0.0.1:1437'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function ready(url) {
  for (let i = 0; i < 100; i++) {
    try { const response = await fetch(url); if (response.ok) return response } catch {}
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
const errors = []
let sequence = 0
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)) }, 20_000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
}
socket.onmessage = event => {
  const data = JSON.parse(event.data)
  if (data.id) {
    const request = pending.get(data.id)
    if (!request) return
    pending.delete(data.id); clearTimeout(request.timer)
    if (data.error) request.reject(new Error(JSON.stringify(data.error)))
    else request.resolve(data.result)
  }
  if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text)
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}
async function until(expression) {
  for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await pause(100) }
  throw new Error(`UI not ready: ${expression}`)
}
const clickText = text => evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.includes(${JSON.stringify(text)})).click()`)
const output = path.resolve('output/workspace-smoke')
await mkdir(output, { recursive: true })
const temp = await mkdtemp(path.join(tmpdir(), 'aifred-upload-smoke-'))
async function screenshot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(output, name), Buffer.from(result.data, 'base64'))
}
try {
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 1000, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `${origin}/tests/workspace-smoke.html` })
  await until(`document.body.textContent.includes('每日业务简报')`)
  await clickText('每日业务简报')
  await until(`document.body.textContent.includes('已完成业务汇总')`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="任务详情"]').getAttribute('aria-busy')`), 'false')
  await screenshot('automation-desktop.png')
  await clickText('新建任务')
  await until(`document.querySelector('form') !== null`)
  assert.equal(await evaluate(`document.querySelector('button[type="submit"]').textContent.includes('保存任务')`), true)
  await screenshot('automation-form.png')
  await clickText('取消')
  await evaluate(`(()=>{ const input=document.querySelector('[aria-label="搜索任务"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'不存在的任务'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`)
  await until(`document.body.textContent.includes('没有匹配的任务')`)
  await clickText('清除筛选')
  await until(`document.body.textContent.includes('每日业务简报')`)
  await send('Emulation.setDeviceMetricsOverride', { width: 620, height: 1000, deviceScaleFactor: 1, mobile: false })
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, 'narrow page must not overflow horizontally')
  await screenshot('automation-narrow.png')
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false })
  await evaluate(`window.__show('upload')`)
  await until(`document.querySelector('select')?.options[0]?.textContent.includes('企业共享知识库')`)
  const file = path.join(temp, 'smoke.txt')
  await writeFile(file, 'hello')
  const dom = await send('DOM.getDocument')
  const input = await send('DOM.querySelector', { nodeId: dom.root.nodeId, selector: 'input[type="file"]' })
  await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] })
  await until(`document.body.textContent.includes('smoke.txt')`)
  await clickText('开始上传')
  await until(`document.body.textContent.includes('已提交 1 个文件')`)
  assert.equal(await evaluate('window.__uploaded'), 1)
  await screenshot('knowledge-upload.png')
  await evaluate(`window.__show('talent')`)
  await until(`document.body.textContent.includes('企业共享知识库') && document.querySelector('select')?.value==='employee-1'`)
  await clickText('关联')
  await until(`document.body.textContent.includes('已将「企业共享知识库」关联')`)
  assert.equal(await evaluate('window.__bound'), true)
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='已关联').getBoundingClientRect().width < 200`), true, 'association action must not squeeze the knowledge name')
  await screenshot('talent-knowledge.png')
  await clickText('发起对话')
  await until(`window.__chatCreated===1`)
  assert.deepEqual(errors, [])
  console.log('PASS: desktop/narrow automation, form, filtering, Manager upload, talent association and start-chat; mocked APIs. Screenshots:', output)
} finally {
  await evaluate('window.__restoreConfig?.()').catch(() => {})
  socket.close()
  await rm(temp, { recursive: true, force: true })
}
