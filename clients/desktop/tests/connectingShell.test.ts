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
const { MemoryRouter, useLocation } = require('react-router-dom')
const { build } = await import(pathToFileURL(require.resolve('esbuild', { paths: [dirname(require.resolve('vite'))] })).href)
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

// Real App, Layout and TopBar with a scriptable auth store; leaf screens render as named stubs.
const STUB = `import React from 'react';
const Stub = ({ children }) => React.createElement('div', { 'data-stub': __NAME__ }, children);
export default Stub;
export const useNetworkStatus = () => true;
export const useGlobalActivity = () => {};
export const createSafeDiagnostic = () => null;
export const classifyBackendStartupFailure = () => ({});
export const isBackendStartupConfigurationError = () => false;
export const initializeAgentRuntime = () => globalThis.__shellTest.backend();
export const isTauri = () => true;
export class AgentApiClient {}
export const useManagerReachability = Object.assign(
  () => false,
  { getState: () => ({ unavailable: false }), subscribe: () => () => {}, setState: () => {} },
);
export const MANAGER_UNAVAILABLE_NOTICE = '';
export const useTopBarOverrideValue = () => null;
export const isGlobalSearchShortcut = () => false;
export const requestGlobalSearch = () => {};
export const resolveTopBarRoute = (path) => ({ title: 'route:' + path, breadcrumbs: [] });
export const useChatStore = (select) => select(globalThis.__shellTest.chat);
export const useAgentAuthStore = Object.assign(
  (select) => { const [, force] = React.useReducer((n) => n + 1, 0);
    React.useEffect(() => globalThis.__shellTest.subscribe(force), []);
    return select(globalThis.__shellTest.auth); },
  { getState: () => globalThis.__shellTest.auth },
);`

async function bundle() {
  const dir = mkdtempSync(join(tmpdir(), 'connecting-shell-'))
  const outfile = join(dir, 'app.cjs')
  await build({
    entryPoints: ['src/App.tsx'], outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
    loader: { '.css': 'empty' },
    plugins: [{ name: 'stubs', setup(b: any) {
      b.onResolve({ filter: /^(react|react-dom|react-router-dom)(\/.*)?$/ }, (a: any) => ({ path: require.resolve(a.path), external: true }))
      b.onResolve({ filter: /^\.\.?\// }, (a: any) => {
        if (a.kind === 'entry-point' || /\.css$/.test(a.path)) return undefined
        if (a.path === './components/Layout') return undefined
        if (a.importer.endsWith('Layout/index.tsx') && a.path === './TopBar') return undefined
        return { path: a.path, namespace: 'stub' }
      })
      b.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }: { path: string }) => ({
        contents: STUB.replace('__NAME__', JSON.stringify(path.split('/').pop())), loader: 'js', resolveDir: process.cwd(),
      }))
    } }],
  })
  return { App: (await import(pathToFileURL(outfile).href)).default.default, close: () => rmSync(dir, { recursive: true, force: true }) }
}

function auth(overrides: Record<string, unknown> = {}) {
  return { isAuthenticated: false, isRestoring: false, isConnecting: false, sessionGeneration: 1, account: null, connectingAccount: null,
    restoreSession: async () => {}, runPendingAutoLogin: async () => {}, ...overrides }
}

