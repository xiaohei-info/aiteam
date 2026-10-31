import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { listConversations, listEntries } from '../src/api/agent/conversations.ts'
import type { AgentApiClient, AgentRequestOptions } from '../src/api/agent/client.ts'
import type { ConversationEntry, ConversationMetadata } from '../src/api/agent/types.ts'
import {
  buildSolutionEmployeeIds,
  filterConversationHistoryEntries,
  getHistoryEntryText,
  getHistoryEntryTimestamp,
  parseHistorySearchDate,
  searchConversationHistory,
} from '../src/lib/conversationHistorySearch.ts'

function conversation(
  id: string,
  patch: Partial<ConversationMetadata> = {},
): ConversationMetadata {
  return {
    id,
    title: `会话 ${id}`,
    kind: 'chat',
    labels: [],
    state: 'active',
    entry_employee_id: 'employee-1',
    coordinator_employee_id: null,
    solution_instance_id: null,
    schedule: null,
    permission_mode: 'read-only',
    last_read_entry_id: null,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...patch,
  }
}

function entry(
  id: string,
  text: string,
  timestamp: string | number,
  patch: Partial<ConversationEntry> = {},
): ConversationEntry {
  return {
    id,
    type: 'message',
    timestamp,
    message: { role: 'user', content: text },
    source_type: 'human',
    ...patch,
  }
}

test('history indexing uses visible message text and real entry timestamps only', () => {
  const item: ConversationEntry = {
    id: 'entry-parts',
    type: 'message',
    timestamp: 1_780_000_000_000,
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'private chain of thought' },
        { type: 'text', text: '发布' },
        { type: 'toolCall', id: 'tool-1', name: 'deploy', arguments: { secret: 'hidden' } },
        { type: 'text', text: '完成' },
      ],
    },
  }

  assert.equal(getHistoryEntryText(item), '发布完成')
  assert.equal(getHistoryEntryTimestamp(item), 1_780_000_000_000)
  assert.equal(getHistoryEntryText({ id: 'system', type: 'system' }), '')
  assert.equal(getHistoryEntryText({
    id: 'tool-result',
    type: 'message',
    message: { role: 'toolResult', content: '不能定位成独立消息' },
  }), '')
  assert.equal(getHistoryEntryTimestamp({ id: 'unknown', type: 'message' }), null)
  assert.equal(getHistoryEntryTimestamp({
    id: 'message-only-time',
    type: 'message',
    message: { role: 'user', timestamp: 1_780_000_000_000, content: '正文' },
  }), null)
})

test('local history filters apply keyword, employee roster and inclusive date boundaries', () => {
  const chat = conversation('chat-1')
  const startAt = parseHistorySearchDate('2026-09-01')!
  const endAt = parseHistorySearchDate('2026-09-01', true)!
  const entries = [
    entry('before', '发布检查', startAt - 1),
    entry('match', '准备 RELEASE 发布检查', startAt + 60_000),
    entry('after', '发布检查', endAt + 1),
  ]

  const matches = filterConversationHistoryEntries(chat, entries, {
    query: 'release',
    employeeId: 'employee-1',
    startAt,
    endAt,
  })
  assert.deepEqual(matches.map((item) => item.entryId), ['match'])
  assert.match(matches[0].snippet, /RELEASE/)

  assert.deepEqual(filterConversationHistoryEntries(chat, entries, {
    query: 'release',
    employeeId: 'employee-2',
  }), [])

  const group = conversation('group-1', {
    kind: 'group',
    entry_employee_id: null,
    coordinator_employee_id: 'employee-1',
  })
  const roster = new Map([['group-1', ['employee-1', 'employee-2']]])
  assert.equal(filterConversationHistoryEntries(group, [entry('group-user', '发布检查', startAt)], {
    query: '发布',
    employeeId: 'employee-2',
  }, roster).length, 1)
})

test('solution roster index includes experts and coordinator without duplicates', () => {
  const roster = buildSolutionEmployeeIds([{
    solution_instance_id: 'solution-1',
    display_name: '发布团队',
    version: '1',
    coordinator_employee_id: 'employee-1',
    expert_employee_ids: ['employee-1', 'employee-2'],
  }])

  assert.deepEqual(roster.get('solution-1'), ['employee-1', 'employee-2'])
})

