import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { RuntimePricingSnapshot } from "./pi/model-runtime.js";

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
  pricing_version: number | null;
  pricing_status: "known" | "unknown";
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
  pricing?: RuntimePricingSnapshot | null;
}

/** Build the only shape allowed into the Agent→Manager usage outbox. */
export function aggregateUsage(capture: UsageCapture): UsageSummary {
  const start = new Date(capture.startedAt);
  start.setUTCMinutes(0, 0, 0);
  const windowStart = start.toISOString();
  const windowEnd = new Date(start.getTime() + 60 * 60 * 1000).toISOString();
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const entry of capture.entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const usage = (entry.message as unknown as { usage?: Record<string, unknown> }).usage;
    if (!usage) continue;
    input += finite(usage.input);
    output += finite(usage.output);
    cacheRead += finite(usage.cacheRead);
    cacheWrite += finite(usage.cacheWrite);
  }
  const pricing = capture.pricing;
  const pricingKnown = pricing?.pricing_status === "known";
  const cost = pricingKnown
    ? pricing.billing_mode === "request"
      ? decimal(pricing.request_usd)
      : (input * decimal(pricing.input_usd_per_million)
        + output * decimal(pricing.output_usd_per_million)
        + cacheRead * decimal(pricing.cache_read_usd_per_million)
        + cacheWrite * decimal(pricing.cache_write_usd_per_million)) / 1_000_000
    : 0;
  const cache = cacheRead + cacheWrite;
  const costTotal = Math.round(cost * 1_000_000) / 1_000_000;
  const summaryId = createHash("sha256")
    .update(`${capture.tenantId}:${capture.memberId}:${capture.employeeId}:${windowStart}:${pricing?.pricing_version ?? "unknown"}`)
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
    pricing_version: pricing?.pricing_version ?? null,
    pricing_status: pricingKnown ? "known" : "unknown",
    run_count: 1,
    token_total: input + output + cache,
    cost_total: costTotal,
    duration_seconds_total: Math.ceil(Math.max(0, capture.endedAt - capture.startedAt) / 1000),
  };
}

function decimal(value: string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
