import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { webcrypto } from 'node:crypto'
import { dispatchPiEvent, entriesToMessages, resolvePiEventSenderIdentity } from '../src/lib/piConverters.ts'
import { applyLocalFailures, assistantFailure, describeFailure, displayDetail, retryTarget, settledFailure } from '../src/lib/replyFailure.ts'
import { createSettleTracker } from '../src/lib/groupStreamLifecycle.ts'
import { classifyRequestError } from '../src/lib/requestError.ts'
import { collectTodoTaskCards } from '../src/lib/todoTaskCard.ts'
import { mergeReplyProjection, reconcileReplyProjection } from '../src/lib/replyProjection.ts'
import { replyPreview } from '../src/lib/replyPreview.ts'

function chatStore(api: Record<string, unknown>) {
  const source = readFileSync(new URL('../src/stores/chat.ts', import.meta.url), 'utf8')
  const exports: Record<string, any> = {}
  const require = (id: string): unknown => {
    if (id === 'zustand') return { create: (init: any) => {
      let state: any
      const getState = () => state
      const setState = (patch: any) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) } }
      state = init(setState, getState)
      return { getState, setState }
    } }
    if (id === '../api/agent') return { agentApi: api, AgentApiError: Error }
    if (id === './agentAuth') return { useAgentAuthStore: { getState: () => ({}), subscribe: () => {} } }
    if (id === '../lib/pinnedConversations') return { getPinnedStorageKey: () => null }
    if (id === '../lib/piConverters') return { entriesToMessages, dispatchPiEvent, resolvePiEventSenderIdentity }
    if (id === '../lib/replyFailure') return { applyLocalFailures, describeFailure, settledFailure }
    if (id === '../lib/replyProjection') return { mergeReplyProjection, reconcileReplyProjection }
    if (id === '../lib/groupStreamLifecycle') return { createSettleTracker }
    if (id === '../lib/globalActivityCollector') return { globalActivityCollector: { emit: () => {} } }
    if (id === '../lib/systemNotifications') return { notifyConversationCompleted: async () => {} }
    if (id === '../lib/requestError') return { classifyRequestError }
    return {}
  }
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  vm.runInNewContext(`(function(require, exports) { ${code}\n})`, { console, setTimeout, clearTimeout, crypto: webcrypto })(require, exports)
  return exports.useChatStore
}
const entry = (id: string) => ({ id, type: 'message', message: { role: 'user', content: id } })

for (const kind of ['chat', 'group'] as const) {
  test(`${kind}: sending after stopping appends fresh thinking bubbles after the new message`, async () => {
    let onEvent: (event: unknown) => void = () => {}
    const store = chatStore({
      abortConversation: async () => {},
      getConversationState: async () => ({ prompting: true }),
      subscribeEvents: (options: { onEvent: typeof onEvent }) => {
        onEvent = options.onEvent
        return { close: () => {} }
      },
    })
    const convId = 'conversation'
    const targets = kind === 'group' ? ['worker-a', 'worker-b'] : [undefined]
    store.setState(kind === 'chat' ? { activeConvId: convId } : { activeGroupId: convId })
    const send = (id: string) => {
      store.getState().appendMessage(convId, { id, role: 'user', msgType: 'text', content: id })
      store.getState().startAssistantStream(convId, {
        kind, targetEmployeeIds: targets.filter(Boolean), expectedTargetsKnown: true,
      })
    }
    try {
      send('first')
      onEvent({ type: 'message_update', source_employee_id: targets[0], assistantMessageEvent: { type: 'thinking_delta', delta: 'previous reasoning' } })
      onEvent({ type: 'message_update', source_employee_id: targets[0], assistantMessageEvent: { type: 'text_delta', delta: 'partial reply' } })
      await store.getState().abortStream(convId)
      const stopped = store.getState().activeConvMessages.filter((message: any) => message.role === 'assistant')
      assert.equal(stopped[0].content, 'partial reply\n\n停止生成')

      send('second')
      const state = store.getState()
      const newMessageIndex = state.activeConvMessages.findIndex((message: any) => message.id === 'second')
      const thinking = state.activeConvMessages.filter((message: any) => state.streamingMsgIds.has(message.id))
      assert.equal(thinking.length, targets.length)
      for (const message of thinking) {
        assert.ok(state.activeConvMessages.indexOf(message) > newMessageIndex)
        assert.equal(message.content, '')
        assert.equal(message.thinking, undefined)
        assert.equal(message._pending, true)
      }
      for (const message of stopped) {
        assert.equal(state.activeConvMessages.find((item: any) => item.id === message.id), message)
        assert.equal(state.streamingMsgIds.has(message.id), false)
      }
      onEvent({ type: 'message_update', source_employee_id: targets[0], assistantMessageEvent: { type: 'text_delta', delta: 'new reply' } })
      assert.equal(store.getState().activeConvMessages.find((message: any) => message.id === thinking[0].id).content, 'new reply')
      assert.equal(store.getState().activeConvMessages.find((message: any) => message.id === stopped[0].id).content, 'partial reply\n\n停止生成')
    } finally {
      await store.getState().abortStream(convId)
    }
  })
}

test('reselecting the active chat preserves its loaded messages', () => {
  const store = chatStore({})
  store.setState({ activeConvId: 'chat', activeConvMessages: [{ id: 'first', content: 'hello' }] })
  store.getState().setActiveConvId('chat')
  assert.equal(store.getState().activeConvMessages[0].content, 'hello')
})

test('switching away and back keeps an in-flight thinking projection', async () => {
  let onEvent: (event: any) => void = () => {}
  const store = chatStore({
    abortConversation: async () => {},
    listEntries: async () => ({ entries: [] }),
    getConversationState: async () => ({ prompting: true }),
    subscribeEvents: (options: { onEvent: typeof onEvent }) => {
      onEvent = options.onEvent
      return { close() {} }
    },
  })
  store.getState().setActiveConvId('a')
  store.getState().startAssistantStream('a')
  onEvent({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '先' } })
  store.getState().setActiveConvId('b')
  onEvent({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '后' } })
  store.getState().setActiveConvId('a')
  await store.getState().loadConversation('a')
  const assistant = store.getState().activeConvMessages.find((message: any) => message.role === 'assistant')
  assert.equal(assistant?.thinking, '先后')
  assert.equal(assistant?._pending, true)
  await store.getState().abortStream('a')
})

