// Self-contained real Chrome test; business HTTP is mocked by the fixture.
// Run from AITeam: node tests/knowledge-create-browser-smoke.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const profile = await mkdtemp(path.join(tmpdir(), 'aifred-kb-create-'))
const port = 1441
const debugPort = 9239
const origin = `http://127.0.0.1:${port}`
const children = []
let socket
const pending = new Map()
let sequence = 0
const errors = []
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function start(command, args) {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', data => { log = (log + data).slice(-12000) })
  child.stderr.on('data', data => { log = (log + data).slice(-12000) })
  child.on('error', error => { errors.push(error.message) })
  children.push({ child, log: () => log })
}
async function ready(url) {
  for (let i = 0; i < 150; i++) {
    if (children.some(({ child }) => child.exitCode !== null)) throw new Error('Test service exited')
    try { const response = await fetch(url); if (response.ok) return response } catch {}
    await pause(100)
  }
  throw new Error(`Service not ready: ${url}`)
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)) }, 15000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
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
const click = text => evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(text)}).click()`)
const field = label => `Array.from(document.querySelectorAll('[role="dialog"] label')).find(label=>label.querySelector('span')?.textContent===${JSON.stringify(label)})?.querySelector('input,select')`
async function fill(label, value) {
  await evaluate(`(()=>{const input=${field(label)}; Object.getOwnPropertyDescriptor(input.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`)
}
const clickIn = (scope, text) => evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(`${scope} button`)})).find(button=>button.textContent.trim()===${JSON.stringify(text)}).click()`)
const submitDisabled = `document.querySelector('[role="dialog"] form button[type="submit"]')?.disabled`
const createVisible = `document.querySelector('[aria-labelledby="kb-create-title"]')!==null`
const connectVisible = `document.querySelector('[aria-labelledby="kb-source-config-title"]')!==null`
const connectTitle = `document.querySelector('#kb-source-config-title')?.textContent`
const dialogError = `(document.querySelector('[role="dialog"] .kb-source-config-error')?.textContent ?? '')`
const dialogCount = 'document.querySelectorAll(\'[role="dialog"]\').length'
const postCount = `window.__requests.filter(request=>request.method==='POST').length`
const enterpriseCard = `document.querySelector('.kb-source-card[data-source="enterprise"]')`
const enterpriseState = () => evaluate(`${enterpriseCard}.querySelector('.kb-source-pill').textContent`)
const nasRow = id => `.kb-nas-row[data-nas-id="${id}"]`
const nasRowCount = `document.querySelectorAll('.kb-nas-row').length`
const nasRows = () => evaluate(`Array.from(document.querySelectorAll('.kb-nas-row')).map(row=>({id:row.dataset.nasId,title:row.querySelector('strong').textContent,state:row.querySelector('.kb-source-pill').textContent,text:row.textContent}))`)
const navLabels = () => evaluate(`Object.fromEntries(Array.from(document.querySelectorAll('.kb-nav-text')).map(item=>[item.querySelector('strong').textContent,item.querySelector('em').textContent]))`)
const createTarget = () => evaluate(`(()=>{const target=document.querySelector('.kb-create-target'); return {name:target.querySelector('strong')?.textContent, address:target.querySelector('code')?.textContent ?? ''}})()`)
const storedConfig = () => evaluate(`JSON.parse(localStorage.getItem('aifred:knowledge-source-config:v1') || 'null')`)
const libraryIds = () => evaluate(`window.__knowledgeApi.fetchKnowledgeBases().then(bases=>bases.map(base=>base.id).sort())`)
const openPage = (query = '') => send('Page.navigate', { url: `${origin}/tests/knowledge-create-smoke.html${query}` })
const output = path.join(cwd, 'output/knowledge-create-smoke')
async function screenshot(name) {
  await mkdir(output, { recursive: true })
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(output, name), Buffer.from(shot.data, 'base64'))
}
async function checkDraft(name) {
  await until(`${createVisible} && ${field('名称')}!==undefined`)
  assert.equal(await evaluate(`${field('名称')}.value`), name)
  assert.equal(await evaluate(dialogCount), 1)
}
try {
  start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'])
  start(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank',
  ])
  await ready(origin)
  const targets = await (await ready(`http://127.0.0.1:${debugPort}/json/list`)).json()
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
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
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1100, deviceScaleFactor: 1, mobile: false })
  await openPage()
  await until(`${enterpriseCard}!==null && document.querySelector('.kb-category-bar')!==null`)
  assert.equal(await evaluate('window.__requests.length'), 0, 'no configured source must not contact an Agent or remote knowledge service')
  assert.equal(await enterpriseState(), '未连接')
  assert.deepEqual(await nasRows(), [])
  assert.match(await evaluate(`document.querySelector('.kb-nas-panel').textContent`), /可以连接多个服务/)
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='上传文档').disabled`), true)
  assert.equal(await evaluate(`document.querySelector('[role="tablist"]').textContent.includes('本地电脑')`), false)
  // Without a NAS there is nothing to create on: no create button anywhere.
  const createButtons = `Array.from(document.querySelectorAll('button')).filter(button=>['新建知识库','新建 NAS 知识库','服务连接'].includes(button.textContent.trim())).length`
  assert.equal(await evaluate(createButtons), 0, 'creation starts only from a connected NAS row')
  await screenshot('sources-empty.png')

  // Adding a NAS is the only way to connect one; an invalid address is rejected before any request.
  await clickIn('.kb-nas-panel', '添加个人知识库服务')
  await until(`${connectVisible} && document.activeElement===${field('服务名称')}`)
  assert.equal(await evaluate(connectTitle), '添加个人知识库服务')
  assert.equal(await evaluate(submitDisabled), true, 'adding requires a NAS address')
  // Relative paths are supported for same-origin proxies; use a malformed absolute URL.
  await fill('服务地址', 'http://')
  await click('连接并添加')
  await until(`${dialogError}.length>0`)
  assert.equal(await storedConfig(), null, 'an invalid address is never saved')
  assert.equal(await evaluate('window.__requests.length'), 0)
  await click('取消')
  await until(`!(${connectVisible})`)

  // The enterprise library is connected from its own card, never created.
  await clickIn('.kb-source-card[data-source="enterprise"]', '连接企业知识库')
  await until(connectVisible)
  assert.equal(await evaluate(dialogCount), 1)
  assert.equal(await evaluate(connectTitle), '连接企业知识库')
  await screenshot('connect-enterprise.png')
  await fill('Manager 地址', origin)
  await fill('Manager 访问令牌', 'mock-manager-token')
  await click('保存并连接')
  await until(`!(${connectVisible}) && document.body.textContent.includes('企业共享知识库')`)
  assert.equal(await enterpriseState(), '已连接')
  assert.deepEqual(await nasRows(), [])
  assert.equal(await evaluate(`${enterpriseCard}.querySelector('.kb-source-card-address').textContent`), '127.0.0.1:1441')
  assert.equal(await evaluate(`${enterpriseCard}.querySelector('button').textContent.trim()`), '修改连接')
  assert.equal((await navLabels())['企业共享知识库'], '企业 · 按岗位权限')
  // Manager-only configuration offers no way to create a library.
  assert.equal(await evaluate(createButtons), 0)
  assert.equal(await evaluate(postCount), 0)
  await screenshot('sources-enterprise-connected.png')

  // A failing source is reported on its own card.
  await evaluate('window.__failManager=true')
  await click('刷新')
  await until(`${enterpriseCard}.classList.contains('is-error')`)
  assert.equal(await enterpriseState(), '连接失败')
  assert.match(await evaluate(`${enterpriseCard}.textContent`), /Manager 不可用/)
  await evaluate('window.__failManager=false')
  await click('刷新')
  await until(`${enterpriseCard}.querySelector('.kb-source-pill').textContent==='已连接'`)

  // Disconnect clears only Manager; reconnecting from the card restores the library.
  await clickIn('.kb-source-card[data-source="enterprise"]', '修改连接')
  await until(connectVisible)
  assert.equal(await evaluate(`${field('Manager 地址')}.value`), origin)
  await click('断开连接')
  await until(`!(${connectVisible}) && ${enterpriseCard}.querySelector('.kb-source-pill').textContent==='未连接'`)
  assert.equal(await evaluate(`document.body.textContent.includes('企业共享知识库')`), false)
  assert.equal((await storedConfig()).enterpriseUrl, '')
  await clickIn('.kb-source-card[data-source="enterprise"]', '连接企业知识库')
  await until(connectVisible)
  assert.equal(await evaluate(`${field('Manager 地址')}.value`), '')
  await fill('Manager 地址', origin)
  await fill('Manager 访问令牌', 'mock-manager-token')
  await click('保存并连接')
  await until(`${enterpriseCard}.querySelector('.kb-source-pill').textContent==='已连接'`)

  // A NAS is verified before it is saved; an address that cannot be listed is not added.
  await clickIn('.kb-nas-panel', '添加个人知识库服务')
  await until(`${connectVisible} && document.activeElement===${field('服务名称')}`)
  assert.equal(await evaluate(connectTitle), '添加个人知识库服务')
  await fill('服务名称', '总部')
  await fill('服务地址', `${origin}/bad`)
  await click('连接并添加')
  await until(`${dialogError}.includes('连接失败，未保存')`)
  assert.match(await evaluate(dialogError), /NAS 无法访问/)
  assert.deepEqual((await storedConfig()).nas, [])
  assert.equal(await evaluate(nasRowCount), 0)
  await fill('服务地址', `  ${origin}/nas/  `)
  await fill('访问令牌', 'mock-nas-token')
  await click('连接并添加')
  await until(`!(${connectVisible}) && ${nasRowCount}===1`)
  let stored = await storedConfig()
  const hqId = stored.nas[0].id
  assert.deepEqual(stored.nas, [{ id: hqId, name: '总部', url: `${origin}/nas`, token: 'mock-nas-token' }])
  assert.equal(stored.enterpriseUrl, origin, 'adding a NAS never touches the Manager connection')
  const [hqRow] = await nasRows()
  assert.equal(hqRow.title, '总部')
  assert.equal(hqRow.state, '已连接')
  assert.match(hqRow.text, /127\.0\.0\.1:1441\/nas/)
  assert.match(hqRow.text, /这台上有 1 个知识库/)
  assert.equal((await navLabels())['总部资料'], '个人·总部 · 仅本人')

  // The same NAS cannot be added twice; the check happens before any request.
  await clickIn('.kb-nas-panel', '添加个人知识库服务')
  await until(connectVisible)
  const beforeDuplicate = await evaluate('window.__requests.length')
  await fill('服务地址', `${origin}/nas`)
  await click('连接并添加')
  await until(`${dialogError}.includes('已连接为「总部」')`)
  assert.equal(await evaluate('window.__requests.length'), beforeDuplicate)
  assert.equal((await storedConfig()).nas.length, 1)
  await click('取消')
  await until(`!(${connectVisible})`)

  // Each NAS row creates on that NAS; adding a second NAS keeps the first unchanged.
  await clickIn('.kb-nas-panel', '添加个人知识库服务')
  await until(connectVisible)
  await fill('服务名称', '分部')
  await fill('服务地址', `${origin}/nas2`)
  await fill('访问令牌', 'mock-nas2-token')
  await click('连接并添加')
  await until(`!(${connectVisible}) && ${nasRowCount}===2`)
  stored = await storedConfig()
  const branchId = stored.nas[1].id
  assert.notEqual(branchId, hqId)
  assert.deepEqual(stored.nas[0], { id: hqId, name: '总部', url: `${origin}/nas`, token: 'mock-nas-token' }, 'adding a NAS keeps the others unchanged')
  assert.equal(stored.enterpriseUrl, origin)
  assert.equal(await evaluate(`document.querySelectorAll('.kb-nas-row .kb-nas-create:not(:disabled)').length`), 2)
  assert.equal(await evaluate(createButtons), 2, 'one create button per NAS, none elsewhere')

  await clickIn(nasRow(branchId), '新建知识库')
  await until(`${createVisible} && document.activeElement===${field('名称')}`)
  assert.deepEqual(await createTarget(), { name: '分部', address: '127.0.0.1:1441/nas2' })
  const createText = await evaluate(`document.querySelector('[aria-labelledby="kb-create-title"]').textContent`)
  for (const removed of ['选择 NAS', '添加新的 NAS', '上一步', 'NAS 服务地址', '知识库类型']) assert.equal(createText.includes(removed), false, removed)
  // Personal services only create private libraries: no level picker, the scope is stated instead.
  assert.equal(await evaluate(`${field('可见范围')}===undefined`), true)
  assert.match(createText, /可见范围：仅本人/)
  await fill('名称', 'NAS 新库')
  await fill('说明', '创建说明')
  await fill('目录名', '测试目录')
  assert.equal(await evaluate(submitDisabled), false)

  await send('Emulation.setDeviceMetricsOverride', { width: 620, height: 1100, deviceScaleFactor: 1, mobile: false })
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
  await screenshot('create-nas.png')

  // Backend rejection keeps the form; the library is created only on the chosen NAS.
  await evaluate('window.__failCreate=true')
  await click('创建')
  await until(`document.querySelector('.kb-modal-toast')?.textContent.includes('NAS 创建失败')`)
  await checkDraft('NAS 新库')
  await evaluate('window.__failCreate=false')
  await click('创建')
  await until(`document.querySelector('#test-route').textContent.includes(${JSON.stringify(branchId)}) && document.querySelector('#test-route').textContent.includes('created-1')`)
  const writes = await evaluate(`window.__requests.filter(request=>request.method==='POST')`)
  assert.equal(writes.length, 2)
  assert.ok(writes.every(request => request.path === '/nas2/api/knowledge-bases'))
  assert.ok(writes.every(request => request.auth === 'Bearer mock-nas2-token'))
  assert.deepEqual(JSON.parse(writes[1].body), { name: 'NAS 新库', description: '创建说明', directory: '测试目录', level: 'private' })
  await until(`document.querySelector('.kb-meta-line')?.textContent.includes('来源：个人·分部')`)
  // Each connection sends only its own token.
  const reads = await evaluate(`window.__requests.filter(request=>request.method==='GET')`)
  for (const [prefix, token] of [['/nas/', 'mock-nas-token'], ['/nas2/', 'mock-nas2-token'], ['/api/manager/', 'mock-manager-token']]) {
    const own = reads.filter(request => request.path.startsWith(prefix))
    assert.ok(own.length > 0, prefix)
    assert.ok(own.every(request => request.auth === `Bearer ${token}`), prefix)
  }

  // With several NAS, callers must say which one receives a new library.
  const multiError = await evaluate(`window.__knowledgeApi.createKnowledgeBase({name:'未指定',description:''}).then(()=>null,error=>error.message)`)
  assert.match(multiError, /已连接多台 NAS/)
  assert.equal(await evaluate(postCount), 2)

  // Back on the overview, the same server id on two NAS stays two separate libraries.
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1100, deviceScaleFactor: 1, mobile: false })
  await openPage('?keep=1')
  await until(`${nasRowCount}===2 && Array.from(document.querySelectorAll('.kb-nas-row .kb-source-pill')).every(pill=>pill.textContent==='已连接')`)
  assert.deepEqual((await nasRows()).map(row => [row.id, row.title]), [[hqId, '总部'], [branchId, '分部']])
  const ids = await libraryIds()
  assert.ok(ids.includes(`local:${hqId}:shared-id`) && ids.includes(`local:${branchId}:shared-id`), ids.join(','))
  const labels = await navLabels()
  assert.equal(labels['总部资料'], '个人·总部 · 仅本人')
  assert.equal(labels['分部资料'], '个人·分部 · 仅本人')
  await screenshot('sources-connected.png')

  // A failing NAS only affects its own row.
  await evaluate(`window.__failNas['/nas2']=true`)
  await click('刷新')
  await until(`document.querySelector(${JSON.stringify(nasRow(branchId))})?.classList.contains('is-error')`)
  const failing = Object.fromEntries((await nasRows()).map(row => [row.id, row]))
  assert.equal(failing[hqId].state, '已连接')
  assert.equal(failing[branchId].state, '连接失败')
  // A failed NAS cannot be created on until its connection is fixed.
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(nasRow(branchId))}).querySelector('.kb-nas-create').disabled`), true)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(nasRow(hqId))}).querySelector('.kb-nas-create').disabled`), false)
  assert.match(failing[branchId].text, /NAS 离线/)
  assert.equal(await enterpriseState(), '已连接')
  const partial = await navLabels()
  assert.ok('总部资料' in partial && !('分部资料' in partial))
  await screenshot('sources-nas-error.png')
  await evaluate(`window.__failNas['/nas2']=false`)

  // Disconnecting one NAS keeps the other NAS and the Manager.
  await clickIn(nasRow(branchId), '修改连接')
  await until(connectVisible)
  assert.equal(await evaluate(connectTitle), '修改个人知识库服务连接')
  assert.equal(await evaluate(`${field('服务名称')}.value`), '分部')
  await click('断开连接')
  await until(`!(${connectVisible}) && ${nasRowCount}===1`)
  assert.equal((await nasRows())[0].id, hqId)
  stored = await storedConfig()
  assert.deepEqual(stored.nas.map(item => item.id), [hqId])
  assert.equal(stored.enterpriseUrl, origin)
  assert.equal('分部资料' in (await navLabels()), false)

  // API callers that omit the NAS create on the only one, never in the Agent.
  await evaluate(`window.__knowledgeApi.createKnowledgeBase({name:'默认来源库',description:''})`)
  const lastWrite = await evaluate(`window.__requests.filter(request=>request.method==='POST').at(-1)`)
  assert.equal(lastWrite.path, '/nas/api/knowledge-bases')
  assert.equal(lastWrite.auth, 'Bearer mock-nas-token')
  const beforeBinding = await evaluate('window.__requests.length')
  const bindingError = await evaluate(`window.__knowledgeApi.updateEmployeeKnowledgeBases('employee-1',['enterprise:enterprise','device:old-kb']).then(()=>null,error=>error.message)`)
  assert.match(bindingError, /本机副本知识库已移除/)
  assert.equal(await evaluate('window.__requests.length'), beforeBinding, 'validate all IDs before any binding write')

  // A NAS saved before multi-NAS is migrated and keeps its `local:<id>` library keys.
  await evaluate(`localStorage.setItem('aifred:knowledge-source-config:v1', JSON.stringify({enterpriseUrl:'',enterpriseToken:'',localUrl:location.origin+'/nas',localToken:'legacy-token'}))`)
  await openPage('?keep=1')
  await until(`${nasRowCount}===1 && document.querySelector('.kb-nas-row .kb-source-pill').textContent==='已连接'`)
  const [legacyRow] = await nasRows()
  assert.equal(legacyRow.id, 'default')
  assert.equal(legacyRow.title, '127.0.0.1:1441/nas')
  assert.deepEqual(await libraryIds(), ['local:shared-id'])
  const legacyReads = await evaluate(`window.__requests.filter(request=>request.path.startsWith('/nas/'))`)
  assert.ok(legacyReads.length > 0 && legacyReads.every(request => request.auth === 'Bearer legacy-token'))

  // A legacy detail route is handled locally, even when no service is configured.
  await send('Page.navigate', { url: `${origin}/tests/knowledge-create-smoke.html?route=${encodeURIComponent('/knowledge/device:old-kb')}` })
  await until(`document.querySelector('h1')?.textContent==='本机副本知识库已移除'`)
  assert.equal(await evaluate('window.__requests.length'), 0)
  await evaluate(`Array.from(document.querySelectorAll('a')).find(link=>link.textContent==='查看本地文档').click()`)
  await until(`document.querySelector('#test-route').textContent==='/knowledge/local-documents' && document.querySelector('.kb-local-scan-toolbar')!==null`)
  assert.equal(await evaluate('window.__requests.length'), 0, 'local documents remain available without knowledge services')
  assert.equal(await evaluate(`document.querySelector('.kb-local-scan-toolbar').textContent.includes('扫描')`), true)
  assert.deepEqual(errors, [])
  console.log('PASS: empty sources make no HTTP calls; enterprise card connects only (connect/fail/disconnect); multiple NAS (verify before save, duplicate rejected, per-NAS rows/errors/disconnect, same server id kept apart); 添加个人知识库服务 is the only add entry; 新建知识库 only from a personal service row, targeting that service, private only, disabled when it fails; Manager-only offers no create; URL validation; per-connection tokens; single dialog; narrow layout; NAS failure/retry; no cross-source writes; legacy single-NAS config migrated with its keys; stale device IDs blocked; local documents remain available.')
} catch (error) {
  for (const child of children) console.error(child.log())
  throw error
} finally {
  for (const request of pending.values()) clearTimeout(request.timer)
  socket?.close()
  await Promise.all(children.map(({ child }) => new Promise(resolve => {
    if (child.exitCode !== null) return resolve()
    child.once('exit', resolve)
    child.kill('SIGTERM')
  })))
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
