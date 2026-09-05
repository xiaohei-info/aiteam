import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { WorkOutcome } from "../storage/work-records.js";

/** Pi terminal evidence, not Promise resolution or a product execution state machine. */
export function observedWorkOutcome(stopReason: string | undefined, settled: boolean, aborted = false, failed = false): Exclude<WorkOutcome, "active"> {
  if (aborted || stopReason === "aborted") return "aborted";
  if (failed || stopReason === "error") return "error";
  if (settled && (stopReason === "stop" || stopReason === "length")) return "succeeded";
  return "unknown";
}

export function lastAssistantStopReason(entries: readonly SessionEntry[]): string | undefined {
  const entry = [...entries].reverse().find((item) => item.type === "message" && item.message.role === "assistant");
  return (entry as unknown as { message?: { stopReason?: string } } | undefined)?.message?.stopReason;
}

/** Do not replace missing legacy timestamps with a fabricated date. */
export function workEntryTime(entry: SessionEntry | undefined): number | null {
  const value = (entry as { timestamp?: unknown } | undefined)?.timestamp;
  if (typeof value === "number" && Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime())) return value;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return Date.parse(value);
}

/** Keep each participant's fan-out input: one historical segment per actual employee Session. */
export function historicalWorkSegments(entries: readonly SessionEntry[]) {
  const starts: number[] = [];
  for (const [ordinal, entry] of entries.entries()) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "user" || (!starts.length && entry.message.role === "assistant")) starts.push(ordinal);
  }
  return starts.map((start, index) => ({ start, end: starts[index + 1] ?? entries.length }));
}