test('reconciliation restores an active run snapshot after a reconnect', () => {
  let onEvent: (event: any) => void = () => {}
  const store = chatStore({
    abortConversation: async () => {},
    getConversationState: async () => ({ prompting: true }),
    subscribeEvents: (options: { onEvent: typeof onEvent }) => {
      onEvent = options.onEvent
      return { close() {} }
    },
  })
  store.getState().setActiveConvId('reconnect')
  store.getState().startAssistantStream('reconnect')
  onEvent({
    type: 'reconciliation', schema_version: '2', conversation_id: 'reconnect', state: 'active', prompting: true,
    entries: [], active_runs: [{ work_id: 'work-1', status: 'thinking', message: {
      role: 'assistant', content: [{ type: 'thinking', thinking: '恢复的思考' }],
    } }],
  })
  const assistant = store.getState().activeConvMessages.find((message: any) => message.role === 'assistant')
  assert.equal(assistant?.thinking, '恢复的思考')
  assert.equal(assistant?.workId, 'work-1')
  assert.equal(assistant?._pending, true)
  store.getState().abortStream('reconnect')
})

const processEntry = (employee = 'pm', work = 'w1', id = 'saved') => ({
  id, entry_ref: `ref-${id}`, type: 'message', work_id: work, source_employee_id: employee,
  message: { role: 'assistant', content: [
    { type: 'thinking', thinking: 'inspect' },
    { type: 'toolCall', id: 'bash-1', name: 'bash', arguments: { command: 'pwd' } },
  ] },
})

for (const kind of ['chat', 'group'] as const) {
  test(`${kind}: loaded history and active snapshot share one streaming row without live work_id`, async () => {
    let emit: (event: any) => void = () => {}
    const saved = processEntry()
    const store = chatStore({
      listEntries: async () => ({ entries: [saved] }),
      getConversationState: async () => ({ prompting: true }), abortConversation: async () => {},
      subscribeEvents: (options: any) => { emit = options.onEvent; return { close() {} } },
    })
    store.setState(kind === 'chat' ? { activeConvId: 'c' } : { activeGroupId: 'c' })
    try {
      await store.getState()[kind === 'chat' ? 'loadConversation' : 'loadGroupConversation']('c')
      const snapshot = { type: 'reconciliation', conversation_id: 'c', prompting: true,
        entries: [saved], active_runs: [{ work_id: 'w1', source_employee_id: 'pm', status: 'tool', message: saved.message }] }
      emit(snapshot)
      emit(snapshot)
      emit({ type: 'tool_execution_end', source_employee_id: 'pm', toolCallId: 'bash-1', toolName: 'bash', result: 'ok' })
      const state = store.getState()
      assert.equal(state.activeConvMessages.length, 1)
      const reply = state.activeConvMessages[0]
      assert.equal(reply.workId, 'w1')
      assert(reply.entryRefs.includes('ref-saved'))
      assert.equal(reply.thinkingSteps.length, 2)
      assert.equal(reply.thinkingSteps[1].tool.result, 'ok')
      assert(state.streamingMsgIds.has(reply.id))
      assert.equal(state.activeConvMsgIds.size, 1)
    } finally { await store.getState().abortStream('c') }
  })
}

test('switching back reconciles a live tool with its unique employee-scoped durable work', async () => {
  let emit: (event: any) => void = () => {}
  const saved = processEntry()
  const store = chatStore({
    listEntries: async () => ({ entries: [saved] }), getConversationState: async () => ({ prompting: true }),
    abortConversation: async () => {},
    subscribeEvents: (options: any) => { emit = options.onEvent; return { close() {} } },
  })
  store.setState({ activeConvId: 'c' })
  store.getState().startAssistantStream('c')
  try {
    emit({ type: 'message_update', source_employee_id: 'pm', assistantMessageEvent: { type: 'thinking_delta', delta: 'inspect' } })
    emit({ type: 'tool_execution_start', source_employee_id: 'pm', toolCallId: 'bash-1', toolName: 'bash', args: { command: 'pwd' } })
    const originalId = store.getState().activeConvMessages[0].id
    store.getState().setActiveConvId('elsewhere')
    store.getState().setActiveConvId('c')
    await store.getState().loadConversation('c')
    emit({ type: 'tool_execution_end', source_employee_id: 'pm', toolCallId: 'bash-1', toolName: 'bash', result: 'done' })
    const rows = store.getState().activeConvMessages
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, originalId)
    assert.equal(rows[0].workId, 'w1')
    assert.equal(rows[0].thinkingSteps.length, 2)
    assert.equal(rows[0].thinkingSteps[1].tool.result, 'done')
  } finally { await store.getState().abortStream('c') }
})

