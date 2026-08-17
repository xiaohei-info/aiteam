import type { AuthenticatedCaller } from "./http/auth.js";
import type { ManagerClient } from "./manager-client.js";
import { AgentSqliteStore } from "./storage/sqlite.js";

export class UsageFlushService {
  private readonly active = new Set<Promise<unknown>>();

  constructor(private readonly store: AgentSqliteStore, private readonly managerClient?: ManagerClient) {}

  async flush(caller: AuthenticatedCaller, limit = 50): Promise<{ sent: string[]; failed: string[] }> {
    if (!this.managerClient?.uploadUsage) throw new Error("Manager usage upload is not configured");
    const operation = this.flushInternal(caller, limit);
    this.active.add(operation);
    try { return await operation; } finally { this.active.delete(operation); }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.active]);
  }

  private async flushInternal(caller: AuthenticatedCaller, limit: number): Promise<{ sent: string[]; failed: string[] }> {
    const client = this.managerClient;
    if (!client?.uploadUsage) throw new Error("Manager usage upload is not configured");
    const rows = this.store.claimUsageOutbox(caller.tenantId!, caller.userId ?? caller.callerId, limit);
    const sent: string[] = [];
    const failed: string[] = [];
    for (const row of rows) {
      try {
        await client.uploadUsage(caller, row.payload);
        this.store.markUsageSent(row.summary_id, row.claim_token);
        sent.push(row.summary_id);
      } catch (error) {
        this.store.markUsageFailed(row.summary_id, row.claim_token, error instanceof Error ? error.message : "Manager usage upload failed");
        failed.push(row.summary_id);
      }
    }
    return { sent, failed };
  }
}
