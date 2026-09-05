import type { AuthenticatedCaller } from "../http/auth.js";
import { employeeDisplay } from "./employee-display.js";
import type { AgentSqliteStore, ConversationMetadata } from "../storage/sqlite.js";
import { compareReadOrder, decodeReadCursor, encodeReadCursor, readCursorScope } from "../storage/read-cursor.js";
import type { SessionHost } from "../pi/session-host.js";
import { safeText, serializePiEntry } from "../pi/event-sse.js";
import { searchableHistoryText, visibleHistoryText, type HistoryOrder, type IndexedHistoryEntry } from "../pi/session-history.js";

export class ConversationReadError extends Error {
  constructor(readonly status: 404 | 422, readonly code: string, message: string) {
    super(message);
    this.name = "ConversationReadError";
  }
}

export function validateReadQuery(query: URLSearchParams, allowed: readonly string[]): void {
  for (const key of query.keys()) {
    if (!allowed.includes(key) || query.getAll(key).length !== 1) throw new ConversationReadError(422, "invalid_query", "Unsupported or repeated query parameter");
  }
}

export function readPageLimit(query: URLSearchParams): number {
  const raw = query.get("limit");
  const limit = raw === null ? 50 : /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ConversationReadError(422, "invalid_limit", "limit must be an integer between 1 and 100");
  return limit;
}

function resolveReadEntry(entries: IndexedHistoryEntry[], reference: string): IndexedHistoryEntry | undefined {
  const matches = entries.flatMap((item) => item.references.filter((ref) => ref.entry_ref === reference || ref.id === reference).map(() => item));
  return matches.length === 1 ? matches[0] : undefined;
}

const HISTORY_ORDER_TYPES = ["number", "string", "string", "number", "string"] as const;

export class ConversationReadService {
  constructor(private readonly store: AgentSqliteStore, private readonly host: Pick<SessionHost, "readEntries" | "entries">) {}

  private owned(conversationId: string, caller: AuthenticatedCaller): ConversationMetadata {
    const metadata = caller.tenantId && this.store.getOwnedConversationMetadata(conversationId, caller.tenantId, caller.userId ?? caller.callerId);
    if (!metadata) throw new ConversationReadError(404, "conversation_not_found", "Conversation not found");
    return metadata;
  }

  metadata(conversationId: string, caller: AuthenticatedCaller) {
    const metadata = this.owned(conversationId, caller);
    const entries = this.host.readEntries(conversationId, caller);
    const read = metadata.last_read_entry_id ? resolveReadEntry(entries, metadata.last_read_entry_id) : undefined;
    let lastPreview: string | null = null;
    let unreadCount = 0;
    for (const item of entries) {
      const text = visibleHistoryText(item.entry);
      if (!text) continue;
      lastPreview = safeText(text, 200);
      if (item.entry.type === "message" && item.entry.message.role === "assistant" && (!read || compareReadOrder(item.order, read.order) > 0)) unreadCount += 1;
    }
    return { ...metadata, last_preview: lastPreview, unread_count: unreadCount };
  }

  readPointer(conversationId: string, caller: AuthenticatedCaller, value: unknown): string | null {
    this.owned(conversationId, caller);
    if (value === null) return null;
    if (typeof value !== "string" || !value || value.length > 256) throw new ConversationReadError(422, "invalid_last_read_entry_id", "Read pointer must identify an entry in this conversation");
    const entry = resolveReadEntry(this.host.readEntries(conversationId, caller), value);
    if (!entry) throw new ConversationReadError(422, "invalid_last_read_entry_id", "Read pointer is invalid or ambiguous in this conversation");
    return entry.entry.entry_ref;
  }

  participants(conversationId: string, caller: AuthenticatedCaller) {
    this.owned(conversationId, caller);
    const memberId = caller.userId ?? caller.callerId;
    const experts = new Map(this.store.listLoadedExperts(caller.tenantId, memberId, true).map((expert) => [expert.employee_id, expert]));
    const snapshots = this.store.listSnapshots(caller.tenantId, memberId);
    const participants = this.store.listConversationParticipants(conversationId).map((participant) => {
      const expert = experts.get(participant.employee_id);
      return {
        employee_id: safeText(participant.employee_id, 256),
        display_name: safeText(expert?.display_name ?? participant.employee_id, 256),
        handle: expert ? safeText(expert.handle, 256) : null,
        ...employeeDisplay(expert),
        role: participant.role === "coordinator" ? "coordinator" as const : "participant" as const,
        available: Boolean(expert && !expert.revoked && (expert.status === undefined || expert.status === "active") && snapshots.some((snapshot) => snapshot.employee_id === expert.employee_id && snapshot.version === expert.version)),
      };
    });
    return { data: { conversation_id: conversationId, participants, employee_count: participants.length } };
  }

