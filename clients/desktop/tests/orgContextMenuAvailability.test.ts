import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  EMPLOYEE_CONTEXT_MENU_AVAILABLE_REASON,
  ORG_CONTEXT_MENU_AVAILABILITY,
  ORG_CONTEXT_MENU_UNAVAILABLE_REASON,
} from '../src/pages/OrgChart/orgContextMenuAvailability.ts'

const orgChartSource = readFileSync(
  new URL('../src/pages/OrgChart/index.tsx', import.meta.url),
  'utf8',
)
const orgApiSource = readFileSync(
  new URL('../src/pages/OrgChart/api.ts', import.meta.url),
  'utf8',
)
const memberPopupSource = readFileSync(
  new URL('../src/pages/OrgChart/MemberActionPopup.tsx', import.meta.url),
  'utf8',
)
const createDeptSource = readFileSync(
  new URL('../src/pages/OrgChart/CreateDeptDialog.tsx', import.meta.url),
  'utf8',
)

test('employee context menu exposes real chat while department management stays unavailable', () => {
  assert.deepEqual(Object.keys(ORG_CONTEXT_MENU_AVAILABILITY), ['employee', 'department'])
  assert.equal(ORG_CONTEXT_MENU_AVAILABILITY.employee.enabled, true)
  assert.equal(ORG_CONTEXT_MENU_AVAILABILITY.department.enabled, false)
  assert.match(EMPLOYEE_CONTEXT_MENU_AVAILABLE_REASON, /真实会话入口/)
  assert.match(ORG_CONTEXT_MENU_UNAVAILABLE_REASON, /禁止用本地组织树变更冒充成功/)
})

test('employee nodes mount a native context menu without exposing department fake writes', () => {
  assert.match(orgChartSource, /\bonContextMenu\s*=/)
  assert.match(orgChartSource, /e\.preventDefault\(\)/)
  assert.match(orgChartSource, /aria-keyshortcuts="Shift\+F10"/)
  assert.match(orgChartSource, /handleOpenMemberPopup/)
  assert.match(orgChartSource, /AssignDepartmentDialog/)
  assert.match(orgChartSource, /CreateDeptDialog/)
  assert.match(orgChartSource, /writeAvailability\.reason/)
})

test('left-click and right-click share a popup; assigning a department is gated by role', () => {
  assert.match(memberPopupSource, /onChat\(\)/)
  assert.match(memberPopupSource, /disabled=\{Boolean\(assignDisabledReason\) \|\| !onAssign\}/)
  assert.match(memberPopupSource, /assignDisabledReason/)
  assert.doesNotMatch(memberPopupSource, /updateEmployee|setDepartments|setRawEmps/)
})

test('department writes go only through the Agent gateway; deleting employees is not offered, deleting a department needs confirmation', () => {
  assert.match(orgApiSource, /createDepartment/)
  assert.match(orgApiSource, /assignEmployeeDepartment/)
  assert.match(orgApiSource, /renameDepartmentRemote/)
  assert.match(orgApiSource, /moveDepartmentRemote/)
  assert.match(orgApiSource, /promoteDepartmentRemote/)
  assert.doesNotMatch(orgApiSource, /managerApi|\/api\/manager/)
  assert.match(orgApiSource, /deleteDepartmentRemote/)
  assert.doesNotMatch(orgApiSource, /removeEmployee/)
  assert.match(orgChartSource, /<DeleteDeptDialog/)
  // 后端语义错误要有明确提示，而不是笼统的“失败”
  for (const code of ['org_depth_exceeded', 'org_invalid_move', 'org_invalid_request', 'org_target_not_found']) assert.match(orgApiSource, new RegExp(code))
})

test('create-department dialog does not submit or close on the Enter/Escape that confirms an IME candidate', () => {
  assert.match(createDeptSource, /onCompositionStart/)
  assert.match(createDeptSource, /onCompositionEnd/)
  assert.match(createDeptSource, /e\.key === 'Enter' && !isImeKeyboardEvent\(e\.nativeEvent, composingRef\.current\)/)
  assert.match(createDeptSource, /e\.key === 'Escape' && !saving && !isImeKeyboardEvent\(e, composingRef\.current\)/)
})

test('create-department dialog blocks a name that already exists, since Manager only enforces unique slugs', () => {
  assert.match(orgChartSource, /<CreateDeptDialog departments=\{departments\}/)
  assert.match(createDeptSource, /hasDepartmentNamed\(departments, trimmed\)/)
  assert.match(createDeptSource, /!trimmed \|\| duplicate \|\| saving/)
})
