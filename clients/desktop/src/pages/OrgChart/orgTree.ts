import type { ApiDepartment, ApiEmployee } from './api'

export const DEFAULT_DEPARTMENT_ID = '__default__'

// Manager 给没有部门的员工合成的“未设置”节点；它不是真实部门，不能作为分配目标。
export const SERVER_UNASSIGNED_DEPARTMENT_ID = 'unassigned'

export function collectDepartmentIds(departments: readonly ApiDepartment[]): Set<string> {
  const ids = new Set<string>()
  const walk = (items: readonly ApiDepartment[]) => {
    for (const department of items) {
      ids.add(department.department_id)
      walk(department.children ?? [])
    }
  }
  walk(departments)
  return ids
}

export function collectEmployeesFromTree(departments: readonly ApiDepartment[]): ApiEmployee[] {
  const employees: ApiEmployee[] = []
  const walk = (department: ApiDepartment) => {
    employees.push(...(department.members ?? []))
    for (const child of department.children ?? []) walk(child)
  }
  for (const department of departments) walk(department)
  return employees
}

export function groupEmployeesByDepartment(
  departments: readonly ApiDepartment[],
  employees: readonly ApiEmployee[],
): Map<string, ApiEmployee[]> {
  const validDepartmentIds = collectDepartmentIds(departments)
  const grouped = new Map<string, ApiEmployee[]>()
  for (const employee of employees) {
    const departmentId = employee.department_id
    const key = departmentId && validDepartmentIds.has(departmentId)
      ? departmentId
      : DEFAULT_DEPARTMENT_ID
    const members = grouped.get(key) ?? []
    members.push(employee)
    grouped.set(key, members)
  }
  return grouped
}

export interface AssignableDepartment {
  id: string
  name: string
  depth: number
}

// 服务端是“追加部门”语义：只列出员工尚未所属的真实部门，depth 用于缩进展示子部门。
export function listAssignableDepartments(
  departments: readonly ApiDepartment[],
  employeeId: string,
): AssignableDepartment[] {
  const options: AssignableDepartment[] = []
  const walk = (items: readonly ApiDepartment[], depth: number) => {
    for (const department of items) {
      const belongs = (department.members ?? []).some(member => member.employee_id === employeeId)
      if (department.department_id !== SERVER_UNASSIGNED_DEPARTMENT_ID && !belongs) {
        options.push({ id: department.department_id, name: department.name, depth })
      }
      walk(department.children ?? [], depth + 1)
    }
  }
  walk(departments, 0)
  return options
}

const normalizeDepartmentName = (name: string) => name.normalize('NFKC').trim().toLowerCase()

// Manager 只对部门标识做唯一约束，同名部门不会被拒绝；创建前在客户端拦下，避免建出看起来一模一样的部门。
export function hasDepartmentNamed(departments: readonly ApiDepartment[], name: string, exceptId?: string): boolean {
  const wanted = normalizeDepartmentName(name)
  if (!wanted) return false
  const walk = (items: readonly ApiDepartment[]): boolean =>
    items.some(department => (department.department_id !== exceptId && normalizeDepartmentName(department.name) === wanted) || walk(department.children ?? []))
  return walk(departments)
}

// 与 Manager 的 department_tree.py 保持一致：顶级为第 1 层，最多 5 层。
export const MAX_DEPARTMENT_DEPTH = 5

export type MoveDepartmentResult =
  // promoted：被升级的下级部门 id（拖到自己的下级上时），此时需要走“升级”而不是“移动”。
  | { ok: true; departments: ApiDepartment[]; promoted?: string }
  | { ok: false; reason: string }

export function findDepartment(
  departments: readonly ApiDepartment[],
  id: string,
  depth = 1,
): { department: ApiDepartment; depth: number } | undefined {
  for (const department of departments) {
    if (department.department_id === id) return { department, depth }
    const inChild = findDepartment(department.children ?? [], id, depth + 1)
    if (inChild) return inChild
  }
  return undefined
}

function subtreeHeight(department: ApiDepartment): number {
  return 1 + Math.max(0, ...(department.children ?? []).map(subtreeHeight))
}

function withoutDepartment(departments: readonly ApiDepartment[], id: string): ApiDepartment[] {
  return departments
    .filter(department => department.department_id !== id)
    .map(department => ({ ...department, children: withoutDepartment(department.children ?? [], id) }))
}

function insertUnder(departments: readonly ApiDepartment[], parentId: string, node: ApiDepartment): ApiDepartment[] {
  return departments.map(department => department.department_id === parentId
    ? { ...department, children: [...(department.children ?? []), node] }
    : { ...department, children: insertUnder(department.children ?? [], parentId, node) })
}

