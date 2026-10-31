import { backendApi } from '../../api/backend'
import { agentApi } from '../../api/agent'
import type { OfficeSceneSummary, OrgTreeNode } from '../../api/agent/types'
import { fetchMarketAgents } from '../TalentMarket/api'
import { loadMarketEmployeeIds } from '../TalentMarket/talentEmployeeChat'
import { chatReadyOfficeScene, loadChatReadyEmployeeIds } from './officeEmployees'

/** 办公室风格固定为商务风，不再提供地图/风格切换入口 */
export const OFFICE_MAP_FILE = 'office-10-person-business.json'

/** 地图地址；version 是共用配置的更新时间，编辑器保存后变化，用来绕过缓存并触发场景重建 */
export function officeMapUrl(version: string): string {
  return `/assets/office/map/${encodeURIComponent(OFFICE_MAP_FILE)}${version ? `?v=${encodeURIComponent(version)}` : ''}`
}

export interface OfficeAgentConf { id: number | string; name: string; dept?: string; role?: string; status?: string }

export interface OfficeRoster {
  agents: OfficeAgentConf[]
  summary: OfficeSceneSummary
}

/**
 * 工位数据源：GET /api/agent/office/scene 的 employees 投影。
 * - 包含 Agent 服务明确下发的员工（含系统主持人 emp_sys_*），只保留在人才市场展示（模板已发布且已招募）并且当前能发起对话（readiness available）的员工；
 *   模板未发布、暂停、下架、撤销授权或未就绪的不展示
 * - 接口失败直接抛出，由调用方区分失败、真实空态与加载态，不使用 mock
 */
export async function loadOfficeRoster(): Promise<OfficeRoster> {
  const [scene, departments] = await Promise.all([
    Promise.all([
      agentApi.getOfficeScene(),
      fetchMarketAgents().then(({ items }) => loadMarketEmployeeIds(items.map(item => item.template_id))),
    ]).then(async ([rawScene, marketEmployeeIds]) => chatReadyOfficeScene(
      rawScene,
      await loadChatReadyEmployeeIds(rawScene.employees, marketEmployeeIds, (employeeId) => agentApi.getExpertReadiness(employeeId)),
    )),
    backendApi.getOrgTree().catch(() => null),
  ])
  const names = new Map<string, string>()
  const collect = (node: OrgTreeNode) => {
    if (node.type === 'department') names.set(node.id, node.name)
    node.children?.forEach(collect)
  }
  if (departments) collect(departments)
  // OfficeScene.employees[]:employee_id / display_name / status / task / avatar_url
  // 新栈 status 三态:'working' | 'ready' | 'offline';UI 的 dept/role 字段没有
  // 直接对应字段,先用 last_task / status 兜底,展示不再显示部门归属(旧栈也是伪值)。
  const agents: OfficeAgentConf[] = scene.employees.map((e) => ({
    id: e.employee_id,
    name: e.display_name,
    dept: e.department_ids?.map(id => names.get(id) ?? id).join(' / ') || undefined,
    role: e.role_title ?? '岗位未设置',
    status: e.status,
  }))
  return { agents, summary: scene.summary }
}
