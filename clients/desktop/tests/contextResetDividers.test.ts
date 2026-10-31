import assert from 'node:assert/strict'
import test from 'node:test'
import { contextResetDividers, contextResetMemoryText, contextResetPlacement, entriesToMessages } from '../src/lib/piConverters.ts'
import { confirmationReasonText, contextResetNotice, dividerMemoryText, isMemoryFailure } from '../src/lib/contextResetMemory.ts'
import type { ContextResetMemoryReason, ContextResetResult, ConversationEntry } from '../src/api/agent/types.ts'

const message = (id: string, role: 'user' | 'assistant', text: string): ConversationEntry => ({
  id,
  type: 'message',
  timestamp: '2026-10-26T10:00:00.000Z',
  message: { role, content: [{ type: 'text', text }] },
} as ConversationEntry)

const reset = (id: string, resetId: string, memoryReason: string = 'saved'): ConversationEntry => ({
  id,
  type: 'custom',
  customType: 'aiteam_context_reset',
  data: { reset_id: resetId, message_count: 2, memory_saved: memoryReason === 'saved', memory_reason: memoryReason },
})

test('context reset markers become a divider before the next message, not a message', () => {
  const entries = [message('m1', 'user', 'hi'), message('m2', 'assistant', 'hello'), reset('r1', 'reset-1'), message('m3', 'user', 'again')]
  const dividers = contextResetDividers(entries)
  assert.deepEqual([...dividers.before], [['m3', 'reset-1']])
  assert.equal(dividers.trailing, null)
  assert.deepEqual(entriesToMessages(entries).map(m => m.id), ['m1', 'm2', 'm3'])
})

test('group participants sharing one reset_id and resets with no new messages yield one trailing divider', () => {
  const entries = [message('m1', 'user', 'hi'), reset('a:r1', 'reset-1'), reset('b:r1', 'reset-1')]
  const dividers = contextResetDividers(entries)
  assert.deepEqual(dividers.before, new Map())
  assert.deepEqual(dividers.trailing, { resetId: 'reset-1', afterEntryRef: 'm1' })
  assert.deepEqual(dividers.memory.get('reset-1'), ['saved', 'saved'])
})

test('consecutive resets with different reset_ids collapse to the latest one', () => {
  const entries = [message('m1', 'user', 'hi'), reset('r1', 'reset-1'), reset('r2', 'reset-2'), message('m2', 'user', 'again')]
  assert.deepEqual([...contextResetDividers(entries).before], [['m2', 'reset-2']])
})

test('markers without data fall back to entry_ref, and a reset before any message anchors to the top', () => {
  const entries: ConversationEntry[] = [{ id: 'r1', entry_ref: 'conv:r1', type: 'custom', customType: 'aiteam_context_reset' }]
  const dividers = contextResetDividers(entries)
  assert.deepEqual(dividers.trailing, { resetId: 'conv:r1', afterEntryRef: null })
  assert.deepEqual(contextResetPlacement({ id: 'live-1' }, 0, dividers), { before: 'conv:r1', after: null })
  assert.deepEqual(contextResetPlacement({ id: 'live-2' }, 1, dividers), { before: null, after: null })
  assert.equal(contextResetMemoryText('conv:r1', dividers), null, 'old markers without memory_reason show no memory status')
})

test('placement matches merged entryRefs and keeps live messages below a trailing divider', () => {
  const entries = [message('m1', 'user', 'hi'), message('m2', 'assistant', 'hello'), reset('r1', 'reset-1')]
  const dividers = contextResetDividers(entries)
  assert.deepEqual(contextResetPlacement({ id: 'm1' }, 0, dividers), { before: null, after: null })
  assert.deepEqual(contextResetPlacement({ id: 'merged', entryRefs: ['m2'] }, 1, dividers), { before: null, after: 'reset-1' })
  assert.deepEqual(contextResetPlacement({ id: 'live' }, 2, dividers), { before: null, after: null })
})

