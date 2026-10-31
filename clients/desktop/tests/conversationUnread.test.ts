import assert from 'node:assert/strict'
import test from 'node:test'
import { countUnreadReplies, fillConversationUnreadCounts } from '../src/lib/conversationUnread.ts'
import { dispatchPiEvent } from '../src/lib/piConverters.ts'
import type { ConversationEntry, ConversationMetadata } from '../src/api/agent/types.ts'

const reply = (id: string): ConversationEntry => ({ id, type: 'message', message: { role: 'assistant', content: '回复' } })

test('按已读锚点之后的真实员工回复统计，排除用户、思考、工具和系统条目', () => {
  const entries: ConversationEntry[] = [
    reply('z-read'),
    { id: 'user', type: 'message', message: { role: 'user', content: '你好' } },
    { id: 'thinking', type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '分析' }] } },
    { id: 'tool', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'search' }] } },
    { id: 'result', type: 'message', message: { role: 'toolResult', content: '结果' } },
    { id: 'system', type: 'compaction' },
    reply('a-unread'), reply('a-unread'),
    { ...reply('image'), message: { role: 'assistant', content: [{ type: 'image' }] } },
  ]
  assert.equal(countUnreadReplies(entries, 'z-read'), 2)
  assert.equal(countUnreadReplies(entries, null), 3)
  assert.equal(countUnreadReplies(entries, 'image'), 0)
  assert.equal(countUnreadReplies(entries, 'missing'), undefined)
})

test('群聊员工转交消息计入回复，同一 logical_message_id 只计一次', () => {
  const first = { ...reply('first'), logical_message_id: 'shared' }
  const mirror = { ...reply('mirror'), logical_message_id: 'shared', source_type: 'employee' as const, message: { role: 'user' as const, content: '员工转交' } }
  assert.equal(countUnreadReplies([first, mirror], null), 1)
  assert.equal(countUnreadReplies([first, mirror], 'first'), 0)
})

test('已有后台计数时不请求历史，旧后台按真实条目补齐，失败不伪造零未读', async () => {
  const conversations = [
    { id: 'server', unread_count: 4, last_read_entry_id: null },
    { id: 'legacy', last_read_entry_id: 'read' },
    { id: 'failed', last_read_entry_id: null },
  ] as ConversationMetadata[]
  const requested: string[] = []
  const result = await fillConversationUnreadCounts(conversations, async (id) => {
    requested.push(id)
    if (id === 'failed') throw new Error('offline')
    return { entries: [reply('read'), reply('new')] }
  })
  assert.deepEqual(requested, ['legacy', 'failed'])
  assert.deepEqual(result.map((item) => item.unread_count), [4, 1, undefined])
})

test('流事件把思考、正文、工具和完成状态分开，agent_end 不作为完成', () => {
  const events: string[] = []
  const callbacks = {
    onDelta: (text: string) => events.push(`text:${text}`),
    onThinkingDelta: (text: string) => events.push(`thinking:${text}`),
    onToolCall: () => events.push('tool'),
    onSettled: () => events.push('settled'),
  }
  dispatchPiEvent({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '分析' } }, callbacks)
  dispatchPiEvent({ type: 'tool_execution_start', toolCallId: 'call', toolName: 'search' }, callbacks)
  dispatchPiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '答复' } }, callbacks)
  dispatchPiEvent({ type: 'agent_end' }, callbacks)
  assert.deepEqual(events, ['thinking:分析', 'tool', 'text:答复'])
  dispatchPiEvent({ type: 'agent_settled' }, callbacks)
  assert.equal(events.at(-1), 'settled')
})

test('窗口可见且拥有焦点才允许自动已读，恢复焦点后重新满足条件', async () => {
  const { isAppFocused } = await import('../src/hooks/useAppFocus.ts')
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  let focused = true
  const documentState = { visibilityState: 'visible', hasFocus: () => focused }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentState })
  try {
    assert.equal(isAppFocused(), true)
    focused = false
    assert.equal(isAppFocused(), false)
    documentState.visibilityState = 'hidden'
    focused = true
    assert.equal(isAppFocused(), false)
    documentState.visibilityState = 'visible'
    assert.equal(isAppFocused(), true)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})
