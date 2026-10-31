import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  ORG_CHART_WRITE_AVAILABILITY,
  getOrgChartWriteAvailability,
  isWriteActionDisabled,
} from '../src/lib/serviceWriteAvailability.ts'

const orgChartSource = readFileSync(
  new URL('../src/pages/OrgChart/index.tsx', import.meta.url),
  'utf8',
)
const dropIntentSource = readFileSync(
  new URL('../src/pages/OrgChart/dropIntent.ts', import.meta.url),
  'utf8',
)
const orgApiSource = readFileSync(
  new URL('../src/pages/OrgChart/api.ts', import.meta.url),
  'utf8',
)

test('department writes are enabled only for owner and enterprise_admin', () => {
  for (const role of ['owner', 'enterprise_admin']) {
    assert.equal(isWriteActionDisabled(getOrgChartWriteAvailability([role])), false, role)
  }
  for (const roles of [['member'], [], null, undefined]) {
    const availability = getOrgChartWriteAvailability(roles)
    assert.equal(isWriteActionDisabled(availability), true)
    assert.equal(availability, ORG_CHART_WRITE_AVAILABILITY)
  }
  assert.match(ORG_CHART_WRITE_AVAILABILITY.reason, /所有者或管理员/)
})

test('department drag, promote and rename are role-gated and saved through the Agent with rollback on failure', () => {
  assert.match(orgChartSource, /DndContext/)
  assert.match(orgChartSource, /useDeptDrag\(/)
  // 松手结果统一由 describeDrop 算出，并经 moveDepartment 做层数、防环校验
  assert.match(dropIntentSource, /moveDepartment\(departments, draggedId, parentId\)/)
  assert.match(orgChartSource, /promoteDepartmentRemote\(departmentId, action\.promoted\)/)
  assert.match(orgChartSource, /moveDepartmentRemote\(departmentId, action\.parentId\)/)
  assert.match(orgChartSource, /renameDepartmentRemote\(renamingDept\.id, name\)/)
  assert.match(orgChartSource, /setDepartments\(previous\)/)
  assert.doesNotMatch(orgChartSource, /尚未保存到后台|仅本页预览/)
  // 只有有写权限的真实部门可拖：“未设置”和“未分配部门”不显示铅笔，也不可拖、不可作为放置目标
  assert.match(orgChartSource, /const editable = \(dept: ApiDepartment \| null\) => writeAvailability\.enabled && dept !== null && dept\.department_id !== SERVER_UNASSIGNED_DEPARTMENT_ID/)
  assert.match(orgChartSource, /enabled: editable\(dept\)/)
  assert.equal(orgChartSource.match(/<DeptDragNode \{\.\.\.deptNodeProps\(/g)?.length, 2)
  // 拖动时不往页面里插入占位或提示块，布局保持不动
  assert.doesNotMatch(orgChartSource, /SiblingDropZone|TopLevelDropZone/)
})

test('organization API saves department changes through the Agent backend client only', () => {
  assert.match(orgApiSource, /backendApi\.getOrgTree\(\)/)
  assert.match(orgApiSource, /backendApi\.createOrgDepartment/)
  assert.match(orgApiSource, /backendApi\.assignOrgDepartment/)
  assert.match(orgApiSource, /backendApi\.updateOrgDepartment/)
  assert.match(orgApiSource, /backendApi\.promoteOrgDepartment/)
  assert.doesNotMatch(orgApiSource, /parent_department_id/)
})