async function mount(App: any, path: string, initial: Record<string, unknown>, backend: () => Promise<void> = async () => {}) {
  const listeners = new Set<() => void>()
  const calls = { load: 0, refresh: 0 }
  const harness = {
    auth: auth(initial),
    backend,
    chat: { loadAgentsAndConversations: () => { calls.load += 1 }, refreshConversations: async () => { calls.refresh += 1 } },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  ;(globalThis as any).__shellTest = harness
  ;(globalThis as any).window ??= { location: { pathname: path }, addEventListener() {}, removeEventListener() {} }
  ;(globalThis as any).document ??= { addEventListener() {}, removeEventListener() {}, hidden: false }
  let pathname = path
  const Probe = () => { pathname = useLocation().pathname; return null }
  let renderer: any
  await act(async () => {
    renderer = create(React.createElement(MemoryRouter, { initialEntries: [path] },
      React.createElement(App), React.createElement(Probe)))
    await tick()
  })
  return {
    calls,
    pathname: () => pathname,
    text: () => JSON.stringify(renderer.toJSON()),
    stubs: () => renderer.root.findAll((n: any) => n.props['data-stub']).map((n: any) => n.props['data-stub']),
    update: async (next: Record<string, unknown>) => {
      await act(async () => { harness.auth = { ...harness.auth, ...next }; listeners.forEach(l => l()); await tick() })
    },
    unmount: () => act(() => renderer.unmount()),
  }
}

const { App, close } = await bundle()
test.after(close)

test('connecting shows the workspace with "连接中..." instead of the login page', async () => {
  const view = await mount(App, '/', { isConnecting: true, isRestoring: true })
  try {
    assert.equal(view.pathname(), '/chat', 'the shell lands where the app will open')
    assert.ok(view.text().includes('连接中...'))
    assert.ok(view.stubs().includes('Sidebar'))
    assert.ok(view.stubs().includes('Panel'))
    assert.ok(!view.stubs().includes('Login'))
  } finally { view.unmount() }
})

test('no page content, dialogs or data requests run without a token', async () => {
  const view = await mount(App, '/chat', { isConnecting: true })
  try {
    for (const stub of ['Chat', 'ApprovalDialog', 'RechargePromptDialog', 'CommandPalette', 'OfficeRuntimeHost']) {
      assert.ok(!view.stubs().includes(stub), `${stub} must wait for login`)
    }
    assert.equal(view.calls.load, 0)
  } finally { view.unmount() }
})

test('finishing the connection mounts the page and loads data, and drops the indicator', async () => {
  const view = await mount(App, '/chat', { isConnecting: true })
  try {
    await view.update({ isConnecting: false, isAuthenticated: true })
    assert.ok(!view.text().includes('连接中...'))
    assert.ok(view.stubs().includes('Chat'))
    assert.equal(view.calls.load, 1)
  } finally { view.unmount() }
})

test('a failed connection redirects to the login page', async () => {
  const view = await mount(App, '/chat', { isConnecting: true })
  try {
    await view.update({ isConnecting: false })
    assert.equal(view.pathname(), '/login')
    assert.ok(view.stubs().includes('Login'))
    assert.ok(!view.text().includes('连接中...'))
  } finally { view.unmount() }
})

test('reconnecting from /login, as the retry button can, leaves the login page', async () => {
  const view = await mount(App, '/login', { isConnecting: true })
  try {
    assert.equal(view.pathname(), '/chat')
    assert.ok(!view.stubs().includes('Login'))
  } finally { view.unmount() }
})

test('a normal signed-out launch still shows the login page and no shell', async () => {
  const view = await mount(App, '/', {})
  try {
    assert.equal(view.pathname(), '/login')
    assert.ok(view.stubs().includes('Login'))
    assert.ok(!view.stubs().includes('Sidebar'))
  } finally { view.unmount() }
})

test('restoring with nothing to connect keeps the neutral restore screen', async () => {
  const view = await mount(App, '/', { isRestoring: true })
  try {
    assert.ok(view.text().includes('正在恢复登录状态'))
    assert.ok(!view.stubs().includes('Login'))
    assert.ok(!view.stubs().includes('Sidebar'))
  } finally { view.unmount() }
})

test('auto login starts only after the local Agent is ready and the restore has ended', async () => {
  let attempts = 0
  let backendReady!: () => void
  const backend = new Promise<void>(resolve => { backendReady = resolve })
  const runPendingAutoLogin = async () => { attempts += 1 }
  const view = await mount(App, '/chat', { isConnecting: true, isRestoring: true, runPendingAutoLogin }, () => backend)
  try {
    assert.equal(attempts, 0)
    assert.ok(view.stubs().includes('BackendStartupScreen'), 'the Agent startup screen still comes first')
    await act(async () => { backendReady(); await tick() })
    assert.equal(attempts, 0, 'restore still running')
    assert.ok(view.text().includes('连接中...'))
    await view.update({ isRestoring: false })
    assert.equal(attempts, 1)
  } finally { view.unmount() }
})
