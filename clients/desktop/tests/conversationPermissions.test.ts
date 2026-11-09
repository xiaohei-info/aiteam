import assert from 'node:assert/strict'
import test from 'node:test'
import { isDraftConversation, permissionSummary } from '../src/lib/conversationPermissions.ts'

test('permissionSummary 汇总会话权限与已开启目录数，0 个目录时不追加', () => {
  assert.equal(permissionSummary('read-only', 0), '只读')
  assert.equal(permissionSummary('read-only', 2), '只读 · 2 个目录')
  assert.equal(permissionSummary('workspace-write', 0), '工作区可写')
  assert.equal(permissionSummary('full-access', 0), '完全访问')
  assert.equal(permissionSummary('full-access', 3), '完全访问 · 3 个目录')
})

test('isDraftConversation：只有 emp_ 开头的占位会话还没创建', () => {
  assert.equal(isDraftConversation('emp_e1'), true)
  assert.equal(isDraftConversation('c1'), false)
})
