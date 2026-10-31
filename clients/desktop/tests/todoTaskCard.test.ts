import assert from 'node:assert/strict'
import test from 'node:test'
import { entriesToMessages, dispatchPiEvent } from '../src/lib/piConverters.ts'
import {
  collectTodoTaskCards,
  parseTodoTaskCard,
  resolveTodoTaskDisplayStatus,
  toTodoTaskDisplay,
  withToolCallSteps,
} from '../src/lib/todoTaskCard.ts'
import type { ConversationEntry, PiSseEventData } from '../src/api/agent/types.ts'
import type { ThinkingStep, ToolCall } from '../src/stores/chat.ts'

const items = [
  { id: 'research', title: '完成调研', status: 'completed' as const },
  { id: 'draft', title: '整理报告', status: 'in_progress' as const },
]

test('todo_update accepts only the strict FredServer todo schema', () => {
  const card = parseTodoTaskCard({
    id: 'call-1',
    name: 'todo_update',
    toolKind: 'todo',
    resultValue: { items, item_count: 2 },
  })
  assert.deepEqual(card, { callId: 'call-1', items })

  for (const call of [
    { id: 'unknown', name: 'custom_tool', resultValue: { items } },
    { id: 'error', name: 'todo_update', isError: true, resultValue: { items } },
    { id: 'bad-status', name: 'todo_update', resultValue: { items: [{ id: '1', title: 'x', status: 'done' }] } },
    { id: 'duplicate', name: 'todo_update', resultValue: { items: [items[0], items[0]] } },
    { id: 'extra', name: 'todo_update', resultValue: { items: [{ ...items[0], action: 'open' }] } },
    { id: 'count', name: 'todo_update', resultValue: { items, item_count: 3 } },
  ] as ToolCall[]) {
    assert.equal(parseTodoTaskCard(call), null, call.id)
  }
})

test('task cards prefer authoritative results and retain all execution steps', () => {
  const todoCall: ToolCall = {
    id: 'todo',
    name: 'todo_update',
    input: { items: [{ ...items[1], status: 'pending' }] },
    result: JSON.stringify({ items, item_count: 2 }),
  }
  const ordinaryCall: ToolCall = { id: 'read', name: 'read', input: { value: 'safe' } }
  const steps: ThinkingStep[] = [
    { kind: 'reasoning', text: '分析中' },
    { kind: 'tool', tool: todoCall },
    { kind: 'tool', tool: ordinaryCall },
  ]

  assert.deepEqual(collectTodoTaskCards(steps, undefined), [{ callId: 'todo', items }])
  assert.deepEqual(withToolCallSteps(steps, [todoCall, ordinaryCall]), steps)
})

test('history toolResult preserves structured todo data and links it to the original tool call', () => {
  const entries: ConversationEntry[] = [
    {
      id: 'assistant-1',
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'todo-1', name: 'todo_update', arguments: { items } }],
      },
    },
    {
      id: 'result-1',
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'todo-1',
        toolName: 'todo_update',
        tool_kind: 'todo',
        content: [{ type: 'text', text: JSON.stringify({ items, item_count: 2 }) }],
        result: { items, item_count: 2 },
      },
    },
  ]

  const messages = entriesToMessages(entries)
  assert.equal(messages.length, 1)
  const call = messages[0].toolCalls?.[0]
  assert.equal(call?.toolKind, 'todo')
  assert.deepEqual(call?.resultValue, { items, item_count: 2 })
  assert.deepEqual(call ? parseTodoTaskCard(call) : null, { callId: 'todo-1', items })
})

test('live todo SSE keeps tool kind and structured result for the same card path', () => {
  const calls: ToolCall[] = []
  dispatchPiEvent({
    type: 'tool_execution_end',
    toolCallId: 'todo-live',
    toolName: 'todo_update',
    tool_kind: 'todo',
    result: { items, item_count: 2 },
  } as PiSseEventData, {
    onToolCall: (call) => calls.push(call),
  })

  assert.equal(calls[0].toolKind, 'todo')
  assert.deepEqual(parseTodoTaskCard(calls[0]), { callId: 'todo-live', items })
})

const update = (id: string, nextItems = items): ToolCall => ({
  id, name: 'todo_update', resultValue: { items: nextItems, item_count: nextItems.length },
})

