import assert from 'node:assert/strict'
import test from 'node:test'
import { grantsSyncRetryResult, skippedEmployeeLabels } from '../src/lib/grantsSyncNotice.ts'

test('skipped employees show display names and fall back to the id when never synced', () => {
  const experts = [
    { employee_id: 'e1', display_name: '财务助理' },
    { employee_id: 'e2', display_name: '  ' },
    { employee_id: 'e3', display_name: '不相关' },
  ]
  assert.deepEqual(skippedEmployeeLabels(['e1', 'e2', 'e9'], experts), ['财务助理', 'e2', 'e9'])
  assert.deepEqual(skippedEmployeeLabels([], experts), [])
})

test('a successful retry clears the notice; a retry that outlives its session is discarded', () => {
  assert.deepEqual(grantsSyncRetryResult('t1', 't1', []), [])
  assert.deepEqual(grantsSyncRetryResult('t1', 't1', ['e1']), ['e1'])
  assert.equal(grantsSyncRetryResult('t1', null, []), null)
  assert.equal(grantsSyncRetryResult('t1', 't2', []), null)
})
