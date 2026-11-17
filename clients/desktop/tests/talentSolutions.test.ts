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

import { capabilityReadiness, renderSolutionRules } from '../src/pages/TalentMarket/solutionMarket.ts'
import type { LocalCapability } from '../src/api/agent/types.ts'

const local = (extra: Partial<LocalCapability>): LocalCapability =>
  ({ kind: 'mcp', ref: 'x', display_name: 'x', url: '', tools: [], source: 'user_url', reason: '', approved_by: 'm', created_at: '', ...extra })

test('recommended capability readiness comes from locally installed personal capabilities', () => {
  const installed = [local({ kind: 'mcp', ref: 'mes' }), local({ kind: 'skill', ref: 'tenant-sheet', source: 'enterprise_catalog', source_ref: 'plat-sheet' })]
  assert.deepEqual(capabilityReadiness({ kind: 'mcp', ref: 'mes' }, installed), { label: '已就绪', ready: true })
  // 推荐清单里是平台 skill ID，本机记录的是企业 skill ID：按 source_ref 对上。
  assert.deepEqual(capabilityReadiness({ kind: 'skill', ref: 'plat-sheet' }, installed), { label: '已就绪', ready: true })
  assert.deepEqual(capabilityReadiness({ kind: 'mcp', ref: 'crm' }, installed), { label: '需在本机安装', ready: false })
  assert.deepEqual(capabilityReadiness({ kind: 'skill', ref: 'other' }, installed), { label: '需要时询问安装', ready: false })
  // 同 ref 但类型不同不算已装；本机能力读不到时不下结论。
  assert.equal(capabilityReadiness({ kind: 'skill', ref: 'mes' }, installed)?.ready, false)
  assert.equal(capabilityReadiness({ kind: 'mcp', ref: 'mes' }, null), null)
})

test('orchestration rules render member ids as names and flag unknown members', () => {
  const names = new Map([['e1', '质检协调']])
  assert.equal(renderSolutionRules('1. @{e1} 先拆解\n2. @{e9} 执行', names), '1. @质检协调 先拆解\n2. @e9（未授权到本机的成员） 执行')
  assert.equal(renderSolutionRules(undefined, names), '')
})
