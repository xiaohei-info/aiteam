import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canEditSegment, contextOutcomeNotice, contextResetFinishedNotice, contextResetRequest, currentSegmentMessages, dividerOutcome, emptyOutcomeDraft,
  isOutcomeUnsupportedError, outcomeEvaluation, segmentsByResetId, segmentUpdateRequest, shouldShowOutcomePrompt, upsertSegment,
} from '../src/lib/contextOutcome.ts'
import { contextResetDividers } from '../src/lib/piConverters.ts'
import { readFileSync } from 'node:fs'
import type { ContextResetResult, ContextSegment, ConversationEntry } from '../src/api/agent/types.ts'

const entry = (id: string, role: 'user' | 'assistant'): ConversationEntry => ({
  id, type: 'message', timestamp: '2026-10-30T10:00:00.000Z', message: { role, content: [{ type: 'text', text: id }] },
} as ConversationEntry)
const reset = (id: string, resetId: string): ConversationEntry => ({
  id, type: 'custom', customType: 'aiteam_context_reset', data: { reset_id: resetId, memory_reason: 'saved' },
})
const msg = (id: string, role: 'user' | 'assistant', extra: { _pending?: boolean } = {}) => ({ id, role, ...extra })

const segment = (id: string, extra: Partial<ContextSegment> = {}): ContextSegment => ({
  segment_id: id, conversation_id: 'c1', employee_ids: ['e1'], message_count: 2,
  outcome: null, outcome_reasons: [], outcome_note: null, follow_up: false, revision: 1,
  ended_at: '2026-10-30T02:00:00.000Z', evaluated_at: null, editable_until: '2026-11-06T02:00:00.000Z',
  ...extra,
})

test('current segment starts after the last reset divider, including a trailing one', () => {
  const messages = [msg('m1', 'user'), msg('m2', 'assistant'), msg('m3', 'user'), msg('m4', 'assistant')]
  const before = contextResetDividers([entry('m1', 'user'), entry('m2', 'assistant'), reset('r1', 'reset-1'), entry('m3', 'user'), entry('m4', 'assistant')])
  assert.deepEqual(currentSegmentMessages(messages, before).map(m => m.id), ['m3', 'm4'])
  const trailing = contextResetDividers([entry('m1', 'user'), entry('m2', 'assistant'), reset('r1', 'reset-1')])
  assert.deepEqual(currentSegmentMessages(messages.slice(0, 2), trailing), [])
  assert.deepEqual(currentSegmentMessages(messages, contextResetDividers([])).length, 4)
})

test('prompt shows only after a settled reply in a segment with a user message', () => {
  const settled = [msg('m1', 'user'), msg('m2', 'assistant')]
  assert.equal(shouldShowOutcomePrompt({ segment: settled, generating: false, dismissed: false }), true)
  assert.equal(shouldShowOutcomePrompt({ segment: settled, generating: true, dismissed: false }), false, 'generating')
  assert.equal(shouldShowOutcomePrompt({ segment: settled, generating: false, dismissed: true }), false, 'dismissed')
  assert.equal(shouldShowOutcomePrompt({ segment: [], generating: false, dismissed: false }), false, 'empty segment')
  assert.equal(shouldShowOutcomePrompt({ segment: [msg('m1', 'assistant')], generating: false, dismissed: false }), false, 'introduction only')
  assert.equal(shouldShowOutcomePrompt({ segment: [msg('m1', 'user')], generating: false, dismissed: false }), false, 'awaiting reply')
  assert.equal(shouldShowOutcomePrompt({ segment: [msg('m1', 'user'), msg('m2', 'assistant', { _pending: true })], generating: false, dismissed: false }), false, 'placeholder')
})

test('resolved sends only the outcome; unresolved sends filled details in canonical order', () => {
  assert.deepEqual(outcomeEvaluation({ outcome: 'resolved', reasons: ['other'], note: 'x', followUp: true }), { outcome: 'resolved' })
  assert.deepEqual(outcomeEvaluation(emptyOutcomeDraft('unresolved')), { outcome: 'unresolved' })
  assert.deepEqual(outcomeEvaluation({ outcome: 'unresolved', reasons: ['too_slow', 'missing_info'], note: '  缺少报价单 ', followUp: true }), {
    outcome: 'unresolved', outcome_reasons: ['missing_info', 'too_slow'], outcome_note: '缺少报价单', follow_up: true,
  })
  const long = outcomeEvaluation({ outcome: 'unresolved', reasons: [], note: '字'.repeat(600), followUp: false })
  assert.equal([...long.outcome_note!].length, 500)
})

test('reset request keeps the evaluation on the proceed retry and drops it for old agents', () => {
  const evaluation = outcomeEvaluation({ outcome: 'unresolved', reasons: ['wrong_result'], note: '', followUp: false })
  assert.deepEqual(contextResetRequest(evaluation, false), { outcome: 'unresolved', outcome_reasons: ['wrong_result'] })
  assert.deepEqual(contextResetRequest(evaluation, true), { outcome: 'unresolved', outcome_reasons: ['wrong_result'], on_memory_failure: 'proceed' })
  assert.deepEqual(contextResetRequest(null, true), { on_memory_failure: 'proceed' })
  assert.equal(isOutcomeUnsupportedError({ status: 422, code: 'invalid_request' }), true)
  assert.equal(isOutcomeUnsupportedError({ status: 422, code: 'invalid_outcome' }), false)
  assert.equal(isOutcomeUnsupportedError({ status: 409, code: 'conversation_busy' }), false)
})

