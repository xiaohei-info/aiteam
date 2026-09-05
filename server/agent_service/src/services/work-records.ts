import type { AuthenticatedCaller } from "../http/auth.js";
import type { SessionHost } from "../pi/session-host.js";
import { historyEntryRef, visibleHistoryText, type HistorySource } from "../pi/session-history.js";
import { historicalWorkSegments, lastAssistantStopReason, observedWorkOutcome, workEntryTime } from "../pi/work-history.js";
import { safeText } from "../pi/event-sse.js";
import type { AgentSqliteStore } from "../storage/sqlite.js";
import type { WorkFilter, WorkRecordRow } from "../storage/work-records.js";
import { decodeReadCursor, encodeReadCursor, InvalidReadCursorError, readCursorScope } from "../storage/read-cursor.js";
import type { WorkUsage } from "../usage.js";
import { ConversationReadError, readPageLimit, validateReadQuery } from "./conversation-reads.js";

export function workReadFilter(caller: AuthenticatedCaller, query: URLSearchParams, hourly = false): WorkFilter {
  const employeeId = query.get("employee_id");
  if (employeeId !== null && (!employeeId.trim() || employeeId.length > 256)) throw new ConversationReadError(422, "invalid_employee_id", "employee_id must be non-blank and at most 256 characters");
  const rawStart = query.get("window_start");
  const rawEnd = query.get("window_end");
  const timestamp = (value: string | null) => {
    if (!value || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return NaN;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return NaN;
    const normalized = value.includes(".") ? value.replace(/\.(\d+)Z$/, (_, digits: string) => `.${digits.padEnd(3, "0")}Z`) : value.replace("Z", ".000Z");
    return new Date(parsed).toISOString() === normalized ? parsed : NaN;
  };
  const start = rawStart === null && rawEnd === null ? undefined : timestamp(rawStart);
  const end = rawStart === null && rawEnd === null ? undefined : timestamp(rawEnd);
  if (start !== undefined && (!Number.isFinite(start) || !Number.isFinite(end) || start >= end! || (hourly && (start % 3_600_000 !== 0 || end! % 3_600_000 !== 0)))) {
    throw new ConversationReadError(422, "invalid_time_range", hourly ? "Use paired UTC hour-aligned [window_start,window_end), with start < end" : "Use paired UTC [window_start,window_end), with start < end");
  }
  return { tenantId: caller.tenantId ?? "", memberId: caller.userId ?? caller.callerId, ...(employeeId === null ? {} : { employeeId }), ...(start === undefined ? {} : { start, end }) };
}

function changeScope(filter: WorkFilter): string {
  return readCursorScope("work-records:changes", [filter.tenantId, filter.memberId], [filter.employeeId ?? null]);
}

/** Query index and safe summaries; only Pi JSONL/live entries contain message bodies. */
export class WorkRecordReadService {
  constructor(private readonly store: AgentSqliteStore, private readonly host: Pick<SessionHost, "readHistorySources">) {}

  history(caller: AuthenticatedCaller, query: URLSearchParams) {
    validateReadQuery(query, ["employee_id", "window_start", "window_end", "limit", "before"]);
    const filter = workReadFilter(caller, query);
    const limit = readPageLimit(query);
    const scope = readCursorScope("work-records:before", [filter.tenantId, filter.memberId], [filter.employeeId ?? null, filter.start ?? null, filter.end ?? null]);
    const raw = query.get("before");
    const cursor = raw === null ? undefined : decodeReadCursor(raw, scope, ["number", "number", "number"]) as [number, number, number];
    if (cursor && (cursor[1] < 1 || cursor[2] < 0 || cursor[2] > this.store.workRecords.watermark(filter))) throw new InvalidReadCursorError();
    const sources = this.backfill(caller, filter);
    const watermark = cursor?.[2] ?? this.store.workRecords.watermark(filter);
    const rows = this.store.workRecords.history(filter, limit + 1, cursor ? [cursor[0], cursor[1]] : undefined);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map((row) => this.view(row, sources)),
      page: { has_more: rows.length > limit, next_cursor: rows.length > limit && last ? encodeReadCursor(scope, [last.occurred_at ?? -8640000000000000, last.created_seq, watermark]) : null },
      meta: { after: encodeReadCursor(changeScope(filter), [watermark]) },
    };
  }

  changes(caller: AuthenticatedCaller, query: URLSearchParams) {
    validateReadQuery(query, ["employee_id", "after", "limit"]);
    const filter = workReadFilter(caller, query);
    const limit = readPageLimit(query);
    const scope = changeScope(filter);
    const raw = query.get("after");
    const after = raw === null ? 0 : decodeReadCursor(raw, scope, ["number"])[0] as number;
    if (after < 0 || after > this.store.workRecords.watermark(filter)) throw new InvalidReadCursorError();
    const sources = this.backfill(caller, filter);
    const rows = this.store.workRecords.changes(filter, after, limit + 1);
    const page = rows.slice(0, limit);
    const next = rows.length > limit ? page.at(-1)!.seq : this.store.workRecords.watermark(filter);
    return {
      data: page.map((change) => change.deleted ? { operation: "delete" as const, record_id: change.record_id } : {
        operation: "upsert" as const, record_id: change.record_id, record: this.view(this.store.workRecords.get(change.record_id, filter)!, sources),
      }),
      page: { has_more: rows.length > limit, next_cursor: encodeReadCursor(scope, [next]) },
    };
  }

  private backfill(caller: AuthenticatedCaller, filter: WorkFilter): Map<string, HistorySource[]> {
    const sources = new Map<string, HistorySource[]>();
    let cursor: string | undefined;
    do {
      const page = this.store.listConversations(100, cursor, filter.tenantId, filter.memberId);
      for (const conversation of page.items) {
        const history = this.host.readHistorySources(conversation.id, caller);
        sources.set(conversation.id, history);
        for (const source of history) {
          if (!source.employeeId || (filter.employeeId && filter.employeeId !== source.employeeId)) continue;
          const segments = historicalWorkSegments(source.entries).map((segment) => {
            const entries = source.entries.slice(segment.start, segment.end);
            const first = entries[0]!;
            const last = entries.at(-1)!;
            return {
              startOrdinal: segment.start, endOrdinal: segment.end, firstEntryId: first.id, lastEntryId: last.id,
              firstEntryAt: workEntryTime(first), lastEntryAt: workEntryTime(last),
              outcome: observedWorkOutcome(lastAssistantStopReason(entries), true),
            };
          });
          this.store.workRecords.importHistory({ ...filter, conversationId: conversation.id, employeeId: source.employeeId }, segments);
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return sources;
  }

  private view(row: WorkRecordRow, sources: Map<string, HistorySource[]>) {
    const conversation = this.store.getOwnedConversationMetadata(row.conversation_id, row.tenant_id, row.member_id)!;
    const entries = sources.get(row.conversation_id)?.find((source) => source.employeeId === row.employee_id)?.entries ?? [];
    const endOrdinal = row.end_ordinal ?? this.store.workRecords.forConversation(row.conversation_id, { tenantId: row.tenant_id, memberId: row.member_id })
      .filter((next) => next.employee_id === row.employee_id && next.provenance === "live" && next.created_seq > row.created_seq && next.start_ordinal >= row.start_ordinal)
      .reduce((end, next) => Math.min(end, next.start_ordinal), entries.length);
    const candidate = entries.slice(row.start_ordinal, endOrdinal);
    // Ordinals alone are not identity: a replaced/truncated Session must not relabel another prompt.
    const range = (row.first_entry_id !== null && candidate[0]?.id !== row.first_entry_id)
      || (row.last_entry_id !== null && entries[endOrdinal - 1]?.id !== row.last_entry_id) ? [] : candidate;
    const input = range.find((entry) => entry.type === "message" && entry.message.role === "user");
    const output = [...range].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
    const source = input ? this.store.getConversationEntrySource(row.conversation_id, row.employee_id, input.id) : undefined;
    const expert = this.store.listLoadedExperts(row.tenant_id, row.member_id, true).find((item) => item.employee_id === row.employee_id);
    const time = (value: number | null) => value === null ? null : new Date(value).toISOString();
    const summary = input ? visibleHistoryText(input) : null;
    const result = output ? visibleHistoryText(output) : null;
    return {
      id: row.id, employee_id: row.employee_id, employee_display_name: safeText(expert?.display_name ?? row.employee_id, 256),
      conversation_id: row.conversation_id, conversation_title: conversation.title ? safeText(conversation.title, 200) : null,
      provenance: row.provenance, outcome: row.outcome, reason: row.reason,
      time_basis: row.occurred_at === null ? "unknown" : row.provenance === "live" ? "prompt_start" : "pi_entry",
      occurred_at: time(row.occurred_at), started_at: time(row.started_at), ended_at: time(row.ended_at), updated_at: time(row.updated_at)!,
      first_entry_at: time(row.first_entry_at), last_entry_at: time(row.last_entry_at),
      input_entry_ref: input ? historyEntryRef(row.conversation_id, row.employee_id, input.id) : null,
      output_entry_ref: output ? historyEntryRef(row.conversation_id, row.employee_id, output.id) : null,
      source_type: source?.source_type ?? null, source_id: source?.source_id ?? null,
      task_summary: summary ? safeText(summary, 240) : null, result_summary: result ? safeText(result, 240) : null,
      usage: row.usage_json ? JSON.parse(row.usage_json) as WorkUsage : null,
    };
  }
}
