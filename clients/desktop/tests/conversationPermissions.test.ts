import assert from 'node:assert/strict'
import test from 'node:test'
import { directoryEmployeeIdOf, permissionSummary } from '../src/lib/conversationPermissions.ts'

test('permissionSummary 汇总会话权限与已开启目录数，0 个目录时不追加', () => {
  assert.equal(permissionSummary(false, 0), '只读')
  assert.equal(permissionSummary(false, 2), '只读 · 2 个目录')
  assert.equal(permissionSummary(true, 0), '完全访问')
  assert.equal(permissionSummary(true, 3), '完全访问 · 3 个目录')
})

test('directoryEmployeeIdOf：占位会话取 id，私聊（chat / private）取入口员工，群聊不检索', () => {
  assert.equal(directoryEmployeeIdOf('emp_e1', null), 'e1')
  assert.equal(directoryEmployeeIdOf('c1', null), null)
  assert.equal(directoryEmployeeIdOf('c1', { kind: 'chat', entry_employee_id: 'e2' }), 'e2')
  assert.equal(directoryEmployeeIdOf('c1', { kind: 'private', entry_employee_id: 'e3' }), 'e3')
  assert.equal(directoryEmployeeIdOf('g1', { kind: 'group', entry_employee_id: 'e4' }), null)
})
