import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  LEGACY_PINNED_STORAGE_KEY,
  getPinnedStorageKey,
  loadPinnedConversations,
  migratePinnedConversationId,
  savePinnedConversations,
  type PinnedStorage,
} from '../src/lib/pinnedConversations.ts'

class MemoryStorage implements PinnedStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

test('置顶存储 key 按租户和账号隔离，未登录不读写账号数据', () => {
  const accountAKey = getPinnedStorageKey({
    isAuthenticated: true,
    tenantId: 'tenant/acme',
    memberId: 'member+a',
  })
  const accountBKey = getPinnedStorageKey({
    isAuthenticated: true,
    tenantId: 'tenant/acme',
    memberId: 'member+b',
  })

  assert.notEqual(accountAKey, accountBKey)
  assert.match(accountAKey ?? '', /tenant%2Facme:member%2Ba$/)
  assert.equal(getPinnedStorageKey({ isAuthenticated: false, tenantId: 'tenant', memberId: 'member' }), null)

  const storage = new MemoryStorage()
  savePinnedConversations(storage, accountAKey, { 'conv-a': '2026-09-07T01:00:00.000Z' })
  savePinnedConversations(storage, accountBKey, { 'conv-b': '2026-09-07T02:00:00.000Z' })
  assert.deepEqual(loadPinnedConversations(storage, accountAKey), { 'conv-a': '2026-09-07T01:00:00.000Z' })
  assert.deepEqual(loadPinnedConversations(storage, accountBKey), { 'conv-b': '2026-09-07T02:00:00.000Z' })
})

test('全局旧置顶只迁移给首个恢复账号，后续账号不会串数据', () => {
  const storage = new MemoryStorage()
  const accountAKey = getPinnedStorageKey({ isAuthenticated: true, tenantId: 'tenant', memberId: 'a' })
  const accountBKey = getPinnedStorageKey({ isAuthenticated: true, tenantId: 'tenant', memberId: 'b' })
  storage.setItem(LEGACY_PINNED_STORAGE_KEY, JSON.stringify({ legacy: '2026-09-07T01:00:00.000Z' }))

  assert.deepEqual(loadPinnedConversations(storage, accountAKey), {
    legacy: '2026-09-07T01:00:00.000Z',
  })
  assert.equal(storage.getItem(LEGACY_PINNED_STORAGE_KEY), null)
  assert.deepEqual(loadPinnedConversations(storage, accountBKey), {})
})

test('占位会话升级时迁移置顶时间且不修改原对象', () => {
  const original = {
    emp_worker: '2026-09-07T01:00:00.000Z',
    other: '2026-09-07T00:00:00.000Z',
  }
  const migrated = migratePinnedConversationId(original, 'emp_worker', 'conversation-1')

  assert.deepEqual(migrated, {
    'conversation-1': '2026-09-07T01:00:00.000Z',
    other: '2026-09-07T00:00:00.000Z',
  })
  assert.equal(original.emp_worker, '2026-09-07T01:00:00.000Z')
})

test('服务端契约未提供 pinned_at 时置顶仅保存为本机账号偏好', () => {
  const typesSource = readFileSync(new URL('../src/api/agent/types.ts', import.meta.url), 'utf8')
  const chatSource = readFileSync(new URL('../src/stores/chat.ts', import.meta.url), 'utf8')

  const metadataBody = typesSource.match(
    /export interface ConversationMetadata \{([\s\S]*?)\n\}/,
  )?.[1]
  const updateBody = typesSource.match(
    /export interface ConversationUpdateRequest \{([\s\S]*?)\n\}/,
  )?.[1]
  const toggleBody = chatSource.match(
    /togglePinConversation: \(convId\) => \{([\s\S]*?)\n {2}\},\n\}\)\)/,
  )?.[1]

  assert.ok(metadataBody)
  assert.ok(updateBody)
  assert.ok(toggleBody)
  assert.doesNotMatch(metadataBody, /pinned_at/)
  assert.doesNotMatch(updateBody, /pinned_at/)
  assert.match(toggleBody, /savePinnedToStorage\(next\)/)
  assert.doesNotMatch(toggleBody, /agentApi\.|updateConversation|PATCH/)
})
