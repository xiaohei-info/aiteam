import type { AgentApiClient } from "../../lib/api-client";

export interface FrozenSnapshot { employee_id: string; version: string; snapshot_version: string; display_name: string; }
export interface SyncResult { ok: boolean; upserted: number; revoked: number; error?: string|null; }
export interface OutboxItem { summary_id: string; tenant_id: string; kind: string; status: string; attempts: number; last_error?: string|null; created_at: string; }

export async function listSnapshots(client: AgentApiClient): Promise<FrozenSnapshot[]> {
  return (await client.listGet<FrozenSnapshot>("/api/agent/grants/snapshots")).items;
}
export async function syncGrants(client: AgentApiClient, tenantId: string, memberId: string): Promise<SyncResult | null> {
  return client.post<SyncResult>("/api/agent/grants/sync", { body: { tenant_id: tenantId, member_id: memberId } });
}
export async function listOutbox(client: AgentApiClient): Promise<OutboxItem[]> {
  return (await client.listGet<OutboxItem>("/api/agent/usage/outbox")).items;
}
