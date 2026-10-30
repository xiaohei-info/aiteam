// Read the organization tree and forward department writes through the local Agent gateway.
import { backendApi } from '../../api/backend'
import type { OrgTreeNode } from '../../api/agent/types'

export interface ApiEnterprise {
  enterprise_id: string
  name: string
}

export interface ApiEmployee {
  // assignment_id 与组织树 employee 节点 id 都是同一个 employee_id。
  assignment_id: string
  employee_id: string
  department_id: string | null
  position_title: string
  visibility_scope: string
  // B1 的权威在线字段尚未提供；不得用 OrgTreeNode.status（生命周期/节点状态）代替。
  presence: string | null
  display_name: string
  role_name: string
  status: string
  avatar_url: string | null
  online_status: string | null
  last_seen_at: string | null
}

export interface ApiDepartment {
  department_id: string
  name: string
  parent_id?: string | null
  members?: ApiEmployee[]
  children?: ApiDepartment[]
}

export interface ApiStats {
  department_count: number
  assigned_employee_count: number
  unassigned_employee_count: number
}

export interface OrgTreeResponse {
  enterprise: ApiEnterprise
  departments: ApiDepartment[]
  unassigned_members: ApiEmployee[]
  stats: ApiStats
}

export function createDepartment(name: string): Promise<{ id: string; name: string }> {
  return backendApi.createOrgDepartment(name)
}

export async function renameDepartmentRemote(departmentId: string, name: string): Promise<void> {
  await backendApi.updateOrgDepartment(departmentId, { name })
}

/** parentId 为 null 表示移到顶级。 */
export async function moveDepartmentRemote(departmentId: string, parentId: string | null): Promise<void> {
  await backendApi.updateOrgDepartment(departmentId, { parent_id: parentId })
}

/** 删除部门：子部门上移到它的上级，员工在该部门的归属一并清除。 */
export async function deleteDepartmentRemote(departmentId: string): Promise<void> {
  await backendApi.deleteOrgDepartment(departmentId)
}

/** 下级部门升级：childId 取代 departmentId 的位置，departmentId 成为它的子部门。 */
export async function promoteDepartmentRemote(departmentId: string, childId: string): Promise<void> {
  await backendApi.promoteOrgDepartment(departmentId, childId)
}

const ORG_ERROR_MESSAGES: Record<string, string> = {
  org_depth_exceeded: '部门层级最多 5 层',
  org_invalid_move: '不能把部门放到它自己或它的下级部门下面',
  org_target_not_found: '部门或员工不存在，可能已被其他人删除，请刷新后重试',
  org_conflict: '与现有组织数据冲突，请刷新后重试',
  // 后台未升级到支持部门层级的版本时，会拒绝 parent_id / 升级请求。
  org_invalid_request: '后台拒绝了这次调整，可能后台尚未升级到支持部门层级的版本，请联系管理员',
  invalid_department_update: '请至少修改名称或上级部门',
  forbidden: '只有企业所有者或管理员可以调整组织架构',
}

/** 把组织写入失败转成可直接展示的中文提示。 */
export function describeOrgError(error: unknown, fallback: string): string {
  const code = (error as { code?: string; problem?: { code?: string } } | null)?.code ?? (error as { problem?: { code?: string } } | null)?.problem?.code
  if (code && ORG_ERROR_MESSAGES[code]) return ORG_ERROR_MESSAGES[code]
  return fallback
}

// 服务端语义是为员工“追加”一个部门，不会移除已有部门。
export function assignEmployeeDepartment(employeeId: string, departmentId: string): Promise<unknown> {
  return backendApi.assignOrgDepartment(employeeId, departmentId)
}

// -------------------- OrgTreeNode → 旧结构适配 --------------------

function nodeToEmployee(node: OrgTreeNode, parentDepartmentId: string | null): ApiEmployee {
  return {
    assignment_id: node.id,
    employee_id: node.id,
    department_id: parentDepartmentId,
    position_title: node.role_title ?? '',
    visibility_scope: 'department',
    presence: null,
    display_name: node.name,
    role_name: node.role_title ?? '',
    status: node.status ?? 'active',
    avatar_url: null,
    online_status: null,
    last_seen_at: null,
  }
}

function nodeToDepartment(node: OrgTreeNode, parentId: string | null): ApiDepartment {
  const members: ApiEmployee[] = []
  const children: ApiDepartment[] = []
  for (const child of node.children ?? []) {
    if (child.type === 'employee') members.push(nodeToEmployee(child, node.id))
    else if (child.type === 'department') children.push(nodeToDepartment(child, node.id))
  }
  return { department_id: node.id, name: node.name, parent_id: parentId, members, children }
}

function collectStats(departments: ApiDepartment[]): { deptCount: number; assignedCount: number } {
  let deptCount = 0
  const assigned = new Set<string>()
  const walk = (list: ApiDepartment[]) => {
    for (const d of list) {
      deptCount += 1
      d.members?.forEach(member => assigned.add(member.employee_id))
      if (d.children?.length) walk(d.children)
    }
  }
  walk(departments)
  return { deptCount, assignedCount: assigned.size }
}

export async function fetchOrgTree(): Promise<OrgTreeResponse> {
  const root: OrgTreeNode = await backendApi.getOrgTree()

  const enterprise: ApiEnterprise = { enterprise_id: root.id, name: root.name }
  // 根节点 children 里 employee 类型的算作"未归属员工"(旧栈的 unassigned_members)。
  // 部门类型的作为顶层 departments。
  const topDepartments: ApiDepartment[] = []
  const unassigned: ApiEmployee[] = []
  for (const child of root.children ?? []) {
    if (child.type === 'employee') unassigned.push(nodeToEmployee(child, null))
    else if (child.type === 'department') topDepartments.push(nodeToDepartment(child, root.id))
  }

  const { deptCount, assignedCount } = collectStats(topDepartments)
  return {
    enterprise,
    departments: topDepartments,
    unassigned_members: unassigned,
    stats: {
      department_count: deptCount,
      assigned_employee_count: assignedCount,
      unassigned_employee_count: unassigned.length,
    },
  }
}
