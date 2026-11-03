// Run against Vite on :1437 and Chrome CDP on :9238. All business responses are mocked.
// Usage: node tests/group-detail-browser-smoke.mjs [label]   Screenshots go to output/group-detail-smoke/<label>/.
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
const output = path.resolve('output/group-detail-smoke', label)
await mkdir(output, { recursive: true })
async function screenshot(name) {
  const box = await evaluate(`(() => { const r = document.querySelector('.adp').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
  const result = await send('Page.captureScreenshot', { format: 'png', clip: { x: box.x - 12, y: 0, width: box.width + 24, height: box.height + 24, scale: 2 } })
  await writeFile(path.join(output, `${name}.png`), Buffer.from(result.data, 'base64'))
}
async function open(query, height = 1300) {
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `${origin}/tests/group-detail-smoke.html?${query}` })
  await until(`document.querySelector('.adp') !== null && document.querySelector('.usc-skeleton') === null`)
  await pause(400)
}

const clickText = text => evaluate(`Array.from(document.querySelectorAll('.adp button')).find(button=>button.textContent.includes(${JSON.stringify(text)})).click()`)
// Layout invariants that the previous version broke.
async function assertLayout(name) {
  const report = await evaluate(`(() => {
    const body = document.querySelector('.adp-body')
    // Compare real geometry with the panel edge: actions intentionally use negative margins to reach into the section padding.
    const limit = body.getBoundingClientRect()
    const overflowing = Array.from(body.querySelectorAll('*')).filter(el => { const box = el.getBoundingClientRect(); return box.width > 0 && (box.right > limit.right + 0.5 || box.left < limit.left - 0.5) })
    const badge = document.querySelector('.gdp-mode-badge')
    return {
      bodyOverflow: body.scrollWidth - body.clientWidth,
      overflowing: overflowing.map(el => el.className).slice(0, 5),
      badgePosition: badge ? getComputedStyle(badge).position : 'static',
      nested: Array.from(body.querySelectorAll('.adp-card')).filter(el => getComputedStyle(el).borderTopLeftRadius !== '0px').length,
      // Every block after the first one below the hero is separated by a hairline.
      undivided: Array.from(body.children).slice(2).filter(el => getComputedStyle(el).borderTopWidth !== '1px').map(el => el.getAttribute('aria-label')),
      leaked: /workflow_skill_ref|会话详情接口|查看扩展信息/.test(document.querySelector('.adp').textContent),
    }
  })()`)
  assert.equal(report.bodyOverflow, 0, `${name}: panel scrolls sideways`)
  assert.deepEqual(report.overflowing, [], `${name}: content overflows`)
  assert.equal(report.badgePosition, 'static', `${name}: badge is out of flow`)
  assert.equal(report.nested, 0, `${name}: card chrome is back`)
  assert.deepEqual(report.undivided, [], `${name}: missing section divider`)
  assert.equal(report.leaked, false, `${name}: internal wording in the panel`)
}

await send('Page.enable'); await send('Runtime.enable')
for (const theme of ['dark', 'light']) {
  for (const scenario of ['custom', 'auto', 'solution', 'long']) {
    await open(`scenario=${scenario}&theme=${theme}`)
    await assertLayout(`${scenario}-${theme}`)
    await screenshot(`${scenario}-${theme}`)
  }
  await open(`scenario=custom&usage=empty&theme=${theme}`)
  await assertLayout(`empty-usage-${theme}`)
  await screenshot(`empty-usage-${theme}`)
}

// The end of the panel, which does not fit in the first screen.
await open('scenario=custom&theme=dark')
await evaluate(`(() => { const body = document.querySelector('.adp-body'); body.scrollTop = body.scrollHeight })()`)
await pause(100)
await screenshot('custom-dark-bottom')

// Eight members collapse to six until the reader asks for the rest.
await open('scenario=custom&theme=dark')
assert.equal(await evaluate(`document.querySelectorAll('.gdp-member-row').length`), 6)
await clickText('查看全部 8 位')
await until(`document.querySelectorAll('.gdp-member-row').length === 8`)

// Non-custom groups do not offer edits the server rejects, and say why exactly once.
await open('scenario=solution&theme=dark')
assert.equal(await evaluate(`Array.from(document.querySelectorAll('.gdp-action')).length`), 0)
assert.equal(await evaluate(`(document.querySelector('.adp').textContent.match(/不是自选成员群/g) ?? []).length`), 1)

// Edit states.
for (const theme of ['dark', 'light']) {
  await open(`scenario=custom&theme=${theme}`)
  await evaluate(`document.querySelector('[aria-label="修改群名称"]').click()`)
  await until(`document.querySelector('.gdp-name-input') !== null`)
  await clickText('编辑')
  await until(`document.querySelector('textarea[aria-label="群简介"]') !== null`)
  await clickText('自动')
  await until(`document.querySelectorAll('textarea[aria-label="群简介"]').length === 2`)
  // The switch follows the editor that is open, once its colour transition has settled.
  await pause(300)
  assert.equal(await evaluate(`document.querySelector('.gdp-mode-toggle [aria-pressed="true"]').textContent`), '自动')
  assert.notEqual(
    await evaluate(`getComputedStyle(document.querySelector('.gdp-mode-toggle [aria-pressed="true"]')).color`),
    await evaluate(`getComputedStyle(document.querySelector('.gdp-mode-toggle [aria-pressed="false"]')).color`),
  )
  await assertLayout(`editing-${theme}`)
  await screenshot(`editing-${theme}`)
  await clickText('自定义')
  await pause(200)
  await evaluate(`Array.from(document.querySelectorAll('.gdp-rule-header button')).forEach(button => button.click())`)
  await pause(200)
  await assertLayout(`editing-rule-${theme}`)
  await screenshot(`editing-rule-${theme}`)
}

// The close button dismisses the panel.
await open('scenario=custom&theme=dark')
await evaluate(`document.querySelector('.adp-close').click()`)
await until(`document.querySelector('.adp') === null`)

assert.deepEqual(errors, [])
console.log(`group detail smoke ok: ${output}`)
socket.close()
