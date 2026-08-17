import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface UsageSummary {
  schema_version: "1";
  summary_id: string;
  tenant_id: string;
  member_id: string;
  employee_id: string;
  window_start: string;
  window_end: string;
  prompt_count: number;
  settled_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  cost_minor: number;
  currency: "USD";
  duration_ms_total: number;
  /** Manager's existing rollup aliases; these remain aggregate-only. */
  run_count: number;
  token_total: number;
  cost_total: number;
  duration_seconds_total: number;
}

export interface UsageCapture {
  tenantId: string;
  memberId: string;
  employeeId: string;
  startedAt: number;
  endedAt: number;
  entries: readonly SessionEntry[];
  settled: boolean;
}

/** Build the only shape allowed into the Agent→Manager usage outbox. */
export function aggregateUsage(capture: UsageCapture): UsageSummary {
  const start = new Date(capture.startedAt);
  start.setUTCMinutes(0, 0, 0);
  const windowStart = start.toISOString();
  const windowEnd = new Date(start.getTime() + 60 * 60 * 1000).toISOString();
  let input = 0;
  let output = 0;
  let cache = 0;
  let cost = 0;
  for (const entry of capture.entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const usage = (entry.message as unknown as { usage?: Record<string, unknown> }).usage;
    if (!usage) continue;
    input += finite(usage.input);
    output += finite(usage.output);
    cache += finite(usage.cacheRead) + finite(usage.cacheWrite);
    const costValue = usage.cost;
    if (costValue && typeof costValue === "object") cost += finite((costValue as Record<string, unknown>).total);
  }
  const summaryId = createHash("sha256")
    .update(`${capture.tenantId}:${capture.memberId}:${capture.employeeId}:${windowStart}`)
    .digest("hex");
  return {
    schema_version: "1",
    summary_id: summaryId,
    tenant_id: capture.tenantId,
    member_id: capture.memberId,
    employee_id: capture.employeeId,
    window_start: windowStart,
    window_end: windowEnd,
    prompt_count: 1,
    settled_count: capture.settled ? 1 : 0,
    error_count: capture.settled ? 0 : 1,
    input_tokens: input,
    output_tokens: output,
    cache_tokens: cache,
    cost_minor: Math.round(cost * 100),
    currency: "USD",
    duration_ms_total: Math.max(0, capture.endedAt - capture.startedAt),
    run_count: 1,
    token_total: input + output + cache,
    cost_total: Math.round(cost * 100) / 100,
    duration_seconds_total: Math.ceil(Math.max(0, capture.endedAt - capture.startedAt) / 1000),
  };
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
