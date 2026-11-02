import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  NOTIFICATION_TARGET_SOURCE,
  NOTIFICATION_TARGET_VERSION,
  activateNotificationTarget,
  buildCompletionNotificationCopy,
  buildNotificationStorageKey,
  buildNotificationTarget,
  parseNotificationPreference,
  parseNotificationTarget,
  readNotificationPreference,
  readNotificationPreferenceResult,
  resolveNotificationNavigation,
  shouldSendCompletionNotification,
  writeNotificationPreference,
  type NotificationStorage,
} from '../src/lib/notificationPolicy.ts'

class MemoryNotificationStorage implements NotificationStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

const target = buildNotificationTarget('chat', 'conv_123')!

test('notification preference defaults off and accepts only the explicit enabled value', () => {
  for (const value of [null, undefined, '', 'true', 'on', true, 1, {}]) {
    assert.equal(parseNotificationPreference(value), 'disabled')
  }
  assert.equal(parseNotificationPreference('disabled'), 'disabled')
  assert.equal(parseNotificationPreference('enabled'), 'enabled')
})

test('notification preference is account scoped and storage failures remain disabled', () => {
  const key = buildNotificationStorageKey({ tenantId: 'tenant/a', memberId: 'member 1' })
  assert.equal(key, 'aifred.notifications.v1:tenant%2Fa:member%201')
  assert.equal(buildNotificationStorageKey({ tenantId: null, memberId: 'member' }), null)

  const storage = new MemoryNotificationStorage()
  assert.equal(readNotificationPreference(key, storage), 'disabled')
  assert.equal(writeNotificationPreference(key, 'enabled', storage), true)
  assert.equal(readNotificationPreference(key, storage), 'enabled')
  storage.values.set(key!, 'corrupt')
  assert.equal(readNotificationPreference(key, storage), 'disabled')
  assert.deepEqual(readNotificationPreferenceResult(key, storage), {
    preference: 'disabled',
    status: 'invalid',
  })

  const unavailable: NotificationStorage = {
    getItem() { throw new Error('unavailable') },
    setItem() { throw new Error('unavailable') },
  }
  assert.equal(readNotificationPreference(key, unavailable), 'disabled')
  assert.deepEqual(readNotificationPreferenceResult(key, unavailable), {
    preference: 'disabled',
    status: 'unavailable',
  })
  assert.equal(writeNotificationPreference(key, 'enabled', unavailable), false)
})

test('notification target accepts only versioned chat identifiers and never arbitrary URLs', () => {
  assert.deepEqual(target, {
    source: NOTIFICATION_TARGET_SOURCE,
    version: NOTIFICATION_TARGET_VERSION,
    kind: 'chat',
    conversationId: 'conv_123',
  })
  assert.equal(buildNotificationTarget('chat', 'https://evil.example/path'), null)
  assert.equal(buildNotificationTarget('group', '../settings'), null)
  assert.equal(parseNotificationTarget({ ...target, source: 'other-app' }), null)
  assert.equal(parseNotificationTarget({ ...target, version: 2 }), null)
})

test('notification navigation resolves only conversations already present in the chat store', () => {
  assert.deepEqual(resolveNotificationNavigation(target, ['conv_123'], ['group_1']), {
    path: '/chat',
    conversationId: 'conv_123',
    kind: 'chat',
  })
  assert.deepEqual(
    resolveNotificationNavigation(buildNotificationTarget('group', 'group_1'), ['conv_123'], ['group_1']),
    { path: '/group-chat', conversationId: 'group_1', kind: 'group' },
  )
  assert.equal(resolveNotificationNavigation(target, [], ['conv_123']), null)
  assert.equal(resolveNotificationNavigation({ url: 'https://evil.example' }, ['conv_123'], []), null)
})