test('each checklist update replaces the current card while retaining ordered snapshots', () => {
  const first = update('first')
  const completed = update('completed', items.map(item => ({ ...item, status: 'completed' })))
  const steps: ThinkingStep[] = [
    { kind: 'tool', tool: first },
    { kind: 'reasoning', text: '正在整理报告' },
    { kind: 'tool', tool: completed },
  ]
  assert.deepEqual(collectTodoTaskCards(steps.slice(0, 1), [first]), [parseTodoTaskCard(first)])
  assert.deepEqual(collectTodoTaskCards(steps, [first, completed]), [parseTodoTaskCard(completed)])
  assert.deepEqual(withToolCallSteps(steps, [first, completed]), steps)
})

test('replacement supports changing IDs, removing, reordering and clearing items', () => {
  const first = update('first')
  for (const nextItems of [[items[1]], [items[1], items[0]], [{ ...items[1], id: 'new' }], []]) {
    const next = update('next', nextItems)
    assert.deepEqual(collectTodoTaskCards(undefined, [first, next]), [parseTodoTaskCard(next)])
  }
})

test('failed or malformed updates keep the previous valid card and remain in the process', () => {
  const first = update('first')
  for (const invalid of [
    { ...update('failed'), isError: true },
    { id: 'malformed', name: 'todo_update', resultValue: { items: 'invalid' } },
  ]) {
    assert.deepEqual(collectTodoTaskCards(undefined, [first, invalid]), [parseTodoTaskCard(first)])
    assert.deepEqual(withToolCallSteps(undefined, [first, invalid]), [
      { kind: 'tool', tool: first }, { kind: 'tool', tool: invalid },
    ])
  }
})

test('legacy tool-only messages retain one step per call in execution order', () => {
  const first = update('first')
  const second = update('second', [])
  assert.deepEqual(withToolCallSteps(undefined, [first, first, second]), [
    { kind: 'tool', tool: first }, { kind: 'tool', tool: second },
  ])
  assert.equal(withToolCallSteps(undefined, undefined), undefined)
})

test('refreshed history keeps one latest checklist per employee execution', () => {
  const history: ConversationEntry[] = []
  for (const [workId, employee, calls] of [
    ['w1', 'pm', [update('initial'), update('complete', items.map(item => ({ ...item, status: 'completed' })))]],
    ['w2', 'pm', [update('new-reply')]],
    ['w1', 'developer', [update('other-employee')]],
  ] as const) {
    for (const call of calls) {
      history.push({
        id: `${employee}-${call.id}`, type: 'message', work_id: workId, source_employee_id: employee,
        message: { role: 'assistant', content: [{ type: 'toolCall', id: call.id, name: call.name, arguments: call.resultValue }] },
      }, {
        id: `${employee}-${call.id}-result`, type: 'message', work_id: workId, source_employee_id: employee,
        message: { role: 'toolResult', toolCallId: call.id, result: call.resultValue, content: JSON.stringify(call.resultValue) },
      })
    }
  }
  const messages = entriesToMessages(history)
  assert.equal(messages.length, 3)
  assert.deepEqual(messages.map(msg => collectTodoTaskCards(msg.thinkingSteps, msg.toolCalls).map(card => card.callId)), [
    ['complete'], ['new-reply'], ['other-employee'],
  ])
  assert.equal(messages[0].thinkingSteps?.filter(step => step.kind === 'tool').length, 2)
})

test('settled replies degrade in_progress items to the terminal unfinished display state', () => {
  const card = { callId: 'todo', items }

  assert.deepEqual(
    toTodoTaskDisplay(card, true).items.map(item => item.displayStatus),
    ['completed', 'in_progress'],
  )

  const settled = toTodoTaskDisplay(card, false)
  assert.deepEqual(settled.items.map(item => item.displayStatus), ['completed', 'unfinished'])
  assert.equal(settled.completed, 1)
  assert.equal(settled.unfinished, 1)
  assert.equal(settled.total, 2)
  assert.equal(settled.allCompleted, false)

  assert.equal(resolveTodoTaskDisplayStatus('in_progress', false), 'unfinished')
  assert.equal(resolveTodoTaskDisplayStatus('in_progress', true), 'in_progress')
  assert.equal(resolveTodoTaskDisplayStatus('pending', false), 'pending')
  assert.equal(resolveTodoTaskDisplayStatus('completed', false), 'completed')
})

test('allCompleted only holds for a non-empty fully completed card', () => {
  assert.equal(toTodoTaskDisplay({ callId: 't', items: [items[0]] }, false).allCompleted, true)
  assert.equal(toTodoTaskDisplay({ callId: 't', items: [] }, false).allCompleted, false)
  assert.equal(toTodoTaskDisplay({ callId: 't', items: [items[0]] }, true).allCompleted, true)
})
