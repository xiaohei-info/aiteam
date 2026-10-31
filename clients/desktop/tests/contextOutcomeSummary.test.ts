import assert from 'node:assert/strict'
import test from 'node:test'
import { editWindowText, emptyOutcomeDraft, endedSegmentMessages, isOutcomeDraftChanged, segmentSummary } from '../src/lib/contextOutcome.ts'
import { contextResetDividers } from '../src/lib/piConverters.ts'
import type { ContextSegment, ConversationEntry } from '../src/api/agent/types.ts'
import type { MessageAttachment } from '../src/stores/chat.ts'

const entry = (id: string, role: 'user' | 'assistant'): ConversationEntry => ({
  id, type: 'message', timestamp: '2026-10-30T10:00:00.000Z', message: { role, content: [{ type: 'text', text: id }] },
} as ConversationEntry)
const reset = (id: string, resetId: string): ConversationEntry => ({
  id, type: 'custom', customType: 'aiteam_context_reset', data: { reset_id: resetId, memory_reason: 'saved' },
})
const file = (id: string): MessageAttachment => ({ id, filename: `${id}.csv`, mime_type: 'text/csv' })
// 本地时间构造,测试不依赖时区。
const local = (month: number, day: number, hour: number, minute: number) => new Date(2026, month - 1, day, hour, minute)

test('ended segment is the messages between the previous divider and the given one', () => {
  const messages = ['m1', 'm2', 'm3', 'm4'].map((id) => ({ id }))
  const dividers = contextResetDividers([
    entry('m1', 'user'), entry('m2', 'assistant'), reset('r1', 'reset-1'),
    entry('m3', 'user'), entry('m4', 'assistant'), reset('r2', 'reset-2'),
  ])
  assert.deepEqual(endedSegmentMessages(messages, dividers, 'reset-1').map((m) => m.id), ['m1', 'm2'])
  assert.deepEqual(endedSegmentMessages(messages, dividers, 'reset-2').map((m) => m.id), ['m3', 'm4'], 'trailing divider')
  assert.deepEqual(endedSegmentMessages(messages, dividers, 'missing'), [])
})

test('segment summary shows the time range, server message count, files, memory and first question', () => {
  const summary = segmentSummary(
    { ended_at: local(10, 28, 14, 35).toISOString(), message_count: 6 },
    [
      { role: 'assistant', content: '你好，我是小策', _ts: local(10, 28, 14, 1).getTime() },
      { role: 'user', content: '  帮我把\n上周的投放数据   做个汇总 ', _ts: local(10, 28, 14, 2).getTime() },
      { role: 'assistant', content: '已汇总', attachments: [file('a'), file('b')] },
    ],
    '记忆已保存',
  )
  assert.equal(summary.range, '10/28 14:01–14:35')
  assert.deepEqual(summary.facts, ['6 条消息', '2 个文件', '记忆已保存'])
  assert.equal(summary.firstQuestion, '帮我把 上周的投放数据 做个汇总')
})

test('segment summary handles cross-day ranges, missing timestamps and long questions', () => {
  const crossDay = segmentSummary(
    { ended_at: local(10, 28, 0, 10).toISOString(), message_count: 2 },
    [{ role: 'user', content: '夜间任务', _ts: local(10, 27, 23, 50).getTime() }],
    null,
  )
  assert.equal(crossDay.range, '10/27 23:50 – 10/28 00:10')
  assert.deepEqual(crossDay.facts, ['2 条消息'])

  const long = '问'.repeat(100)
  const noTimes = segmentSummary({ ended_at: local(10, 28, 14, 35).toISOString(), message_count: 2 }, [{ role: 'user', content: long }], undefined)
  assert.equal(noTimes.range, '10/28 14:35 结束')
  assert.equal(noTimes.firstQuestion, `${'问'.repeat(80)}…`)
  assert.equal(segmentSummary({ ended_at: local(10, 28, 14, 35).toISOString(), message_count: 0 }, [], null).firstQuestion, null)
})

test('save is enabled only when the submitted evaluation would change', () => {
  const segment = (extra: Partial<ContextSegment>): ContextSegment => ({
    segment_id: 's1', conversation_id: 'c1', employee_ids: ['e1'], message_count: 2,
    outcome: 'unresolved', outcome_reasons: ['missing_info'], outcome_note: '缺数据', follow_up: false, revision: 1,
    ended_at: '2026-10-30T02:00:00.000Z', evaluated_at: '2026-10-30T02:00:00.000Z', editable_until: '2026-11-06T02:00:00.000Z',
    ...extra,
  })
  const unresolved = segment({})
  const same = { outcome: 'unresolved' as const, reasons: ['missing_info' as const], note: ' 缺数据 ', followUp: false }
  assert.equal(isOutcomeDraftChanged(unresolved, same), false, 'whitespace in the note is not a change')
  assert.equal(isOutcomeDraftChanged(unresolved, { ...same, followUp: true }), true)
  assert.equal(isOutcomeDraftChanged(unresolved, { ...same, outcome: 'resolved' }), true)

  const resolved = segment({ outcome: 'resolved', outcome_reasons: [], outcome_note: null })
  assert.equal(isOutcomeDraftChanged(resolved, { ...same, outcome: 'resolved' }), false, 'leftover reasons are not sent for resolved')
  assert.equal(isOutcomeDraftChanged(segment({ outcome: null }), emptyOutcomeDraft('resolved')), true, 'unevaluated segment')
})

test('edit window text counts down days, then hours, and is null once closed', () => {
  const now = Date.parse('2026-10-30T02:00:00.000Z')
  const until = (ms: number) => ({ editable_until: new Date(now + ms).toISOString() })
  assert.equal(editWindowText(until((5 * 24 + 1) * 3_600_000), now), '还可修改 5 天')
  assert.equal(editWindowText(until(3 * 3_600_000 + 60_000), now), '还可修改 3 小时')
  assert.equal(editWindowText(until(10 * 60_000), now), '还可修改不到 1 小时')
  assert.equal(editWindowText(until(-1), now), null)
  assert.equal(editWindowText({ editable_until: 'not a date' }, now), null)
})
