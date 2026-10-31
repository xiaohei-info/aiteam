import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { ConversationMetadata } from '../src/api/agent/types.ts'
import { formatConversationTime, resolveConversationSummary } from '../src/lib/conversationSummary.ts'

function conversation(overrides: Partial<ConversationMetadata> = {}): ConversationMetadata {
  return {
    id: 'conversation-1',
    title: '会话',
    kind: 'chat',
    labels: [],
    state: 'active',
    entry_employee_id: 'employee-1',
    coordinator_employee_id: null,
    solution_instance_id: null,
    schedule: null,
    permission_mode: 'read-only',
    last_read_entry_id: null,
    created_at: '2026-09-08T08:00:00Z',
    updated_at: '2026-09-08T09:00:00Z',
    ...overrides,
  }
}

test('conversation summary consumes only authoritative server metadata', () => {
  const preview = '这是一段超过二十个字符的服务端真实会话摘要内容，用于验证截断'
  const summary = resolveConversationSummary(conversation({
    last_preview: preview,
    unread_count: 3,
    last_message_at: '2026-09-08T08:30:00Z',
  }))

  assert.equal(summary.preview, preview.slice(0, 20))
  assert.equal(summary.unreadCount, 3)
  assert.equal(summary.lastMessageAt, Date.parse('2026-09-08T08:30:00Z'))
  assert.deepEqual(summary.availability, {
    preview: true,
    unreadCount: true,
    lastMessageAt: true,
  })
})

test('missing summary fields stay unavailable and never fall back to updated_at', () => {
  const summary = resolveConversationSummary(conversation())

  assert.equal(summary.preview, '')
  assert.equal(summary.unreadCount, undefined)
  assert.equal(summary.lastMessageAt, undefined)
  assert.deepEqual(summary.availability, {
    preview: false,
    unreadCount: false,
    lastMessageAt: false,
  })
})

test('explicit null preview and message time mean a known empty conversation', () => {
  const summary = resolveConversationSummary(conversation({
    last_preview: null,
    unread_count: 0,
    last_message_at: null,
  }))

  assert.equal(summary.preview, '')
  assert.equal(summary.unreadCount, undefined)
  assert.equal(summary.lastMessageAt, undefined)
  assert.deepEqual(summary.availability, {
    preview: true,
    unreadCount: true,
    lastMessageAt: true,
  })
})

test('旧消息有摘要但无有效时间时不清除摘要、不使用元数据更新时间', () => {
  const summary = resolveConversationSummary(conversation({
    last_preview: '保留的历史消息',
    unread_count: 1,
    last_message_at: null,
  }))
  assert.equal(summary.preview, '保留的历史消息')
  assert.equal(summary.unreadCount, 1)
  assert.equal(summary.lastMessageAt, undefined)
  assert.equal(summary.availability.lastMessageAt, true)
})

test('改名和已读更新不改变服务端权威消息时间', () => {
  const original = conversation({
    last_preview: '你好',
    unread_count: 1,
    last_message_at: '2026-09-08T08:30:00Z',
  })
  const changed = { ...original, title: '新名称', last_read_entry_id: 'entry-read',
    unread_count: 0, updated_at: '2026-10-08T12:00:00Z' }
  assert.equal(resolveConversationSummary(changed).lastMessageAt,
    resolveConversationSummary(original).lastMessageAt)
})

test('message time always includes hours and minutes, never seconds', () => {
  const now = new Date(2026, 9, 7, 12, 30)
  assert.equal(formatConversationTime(new Date(2026, 9, 7, 9, 5, 59).getTime(), now), '09:05')
  assert.equal(formatConversationTime(new Date(2026, 9, 6, 23, 59).getTime(), now), '昨天 23:59')
  assert.equal(formatConversationTime(new Date(2026, 9, 5, 8, 7).getTime(), now), '10-05 08:07')
  assert.equal(formatConversationTime(new Date(2025, 9, 5, 16, 30).getTime(), now), '2025-10-05 16:30')
  assert.equal(formatConversationTime(new Date(2026, 9, 5).getTime(), now), '10-05 00:00')
  for (const value of [undefined, null, NaN, Infinity]) assert.equal(formatConversationTime(value, now), '')
  const invalid = resolveConversationSummary(conversation({ last_message_at: 'invalid' }))
  assert.equal(invalid.lastMessageAt, undefined)
  assert.equal(invalid.availability.lastMessageAt, false)
})

test('yesterday retains minutes across month and year boundaries', () => {
  assert.equal(formatConversationTime(new Date(2026, 8, 30, 23, 5).getTime(),
    new Date(2026, 9, 1, 0, 1)), '昨天 23:05')
  assert.equal(formatConversationTime(new Date(2025, 11, 31, 23, 59).getTime(),
    new Date(2026, 0, 1, 0, 1)), '昨天 23:59')
})

test('active Agent chat flow does not calculate preview or SSE unread locally', () => {
  const storeSource = readFileSync(new URL('../src/stores/chat.ts', import.meta.url), 'utf8')
  const chatSource = readFileSync(new URL('../src/pages/Chat/index.tsx', import.meta.url), 'utf8')
  const groupChatSource = readFileSync(new URL('../src/pages/GroupChat/index.tsx', import.meta.url), 'utf8')
  const panelSource = readFileSync(new URL('../src/components/Layout/Panel.tsx', import.meta.url), 'utf8')

  assert.doesNotMatch(storeSource, /updateConvPreview/)
  assert.doesNotMatch(chatSource, /updateConvPreview|bumpUnread/)
  assert.doesNotMatch(groupChatSource, /updateConvPreview|bumpUnread/)
  assert.match(storeSource, /resolveConversationSummary\(c\)/)
  assert.doesNotMatch(storeSource, /time:\s*c\.updated_at/)
  assert.match(panelSource, /摘要未提供/)
  const unreadBadgeSource = readFileSync(new URL('../src/components/Layout/ConversationUnreadBadge.tsx', import.meta.url), 'utf8')
  assert.match(panelSource, /<ConversationUnreadBadge conversation=\{conv\}/)
  assert.match(panelSource, /<ConversationUnreadBadge conversation=\{group\}/)
  assert.match(unreadBadgeSource, /未读数量未提供/)
  assert.match(panelSource, /时间未提供/)
})