test('other custom entries are ignored', () => {
  const entries: ConversationEntry[] = [{ id: 'c1', type: 'custom', customType: 'other' }, message('m1', 'user', 'hi')]
  const dividers = contextResetDividers(entries)
  assert.deepEqual(dividers.before, new Map())
  assert.equal(dividers.trailing, null)
  assert.equal(dividers.memory.size, 0)
})

test('dividers show whether memory was saved and why not', () => {
  const entries = [
    message('m1', 'user', 'hi'), reset('r1', 'reset-1', 'saved'),
    message('m2', 'user', 'two'), reset('r2', 'reset-2', 'timeout'),
    message('m3', 'user', 'three'), reset('a:r3', 'reset-3', 'saved'), reset('b:r3', 'reset-3', 'policy'),
    message('m4', 'user', 'four'), reset('r4', 'reset-4', 'not-a-reason'),
    message('m5', 'user', 'five'),
  ]
  const dividers = contextResetDividers(entries)
  assert.equal(contextResetMemoryText('reset-1', dividers), '记忆已保存')
  assert.equal(contextResetMemoryText('reset-2', dividers), '记忆未保存：记忆服务响应超时')
  assert.equal(contextResetMemoryText('reset-3', dividers), '部分成员记忆未保存：记忆策略不允许保存')
  assert.equal(contextResetMemoryText('reset-4', dividers), null, 'unknown reasons are not shown')
  assert.equal(dividerMemoryText(['error']), '记忆未保存：保存失败', 'markers written before reason codes were split')
})

const result = (participants: Array<{ reset: boolean; memory_reason: ContextResetMemoryReason; already_reset?: boolean }>, extra: Partial<ContextResetResult> = {}): ContextResetResult => ({
  conversation_id: 'c1',
  reset_id: 'reset-1',
  reset: participants.some(p => p.reset),
  already_reset: false,
  confirmation_required: participants.some(p => !p.reset && isMemoryFailure(p.memory_reason)),
  memory_saved: participants.some(p => p.memory_reason === 'saved'),
  participants: participants.map((p, i) => ({
    employee_id: `e${i}`, reset: p.reset, already_reset: p.already_reset ?? false, reset_id: p.reset ? 'reset-1' : null,
    message_count: 2, memory_saved: p.memory_reason === 'saved', memory_reason: p.memory_reason, operation_id: null,
  })),
  ...extra,
})

test('only transient failures ask for confirmation', () => {
  for (const reason of ['unauthorized', 'too_large', 'manager_unavailable', 'retention_unverified', 'timeout'] as const) assert.equal(isMemoryFailure(reason), true, reason)
  for (const reason of ['saved', 'empty', 'skipped', 'retain_disabled', 'policy', 'error'] as const) assert.equal(isMemoryFailure(reason), false, reason)
  const blocked = result([{ reset: false, memory_reason: 'timeout' }, { reset: false, memory_reason: 'manager_unavailable' }, { reset: true, memory_reason: 'saved' }])
  assert.equal(confirmationReasonText(blocked), '记忆服务响应超时、记忆服务暂不可用')
})

test('reset notices cover saved, unsaved, replay and nothing to reset', () => {
  assert.deepEqual(contextResetNotice(result([{ reset: true, memory_reason: 'saved' }])), { tone: 'ok', text: '已开启新上下文，关键记忆已提交保存。' })
  assert.deepEqual(contextResetNotice(result([{ reset: true, memory_reason: 'empty' }])), { tone: 'ok', text: '已开启新上下文。' })
  // 记忆未保存只在对话分隔线上提示，不弹顶部提示。
  assert.equal(contextResetNotice(result([{ reset: true, memory_reason: 'policy' }])), null)
  assert.equal(contextResetNotice(result([{ reset: true, memory_reason: 'timeout' }])), null)
  assert.deepEqual(contextResetNotice(result([{ reset: true, memory_reason: 'saved', already_reset: true }], { already_reset: true })), { tone: 'ok', text: '已经是新上下文，无需重复开启。' })
  assert.deepEqual(contextResetNotice(result([{ reset: false, memory_reason: 'empty' }])), { tone: 'warn', text: '当前没有可重置的上下文。' })
})
