import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AUTO_LOGIN_STORAGE_KEY } from '../src/lib/autoLogin.ts'

const require = createRequire(import.meta.url)
const { build } = await import(pathToFileURL(require.resolve('esbuild', { paths: [dirname(require.resolve('vite'))] })).href)

function claims(token: string) { return { user_id: token, tenant_id: 'tenant', roles: ['owner'] } }
function session(token: string) {
  return { token, claims: claims(token), tenantId: 'tenant', account: token, credentialEnterprise: 'acme' }
}
const SAVED = JSON.stringify({ enterprise: 'acme', account: 'saved', password: 'pw' })

// Bundle the real store (a fresh launch each time); only network and keychain are replaced.
async function launch({ autoLogin = true, saved = SAVED as string | null, storedSession = null as string | null } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'auto-login-store-'))
  const output = join(directory, 'store.cjs')
  await build({
    entryPoints: ['src/stores/agentAuth.ts'], outfile: output, bundle: true, platform: 'node', format: 'cjs',
    plugins: [{ name: 'adapters', setup(builder: any) {
      builder.onResolve({ filter: /^\.\.\/api\/(agent|backend)$/ }, () => ({ path: 'api', namespace: 'fake' }))
      builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'vault', namespace: 'fake' }))
      builder.onLoad({ filter: /.*/, namespace: 'fake' }, ({ path }: { path: string }) => ({ contents: path === 'api'
        ? `export class AgentApiClient { constructor(o) { this.o=o } request(r) { return globalThis.__autoLoginTest.request(r,this.o.getToken()) } logout() { return Promise.resolve() } }; export const backendApi = { login: (b) => globalThis.__autoLoginTest.login(b) };`
        : `export const invoke = (...args) => globalThis.__autoLoginTest.invoke(...args);` }))
    } }],
  })
  const vault = { value: storedSession }
  const logins: any[] = []
  const adapter = {
    request: async (r: any, token: string): Promise<unknown> => r.path.endsWith('whoami') ? claims(token) : {},
    login: async (body: any): Promise<unknown> => { logins.push(body); return { token: body.account, claims: claims(body.account) } },
    invoke: async (command: string, args?: any) => {
      if (command === 'secure_login_credentials_read') return saved
      if (command.startsWith('secure_login_credentials_')) return undefined
      if (command === 'secure_session_read') return vault.value
      if (command === 'secure_session_write') vault.value = args.session
      if (command === 'secure_session_delete') vault.value = null
    },
  }
  const storage = new Map<string, string>(autoLogin ? [[AUTO_LOGIN_STORAGE_KEY, 'true']] : [])
  ;(globalThis as any).__autoLoginTest = adapter
  ;(globalThis as any).localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  }
  ;(globalThis as any).window = { __TAURI_INTERNALS__: {}, addEventListener() {} }
  const store = (await import(pathToFileURL(output).href)).default.useAgentAuthStore
  // What App would route to on every store update, from the moment the launch starts.
  const screens: string[] = []
  store.subscribe((state: any) => {
    const screen = state.isAuthenticated ? 'app' : state.isConnecting ? 'connecting' : state.isRestoring ? 'restoring' : 'login'
    if (screens.at(-1) !== screen) screens.push(screen)
  })
  return {
    store, adapter, vault, logins, screens,
    close: () => {
      rmSync(directory, { recursive: true, force: true })
      delete (globalThis as any).window
      delete (globalThis as any).localStorage
    },
  }
}

test('auto login: goes from connecting straight into the app, never through the login page', async () => {
  const f = await launch()
  try {
    await f.store.getState().restoreSession()
    assert.equal(f.store.getState().isConnecting, true, 'still connecting until App starts the attempt')
    assert.equal(f.logins.length, 0, 'the attempt must wait for App to report the local Agent ready')

    await f.store.getState().runPendingAutoLogin()

    assert.deepEqual(f.screens, ['connecting', 'app'])
    assert.equal(f.store.getState().account, 'saved')
    assert.equal(f.store.getState().isConnecting, false)
    assert.deepEqual(f.logins.map(b => [b.enterprise, b.account, b.password]), [['acme', 'saved', 'pw']])
  } finally { f.close() }
})

