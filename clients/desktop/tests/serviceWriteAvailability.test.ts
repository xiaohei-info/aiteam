import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  EMPLOYEE_SERVICE_CONTROL_AVAILABILITY,
  KNOWLEDGE_BASE_WRITE_AVAILABILITY,
  ORG_CHART_WRITE_AVAILABILITY,
  getServiceWriteAvailability,
  isWriteActionDisabled,
} from '../src/lib/serviceWriteAvailability.ts'

test('disabled services expose a user-facing reason and disable writes', () => {
  for (const availability of [
    KNOWLEDGE_BASE_WRITE_AVAILABILITY,
    ORG_CHART_WRITE_AVAILABILITY,
    EMPLOYEE_SERVICE_CONTROL_AVAILABILITY,
  ]) {
    assert.equal(availability.enabled, false)
    assert.ok(availability.reason.trim().length > 0)
    assert.equal(isWriteActionDisabled(availability), true)
  }
})

test('employee service control stays unavailable until lifecycle and running-task contracts are integrated', () => {
  assert.equal(EMPLOYEE_SERVICE_CONTROL_AVAILABILITY.enabled, false)
  assert.match(EMPLOYEE_SERVICE_CONTROL_AVAILABILITY.reason, /所有者或管理员/)
  assert.match(EMPLOYEE_SERVICE_CONTROL_AVAILABILITY.reason, /生命周期写接口/)
  assert.match(EMPLOYEE_SERVICE_CONTROL_AVAILABILITY.reason, /运行中任务/)

  const panelSource = readFileSync(
    new URL('../src/components/Chat/AgentDetailPanel.tsx', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(panelSource, /onClick=\{\(\) => \{\}\}/)
  assert.match(panelSource, /disabled=\{!EMPLOYEE_SERVICE_CONTROL_AVAILABILITY\.enabled\}/)
  assert.match(panelSource, /aria-describedby="employee-service-control-reason"/)
})

test('write actions are enabled only when the service is available and idle', () => {
  const available = getServiceWriteAvailability('available')

  assert.equal(isWriteActionDisabled(available), false)
  assert.equal(isWriteActionDisabled(available, true), true)
  assert.equal(getServiceWriteAvailability('gone').enabled, false)
  assert.equal(getServiceWriteAvailability('not_implemented').enabled, false)
  assert.equal(getServiceWriteAvailability('integration_incomplete').enabled, false)
  assert.equal(getServiceWriteAvailability('unavailable').enabled, false)
})
