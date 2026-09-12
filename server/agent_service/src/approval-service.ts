import { createHash } from "node:crypto";
import type { ApprovalRecord, ApprovalStatus, AgentSqliteStore } from "./storage/sqlite.js";
import { encodeScope } from "./runtime-lease-cache.js";

export type ApprovalRisk = "bash" | "write" | "edit" | "external" | "unknown";

export interface ApprovalRequest {
  tenantId: string;
  memberId: string;
  conversationId: string;
  participantEmployeeId?: string;
  sessionId: string;
  snapshotVersion: string;
  permissionRevision: string;
  toolCallId: string;
  toolCallEntryId?: string;
  promptReceiptRef?: string;
  toolName: string;
  args: unknown;
  riskLevel: ApprovalRisk;
  permissionMode?: "read-only" | "workspace-write" | "full-access";
  /** The lease/JWT cutoff is an upper bound in addition to the approval TTL. */
  expiresAt?: number;
  signal?: AbortSignal;
}

export interface ApprovalServiceOptions {
  now?: () => number;
  ttlMs?: number;
  onRequired?: (record: ApprovalRecord) => void | Promise<void>;
}

export class ApprovalCancelledError extends Error {
  constructor(message = "Approval was cancelled") { super(message); this.name = "ApprovalCancelledError"; }
}
export class ApprovalDeniedError extends Error {
  constructor(message = "Tool execution was denied") { super(message); this.name = "ApprovalDeniedError"; }
}
export class ApprovalExpiredError extends Error {
  constructor(message = "Tool approval expired") { super(message); this.name = "ApprovalExpiredError"; }
}
export class ApprovalPermissionError extends Error {
  constructor(message = "Tool is not permitted by the conversation permission") { super(message); this.name = "ApprovalPermissionError"; }
}

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

/**
 * The approval gate is intentionally a small side-effect coordinator around
 * Pi's normal ToolDefinition.execute function. It does not create a second
 * execution engine and stores only a parameter hash and redacted preview.
 */
export class ApprovalService {
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private onRequired?: (record: ApprovalRecord) => void | Promise<void>;

  constructor(private readonly store: AgentSqliteStore, private readonly options: ApprovalServiceOptions = {}) {
    this.onRequired = options.onRequired;
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = Math.min(Math.max(options.ttlMs ?? 10 * 60_000, 1_000), 10 * 60_000);
  }

  setOnRequired(callback: (record: ApprovalRecord) => void | Promise<void>): void {
    this.onRequired = callback;
  }

  requiresApproval(toolName: string): ApprovalRisk | undefined {
    return approvalRiskForTool(toolName);
  }

  async execute<T>(request: ApprovalRequest, operation: () => Promise<T>): Promise<T> {
    if ((request.riskLevel === "write" || request.riskLevel === "edit") && request.permissionMode === "read-only") {
      // Approval may never upgrade the Conversation's sandbox permission.
      // read-only is rejected before an ApprovalRecord is created.
      throw new ApprovalPermissionError();
    }
    const hash = canonicalArgsHmac(request.args);
    const existing = this.store.findApprovalForTool({
      tenantId: request.tenantId,
      memberId: request.memberId,
      conversationId: request.conversationId,
      sessionId: request.sessionId,
      participantEmployeeId: request.participantEmployeeId,
      toolCallId: request.toolCallId,
      canonicalArgsHmac: hash,
      snapshotVersion: request.snapshotVersion,
    });
    if (existing && (existing.permission_revision !== request.permissionRevision || existing.tool_name !== request.toolName)) {
      throw new ApprovalDeniedError("Approval binding changed; request a new approval");
    }
    const record = existing ?? this.create(request, hash);
    const claimed = await this.waitAndClaim(record, request);
    try {
      const result = await operation();
      this.store.finishApproval(claimed.id, "succeeded");
      return result;
    } catch (error) {
      // A thrown operation can mean the side effect was started but its result
      // was lost. Do not turn it into an automatically retryable rejection.
      this.store.finishApproval(claimed.id, "uncertain");
      throw error;
    }
  }

  list(conversationId: string, tenantId: string, memberId: string, includeTerminal = true): ApprovalRecord[] {
    this.expireDue(conversationId, tenantId, memberId);
    return this.store.listOwnedApprovalRecords(conversationId, tenantId, memberId, includeTerminal);
  }

