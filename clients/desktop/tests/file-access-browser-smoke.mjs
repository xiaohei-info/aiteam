// Mocked native IPC UI test. Starts/stops its own Vite and headless Chrome.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const profile = await mkdtemp(path.join(tmpdir(), 'aifred-file-access-'))
const origin = 'http://127.0.0.1:1458'
const children = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const errors = []
let socket
async function ready(url) {
  for (let i = 0; i < 100; i++) {
    try { const response = await fetch(url); if (response.ok) return response } catch {}
    await delay(100)
  }
  throw new Error(`Not ready: ${url}`)
}
try {
  children.push(spawn('node', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '1458', '--strictPort'], {stdio:'ignore'}))
  children.push(spawn(process.env.CHROME_BINARY || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=9258', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], {stdio:'ignore'}))
  for (const child of children) child.on('error', error => errors.push(String(error)))
  await ready(origin)
  const pages = await (await ready('http://127.0.0.1:9258/json/list')).json()
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let sequence = 0
  const pending = new Map()
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)) }, 15_000)
      pending.set(id, {resolve,reject,timer})
      socket.send(JSON.stringify({id,method,params}))
    })
  }
  socket.onmessage = event => {
    const value = JSON.parse(event.data)
    if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails.exception?.description ?? value.params.exceptionDetails.text)
    const request = pending.get(value.id)
    if (!request) return
    pending.delete(value.id); clearTimeout(request.timer)
    if (value.error) request.reject(new Error(JSON.stringify(value.error)))
    else request.resolve(value.result)
  }
  async function evaluate(expression) {
    const response = await send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true})
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result.value
  }
  async function until(expression) {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(100) }
    throw new Error(`UI not ready: ${expression}; ${await evaluate('document.body.innerText')}`)
  }
  const click = async text => {
    const selector = `Array.from(document.querySelectorAll('button')).find(button=>button.textContent === ${JSON.stringify(text)} && !button.disabled)`
    await until(`Boolean(${selector})`)
    await evaluate(`${selector}.click()`)
  }
  const reload = async () => {
    const oldBoot = await evaluate('window.__bootId')
    await send('Page.reload')
    await until(`Boolean(window.__bootId) && window.__bootId !== ${JSON.stringify(oldBoot)}`)
  }
  const screenshot = async name => {
    await mkdir('output/file-access-smoke', {recursive:true})
    const shot = await send('Page.captureScreenshot', {format:'png'})
    await writeFile(`output/file-access-smoke/${name}.png`, Buffer.from(shot.data, 'base64'))
  }
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]})
  await send('Emulation.setDeviceMetricsOverride', {width:1000,height:1000,deviceScaleFactor:1,mobile:false})
  await send('Page.navigate', {url:`${origin}/tests/file-access-smoke.html`})
  await until(`document.querySelector('#file-access-title')?.textContent === '授权本机文件访问'`)
  assert.equal(await evaluate(`document.querySelectorAll('[role="dialog"]').length`), 1, 'StrictMode must not duplicate startup dialogs')
  assert.equal(await evaluate(`document.querySelector('.file-access-dialog details').open`), false)
  await screenshot('startup-macos')
  await evaluate(`document.documentElement.dataset.theme='light'`)
  await screenshot('startup-macos-light')
  await evaluate(`delete document.documentElement.dataset.theme`)
  await click('选择根目录授权')
  await until(`!document.querySelector('[role="dialog"]') && document.querySelector('.file-access-grants')?.textContent.includes('/')`)
  await reload()
  await until(`document.querySelector('.file-access-grants') !== null`)
  assert.equal(await evaluate(`document.querySelector('[role="dialog"]') === null`), true, 'persisted grant must not prompt again')
  await click('取消全部目录授权')
  await until(`window.__status.directories.length === 0`)
  await evaluate('window.__read()')
  await until(`document.querySelector('#file-access-title')?.textContent === '需要文件访问授权'`)
  await click('取消本次操作')
  await until(`window.__result === 'denied'`)
  await evaluate('window.__read()')
  await until(`document.querySelector('[role="dialog"]') !== null`)
  await click('选择目录并重试')
  await until(`window.__result === 'YQ=='`)
  await evaluate(`window.__readMode='system'; window.__read()`)
  await until(`document.querySelector('#file-access-title')?.textContent === '系统限制了文件访问'`)
  await until(`document.querySelector('.file-access-dialog details').open && document.querySelector('.file-access-dialog').textContent.includes('列表中没有 AIFred？')`)
  await screenshot('recovery-macos')
  await click('打开系统权限设置')
  assert.equal(await evaluate(`window.__calls.includes('open_file_privacy_settings')`), true)
  await click('已调整权限，重试')
  await until(`window.__result === 'denied'`)
  assert.equal(await evaluate(`document.querySelector('[role="dialog"]') === null`), true, 'failed retry must not loop')
  await click('取消全部目录授权')
  await until(`window.__status.directories.length === 0`)
  await reload()
  await until(`document.querySelector('#settings-file-access-title') !== null && document.body.textContent.includes('尚未授权目录')`)
  assert.equal(await evaluate(`document.querySelector('[role="dialog"]') === null`), true, 'revoke persists without startup nagging')
  await evaluate(`sessionStorage.setItem('access-status',JSON.stringify({startup_seen:false,directories:[],platform:'windows',suggested_root:'C:\\\\'}))`)
  await reload()
  await until(`document.querySelector('#file-access-title') !== null`)
  await evaluate(`document.querySelector('.file-access-dialog summary').click()`)
  await until(`document.querySelector('.file-access-dialog').textContent.includes('Windows 每个磁盘分别授权')`)
  await send('Emulation.setDeviceMetricsOverride', {width:390,height:740,deviceScaleFactor:1,mobile:false})
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  await screenshot('startup-windows-narrow')
  const narrowLayout = await evaluate(`({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,dialog:document.querySelector('.file-access-dialog').getBoundingClientRect().toJSON()})`)
  assert.equal(narrowLayout.scrollWidth <= narrowLayout.width && narrowLayout.dialog.bottom <= narrowLayout.height, true, JSON.stringify(narrowLayout))
  await evaluate(`window.__pick=['C:\\\\','D:\\\\']`)
  await click('选择根目录授权')
  await until(`document.querySelectorAll('.file-access-grants li').length === 2`)
  await evaluate(`document.querySelector('.file-access-grants button').click()`)
  await until(`document.querySelectorAll('.file-access-grants li').length === 1`)
  assert.equal(await evaluate(`window.__status.directories[0].startsWith('D:')`), true)
  await send('Emulation.setDeviceMetricsOverride', {width:620,height:900,deviceScaleFactor:1,mobile:false})
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true)
  await screenshot('settings-windows')
  await evaluate(`document.documentElement.dataset.theme='light'`)
  await screenshot('settings-windows-light')
  await evaluate(`delete document.documentElement.dataset.theme`)
  await send('Emulation.setDeviceMetricsOverride', {width:390,height:740,deviceScaleFactor:1,mobile:false})
  await reload()
  await until(`document.querySelector('#file-access') !== null`)
  const settingsNarrow = await evaluate(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,card:document.querySelector('#file-access').getBoundingClientRect().toJSON()})`)
  assert.equal(settingsNarrow.scrollWidth <= settingsNarrow.width && settingsNarrow.card.right <= settingsNarrow.width, true, JSON.stringify(settingsNarrow))
  await screenshot('settings-windows-narrow')
  assert.deepEqual(errors, [])
  console.log('PASS: startup grant, StrictMode, restart, revoke, cancel, reauthorize/retry, OS settings, bounded retry, Windows multi-volume and narrow layout (mocked IPC).')
} finally {
  socket?.close()
  for (const child of children) child.kill('SIGTERM')
  await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))))
  await rm(profile, {recursive:true,force:true})
}