test('next-message reconciliation preserves prior steps, text and tool results on repeat', async () => {
  let emit: (event: any) => void = () => {}
  const saved = processEntry()
  saved.message.content.unshift({ type: 'text', text: 'First paragraph' } as any)
  const result = { id: 'result', entry_ref: 'ref-result', type: 'message', work_id: 'w1', source_employee_id: 'pm',
    message: { role: 'toolResult', toolCallId: 'bash-1', content: 'done' } }
  const store = chatStore({
    getConversationState: async () => ({ prompting: true }), abortConversation: async () => {},
    subscribeEvents: (options: any) => { emit = options.onEvent; return { close() {} } },
  })
  store.setState({ activeConvId: 'c' })
  store.getState().startAssistantStream('c')
  try {
    const event = { type: 'reconciliation', conversation_id: 'c', prompting: true, entries: [saved, result],
      active_runs: [{ work_id: 'w1', source_employee_id: 'pm', status: 'text', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'finish' }, { type: 'text', text: 'Second paragraph' },
      ] } }] }
    emit(event)
    emit(event)
    emit({ type: 'message_update', source_employee_id: 'pm', assistantMessageEvent: { type: 'text_delta', delta: '!' } })
    const rows = store.getState().activeConvMessages
    assert.equal(rows.length, 1)
    assert.equal(rows[0].content, 'First paragraph\n\nSecond paragraph!')
    assert.equal(rows[0].thinkingSteps.length, 3)
    assert.equal(rows[0].thinkingSteps[1].tool.result, 'done')
    assert.equal(rows[0].thinkingSteps[2].text, 'finish')
    assert(rows[0].entryRefs.includes('ref-result'))
  } finally { await store.getState().abortStream('c') }
})

test('a reply spanning several entries shows when it finished and still sorts by when it started', () => {
  const started = Date.parse('2026-11-05T14:10:00.000Z')
  const finished = Date.parse('2026-11-05T14:21:00.000Z')
  const entry = (id: string, timestamp: number, content: unknown[]) => ({
    id, entry_ref: id, type: 'message', work_id: 'w1', timestamp: new Date(timestamp).toISOString(),
    message: { role: 'assistant', content, timestamp },
  })
  const clock = (ms: number) => {
    const at = new Date(ms)
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  }
  const [reply, ...others] = entriesToMessages([
    entry('call', started, [{ type: 'toolCall', id: 't1', name: 'bash', arguments: {} }]),
    entry('final', finished, [{ type: 'text', text: 'done' }]),
  ] as never)
  assert.equal(others.length, 0)
  assert.equal(reply.time, clock(finished))
  assert.equal(reply._ts, started)
})

test('agent_start after settled opens a new employee reply without work_id and does not revive old rows', async () => {
  let emit: (event: any) => void = () => {}
  const store = chatStore({
    getConversationState: async () => ({ prompting: true }), abortConversation: async () => {},
    subscribeEvents: (options: any) => { emit = options.onEvent; return { close() {} } },
  })
  store.setState({ activeGroupId: 'c' })
  store.getState().startAssistantStream('c', { kind: 'group', expectedTargetsKnown: false })
  try {
    const send = (event: object) => emit({ source_employee_id: 'pm', ...event })
    send({ type: 'agent_start' })
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'First' } })
    send({ type: 'agent_settled' })
    send({ type: 'agent_start' })
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Second' } })
    emit({ type: 'reconciliation', conversation_id: 'c', prompting: true, entries: [], active_runs: [] })
    const state = store.getState()
    assert.equal(state.activeConvMessages.length, 2)
    assert.equal(state.activeConvMessages[0].content, 'First')
    assert.equal(state.activeConvMessages[1].content, 'Second')
    assert(!state.streamingMsgIds.has(state.activeConvMessages[0].id))
    assert(state.streamingMsgIds.has(state.activeConvMessages[1].id))
  } finally { await store.getState().abortStream('c') }
})

test('background reconciliation keeps employee works isolated and preserves an older history window', async () => {
  let emit: (event: any) => void = () => {}
  const history = [entry('older-user'), processEntry('pm', 'w1', 'pm-saved'), processEntry('engineer', 'w2', 'eng-saved')]
  const store = chatStore({
    listEntries: async () => ({ entries: history }), getConversationState: async () => ({ prompting: true }),
    abortConversation: async () => {},
    subscribeEvents: (options: any) => { emit = options.onEvent; return { close() {} } },
  })
  store.setState({ activeGroupId: 'c' })
  try {
    await store.getState().loadGroupConversation('c')
    store.setState({ activeGroupId: 'elsewhere', activeConvMessages: [{ id: 'unrelated', role: 'user', content: 'keep' }] })
    emit({ type: 'reconciliation', conversation_id: 'c', prompting: true, entries: [history[2]], active_runs: [
      { work_id: 'w1', source_employee_id: 'pm', status: 'tool', message: history[1].message },
      { work_id: 'w2', source_employee_id: 'engineer', status: 'tool', message: history[2].message },
    ] })
    assert.equal(store.getState().activeConvMessages[0].id, 'unrelated')
    store.setState({ activeGroupId: 'c' })
    await store.getState().loadGroupConversation('c')
    const rows = store.getState().activeConvMessages
    assert.equal(rows.length, 3)
    assert.equal(rows[0].id, 'older-user')
    assert.equal(rows[1].senderEmployeeId, 'pm')
    assert.equal(rows[2].senderEmployeeId, 'engineer')
    assert.equal(rows[1].thinkingSteps.length, 2)
    assert.equal(rows[2].thinkingSteps.length, 2)
    assert(store.getState().streamingMsgIds.has(rows[1].id))
    assert(store.getState().streamingMsgIds.has(rows[2].id))
  } finally { await store.getState().abortStream('c') }
})

test('an identity-only snapshot adopts history without erasing process or leaking synthetic references', async () => {
  let emit: (event: any) => void = () => {}
  const saved = processEntry()
  const store = chatStore({
    getConversationState: async () => ({ prompting: true }), abortConversation: async () => {},
    subscribeEvents: (options: any) => { emit = options.onEvent; return { close() {} } },
  })
  store.setState({ activeConvId: 'c' })
  store.getState().startAssistantStream('c')
  try {
    const snapshot = { type: 'reconciliation', conversation_id: 'c', prompting: true, entries: [saved],
      active_runs: [{ work_id: 'w1', source_employee_id: 'pm', status: 'tool' }] }
    emit(snapshot)
    emit({ ...snapshot, entries: [], receipt_settlement_pending: true })
    const rows = store.getState().activeConvMessages
    assert.equal(rows.length, 1)
    assert.equal(rows[0].thinkingSteps.length, 2)
    assert.equal(JSON.stringify(rows[0].entryRefs), '["ref-saved"]')
    assert.equal(store.getState().activeConvRawItems.length, 1)
  } finally { await store.getState().abortStream('c') }
})

