import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_DEPARTMENT_ID,
  SERVER_UNASSIGNED_DEPARTMENT_ID,
  collectDepartmentIds,
  collectEmployeesFromTree,
  groupEmployeesByDepartment,
  hasDepartmentNamed,
  listAssignableDepartments,
  moveDepartment,
  renameDepartment,
} from '../src/pages/OrgChart/orgTree.ts'
import type { ApiDepartment, ApiEmployee } from '../src/pages/OrgChart/api.ts'

const makeEmployee = (employeeId: string, departmentId: string | null): ApiEmployee => ({
  assignment_id: employeeId,
  employee_id: employeeId,
  department_id: departmentId,
  position_title: '',
  visibility_scope: 'department',
  presence: null,
  display_name: employeeId,
  role_name: '',
  status: 'active',
  avatar_url: null,
})

test('组织树递归收集所有层级的部门和直属员工', () => {
  const childEmployee = makeEmployee('child-worker', 'child')
  const departments: ApiDepartment[] = [{
    department_id: 'root-dept',
    name: '研发中心',
    members: [makeEmployee('root-worker', 'root-dept')],
    children: [{
      department_id: 'child',
      name: '平台组',
      members: [childEmployee],
      children: [],
    }],
  }]

  assert.deepEqual([...collectDepartmentIds(departments)], ['root-dept', 'child'])
  assert.deepEqual(collectEmployeesFromTree(departments).map(employee => employee.employee_id), [
    'root-worker',
    'child-worker',
  ])
})

test('子部门员工保留真实归属，空归属和失效部门才进入未分配', () => {
  const departments: ApiDepartment[] = [{
    department_id: 'root-dept',
    name: '研发中心',
    children: [{ department_id: 'child', name: '平台组' }],
  }]
  const employees = [
    makeEmployee('root-worker', 'root-dept'),
    makeEmployee('child-worker', 'child'),
    makeEmployee('orphan-worker', 'deleted-dept'),
    makeEmployee('unassigned-worker', null),
  ]
  const grouped = groupEmployeesByDepartment(departments, employees)

  assert.deepEqual(grouped.get('root-dept')?.map(employee => employee.employee_id), ['root-worker'])
  assert.deepEqual(grouped.get('child')?.map(employee => employee.employee_id), ['child-worker'])
  assert.deepEqual(grouped.get(DEFAULT_DEPARTMENT_ID)?.map(employee => employee.employee_id), [
    'orphan-worker',
    'unassigned-worker',
  ])
})

test('分配部门只列出员工尚未所属的真实部门，并排除服务端合成的“未设置”节点', () => {
  const departments: ApiDepartment[] = [
    {
      department_id: 'root-dept',
      name: '研发中心',
      members: [makeEmployee('worker', 'root-dept')],
      children: [{ department_id: 'child', name: '平台组', members: [], children: [] }],
    },
    {
      department_id: SERVER_UNASSIGNED_DEPARTMENT_ID,
      name: '未设置',
      members: [makeEmployee('loose', SERVER_UNASSIGNED_DEPARTMENT_ID)],
      children: [],
    },
  ]

  assert.deepEqual(listAssignableDepartments(departments, 'worker'), [{ id: 'child', name: '平台组', depth: 1 }])
  assert.deepEqual(listAssignableDepartments(departments, 'loose'), [
    { id: 'root-dept', name: '研发中心', depth: 0 },
    { id: 'child', name: '平台组', depth: 1 },
  ])
  assert.deepEqual(listAssignableDepartments([], 'worker'), [])
})

test('创建部门前按名称查重：忽略首尾空白、大小写和全角差异，并检查子部门', () => {
  const departments: ApiDepartment[] = [{
    department_id: 'root-dept',
    name: '研发中心',
    children: [{ department_id: 'child', name: 'Platform 组' }],
  }]

  assert.equal(hasDepartmentNamed(departments, '研发中心'), true)
  assert.equal(hasDepartmentNamed(departments, '  研发中心  '), true)
  assert.equal(hasDepartmentNamed(departments, 'platform 组'), true)
  assert.equal(hasDepartmentNamed(departments, 'ＰＬＡＴＦＯＲＭ 组'), true)
  assert.equal(hasDepartmentNamed(departments, '运营部'), false)
  assert.equal(hasDepartmentNamed(departments, '   '), false)
  assert.equal(hasDepartmentNamed([], '研发中心'), false)
})

const dept = (id: string, children: ApiDepartment[] = [], members: ApiEmployee[] = []): ApiDepartment =>
  ({ department_id: id, name: id, children, members })
const ids = (items: readonly ApiDepartment[]): string[] => items.map(item => item.department_id)

test('移动部门：整棵子树和员工一起走，原数据不被修改', () => {
  const worker = makeEmployee('w', 'b')
  const tree = [dept('a', [dept('b', [dept('c')], [worker])]), dept('d')]
  const result = moveDepartment(tree, 'b', 'd')
  assert.ok(result.ok)
  assert.deepEqual(ids(result.departments), ['a', 'd'])
  assert.deepEqual(ids(result.departments[0].children ?? []), [])
  const moved = result.departments[1].children?.[0]
  assert.equal(moved?.department_id, 'b')
  assert.equal(moved?.parent_id, 'd')
  assert.deepEqual(ids(moved?.children ?? []), ['c'])
  assert.deepEqual(moved?.members, [worker])
  assert.deepEqual(ids(tree[0].children ?? []), ['b'])
})