/** 把部门（含整棵子树和员工）移到另一个部门下；parentId 为 null 表示移到顶级。不修改入参。 */
export function moveDepartment(
  departments: readonly ApiDepartment[],
  departmentId: string,
  parentId: string | null,
): MoveDepartmentResult {
  if (departmentId === SERVER_UNASSIGNED_DEPARTMENT_ID || parentId === SERVER_UNASSIGNED_DEPARTMENT_ID) {
    return { ok: false, reason: '“未设置”不是真实部门，不能调整层级' }
  }
  const moving = findDepartment(departments, departmentId)
  if (!moving) return { ok: false, reason: '找不到要移动的部门' }
  if (parentId === departmentId) return { ok: false, reason: '不能把部门放到它自己下面' }
  const node = moving.department
  if (parentId !== null && findDepartment(node.children ?? [], parentId)) {
    // 拖到自己的下级部门上 = 让下级“升级”：它取代原部门的位置，原部门（去掉它之后的部分）成为它的子部门。
    const currentParent = findParentId(departments, departmentId) ?? null
    const promoted = findDepartment(node.children ?? [], parentId)!.department
    const oldNode = withoutDepartment([node], parentId)[0]
    const swapped: ApiDepartment = {
      ...promoted,
      parent_id: currentParent,
      children: [...(promoted.children ?? []), { ...oldNode, parent_id: parentId }],
    }
    const baseDepth = currentParent === null ? 0 : findDepartment(departments, currentParent)!.depth
    if (baseDepth + subtreeHeight(swapped) > MAX_DEPARTMENT_DEPTH) {
      return { ok: false, reason: `部门层级最多 ${MAX_DEPARTMENT_DEPTH} 层` }
    }
    const rest = withoutDepartment(departments, departmentId)
    return { ok: true, departments: currentParent === null ? [...rest, swapped] : insertUnder(rest, currentParent, swapped), promoted: parentId }
  }
  if (parentId !== null) {
    const target = findDepartment(departments, parentId)
    if (!target) return { ok: false, reason: '找不到目标部门' }
    if (target.depth + subtreeHeight(node) > MAX_DEPARTMENT_DEPTH) {
      return { ok: false, reason: `部门层级最多 ${MAX_DEPARTMENT_DEPTH} 层` }
    }
  }
  const currentParent = findParentId(departments, departmentId)
  if (currentParent === parentId) return { ok: false, reason: '部门已经在这个位置' }
  const rest = withoutDepartment(departments, departmentId)
  const moved = { ...node, parent_id: parentId }
  return { ok: true, departments: parentId === null ? [...rest, moved] : insertUnder(rest, parentId, moved) }
}

/** 部门的上级 id（顶级为 null，找不到为 undefined）。 */
export const parentOf = (departments: readonly ApiDepartment[], id: string) => findParentId(departments, id)

/** ancestorId 是否是 id 的上级（任意层）。 */
export function isAncestor(departments: readonly ApiDepartment[], ancestorId: string, id: string): boolean {
  const found = findDepartment(departments, ancestorId)
  return Boolean(found && findDepartment(found.department.children ?? [], id))
}

function findParentId(departments: readonly ApiDepartment[], id: string, parent: string | null = null): string | null | undefined {
  for (const department of departments) {
    if (department.department_id === id) return parent
    const inChild = findParentId(department.children ?? [], id, department.department_id)
    if (inChild !== undefined) return inChild
  }
  return undefined
}

export const MAX_DEPARTMENT_NAME_LENGTH = 64

export type RenameDepartmentResult =
  | { ok: true; departments: ApiDepartment[] }
  | { ok: false; reason: string }

function mapDepartment(departments: readonly ApiDepartment[], id: string, name: string): ApiDepartment[] {
  return departments.map(department => ({
    ...department,
    name: department.department_id === id ? name : department.name,
    children: mapDepartment(department.children ?? [], id, name),
  }))
}

/** 重命名部门（只改名称，位置、员工和子部门不变）。不修改入参。 */
export function renameDepartment(departments: readonly ApiDepartment[], departmentId: string, rawName: string): RenameDepartmentResult {
  const name = rawName.trim()
  if (departmentId === SERVER_UNASSIGNED_DEPARTMENT_ID) return { ok: false, reason: '“未设置”不是真实部门，不能重命名' }
  if (!findDepartment(departments, departmentId)) return { ok: false, reason: '找不到要重命名的部门' }
  if (!name) return { ok: false, reason: '部门名称不能为空' }
  if (name.length > MAX_DEPARTMENT_NAME_LENGTH) return { ok: false, reason: `部门名称最多 ${MAX_DEPARTMENT_NAME_LENGTH} 个字符` }
  if (hasDepartmentNamed(departments, name, departmentId)) return { ok: false, reason: '已有同名部门，请换一个名称' }
  if (findDepartment(departments, departmentId)!.department.name === name) return { ok: false, reason: '名称没有变化' }
  return { ok: true, departments: mapDepartment(departments, departmentId, name) }
}