test('history remains visible when execution state is unavailable', async () => {
  const store = chatStore({
    listEntries: async () => ({ entries: [entry('saved-message')] }),
    getConversationState: async () => { throw new Error('state unavailable') },
  })
  store.getState().setActiveConvId('chat')
  await store.getState().loadConversation('chat')
  assert.equal(store.getState().activeConvMessages[0].content, 'saved-message')
  assert.equal(store.getState().activeMessagesError, null)
})

test('an old history request cannot overwrite a newer visit to the same chat', async () => {
  let finishOld: (value: unknown) => void = () => {}
  let calls = 0
  const store = chatStore({
    listEntries: () => ++calls === 1 ? new Promise(resolve => { finishOld = resolve }) : Promise.resolve({ entries: [entry('new')] }),
    getConversationState: async () => ({ prompting: false }),
  })
  store.getState().setActiveConvId('a')
  const old = store.getState().loadConversation('a')
  store.getState().setActiveConvId('b')
  store.getState().setActiveConvId('a')
  await store.getState().loadConversation('a')
  finishOld({ entries: [] })
  await old
  assert.equal(store.getState().activeConvMessages[0].content, 'new')
})

// Execute the page's actual callback with a synchronous ID-change observer,
// representing a history effect firing before the first prompt is persisted.
function pageCallback(name: string, context: Record<string, unknown>): any {
  const source = ts.createSourceFile('Chat.tsx', readFileSync(new URL('../src/pages/Chat/index.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let callback: ts.Expression | undefined
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0]
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(callback)
  const code = ts.transpileModule(`(${callback.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
  return vm.runInNewContext(code, context)
}

test('upgrading an employee placeholder does not request empty history before first send', async () => {
  const loaded = { current: 'emp_employee' }
  let clears = 0
  const ensure = pageCallback('ensureConversation', {
    conversations: [{ id: 'emp_employee', _employeeId: 'employee' }], getEmployeeId: () => 'employee',
    upgradedConversationIdsRef: { current: new Map() }, conversationCreationRef: { current: null },
    agentApi: { createConversation: async () => ({ id: 'real-chat' }) }, workbenchEmployees: [],
    loadedConversationRef: loaded, useChatStore: { getState: () => ({ activeConvId: 'emp_employee' }) },
    upgradeConversationId: (_old: string, id: string) => { if (loaded.current !== id) clears++ },
    rememberEmployeeConversation: () => {},
  })
  assert.equal((await ensure('emp_employee')).id, 'real-chat')
  assert.equal(clears, 0)
})

test('new-session send skips empty history loading on activation', async () => {
  const loaded = { current: null as string | null }
  let clears = 0
  let sent = false
  const send = pageCallback('startNewSession', {
    workbenchEmployees: [{ employeeId: 'employee' }], uploadedAttachmentIds: () => [],
    setNewSessionError: () => {}, setSendError: () => {}, setIsGenerating: () => {},
    ensureNewSessionConversation: async () => ({ id: 'new-chat', item: {} }),
    useChatStore: { getState: () => ({ conversations: [] }) }, addConversation: () => {}, setConvDraft: () => {},
    loadedConversationRef: loaded, newSessionConversationRef: { current: null },
    setActiveConvId: (id: string) => { if (loaded.current !== id) clears++ },
    submitMessage: async () => { sent = true; return true },
  })
  assert.equal(await send('hello'), true)
  assert.equal(sent, true)
  assert.equal(clears, 0)
})

for (const kind of ['chat', 'group'] as const) {
  test(`${kind}: one work keeps ordered reasoning/tools and a repeated employee work starts a new bubble`, async () => {
    let onEvent: (event: unknown) => void = () => {}
    const store = chatStore({
      abortConversation: async () => {}, getConversationState: async () => ({ prompting: true }),
      subscribeEvents: (options: { onEvent: typeof onEvent }) => { onEvent = options.onEvent; return { close() {} } },
    })
    const convId = 'work-conv'
    store.setState(kind === 'chat' ? { activeConvId: convId } : { activeGroupId: convId })
    store.getState().startAssistantStream(convId, { kind, expectedTargetsKnown: true, targetEmployeeIds: ['pm'] })
    const emit = (work: string, event: object) => onEvent({ source_employee_id: 'pm', work_id: work, ...event })
    try {
      emit('w1', { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'plan' } })
      emit('w1', { type: 'tool_execution_start', toolCallId: 'todo', toolName: 'todo_update' })
      emit('w1', { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'done' } })
      emit('w1', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'JD' } })
      emit('w2', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'second JD' } })
      const replies = store.getState().activeConvMessages
      assert.equal(replies.length, 2)
      assert.equal(replies[0].workId, 'w1')
      assert.equal(replies[0].content, 'JD')
      assert.deepEqual(Array.from(replies[0].thinkingSteps, (s: any) => s.kind), ['reasoning', 'tool', 'reasoning'])
      assert.equal(replies[1].workId, 'w2')
      assert.equal(replies[1].thinkingSteps, undefined)
    } finally { await store.getState().abortStream(convId) }
  })
}

for (const kind of ['chat', 'group'] as const) {
 test(`${kind}: resuming a work appends deltas to its loaded history bubble`, async () => {
  let onEvent: (event: unknown) => void = () => {}
  const store = chatStore({
    abortConversation: async () => {}, getConversationState: async () => ({ prompting: true }),
    subscribeEvents: (options: { onEvent: typeof onEvent }) => { onEvent = options.onEvent; return { close() {} } },
  })
  store.setState({ ...(kind === 'chat' ? { activeConvId: 'c' } : { activeGroupId: 'c' }), activeConvMessages: [{ id: 'history', role: 'assistant', senderEmployeeId: 'pm', workId: 'w1', content: 'start' }] })
  store.getState().startAssistantStream('c', { kind, expectedTargetsKnown: false })
  try {
    onEvent({ type: 'message_update', source_employee_id: 'pm', work_id: 'w1', assistantMessageEvent: { type: 'text_delta', delta: ' end' } })
    assert.equal(store.getState().activeConvMessages.length, 1)
    assert.equal(store.getState().activeConvMessages[0].id, 'history')
    assert.equal(store.getState().activeConvMessages[0].content, 'start end')
  } finally { await store.getState().abortStream('c') }
})

}

test('settlement and refresh preserve the same grouped reply as the live stream', async () => {
  let onEvent: (event: unknown) => void = () => {}
  const origin = { source_employee_id: 'pm', work_id: 'work' }
  const history = [
    { ...entry('u'), message: { role: 'user', content: 'write JD' } },
    { id: 'plan', type: 'message', ...origin, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'plan' }, { type: 'toolCall', id: 't', name: 'todo_update', arguments: { items: [] } }] } },
    { id: 'tool-result', type: 'message', ...origin, message: { role: 'toolResult', toolCallId: 't', tool_kind: 'todo', content: 'done' } },
    { id: 'answer', type: 'message', ...origin, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'finish' }, { type: 'text', text: 'JD' }] } },
  ]
  const store = chatStore({
    listEntries: async () => ({ entries: history }), getConversationState: async () => ({ prompting: false }),
    subscribeEvents: (options: { onEvent: typeof onEvent }) => { onEvent = options.onEvent; return { close() {} } },
  })
  store.setState({ activeGroupId: 'c', refreshConversations: async () => {} })
  store.getState().appendMessage('c', { id: 'u', role: 'user', content: 'write JD' })
  store.getState().startAssistantStream('c', { kind: 'group', expectedTargetsKnown: true, targetEmployeeIds: ['pm'] })
  const emit = (event: object) => onEvent({ ...origin, ...event })
  emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'plan' } })
  emit({ type: 'tool_execution_start', toolCallId: 't', toolName: 'todo_update', tool_kind: 'todo', args: { items: [] } })
  emit({ type: 'tool_execution_end', toolCallId: 't', toolName: 'todo_update', tool_kind: 'todo', result: 'done' })
  emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'finish' } })
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'JD' } })
  emit({ type: 'agent_settled' })
  const projection = () => JSON.parse(JSON.stringify(store.getState().activeConvMessages.map((m: any) => ({
    role: m.role, content: m.content, work: m.workId,
    steps: m.thinkingSteps?.map((s: any) => s.kind === 'reasoning' ? s : { kind: 'tool', id: s.tool.id, input: s.tool.input, result: s.tool.result }),
  }))))
  const live = projection()
  assert.equal(live.length, 2)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(projection(), live, 'automatic final history reconciliation')
  await store.getState().loadGroupConversation('c')
  assert.deepEqual(projection(), live, 'manual refresh')
  assert(store.getState().activeConvMessages[1].entryRefs.includes('answer'))
})

test('checklist updates keep one current card and the same snapshots across stream and refresh', async () => {
  let onEvent: (event: unknown) => void = () => {}
  const origin = { source_employee_id: 'pm', work_id: 'todo-work' }
  const snapshots = [
    { items: [{ id: 'draft', title: '整理报告', status: 'in_progress' }], item_count: 1 },
    { items: [{ id: 'draft', title: '整理报告', status: 'completed' }], item_count: 1 },
  ]
  const history = snapshots.flatMap((result, i) => [
    { id: `call-${i}`, type: 'message', ...origin, message: { role: 'assistant', content: [{ type: 'toolCall', id: `todo-${i}`, name: 'todo_update', arguments: { items: result.items } }] } },
    { id: `result-${i}`, type: 'message', ...origin, message: { role: 'toolResult', toolCallId: `todo-${i}`, tool_kind: 'todo', result, content: JSON.stringify(result) } },
  ])
  const store = chatStore({
    listEntries: async () => ({ entries: history }), getConversationState: async () => ({ prompting: false }),
    abortConversation: async () => {},
    subscribeEvents: (options: { onEvent: typeof onEvent }) => { onEvent = options.onEvent; return { close() {} } },
  })
  store.setState({ activeGroupId: 'c', refreshConversations: async () => {} })
  store.getState().startAssistantStream('c', { kind: 'group', expectedTargetsKnown: true, targetEmployeeIds: ['pm'] })
  const projection = () => {
    const messages = store.getState().activeConvMessages
    assert.equal(messages.length, 1)
    const msg = messages[0]
    return JSON.parse(JSON.stringify({
      cards: collectTodoTaskCards(msg.thinkingSteps, msg.toolCalls),
      snapshots: msg.thinkingSteps.filter((s: any) => s.kind === 'tool').map((s: any) => s.tool.resultValue),
    }))
  }
  try {
    for (const [i, result] of snapshots.entries()) {
      const call = { ...origin, toolCallId: `todo-${i}`, toolName: 'todo_update', tool_kind: 'todo' }
      onEvent({ ...call, type: 'tool_execution_start', args: { items: result.items } })
      onEvent({ ...call, type: 'tool_execution_end', result })
      // Replayed end events must update the existing step, not add a snapshot.
      onEvent({ ...call, type: 'tool_execution_end', result })
      const current = projection()
      assert.deepEqual(current.cards, [{ callId: `todo-${i}`, items: result.items }])
      assert.equal(current.snapshots.length, i + 1)
    }
    const live = projection()
    onEvent({ ...origin, type: 'agent_settled' })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(projection(), live, 'settlement preserves current card and history')
    await store.getState().loadGroupConversation('c')
    assert.deepEqual(projection(), live, 'refresh preserves current card and history')
  } finally { await store.getState().abortStream('c') }
})

const failedReply = (id: string, work: string, errorMessage?: string) => ({
  id, entry_ref: `ref-${id}`, type: 'message', work_id: work, source_employee_id: 'pm',
  message: { role: 'assistant', content: [], stopReason: 'error', ...(errorMessage ? { errorMessage } : {}) },
})

test('failures are explained in plain words and keep the original error as detail', () => {
  assert.deepEqual(assistantFailure({ role: 'assistant', content: [], stopReason: 'error', errorMessage: ' 401 Unauthorized ' }),
    { kind: 'model', summary: '抱歉，模型服务授权异常，请联系管理员。', detail: '401 Unauthorized' })
  assert.deepEqual(assistantFailure({ role: 'assistant', content: [], stopReason: 'error' }), { kind: 'model', summary: '抱歉，这条消息没能回复，请稍后再试。' })
  assert.equal(assistantFailure({ role: 'assistant', content: [], stopReason: 'stop', errorMessage: 'stale' }), undefined)
  assert.equal(assistantFailure({ role: 'user', content: 'hi', stopReason: 'error' }), undefined)
  for (const [raw, summary] of [
    ['429 Too Many Requests', '抱歉，模型额度暂时用满，请稍后再试。'],
    ['insufficient_quota', '抱歉，模型额度暂时用满，请稍后再试。'],
    ['503 Service Unavailable', '抱歉，模型服务繁忙，请稍后再试。'],
    ['Overloaded', '抱歉，模型服务繁忙，请稍后再试。'],
    ['fetch failed: ECONNREFUSED', '抱歉，网络连接中断，请稍后再试。'],
    ["Cannot find module 'x'", '抱歉，程序加载异常，请联系管理员。'],
    ['Manager returned HTTP 404', '抱歉，暂未找到该员工的配置，请联系管理员。'],
    ['something odd', '抱歉，这次没能开始处理，请稍后再试。'],
  ] as const) assert.equal(describeFailure('execution', raw).summary, summary, raw)
  assert.deepEqual(settledFailure({ type: 'agent_settled', failed: true, error_message: 'Manager returned HTTP 404' } as any),
    { kind: 'execution', summary: '抱歉，暂未找到该员工的配置，请联系管理员。', detail: 'Manager returned HTTP 404' })
  assert.deepEqual(settledFailure({ type: 'agent_settled', failed: true } as any), { kind: 'execution', summary: '抱歉，这次没能开始处理，请稍后再试。' })
  assert.equal(settledFailure({ type: 'agent_settled', failed: false, error_message: 'x' } as any), undefined)
  assert.equal(settledFailure({ type: 'agent_settled' } as any), undefined)
})

test('the technical detail hides paths on screen; the copy keeps them for developers', () => {
  const raw = "Cannot find module '~/app/node_modules/x/a.js' imported from /Users/someone/app/b.js. See C:\\Fred\\c.js"
  assert.equal(displayDetail(raw), "Cannot find module '[路径已隐藏]' imported from [路径已隐藏]. See [路径已隐藏]")
  assert.equal(displayDetail('401 Unauthorized'), '401 Unauthorized')
  assert.equal(displayDetail('ratio 1/2 and a lone ~ stay'), 'ratio 1/2 and a lone ~ stay')
  // The failure itself keeps the full text, which is what「复制」puts on the clipboard.
  assert.equal(describeFailure('model', raw).detail, raw)
})

test('history keeps the failure as its own field, last attempt of a work wins', () => {
  const [failed] = entriesToMessages([failedReply('e1', 'w1', '401 Unauthorized')] as any)
  assert.equal(failed.content, '')
  assert.equal(failed.failure?.detail, '401 Unauthorized')

  // The failure follows the text already written in the same work; the text stays clean for copying.
  const partial = { id: 'p1', entry_ref: 'ref-p1', type: 'message', work_id: 'w2', source_employee_id: 'pm',
    message: { role: 'assistant', content: [{ type: 'text', text: '先写好了一半' }], stopReason: 'toolUse' } }
  const [cut] = entriesToMessages([partial, failedReply('e2', 'w2', 'overloaded')] as any)
  assert.equal(cut.content, '先写好了一半')
  assert.equal(cut.failure?.summary, '抱歉，模型服务繁忙，请稍后再试。')

  // An automatic retry that succeeded hides the earlier failure of the same work.
  const retried = { id: 'r1', entry_ref: 'ref-r1', type: 'message', work_id: 'w3', source_employee_id: 'pm',
    message: { role: 'assistant', content: [{ type: 'text', text: '重试后成功' }], stopReason: 'stop' } }
  const [ok] = entriesToMessages([failedReply('e3', 'w3', '429'), retried] as any)
  assert.equal(ok.content, '重试后成功')
  assert.equal('failure' in ok, false)
  const [plain] = entriesToMessages([retried] as any)
  assert.equal('failure' in plain, false)
})

test('a body the Agent cut at its length cap is flagged, also after merging a work', () => {
  const reply = (id: string, text: string, truncated?: boolean) => ({ id, entry_ref: `ref-${id}`, type: 'message', work_id: 'w1', source_employee_id: 'pm',
    message: { role: 'assistant', content: [{ type: 'text', text, ...(truncated ? { truncated } : {}) }], stopReason: 'stop' } })
  const [full] = entriesToMessages([reply('a', '完整的长报告')] as any)
  assert.equal(full.content, '完整的长报告')
  assert.equal('truncated' in full, false)
  const [merged] = entriesToMessages([reply('b', '前半…', true), reply('c', '后续')] as any)
  assert.equal(merged.content, '前半…\n\n后续')
  assert.equal(merged.truncated, true)
})

test('a reply saved as a file keeps its full text and gets a preview, also as the last part of a work', () => {
  const file = { id: 'file-1', filename: '总结-1105-2010.md', path: '回复/总结-1105-2010.md', chars: 2_001 }
  const reply = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ id, entry_ref: `ref-${id}`, type: 'message', work_id: 'w1', source_employee_id: 'pm',
    message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' }, ...extra })
  const long = `第一段\n${'长'.repeat(2_000)}`
  const [single] = entriesToMessages([reply('a', long, { reply_file: file })] as any)
  assert.equal(single.content, long)
  assert.deepEqual(single.replyFile, file)
  assert.equal(single.replyPreview, replyPreview(long))

  const [merged] = entriesToMessages([reply('b', '我先查一下资料。'), reply('c', long, { reply_file: file })] as any)
  assert.equal(merged.content, `我先查一下资料。\n\n${long}`)
  assert.equal(merged.replyPreview, `我先查一下资料。\n\n${replyPreview(long)}`)

  const [later] = entriesToMessages([reply('d', long, { reply_file: file }), reply('e', '补充一句')] as any)
  assert.equal('replyFile' in later, false, 'a file that is not the last part would hide the later text')

  const checklist = { id: 'g', entry_ref: 'ref-g', type: 'message', work_id: 'w1', source_employee_id: 'pm',
    message: { role: 'assistant', content: [{ type: 'toolCall', id: 'todo', name: 'todo_update', arguments: {} }], stopReason: 'toolUse' } }
  const [closed] = entriesToMessages([reply('b', '我先查一下资料。'), reply('c', long, { reply_file: file }), checklist] as any)
  assert.deepEqual(closed.replyFile, file, 'a tool-only entry after the reply keeps the card')
  assert.equal(closed.replyPreview, `我先查一下资料。\n\n${replyPreview(long)}`)
  assert.equal(closed.toolCalls?.length ?? closed.thinkingSteps?.length, 1)

  for (const broken of [{ ...file, chars: '2001' }, { ...file, id: '' }, 'file-1', null]) {
    const [message] = entriesToMessages([reply('f', long, { reply_file: broken })] as any)
    assert.equal('replyFile' in message, false, JSON.stringify(broken))
  }
})

test('reply preview cuts near 500 characters at a line break and closes an open code block', () => {
  assert.equal(replyPreview('短回复'), '短回复')
  const lines = Array.from({ length: 40 }, (_, index) => `第 ${index} 行：${'内容'.repeat(5)}`).join('\n')
  const preview = replyPreview(lines)
  assert.ok(Array.from(preview).length <= 504)
  assert.match(preview, /行：(内容)+\n\n…$/u, 'ends on a whole line')
  assert.equal(Array.from(replyPreview('😀'.repeat(600))).length, 503, 'counts characters, not UTF-16 units')
  const code = replyPreview(`说明\n\`\`\`python\n${'x = 1\n'.repeat(200)}`)
  assert.match(code, /\n```\n\n…$/u)
  assert.equal((code.match(/```/g) ?? []).length, 2)
})