test('segment update request carries revision, and null undoes the verdict', () => {
  assert.deepEqual(segmentUpdateRequest(emptyOutcomeDraft('resolved'), 3), { outcome: 'resolved', revision: 3 })
  assert.deepEqual(segmentUpdateRequest(null, 2), { outcome: null, revision: 2 })
})

test('segments merge into dividers by reset_id; legacy and undone segments are unevaluated', () => {
  const byId = segmentsByResetId([segment('reset-1', { outcome: 'resolved' }), segment('reset-2', { outcome: 'unresolved', outcome_reasons: ['missing_info', 'too_slow'] })])
  assert.deepEqual(dividerOutcome(byId.get('reset-1')), { tone: 'resolved', text: '✓ 已解决' })
  assert.deepEqual(dividerOutcome(byId.get('reset-2')), { tone: 'unresolved', text: '↻ 未解决：信息不够、太慢' })
  assert.deepEqual(dividerOutcome(byId.get('legacy')), { tone: 'none', text: '未评估' })
  assert.deepEqual(dividerOutcome(segment('reset-3')), { tone: 'none', text: '未评估' })
  assert.deepEqual(dividerOutcome(segment('reset-4', { outcome: 'unresolved' })), { tone: 'unresolved', text: '↻ 未解决' })
})

test('upsert replaces by segment_id and keeps end-time order', () => {
  const list = [segment('a', { ended_at: '2026-10-30T01:00:00.000Z' }), segment('b', { ended_at: '2026-10-30T03:00:00.000Z' })]
  const next = upsertSegment(list, segment('a', { ended_at: '2026-10-30T01:00:00.000Z', outcome: 'resolved', revision: 2 }))
  assert.deepEqual(next.map(s => [s.segment_id, s.revision]), [['a', 2], ['b', 1]])
  assert.deepEqual(upsertSegment(list, segment('c', { ended_at: '2026-10-30T02:00:00.000Z' })).map(s => s.segment_id), ['a', 'c', 'b'])
})

test('verdicts are editable until editable_until unless the server closed the window', () => {
  const s = segment('a')
  assert.equal(canEditSegment(s, Date.parse('2026-11-01T00:00:00.000Z'), new Set()), true)
  assert.equal(canEditSegment(s, Date.parse('2026-11-07T00:00:00.000Z'), new Set()), false)
  assert.equal(canEditSegment(s, Date.parse('2026-11-01T00:00:00.000Z'), new Set(['a'])), false)
})

const result = (extra: Partial<ContextResetResult> = {}): ContextResetResult => ({
  conversation_id: 'c1', reset_id: 'reset-1', reset: true, already_reset: false, confirmation_required: false, memory_saved: true,
  participants: [{ employee_id: 'e1', reset: true, already_reset: false, reset_id: 'reset-1', message_count: 2, memory_saved: true, memory_reason: 'saved', operation_id: 'op' }],
  ...extra,
})

test('reset notice names the recorded verdict and explains old agents', () => {
  assert.deepEqual(contextOutcomeNotice(result({ outcome: 'resolved' }), true), { tone: 'ok', text: '已记为已解决，已开启新上下文。' })
  assert.deepEqual(contextOutcomeNotice(result({ outcome: 'unresolved' }), true), { tone: 'ok', text: '已记为未解决，已开启新上下文。' })
  assert.deepEqual(contextOutcomeNotice(result(), false), { tone: 'ok', text: '已开启新上下文，当前版本暂不记录评估。' })
  assert.deepEqual(contextOutcomeNotice(result({ already_reset: true }), true), { tone: 'ok', text: '已经是新上下文，无需重复开启。' })
})

test('reset without evaluation only reports memory status, even on agents without verdict support', () => {
  assert.deepEqual(contextResetFinishedNotice(result(), false, false), { tone: 'ok', text: '已开启新上下文，关键记忆已提交保存。' })
  assert.deepEqual(contextResetFinishedNotice(result({ outcome: 'resolved' }), true, true), { tone: 'ok', text: '已记为已解决，已开启新上下文。' })
  assert.deepEqual(contextResetRequest(null, false), {})
})

test('chat and group chat offer a reset that skips evaluation next to the outcome prompt', () => {
  const button = readFileSync(new URL('../src/components/Chat/ContextResetControls.tsx', import.meta.url), 'utf8')
  assert.ok(button.includes("reset.run('plain', null, false)"), 'toolbar reset must not send an evaluation')
  for (const page of ['../src/pages/Chat/index.tsx', '../src/pages/GroupChat/index.tsx']) {
    const source = readFileSync(new URL(page, import.meta.url), 'utf8')
    assert.ok(source.includes('<ContextResetToolButton'), `${page} must render the toolbar reset`)
    assert.ok(source.includes('reset={contextReset}'), `${page} must share one reset flow with the outcome prompt`)
  }
})
