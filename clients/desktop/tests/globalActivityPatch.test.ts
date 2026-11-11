import assert from 'node:assert/strict'
import test from 'node:test'
import { patchActivityItem, type ActivityPatchOptions, type PromptSettledActivity } from '../src/lib/conversationActivityPatch.ts'

interface Item {
  id: string
  lastMessage: string
  time: string
  unread?: number
  lastMessageAt?: number
}

const item = (id: string, overrides: Partial<Item> = {}): Item => ({
  id,
  lastMessage: '旧摘要',
  time: '昨天',
  unread: 0,
  lastMessageAt: 1_000,
  ...overrides,
})

const settledEvent = (conversationId: string, overrides: Partial<PromptSettledActivity> = {}): PromptSettledActivity => ({
  type: 'prompt_settled',
  conversation_id: conversationId,
  employee_id: 'employee-1',
  tenant_id: 'tenant-1',
  member_id: 'member-1',
  outcome: 'succeeded',
  last_preview: '新摘要',
  last_message_at: '2026-11-11T06:00:30.000Z',
  assistant_message_count: 1,
  ...overrides,
})

const formatTime = (timestamp: number) => `t:${timestamp}`

function patch(items: readonly Item[], conversationId: string, isActive: boolean, event: PromptSettledActivity = settledEvent(conversationId)): Item[] {
  const options: ActivityPatchOptions = { conversationId, event, isActive, formatTime }
  return patchActivityItem(items, options)
}

test('活动信号补丁：更新摘要/时间/未读，并把该项提到最前', () => {
  const result = patch([item('a'), item('target'), item('b')], 'target', false)
  assert.equal(result[0]!.id, 'target')
  assert.equal(result[0]!.lastMessage, '新摘要')
  assert.equal(result[0]!.lastMessageAt, Date.parse('2026-11-11T06:00:30.000Z'))
  assert.equal(result[0]!.time, `t:${Date.parse('2026-11-11T06:00:30.000Z')}`)
  assert.equal(result[0]!.unread, 1)
  assert.equal(result[0]!.summaryAvailability, undefined)
  // 其他项相对顺序不变。
  assert.deepEqual(result.slice(1).map((entry) => entry.id), ['a', 'b'])
})

test('活动信号补丁：正在查看的会话未读清零，多轮回复按条数累加', () => {
  const items = [item('target', { unread: 3 })]
  const viewing = patch(items, 'target', true)
  assert.equal(viewing[0]!.unread, 0)

  const background = patch(items, 'target', false, settledEvent('target', { assistant_message_count: 2 }))
  assert.equal(background[0]!.unread, 5)
})

test('活动信号补丁：不存在的会话不改动列表', () => {
  const items = [item('a')]
  const result = patch(items, 'missing', false)
  assert.deepEqual(result, items)
})

test('活动信号补丁：摘要为空时保留原摘要，非法时间不动列表', () => {
  const items = [item('target', { lastMessage: '保留我', lastMessageAt: 5_000 })]
  const noPreview = patch(items, 'target', false, settledEvent('target', { last_preview: null }))
  assert.equal(noPreview[0]!.lastMessage, '保留我')

  const badTime = patch(items, 'target', false, settledEvent('target', { last_message_at: 'not-a-date' }))
  assert.deepEqual(badTime, items)
})