test('reply preview stops before a table it would cut and keeps whole rows when the table comes first', () => {
  const row = (index: number) => `| ${index} | ${'项目'.repeat(20)} |`
  const table = (rows: number) => ['| 排名 | 名称 |', '| :---: | :--- |', ...Array.from({ length: rows }, (_, index) => row(index))].join('\n')
  const tail = `\n\n${'后续内容。'.repeat(200)}`

  assert.equal(replyPreview(`开场说明：\n\n${table(40)}${tail}`), '开场说明：\n\n…', 'cut across the rows')
  const wide = `开场说明：\n\n| 排名 | 名称 |\n| --- | --- |\n| 1 | ${'宽'.repeat(900)} |`
  assert.equal(replyPreview(wide), '开场说明：\n\n…', 'cut inside a row with no line break nearby')
  const fitting = `开场说明：\n\n${table(3)}${tail}`
  assert.ok(replyPreview(fitting).includes(row(2)), 'a table that fits stays whole')

  const first = replyPreview(`${table(40)}${tail}`).split('\n')
  assert.deepEqual(first.slice(0, 3), ['| 排名 | 名称 |', '| :---: | :--- |', row(0)])
  assert.equal(first[first.length - 1], '…')
  assert.ok(first.slice(0, -2).every((line) => line.endsWith('|')), 'only whole rows')
  assert.ok(replyPreview(`| 排名 | 名称 |\n| --- | --- |\n| 1 | ${'宽'.repeat(900)} |`).includes('宽'.repeat(900)), 'the first row is kept whole even past the limit')

  const piped = `说明\n${Array.from({ length: 60 }, (_, index) => `| 不是表格 ${index} ${'内容'.repeat(5)}`).join('\n')}`
  assert.match(replyPreview(piped), /\| 不是表格 \d+ (内容)+\n\n…$/u, 'pipes without a rule line are ordinary text')
  const fenced = replyPreview(`说明\n\`\`\`\n${table(40)}`)
  assert.match(fenced, /\|\n```\n\n…$/u, 'a table inside a code block stays as code')
})

test('assistant message_end reports a failure only for failed model calls', () => {
  const seen: Array<[string | undefined, string | undefined]> = []
  const unknown: string[] = []
  const callbacks = { onAssistantEnd: (failure: any, src?: string) => seen.push([failure?.detail, src]), onUnknown: (event: any) => unknown.push(event.type) }
  dispatchPiEvent({ type: 'message_end', source_employee_id: 'pm', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'boom' } } as any, callbacks)
  dispatchPiEvent({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'stop' } } as any, callbacks)
  dispatchPiEvent({ type: 'message_end', message: { role: 'user', content: 'hi' } } as any, callbacks)
  assert.deepEqual(seen, [['boom', 'pm'], [undefined, undefined]])
  assert.deepEqual(unknown, ['message_end'])
})

test('local failures attach to the same work, otherwise append, and never override history', () => {
  const failure = { kind: 'execution' as const, summary: '抱歉，这次没能开始处理，请稍后再试。' }
  const history = [
    { id: 'u', role: 'user', content: 'hi' },
    { id: 'a', role: 'assistant', content: 'half', workId: 'w1', senderEmployeeId: 'pm' },
  ]
  const local = { id: 'pending', role: 'assistant', content: '' }
  assert.deepEqual(applyLocalFailures(history, []), history)
  assert.deepEqual(applyLocalFailures(history, [{ workId: 'w1', message: local, failure }])[1], { ...history[1], failure })
  assert.deepEqual(applyLocalFailures(history, [{ workId: 'w1', senderEmployeeId: 'other', message: local, failure }]).map(m => m.id), ['u', 'a', 'pending'])
  assert.deepEqual(applyLocalFailures(history, [{ message: local, failure }]).map(m => m.id), ['u', 'a', 'pending'])
  const persisted = { ...history[1], failure: { kind: 'model' as const, summary: '抱歉，这条消息没能回复，请稍后再试。' } }
  assert.equal(applyLocalFailures([history[0], persisted], [{ workId: 'w1', message: local, failure }])[1].failure, persisted.failure)
})

test('retry is offered only for a last failed reply to a text-only message', () => {
  const failure = { kind: 'model' as const, summary: 'x' }
  const user = { id: 'u', role: 'user', content: ' 做个小游戏 ' }
  const failed = { id: 'f', role: 'assistant', content: '', failure }
  assert.deepEqual(retryTarget([user, failed]), { failedId: 'f', text: '做个小游戏' })
  assert.equal(retryTarget([user, { ...failed, failure: undefined }]), null)
  assert.equal(retryTarget([user, failed, { id: 'n', role: 'assistant', content: 'later' }]), null)
  assert.equal(retryTarget([{ ...user, attachments: [{}] }, failed]), null)
  assert.equal(retryTarget([failed]), null)
})

for (const [label, events, expected] of [
  ['a failed model call', [{ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: "Cannot find module 'x'" } }],
    { content: '', detail: "Cannot find module 'x'" }],
  ['a retried model call', [{ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '429' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '重试成功' } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '重试成功' }], stopReason: 'stop' } }],
    { content: '重试成功', detail: undefined }],
  ['a pre-execution failure', [{ type: 'agent_settled', failed: true, error_message: 'Manager returned HTTP 404' }],
    { content: '', detail: 'Manager returned HTTP 404' }],
] as const) {
  test(`live run with ${label} shows the right failure, also after the post-run history sync`, async () => {
    let onEvent: (event: any) => void = () => {}
    let synced!: () => void
    const sync = new Promise<void>((resolve) => { synced = resolve })
    const store = chatStore({
      abortConversation: async () => {},
      // The Agent keeps no history for a run that failed before it started.
      listEntries: async () => { setTimeout(synced, 0); return { entries: [] } },
      getConversationState: async () => ({ prompting: false }),
      subscribeEvents: (options: { onEvent: typeof onEvent }) => {
        onEvent = options.onEvent
        return { close() {} }
      },
    })
    store.getState().setActiveConvId('failing')
    store.getState().startAssistantStream('failing')
    for (const event of events) onEvent(event)
    if (events[events.length - 1].type !== 'agent_settled') onEvent({ type: 'agent_settled' })
    const replies = () => store.getState().activeConvMessages.filter((message: any) => message.role === 'assistant')
    assert.equal(replies().length, 1)
    assert.equal(replies()[0].content, expected.content)
    assert.equal(replies()[0].failure?.detail, expected.detail)
    await sync
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (expected.detail) {
      assert.equal(replies().length, 1, 'the failure survives the history sync')
      assert.equal(replies()[0].failure?.detail, expected.detail)
    }
    // The next round replaces it.
    store.getState().startAssistantStream('failing')
    await store.getState().refreshActiveEntries?.('failing').catch(() => {})
    store.getState().abortStream('failing')
  })
}

test('after a restart the stored pre-execution failure is shown again until the next run', async () => {
  const stored = { employee_id: null, work_id: 'w9', error_code: 'manager_unavailable', error_message: 'Manager returned HTTP 404', failed_at: '2026-11-04T08:00:00.000Z' }
  const user = { id: 'u1', entry_ref: 'ref-u1', type: 'message', work_id: 'w9', message: { role: 'user', content: '做个小游戏' } }
  let failures: any[] = [stored]
  const store = chatStore({
    abortConversation: async () => {},
    listEntries: async () => ({ entries: [user] }),
    getConversationState: async () => ({ prompting: false, failures }),
    subscribeEvents: () => ({ close() {} }),
  })
  store.getState().setActiveConvId('restarted')
  await store.getState().loadConversation('restarted')
  const replies = () => store.getState().activeConvMessages.filter((message: any) => message.role === 'assistant')
  assert.equal(replies().length, 1)
  assert.equal(replies()[0].content, '')
  assert.deepEqual(replies()[0].failure, { kind: 'execution', summary: '抱歉，暂未找到该员工的配置，请联系管理员。', detail: 'Manager returned HTTP 404' })

  // The next run supersedes it, on the Agent and here.
  store.getState().startAssistantStream('restarted')
  failures = []
  await store.getState().abortStream('restarted')
  await store.getState().loadConversation('restarted')
  assert.equal(replies().length, 0)
})

test('a stored group failure is attached to the participant that failed', async () => {
  const stored = { employee_id: 'pm', work_id: null, error_code: 'execution_failed', error_message: 'fetch failed', failed_at: '2026-11-04T08:00:00.000Z' }
  const store = chatStore({
    abortConversation: async () => {},
    listEntries: async () => ({ entries: [] }),
    getConversationState: async () => ({ prompting: false, failures: [stored] }),
    subscribeEvents: () => ({ close() {} }),
  })
  store.setState({ groups: [{ id: 'g1', name: 'G', members: [{ employee_id: 'pm', display_name: '产品经理' }] }] })
  store.getState().setActiveGroupId('g1')
  await store.getState().loadGroupConversation('g1')
  const [reply] = store.getState().activeConvMessages
  assert.equal(reply.senderEmployeeId, 'pm')
  assert.equal(reply.senderName, '产品经理')
  assert.equal(reply.failure.summary, '抱歉，网络连接中断，请稍后再试。')
})
