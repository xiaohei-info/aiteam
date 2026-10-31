import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  ORG_EMPLOYEE_TRANSFER_AVAILABILITY,
  isWriteActionDisabled,
} from '../src/lib/serviceWriteAvailability.ts'

const orgChartSource = readFileSync(
  new URL('../src/pages/OrgChart/index.tsx', import.meta.url),
  'utf8',
)
const orgApiSource = readFileSync(
  new URL('../src/pages/OrgChart/api.ts', import.meta.url),
  'utf8',
)
const agentApiSource = readFileSync(
  new URL('../src/api/backend/index.ts', import.meta.url),
  'utf8',
)
const packageJson = JSON.parse(readFileSync(
  new URL('../package.json', import.meta.url),
  'utf8',
)) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

test('employee transfer remains unavailable until the write contract is complete', () => {
  assert.equal(isWriteActionDisabled(ORG_EMPLOYEE_TRANSFER_AVAILABILITY), true)
  assert.match(ORG_EMPLOYEE_TRANSFER_AVAILABILITY.reason, /未开放员工调动/)
})

test('organization chart drags departments only, never employees, and keeps no local transfer state', () => {
  // 只有部门头部可拖（DeptDragNode）；员工卡片不可拖，也不在本地改员工归属。
  assert.doesNotMatch(orgChartSource, /useDraggable|useDroppable|SortableContext/)
  assert.doesNotMatch(orgChartSource, /setRawEmps\(\s*(?:prev|current)\s*=>/)
  assert.match(orgChartSource, /DeptDragNode/)

  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  }
  assert.ok(dependencies['@dnd-kit/core'])
  assert.equal(dependencies['react-dnd'], undefined)
})

test('organization writes go through the documented Agent gateway routes only', () => {
  assert.match(agentApiSource, /path: '\/api\/agent\/org\/tree'/)
  assert.match(agentApiSource, /method: 'POST', path: '\/api\/agent\/org\/departments'/)
  assert.match(agentApiSource, /method: 'PATCH', path: `\/api\/agent\/org\/assignments\//)
  assert.doesNotMatch(agentApiSource, /method: 'DELETE', path: '\/api\/agent\/org/)
  assert.doesNotMatch(orgApiSource, /managerApi|\/api\/manager/)
  assert.doesNotMatch(orgApiSource, /client\.patch|agentApi\.update/)
})
