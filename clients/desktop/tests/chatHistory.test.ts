import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { webcrypto } from 'node:crypto'
import { dispatchPiEvent, entriesToMessages, resolvePiEventSenderIdentity } from '../src/lib/piConverters.ts'
import { createSettleTracker } from '../src/lib/groupStreamLifecycle.ts'
import { classifyRequestError } from '../src/lib/requestError.ts'
import { collectTodoTaskCards } from '../src/lib/todoTaskCard.ts'
import { mergeReplyProjection, reconcileReplyProjection } from '../src/lib/replyProjection.ts'

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
