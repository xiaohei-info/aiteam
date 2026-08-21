import type { AgentApiClient } from "../../lib/api-client";

export interface FrozenSnapshot { employee_id: string; version: string; snapshot_version: string; display_name: string; }
export interface SyncResult { ok: boolean; upserted: number; revoked: number; error?: string|null; }
export interface OutboxItem { summary_id: string; tenant_id: string; kind: string; status: string; attempts: number; last_error?: string|null; created_at: string; }

export async function listSnapshots(client: AgentApiClient): Promise<FrozenSnapshot[]> {
  const result = await client.listGet<FrozenSnapshot>("/api/agent/grants/snapshots");
  if (!Array.isArray(result.items)) throw new Error("snapshot list: invalid response");
  return result.items;
}
export async function syncGrants(client: AgentApiClient, tenantId: string, memberId: string): Promise<SyncResult> {
  const result = await client.post<SyncResult>("/api/agent/grants/sync", { body: { tenant_id: tenantId, member_id: memberId } });
  if (!result) throw new Error("grant sync: empty response");
  return result;
}
export interface UsageFlushResult { sent: string[]; failed: string[]; }
export async function flushUsage(client: AgentApiClient, limit = 50): Promise<UsageFlushResult> {
  const result = await client.post<UsageFlushResult>("/api/agent/usage/flush", { body: { limit } });
  if (!result || !Array.isArray(result.sent) || !Array.isArray(result.failed)) throw new Error("usage flush: invalid response");
  return result;
}
export async function listOutbox(client: AgentApiClient): Promise<OutboxItem[]> {
  const result = await client.listGet<OutboxItem>("/api/agent/usage/outbox");
  if (!Array.isArray(result.items)) throw new Error("usage outbox: invalid response");
  return result.items;
}
