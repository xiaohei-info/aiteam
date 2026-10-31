import assert from 'node:assert/strict'
import test from 'node:test'
import { employeeUnavailableMessage, unavailableNoticeKey, isNoticeAcknowledged, acknowledgeNotice } from '../src/lib/employeeAvailability.ts'

test('availability distinguishes delisting, pause, dependency failure and normal employees', () => {
  assert.match(employeeUnavailableMessage({ status: 'archived' })!, /已下架/)
  assert.match(employeeUnavailableMessage({ status: 'paused' })!, /已暂停/)
  assert.match(employeeUnavailableMessage({ availability_reason: 'employee_dependency_unavailable' })!, /模型暂不可用/)
  assert.equal(employeeUnavailableMessage({ status: 'active' }), null)
  assert.equal(employeeUnavailableMessage(), null)
})

test('acknowledgement is scoped to tenant, member, employee and event', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  const key = unavailableNoticeKey('t', 'm', 'e', 'event')
  acknowledgeNotice(storage, key)
  assert.equal(isNoticeAcknowledged(storage, key), true)
  for (const other of [unavailableNoticeKey('t2', 'm', 'e', 'event'), unavailableNoticeKey('t', 'm2', 'e', 'event'), unavailableNoticeKey('t', 'm', 'e2', 'event'), unavailableNoticeKey('t', 'm', 'e', 'event2')]) assert.equal(isNoticeAcknowledged(storage, other), false)
})
