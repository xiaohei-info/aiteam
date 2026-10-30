import type { AuthenticatedCaller } from "../http/auth.js";
import type { AgentSqliteStore } from "../storage/sqlite.js";
import { usdDecimal, usdUnits } from "../usage.js";
import { ConversationReadError, validateReadQuery } from "./conversation-reads.js";
import { workReadFilter } from "./work-records.js";

/** One execution's contribution; usage counters are absent when the source never measured them. */
interface UsageSample {
  employeeId: string;
  count: number;
  succeeded: number;
  nonSuccess: number;
  usage?: { input: number; output: number; cache: number; duration: number; costUnits?: bigint };
}

/** Sums samples with the same "unknown cost is never zero" rule for the total and every group. */
class UsageAccumulator {
  executionCount = 0; succeededCount = 0; nonSuccessCount = 0;
  input = 0; output = 0; cache = 0; duration = 0;
  unknownCount = 0; knownCount = 0; cost = 0n;

  add(sample: UsageSample): void {
    this.executionCount += sample.count;
    this.succeededCount += sample.succeeded;
    this.nonSuccessCount += sample.nonSuccess;
    if (sample.usage) {
      this.input += sample.usage.input;
      this.output += sample.usage.output;
      this.cache += sample.usage.cache;
      this.duration += sample.usage.duration;
    }
    if (sample.usage?.costUnits !== undefined) {
      this.cost += sample.usage.costUnits;
      this.knownCount += sample.count;
    } else this.unknownCount += sample.count;
  }

  totals(excluded: number) {
    const complete = this.unknownCount === 0 && excluded === 0;
    return {
      execution_count: this.executionCount, succeeded_count: this.succeededCount, non_success_count: this.nonSuccessCount,
      input_tokens: this.input, output_tokens: this.output, cache_tokens: this.cache, token_total: this.input + this.output + this.cache, duration_ms_total: this.duration,
      currency: "USD" as const, cost_total: complete ? usdDecimal(this.cost) : null, known_cost_total: usdDecimal(this.cost),
      cost_minor: complete ? Number((this.cost + 5_000_000_000n) / 10_000_000_000n) : null,
      pricing_status: complete ? "known" : this.knownCount > 0 ? "partial" : "unknown",
      unpriced_execution_count: this.unknownCount,
    };
  }
}

const QUERY_KEYS = ["employee_id", "conversation_id", "group_by", "window_start", "window_end"] as const;

/**
 * Member-wide figures come from the retained hourly outbox, the only aggregate ledger regardless of
 * upload status. Hourly summaries carry no conversation, so a conversation filter reads the
 * per-execution work records instead and says so in `coverage`.
 */
export class UsageStatisticsService {
  constructor(private readonly store: AgentSqliteStore) {}

  statistics(caller: AuthenticatedCaller, query: URLSearchParams) {
    validateReadQuery(query, QUERY_KEYS);
    const filter = workReadFilter(caller, query, true);
    const conversationId = query.get("conversation_id");
    if (conversationId !== null && (!conversationId.trim() || conversationId.length > 256)) throw new ConversationReadError(422, "invalid_conversation_id", "conversation_id must be non-blank and at most 256 characters");
    const groupBy = query.get("group_by");
    if (groupBy !== null && groupBy !== "employee") throw new ConversationReadError(422, "invalid_group_by", "group_by must be employee");
    const { samples, excluded } = conversationId === null ? this.hourlySamples(filter) : this.workRecordSamples(filter, conversationId);
    const total = new UsageAccumulator();
    const groups = new Map<string, UsageAccumulator>();
    for (const sample of samples) {
      total.add(sample);
      if (groupBy === null) continue;
      let group = groups.get(sample.employeeId);
      if (!group) groups.set(sample.employeeId, group = new UsageAccumulator());
      group.add(sample);
    }
    return { data: {
      scope: "member_local" as const,
      coverage: conversationId === null ? "recorded_hourly_summaries" as const : "work_records" as const,
      employee_id: filter.employeeId ?? null, conversation_id: conversationId,
      window_start: filter.start === undefined ? null : new Date(filter.start).toISOString(),
      window_end: filter.end === undefined ? null : new Date(filter.end).toISOString(),
      bucket: "utc_hour" as const,
      ...total.totals(excluded),
      excluded_summary_count: excluded,
      ...(groupBy === null ? {} : {
        groups: [...groups.entries()]
          .map(([employeeId, group]) => ({ employee_id: employeeId, ...group.totals(0) }))
          .sort((a, b) => b.token_total - a.token_total || a.employee_id.localeCompare(b.employee_id)),
      }),
    } };
  }

