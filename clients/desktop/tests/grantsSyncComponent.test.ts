import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
process.env.NODE_ENV = 'development'
const React = require('react')
const { act, create } = require('react-test-renderer')
const { build } = await import(pathToFileURL(require.resolve('esbuild', { paths: [dirname(require.resolve('vite'))] })).href)
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve!: (value: any) => void
  const promise = new Promise(a => { resolve = a })
  return { promise, resolve }
}

test('unavailable employee acknowledgement survives login, isolates accounts, and shows new events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grants-component-'))
  const outfile = join(dir, 'notice.cjs')
  await build({ entryPoints: ['src/components/GrantsSyncNotice.tsx'], outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
    plugins: [{ name: 'component-adapters', setup(b: any) {
      b.onResolve({ filter: /^react(?:\/.*)?$/ }, (a: any) => ({ path: require.resolve(a.path), external: true }))
      b.onResolve({ filter: /\.\.\/(stores\/agentAuth|api\/agent)$/ }, () => ({ path: 'adapters', namespace: 'fake' }))
      b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: `export const useAgentAuthStore = Object.assign(s => s(globalThis.__noticeTest.state), { getState: () => globalThis.__noticeTest.state }); export const agentApi = { listExperts: () => globalThis.__noticeTest.names() };` }))
      b.onResolve({ filter: /\.\.\/hooks\/use(DialogFocus|GlobalShortcut)$/ }, () => ({ path: 'hooks', namespace: 'fake-hooks' }))
      b.onLoad({ filter: /.*/, namespace: 'fake-hooks' }, () => ({ contents: `export const useDialogFocus = () => ({ current: null }); export const useGlobalShortcutClose = () => {};` }))
    } }],
  })
  const Notice = (await import(pathToFileURL(outfile).href)).default.default
  const oldNames = deferred(), newNames = deferred()
  const storage = new Map<string, string>()
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } })
  const employee = (id: string, revision = 'event-1') => ({ employee_id: id, display_name: id, status: 'archived', availability_revision: revision })
  const adapter = { state: { sessionGeneration: 1, grantsSyncSkipped: ['A'], tenantId: 't1', claims: { user_id: 'm1' } }, names: () => oldNames.promise }
  ;(globalThis as any).__noticeTest = adapter
  let renderer: any
  const view = () => React.createElement(Notice, { key: adapter.state.sessionGeneration })
  const text = () => JSON.stringify(renderer.toJSON())
  try {
    await act(async () => { renderer = create(view()); await tick() })
    await act(async () => { oldNames.resolve({ experts: [employee('A')] }); await tick() })
    assert.equal(renderer.root.findByProps({ role: 'dialog' }).props['aria-modal'], 'true')
    assert.equal(text().includes('已下架'), true)
    assert.equal(renderer.root.findAllByType('button').length, 1)
    act(() => { renderer.root.findByType('button').props.onClick() })
    assert.equal(renderer.toJSON(), null)
    adapter.state = { ...adapter.state, sessionGeneration: 2 }
    await act(async () => { renderer.update(view()); await tick() })
    assert.equal(renderer.toJSON(), null, 'acknowledgement must survive a new login and component remount')
    adapter.state = { ...adapter.state, sessionGeneration: 3, claims: { user_id: 'm2' } }
    adapter.names = () => newNames.promise
    await act(async () => { renderer.update(view()); await tick() })
    await act(async () => { newNames.resolve({ experts: [employee('A')] }); await tick() })
    assert.equal(text().includes('A'), true, 'another account must still see its notice')
    act(() => { renderer.root.findByType('button').props.onClick() })
    assert.equal(renderer.toJSON(), null)
    adapter.state = { ...adapter.state, sessionGeneration: 4 }
    adapter.names = async () => ({ experts: [employee('A', 'event-2')] })
    await act(async () => { renderer.update(view()); await tick() })
    assert.equal(renderer.root.findAllByType('button').length, 1, 'a new unavailability event must be shown')
  } finally {
    act(() => renderer?.unmount())
    rmSync(dir, { recursive: true, force: true })
    delete (globalThis as any).__noticeTest
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
