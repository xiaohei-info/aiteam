import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const require = createRequire(import.meta.url)
const { build } = require(require.resolve('esbuild', { paths: [dirname(require.resolve('vite'))] }))
function deferred() {
  let resolve!: (value?: unknown) => void
  let reject!: (error: Error) => void
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

// Bundle the real store while replacing only its network and credential adapters.
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'grants-store-'))
  const output = join(directory, 'store.cjs')
  await build({
    entryPoints: ['src/stores/agentAuth.ts'], outfile: output, bundle: true, platform: 'node', format: 'cjs',
    plugins: [{ name: 'adapters', setup(builder: any) {
      builder.onResolve({ filter: /^\.\.\/api\/(agent|backend)$/ }, () => ({ path: 'api', namespace: 'fake' }))
      builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'vault', namespace: 'fake' }))
      builder.onLoad({ filter: /.*/, namespace: 'fake' }, ({ path }: { path: string }) => ({ contents: path === 'api'
        ? `export class AgentApiClient { constructor(o) { this.o=o } request(r) { return globalThis.__grantsTest.request(r,this.o.getToken()) } }; export const backendApi = {};`
        : `export const invoke = (...args) => globalThis.__grantsTest.invoke(...args);` }))
    } }],
  })
  const vault = { value: null as string | null }
  const adapter = {
    request: async (r: any, token: string) => r.path.endsWith('whoami') ? claims(token) : {},
    invoke: async (command: string, args?: any) => {
      if (command === 'secure_session_read') return vault.value
      if (command === 'secure_session_write') vault.value = args.session
      if (command === 'secure_session_delete') vault.value = null
    },
  }
  ;(globalThis as any).__grantsTest = adapter
  ;(globalThis as any).window = { __TAURI_INTERNALS__: {}, addEventListener() {} }
  const store = require(output).useAgentAuthStore
  return { store, adapter, vault, close: () => { rmSync(directory, { recursive: true, force: true }); delete (globalThis as any).window } }
}
function claims(token: string) { return { user_id: token, tenant_id: 'tenant', roles: ['owner'] } }
function session(token: string) { return { token, claims: claims(token), tenantId: 'tenant', account: token } }

for (const operation of ['login', 'restore']) {
  test(`${operation}: logout during sync prevents stale token and vault writes`, async () => {
    const f = await fixture()
    try {
      const started = deferred(), response = deferred()
      f.adapter.request = async (r, token) => {
        if (r.path.endsWith('whoami')) return claims(token)
        if (r.path.endsWith('/sync')) { started.resolve(); return response.promise }
        return { runtime: 'ready' }
      }
      if (operation === 'restore') f.vault.value = JSON.stringify(session('A'))
      const pending = operation === 'restore' ? f.store.getState().restoreSession() : f.store.getState().setSession(session('A'))
      await started.promise
      const logout = f.store.getState().logout()
      response.resolve({ ok: true, partial: true, skipped_employee_ids: ['A-old'] })
      await Promise.all([pending, logout])
      assert.equal(f.store.getState().isAuthenticated, false)
      assert.equal(f.store.getState().token, null)
      assert.deepEqual(f.store.getState().grantsSyncSkipped, [])
      assert.equal(f.vault.value, null)
    } finally { f.close() }
  })
}

test('new login supersedes an older sync and owns the vault', async () => {
  const f = await fixture()
  try {
    const started = deferred(), response = deferred()
    f.adapter.request = async (r, token) => {
      if (r.path.endsWith('whoami')) return claims(token)
      if (r.path.endsWith('/sync')) {
        if (token === 'A') { started.resolve(); return response.promise }
        return { ok: true, partial: true, skipped_employee_ids: ['B-old'] }
      }
      return { runtime: 'ready' }
    }
    const old = f.store.getState().setSession(session('A'))
    await started.promise
    await f.store.getState().setSession(session('B'))
    response.resolve({ ok: true, partial: true, skipped_employee_ids: ['A-old'] })
    await old
    assert.equal(f.store.getState().token, 'B')
    assert.deepEqual(f.store.getState().grantsSyncSkipped, ['B-old'])
    assert.equal(JSON.parse(f.vault.value!).token, 'B')
  } finally { f.close() }
})

for (const fails of [false, true]) {
  test(`retry ${fails ? 'failure' : 'success'} after logout and reuse of the same token is discarded`, async () => {
    const f = await fixture()
    try {
      const started = deferred(), response = deferred()
      let delayed = false
      f.adapter.request = async (r, token) => {
        if (r.path.endsWith('whoami')) return claims(token)
        if (r.path.endsWith('/sync')) {
          if (delayed) { started.resolve(); return response.promise }
          return { ok: true, partial: true, skipped_employee_ids: ['current'] }
        }
        return { runtime: 'ready' }
      }
      await f.store.getState().setSession(session('A'))
      delayed = true
      const old = f.store.getState().retryGrantsSync()
      await started.promise
      await f.store.getState().logout()
      delayed = false
      await f.store.getState().setSession(session('A'))
      if (fails) response.reject(new Error('old failure'))
      else response.resolve({ ok: true })
      await old
      assert.deepEqual(f.store.getState().grantsSyncSkipped, ['current'])
    } finally { f.close() }
  })
}

test('same-session retry failure retains the list and successful retry clears it', async () => {
  const f = await fixture()
  try {
    let mode = 'partial'
    f.adapter.request = async (r, token) => {
      if (r.path.endsWith('whoami')) return claims(token)
      if (r.path.endsWith('/sync')) {
        if (mode === 'fail') throw new Error('offline')
        return { ok: true, partial: mode === 'partial', skipped_employee_ids: mode === 'partial' ? ['e1'] : [] }
      }
      return { runtime: 'ready' }
    }
    await f.store.getState().setSession(session('A'))
    mode = 'fail'
    await assert.rejects(f.store.getState().retryGrantsSync())
    assert.deepEqual(f.store.getState().grantsSyncSkipped, ['e1'])
    mode = 'complete'
    await f.store.getState().retryGrantsSync()
    assert.deepEqual(f.store.getState().grantsSyncSkipped, [])
  } finally { f.close() }
})
