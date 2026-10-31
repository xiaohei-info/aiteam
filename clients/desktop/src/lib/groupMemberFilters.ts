import type { OrgTreeNode, SolutionProjection } from '../api/agent/types'

export const ALL_DEPARTMENTS = '__all_departments__'
export const UNASSIGNED_DEPARTMENT = '__unassigned_department__'

export interface GroupMemberCandidate {
  employeeId: string
  displayName: string
  roleName?: string
}

export interface DepartmentFilterOption {
  id: string
  name: string
  depth: number
  employeeIds: string[]
}

export interface OrganizationFilterIndex {
  departments: DepartmentFilterOption[]
  unassignedEmployeeIds: string[]
  knownEmployeeIds: Set<string>
}

export interface GroupMemberFilter {
  query: string
  departmentEmployeeIds: ReadonlySet<string> | null
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function candidateMatches(candidate: GroupMemberCandidate, query: string): boolean {
  if (!query) return true
  return normalized(`${candidate.displayName} ${candidate.roleName ?? ''}`).includes(query)
}

export function buildOrganizationFilterIndex(
  root: OrgTreeNode,
  allowedEmployeeIds: ReadonlySet<string>,
): OrganizationFilterIndex {
  const departments: DepartmentFilterOption[] = []
  const knownEmployeeIds = new Set<string>()
  const unassignedEmployeeIds: string[] = []

  const visitDepartment = (node: OrgTreeNode, depth: number): Set<string> => {
    const option: DepartmentFilterOption = { id: node.id, name: node.name, depth, employeeIds: [] }
    departments.push(option)
    const employeeIds = new Set<string>()

    for (const child of node.children ?? []) {
      if (child.type === 'employee') {
        if (allowedEmployeeIds.has(child.id)) employeeIds.add(child.id)
        continue
      }
      for (const employeeId of visitDepartment(child, depth + 1)) employeeIds.add(employeeId)
    }

    option.employeeIds = [...employeeIds]
    return employeeIds
  }

  if (root.type === 'employee') {
    if (allowedEmployeeIds.has(root.id)) unassignedEmployeeIds.push(root.id)
  } else {
    for (const child of root.children ?? []) {
      if (child.type === 'employee') {
        if (allowedEmployeeIds.has(child.id)) unassignedEmployeeIds.push(child.id)
      } else {
        visitDepartment(child, 0)
      }
    }
  }

  const visibleDepartments = departments.filter((department) => department.employeeIds.length > 0)
  for (const department of visibleDepartments) {
    for (const employeeId of department.employeeIds) knownEmployeeIds.add(employeeId)
  }
  for (const employeeId of unassignedEmployeeIds) knownEmployeeIds.add(employeeId)

  return { departments: visibleDepartments, unassignedEmployeeIds, knownEmployeeIds }
}

export function filterGroupMemberCandidates(
  candidates: readonly GroupMemberCandidate[],
  filter: GroupMemberFilter,
): GroupMemberCandidate[] {
  const query = normalized(filter.query)
  return candidates.filter((candidate) => (
    candidateMatches(candidate, query)
    && (!filter.departmentEmployeeIds || filter.departmentEmployeeIds.has(candidate.employeeId))
  ))
}

export function filterGroupSolutions(
  solutions: readonly SolutionProjection[],
  candidates: readonly GroupMemberCandidate[],
  filter: GroupMemberFilter,
): SolutionProjection[] {
  const query = normalized(filter.query)
  const candidatesById = new Map(candidates.map((candidate) => [candidate.employeeId, candidate]))

  return solutions.filter((solution) => {
    const roster = [...new Set(solution.expert_employee_ids ?? [])]
    const matchesDepartment = !filter.departmentEmployeeIds
      || roster.some((employeeId) => filter.departmentEmployeeIds?.has(employeeId))
    if (!matchesDepartment) return false
    if (!query) return true
    if (normalized(solution.display_name).includes(query)) return true
    return roster.some((employeeId) => {
      const candidate = candidatesById.get(employeeId)
      return candidate ? candidateMatches(candidate, query) : false
    })
  })
}

export function resolveDepartmentEmployeeIds(
  index: OrganizationFilterIndex | null,
  departmentId: string,
): ReadonlySet<string> | null {
  if (!index || departmentId === ALL_DEPARTMENTS) return null
  if (departmentId === UNASSIGNED_DEPARTMENT) return new Set(index.unassignedEmployeeIds)
  const department = index.departments.find((item) => item.id === departmentId)
  return new Set(department?.employeeIds ?? [])
}
