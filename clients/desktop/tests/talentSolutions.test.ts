import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExpertProjection, SolutionProjection } from '../src/api/agent/types.ts'
import { recommendedSummary, solutionMembers, solutionMode, solutionStart } from '../src/pages/TalentMarket/solutionMarket.ts'

const expert = (id: string, extra: Partial<ExpertProjection> = {}): ExpertProjection =>
  ({ employee_id: id, display_name: id, tenant_id: 't', version: '1', handle: id, revoked: false, synced_at: '', skills: [], tools: [], ...extra })
const solution = (extra: Partial<SolutionProjection> = {}): SolutionProjection =>
  ({ solution_instance_id: 's', display_name: 'S', version: '1', expert_employee_ids: ['a', 'b'], ...extra })

test('legacy solutions without mode are group solutions', () => {
  assert.equal(solutionMode(solution()), 'group')
  assert.equal(solutionMode(solution({ mode: 'solo' })), 'solo')
})

test('solo solution starts a private chat with its only expert; group solution builds a group', () => {
  const experts = [expert('a'), expert('b')]
  assert.deepEqual(solutionStart(solution({ mode: 'solo', expert_employee_ids: ['a'] }), experts), { kind: 'chat', employeeId: 'a', label: '开始私聊' })
  assert.deepEqual(solutionStart(solution({ mode: 'group' }), experts), { kind: 'group', label: '用此方案建群' })
})

test('a member that is not authorized locally blocks starting, with a reason', () => {
  const result = solutionStart(solution(), [expert('a'), expert('b', { revoked: true })])
  assert.equal(result.kind, 'unavailable')
  assert.equal(solutionStart(solution({ expert_employee_ids: [] }), []).kind, 'unavailable')
  assert.deepEqual(solutionMembers(solution(), [expert('a'), expert('b', { revoked: true })]).map(item => item.employee_id), ['a'])
})

test('recommended capabilities are summarized as hints only', () => {
  assert.equal(recommendedSummary(solution()), null)
  assert.equal(recommendedSummary(solution({ recommended_capabilities: [
    { kind: 'skill', ref: 'x' }, { kind: 'skill', ref: 'y' }, { kind: 'mcp', ref: 'mes' },
  ] })), '2 个 skill、1 个 MCP')
})
