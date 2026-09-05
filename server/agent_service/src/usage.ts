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
  const measured = measureWorkUsage(capture.entries, pricing);
  const pricingKnown = measured?.pricing_status === "known";
  const cost = measured?.cost_total === null || !measured ? 0 : Number(measured.cost_total);
  const cache = cacheRead + cacheWrite;
  const costTotal = cost;
  const summaryId = createHash("sha256")
    .update(`${capture.tenantId}:${capture.memberId}:${capture.employeeId}:${windowStart}:${pricing?.pricing_version ?? "unknown"}${pricingKnown ? "" : ":unknown"}`)
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

export interface WorkUsage {
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  token_total: number;
  cost_total: string | null;
  currency: "USD";
  pricing_status: "known" | "unknown";
  pricing_version: number | null;
}

/** Explicit Pi counters only. Missing/partial counters and initialization failures are not zero usage. */
export function measureWorkUsage(entries: readonly SessionEntry[], pricing?: RuntimePricingSnapshot | null): WorkUsage | null {
  const assistants = entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
  if (!assistants.length) return null;
  const totals = [0, 0, 0, 0];
  for (const entry of assistants) {
    const usage = (entry as unknown as { message: { usage?: Record<string, unknown> } }).message.usage;
    for (const [index, field] of ["input", "output", "cacheRead", "cacheWrite"].entries()) {
      const value = usage?.[field];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
      totals[index]! += value;
      if (!Number.isSafeInteger(totals[index])) return null;
    }
  }
  const [input, output, cacheRead, cacheWrite] = totals as [number, number, number, number];
  const rates = pricing?.billing_mode === "request" ? [pricing.request_usd] :
    [pricing?.input_usd_per_million, pricing?.output_usd_per_million, pricing?.cache_read_usd_per_million, pricing?.cache_write_usd_per_million];
  const known = pricing?.pricing_status === "known" && pricing.currency === "USD" && ["request", "token"].includes(pricing.billing_mode) &&
    rates.every((rate) => typeof rate === "string" && /^\d+(\.\d{1,6})?$/.test(rate) && Number.isFinite(Number(rate)));
  // Platform rate precision is six decimals; token pricing therefore needs twelve USD decimals.
  const units = known ? rates.map((rate) => {
    const [whole, fraction = ""] = rate!.split(".");
    return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  }) : [];
  const cost = !known ? null : pricing!.billing_mode === "request" ? units[0]! * 1_000_000n :
    totals.reduce((sum, value, index) => sum + BigInt(value) * units[index]!, 0n);
  return {
    input_tokens: input, output_tokens: output, cache_tokens: cacheRead + cacheWrite,
    token_total: input + output + cacheRead + cacheWrite, cost_total: cost === null ? null : usdDecimal(cost),
    currency: "USD", pricing_status: known ? "known" : "unknown", pricing_version: pricing?.pricing_version ?? null,
  };
}

export function usdDecimal(units: bigint): string {
  return `${units / 1_000_000_000_000n}.${(units % 1_000_000_000_000n).toString().padStart(12, "0")}`;
}

/** Existing numeric summaries retain their recorded precision; new decimal aggregates stay exact. */
export function usdUnits(value: unknown): bigint | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value >= 1e21) return undefined;
    value = value.toFixed(12);
  }
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,12})?$/.test(value)) return undefined;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, "0"));
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
