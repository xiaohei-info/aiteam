import type { AgentApiClient } from "../../lib/api-client";
import { listConversations as listChatConversations, type Conversation } from "../chat/useChatApi";

export type { Conversation };

export async function listConversations(client: AgentApiClient): Promise<Conversation[]> {
  const items: Conversation[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = await listChatConversations(client, cursor, 100);
    items.push(...result.items);
    cursor = result.hasMore ? result.nextCursor : null;
    if (cursor && seenCursors.has(cursor)) throw new Error("conversation list: repeated cursor");
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return items;
}

export interface WorkUsage {
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  token_total: number;
  cost_total: string | null;
  currency: "USD";
  pricing_status: "known" | "unknown";
  pricing_version: number | null;
}

export type WorkRecordOutcome = "active" | "succeeded" | "error" | "aborted" | "unknown";

export interface WorkRecord {
  id: string;
  employee_id: string;
  employee_display_name: string;
  conversation_id: string;
  conversation_title: string | null;
  provenance: "live" | "pi_history";
  outcome: WorkRecordOutcome;
  reason: "process_restart" | null;
  time_basis: "prompt_start" | "pi_entry" | "unknown";
  occurred_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  updated_at: string;
  first_entry_at: string | null;
  last_entry_at: string | null;
  input_entry_ref: string | null;
  output_entry_ref: string | null;
  source_type: "human" | "employee" | null;
  source_id: string | null;
  task_summary: string | null;
  result_summary: string | null;
  usage: WorkUsage | null;
}

export interface WorkHistoryQuery {
  employee_id?: string | null;
  window_start?: string | null;
  window_end?: string | null;
  limit?: number;
  before?: string | null;
}

export interface WorkHistoryPage {
  items: WorkRecord[];
  nextCursor: string | null;
  hasMore: boolean;
  /** Stable change waterline used by the changes polling endpoint. */
  after: string;
}

export async function listWorkRecords(
  client: AgentApiClient,
  query: WorkHistoryQuery = {},
): Promise<WorkHistoryPage> {
  const result = await client.listGet<WorkRecord>("/api/agent/work-records", { query: query as Record<string, string | number | boolean | null | undefined> });
  if (!Array.isArray(result.items) || !result.page || typeof result.page.has_more !== "boolean") {
    throw new Error("work history: invalid response");
  }
  const after = typeof result.meta?.after === "string" ? result.meta.after : "";
  return {
    items: result.items,
    nextCursor: result.page.next_cursor ?? null,
    hasMore: result.page.has_more,
    after,
  };
}

export const listWorkHistory = listWorkRecords;

export interface WorkChangeUpsert {
  operation: "upsert";
  record_id: string;
  record: WorkRecord;
}

export interface WorkChangeDelete {
  operation: "delete";
  record_id: string;
}

export type WorkRecordChange = WorkChangeUpsert | WorkChangeDelete;

export interface WorkChangesPage {
  items: WorkRecordChange[];
  nextCursor: string;
  hasMore: boolean;
}

export interface WorkChangesQuery {
  employee_id?: string | null;
  limit?: number;
  after?: string | null;
}

export async function listWorkRecordChanges(
  client: AgentApiClient,
  query: WorkChangesQuery = {},
): Promise<WorkChangesPage> {
  const result = await client.listGet<WorkRecordChange>("/api/agent/work-records/changes", { query: query as Record<string, string | number | boolean | null | undefined> });
  if (!Array.isArray(result.items) || !result.page || typeof result.page.has_more !== "boolean" || typeof result.page.next_cursor !== "string") {
    throw new Error("work history changes: invalid response");
  }
  return {
    items: result.items,
    nextCursor: result.page.next_cursor,
    hasMore: result.page.has_more,
  };
}

export const getWorkRecordChanges = listWorkRecordChanges;

export interface UsageStatistics {
  scope: "member_local";
  coverage: "recorded_hourly_summaries";
  employee_id: string | null;
  window_start: string | null;
  window_end: string | null;
  bucket: "utc_hour";
  execution_count: number;
  succeeded_count: number;
  non_success_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  token_total: number;
  duration_ms_total: number;
  currency: "USD";
  cost_total: string | null;
  known_cost_total: string;
  cost_minor: number | null;
  pricing_status: "known" | "partial" | "unknown";
  unpriced_execution_count: number;
  excluded_summary_count: number;
}

export interface UsageStatisticsQuery {
  employee_id?: string | null;
  window_start?: string | null;
  window_end?: string | null;
}

export async function getUsageStatistics(
  client: AgentApiClient,
  query: UsageStatisticsQuery = {},
): Promise<UsageStatistics | null> {
  const queryRecord = query as Record<string, string | number | boolean | null | undefined>;
  const result = Object.values(queryRecord).some((value) => value !== undefined && value !== null)
    ? await client.get<UsageStatistics>("/api/agent/usage/statistics", { query: queryRecord })
    : await client.get<UsageStatistics>("/api/agent/usage/statistics");
  if (result === null) return null;
  if (result.scope !== "member_local" || result.coverage !== "recorded_hourly_summaries" || result.bucket !== "utc_hour" || result.currency !== "USD") {
    throw new Error("usage statistics: invalid response");
  }
  return result;
}
