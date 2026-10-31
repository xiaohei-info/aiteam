export type OrgContextMenuTarget = 'employee' | 'department'

export interface OrgContextMenuAvailability {
  enabled: boolean
  target: OrgContextMenuTarget
  reason: string
}

export const ORG_CONTEXT_MENU_UNAVAILABLE_REASON =
  '部门管理菜单尚未接入；禁止用本地组织树变更冒充成功。'

export const EMPLOYEE_CONTEXT_MENU_AVAILABLE_REASON =
  '员工原生右键菜单可使用真实会话入口；岗位与部门编辑暂未开放。'

export const ORG_CONTEXT_MENU_AVAILABILITY: Readonly<
  Record<OrgContextMenuTarget, OrgContextMenuAvailability>
> = Object.freeze({
  employee: Object.freeze({
    enabled: true,
    target: 'employee' as const,
    reason: EMPLOYEE_CONTEXT_MENU_AVAILABLE_REASON,
  }),
  department: Object.freeze({
    enabled: false,
    target: 'department' as const,
    reason: ORG_CONTEXT_MENU_UNAVAILABLE_REASON,
  }),
})
