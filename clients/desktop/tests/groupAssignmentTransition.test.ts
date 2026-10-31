import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldShowGroupAssignmentTransition } from '../src/lib/groupAssignmentTransition.ts'

test('群聊提交成功后、首个员工流事件到达前显示分配状态', () => {
  assert.equal(shouldShowGroupAssignmentTransition(
    true,
    [{ id: 'user-1', role: 'user' }],
    new Set(),
  ), true)
})

test('首个员工占位消息出现后由真实思考气泡接替分配状态', () => {
  assert.equal(shouldShowGroupAssignmentTransition(
    true,
    [
      { id: 'user-1', role: 'user' },
      { id: 'pending-group-1-worker-1', role: 'assistant', _pending: true },
    ],
    new Set(['pending-group-1-worker-1']),
  ), false)
})

test('会话终态或普通历史消息不会显示分配状态', () => {
  assert.equal(shouldShowGroupAssignmentTransition(
    false,
    [{ id: 'assistant-1', role: 'assistant' }],
    new Set(),
  ), false)
})
