import assert from 'node:assert/strict'
import test from 'node:test'
import { formatUsdDecimal, matchesWorkWindow, mergeWorkChanges } from '../src/lib/workRecords.ts'
import { getLastReadEntryId } from '../src/lib/readAnchor.ts'
import { participantRoster } from '../src/lib/groupRoster.ts'
import { listEntries } from '../src/api/agent/conversations.ts'
import { searchLocalMessages } from '../src/lib/localMessageSearch.ts'
import type { WorkRecord } from '../src/api/agent/observations.types'
import type { AgentApiClient } from '../src/api/agent/client'
import type { ConversationMetadata } from '../src/api/agent/types'

const record = (id: string, time: string | null, outcome: WorkRecord['outcome'] = 'active') => ({ id, occurred_at: time, outcome }) as WorkRecord

test('work changes replace active outcomes, filter upserts, and delete by opaque id', () => {
  const first = record('opaque-1', '2026-09-09T09:30:00Z')
  const second = record('opaque-2', null, 'unknown')
  const changed = mergeWorkChanges(new Map([[first.id, first], [second.id, second]]), [
    { operation: 'upsert', record_id: first.id, record: { ...first, outcome: 'aborted' } },
    { operation: 'delete', record_id: second.id },
    { operation: 'upsert', record_id: 'outside', record: record('outside', '2026-09-09T10:00:00Z') },
  ], { window_start: '2026-09-09T09:00:00Z', window_end: '2026-09-09T10:00:00Z' })
  assert.equal(changed.get(first.id)?.outcome, 'aborted')
  assert.equal(changed.size, 1)
  assert.equal(matchesWorkWindow(second, {}), true)
  assert.equal(matchesWorkWindow(second, { window_start: '2026-09-09T09:00:00Z' }), false)
})

test('USD strings round once with arbitrary precision and preserve unknown totals', () => {
  assert.equal(formatUsdDecimal(null), '未知')
  assert.equal(formatUsdDecimal('0.000000000000'), '$0.00')
  assert.equal(formatUsdDecimal('0.004999999999'), '$0.00')
  assert.equal(formatUsdDecimal('0.005000000000'), '$0.01')
  assert.equal(formatUsdDecimal('9007199254740993.995000000000'), '$9007199254740994.00')
})


test('participant roster preserves unavailable historical employees without allowing mentions', () => {
  const roster = participantRoster({ conversation_id: 'group', employee_count: 1, participants: [{ employee_id: 'old', display_name: 'Historical', handle: null, role: 'coordinator', available: false, role_title: null, department_ids: [] }] }, [])
  assert.equal(roster.memberCount, 1)
  assert.equal(roster.members[0].display_name, 'Historical')
  assert.equal(roster.members[0].can_mention, false)
  assert.equal(roster.members[0].role_name, '岗位未设置')
  assert.equal(roster.members[0].is_system_planner, true)
  assert.deepEqual(participantRoster({ conversation_id: 'empty', employee_count: 0, participants: [] }, []).members, [])
})

test('entry pagination echoes cursors and retains colliding raw ids from different participants', async () => {
  const cursors: unknown[] = []
  const signal = new AbortController().signal
  const client = { request: async (options: { query: { cursor?: string }; signal: AbortSignal }) => {
    assert.equal(options.signal, signal)
    cursors.push(options.query.cursor)
    if (!options.query.cursor) return { data: { entries: [{ id: 'same', entry_ref: 'ref-a' }] }, page: { has_more: true, next_cursor: 'opaque-scope-cursor' } }
    return { data: { entries: [{ id: 'same', entry_ref: 'ref-b' }] }, page: { has_more: false, next_cursor: null } }
  } } as unknown as AgentApiClient
  const result = await listEntries(client, 'conversation', signal)
  assert.deepEqual(cursors, [undefined, 'opaque-scope-cursor'])
  assert.equal(result.entries.length, 2)
  assert.equal(getLastReadEntryId(result.entries), 'ref-b')
})

test('server message search passes actual sender filter and uses returned snippets and refs', async () => {
  const queries: unknown[] = []
  const result = await searchLocalMessages({
    searchMessages: async query => {
      queries.push(query)
      return { data: [{ conversation_id: 'conversation', conversation_title: 'Title', entry_ref: 'stable-ref', id: 'raw', participant_employee_id: 'receiver', timestamp: '2026-09-09T09:00:00Z', role: 'user', source_type: 'employee', source_employee_id: 'sender', snippet: 'safe matching text' }], page: { has_more: false, next_cursor: null } }
    },
    getConversation: async id => ({ id, kind: 'group', title: 'Title' }) as ConversationMetadata,
  }, { query: 'matching', employeeId: 'sender' }, { signal: new AbortController().signal })
  assert.deepEqual(queries, [{ q: 'matching', employee_id: 'sender', limit: 100, cursor: undefined }])
  assert.equal(result.results[0].entryId, 'stable-ref')
  assert.equal(result.results[0].snippet, 'safe matching text')
  assert.equal(result.results[0].senderEmployeeId, 'sender')
})
