/**
 * 员工记忆:本机 Agent 用当前成员的登录身份转发到 Manager,Agent 不缓存。
 *
 *   GET    /api/agent/employees/:id/memories                 一页记忆(普通成员只返回自己贡献的)
 *   GET    /api/agent/employees/:id/memories/summary         按贡献者统计的条数,不含正文
 *   DELETE /api/agent/employees/:id/memories/:memory_id      删除(普通成员只能删自己贡献的)
 *
 * 旧版随包 Agent 没有这些路由,返回 404 not_found;调用方据此隐藏入口。
 */
import type { ServiceApiClient } from './client'
import type { Page } from './types'

// mine 只看自己贡献的;all 仅企业 owner/管理员生效,普通成员一律按 mine。
export type EmployeeMemoryScope = 'mine' | 'all'

export interface EmployeeMemory {
  memory_id: string
  employee_id: string
  content: string
  // Hindsight 原始分类值(如 world、experience);服务端未给中文枚举,前端原样显示。
  category: string
  importance: number | null
  source: string
  created_at: string | null
  last_used_at: string | null
  state: 'valid' | 'invalidated'
  contributor_member_id: string | null
  contributor_display_name: string | null
  is_mine: boolean
}

export interface EmployeeMemoryPage {
  data: EmployeeMemory[]
  page: Page
  meta: { scope: EmployeeMemoryScope; total: number; truncated: boolean }
}

export interface EmployeeMemorySummary {
  employee_id: string
  scope: EmployeeMemoryScope
  total_count: number
  own_count: number
  others_count: number
  unattributed_count: number
  recent_count: number
  latest_used_at: string | null
  truncated: boolean
}

export interface EmployeeMemoryQuery {
  scope?: EmployeeMemoryScope
  keyword?: string
  cursor?: string
  limit?: number
}

export function listEmployeeMemories(
  client: ServiceApiClient,
  employeeId: string,
  query: EmployeeMemoryQuery,
  signal?: AbortSignal,
): Promise<EmployeeMemoryPage> {
  return client.request<EmployeeMemoryPage>({
    method: 'GET',
    path: `/api/agent/employees/${encodeURIComponent(employeeId)}/memories`,
    query: { ...query },
    raw: true,
    signal,
  })
}

export function getEmployeeMemorySummary(
  client: ServiceApiClient,
  employeeId: string,
  scope?: EmployeeMemoryScope,
  signal?: AbortSignal,
): Promise<EmployeeMemorySummary> {
  return client.request<EmployeeMemorySummary>({
    method: 'GET',
    path: `/api/agent/employees/${encodeURIComponent(employeeId)}/memories/summary`,
    query: { scope },
    signal,
  })
}

export function deleteEmployeeMemory(
  client: ServiceApiClient,
  employeeId: string,
  memoryId: string,
): Promise<{ deleted: true; employee_id: string; memory_id: string }> {
  return client.request<{ deleted: true; employee_id: string; memory_id: string }>({
    method: 'DELETE',
    path: `/api/agent/employees/${encodeURIComponent(employeeId)}/memories/${encodeURIComponent(memoryId)}`,
  })
}
