import type { AgentApiClient } from './client'
import type { ConversationParticipantsEnvelope, MessageSearchEnvelope, WorkHistoryEnvelope, WorkChangesEnvelope, UsageStatistics, UsageOutcomes } from './observations.types'

export interface WorkFilters { employee_id?: string; window_start?: string; window_end?: string }
// conversation_id / group_by 需要较新的随包 Agent；旧版对未知参数返回 422 invalid_query。
export interface UsageStatisticsQuery extends WorkFilters { conversation_id?: string; group_by?: 'employee' }
export interface MessageSearchParams { q: string; employee_id?: string; conversation_id?: string; cursor?: string; limit?: number }
export const observations = (client: AgentApiClient) => ({
  getParticipants: (id: string) => client.request<ConversationParticipantsEnvelope['data']>({ path: `/api/agent/conversations/${encodeURIComponent(id)}/participants` }),
  searchMessages: (query: MessageSearchParams, signal?: AbortSignal) => client.request<MessageSearchEnvelope>({ path: '/api/agent/messages/search', query: { ...query }, raw: true, signal }),
  getWorkRecords: (query: WorkFilters & { before?: string; limit?: number } = {}, signal?: AbortSignal) => client.request<WorkHistoryEnvelope>({ path: '/api/agent/work-records', query: { ...query }, raw: true, signal }),
  getWorkChanges: (query: { employee_id?: string; after: string; limit?: number }, signal?: AbortSignal) => client.request<WorkChangesEnvelope>({ path: '/api/agent/work-records/changes', query, raw: true, signal }),
  getUsageStatistics: (query: UsageStatisticsQuery = {}, signal?: AbortSignal) => client.request<UsageStatistics>({ path: '/api/agent/usage/statistics', query: { ...query }, signal }),
  getUsageOutcomes: (query: WorkFilters = {}, signal?: AbortSignal) => client.request<UsageOutcomes>({ path: '/api/agent/usage/outcomes', query: { ...query }, signal }),
})
