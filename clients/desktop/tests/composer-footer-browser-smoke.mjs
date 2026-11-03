// Run against Vite on :1437 and Chrome CDP on :9238. All business responses are mocked.
// Usage: node tests/composer-footer-browser-smoke.mjs [label]   Screenshots go to output/composer-footer-smoke/<label>/.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const origin = 'http://127.0.0.1:1437'
const label = process.argv[2] ?? 'current'
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
const output = path.resolve('output/composer-footer-smoke', label)
await mkdir(output, { recursive: true })

// Everything in the composer must stay inside the chat column, and the permission label must stay on one line.
async function measure() {
  return evaluate(`(() => {
    const column = document.querySelector('.chat').getBoundingClientRect()
    const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height } }
    const bubble = box(document.querySelector('.chat-outcome-prompt'))
    const trigger = document.querySelector('.cperm-trigger')
    const meter = document.querySelector('.chat-usage-meter')
    const reset = box(document.querySelector('.chat-outcome-anchor > button, .chat-outcome-anchor button'))
    const arrow = getComputedStyle(document.querySelector('.chat-outcome-prompt'), '::before')
    const bubbleEl = document.querySelector('.chat-outcome-prompt')
    const arrowCenter = bubbleEl ? bubbleEl.getBoundingClientRect().left + parseFloat(arrow.left) + 4 : null
    return {
      column: { left: column.left, right: column.right },
      bubble, reset, arrowCenter,
      trigger: box(trigger), triggerText: trigger?.textContent,
      meter: box(meter), meterClipped: meter ? meter.scrollWidth > meter.clientWidth + 1 : null,
      attach: box(document.querySelector('.chat-input-tools .chat-tool-btn')),
      // Segments of the usage meter must not overlap each other.
      meterOverlap: meter ? Array.from(meter.children).filter(el => el.getBoundingClientRect().width > 0).map(el => el.getBoundingClientRect()).some((r, i, all) => i > 0 && r.left < all[i - 1].right - 0.5) : null,
    }
  })()`)
}
function check(name, m) {
  const inside = (b, what) => {
    assert.ok(b, `${name}: ${what} missing`)
    assert.ok(b.left >= m.column.left - 0.5 && b.right <= m.column.right + 0.5, `${name}: ${what} leaves the chat column (${b.left}–${b.right} vs ${m.column.left}–${m.column.right})`)
  }
  inside(m.bubble, 'outcome bubble')
  inside(m.trigger, 'permission button')
  inside(m.meter, 'usage meter')
  assert.ok(m.trigger.height <= 30, `${name}: permission button wraps (${m.trigger.height}px)`)
  assert.match(m.triggerText, /完全访问 · 1 个目录/, `${name}: permission summary`)
  assert.equal(m.meterClipped, false, `${name}: usage meter is cut off`)
  assert.equal(m.meterOverlap, false, `${name}: usage meter segments overlap`)
  // The bubble sits above the toolbar, never over the attachment button row.
  assert.ok(m.bubble.bottom <= m.attach.top, `${name}: bubble covers the toolbar`)
  // The arrow points at the reset button.
  const resetCenter = (m.reset.left + m.reset.right) / 2
  assert.ok(Math.abs(m.arrowCenter - resetCenter) <= 3, `${name}: arrow at ${m.arrowCenter}, button at ${resetCenter}`)
}

await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false })
const results = {}
for (const theme of ['dark', 'light']) {
  for (const width of [340, 400, 480, 620, 900]) {
    const name = `w${width}-${theme}`
    await send('Page.navigate', { url: `${origin}/tests/composer-footer-smoke.html?width=${width}&theme=${theme}` })
    await until(`document.querySelector('.chat-outcome-prompt') !== null && /个目录/.test(document.querySelector('.cperm-trigger')?.textContent ?? '') && /tokens/.test(document.querySelector('.chat-usage-meter')?.textContent ?? '') && /上下文 25%/.test(document.querySelector('.chat-usage-meter')?.textContent ?? '')`)
    await pause(350)
    const m = await measure()
    results[name] = m
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 380, width: width + 20, height: 320, scale: 2 } })
    await writeFile(path.join(output, `${name}.png`), Buffer.from(shot.data, 'base64'))
    if (process.env.NO_ASSERT) continue
    // Wide composers keep the bubble beside the button (vertical centre on the toolbar row).
    if (width < 900) check(name, m)
  }
}
await writeFile(path.join(output, 'measurements.json'), JSON.stringify(results, null, 2))
assert.deepEqual(errors, [])
console.log(`composer footer smoke ok: ${output}`)
socket.close()
