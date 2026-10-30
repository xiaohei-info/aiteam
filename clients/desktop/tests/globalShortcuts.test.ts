import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GLOBAL_SHORTCUT_PRIORITY,
  GlobalShortcutRegistry,
  handleGlobalShortcut,
  resolveContextualNewAction,
  resolveGlobalShortcut,
  type GlobalShortcutKeyboardEvent,
} from '../src/lib/globalShortcuts.ts'

interface MockShortcutEvent extends GlobalShortcutKeyboardEvent {
  prevented: number
  stopped: number
}

function shortcutEvent(
  key: string,
  overrides: Partial<GlobalShortcutKeyboardEvent> = {},
): MockShortcutEvent {
  const event: MockShortcutEvent = {
    key,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    repeat: false,
    prevented: 0,
    stopped: 0,
    preventDefault() { event.prevented += 1 },
    stopPropagation() { event.stopped += 1 },
    ...overrides,
  }
  return event
}

test('global shortcut matcher accepts only exact Command/Ctrl N or W outside repeat and IME', () => {
  assert.equal(resolveGlobalShortcut(shortcutEvent('n')), 'new')
  assert.equal(resolveGlobalShortcut(shortcutEvent('N', { metaKey: false, ctrlKey: true })), 'new')
  assert.equal(resolveGlobalShortcut(shortcutEvent('w')), 'close')
  assert.equal(resolveGlobalShortcut(shortcutEvent('W', { metaKey: false, ctrlKey: true })), 'close')

  for (const event of [
    shortcutEvent('k'),
    shortcutEvent('1'),
    shortcutEvent('n', { metaKey: false }),
    shortcutEvent('n', { metaKey: true, ctrlKey: true }),
    shortcutEvent('n', { altKey: true }),
    shortcutEvent('n', { shiftKey: true }),
    shortcutEvent('n', { repeat: true }),
    shortcutEvent('n', { isComposing: true }),
    shortcutEvent('n', { keyCode: 229 }),
    shortcutEvent('n', { defaultPrevented: true }),
  ]) {
    assert.equal(resolveGlobalShortcut(event), null)
  }
})

test('contextual new matrix exposes only currently usable chat and group actions', () => {
  const allAvailable = { canCreateChat: true, canCreateGroup: true }
  assert.equal(resolveContextualNewAction('/chat', allAvailable), 'chat')
  assert.equal(resolveContextualNewAction('/chat/conversation-1', allAvailable), 'chat')
  assert.equal(resolveContextualNewAction('/group-chat', allAvailable), 'group')

  assert.equal(resolveContextualNewAction('/chat', { ...allAvailable, canCreateChat: false }), null)
  assert.equal(resolveContextualNewAction('/group-chat', { ...allAvailable, canCreateGroup: false }), null)
  for (const pathname of ['/tasks', '/knowledge', '/knowledge/kb-1', '/org', '/agents', '/talents', '/skills', '/mcp', '/settings', '/office', '/profile', '/login']) {
    assert.equal(resolveContextualNewAction(pathname, allAvailable), null, pathname)
  }
})

test('Command/Ctrl N consumes only a real action, ignores editors, and yields to overlays', () => {
  const registry = new GlobalShortcutRegistry()
  let created = 0
  registry.register({
    kind: 'new',
    priority: GLOBAL_SHORTCUT_PRIORITY.contextualNew,
    handler: () => { created += 1 },
  })
  const runtime = { registry, isTauri: false, closeTauriWindow: () => undefined }

  const commandN = shortcutEvent('n')
  assert.equal(handleGlobalShortcut(commandN, runtime), true)
  assert.equal(created, 1)
  assert.equal(commandN.prevented, 1)

  const editorN = shortcutEvent('n', { target: { tagName: 'INPUT' } as unknown as EventTarget })
  assert.equal(handleGlobalShortcut(editorN, runtime), false)
  assert.equal(created, 1)
  assert.equal(editorN.prevented, 0)

  const unregisterOverlay = registry.register({
    kind: 'close',
    priority: GLOBAL_SHORTCUT_PRIORITY.overlay,
    handler: () => undefined,
  })
  const layeredN = shortcutEvent('n')
  assert.equal(handleGlobalShortcut(layeredN, runtime), false)
  assert.equal(created, 1)
  assert.equal(layeredN.prevented, 0)
  unregisterOverlay()

  const noActionEvent = shortcutEvent('n')
  const emptyRuntime = { ...runtime, registry: new GlobalShortcutRegistry() }
  assert.equal(handleGlobalShortcut(noActionEvent, emptyRuntime), false)
  assert.equal(noActionEvent.prevented, 0)
})

test('close arbitration prefers overlay, then newest peer, then panel and cleans up idempotently', () => {
  const registry = new GlobalShortcutRegistry()
  const closed: string[] = []
  const unregisterPanel = registry.register({
    kind: 'close',
    priority: GLOBAL_SHORTCUT_PRIORITY.panel,
    handler: () => { closed.push('panel') },
  })
  const unregisterFirstOverlay = registry.register({
    kind: 'close',
    priority: GLOBAL_SHORTCUT_PRIORITY.overlay,
    handler: () => { closed.push('first-overlay') },
  })
  const unregisterTopOverlay = registry.register({
    kind: 'close',
    priority: GLOBAL_SHORTCUT_PRIORITY.overlay,
    handler: () => { closed.push('top-overlay') },
  })
  const runtime = { registry, isTauri: false, closeTauriWindow: () => undefined }

  assert.equal(handleGlobalShortcut(shortcutEvent('w'), runtime), true)
  assert.deepEqual(closed, ['top-overlay'])

  unregisterTopOverlay()
  unregisterTopOverlay()
  assert.equal(handleGlobalShortcut(shortcutEvent('w'), runtime), true)
  assert.deepEqual(closed, ['top-overlay', 'first-overlay'])

  unregisterFirstOverlay()
  assert.equal(handleGlobalShortcut(shortcutEvent('w'), runtime), true)
  assert.deepEqual(closed, ['top-overlay', 'first-overlay', 'panel'])

  unregisterPanel()
  assert.equal(registry.size, 0)
})

test('browser close shortcut is consumed without closing a tab; Tauri fallback handles failure', async () => {
  const browserEvent = shortcutEvent('w')
  let browserCloseCalls = 0
  assert.equal(handleGlobalShortcut(browserEvent, {
    registry: new GlobalShortcutRegistry(),
    isTauri: false,
    closeTauriWindow: () => { browserCloseCalls += 1 },
  }), true)
  assert.equal(browserEvent.prevented, 1)
  assert.equal(browserCloseCalls, 0)

  const expectedError = new Error('close rejected')
  let closeCalls = 0
  let reportedError: unknown
  handleGlobalShortcut(shortcutEvent('w'), {
    registry: new GlobalShortcutRegistry(),
    isTauri: true,
    closeTauriWindow: () => {
      closeCalls += 1
      return Promise.reject(expectedError)
    },
    onWindowCloseError: (error) => { reportedError = error },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(closeCalls, 1)
  assert.equal(reportedError, expectedError)
})
