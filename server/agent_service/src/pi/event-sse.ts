import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const ALLOWED_EVENTS = new Set([
  "agent_start", "agent_end", "agent_settled", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
  "auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end",
  "approval_required",
]);
const SECRET_KEY = /(?:authorization|access.?token|refresh.?token|api.?key|credential|secret|password|session.?file|workspace|cwd|path|filename|file.?path)/i;

/** Pi v0.84.2 event boundary: allowlisted event kind, no local paths or credentials. */
export function serializePiEvent(event: AgentSessionEvent, extra: { conversation_id?: string; source_ref?: string; tool_call_id?: string } = {}): Record<string, unknown> | undefined {
  const value = redact(event as unknown);
  if (!value || typeof value !== "object" || typeof (value as Record<string, unknown>).type !== "string") return undefined;
  if (!ALLOWED_EVENTS.has((value as Record<string, unknown>).type as string)) return undefined;
  return { ...(value as Record<string, unknown>), ...extra };
}

function redact(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return undefined;
  if (Array.isArray(value)) return value.map((item) => redact(item)).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return typeof value === "string" && SECRET_KEY.test(value) ? "[REDACTED]" : value;
  const result: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const clean = redact(childValue, childKey);
    if (clean !== undefined) result[childKey] = clean;
  }
  return result;
}
