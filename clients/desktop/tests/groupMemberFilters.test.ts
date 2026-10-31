import assert from 'node:assert/strict'
import test from 'node:test'
import type { OrgTreeNode, SolutionProjection } from '../src/api/agent/types.ts'
import {
  ALL_DEPARTMENTS,
  UNASSIGNED_DEPARTMENT,
  buildOrganizationFilterIndex,
  filterGroupMemberCandidates,
  filterGroupSolutions,
  resolveDepartmentEmployeeIds,
} from '../src/lib/groupMemberFilters.ts'

const candidates = [
  { employeeId: 'alice', displayName: 'Alice', roleName: '市场策略' },
  { employeeId: 'bob', displayName: 'Bob', roleName: '数据工程' },
  { employeeId: 'carol', displayName: 'Carol', roleName: '运营' },
]

const tree: OrgTreeNode = {
  id: 'enterprise',
  name: '示例企业',
  type: 'department',
  children: [
    {
      id: 'product',
      name: '产品中心',
      type: 'department',
      children: [
        { id: 'alice', name: 'Alice', type: 'employee', children: [] },
        {
          id: 'data',
          name: '数据组',
          type: 'department',
          children: [
            { id: 'bob', name: 'Bob', type: 'employee', children: [] },
            { id: 'not-authorized', name: '不可见员工', type: 'employee', children: [] },
          ],
        },
      ],
    },
    { id: 'carol', name: 'Carol', type: 'employee', children: [] },
  ],
}

const solutions: SolutionProjection[] = [
  {
    solution_instance_id: 'analysis-team',
    display_name: '分析协作组',
    version: '1',
    expert_employee_ids: ['alice', 'bob'],
  },
  {
    solution_instance_id: 'operations-team',
    display_name: '日常运营组',
    version: '1',
    expert_employee_ids: ['carol'],
  },
]

test('organization index keeps real hierarchy and intersects authorized employees', () => {
  const index = buildOrganizationFilterIndex(tree, new Set(candidates.map((item) => item.employeeId)))

  assert.deepEqual(index.departments.map(({ id, depth, employeeIds }) => ({ id, depth, employeeIds })), [
    { id: 'product', depth: 0, employeeIds: ['alice', 'bob'] },
    { id: 'data', depth: 1, employeeIds: ['bob'] },
  ])
  assert.deepEqual(index.unassignedEmployeeIds, ['carol'])
  assert.equal(index.knownEmployeeIds.has('not-authorized'), false)
})

test('member keyword and department filters only change visibility', () => {
  const index = buildOrganizationFilterIndex(tree, new Set(candidates.map((item) => item.employeeId)))
  const productIds = resolveDepartmentEmployeeIds(index, 'product')
  const visible = filterGroupMemberCandidates(candidates, {
    query: '数据',
    departmentEmployeeIds: productIds,
  })

  assert.deepEqual(visible.map((item) => item.employeeId), ['bob'])
  assert.equal(resolveDepartmentEmployeeIds(index, ALL_DEPARTMENTS), null)
  assert.deepEqual(
    [...(resolveDepartmentEmployeeIds(index, UNASSIGNED_DEPARTMENT) ?? [])],
    ['carol'],
  )
})

test('solution filtering searches roster members without rewriting the roster', () => {
  const originalRoster = solutions[0].expert_employee_ids
  const visible = filterGroupSolutions(solutions, candidates, {
    query: '数据工程',
    departmentEmployeeIds: null,
  })

  assert.deepEqual(visible.map((item) => item.solution_instance_id), ['analysis-team'])
  assert.strictEqual(visible[0], solutions[0])
  assert.strictEqual(visible[0].expert_employee_ids, originalRoster)

  const unassigned = new Set(['carol'])
  assert.deepEqual(
    filterGroupSolutions(solutions, candidates, { query: '', departmentEmployeeIds: unassigned })
      .map((item) => item.solution_instance_id),
    ['operations-team'],
  )
})
