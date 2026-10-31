import assert from 'node:assert/strict'
import test from 'node:test'
import { attachWorkRecordIds, listEntries } from '../src/api/agent/conversations.ts'
import type { WorkRecord } from '../src/api/agent/observations.types.ts'
import type { AgentApiClient } from '../src/api/agent/client.ts'
import { entriesToMessages } from '../src/lib/piConverters.ts'
import type { ConversationEntry } from '../src/api/agent/types.ts'

const assistant = (id: string, workId: string | undefined, employee = 'pm', content: unknown = id): ConversationEntry => ({
  id, entry_ref: `ref-${id}`, type: 'message', work_id: workId,
  source_employee_id: employee, source_employee_display_name: employee,
  message: { role: 'assistant', content: content as never },
})
const tool = (id: string, workId: string, employee = 'pm'): ConversationEntry => ({
  ...assistant(id, workId, employee),
  message: { role: 'toolResult', toolCallId: 'todo', content: 'completed' },
})

test('one execution groups reasoning, todo updates and final text, retaining all entry references', () => {
  const entries = [
    assistant('plan', 'w1', 'pm', [{ type: 'thinking', thinking: 'plan' }, { type: 'toolCall', id: 'todo', name: 'todo_update' }]),
    tool('result', 'w1'),
    assistant('done', 'w1', 'pm', [{ type: 'thinking', thinking: 'done' }, { type: 'text', text: 'JD' }]),
  ]
  const messages = entriesToMessages([...entries, entries[2]])
  assert.equal(messages.length, 1)
  assert.equal(messages[0].workId, 'w1')
  assert.equal(messages[0].content, 'JD')
  assert.deepEqual(messages[0].thinkingSteps?.map(s => s.kind), ['reasoning', 'tool', 'reasoning'])
  assert.equal(messages[0].toolCalls?.[0].result, 'completed')
  assert.deepEqual(messages[0].entryRefs, ['ref-plan', 'ref-result', 'ref-done'])
})

test('interleaved participants and repeated executions of one employee remain separate', () => {
  const messages = entriesToMessages([
    assistant('a1', 'w1'), assistant('b1', 'w2', 'worker'),
    assistant('a2', 'w1'), assistant('a3', 'w3'), assistant('b2', 'w2', 'worker'),
  ])
  assert.deepEqual(messages.map(m => m.content), ['a1\n\na2', 'b1\n\nb2', 'a3'])
})

test('legacy entries remain separate and employee identity scopes work grouping', () => {
  const messages = entriesToMessages([
    assistant('old1', undefined), assistant('old2', undefined),
    assistant('new1', 'w'), assistant('new2', 'w', 'worker'),
  ])
  assert.equal(messages.length, 4)
})

test('user and employee transfer inputs are not swallowed into execution output', () => {
  const messages = entriesToMessages([
    { ...assistant('u', 'w'), source_type: 'human', message: { role: 'user', content: 'request' } },
    { ...assistant('delegation', 'w'), source_type: 'employee', source_id: 'pm', message: { role: 'user', content: 'delegate' } },
    assistant('answer', 'w'),
  ])
  assert.deepEqual(messages.map(m => [m.role, m.content, m.workId]), [
    ['user', 'request', undefined], ['assistant', 'delegate', undefined], ['assistant', 'answer', 'w'],
  ])
})

test('tool call IDs are scoped to the producing employee and execution', () => {
  const call = [{ type: 'toolCall', id: 'todo', name: 'todo_update' }]
  const messages = entriesToMessages([
    assistant('a', 'w1', 'pm', call), assistant('b', 'w2', 'worker', call),
    assistant('c', 'w3', 'pm', call), tool('result', 'w1'),
  ])
  assert.deepEqual(messages.map(m => m.toolCalls?.[0].result), ['completed', undefined, undefined])
})

const record = (id: string, input: string, output: string, employee = 'pm'): WorkRecord => ({
  id, conversation_id: 'c', employee_id: employee, provenance: 'live', outcome: 'succeeded',
  input_entry_ref: input, output_entry_ref: output,
} as WorkRecord)
const userEntry = (id: string): ConversationEntry => ({ id, entry_ref: `ref-${id}`, type: 'message', participant_employee_id: 'pm', message: { role: 'user', content: 'write JD' } })

test('deployed work API anchors group a completed reply without an entries work_id field', () => {
  const history = [userEntry('u'), assistant('plan', undefined, 'pm', [{ type: 'thinking', thinking: 'plan' }]), assistant('other', undefined, 'worker'), assistant('answer', undefined)]
  const annotated = attachWorkRecordIds(history, [record('w1', 'ref-u', 'ref-answer')], 'c')
  assert.deepEqual(annotated.map(e => e.work_id), [undefined, 'w1', undefined, 'w1'])
  assert.equal(history[1].work_id, undefined, 'source entries are not mutated')
  assert.equal(entriesToMessages(annotated).length, 3)
})

test('missing anchors, another conversation, inferred work and interrupted work are not guessed', () => {
  const history = [userEntry('u'), assistant('answer', undefined)]
  for (const work of [
    record('w', 'missing', 'ref-answer'),
    { ...record('w', 'ref-u', 'ref-answer'), conversation_id: 'other' },
    { ...record('w', 'ref-u', 'ref-answer'), provenance: 'pi_history' as const },
    { ...record('w', 'ref-u', 'ref-answer'), outcome: 'aborted' as const },
  ]) assert.equal(attachWorkRecordIds(history, [work], 'c')[1].work_id, undefined)
  const secondInput = [userEntry('u'), userEntry('u2'), assistant('answer', undefined)]
  assert.equal(attachWorkRecordIds(secondInput, [record('w', 'ref-u', 'ref-answer')], 'c')[2].work_id, undefined)
})

test('anchor overlap remains ungrouped and explicit work IDs remain authoritative', () => {
  const history = [userEntry('u'), assistant('answer', undefined)]
  assert.equal(attachWorkRecordIds(history, [record('a', 'ref-u', 'ref-answer'), record('b', 'ref-u', 'ref-answer')], 'c')[1].work_id, undefined)
  history[1].work_id = 'server-work'
  assert.equal(attachWorkRecordIds(history, [record('a', 'ref-u', 'ref-answer')], 'c')[1].work_id, 'server-work')
})

test('history loading enriches legacy responses across work pages and skips enrichment for new servers', async () => {
  const paths: string[] = []
  const history = [userEntry('u'), assistant('answer', undefined)]
  const client = { request: async (request: any) => {
    paths.push(request.path)
    if (request.path.endsWith('/entries')) return { data: { entries: history }, page: { has_more: false } }
    return request.query.before
      ? { data: [record('w', 'ref-u', 'ref-answer')], page: { has_more: false } }
      : { data: [], page: { has_more: true, next_cursor: 'older' } }
  } } as unknown as AgentApiClient
  assert.equal((await listEntries(client, 'c')).entries[1].work_id, 'w')
  assert.equal(paths.length, 3)
  paths.length = 0
  history[1].work_id = 'server-work'
  assert.equal((await listEntries(client, 'c')).entries[1].work_id, 'server-work')
  assert.equal(paths.length, 1)
})

test('unavailable work metadata does not prevent reading legacy messages', async () => {
  const client = { request: async (request: any) => {
    if (!request.path.endsWith('/entries')) throw new Error('work API unavailable')
    return { data: { entries: [userEntry('u'), assistant('answer', undefined)] }, page: { has_more: false } }
  } } as unknown as AgentApiClient
  assert.equal((await listEntries(client, 'c')).entries[1].message?.content, 'answer')
})
