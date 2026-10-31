import type { OfficeScene, OfficeSceneEmployee, OfficeSceneSummary } from '../../api/agent/types'

/**
 * 在人才市场展示的员工里逐个查询 readiness，返回当前能发起对话的员工 ID。
 * 不在人才市场（模板未发布等）或 status='offline'（撤销授权、暂停、下架）的员工不再查询；
 * 单个员工查询失败时视为不能对话，不展示。
 */
export async function loadChatReadyEmployeeIds(
  employees: OfficeSceneEmployee[],
  marketEmployeeIds: ReadonlySet<string>,
  getReadiness: (employeeId: string) => Promise<{ available: boolean }>,
): Promise<Set<string>> {
  const candidates = employees.filter(employee => employee.status !== 'offline' && marketEmployeeIds.has(employee.employee_id))
  const results = await Promise.allSettled(candidates.map(employee => getReadiness(employee.employee_id)))
  return new Set(candidates.flatMap((employee, index) => {
    const result = results[index]
    return result.status === 'fulfilled' && result.value.available ? [employee.employee_id] : []
  }))
}

/**
 * 办公室只展示在人才市场展示且当前能对话的员工（readyIds 已按两者取交集），并按展示列表重算统计，避免总数里混入不展示的员工。
 */
export function chatReadyOfficeScene(scene: OfficeScene, readyIds: ReadonlySet<string>): OfficeScene {
  const employees = scene.employees.filter(employee => employee.status !== 'offline' && readyIds.has(employee.employee_id))
  const summary: OfficeSceneSummary = {
    total: employees.length,
    working: employees.filter(employee => employee.status === 'working').length,
    ready: employees.filter(employee => employee.status === 'ready').length,
    offline: 0,
  }
  return { employees, summary }
}