test('employee filter resolves a group discovered after a cursor through its solution roster', async () => {
  const controller = new AbortController()
  const solutionEmployeeIds = buildSolutionEmployeeIds([{
    solution_instance_id: 'solution-late',
    display_name: '历史团队',
    version: '1',
    coordinator_employee_id: 'employee-coordinator',
    expert_employee_ids: ['employee-worker'],
  }])

  const response = await searchConversationHistory({
    listConversations: async ({ cursor }) => cursor
      ? {
          conversations: [conversation('group-after-cursor', {
            kind: 'group',
            entry_employee_id: null,
            coordinator_employee_id: null,
            solution_instance_id: 'solution-late',
          })],
          page: { next_cursor: null, has_more: false },
        }
      : {
          conversations: [conversation('first-page-chat')],
          page: { next_cursor: 'cursor-2', has_more: true },
        },
    listEntries: async (conversationId) => ({
      conversation_id: conversationId,
      entries: [entry(`entry-${conversationId}`, '跨页发布命中', '2026-09-02T12:00:00.000Z')],
    }),
  }, {
    query: '发布',
    employeeId: 'employee-worker',
  }, {
    signal: controller.signal,
    conversationEmployeeIds: new Map(),
    solutionEmployeeIds,
  })

  assert.deepEqual(response.results.map((item) => item.entryId), ['entry-group-after-cursor'])
})

test('history aggregation paginates all conversations, limits entry concurrency and reports partial failures', async () => {
  const controller = new AbortController()
  const pageCalls: Array<string | undefined> = []
  const entryCalls: string[] = []
  let activeRequests = 0
  let maximumConcurrency = 0
  const progress: number[] = []
  const denied = Object.assign(new Error('denied'), { status: 403 })

  const response = await searchConversationHistory({
    listConversations: async (params, signal) => {
      assert.equal(signal, controller.signal)
      pageCalls.push(params.cursor)
      if (!params.cursor) {
        return {
          conversations: [conversation('c1'), conversation('c2')],
          page: { next_cursor: 'cursor-2', has_more: true },
        }
      }
      return {
        conversations: [conversation('c3', { updated_at: '2026-09-03T00:00:00.000Z' })],
        page: { next_cursor: null, has_more: false },
      }
    },
    listEntries: async (conversationId, signal) => {
      assert.equal(signal, controller.signal)
      entryCalls.push(conversationId)
      activeRequests += 1
      maximumConcurrency = Math.max(maximumConcurrency, activeRequests)
      await new Promise((resolve) => setTimeout(resolve, conversationId === 'c1' ? 8 : 2))
      activeRequests -= 1
      if (conversationId === 'c2') throw denied
      const timestamp = conversationId === 'c3'
        ? '2026-09-03T12:00:00.000Z'
        : '2026-09-01T12:00:00.000Z'
      return { conversation_id: conversationId, entries: [entry(`entry-${conversationId}`, '真实命中', timestamp)] }
    },
  }, { query: '命中' }, {
    signal: controller.signal,
    concurrency: 2,
    onProgress: (next) => progress.push(next.scannedConversations),
  })

  assert.deepEqual(pageCalls, [undefined, 'cursor-2'])
  assert.deepEqual(entryCalls.sort(), ['c1', 'c2', 'c3'])
  assert.equal(maximumConcurrency, 2)
  assert.deepEqual(response.results.map((item) => item.entryId), ['entry-c3', 'entry-c1'])
  assert.deepEqual(response.failures, [{
    conversationId: 'c2',
    conversationTitle: '会话 c2',
    reason: '无权读取此会话',
  }])
  assert.equal(progress.at(-1), 3)
})

