import type { AuthenticatedCaller } from "../http/auth.js";
import type { GroupOrchestration } from "../groups/orchestration.js";
import type { SessionHost } from "../pi/session-host.js";
import type { AgentSqliteStore, ConversationMetadata, ConversationPermissionMode } from "../storage/sqlite.js";

export interface GroupParticipantSeed {
  id: string;
  version: string;
}

/** Fully resolved group input shared by solution and custom creation entrypoints. */
export interface ResolvedGroupConversation {
  id: string;
  title: string | null;
  labels: string[];
  description?: string | null;
  orchestration?: GroupOrchestration | null;
  coordinatorEmployeeId: string;
  solutionRef?: string | null;
  schedule?: Record<string, unknown> | null;
  permissionMode: ConversationPermissionMode;
  tenantId: string;
  memberId: string;
  participants: readonly GroupParticipantSeed[];
}

export class GroupCreationError extends Error {
  constructor(readonly status: 404 | 409, readonly code: "conversation_not_found" | "conversation_exists", message: string) {
    super(message);
    this.name = "GroupCreationError";
  }
}

/**
 * Shared persistence/session lifecycle for every group creation source.
 * Source-specific resolvers only decide the roster and group behavior.
 */
export class GroupCreationService {
  constructor(
    private readonly store: AgentSqliteStore,
    private readonly host: Pick<SessionHost, "initializeConversationParticipants" | "delete">,
  ) {}

  assertAvailable(id: string, tenantId: string, memberId: string): void {
    const existing = this.store.getConversationMetadata(id);
    if (existing) {
      if (existing.tenant_id === tenantId && existing.member_id === memberId) {
        throw new GroupCreationError(409, "conversation_exists", "Conversation already exists");
      }
      throw new GroupCreationError(404, "conversation_not_found", "Conversation not found");
    }
  }

  async create(input: ResolvedGroupConversation, caller: AuthenticatedCaller): Promise<ConversationMetadata> {
    this.assertAvailable(input.id, input.tenantId, input.memberId);
    this.store.createGroupConversation({
      id: input.id,
      kind: "group",
      title: input.title,
      labels: input.labels,
      state: "active",
      entryEmployeeId: null,
      coordinatorEmployeeId: input.coordinatorEmployeeId,
      solutionRef: input.solutionRef ?? null,
      tenantId: input.tenantId,
      memberId: input.memberId,
      schedule: input.schedule ?? null,
      description: input.description ?? null,
      orchestration: input.orchestration ?? null,
      permissionMode: input.permissionMode,
    }, input.participants);

    try {
      await this.host.initializeConversationParticipants(input.id, caller);
    } catch (error) {
      await this.host.delete(input.id, input.tenantId, input.memberId).catch(() => undefined);
      throw error;
    }
    return this.store.getConversationMetadata(input.id)!;
  }
}
