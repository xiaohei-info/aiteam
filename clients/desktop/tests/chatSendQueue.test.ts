import test from 'node:test'
import assert from 'node:assert/strict'
import {
  enqueueMessage,
  moveQueuedMessage,
  prependQueuedMessage,
  promoteQueuedMessage,
  removeQueuedMessage,
  renameQueue,
  replaceQueuedMessage,
  shouldDispatchQueue,
  takeNextQueuedMessage,
  type ChatSendQueues,
  type QueuedChatMessage,
} from '../src/lib/chatSendQueue.ts'

const msg = (id: string): QueuedChatMessage => ({ id, text: id, files: [] })
const ids = (queues: ChatSendQueues, convId: string) => (queues[convId] ?? []).map((item) => item.id)

const seeded = (): ChatSendQueues => ['a', 'b', 'c'].reduce<ChatSendQueues>(
  (queues, id) => enqueueMessage(queues, 'conv-1', msg(id)), {},
)

test('enqueue appends per conversation and keeps conversations isolated', () => {
  const queues = enqueueMessage(seeded(), 'conv-2', msg('x'))
  assert.deepEqual(ids(queues, 'conv-1'), ['a', 'b', 'c'])
  assert.deepEqual(ids(queues, 'conv-2'), ['x'])
})

test('take returns the head in FIFO order and drops empty queues', () => {
  let queues: ChatSendQueues = enqueueMessage({}, 'conv-1', msg('a'))
  const first = takeNextQueuedMessage(queues, 'conv-1')
  assert.equal(first.message?.id, 'a')
  queues = first.queues
  assert.equal('conv-1' in queues, false)
  assert.equal(takeNextQueuedMessage(queues, 'conv-1').message, undefined)
})

test('failed head goes back to the front', () => {
  const { message, queues } = takeNextQueuedMessage(seeded(), 'conv-1')
  assert.deepEqual(ids(prependQueuedMessage(queues, 'conv-1', message!), 'conv-1'), ['a', 'b', 'c'])
})

test('move reorders by drag target', () => {
  assert.deepEqual(ids(moveQueuedMessage(seeded(), 'conv-1', 'c', 'a'), 'conv-1'), ['c', 'a', 'b'])
  assert.deepEqual(ids(moveQueuedMessage(seeded(), 'conv-1', 'a', 'c'), 'conv-1'), ['b', 'c', 'a'])
  const unchanged = seeded()
  assert.equal(moveQueuedMessage(unchanged, 'conv-1', 'a', 'missing'), unchanged)
})

test('promote moves an item to the head', () => {
  assert.deepEqual(ids(promoteQueuedMessage(seeded(), 'conv-1', 'c'), 'conv-1'), ['c', 'a', 'b'])
})

test('remove and replace', () => {
  assert.deepEqual(ids(removeQueuedMessage(seeded(), 'conv-1', 'b'), 'conv-1'), ['a', 'c'])
  assert.deepEqual(ids(replaceQueuedMessage(seeded(), 'conv-1', 'b', msg('n')), 'conv-1'), ['a', 'n', 'c'])
  assert.deepEqual(ids(replaceQueuedMessage(seeded(), 'conv-1', 'b', null), 'conv-1'), ['a', 'c'])
})

test('rename migrates an emp_ queue behind the real conversation queue', () => {
  const queues = renameQueue(enqueueMessage(seeded(), 'conv-2', msg('x')), 'conv-1', 'conv-2')
  assert.equal('conv-1' in queues, false)
  assert.deepEqual(ids(queues, 'conv-2'), ['x', 'a', 'b', 'c'])
})

test('dispatch only when idle', () => {
  const idle = { queueLength: 1, isGenerating: false, isSyncing: false, disabled: false, isSubmitting: false }
  assert.equal(shouldDispatchQueue(idle), true)
  assert.equal(shouldDispatchQueue({ ...idle, queueLength: 0 }), false)
  assert.equal(shouldDispatchQueue({ ...idle, isGenerating: true }), false)
  // 生成结束后的历史对齐会整体替换消息列表，必须等它完成再发下一条。
  assert.equal(shouldDispatchQueue({ ...idle, isSyncing: true }), false)
  assert.equal(shouldDispatchQueue({ ...idle, disabled: true }), false)
  assert.equal(shouldDispatchQueue({ ...idle, isSubmitting: true }), false)
})
