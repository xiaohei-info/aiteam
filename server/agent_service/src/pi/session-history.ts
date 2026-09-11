import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentSqliteStore, ConversationParticipantRole } from "../storage/sqlite.js";
import { compareReadOrder } from "../storage/read-cursor.js";
import type { WorkRecordRow } from "../storage/work-records.js";
import { safeText } from "./event-sse.js";

export type HistoryOrder = [number, string, string, number, string];
export type HistoryEntry = SessionEntry & {
  work_id?: string;
  entry_ref: string;
  participant_employee_id?: string;
  source_employee_id?: string;
  source_employee_display_name?: string;
  source_type?: "human" | "employee";
  source_id?: string;
  source_display_name?: string;
  source_role?: "human" | "participant" | "coordinator";
  logical_message_id?: string;
};

export interface IndexedHistoryEntry {
  entry: HistoryEntry;
  order: HistoryOrder;
  /** Fan-out copies resolve to the same visible logical message, without losing raw-ID ambiguity. */
  references: Array<{ id: string; entry_ref: string }>;
}

export interface HistorySource {
  employeeId?: string;
  role?: ConversationParticipantRole;
  entries: readonly SessionEntry[];
}

export function historyTimestamp(entry: unknown): number {
  const value = (entry as { timestamp?: unknown } | undefined)?.timestamp;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function historyEntryRef(conversationId: string, employeeId: string | undefined, id: string): string {
  return `entry_v1_${createHash("sha256").update(JSON.stringify([conversationId, employeeId ?? null, id])).digest("base64url")}`;
}

/** Only authoritative live ranges with matching anchors may group a reply. */
export function workIdsForEntries(entries: readonly SessionEntry[], records: readonly WorkRecordRow[]): Map<number, string> {
  const ids = new Map<number, string>();
  const ambiguous = new Set<number>();
  const live = records.filter((row) => row.provenance === "live").sort((a, b) => a.start_ordinal - b.start_ordinal);
  const starts = [...new Set(live.map((row) => row.start_ordinal))];
  const nextStarts = new Map(starts.map((start, index) => [start, starts[index + 1] ?? entries.length]));
  for (const row of live) {
    const start = row.start_ordinal;
    const next = nextStarts.get(start)!;
    const end = row.end_ordinal ?? (row.outcome === "active" ? next : undefined);
    if (end === undefined || start < 0 || end <= start || end > entries.length) continue;
    if (row.first_entry_id && entries[start]?.id !== row.first_entry_id) continue;
    if (row.last_entry_id && entries[end - 1]?.id !== row.last_entry_id) continue;
    for (let ordinal = start; ordinal < end; ordinal++) {
      if (ids.has(ordinal)) ambiguous.add(ordinal);
      else ids.set(ordinal, row.id);
    }
  }
  for (const ordinal of ambiguous) ids.delete(ordinal);
  return ids;
}

/** Pure projection of already-owned Session entries; no Session creation or body persistence. */
export function mergeHistorySources(store: AgentSqliteStore, conversationId: string, sources: HistorySource[]): IndexedHistoryEntry[] {
  const conversation = store.getConversation(conversationId);
  const experts = new Map(store.listLoadedExperts(conversation?.tenantId ?? undefined, conversation?.memberId ?? undefined, true).map((expert) => [expert.employee_id, expert]));
  const workRecords = conversation?.tenantId && conversation.memberId
    ? store.workRecords.forConversation(conversationId, { tenantId: conversation.tenantId, memberId: conversation.memberId }) : [];
  const indexed = sources.flatMap((source) => {
    const workIds = workIdsForEntries(source.entries, workRecords.filter((row) => row.employee_id === source.employeeId));
    return source.entries.flatMap((raw, ordinal): IndexedHistoryEntry[] => {
      if (typeof raw.id !== "string" || raw.type === ("session" as string)) return [];
      const entry: HistoryEntry = { ...raw, entry_ref: historyEntryRef(conversationId, source.employeeId, raw.id) };
      // Never trust a raw runtime field over the owner-scoped work index.
      delete entry.work_id;
      if (raw.type === "message" && (raw.message?.role === "assistant" || raw.message?.role === "toolResult")) {
        const workId = workIds.get(ordinal);
        if (workId) entry.work_id = workId;
      }
      if (source.employeeId) entry.participant_employee_id = source.employeeId;
      if (raw.type === "message" && raw.message?.role === "user") {
        const origin = source.employeeId ? store.getConversationEntrySource(conversationId, source.employeeId, raw.id) : undefined;
        entry.source_type = origin?.source_type ?? "human";
        entry.source_role = entry.source_type === "employee" ? "participant" : "human";
        if (origin) {
          entry.source_id = origin.source_id;
          entry.logical_message_id = origin.logical_message_id;
          if (origin.source_display_name) entry.source_display_name = origin.source_display_name;
          if (origin.source_type === "employee") {
            entry.source_employee_id = origin.source_id;
            entry.source_employee_display_name = origin.source_display_name ?? experts.get(origin.source_id)?.display_name ?? origin.source_id;
          }
        }
      } else if (source.employeeId) {
        entry.source_employee_id = source.employeeId;
        entry.source_employee_display_name = experts.get(source.employeeId)?.display_name ?? source.employeeId;
        entry.source_role = source.role === "coordinator" ? "coordinator" : "participant";
      }
      return [{ entry, order: [historyTimestamp(raw), conversationId, source.employeeId ?? "", ordinal, raw.id], references: [{ id: raw.id, entry_ref: entry.entry_ref }] }];
    });
  }).sort((left, right) => compareReadOrder(left.order, right.order));
  const logicalMessages = new Map<string, IndexedHistoryEntry>();
  return indexed.filter((item) => {
    const entry = item.entry;
    if (entry.type !== "message" || entry.message.role !== "user" || !entry.logical_message_id) return true;
    const key = JSON.stringify([entry.source_type, entry.source_id, entry.logical_message_id]);
    const previous = logicalMessages.get(key);
    if (previous) {
      previous.references.push(...item.references);
      return false;
    }
    logicalMessages.set(key, item);
    return true;
  });
}

/** Redact complete concatenated text, including split secrets, without altering literal whitespace. */
export function searchableHistoryText(entry: unknown): string | null {
  const raw = entry as { type?: string; message?: { role?: string; content?: unknown } };
  if (raw.type !== "message" || !["user", "assistant"].includes(raw.message?.role ?? "")) return null;
  const content = raw.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.flatMap((part) => part?.type === "text" && typeof part.text === "string" ? [part.text] : part?.type === "image" ? [" [图片] "] : []).join("")
    : "";
  return safeText(text, Infinity) || null;
}

/** Display-only whitespace normalization; search matches searchableHistoryText before taking a snippet. */
export function visibleHistoryText(entry: unknown): string | null {
  return searchableHistoryText(entry)?.replace(/\s+/gu, " ").trim() || null;
}
