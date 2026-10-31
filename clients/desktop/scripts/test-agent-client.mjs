import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/api/agent')

// Test-harness parse helpers: these still throw on malformed input (so assertions
// fail loudly), but wrap the raw throwing calls in try/catch and re-raise with
// context so a failure names the suspected capture instead of a bare SyntaxError.
function parseJson(raw) {
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`捕获到非 JSON 响应体: ${String(raw).slice(0, 120)}`, { cause: error })
  }
}

function urlPathname(url) {
  try {
    return new URL(url).pathname
  } catch (error) {
    throw new Error(`捕获到非法 URL: ${String(url).slice(0, 120)}`, { cause: error })
  }
}

// Exercise the actual TS modules in isolated dev/production WebView contexts.
// Mock only Tauri IPC and transport, without introducing a frontend test framework.
function environment({ desktop = true, dev = false, address = 'http://127.0.0.1:53124', responses = {}, assetAddress = 'asset://localhost/cache/file.pdf' } = {}) {
  const calls = []
  const logs = []
  let invocations = 0
  let credential = null
  const fetch = async (url, options) => {
    calls.push({ url, options })
    if (String(url).startsWith('asset://')) return new Response('local-file')
    if (/\/api\/agent\/conversations\/[^/]+\/(attachments|artifacts)\/[^/]+$/.test(String(url))) return new Response('agent-file')
    if (String(url).includes('/events')) {
      return new Response('id: entry-1\nevent: pi\ndata: {"type":"agent_end"}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }
    const pathname = new URL(url, 'http://browser.test').pathname
    if (pathname.endsWith('/api/agent/knowledge-bases')) return new Response(JSON.stringify({ error: { code: 'Gone', message: 'Knowledge API retired' } }), { status: 410 })
    return new Response(JSON.stringify({ data: responses[pathname] ?? { status: 'ok' } }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const context = vm.createContext({
    env: { DEV: dev, VITE_AGENT_BASE_URL: 'https://remote-must-not-be-used.example', VITE_BACKEND_BASE_URL: 'http://121.40.78.201:8783' },
    // desktop 为 true 时注入 __TAURI_INTERNALS__，被测模块据此走原生 HTTP 分支（桌面模式开关）。
    window: { ...(desktop ? { __TAURI_INTERNALS__: {} } : {}), dispatchEvent() {}, addEventListener() {} },
    fetch: desktop ? (url, options) => {
      if (String(url).startsWith('asset://')) return fetch(url, options)
      throw new Error('Desktop must use native HTTP, including dev')
    } : fetch,
    URL, URLSearchParams, Response, AbortController, TransformStream, TextDecoderStream,
    setTimeout, clearTimeout, console: { ...console, info: (...args) => logs.push(args) }, performance,
    // WebView modules such as src/lib/applicationLog.ts read globalThis.crypto at module scope;
    // a vm context does not inherit host globals, so expose the host WebCrypto explicitly.
    crypto: webcrypto,
    __agentToken: 'test-enterprise-identity',
  })
  const cache = new Map()
  function load(name) {
    name = path.resolve(root, name).replace(/\.ts$/, '')
    if (!existsSync(`${name}.ts`)) name = path.join(name, 'index')
    if (cache.has(name)) return cache.get(name)
    const source = readFileSync(`${name}.ts`, 'utf8').replaceAll('import.meta.env', 'env')
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    })
    const exports = {}
    cache.set(name, exports)
    const require = (id) => {
      if (id === '@tauri-apps/api/core') return {
        invoke: async (command, args) => {
          if (command === 'resolve_cached_file') { assert.equal(args.relPath, 'cache/file.pdf'); return assetAddress }
          if (command === 'secure_session_read') return credential
          if (command === 'secure_session_write') { credential = args.session; return }
          if (command === 'secure_session_delete') { credential = null; return }
          assert.equal(command, 'get_agent_base_url')
          invocations++
          if (address instanceof Error) throw address
          return address
        },
      }
      if (id === 'zustand') return { create: initializer => {
        let state
        const getState = () => state
        const setState = patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) } }
        state = initializer(setState, getState)
        return { getState, setState }
      } }
      if (id === '@tauri-apps/plugin-dialog') return { open: async () => null }
      // Native HTTP ownership is covered by tests/nativeHttpFetch.test.ts.
      if (id === './nativeHttpFetch') return { createNativeHttpFetch: () => fetch }
      if (id.startsWith('.')) return load(path.resolve(path.dirname(name), id))
      throw new Error(`Unexpected import ${id}`)
    }
    vm.runInContext(`(function(require, exports) { ${outputText}\n})`, context)(require, exports)
    return exports
  }
  return { load, calls, logs, credential: () => credential, token: () => context.__agentToken, invocations: () => invocations, setAddress(value) { address = value } }
}

