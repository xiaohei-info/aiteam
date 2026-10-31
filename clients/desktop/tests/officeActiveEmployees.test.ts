import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { OfficeSceneEmployee } from '../src/api/agent/types.ts'
import { chatReadyOfficeScene, loadChatReadyEmployeeIds } from '../src/pages/OfficeStatus/officeEmployees.ts'

function employee(id: string, status: string): OfficeSceneEmployee {
  return { employee_id: id, display_name: id, role_title: null, department_ids: [], status, task: null, avatar_url: null }
}

test('办公室只展示在人才市场展示且能对话的员工：不在市场或 offline 不查询，readiness 不可用或查询失败的不展示，统计按展示列表重算', async () => {
  const employees = [
    employee('working', 'working'),
    employee('ready', 'ready'),
    employee('paused', 'offline'),
    employee('unpublished', 'ready'),
    employee('skill-missing', 'ready'),
    employee('readiness-error', 'ready'),
  ]
  const market = new Set(['working', 'ready', 'paused', 'skill-missing', 'readiness-error'])
  const queried: string[] = []
  const readyIds = await loadChatReadyEmployeeIds(employees, market, async (id) => {
    queried.push(id)
    if (id === 'readiness-error') throw new Error('network')
    return { available: id !== 'skill-missing' }
  })
  assert.deepEqual(queried, ['working', 'ready', 'skill-missing', 'readiness-error'])
  assert.deepEqual([...readyIds], ['working', 'ready'])

  const scene = chatReadyOfficeScene({ employees, summary: { total: 6, working: 1, ready: 4, offline: 1 } }, readyIds)
  assert.deepEqual(scene.employees.map(item => item.employee_id), ['working', 'ready'])
  assert.deepEqual(scene.summary, { total: 2, working: 1, ready: 1, offline: 0 })

  // 花名册加载已从页面抽到 officeRoster.ts，由常驻运行时（OfficeRuntimeHost）登录后调用
  const roster = readFileSync(new URL('../src/pages/OfficeStatus/officeRoster.ts', import.meta.url), 'utf8')
  const page = readFileSync(new URL('../src/pages/OfficeStatus/index.tsx', import.meta.url), 'utf8')
  assert.match(roster, /loadMarketEmployeeIds\(items\.map\(item => item\.template_id\)\)/)
  assert.match(roster, /loadChatReadyEmployeeIds\(rawScene\.employees, marketEmployeeIds, \(employeeId\) => agentApi\.getExpertReadiness\(employeeId\)\)/)
  assert.doesNotMatch(page, /label: '离线'/)
})