  decide(input: {
    id: string;
    tenantId: string;
    memberId: string;
    conversationId: string;
    decision: "approve" | "deny";
    expectedRevision?: number;
    approvedBy: string;
    idempotencyKey: string;
  }): ApprovalRecord {
    this.expireDue(input.conversationId, input.tenantId, input.memberId);
    const record = this.store.decideApproval(input);
    if (record.status === "rejected") this.cancelBatch(record.approval_batch_id, record.id);
    this.wake(record.id, record.status === "approved" ? undefined : new ApprovalDeniedError());
    return record;
  }

  cancelConversation(conversationId: string, tenantId?: string, memberId?: string): void {
    this.store.invalidateApprovalsForConversation(conversationId, tenantId, memberId);
    for (const [id, waiters] of this.waiters) {
      const record = this.store.getApprovalRecord(id);
      if (!record || record.conversation_id !== conversationId || (tenantId !== undefined && record.tenant_id !== tenantId) || (memberId !== undefined && record.member_id !== memberId)) continue;
      for (const waiter of waiters) waiter.reject(new ApprovalCancelledError());
      this.waiters.delete(id);
    }
  }

  cancelOwner(tenantId: string, memberId: string): void {
    this.store.invalidateApprovalsForOwner(tenantId, memberId);
    for (const [id, waiters] of this.waiters) {
      const record = this.store.getApprovalRecord(id);
      if (!record || record.tenant_id !== tenantId || record.member_id !== memberId) continue;
      for (const waiter of waiters) waiter.reject(new ApprovalCancelledError());
      this.waiters.delete(id);
    }
  }

  clear(): void {
    for (const waiters of this.waiters.values()) for (const waiter of waiters) waiter.reject(new ApprovalCancelledError());
    this.waiters.clear();
  }

  private create(request: ApprovalRequest, hash: string): ApprovalRecord {
    const now = this.now();
    const maxExpiry = now + this.ttlMs;
    const expiry = request.expiresAt !== undefined && Number.isFinite(request.expiresAt)
      ? Math.min(maxExpiry, request.expiresAt)
      : maxExpiry;
    if (expiry <= now) throw new ApprovalExpiredError();
    const id = createHash("sha256").update(encodeScope([request.tenantId, request.memberId, request.conversationId, request.sessionId, request.toolCallId, hash, request.snapshotVersion])).digest("hex").slice(0, 32);
    const record = this.store.createApprovalRecord({
      id,
      approval_batch_id: encodeScope([request.sessionId, request.promptReceiptRef ?? request.toolCallId]),
      tenant_id: request.tenantId,
      member_id: request.memberId,
      conversation_id: request.conversationId,
      participant_employee_id: request.participantEmployeeId ?? null,
      session_id: request.sessionId,
      snapshot_version: request.snapshotVersion,
      permission_revision: request.permissionRevision,
      tool_call_id: request.toolCallId,
      tool_call_entry_id: request.toolCallEntryId ?? null,
      prompt_receipt_ref: request.promptReceiptRef ?? null,
      tool_name: request.toolName,
      canonical_args_hmac: hash,
      redacted_summary: redactedToolSummary(request.toolName, request.args),
      risk_level: request.riskLevel,
      expires_at: new Date(expiry).toISOString(),
      idempotency_key: encodeScope([request.conversationId, request.sessionId, request.toolCallId]),
    });
    void this.onRequired?.(record);
    return record;
  }

  private async waitAndClaim(record: ApprovalRecord, request: ApprovalRequest): Promise<ApprovalRecord> {
    let current = record;
    while (true) {
      if (current.status === "approved") {
        const claimed = this.store.claimApproval(
          current.id, request.tenantId, request.memberId, request.conversationId,
          current.decision_revision, request.snapshotVersion, request.permissionRevision,
          new Date(this.now()).toISOString(),
        );
        if (claimed?.status === "executing" && claimed.consumed) return claimed;
        current = this.store.getApprovalRecord(current.id) ?? current;
        if (current.status === "executing" || current.consumed) throw new ApprovalDeniedError("Approval was already consumed");
      }
      if (current.status === "rejected" || current.status === "invalidated" || current.status === "succeeded" || current.status === "executing") throw new ApprovalDeniedError("Approval was already consumed");
      if (current.status === "expired" || Date.parse(current.expires_at) <= this.now()) {
        this.store.expireApproval(current.id, new Date(this.now()).toISOString());
        throw new ApprovalExpiredError();
      }
      if (current.status === "uncertain") throw new ApprovalDeniedError("Approval is not recoverable after restart");
      await this.waitForDecision(current.id, current.expires_at, request.signal);
      current = this.store.getApprovalRecord(current.id) ?? current;
    }
  }

