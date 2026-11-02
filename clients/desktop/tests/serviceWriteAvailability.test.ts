import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  KNOWLEDGE_BASE_WRITE_AVAILABILITY,
  ORG_CHART_WRITE_AVAILABILITY,
  getServiceWriteAvailability,
  isWriteActionDisabled,
} from '../src/lib/serviceWriteAvailability.ts'

test('disabled services expose a user-facing reason and disable writes', () => {
  for (const availability of [
    KNOWLEDGE_BASE_WRITE_AVAILABILITY,
    ORG_CHART_WRITE_AVAILABILITY,
  ]) {
    assert.equal(availability.enabled, false)
    assert.ok(availability.reason.trim().length > 0)
    assert.equal(isWriteActionDisabled(availability), true)
  }
})

test('employee detail panel has no pause/resume or full-profile footer actions', () => {
  // 员工详情只做展示：暂停/恢复归企业管理端，「查看完整资料」与人才市场重复，二者都已移除。
  const panelSource = readFileSync(
    new URL('../src/components/Chat/AgentDetailPanel.tsx', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(panelSource, /暂停 \/ 恢复服务|查看完整资料|adp-footer/)
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
