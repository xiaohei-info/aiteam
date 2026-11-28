import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { build } = await import(pathToFileURL(require.resolve('esbuild', { paths: [dirname(require.resolve('vite'))] })).href)

const claims = (tenant: string) => ({ user_id: 'member-1', tenant_id: tenant, roles: ['member'] })
const problem = (status: number, code: string, meta?: unknown) =>
  Object.assign(new Error(code), { status, code, problem: { code, detail: code, meta } })

// Bundle the real store; only the Agent HTTP adapter and the keychain are replaced.
async function launch() {
  const directory = mkdtempSync(join(tmpdir(), 'tenant-login-store-'))
  const output = join(directory, 'store.cjs')
  await build({
    entryPoints: ['src/stores/agentAuth.ts'], outfile: output, bundle: true, platform: 'node', format: 'cjs',
    plugins: [{ name: 'adapters', setup(builder: any) {
      builder.onResolve({ filter: /^\.\.\/api\/(agent|backend)$/ }, () => ({ path: 'api', namespace: 'fake' }))
      builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'vault', namespace: 'fake' }))
      builder.onLoad({ filter: /.*/, namespace: 'fake' }, ({ path }: { path: string }) => ({ contents: path === 'api'
        ? `export class AgentApiClient { constructor(o) { this.o=o } request(r) { return globalThis.__tenantLoginTest.request(r) } logout() { return Promise.resolve() } };
           export const backendApi = { login: (b) => globalThis.__tenantLoginTest.call('login', b), resetPassword: (b) => globalThis.__tenantLoginTest.call('reset', b) };`
        : `export const invoke = (...args) => globalThis.__tenantLoginTest.invoke(...args);` }))
    } }],
  })
  const calls: Array<{ kind: string; body: any }> = []
  const requests: string[] = []
  const adapter = {
    handlers: {} as Record<string, (body: any) => Promise<unknown>>,
    call: async (kind: string, body: any) => {
      calls.push({ kind, body })
      const result: any = await adapter.handlers[kind](body)
      adapter.whoamiTenant = result.claims.tenant_id // the local whoami echoes the issued session
      return result
    },
    request: async (r: any) => { requests.push(r.path); return r.path.endsWith('whoami') ? claims(adapter.whoamiTenant) : {} },
    whoamiTenant: '',
    vault: null as string | null,
    invoke: async (command: string, args?: any) => {
      if (command === 'secure_session_read') return adapter.vault
      if (command === 'secure_session_write') adapter.vault = args.session
      if (command === 'secure_session_delete') adapter.vault = null
      return null
    },
  }
  ;(globalThis as any).__tenantLoginTest = adapter
  ;(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  ;(globalThis as any).window = { __TAURI_INTERNALS__: {}, addEventListener() {} }
  const store = (await import(pathToFileURL(output).href)).default.useAgentAuthStore
  return {
    store, adapter, calls, requests,
    close: () => {
      rmSync(directory, { recursive: true, force: true })
      delete (globalThis as any).window
      delete (globalThis as any).localStorage
    },
  }
}

test('多企业账号：未填企业标识直接登录拿到 409 候选，再按 tenant_id 登录成功，不再解析企业', async () => {
  const f = await launch()
  try {
    f.adapter.handlers.login = async (body: any) => {
      if (!body.tenant_id) throw problem(409, 'tenant_selection_required', { candidates: [{ tenant_id: 't-a', enterprise_name: '甲' }, { tenant_id: 't-b', enterprise_name: '乙' }] })
      return { token: 'tok', claims: claims(body.tenant_id) }
    }
    await assert.rejects(f.store.getState().login('', 'member', 'pw'), (error: any) => error.status === 409)
    assert.equal(await f.store.getState().login('', 'member', 'pw', 't-b'), 'authenticated')

    assert.deepEqual(f.calls, [
      { kind: 'login', body: { account: 'member', password: 'pw' } },
      { kind: 'login', body: { tenant_id: 't-b', account: 'member', password: 'pw' } },
    ])
    assert.ok(!f.requests.some((path) => path.includes('resolve-tenant')), 'the retired resolver must never be called')
    assert.equal(f.store.getState().isAuthenticated, true)
    assert.equal(f.store.getState().tenantId, 't-b')
    assert.equal(f.store.getState().credentialEnterprise, '')
  } finally { f.close() }
})

test('选定的 tenant_id 优先于企业标识输入；返回的企业不一致时拒绝', async () => {
  const f = await launch()
  try {
    f.adapter.handlers.login = async () => ({ token: 'tok', claims: claims('t-other') })
    await assert.rejects(f.store.getState().login('acme', 'member', 'pw', 't-b'), /do not match/)
    assert.deepEqual(f.calls.map((c) => c.body), [{ tenant_id: 't-b', account: 'member', password: 'pw' }])
    assert.equal(f.store.getState().isAuthenticated, false)
  } finally { f.close() }
})

test('首次改密：未填企业标识时用 403 meta.tenant_id 定位企业完成改密', async () => {
  const f = await launch()
  try {
    f.adapter.handlers.login = async () => { throw problem(403, 'password_reset_required', { tenant_id: 't-r' }) }
    f.adapter.handlers.reset = async (body: any) => ({ token: 'tok', claims: claims(body.tenant_id) })
    assert.equal(await f.store.getState().login('', 'owner', 'old'), 'password_reset_required')
    assert.deepEqual(f.store.getState().pendingPasswordReset, { tenant_id: 't-r', account: 'owner' })

    await f.store.getState().resetPassword('old', 'New-pass-1')
    assert.deepEqual(f.calls.at(-1), { kind: 'reset', body: { tenant_id: 't-r', account: 'owner', old_password: 'old', new_password: 'New-pass-1' } })
    assert.equal(f.store.getState().isAuthenticated, true)
    assert.equal(f.store.getState().tenantId, 't-r')
  } finally { f.close() }
})

test('首次改密：企业服务没回传 tenant_id 时改密不带企业，由企业服务凭旧密码匹配', async () => {
  const f = await launch()
  try {
    f.adapter.handlers.login = async () => { throw problem(403, 'password_reset_required') }
    f.adapter.handlers.reset = async () => ({ token: 'tok', claims: claims('t-x') })
    assert.equal(await f.store.getState().login('', 'owner', 'old'), 'password_reset_required')
    await f.store.getState().resetPassword('old', 'New-pass-1')
    assert.deepEqual(f.calls.at(-1)?.body, { account: 'owner', old_password: 'old', new_password: 'New-pass-1' })
    assert.equal(f.store.getState().tenantId, 't-x')
  } finally { f.close() }
})