  private waitForDecision(id: string, expiresAt: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      this.store.invalidateApprovalsForConversation(this.store.getApprovalRecord(id)?.conversation_id ?? "");
      return Promise.reject(new ApprovalCancelledError());
    }
    const delay = Math.max(0, Date.parse(expiresAt) - this.now());
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve: () => { cleanup(); resolve(); }, reject: (error) => { cleanup(); reject(error); } };
      const waiters = this.waiters.get(id) ?? new Set<Waiter>();
      waiters.add(waiter);
      this.waiters.set(id, waiters);
      const timer = setTimeout(() => {
        this.store.expireApproval(id, new Date(this.now()).toISOString());
        this.wake(id, new ApprovalExpiredError());
      }, delay);
      const abort = () => {
        this.store.invalidateApprovalsForConversation(this.store.getApprovalRecord(id)?.conversation_id ?? "");
        this.wake(id, new ApprovalCancelledError());
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        const active = this.waiters.get(id);
        active?.delete(waiter);
        if (active?.size === 0) this.waiters.delete(id);
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private wake(id: string, error?: Error): void {
    const waiters = this.waiters.get(id);
    if (!waiters) return;
    for (const waiter of [...waiters]) error ? waiter.reject(error) : waiter.resolve();
  }

  private cancelBatch(batchId: string, exceptId: string): void {
    for (const [id, waiters] of this.waiters) {
      if (id === exceptId) continue;
      const record = this.store.getApprovalRecord(id);
      if (!record || record.approval_batch_id !== batchId) continue;
      for (const waiter of waiters) waiter.reject(new ApprovalDeniedError("Approval batch was rejected"));
      this.waiters.delete(id);
    }
  }

  private expireDue(conversationId: string, tenantId: string, memberId: string): void {
    for (const record of this.store.listOwnedApprovalRecords(conversationId, tenantId, memberId, false)) {
      if ((record.status === "pending" || record.status === "approved") && Date.parse(record.expires_at) <= this.now()) {
        this.store.expireApproval(record.id, new Date(this.now()).toISOString());
        this.wake(record.id, new ApprovalExpiredError());
      }
    }
  }
}

const SAFE_TOOLS = new Set([
  "read", "grep", "find", "ls", "knowledge_search", "knowledge_get",
  "hindsight_recall", "memory_recall", "todo_update", "mention_employee", "delegate_employee",
]);

export function approvalRiskForTool(toolName: string): ApprovalRisk | undefined {
  if (toolName === "bash") return "bash";
  if (toolName === "write") return "write";
  if (toolName === "edit") return "edit";
  if (SAFE_TOOLS.has(toolName)) return undefined;
  // External connectors, memory retain and every unrecognized tool are treated
  // as side-effecting. A remote readOnlyHint cannot lower this classification.
  if (toolName === "hindsight_retain" || toolName === "memory_retain" || /^(?:external|connector|jira)[._:-]/iu.test(toolName)) return "external";
  return "unknown";
}

export function canonicalArgsHmac(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value)) ?? "undefined").digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]));
}

function redactedToolSummary(toolName: string, args: unknown): string {
  const value = boundedRedaction(args);
  const serialized = JSON.stringify(value) ?? "{}";
  return `${toolName}: ${serialized.length <= 800 ? serialized : `${serialized.slice(0, 799)}…`}`;
}

function boundedRedaction(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[内容已省略]";
  if (typeof value === "string") return value
    .replace(/(?:bearer\s+|(?:api[_ -]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/giu, "[内容已隐藏]")
    .replace(/(?:\/(?:Users|Volumes|private|home|tmp|var|workspace|etc|root|opt|srv|mnt|data)(?:\/[^\s"'<>]*)*|[A-Za-z]:\\[^\s"'<>]*)/giu, "[路径已隐藏]")
    .slice(0, 240);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 16).map((item) => boundedRedaction(item, depth + 1));
  if (typeof value !== "object") return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 16)) {
    if (/(?:token|secret|password|credential|authorization|api[_ -]?key|private[_ -]?key|content)/iu.test(key)) continue;
    output[key] = boundedRedaction(item, depth + 1);
  }
  return output;
}
