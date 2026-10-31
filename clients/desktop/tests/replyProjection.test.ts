import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeReplyProjection, reconcileReplyProjection, replyMatches } from '../src/lib/replyProjection.ts'
import type { Message } from '../src/stores/chat.ts'

const row = (id: string, employee: string | undefined, workId?: string): Message => ({
  id, role: 'assistant', msgType: 'text', time: '12:00', content: '',
  senderEmployeeId: employee, workId, entryRefs: workId ? [`ref-${id}`] : undefined,
  thinkingSteps: [{ kind: 'tool', tool: { id: 'call', name: 'bash', input: { command: 'pwd' } } }],
})

test('a work projection replaces all aliases, retains references and preserves unrelated row ordering', () => {
  const a = row('history', 'pm', 'w')
  const pending = { ...row('pending', 'pm', 'w'), _pending: true }
  const user: Message = { ...row('user', undefined), role: 'user', content: 'hello' }
  const other = row('other', 'engineer', 'w')
  const result = reconcileReplyProjection([user, a, other, pending], pending)
  assert.deepEqual(result.messages.map(m => m.id), ['user', 'pending', 'other'])
  assert(result.message.entryRefs?.includes('ref-history'))
  assert.equal(result.message.thinkingSteps?.length, 1)
})

test('tool identity never crosses employee, explicit execution or ambiguous work boundaries', () => {
  const pending = row('pending', 'pm')
  const first = row('one', 'pm', 'w1')
  const second = row('two', 'pm', 'w2')
  assert.equal(replyMatches([first, second], pending).length, 0)
  assert.equal(replyMatches([row('other', 'engineer', 'w1')], pending).length, 0)
  assert.equal(replyMatches([second], { ...pending, workId: 'w1' }).length, 0)
  assert.equal(replyMatches([first], pending).length, 1)
})

test('legacy or text-only messages are not assigned to works by text, name or timestamp', () => {
  const pending = { ...row('pending', 'pm'), content: 'same', thinkingSteps: [], senderName: 'same' }
  const history = { ...row('old', 'pm', 'w'), content: 'same', thinkingSteps: [], senderName: 'same' }
  assert.equal(reconcileReplyProjection([history], pending).messages.length, 2)
  assert.equal(replyMatches([row('legacy', 'pm')], row('pending', 'pm')).length, 0)
})

test('snapshot arguments do not erase existing tool results or duplicate tool steps', () => {
  const base = row('history', 'pm', 'w')
  base.thinkingSteps = [{ kind: 'reasoning', text: 'plan' }, { kind: 'tool', tool: { id: 'call', name: 'bash', result: 'ok' } }]
  const snapshot = row('active', 'pm', 'w')
  const once = mergeReplyProjection(base, snapshot)
  const twice = mergeReplyProjection(once, snapshot)
  assert.deepEqual(twice, once)
  assert.equal(twice.thinkingSteps?.length, 2)
  assert.equal(twice.toolCalls?.[0].result, 'ok')
})

test('current-round reasoning is not collapsed into an identical earlier round before a tool', () => {
  const base = row('history', 'pm', 'w')
  base.thinkingSteps = [{ kind: 'reasoning', text: 'inspect' }, ...base.thinkingSteps!]
  const snapshot = { ...row('active', 'pm', 'w'), thinkingSteps: [{ kind: 'reasoning' as const, text: 'inspect' }] }
  const once = mergeReplyProjection(base, snapshot, 'current-message')
  assert.deepEqual(once.thinkingSteps?.map(step => step.kind), ['reasoning', 'tool', 'reasoning'])
  assert.deepEqual(mergeReplyProjection(once, snapshot, 'current-message'), once)
})

test('a longer current-message snapshot extends the tail without repeating earlier paragraphs', () => {
  const base = { ...row('base', 'pm', 'w'), content: 'first\n\nsec' }
  const current = { ...row('active', 'pm', 'w'), content: 'second' }
  assert.equal(mergeReplyProjection(base, current).content, 'first\n\nsecond')
})