test('history aggregation aborts in-flight entry reads and discards incomplete results', async () => {
  const controller = new AbortController()
  const search = searchConversationHistory({
    listConversations: async () => ({
      conversations: [conversation('slow')],
      page: { next_cursor: null, has_more: false },
    }),
    listEntries: async (_conversationId, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      setTimeout(() => resolve({ conversation_id: 'slow', entries: [] }), 100)
    }),
  }, { query: 'anything' }, { signal: controller.signal })

  controller.abort()
  await assert.rejects(search, (error: unknown) => error instanceof Error && error.name === 'AbortError')
})

test('Agent conversation wrappers forward AbortSignal and never send the rejected kind query', async () => {
  const controller = new AbortController()
  const calls: AgentRequestOptions[] = []
  const client = {
    request: async (options: AgentRequestOptions) => {
      calls.push(options)
      if (options.path.endsWith('/entries')) {
        return { data: { conversation_id: 'conversation-1', entries: [] }, page: { has_more: false, next_cursor: null } }
      }
      return { data: [], page: { next_cursor: null, has_more: false } }
    },
  } as AgentApiClient

  await listConversations(client, { cursor: 'cursor-1', limit: 100, signal: controller.signal })
  await listEntries(client, 'conversation-1', controller.signal)

  assert.deepEqual(calls[0].query, { cursor: 'cursor-1', limit: 100 })
  assert.equal(calls[0].signal, controller.signal)
  assert.equal(calls[1].signal, controller.signal)
})

test('history search UI is globally mounted and both chat kinds locate by entry id', () => {
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const paletteSource = readFileSync(new URL('../src/components/Layout/CommandPalette.tsx', import.meta.url), 'utf8')
  const searchSource = readFileSync(new URL('../src/components/Layout/ConversationHistorySearch.tsx', import.meta.url), 'utf8')
  const chatSource = readFileSync(new URL('../src/pages/Chat/index.tsx', import.meta.url), 'utf8')
  const groupSource = readFileSync(new URL('../src/pages/GroupChat/index.tsx', import.meta.url), 'utf8')

  assert.match(appSource, /isAuthenticated\s*&&\s*<ConversationHistorySearch\s*\/>/)
  assert.match(paletteSource, /requestHistorySearch\(initialQuery\)/)
  assert.match(searchSource, /conversation\.kind === 'group'/)
  assert.match(searchSource, /navigate\('\/group-chat'\)/)
  assert.match(searchSource, /navigate\('\/chat'\)/)
  assert.match(searchSource, /setHighlightMsgId\(result\.entryId\)/)
  assert.match(chatSource, /m\.id === highlightMsgId \|\| m\.entryRefs\?\.includes\(highlightMsgId\)/)
  assert.match(groupSource, /message\.id === highlightMsgId \|\| message\.entryRefs\?\.includes\(highlightMsgId\)/)
  assert.match(groupSource, /flashMsgId === msg\.id \? ' highlight'/)
})

test('obsolete agentDetails store has no producer or fallback search path', () => {
  const storeSource = readFileSync(new URL('../src/stores/chat.ts', import.meta.url), 'utf8')
  const panelSource = readFileSync(new URL('../src/components/Layout/Panel.tsx', import.meta.url), 'utf8')
  const oldTypeUrl = new URL('../src/types/agentDetail.ts', import.meta.url)

  assert.doesNotMatch(storeSource, /agentDetails|addAgentDetail/)
  assert.doesNotMatch(panelSource, /agentDetails|addAgentDetail/)
  assert.match(panelSource, /employee\?\.roleName/)
  assert.match(panelSource, /employee\?\.persona/)
  assert.match(panelSource, /employee\?\.skills/)
  assert.equal(existsSync(oldTypeUrl), false)
})

test('conversation state and permission unions stay aligned with FredServer enums', () => {
  const typeSource = readFileSync(new URL('../src/api/agent/types.ts', import.meta.url), 'utf8')
  assert.match(typeSource, /ConversationStateValue = 'draft' \| 'active' \| 'paused' \| 'muted' \| 'archived'/)
  assert.match(typeSource, /PermissionMode = 'read-only' \| 'workspace-write' \| 'full-access'/)
  assert.doesNotMatch(typeSource, /ConversationStateValue[^\n]*closed/)
  assert.doesNotMatch(typeSource, /PermissionMode[^\n]*(strict|sandbox|ambient)/)
})
