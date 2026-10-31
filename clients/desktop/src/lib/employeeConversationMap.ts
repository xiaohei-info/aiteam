/**
 * Agent employee-to-conversation mapping shared by chat projections and routes.
 *
 * This is an in-memory identity map only. It performs no network requests or
 * persistence and is rebuilt from authoritative Agent projections at runtime.
 */
import type { EmployeeUsageMetrics } from './usageDisplay'

const employeeByConversation = new Map<string, string>()

export interface WorkbenchEmployee {
  availability_reason?: string
  availability_revision?: string
  status?: string
  employeeId: string
  displayName: string
  roleName?: string
  conversationId: string | null
  // 员工额外信息,由 ExpertProjection 直接透传,供 AgentDetailPanel / 头像回退等 UI 消费。
  avatarUrl?: string | null
  skills?: string[]
  persona?: string
  memorySummary?: string | null
  modelName?: string | null
  modelProvider?: string | null
  connectorRefs?: string[]
  knowledgeRefs?: string[]
  automationTasks?: string[]
  onlineStatus?: string | null
  lastSeenAt?: string | null
  // B2.1 的显式领域预留；仅在 API 契约正式声明并由 store 映射后赋值。
  usage?: EmployeeUsageMetrics
}

export function getEmployeeId(convId: string): string | undefined {
  return employeeByConversation.get(convId)
}

export function rememberEmployeeConversation(convId: string, employeeId: string): void {
  employeeByConversation.set(convId, employeeId)
}