test('development logs expose the destination and correlate response status without credentials', async () => {
  const env = environment({ dev: true })
  await env.load('runtime').initializeAgentRuntime()
  const { AgentApiClient } = env.load('client')
  await new AgentApiClient({ getToken: () => 'secret-bearer' }).request({
    path: '/api/auth/resolve-tenant-by-account', method: 'POST',
    body: { account: 'private-account', password: 'private-password' },
    query: { token: 'private-query', limit: 25 },
  })
  assert.match(env.logs[0][0], /\[AgentApi #1\] POST http:\/\/127\.0\.0\.1:53124\/api\/auth\/resolve-tenant-by-account\?<redacted> →/)
  assert.match(env.logs[1][0], /\[AgentApi #1\].*← 200/)
  assert.equal(env.logs.length, 2)
  assert.match(env.logs[0][0], /"limit":25/)
  assert.match(env.logs[1][0], /"data":/)
  for (const secret of ['secret-bearer', 'private-account', 'private-password', 'private-query']) {
    assert.ok(!JSON.stringify(env.logs).includes(secret))
  }
  const release = environment({ dev: false })
  await release.load('runtime').initializeAgentRuntime()
  await new (release.load('client').AgentApiClient)().request({ path: '/healthz' })
  assert.equal(release.logs.length, 0)
})

for (const dev of [true, false]) {
  test(`Tauri ${dev ? 'dev' : 'production'} keeps identity checks and chat SSE on the local gateway Agent`, async () => {
    const env = environment({ dev })
    const runtime = env.load('runtime')
    const { AgentApiClient } = env.load('client')
    const client = new AgentApiClient({ getToken: () => 'test-bearer' })
    assert.throws(() => runtime.getAgentBaseUrl(), /尚未就绪/)
    await Promise.all([runtime.initializeAgentRuntime(), runtime.initializeAgentRuntime()])
    assert.equal(env.invocations(), 1)
    const response = await client.request({ path: '/api/agent/whoami' })
    assert.equal(response.status, 'ok')
    assert.equal(env.calls[0].url, 'http://127.0.0.1:53124/api/agent/whoami')
    assert.equal(env.calls[0].options.headers.Authorization, 'Bearer test-bearer')
    await new Promise((resolve, reject) => {
      const subscription = env.load('events').subscribeConversationEvents({
        conversationId: 'conversation/1', after: 'previous',
        onEvent(event, id) {
          try {
            assert.equal(event.type, 'agent_end')
            assert.equal(id, 'entry-1')
            subscription.close()
            resolve()
          } catch (error) { reject(error) }
        },
        onError: reject,
      })
    })
    assert.equal(env.calls[1].url, 'http://127.0.0.1:53124/api/agent/conversations/conversation%2F1/events?after=previous')
  })
}

test('startup errors and invalid host URLs never fall back to remote Agent', async () => {
  for (const address of [new Error('missing JWKS'), 'http://remote.example:8000', 'http://127.0.0.1:53124/redirect']) {
    const env = environment({ address })
    const runtime = env.load('runtime')
    await assert.rejects(runtime.initializeAgentRuntime())
    assert.throws(() => runtime.getAgentBaseUrl(), /尚未就绪/)
    assert.equal(env.calls.length, 0)
  }
})

test('local API and chat SSE both follow a rediscovered child', async () => {
  const env = environment()
  await env.load('runtime').initializeAgentRuntime()
  env.setAddress('http://127.0.0.1:54432')
  const client = new (env.load('client').AgentApiClient)()
  await client.request({ path: '/healthz' })
  assert.equal(env.calls[0].url, 'http://127.0.0.1:54432/healthz')
  env.setAddress('http://127.0.0.1:55443')
  await new Promise((resolve, reject) => {
    const subscription = env.load('events').subscribeConversationEvents({
      conversationId: 'restart',
      onEvent() { subscription.close(); resolve() },
      onError: reject,
    })
  })
  assert.equal(env.calls[1].url, 'http://127.0.0.1:55443/api/agent/conversations/restart/events')
})

test('login goes through the local gateway Agent, verifies locally and syncs grants without tenant lookup', async () => {
  const claims = { tenant_id: 'tenant', user_id: 'member', roles: ['member'] }
  const env = environment({ responses: {
    '/api/agent/login': { token: 'login-token', claims },
    '/api/agent/whoami': claims,
    '/api/agent/grants/sync': { ok: true },
    '/api/agent/grants/readiness': { runtime: 'ready', experts: [] },
  } })
  const store = env.load('../../stores/agentAuth').useAgentAuthStore
  await store.getState().logout()
  assert.equal(await store.getState().login(' 企业代码 ', 'account', 'password'), 'authenticated')
  assert.equal(store.getState().isAuthenticated, true)
  assert.equal(parseJson(env.credential()).token, 'login-token')
  assert.equal(env.token(), 'login-token')
  assert.deepEqual(env.calls.map(({ url }) => url), [
    'http://127.0.0.1:53124/api/agent/login',
    'http://127.0.0.1:53124/api/agent/whoami',
    'http://127.0.0.1:53124/api/agent/grants/sync',
    'http://127.0.0.1:53124/api/agent/grants/readiness',
  ])
  assert.equal(env.calls[0].options.headers.Authorization, undefined)
  assert.deepEqual(parseJson(env.calls[0].options.body), {
    enterprise: '企业代码', account: 'account', password: 'password',
  })
  assert.ok(env.calls.slice(1).every(call => call.options.headers.Authorization === 'Bearer login-token'))
  assert.deepEqual(parseJson(env.calls[2].options.body), { tenant_id: 'tenant', member_id: 'member', known_versions: {} })
  env.calls.length = 0
  await store.getState().restoreSession()
  assert.equal(store.getState().isAuthenticated, true)
  assert.deepEqual(env.calls.map(call => urlPathname(call.url)), [
    '/api/agent/whoami', '/api/agent/grants/sync', '/api/agent/grants/readiness',
  ])
  await store.getState().logout()
  assert.equal(env.token(), null)
  assert.equal(env.credential(), null)
})

test('sync failure prevents login and restoration can retry without losing credentials', async () => {
  const claims = { tenant_id: 'tenant', user_id: 'member', roles: ['member'] }
  const responses = {
    '/api/agent/login': { token: 'login-token', claims },
    '/api/agent/whoami': claims,
    '/api/agent/grants/sync': { ok: false },
    '/api/agent/grants/readiness': { runtime: 'ready', experts: [] },
  }
  const env = environment({ responses })
  const store = env.load('../../stores/agentAuth').useAgentAuthStore
  await store.getState().logout()
  await assert.rejects(store.getState().login('tenant', 'account', 'password'), /同步用户授权配置失败/)
  assert.equal(store.getState().isAuthenticated, false)
  assert.equal(env.credential(), null)
  assert.equal(env.token(), null)
  responses['/api/agent/grants/sync'] = { ok: true }
  await store.getState().login('tenant', 'account', 'password')
  const saved = env.credential()
  responses['/api/agent/grants/sync'] = { ok: false }
  await store.getState().restoreSession()
  assert.equal(store.getState().isAuthenticated, false)
  assert.match(store.getState().restoreError, /同步授权配置/)
  assert.equal(env.credential(), saved)
  assert.equal(env.token(), null)
  responses['/api/agent/grants/sync'] = { ok: true }
  await store.getState().restoreSession()
  assert.equal(store.getState().isAuthenticated, true)
  await store.getState().logout()
})

for (const inputTenantId of ['', '   ']) {
  test(`login resolves the enterprise by account when the input is ${JSON.stringify(inputTenantId)}`, async () => {
    const claims = { tenant_id: 'resolved-tenant', user_id: 'member', roles: ['member'] }
    const env = environment({ responses: {
      '/api/auth/resolve-tenant-by-account': { tenant_id: 'resolved-tenant' },
      '/api/agent/login': { token: 'login-token', claims },
      '/api/agent/whoami': claims,
    '/api/agent/grants/sync': { ok: true },
    '/api/agent/grants/readiness': { runtime: 'ready', experts: [] },
    } })
    const store = env.load('../../stores/agentAuth').useAgentAuthStore
    await store.getState().logout()
    assert.equal(await store.getState().login(inputTenantId, 'account', 'password'), 'authenticated')
    assert.deepEqual(env.calls.map(({ url }) => urlPathname(url)), [
      '/api/auth/resolve-tenant-by-account', '/api/agent/login', '/api/agent/whoami',
      '/api/agent/grants/sync', '/api/agent/grants/readiness',
    ])
    assert.deepEqual(parseJson(env.calls[0].options.body), { account: 'account' })
    assert.deepEqual(parseJson(env.calls[1].options.body), {
      tenant_id: 'resolved-tenant', account: 'account', password: 'password',
    })
    assert.equal(store.getState().tenantId, 'resolved-tenant')
    await store.getState().logout()
  })
}

test('required password reset retains enterprise and stores the resolved tenant', async () => {
  const claims = { tenant_id: 'entered-tenant', user_id: 'member', roles: ['member'] }
  const env = environment({ responses: {
    '/api/agent/reset-password': { token: 'replacement-token', claims },
    '/api/agent/whoami': claims,
    '/api/agent/grants/sync': { ok: true },
    '/api/agent/grants/readiness': { runtime: 'ready', experts: [] },
  } })
  env.load('../backend/index').backendApi.login = async () => {
    throw { status: 403, code: 'forbidden', message: 'password reset required' }
  }
  const store = env.load('../../stores/agentAuth').useAgentAuthStore
  assert.equal(await store.getState().login('企业名称', 'account', 'password'), 'password_reset_required')
  assert.equal(store.getState().pendingPasswordReset.enterprise, '企业名称')
  assert.equal(store.getState().isAuthenticated, false)
  await store.getState().resetPassword('password', 'New-Password-1!')
  assert.deepEqual(parseJson(env.calls[0].options.body), {
    enterprise: '企业名称', account: 'account',
    old_password: 'password', new_password: 'New-Password-1!',
  })
  assert.equal(store.getState().tenantId, 'entered-tenant')
  assert.equal(store.getState().isAuthenticated, true)
  await store.getState().logout()
})

for (const identity of [
  { tenant_id: 'other', user_id: 'member', roles: ['member'] },
  { tenant_id: 'tenant', user_id: 'other', roles: ['member'] },
]) {
  test(`login rejects local identity mismatch ${identity.tenant_id}/${identity.user_id}`, async () => {
    const env = environment({ responses: { '/api/agent/whoami': identity } })
    const store = env.load('../../stores/agentAuth').useAgentAuthStore
    await store.getState().logout()
    await assert.rejects(store.getState().setSession({ token: 'token', tenantId: 'tenant', account: 'account',
      claims: { tenant_id: 'tenant', user_id: 'member', roles: ['member'] } }))
    assert.equal(store.getState().isAuthenticated, false)
    assert.equal(env.credential(), null)
    assert.equal(env.token(), null)
  })
}

for (const dev of [true, false]) {
  test(`desktop backend routes go through the local gateway Agent and never fall back to remote in ${dev ? 'dev' : 'release'}`, async () => {
    const env = environment({ dev })
    const { backendApi } = env.load('../backend/index')
    await backendApi.getOrgTree()
    await backendApi.listMarketplaceTemplates()
    await backendApi.listExperts()
    assert.deepEqual(env.calls.map(({ url }) => url), [
      'http://127.0.0.1:53124/api/agent/org/tree',
      'http://127.0.0.1:53124/api/agent/marketplace/templates',
      'http://127.0.0.1:53124/api/agent/grants/experts',
    ])
    assert.ok(env.calls.every(({ options }) => options.headers.Authorization === 'Bearer test-enterprise-identity'))
    const offline = environment({ dev, address: new Error('Agent unavailable') })
    await assert.rejects(offline.load('../backend/index').backendApi.getOrgTree())
    assert.equal(offline.calls.length, 0)
  })
}

test('both clients reject undocumented routes, methods and snapshots before sending credentials', async () => {
  const env = environment()
  for (const client of [new (env.load('client').AgentApiClient)(), new (env.load('../backend/client').BackendApiClient)()]) {
    for (const [method, path] of [
      ['GET', '/api/manager/org/tree'], ['GET', '/api/operator/tenants'],
      ['GET', '/api/agent/%2e%2e/manager/employees'], ['GET', '/healthz-redirect'],
      ['GET', '/api/agent/grants/snapshots'],
      ['POST', '/api/agent/org/tree'], ['GET', '/api/agent/conversations/..'],
      ['GET', '/api/agent/conversations/%2e%2e'], ['GET', '/api/agent/conversations/%zz'],
    ]) await assert.rejects(client.request({ path, method }), { code: 'client_path_denied' })
  }
  assert.equal(env.calls.length, 0)
  assert.equal(env.invocations(), 0)
})

test('knowledge preserves documented 410 and reads employee roles without guessing status', async () => {
  const env = environment({ responses: {
    '/api/agent/grants/experts': [
      { employee_id: 'employee', display_name: 'Analyst', role_title: 'Research', status: 'paused' },
      { employee_id: 'unknown', display_name: 'Unknown' },
      { employee_id: 'revoked', revoked: true },
    ],
  } })
  const knowledge = env.load('../../pages/KnowledgeBase/api')
  await assert.rejects(knowledge.fetchKnowledgeBases(), { status: 410 })
  const employees = await knowledge.fetchKnowledgeEmployees()
  assert.equal(employees.length, 2)
  assert.equal(employees[0].roleName, 'Research')
  assert.equal(employees[0].status, 'paused')
  assert.equal(employees[1].status, undefined)
  const count = env.calls.length
  await assert.rejects(knowledge.createKnowledgeBase({ name: 'test', description: '' }), { status: 410 })
  await assert.rejects(knowledge.updateEmployeeKnowledgeBases('employee', ['kb']), { status: 410 })
  assert.equal(env.calls.length, count)
  assert.ok(env.calls.every(({ url }) => url.startsWith('http://127.0.0.1:53124/api/agent/')))
})

test('organization and talent pages consume documented backend contracts', async () => {
  const env = environment({ responses: {
    '/api/agent/org/tree': { id: 'tenant', type: 'department', name: 'Enterprise', children: [
      { id: 'department', type: 'department', name: 'Research', children: [
        { id: 'employee', type: 'employee', name: 'Analyst', role_title: 'Research analyst' },
      ] },
    ] },
    '/api/agent/org/departments': { id: 'department-new', name: '研究部' },
    '/api/agent/org/assignments/employee%2F1': { employee_id: 'employee/1', department_id: 'department-new' },
    '/api/agent/marketplace/templates/template': {
      template_id: 'template', display_name: 'Expert', model_name: 'model',
      description: 'Published description', platform_skill_refs: [], skills_count: 0,
      category: 'research', tags: [], avatar_url: null, recruit_count: null, is_recruited: true,
    },
    '/api/agent/marketplace/templates': [{
      template_id: 'template', display_name: 'Expert', description: 'Published description',
      model_name: 'model', category: 'research', tags: [], avatar_url: null,
      platform_skill_refs: [], skills_count: 0, recruit_count: null, is_recruited: true,
    }],
  } })
  const org = await env.load('../../pages/OrgChart/api').fetchOrgTree()
  assert.equal(org.departments[0].members[0].position_title, 'Research analyst')
  const market = env.load('../../pages/TalentMarket/api')
  const list = await market.fetchMarketAgents()
  assert.equal(list.items[0].description, 'Published description')
  assert.equal(list.items[0].skills_count, 0)
  assert.equal(list.items[0].recruit_count, null)
  assert.equal((await market.fetchMarketTemplateDetail('template')).name, 'Expert')
  await assert.rejects(market.recruitMarketAgent('template'), { status: 410 })
  // 组织架构只开放“添加部门”和“追加部门”两个写入口；编辑员工资料仍不存在。
  const orgApi = env.load('../../pages/OrgChart/api')
  assert.equal(orgApi.updateEmployee, undefined)
  const before = env.calls.length
  assert.deepEqual(await orgApi.createDepartment('研究部'), { id: 'department-new', name: '研究部' })
  await orgApi.assignEmployeeDepartment('employee/1', 'department-new')
  const [created, assigned] = env.calls.slice(before)
  assert.equal(env.calls.length, before + 2)
  assert.equal(created.url, 'http://127.0.0.1:53124/api/agent/org/departments')
  assert.equal(created.options.method, 'POST')
  assert.deepEqual(parseJson(created.options.body), { name: '研究部' })
  assert.equal(assigned.url, 'http://127.0.0.1:53124/api/agent/org/assignments/employee%2F1')
  assert.equal(assigned.options.method, 'PATCH')
  assert.deepEqual(parseJson(assigned.options.body), { department_id: 'department-new' })
  assert.ok([created, assigned].every(call => call.options.headers.Authorization === 'Bearer test-enterprise-identity'))
  assert.ok(env.calls.every(({ url }) => url.startsWith('http://127.0.0.1:53124/api/agent/')))
})

test('market distinguishes empty catalogs and malformed responses without extra logs', async () => {
  for (const [data, query, matched] of [
    [[], {}, 0],
    [[{ template_id: 't', display_name: 'Analyst', model_name: 'm' }], { q: 'unmatched' }, 0],
  ]) {
    const env = environment({ dev: true, responses: { '/api/agent/marketplace/templates': data } })
    const result = await env.load('../../pages/TalentMarket/api').fetchMarketAgents(query)
    assert.equal(result.items.length, matched)
    assert.equal(env.logs.length, 2)
    assert.ok(env.logs.every(([label]) => !label.includes('list counts')))
  }
  const malformed = environment({ responses: { '/api/agent/marketplace/templates': { items: [] } } })
  await assert.rejects(malformed.load('../../pages/TalentMarket/api').fetchMarketAgents(), { code: 'client_bad_catalog' })
})

test('browser development keeps relative proxy paths and explicit client overrides work', async () => {
  const env = environment({ desktop: false, dev: true })
  await env.load('runtime').initializeAgentRuntime()
  const { AgentApiClient } = env.load('client')
  await new AgentApiClient().request({ path: '/healthz' })
  await new AgentApiClient({ baseUrl: 'http://127.0.0.1:54321' }).request({ path: '/readyz' })
  assert.equal(env.calls[0].url, '/healthz')
  assert.equal(env.calls[1].url, 'http://127.0.0.1:54321/readyz')
  await env.load('../backend/index').backendApi.getOrgTree()
  assert.equal(env.calls[2].url, '/backend-api/api/agent/org/tree')
  assert.equal(env.invocations(), 0)
})

test('native permission failures become actionable errors without exposing request secrets', async () => {
  const env = environment()
  const { AgentApiClient, AgentApiError } = env.load('client')
  const client = new AgentApiClient({
    baseUrl: 'http://127.0.0.1:64400',
    fetchImpl: async () => {
      // 刻意抛出裸字符串而非 Error：原生层可能抛出任意值，
      // 该测试验证 client 能净化非 Error 抛出且不泄露密钥。
      const nativeFailure = 'error deserializing scope: http://account:private-value@example.invalid'
      throw nativeFailure
    },
  })
  await assert.rejects(client.request({
    method: 'POST', path: '/api/auth/resolve-tenant-by-account', body: { account: 'test' },
  }), (error) => {
    assert.ok(error instanceof AgentApiError)
    assert.equal(error.code, 'client_http_permission_denied')
    assert.match(error.message, /权限/)
    assert.doesNotMatch(error.message, /private-value|example.invalid/)
    return true
  })
})

test('unreadable successful responses are not reported as a connectivity failure', async () => {
  const env = environment()
  const { AgentApiClient, AgentApiError } = env.load('client')
  const client = new AgentApiClient({
    baseUrl: 'http://127.0.0.1:64400',
    fetchImpl: async () => new Response('truncated {', {
      headers: { 'Content-Type': 'application/json' },
    }),
  })
  await assert.rejects(client.request({ path: '/healthz' }), (error) => {
    assert.ok(error instanceof AgentApiError)
    assert.equal(error.code, 'client_bad_response')
    return true
  })
})


test('conversation file downloads use the current local gateway Agent and authenticated documented routes', async () => {
  const env = environment()
  const { agentApi } = env.load('index')
  assert.equal(await (await agentApi.downloadFile('conversation/1', 'attachment', 'file/1')).text(), 'agent-file')
  env.setAddress('http://127.0.0.1:55443')
  assert.equal(await (await agentApi.downloadFile('conversation/1', 'artifact', 'file/2')).text(), 'agent-file')
  assert.deepEqual(env.calls.map(({ url }) => url), [
    'http://127.0.0.1:53124/api/agent/conversations/conversation%2F1/attachments/file%2F1',
    'http://127.0.0.1:55443/api/agent/conversations/conversation%2F1/artifacts/file%2F2',
  ])
  assert.ok(env.calls.every(({ options }) => options.headers.Authorization === 'Bearer test-enterprise-identity'))
})

test('knowledge preview never requests arbitrary URLs or invokes the removed HTTP bridge', async () => {
  const env = environment()
  const knowledge = env.load('../../pages/KnowledgeBase/api')
  for (const previewUrl of ['/previews/file', 'https://aifred.cn/old-api/file', 'http://127.0.0.1:1234/legacy']) {
    const file = { previewUrl }
    assert.equal(knowledge.getKnowledgeFilePreviewUrlResult(file).url, null)
    await assert.rejects(knowledge.fetchKnowledgeFilePreview(file), { status: 410 })
  }
  assert.equal(env.calls.length, 0)
  assert.equal(env.invocations(), 0)
})

test('upload reads the native cached path and never trusts a restored asset_url as a remote endpoint', async () => {
  const file = { rel_path: 'cache/file.pdf', asset_url: 'https://aifred.cn/old-api/file' }
  const env = environment()
  const blob = await env.load('../../lib/fileCache').readCachedFileBlob(file)
  assert.equal(await blob.text(), 'local-file')
  assert.deepEqual(env.calls.map(({ url }) => url), ['asset://localhost/cache/file.pdf'])
  const invalid = environment({ assetAddress: 'https://aifred.cn/old-api/file' })
  await assert.rejects(invalid.load('../../lib/fileCache').readCachedFileBlob(file))
  assert.equal(invalid.calls.length, 0)
})

test('SSE rejects a path traversal conversation before network or discovery', async () => {
  const env = environment()
  await new Promise((resolve, reject) => {
    const subscription = env.load('events').subscribeConversationEvents({
      conversationId: '..',
      onError(error) {
        subscription.close()
        try { assert.equal(error.code, 'client_path_denied'); resolve() } catch (error) { reject(error) }
      },
      onEvent: () => reject(new Error('unexpected event')),
    })
  })
  assert.equal(env.calls.length, 0)
  assert.equal(env.invocations(), 0)
})

for (const desktop of [true, false]) {
  test(`chat history, creation, prompt and state share one destination (${desktop ? 'desktop: local gateway Agent' : 'browser dev'})`, async () => {
    const prefix = desktop ? '' : '/backend-api'
    const env = environment({ desktop, dev: true, ...(desktop ? {} : { address: new Error('local Agent offline') }), responses: {
      [`${prefix}/api/agent/conversations`]: { id: 'remote-chat' },
      [`${prefix}/api/agent/conversations/remote-chat/entries`]: { entries: [{ id: 'entry', type: 'message', message: { role: 'user', content: 'history' } }] },
    } })
    const { agentApi } = env.load('index')
    await agentApi.createConversation({ kind: 'chat', entry_employee_id: 'employee' })
    // Page metadata comes from the wire; use listEntriesPage to verify routing independently.
    await agentApi.listEntriesPage('remote-chat', { limit: 100 })
    await agentApi.submitPrompt('remote-chat', { text: 'hello' }, 'retry-key')
    await agentApi.getConversationState('remote-chat')
    const base = desktop ? 'http://127.0.0.1:53124' : '/backend-api'
    assert.deepEqual(env.calls.map(c => c.url), [
      `${base}/api/agent/conversations`,
      `${base}/api/agent/conversations/remote-chat/entries?limit=100`,
      `${base}/api/agent/conversations/remote-chat/prompt`,
      `${base}/api/agent/conversations/remote-chat/state`,
    ])
    assert.ok(env.calls.every(c => c.options.headers.Authorization === 'Bearer test-enterprise-identity'))
    assert.equal(env.calls[2].options.headers['Idempotency-Key'], 'retry-key')
    if (!desktop) { assert.equal(env.invocations(), 0); return }
    // The desktop prompt must reach the local gateway (local-directory retrieval), never the remote Agent directly.
    const offline = environment({ desktop, dev: true, address: new Error('local Agent offline') })
    await assert.rejects(offline.load('index').agentApi.submitPrompt('remote-chat', { text: 'hello' }, 'offline-key'))
    assert.equal(offline.calls.length, 0)
  })
}
