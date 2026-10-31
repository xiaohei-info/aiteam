// API contract snapshot: TEST OpenAPI, 2026-09-09. Do not infer absent business fields.
export type WorkRecord = {
  "id": string
  "employee_id": string
  "employee_display_name": string
  "conversation_id": string
  "conversation_title": string | null
  "provenance": "live" | "pi_history"
  "outcome": "active" | "succeeded" | "error" | "aborted" | "unknown"
  "reason": "process_restart" | null
  "time_basis": "prompt_start" | "pi_entry" | "unknown"
  "occurred_at": string | null
  "started_at": string | null
  "ended_at": string | null
  "updated_at": string
  "first_entry_at": string | null
  "last_entry_at": string | null
  "input_entry_ref": string | null
  "output_entry_ref": string | null
  "source_type": "human" | "employee" | null
  "source_id": string | null
  "task_summary": string | null
  "result_summary": string | null
  "usage": WorkUsage | null
}

export type WorkHistoryEnvelope = {
  "data": (WorkRecord)[]
  "page": Page
  "meta": {
  "after": string
}
}

export type WorkChangesEnvelope = {
  "data": (WorkChange)[]
  "page": {
  "next_cursor": string
  "has_more": boolean
}
}

export type UsageStatistics = {
  "scope": "member_local"
  // work_records：带 conversation_id 时改为汇总该会话已结算的 live 工作记录。
  "coverage": "recorded_hourly_summaries" | "work_records"
  "employee_id": string | null
  "conversation_id": string | null
  "window_start": string | null
  "window_end": string | null
  "bucket": "utc_hour"
  "execution_count": number
  "succeeded_count": number
  "non_success_count": number
  "input_tokens": number
  "output_tokens": number
  "cache_tokens": number
  "token_total": number
  "duration_ms_total": number
  "currency": "USD"
  "cost_total": string | null
  "known_cost_total": string
  "cost_minor": number | null
  "pricing_status": "known" | "partial" | "unknown"
  "unpriced_execution_count": number
  "excluded_summary_count": number
  // 仅 group_by=employee 时返回，按 token_total 降序；employee_id 为 "unknown" 表示无法归属的旧摘要。
  "groups"?: (UsageStatisticsGroup)[]
}

export type UsageStatisticsGroup = {
  "employee_id": string
  "execution_count": number
  "succeeded_count": number
  "non_success_count": number
  "input_tokens": number
  "output_tokens": number
  "cache_tokens": number
  "token_total": number
  "duration_ms_total": number
  "currency": "USD"
  "cost_total": string | null
  "known_cost_total": string
  "cost_minor": number | null
  "pricing_status": "known" | "partial" | "unknown"
  "unpriced_execution_count": number
}

// GET /api/agent/usage/outcomes：段落解决率，已评估少于 min_sample 段时 resolution_rate 为 null。
export type UsageOutcomes = {
  "scope": "member_local"
  "employee_id": string | null
  "window_start": string | null
  "window_end": string | null
  "min_sample": number
  "evaluated_count": number
  "resolved_count": number
  "unresolved_count": number
  "resolution_rate": number | null
  "reasons": ({ "reason": string; "count": number })[]
}

export type ConversationParticipantsEnvelope = {
  "data": {
  "conversation_id": string
  "participants": (ConversationParticipant)[]
  "employee_count": number
}
}

export type MessageSearchEnvelope = {
  "data": (MessageSearchHit)[]
  "page": Page
}

export type WorkUsage = {
  "input_tokens": number
  "output_tokens": number
  "cache_tokens": number
  "token_total": number
  "cost_total": string | null
  "currency": "USD"
  "pricing_status": "known" | "unknown"
  "pricing_version": number | null
}

export type Page = {
  "next_cursor": string | null
  "has_more": boolean
}

export type WorkChange = {
  "operation": "upsert"
  "record_id": string
  "record": WorkRecord
} | {
  "operation": "delete"
  "record_id": string
}

export type ConversationParticipant = {
  "role_title": string | null
  "department_ids": (string)[]
  "department_name"?: string | null
  "employee_id": string
  "display_name": string
  "handle": string | null
  "role": "coordinator" | "participant"
  "available": boolean
}

export type MessageSearchHit = {
  "conversation_id": string
  "conversation_title": string | null
  "entry_ref": string
  "id": string
  "participant_employee_id": string | null
  "timestamp": string
  "role": "user" | "assistant"
  "source_type"?: "human" | "employee"
  "source_id"?: string
  "source_display_name"?: string
  "source_employee_id"?: string
  "source_employee_display_name"?: string
  "source_role"?: "human" | "participant" | "coordinator"
  "logical_message_id"?: string
  "snippet": string
}