  async entries(conversationId: string, caller: AuthenticatedCaller, query: URLSearchParams) {
    this.owned(conversationId, caller);
    validateReadQuery(query, ["limit", "cursor", "entry_ref"]);
    if (query.size === 0) {
      const entries = await this.host.entries(conversationId, caller);
      return { data: { conversation_id: conversationId, entries: entries.map(serializePiEntry).filter(Boolean) } };
    }
    const limit = readPageLimit(query);
    const scope = readCursorScope("entries:ascending", [caller.tenantId, caller.userId ?? caller.callerId], [conversationId]);
    const cursor = query.get("cursor");
    const reference = query.get("entry_ref");
    if (cursor !== null && reference !== null) throw new ConversationReadError(422, "invalid_query", "entry_ref and cursor cannot be combined");
    const boundary = cursor === null ? undefined : decodeReadCursor(cursor, scope, HISTORY_ORDER_TYPES) as HistoryOrder;
    let entries = this.host.readEntries(conversationId, caller);
    if (boundary) entries = entries.filter((item) => compareReadOrder(item.order, boundary) > 0);
    if (reference !== null) {
      const anchor = resolveReadEntry(entries, reference);
      if (!anchor || !reference.startsWith("entry_v1_")) throw new ConversationReadError(422, "invalid_entry_ref", "entry_ref must identify an entry in this conversation");
      entries = entries.filter((item) => compareReadOrder(item.order, anchor.order) >= 0);
    }
    const page = entries.slice(0, limit);
    const last = page.at(-1);
    return {
      data: { conversation_id: conversationId, entries: page.map((item) => serializePiEntry(item.entry)).filter(Boolean) },
      page: { next_cursor: entries.length > limit && last ? encodeReadCursor(scope, last.order) : null, has_more: entries.length > limit },
    };
  }

  search(caller: AuthenticatedCaller, query: URLSearchParams) {
    validateReadQuery(query, ["q", "conversation_id", "employee_id", "limit", "cursor"]);
    const q = query.get("q")?.trim();
    if (!q || q.length > 200) throw new ConversationReadError(422, "invalid_q", "q must contain 1 to 200 non-blank characters");
    const limit = readPageLimit(query);
    const conversationId = query.get("conversation_id");
    const employeeId = query.get("employee_id");
    if (conversationId === "" || employeeId === "") throw new ConversationReadError(422, "invalid_query", "Search filters must be non-empty");
    if (conversationId) this.owned(conversationId, caller);
    const scope = readCursorScope("messages:descending", [caller.tenantId, caller.userId ?? caller.callerId], [q.toLowerCase(), conversationId, employeeId]);
    const cursor = query.get("cursor");
    const boundary = cursor === null ? undefined : decodeReadCursor(cursor, scope, HISTORY_ORDER_TYPES) as HistoryOrder;
    const matches: Array<{ order: HistoryOrder; value: Record<string, unknown> }> = [];
    for (const conversation of conversationId ? [this.owned(conversationId, caller)] : this.allConversations(caller)) {
      for (const item of this.host.readEntries(conversation.id, caller)) {
        if (boundary && compareReadOrder(item.order, boundary) >= 0) continue;
        if (employeeId && item.entry.source_employee_id !== employeeId) continue;
        const text = searchableHistoryText(item.entry);
        const position = text?.toLowerCase().indexOf(q.toLowerCase()) ?? -1;
        if (!text || position < 0) continue;
        const metadata = serializePiEntry({ ...item.entry, message: undefined })!;
        const start = Math.max(0, position - 40);
        const snippetText = text.slice(start, start + 238).replace(/\s+/gu, " ").trim();
        const snippet = `${start > 0 ? "…" : ""}${snippetText}${text.length > start + 238 ? "…" : ""}`;
        const value: Record<string, unknown> = {
          conversation_id: conversation.id,
          conversation_title: conversation.title === null ? null : safeText(conversation.title, 200),
          entry_ref: item.entry.entry_ref,
          id: metadata.id,
          participant_employee_id: metadata.participant_employee_id ?? null,
          timestamp: new Date(item.order[0]).toISOString(),
          role: item.entry.type === "message" ? item.entry.message.role : "user",
          snippet,
        };
        for (const field of ["source_type", "source_id", "source_display_name", "source_employee_id", "source_employee_display_name", "source_role", "logical_message_id"] as const) {
          if (metadata[field] !== undefined) value[field] = metadata[field];
        }
        matches.push({ order: item.order, value });
      }
    }
    matches.sort((left, right) => compareReadOrder(right.order, left.order));
    const page = matches.slice(0, limit);
    const last = page.at(-1);
    return { data: page.map((item) => item.value), page: { next_cursor: matches.length > limit && last ? encodeReadCursor(scope, last.order) : null, has_more: matches.length > limit } };
  }

  private *allConversations(caller: AuthenticatedCaller): Generator<ConversationMetadata> {
    let cursor: string | undefined;
    do {
      const page = this.store.listConversations(100, cursor, caller.tenantId!, caller.userId ?? caller.callerId);
      yield* page.items;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
}
