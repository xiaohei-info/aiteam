import assert from 'node:assert/strict'
import test from 'node:test'
import { readConversationUsage } from '../src/lib/conversationUsage.ts'
import type { WorkHistoryEnvelope, WorkRecord } from '../src/api/agent/observations.types.ts'
const record = (id: string, conv: string, tokens: number | null) => ({
  id, conversation_id: conv, outcome: 'succeeded', usage: tokens === null ? null : { token_total: tokens },
}) as WorkRecord
const page = (data: WorkRecord[], next: string | null = null): WorkHistoryEnvelope => ({ data, page: { next_cursor: next, has_more: next !== null }, meta: { after: '' } })

test('累计消耗遍历分页，排除其他会话并去重工作记录', async () => {
  const cursors: (string | undefined)[] = []
  const result = await readConversationUsage('chat', async before => {
    cursors.push(before)
    return before ? page([record('one', 'chat', 20), record('two', 'chat', 40)])
      : page([record('one', 'chat', 20), record('other', 'elsewhere', 900)], 'next')
  })
  assert.deepEqual(cursors, [undefined, 'next'])
  assert.deepEqual(result, { tokens: 60, outcome: 'succeeded' })
})
test('未上报、部分缺失和真实零消耗有不同语义', async () => {
  assert.equal((await readConversationUsage('chat', async () => page([]))).tokens, null)
  assert.equal((await readConversationUsage('chat', async () => page([record('one', 'chat', 20), record('two', 'chat', null)]))).tokens, null)
  assert.equal((await readConversationUsage('chat', async () => page([record('one', 'chat', 0)]))).tokens, 0)
})
test('分页失败或循环游标不能呈现不完整的累计消耗', async () => {
  await assert.rejects(readConversationUsage('chat', async () => page([], 'loop')), /分页无效/)
  await assert.rejects(readConversationUsage('chat', async () => { throw new Error('offline') }), /offline/)
})
