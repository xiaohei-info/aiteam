import type { ServiceApiClient } from './client'
import type { Page } from './types'

export type TaskCategory = 'report' | 'monitor' | 'reminder' | 'other'
export type TaskStatus = 'active' | 'paused' | 'completed'
export type TaskRunStatus = 'queued' | 'blocked' | 'running' | 'succeeded' | 'error' | 'aborted' | 'unknown' | 'skipped'

export type TaskSchedule =
  | { mode: 'daily'; timezone: string; time: string }
  | { mode: 'weekly'; timezone: string; weekday: number; time: string }
  | { mode: 'monthly'; timezone: string; day_of_month: number; invalid_date_policy: 'skip'; time: string }
  | { mode: 'interval'; timezone: string; interval_seconds: number; starts_at: string }
  | { mode: 'once'; timezone: string; run_at: string }

export interface AutomationEmployee {
  employee_id: string
  display_name: string
}

export interface Connector {
  connector_id: string
  display_name: string
  type: 'mcp'
  status: 'enabled' | 'unavailable'
  available_employee_ids: string[]
}

export interface TaskRun {
  run_id: string
  conversation_id: string
  schedule_id: string
  scheduled_at: string
  receipt_key: string | null
  status: TaskRunStatus
  started_at: string | null
  finished_at: string | null
  error_code: string | null
  result_summary: string | null
  work_record_ids: string[]
}

export interface AutomationTask {
  task_id: string
  name: string
  category: TaskCategory
  prompt?: string
  prompt_summary: string
  employee_id: string | null
  employee: AutomationEmployee | null
  connector_ids: string[]
  connectors?: Connector[]
  schedule: TaskSchedule | null
  status: TaskStatus
  block_reason: string | null
  conversation_id: string | null
  target_kind: string
  origin: string
  etag: string
  last_run_at: string | null
  last_run: TaskRun | null
  next_run_at: string | null
  created_at: string
  updated_at: string
}

export interface TaskPage<T> {
  data: T[]
  page: Page
}

const base = '/api/agent/automation-tasks'

export function listAutomationTasks(client: ServiceApiClient, query: {
  category?: TaskCategory | 'all'
  status?: TaskStatus | 'all'
  q?: string
  employee_id?: string
  limit?: number
  cursor?: string
} = {}): Promise<TaskPage<AutomationTask>> {
  return client.request<TaskPage<AutomationTask>>({ method: 'GET', path: base, query, raw: true })
}

export function getAutomationTask(client: ServiceApiClient, taskId: string): Promise<AutomationTask> {
  return client.request<AutomationTask>({ method: 'GET', path: `${base}/${encodeURIComponent(taskId)}` })
}

export function createAutomationTask(client: ServiceApiClient, body: {
  name: string
  prompt: string
  category: TaskCategory
  employee_id: string
  connector_ids: string[]
  schedule: TaskSchedule
}, idempotencyKey: string): Promise<AutomationTask> {
  return client.request<AutomationTask>({ method: 'POST', path: base, body, idempotencyKey })
}

export function updateAutomationTask(client: ServiceApiClient, taskId: string, body: Partial<{
  name: string
  prompt: string
  category: TaskCategory
  employee_id: string
  connector_ids: string[]
  schedule: TaskSchedule
}>, etag: string): Promise<AutomationTask> {
  return client.request<AutomationTask>({ method: 'PATCH', path: `${base}/${encodeURIComponent(taskId)}`, body, headers: { 'If-Match': etag } })
}

export function setAutomationTaskAction(client: ServiceApiClient, taskId: string, action: 'enable' | 'pause', etag: string): Promise<AutomationTask> {
  return client.request<AutomationTask>({ method: 'POST', path: `${base}/${encodeURIComponent(taskId)}/actions/${action}`, headers: { 'If-Match': etag } })
}

export function deleteAutomationTask(client: ServiceApiClient, taskId: string, etag: string): Promise<void> {
  return client.request<void>({ method: 'DELETE', path: `${base}/${encodeURIComponent(taskId)}`, headers: { 'If-Match': etag } })
}

export function listAutomationTaskRuns(client: ServiceApiClient, taskId: string, query: { limit?: number; cursor?: string; include_deleted?: boolean } = {}): Promise<TaskPage<TaskRun>> {
  return client.request<TaskPage<TaskRun>>({ method: 'GET', path: `${base}/${encodeURIComponent(taskId)}/runs`, query, raw: true })
}

/** 不传 employeeId 时返回当前成员本机已安装、且有员工获授权的全部连接器。 */
export function listConnectors(client: ServiceApiClient, employeeId?: string): Promise<TaskPage<Connector>> {
  return client.request<TaskPage<Connector>>({ method: 'GET', path: '/api/agent/connectors', query: { employee_id: employeeId, status: 'enabled' }, raw: true })
}