test('notification activation mutates only a validated existing target and uses fixed chat routes', () => {
  const calls: string[] = []
  const actions = {
    setActiveConversation: (id: string) => calls.push(`chat:${id}`),
    setActiveGroup: (id: string) => calls.push(`group:${id}`),
    navigate: (path: '/chat' | '/group-chat') => calls.push(`navigate:${path}`),
  }

  assert.equal(activateNotificationTarget(target, ['conv_123'], [], actions), true)
  assert.deepEqual(calls, ['chat:conv_123', 'navigate:/chat'])

  calls.length = 0
  assert.equal(activateNotificationTarget({ ...target, conversationId: 'missing' }, ['conv_123'], [], actions), false)
  assert.equal(activateNotificationTarget({ url: 'https://evil.example' }, ['conv_123'], [], actions), false)
  assert.deepEqual(calls, [])
})

test('completion notification is conservative and suppresses the visible current conversation', () => {
  const context = {
    preference: 'enabled' as const,
    permissionGranted: true,
    isTauriRuntime: true,
    documentVisible: true,
    windowFocused: true,
    pathname: '/chat',
    activeConversationId: 'conv_123',
    activeGroupId: '',
    target,
  }

  assert.equal(shouldSendCompletionNotification(context), false)
  assert.equal(shouldSendCompletionNotification({ ...context, windowFocused: false }), true)
  assert.equal(shouldSendCompletionNotification({ ...context, pathname: '/settings' }), true)
  assert.equal(shouldSendCompletionNotification({ ...context, preference: 'disabled' }), false)
  assert.equal(shouldSendCompletionNotification({ ...context, permissionGranted: false }), false)
  assert.equal(shouldSendCompletionNotification({ ...context, isTauriRuntime: false }), false)
})

test('notification copy contains no request, conversation title, or model response content', () => {
  assert.deepEqual(buildCompletionNotificationCopy('chat'), {
    title: 'AIFred 任务已结束',
    body: 'AI 员工已完成回复，返回应用查看结果。',
  })
  assert.deepEqual(buildCompletionNotificationCopy('group'), {
    title: 'AIFred 协作已结束',
    body: '群聊中有新的 AI 消息，返回应用查看结果。',
  })
})

test('notification integration keeps permissions minimal and requests access only from Settings', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const cargoToml = readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8')
  const capability = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'))
  const rustSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  const settingsSource = readFileSync(new URL('../src/pages/Settings/index.tsx', import.meta.url), 'utf8')
  const notificationSource = readFileSync(new URL('../src/lib/systemNotifications.ts', import.meta.url), 'utf8')
  const chatSource = readFileSync(new URL('../src/stores/chat.ts', import.meta.url), 'utf8')

  assert.equal(packageJson.dependencies['@tauri-apps/plugin-notification'], '^2.8.0')
  assert.match(cargoToml, /^tauri-plugin-notification = "2"$/m)
  assert.match(rustSource, /\.plugin\(tauri_plugin_notification::init\(\)\)/)
  assert.deepEqual(
    capability.permissions.filter((permission: unknown) =>
      typeof permission === 'string' && permission.startsWith('notification:'),
    ).sort(),
    [
      'notification:allow-is-permission-granted',
      'notification:allow-notify',
      'notification:allow-request-permission',
    ],
  )
  assert.doesNotMatch(JSON.stringify(capability), /notification:default|notification:allow-register-listener/)
  assert.match(settingsSource, /handleEnableNotifications[\s\S]*requestSystemNotificationPermission\(\)/)
  assert.doesNotMatch(notificationSource, /import\s*\{[^}]*\b(?:onAction|registerActionTypes)\b[^}]*\}/)
  assert.doesNotMatch(notificationSource, /window\.Notification/)

  const finalizationGuard = chatSource.indexOf('if (!sub.generating) return')
  const notifyCall = chatSource.indexOf('void notifyConversationCompleted({')
  assert.ok(finalizationGuard >= 0 && notifyCall > finalizationGuard)
})