  private hourlySamples(filter: ReturnType<typeof workReadFilter>): { samples: UsageSample[]; excluded: number } {
    const rows = this.store.db.prepare("SELECT payload_json, cost_total_decimal FROM usage_summary_outbox WHERE kind = 'usage' AND tenant_id = ? AND member_id = ?")
      .all(filter.tenantId, filter.memberId) as { payload_json: string; cost_total_decimal: string | null }[];
    const samples: UsageSample[] = [];
    let excluded = 0;
    for (const row of rows) {
      let value: Record<string, unknown>;
      try { value = JSON.parse(row.payload_json); } catch { excluded += 1; continue; }
      if (!value || value.tenant_id !== filter.tenantId || value.member_id !== filter.memberId) { excluded += 1; continue; }
      if (filter.employeeId && value.employee_id !== filter.employeeId) continue;
      const start = typeof value.window_start === "string" ? Date.parse(value.window_start) : NaN;
      const end = typeof value.window_end === "string" ? Date.parse(value.window_end) : NaN;
      if (!Number.isFinite(start) || start % 3_600_000 || end !== start + 3_600_000) { excluded += 1; continue; }
      if (filter.start !== undefined && (start < filter.start || start >= filter.end!)) continue;
      const fields = ["prompt_count", "settled_count", "error_count", "input_tokens", "output_tokens", "cache_tokens", "duration_ms_total"] as const;
      if (value.schema_version !== "1" || value.currency !== "USD" || fields.some((field) => typeof value[field] !== "number" || !Number.isSafeInteger(value[field]) || (value[field] as number) < 0)) { excluded += 1; continue; }
      const units = usdUnits(row.cost_total_decimal ?? value.cost_total);
      samples.push({
        // Legacy summaries without a usable employee stay in the totals, grouped as unknown.
        employeeId: typeof value.employee_id === "string" ? value.employee_id : "unknown",
        count: value.prompt_count as number,
        succeeded: value.settled_count as number,
        nonSuccess: value.error_count as number,
        usage: {
          input: value.input_tokens as number, output: value.output_tokens as number, cache: value.cache_tokens as number,
          duration: value.duration_ms_total as number,
          // Stored legacy precision cannot be recovered; never substitute rounded cost_minor.
          ...(value.pricing_status === "known" && units !== undefined ? { costUnits: units } : {}),
        },
      });
    }
    return { samples, excluded };
  }

  /** Settled live executions only; rebuilt history and unmeasured runs count as unpriced, never as zero. */
  private workRecordSamples(filter: ReturnType<typeof workReadFilter>, conversationId: string): { samples: UsageSample[]; excluded: number } {
    const rows = this.store.db.prepare(`SELECT employee_id, outcome, started_at, ended_at, occurred_at, usage_json FROM work_record
      WHERE tenant_id = ? AND member_id = ? AND conversation_id = ? AND provenance = 'live' AND outcome <> 'active'`)
      .all(filter.tenantId, filter.memberId, conversationId) as { employee_id: string; outcome: string; started_at: number | null; ended_at: number | null; occurred_at: number | null; usage_json: string | null }[];
    const samples: UsageSample[] = [];
    let excluded = 0;
    for (const row of rows) {
      if (filter.employeeId && row.employee_id !== filter.employeeId) continue;
      if (filter.start !== undefined && (row.occurred_at === null || row.occurred_at < filter.start || row.occurred_at >= filter.end!)) continue;
      let usage: Record<string, unknown> | null = null;
      if (row.usage_json !== null) {
        try { usage = JSON.parse(row.usage_json); } catch { excluded += 1; continue; }
      }
      const counters = usage && ["input_tokens", "output_tokens", "cache_tokens"].every((field) => Number.isSafeInteger(usage![field]) && (usage![field] as number) >= 0);
      const units = usage?.pricing_status === "known" ? usdUnits(usage.cost_total) : undefined;
      const duration = row.started_at !== null && row.ended_at !== null ? Math.max(0, row.ended_at - row.started_at) : 0;
      samples.push({
        employeeId: row.employee_id,
        count: 1,
        succeeded: row.outcome === "succeeded" ? 1 : 0,
        nonSuccess: row.outcome === "succeeded" ? 0 : 1,
        ...(counters ? { usage: {
          input: usage!.input_tokens as number, output: usage!.output_tokens as number, cache: usage!.cache_tokens as number,
          duration, ...(units !== undefined ? { costUnits: units } : {}),
        } } : {}),
      });
    }
    return { samples, excluded };
  }
}
