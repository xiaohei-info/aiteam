import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { employeeSendFailure, employeeUnavailableMessage, unavailableNoticeKey, isNoticeAcknowledged, acknowledgeNotice } from '../src/lib/employeeAvailability.ts'

test('availability distinguishes delisting, pause, dependency failure and normal employees', () => {
  assert.match(employeeUnavailableMessage({ status: 'archived' })!, /已下架/)
  assert.match(employeeUnavailableMessage({ status: 'paused' })!, /已暂停/)
  assert.match(employeeUnavailableMessage({ availability_reason: 'employee_dependency_unavailable' })!, /模型暂不可用/)
  assert.equal(employeeUnavailableMessage({ status: 'active' }), null)
  assert.equal(employeeUnavailableMessage(), null)
})

test('a send rejected for an unavailable employee explains why; other errors fall through', () => {
  assert.equal(employeeSendFailure({ code: 'employee_not_runnable', status: 409 }), '有员工暂不可用，消息未发出')
  assert.equal(employeeSendFailure({ code: 'conversation_busy' }), null)
  assert.equal(employeeSendFailure(new Error('employee_not_runnable')), null)
  assert.equal(employeeSendFailure(null), null)
})

test('group chat shows the send failure reason instead of only marking the message failed', () => {
  const page = readFileSync(new URL('../src/pages/GroupChat/index.tsx', import.meta.url), 'utf8')
  assert.match(page, /setSendError\(employeeSendFailure\(err\) \?\? '发送失败，请重试。'\)/)
  assert.match(page, /\{sendError && <p className="chat-input-error" role="alert">\{sendError\}<\/p>\}/)
})

test('acknowledgement is scoped to tenant, member, employee and event', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  const key = unavailableNoticeKey('t', 'm', 'e', 'event')
  acknowledgeNotice(storage, key)
  assert.equal(isNoticeAcknowledged(storage, key), true)
  for (const other of [unavailableNoticeKey('t2', 'm', 'e', 'event'), unavailableNoticeKey('t', 'm2', 'e', 'event'), unavailableNoticeKey('t', 'm', 'e2', 'event'), unavailableNoticeKey('t', 'm', 'e', 'event2')]) assert.equal(isNoticeAcknowledged(storage, other), false)
})
