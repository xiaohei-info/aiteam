import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findMatchingSolution,
  resolveGroupRoster,
} from '../src/lib/groupRoster.ts'

const expert = (employeeId: string, displayName = employeeId) => ({
  employee_id: employeeId,
  tenant_id: 'tenant-1',
  version: '1',
  handle: employeeId,
  display_name: displayName,
  revoked: false,
  synced_at: '2026-09-07T00:00:00.000Z',
  tools: [],
  skills: [],
})

const solution = {
  solution_instance_id: 'solution-1',
  display_name: '研发协作',
  version: '1',
  status: 'applied',
  coordinator_employee_id: 'coordinator',
  expert_employee_ids: ['coordinator', 'worker'],
}

const conversation = (solutionInstanceId: string | null) => ({
  id: 'group-1',
  title: '项目群',
  kind: 'group',
  labels: [],
  state: 'active',
  entry_employee_id: null,
  coordinator_employee_id: 'coordinator',
  solution_instance_id: solutionInstanceId,
  schedule: null,
  permission_mode: 'strict',
  last_read_entry_id: null,
  created_at: '2026-09-07T00:00:00.000Z',
  updated_at: '2026-09-07T00:00:00.000Z',
})

test('建群成员必须与授权 solution roster 精确匹配', () => {
  assert.equal(findMatchingSolution([solution], ['worker', 'coordinator']), solution)
  assert.equal(findMatchingSolution([solution], ['coordinator']), undefined)
  assert.equal(findMatchingSolution([solution], ['coordinator', 'worker', 'other']), undefined)
  assert.equal(findMatchingSolution([{ ...solution, status: 'revoked' }], ['coordinator', 'worker']), undefined)
})

test('solution 群按 roster 顺序加载，并标记当前不可用成员', () => {
  const roster = resolveGroupRoster(
    conversation('solution-1'),
    [solution],
    [expert('coordinator', '主持人')],
  )

  assert.equal(roster.status, 'loaded')
  assert.equal(roster.memberCount, 2)
  assert.deepEqual(roster.members.map((member) => member.employee_id), ['coordinator', 'worker'])
  assert.equal(roster.members[0]?.is_system_planner, true)
  assert.equal(roster.members[0]?.can_mention, true)
  assert.equal(roster.members[1]?.can_mention, false)
  assert.match(roster.message, /\u534f\u4f5c\u65b9\u6848 roster/)
  assert.match(roster.message, /members\[\]/)
})

test('无 solution 的历史群不把全部授权专家伪装成群成员', () => {
  const roster = resolveGroupRoster(
    conversation(null),
    [],
    [expert('coordinator', '主持人'), expert('unrelated', '无关员工')],
  )

  assert.equal(roster.status, 'unavailable')
  assert.equal(roster.memberCount, null)
  assert.deepEqual(roster.members.map((member) => member.employee_id), ['coordinator'])
  assert.match(roster.message ?? '', /未提供真实成员列表/)
  assert.match(roster.message, /members\[\]/)
})