test('auto login: the saved account is shown while connecting', async () => {
  const f = await launch()
  try {
    await f.store.getState().restoreSession()
    let seen: string | null = null
    f.adapter.login = async (body: any) => {
      seen = f.store.getState().connectingAccount
      return { token: body.account, claims: claims(body.account) }
    }
    await f.store.getState().runPendingAutoLogin()
    assert.equal(seen, 'saved')
    assert.equal(f.store.getState().connectingAccount, null)
  } finally { f.close() }
})

test('auto login: a failure lands on the login page and hands over the reason', async () => {
  const f = await launch()
  try {
    const failure = Object.assign(new Error('bad password'), { status: 401 })
    f.adapter.login = async () => { throw failure }
    await f.store.getState().restoreSession()
    await f.store.getState().runPendingAutoLogin()
    assert.deepEqual(f.screens, ['connecting', 'login'])
    assert.equal(f.store.getState().autoLoginFailure, failure)

    // The manual retry starts clean.
    f.adapter.login = async (body: any) => ({ token: body.account, claims: claims(body.account) })
    await f.store.getState().login('acme', 'saved', 'pw')
    assert.equal(f.store.getState().autoLoginFailure, null)
    assert.equal(f.store.getState().isAuthenticated, true)
  } finally { f.close() }
})

test('auto login: a required password change lands on the login page without an error', async () => {
  const f = await launch()
  try {
    f.adapter.login = async () => {
      throw Object.assign(new Error('reset'), { status: 403, problem: { code: 'forbidden', detail: 'password reset required' } })
    }
    await f.store.getState().restoreSession()
    await f.store.getState().runPendingAutoLogin()
    assert.equal(f.store.getState().isConnecting, false)
    assert.equal(f.store.getState().isAuthenticated, false)
    assert.equal(f.store.getState().autoLoginFailure, null)
    assert.equal(f.store.getState().pendingPasswordReset?.account, 'saved')
  } finally { f.close() }
})

test('auto login: concurrent triggers (React StrictMode) share a single attempt', async () => {
  const f = await launch()
  try {
    await f.store.getState().restoreSession()
    await Promise.all([f.store.getState().runPendingAutoLogin(), f.store.getState().runPendingAutoLogin()])
    assert.equal(f.logins.length, 1)
    assert.equal(f.store.getState().isAuthenticated, true)
  } finally { f.close() }
})

test('opted in but nothing saved: connecting ends on the login page, without an error', async () => {
  const f = await launch({ saved: null })
  try {
    await f.store.getState().restoreSession()
    await f.store.getState().runPendingAutoLogin()
    assert.deepEqual(f.screens, ['connecting', 'login'])
    assert.equal(f.store.getState().autoLoginFailure, null)
    assert.equal(f.logins.length, 0)
  } finally { f.close() }
})

test('not opted in and no saved session: goes to the login page without ever connecting', async () => {
  const f = await launch({ autoLogin: false })
  try {
    await f.store.getState().restoreSession()
    assert.deepEqual(f.screens, ['restoring', 'login'])
    assert.equal(f.logins.length, 0)
  } finally { f.close() }
})

test('a saved session connects silently even when auto login is off', async () => {
  const f = await launch({ autoLogin: false, storedSession: JSON.stringify(session('A')) })
  try {
    let during: any = null
    f.adapter.request = async (r: any, token: string) => {
      if (r.path.endsWith('whoami')) {
        during = f.store.getState()
        return claims(token)
      }
      return {}
    }
    await f.store.getState().restoreSession()
    assert.equal(during.isConnecting, true)
    assert.equal(during.connectingAccount, 'A')
    assert.equal(during.isAuthenticated, false, 'the session is not trusted until whoami confirms it')
    assert.equal(during.token, null)
    assert.deepEqual(f.screens, ['restoring', 'connecting', 'app'])
    assert.equal(f.store.getState().isConnecting, false)
    assert.equal(f.store.getState().connectingAccount, null)
  } finally { f.close() }
})

