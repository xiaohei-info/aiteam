import type { AuthenticatedCaller } from "../http/auth.js";
import type { AgentSqliteStore } from "../storage/sqlite.js";
import { usdDecimal, usdUnits } from "../usage.js";
import { validateReadQuery } from "./conversation-reads.js";
import { workReadFilter } from "./work-records.js";

/** The retained hourly outbox is the only aggregate ledger, regardless of upload status. */
export class UsageStatisticsService {
  constructor(private readonly store: AgentSqliteStore) {}

  statistics(caller: AuthenticatedCaller, query: URLSearchParams) {
    validateReadQuery(query, ["employee_id", "window_start", "window_end"]);
    const filter = workReadFilter(caller, query, true);
    const rows = this.store.db.prepare("SELECT payload_json, cost_total_decimal FROM usage_summary_outbox WHERE kind = 'usage' AND tenant_id = ? AND member_id = ?")
      .all(filter.tenantId, filter.memberId) as { payload_json: string; cost_total_decimal: string | null }[];
    let executionCount = 0, succeededCount = 0, nonSuccessCount = 0, input = 0, output = 0, cache = 0, duration = 0;
    let unknownCount = 0, excluded = 0, knownCount = 0;
    let cost = 0n;
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
      const count = value.prompt_count as number;
      executionCount += count;
      succeededCount += value.settled_count as number;
      nonSuccessCount += value.error_count as number;
      input += value.input_tokens as number;
      output += value.output_tokens as number;
      cache += value.cache_tokens as number;
      duration += value.duration_ms_total as number;
      const units = usdUnits(row.cost_total_decimal ?? value.cost_total);
      if (value.pricing_status === "known" && units !== undefined) {
        // Stored legacy precision cannot be recovered; never substitute rounded cost_minor.
        cost += units;
        knownCount += count;
      } else unknownCount += count;
    }
    const complete = unknownCount === 0 && excluded === 0;
    return { data: {
      scope: "member_local" as const, coverage: "recorded_hourly_summaries" as const, employee_id: filter.employeeId ?? null,
      window_start: filter.start === undefined ? null : new Date(filter.start).toISOString(),
      window_end: filter.end === undefined ? null : new Date(filter.end).toISOString(),
      bucket: "utc_hour" as const, execution_count: executionCount, succeeded_count: succeededCount, non_success_count: nonSuccessCount,
      input_tokens: input, output_tokens: output, cache_tokens: cache, token_total: input + output + cache, duration_ms_total: duration,
      currency: "USD" as const, cost_total: complete ? usdDecimal(cost) : null, known_cost_total: usdDecimal(cost),
      cost_minor: complete ? Number((cost + 5_000_000_000n) / 10_000_000_000n) : null,
      pricing_status: complete ? "known" : knownCount > 0 ? "partial" : "unknown",
      unpriced_execution_count: unknownCount, excluded_summary_count: excluded,
    } };
  }
}
