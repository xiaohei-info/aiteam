import type { AuthenticatedCaller } from "./http/auth.js";
import type { ManagerClient } from "./manager-client.js";
import { AgentSqliteStore } from "./storage/sqlite.js";
import type { ExecutionAuthorizationRegistry } from "./execution-authorization.js";

export interface UsageFlushServiceOptions {
  authorization?: ExecutionAuthorizationRegistry;
  intervalMs?: number;
  onAccessDenied?: (caller: AuthenticatedCaller) => void;
}

export class UsageFlushService {
  private readonly active = new Set<Promise<unknown>>();
  private readonly backoff = new Map<string, { failures: number; nextAttemptAt: number }>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly store: AgentSqliteStore, private readonly managerClient?: ManagerClient, private readonly options: UsageFlushServiceOptions = {}) {}

  async flush(caller: AuthenticatedCaller, limit = 50): Promise<{ sent: string[]; failed: string[] }> {
    if (!this.managerClient?.uploadUsage) throw new Error("Manager usage upload is not configured");
    const operation = this.flushInternal(caller, limit);
    this.active.add(operation);
    try { return await operation; } finally { this.active.delete(operation); }
  }

  start(): void {
    if (this.timer || !this.managerClient?.uploadUsage || !this.options.authorization) return;
    this.timer = setInterval(() => void this.drain(), this.options.intervalMs ?? 15_000);
    this.timer.unref();
    void this.drain();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.close();
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.active]);
  }

  private async drain(): Promise<void> {
    const authorization = this.options.authorization;
    if (!authorization || !this.managerClient?.uploadUsage) return;
    const now = Date.now();
    for (const owner of this.store.listUsageOutboxOwners()) {
      const scope = `${owner.tenant_id}:${owner.member_id}`;
      if ((this.backoff.get(scope)?.nextAttemptAt ?? 0) > now) continue;
      const caller = authorization.resolve(owner.tenant_id, owner.member_id, { requireAccessToken: true });
      if (!caller) continue;
      try {
        const result = await this.flush(caller);
        if (result.failed.length === 0) this.backoff.delete(scope);
        else this.noteFailure(scope, now);
      } catch {
        this.noteFailure(scope, now);
        /* bounded background retry on the next tick */
      }
    }
  }

  private noteFailure(scope: string, now: number): void {
    const failures = (this.backoff.get(scope)?.failures ?? 0) + 1;
    const delay = Math.min(5 * 60_000, 1_000 * 2 ** Math.min(failures - 1, 8)) + Math.floor(Math.random() * 250);
    this.backoff.set(scope, { failures, nextAttemptAt: now + delay });
  }

  private async flushInternal(caller: AuthenticatedCaller, limit: number): Promise<{ sent: string[]; failed: string[] }> {
    const client = this.managerClient;
    if (!client?.uploadUsage) throw new Error("Manager usage upload is not configured");
    const rows = this.store.claimUsageOutbox(caller.tenantId!, caller.userId ?? caller.callerId, limit);
    const sent: string[] = [];
    const failed: string[] = [];
    let denied = false;
    for (const row of rows) {
      if (denied) {
        this.store.markUsageFailed(row.summary_id, row.claim_token, "Manager usage authorization was denied");
        failed.push(row.summary_id);
        continue;
      }
      try {
        await client.uploadUsage(caller, row.payload);
        this.store.markUsageSent(row.summary_id, row.claim_token);
        sent.push(row.summary_id);
      } catch (error) {
        this.store.markUsageFailed(row.summary_id, row.claim_token, safeUsageError(error));
        if (isAccessDenial(error)) {
          const authorization = this.options.authorization;
          authorization?.invalidate(caller.tenantId!, caller.userId ?? caller.callerId);
          this.options.onAccessDenied?.(caller);
          this.noteFailure(`${caller.tenantId}:${caller.userId ?? caller.callerId}`, Date.now());
          denied = true;
        }
        failed.push(row.summary_id);
      }
    }
    return { sent, failed };
  }
}

function isAccessDenial(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status;
  if (status === 401 || status === 403) return true;
  return /\b(?:401|403)\b/u.test(error instanceof Error ? error.message : String(error));
}

function safeUsageError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Manager usage upload failed";
  return raw
    .replace(/(?:bearer\s+|(?:api[_ -]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/giu, "[内容已隐藏]")
    .replace(/(?:\/(?:Users|Volumes|private|home|tmp|var|workspace|etc|root|opt|srv|mnt|data)(?:\/[^\s"'<>]*)*|[A-Za-z]:\\[^\s"'<>]*)/giu, "[路径已隐藏]")
    .slice(0, 500);
}