test('a rejected saved session falls back to auto login without showing the login page', async () => {
  const f = await launch({ storedSession: JSON.stringify(session('A')) })
  try {
    f.adapter.request = async (r: any, token: string) => {
      if (r.path.endsWith('whoami') && token === 'A') throw Object.assign(new Error('revoked'), { status: 401 })
      return r.path.endsWith('whoami') ? claims(token) : {}
    }
    await f.store.getState().restoreSession()
    await f.store.getState().runPendingAutoLogin()
    assert.deepEqual(f.screens, ['connecting', 'app'])
    assert.equal(f.store.getState().account, 'saved')
    assert.equal(f.store.getState().restoreError, null)
  } finally { f.close() }
})

test('a rejected saved session without auto login shows the login page with the restore error', async () => {
  const f = await launch({ autoLogin: false, storedSession: JSON.stringify(session('A')) })
  try {
    f.adapter.request = async () => { throw Object.assign(new Error('revoked'), { status: 401 }) }
    await f.store.getState().restoreSession()
    await f.store.getState().runPendingAutoLogin()
    assert.deepEqual(f.screens, ['restoring', 'connecting', 'login'])
    assert.ok(f.store.getState().restoreError)
    assert.equal(f.logins.length, 0)
  } finally { f.close() }
})

test('losing the session mid-run reconnects in place when the launch attempt is still unused', async () => {
  const f = await launch({ storedSession: JSON.stringify(session('A')) })
  try {
    await f.store.getState().restoreSession()
    assert.equal(f.store.getState().isAuthenticated, true)
    f.screens.length = 0

    await f.store.getState().logout({ reason: 'http_unauthorized', source: 'agent_http', status: 401 })
    assert.equal(f.store.getState().isConnecting, true)
    assert.equal(f.store.getState().connectingAccount, 'A')
    await f.store.getState().runPendingAutoLogin()

    assert.deepEqual(f.screens, ['app', 'connecting', 'app'])
    assert.equal(JSON.parse(f.vault.value!).token, 'saved')
  } finally { f.close() }
})

test('losing the session again after the attempt was used goes to the login page', async () => {
  const f = await launch()
  try {
    await f.store.getState().restoreSession()
    await f.store.getState().runPendingAutoLogin()
    f.screens.length = 0
    await f.store.getState().logout({ reason: 'http_unauthorized', source: 'agent_http', status: 401 })
    assert.deepEqual(f.screens, ['app', 'login'])
  } finally { f.close() }
})

test('an explicit logout goes straight to the login page and never reconnects', async () => {
  const f = await launch({ storedSession: JSON.stringify(session('A')) })
  try {
    await f.store.getState().restoreSession()
    f.screens.length = 0
    await f.store.getState().logout()
    assert.deepEqual(f.screens, ['app', 'login'])
    assert.equal(f.store.getState().connectingAccount, null)
    assert.equal(f.logins.length, 0)
  } finally { f.close() }
})

test('an explicit logout during the attempt wins over the pending login', async () => {
  const f = await launch()
  try {
    await f.store.getState().restoreSession()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    f.adapter.login = async (body: any) => { await gate; return { token: body.account, claims: claims(body.account) } }
    const attempt = f.store.getState().runPendingAutoLogin()
    await new Promise(resolve => setImmediate(resolve))
    await f.store.getState().logout()
    release()
    await attempt
    assert.equal(f.store.getState().isAuthenticated, false)
    assert.equal(f.store.getState().isConnecting, false)
    assert.equal(f.store.getState().token, null)
  } finally { f.close() }
})
