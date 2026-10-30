import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { SolutionProjection } from '../src/api/agent/types.ts'
import {
  FIXED_WORKFLOW_PROGRESS_UNAVAILABLE_REASON,
  resolveFixedWorkflowProgressAvailability,
} from '../src/lib/fixedWorkflowProgress.ts'

function solution(overrides: Partial<SolutionProjection> = {}): SolutionProjection {
  return {
    solution_instance_id: 'solution-1',
    display_name: '审计方案',
    version: '2:4',
    ...overrides,
  }
}

test('fixed workflow reference stays unavailable without an authoritative run snapshot', () => {
  assert.deepEqual(
    resolveFixedWorkflowProgressAvailability('solution-1', [solution({
      workflow_skill_ref: { skill_id: 'workflow-1', version: '1.2.0' },
    })]),
    {
      status: 'unavailable',
      title: '固定流程进度暂不可用',
      reason: FIXED_WORKFLOW_PROGRESS_UNAVAILABLE_REASON,
    },
  )
  assert.match(FIXED_WORKFLOW_PROGRESS_UNAVAILABLE_REASON, /步骤 ID/)
  assert.match(FIXED_WORKFLOW_PROGRESS_UNAVAILABLE_REASON, /执行顺序/)
  assert.match(FIXED_WORKFLOW_PROGRESS_UNAVAILABLE_REASON, /权威状态/)
})

test('opaque workflow reference content is never parsed as steps or progress', () => {
  const availability = resolveFixedWorkflowProgressAvailability('solution-1', [solution({
    workflow_skill_ref: {
      skill_id: 'workflow-1',
      steps: [
        { id: 'guessed-step', employee_id: 'employee-1', status: 'done' },
      ],
    },
  })])

  assert.equal(availability.status, 'unavailable')
  assert.equal('steps' in availability, false)
  assert.equal('currentStep' in availability, false)
})

test('groups without a confirmed fixed workflow do not show a progress placeholder', () => {
  assert.deepEqual(resolveFixedWorkflowProgressAvailability(null, []), { status: 'hidden' })
  assert.deepEqual(resolveFixedWorkflowProgressAvailability('missing', []), { status: 'hidden' })
  assert.deepEqual(resolveFixedWorkflowProgressAvailability('solution-1', [solution()]), { status: 'hidden' })
})

test('group chat mounts only the unavailable state and does not infer step progress from runtime events', () => {
  const pageSource = readFileSync(new URL('../src/pages/GroupChat/index.tsx', import.meta.url), 'utf8')
  const resolverSource = readFileSync(new URL('../src/lib/fixedWorkflowProgress.ts', import.meta.url), 'utf8')

  assert.match(pageSource, /resolveFixedWorkflowProgressAvailability/)
  assert.match(pageSource, /workflowProgress\.status === 'unavailable'/)
  assert.doesNotMatch(pageSource, /role="progressbar"|workflow-step/)
  assert.doesNotMatch(resolverSource, /source_employee_id|tool_execution|agent_start/)
})