test('移动到顶级', () => {
  const result = moveDepartment([dept('a', [dept('b')])], 'b', null)
  assert.ok(result.ok)
  assert.deepEqual(ids(result.departments), ['a', 'b'])
  assert.equal(result.departments[1].parent_id, null)
})

test('移动部门拒绝：自己、自己的子部门、未设置、原位置、不存在', () => {
  const tree = [dept('a', [dept('b', [dept('c')])]), dept(SERVER_UNASSIGNED_DEPARTMENT_ID)]
  for (const [id, parent] of [['a', 'a'], ['b', SERVER_UNASSIGNED_DEPARTMENT_ID], [SERVER_UNASSIGNED_DEPARTMENT_ID, 'a'], ['b', 'a'], ['a', null], ['x', 'a'], ['a', 'x']] as const) {
    assert.equal(moveDepartment(tree, id, parent).ok, false, `${id} -> ${parent}`)
  }
})

test('移动部门最多 5 层，按整棵子树计算', () => {
  const chain = dept('n1', [dept('n2', [dept('n3', [dept('n4')])])])
  const other = dept('o', [], [])
  const tree = [chain, other, dept('p', [dept('q')])]
  assert.equal(moveDepartment(tree, 'o', 'n4').ok, true)
  assert.equal(moveDepartment(tree, 'p', 'n4').ok, false) // p 带 q 共 2 层，挂到第 4 层下会到第 6 层
  assert.equal(moveDepartment(tree, 'p', 'n3').ok, true)
})

test('下级部门可以升级为上级：取代原部门位置，原部门成为它的子部门', () => {
  const tree = [dept('a', [dept('b'), dept('c', [dept('e')])], [makeEmployee('w', 'a')]), dept('d')]
  const result = moveDepartment(tree, 'a', 'c')
  assert.ok(result.ok)
  assert.deepEqual(ids(result.departments), ['d', 'c'])
  const c = result.departments[1]
  assert.equal(c.parent_id, null)
  assert.deepEqual(ids(c.children ?? []), ['e', 'a'])
  const a = c.children?.[1]
  assert.equal(a?.parent_id, 'c')
  assert.deepEqual(ids(a?.children ?? []), ['b'])
  assert.equal(a?.members?.[0].employee_id, 'w')
})

test('子部门升级时留在原上级之下，并同样受 5 层限制', () => {
  const nested = [dept('r', [dept('a', [dept('c')])])]
  const ok = moveDepartment(nested, 'a', 'c')
  assert.ok(ok.ok)
  assert.deepEqual(ids(ok.departments[0].children ?? []), ['c'])
  assert.deepEqual(ids(ok.departments[0].children?.[0].children ?? []), ['a'])
  // 原树 5 层；c 升级后 a 连同 b、y 压到 c 下面，会到第 6 层
  const deep = [dept('n1', [dept('n2', [dept('a', [dept('c', [dept('x')]), dept('b', [dept('y')])])])])]
  assert.equal(moveDepartment(deep, 'a', 'c').ok, false)
})

test('重命名部门：只改名称，结构和员工不变，原数据不被修改', () => {
  const worker = makeEmployee('w', 'c')
  const tree = [dept('a', [dept('c', [], [worker])])]
  const result = renameDepartment(tree, 'c', '  新名称 ')
  assert.ok(result.ok)
  const renamed = result.departments[0].children?.[0]
  assert.equal(renamed?.name, '新名称')
  assert.equal(renamed?.department_id, 'c')
  assert.deepEqual(renamed?.members, [worker])
  assert.equal(tree[0].children?.[0].name, 'c')
})

test('重命名部门拒绝：空名、超长、同名（不含自己）、未设置、不存在、无变化', () => {
  const tree = [dept('a', [dept('b')]), dept(SERVER_UNASSIGNED_DEPARTMENT_ID)]
  for (const [id, name] of [['b', '   '], ['b', 'x'.repeat(65)], ['b', 'A'], [SERVER_UNASSIGNED_DEPARTMENT_ID, '新'], ['zz', '新'], ['b', 'b']] as const) {
    assert.equal(renameDepartment(tree, id, name).ok, false, `${id} -> ${name}`)
  }
  assert.equal(renameDepartment(tree, 'b', 'B2').ok, true)
})

test('parentOf 与 isAncestor 用于“拖成同级”', async () => {
  const { parentOf, isAncestor } = await import('../src/pages/OrgChart/orgTree.ts')
  const tree = [{ department_id: 'a', name: 'A', parent_id: null, members: [], children: [{ department_id: 'b', name: 'B', parent_id: 'a', members: [], children: [{ department_id: 'c', name: 'C', parent_id: 'b', members: [], children: [] }] }] }]
  assert.equal(parentOf(tree as never, 'a'), null)
  assert.equal(parentOf(tree as never, 'c'), 'b')
  assert.equal(isAncestor(tree as never, 'a', 'c'), true)
  assert.equal(isAncestor(tree as never, 'c', 'a'), false)
  assert.equal(isAncestor(tree as never, 'a', 'a'), false)
})
