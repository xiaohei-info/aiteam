import assert from 'node:assert/strict'
import { createServer, loadConfigFromFile } from 'vite'

const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, ws: false, hmr: false, watch: null }, appType: 'custom' })
try {
  const { BackendApiClient } = await server.ssrLoadModule('/src/api/backend/client.ts')
  const { AgentApiClient } = await server.ssrLoadModule('/src/api/agent/client.ts')
  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push({ url, ...options })
    if (url.endsWith('/attachments/file')) return new Response('binary-content', { headers: { 'content-type': 'application/octet-stream' } })
    return Response.json({ data: { ok: true }, page: { next_cursor: 'opaque', has_more: true } })
  }
  let currentUrl = 'http://127.0.0.1:53124'
  const local = new AgentApiClient({ resolveBaseUrl: async () => currentUrl, getToken: () => 'local-test-token', fetchImpl })
  assert.deepEqual(await local.request({ path: '/api/agent/whoami' }), { ok: true })
  currentUrl = 'http://127.0.0.1:54123'
  const blob = await local.request({ path: '/api/agent/conversations/conversation/attachments/file', binary: true })
  assert.equal(await blob.text(), 'binary-content')
  assert.equal(requests[1].url, `${currentUrl}/api/agent/conversations/conversation/attachments/file`)
  assert.equal(requests[1].headers.Authorization, 'Bearer local-test-token')
  assert.ok(!requests[1].url.includes('token'))
  await assert.rejects(() => local.request({ path: '/api/manager/employees' }), /path not allowed/)
  const backend = new BackendApiClient({ baseUrl: 'https://backend.example.test', getToken: () => 'enterprise-test-token', fetchImpl })
  const body = { filename: 'document.txt', mime_type: 'text/plain', data: 'ZG9jdW1lbnQ=' }
  await local.request({ method: 'POST', path: '/api/agent/conversations/conversation/attachments', body })
  assert.deepEqual(JSON.parse(requests.at(-1).body), body)
  assert.equal(requests.at(-1).headers['Content-Type'], 'application/json')
  assert.equal(requests.at(-1).headers.Authorization, 'Bearer local-test-token')
  const count = requests.length
  await assert.rejects(local.request({ method: 'POST', path: '/api/agent/conversations/conversation/attachments', body: new FormData() }), { code: 'client_body_denied' })
  assert.equal(requests.length, count)
  await backend.request({ path: '/api/agent/whoami', headers: { Authorization: 'Bearer verification-test-token' } })
  assert.equal(requests.at(-1).headers.Authorization, 'Bearer verification-test-token')
  await assert.rejects(() => backend.request({ path: '/api/manager/employees' }), /path not allowed/)
  await assert.rejects(() => backend.request({ path: '/api/operator/whoami' }), /path not allowed/)
  const raw = await local.request({ path: '/api/agent/work-records', raw: true })
  assert.equal(raw.page.next_cursor, 'opaque')
  // Opening CreateGroupDialog loads a Manager projection. Its 401 must not
  // erase a session that the same service's identity endpoint still accepts.
  for (const identityStatus of [200, 401, 403, 503, 'offline']) {
    let logouts = 0
    const authRequests = []
    const authClient = new BackendApiClient({
      baseUrl: 'https://backend.example.test',
      getToken: () => 'active-token',
      onUnauthorized: () => { logouts += 1 },
      fetchImpl: async (url, options) => {
        authRequests.push(url)
        assert.equal(options.headers.Authorization, 'Bearer active-token')
        if (url.endsWith('/whoami') && identityStatus === 'offline') throw new TypeError('offline')
        return Response.json({ detail: 'Manager authorization failed' }, {
          status: url.endsWith('/whoami') ? identityStatus : 401,
        })
      },
    })
    await assert.rejects(authClient.request({ path: '/api/agent/org/tree' }), { status: 401 })
    assert.equal(logouts, identityStatus === 401 ? 1 : 0)
    assert.deepEqual(authRequests, ['https://backend.example.test/api/agent/org/tree', 'https://backend.example.test/api/agent/whoami'])
  }
  let activeToken = 'old-token'
  let staleLogouts = 0
  const staleClient = new BackendApiClient({
    baseUrl: 'https://backend.example.test',
    getToken: () => activeToken,
    onUnauthorized: () => { staleLogouts += 1 },
    fetchImpl: async url => {
      if (url.endsWith('/whoami')) activeToken = 'new-token'
      return Response.json({}, { status: 401 })
    },
  })
  await assert.rejects(staleClient.request({ path: '/api/agent/org/tree' }), { status: 401 })
  assert.equal(staleLogouts, 0)
  for (const token of [null, 'active-token']) {
    let logouts = 0
    let requestCount = 0
    const identityClient = new BackendApiClient({
      baseUrl: 'https://backend.example.test', getToken: () => token,
      onUnauthorized: () => { logouts += 1 },
      fetchImpl: async () => { requestCount += 1; return Response.json({}, { status: 401 }) },
    })
    await assert.rejects(identityClient.request({ path: '/api/agent/whoami' }), { status: 401 })
    assert.equal(requestCount, 1, 'identity rejection must not recursively verify itself')
    assert.equal(logouts, token ? 1 : 0)
  }
  let resolveIdentity
  const identityGate = new Promise(resolve => { resolveIdentity = resolve })
  let verificationCount = 0
  const concurrentClient = new BackendApiClient({
    baseUrl: 'https://backend.example.test', getToken: () => 'active-token', onUnauthorized: () => assert.fail('session is valid'),
    fetchImpl: async url => {
      if (url.endsWith('/whoami')) {
        verificationCount += 1
        await identityGate
        return Response.json({})
      }
      return Response.json({}, { status: 401 })
    },
  })
  const concurrentRequests = Promise.all([1, 2, 3].map(() => assert.rejects(concurrentClient.request({ path: '/api/agent/org/tree' }), { status: 401 })))
  await new Promise(resolve => setImmediate(resolve))
  resolveIdentity()
  await concurrentRequests
  assert.equal(verificationCount, 1, 'concurrent failures share identity verification')
  console.log('[service-clients] dynamic discovery, documented route checks, authenticated binary, JSON uploads and envelope checks passed')
} finally { await server.close() }


const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' })
assert.ok(loaded)
const proxies = loaded.config.server.proxy
for (const [prefix, proxy] of Object.entries(proxies)) {
  const base = prefix === '/backend-api' ? '/backend-api' : ''
  const supported = prefix === '/healthz' || prefix === '/readyz' ? prefix : `${base}/api/agent/org/tree`
  assert.equal(await proxy.bypass({ method: 'GET', url: `${supported}?limit=1` }), undefined)
  for (const [method, url] of [
    ['GET', `${base}/api/manager/org/tree`],
    ['POST', `${base}/api/agent/org/tree`],
    ['GET', `${base}/api/agent/grants/snapshots`],
    ['GET', `${base}/api/agent/conversations/%2e%2e`],
  ]) assert.equal(await proxy.bypass({ method, url }), false)
  assert.equal(await proxy.bypass({ method: 'POST', url: `${base}/api/agent/grants/sync` }), undefined)
}
assert.equal(proxies['/backend-api'].rewrite('/backend-api/api/agent/org/tree'), '/api/agent/org/tree')
console.log('[service-clients] Vite proxies reject undocumented paths and methods')
