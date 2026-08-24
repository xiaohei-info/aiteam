import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const ALLOWED_EVENTS = new Set([
  "agent_start", "agent_end", "agent_settled", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
  "auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end",
  "approval_required",
]);
const TOOL_EVENTS = new Set(["tool_execution_start", "tool_execution_update", "tool_execution_end"]);
const ASSISTANT_EVENTS = new Set([
  "start", "text_start", "text_delta", "text_end", "thinking_start", "thinking_delta", "thinking_end",
  "toolcall_start", "toolcall_delta", "toolcall_end", "done", "error",
]);
const SECRET_KEY = /(?:authorization|access.?token|refresh.?token|token|api.?key|credential|secret|password|session.?file|workspace|cwd|path|filename|file.?path|private.?key)/i;
const INLINE_SECRET = /(?:bearer\s+|basic\s+|(?:sk|pk|rk)-)[a-z0-9._~+/=-]+|(?:token|secret|password|api[ _-]?key)\s*[:=]\s*[^\s,;]+/gi;
const INLINE_PATH = /(?:\/(?:Users|private|home|tmp|var|workspace|etc|root)(?:\/[^\s"'<>]*)*|[A-Za-z]:\\[^\s"'<>]*)/gi;
const UNSAFE_VALUE_KEY = /^(?:api|provider|model|raw|headers|request|diagnostics|session)$/i;

const MAX_EVENT_BYTES = 24 * 1024;
const MAX_TEXT_CHARS = 4_000;
const MAX_TOOL_NAME_CHARS = 128;
const MAX_IDENTIFIER_CHARS = 256;
const MAX_SOURCE_NAME_CHARS = 256;
const MAX_OBJECT_KEYS = 24;
const MAX_ARRAY_ITEMS = 32;
const MAX_JSON_DEPTH = 4;

type ToolKind = "memory" | "rag" | "todo";

export interface PiEventMetadata {
  conversation_id?: string;
  source_ref?: string;
  tool_call_id?: string;
  source_employee_id?: string;
  source_employee_display_name?: string;
  source_role?: "child" | "coordinator";
}

/** Classify only the Agent-owned tools that have a dedicated UI contract. */
export function classifyToolKind(toolName: unknown): ToolKind | undefined {
  if (typeof toolName !== "string") return undefined;
  if (toolName === "todo_update") return "todo";
  if (toolName === "knowledge_search" || toolName === "knowledge_get") return "rag";
  if (toolName === "hindsight_recall" || toolName === "hindsight_retain" || toolName === "memory_recall" || toolName === "memory_retain") return "memory";
  return undefined;
}

/**
 * Pi event boundary: keep only UI-safe fields, classify the small set of
 * structured Agent tools, and never forward provider/runtime objects.
 */
export function serializePiEvent(event: AgentSessionEvent, extra: PiEventMetadata = {}): Record<string, unknown> | undefined {
  const raw = asRecord(event);
  if (!raw || typeof raw.type !== "string" || !ALLOWED_EVENTS.has(raw.type)) return undefined;

  const result: Record<string, unknown> = { type: raw.type, ...serializeMetadata(extra) };
  if (TOOL_EVENTS.has(raw.type)) serializeToolEvent(result, raw);
  else if (raw.type === "message_update") {
    const message = serializeMessage(raw.message);
    const assistantMessageEvent = serializeAssistantMessageEvent(raw.assistantMessageEvent);
    if (message) result.message = message;
    if (assistantMessageEvent) result.assistantMessageEvent = assistantMessageEvent;
  } else if (raw.type === "message_end") {
    const message = serializeMessage(raw.message);
    if (message) result.message = message;
  } else if (raw.type === "agent_end") {
    if (Array.isArray(raw.messages)) result.message_count = Math.min(raw.messages.length, MAX_ARRAY_ITEMS);
  } else if (raw.type === "auto_retry_start") {
    copyInteger(result, raw, "attempt");
    copyInteger(result, raw, "maxAttempts");
    copyInteger(result, raw, "delayMs");
    copyText(result, raw, "errorMessage");
  } else if (raw.type === "auto_retry_end") {
    copyBoolean(result, raw, "success");
    copyInteger(result, raw, "attempt");
    copyText(result, raw, "finalError");
  } else if (raw.type === "compaction_start") {
    copyReason(result, raw);
  } else if (raw.type === "compaction_end") {
    copyReason(result, raw);
    copyBoolean(result, raw, "aborted");
    copyBoolean(result, raw, "willRetry");
    copyText(result, raw, "errorMessage");
  } else if (raw.type === "approval_required") {
    copyIdentifier(result, raw, "toolCallId");
    copyToolName(result, raw);
    const kind = classifyToolKind(raw.toolName);
    if (kind) {
      result.tool_kind = kind;
      if (Object.prototype.hasOwnProperty.call(raw, "args")) result.args = safeToolValue(raw.args, kind);
    }
  }
  return boundEvent(result);
}

function serializeToolEvent(result: Record<string, unknown>, raw: Record<string, unknown>): void {
  copyIdentifier(result, raw, "toolCallId");
  copyToolName(result, raw);
  const kind = classifyToolKind(raw.toolName);
  if (kind) result.tool_kind = kind;
  // Ordinary coding/custom tools still get bounded summaries. The serializer
  // strips credentials, paths, runtime objects, and oversized payloads below.
  if (raw.type !== "tool_execution_end" && Object.prototype.hasOwnProperty.call(raw, "args")) result.args = safeToolValue(raw.args, kind);
  if (raw.type === "tool_execution_update" && Object.prototype.hasOwnProperty.call(raw, "partialResult")) result.partialResult = safeToolResult(raw.partialResult, kind);
  if (raw.type === "tool_execution_end") {
    if (Object.prototype.hasOwnProperty.call(raw, "result")) result.result = safeToolResult(raw.result, kind);
    copyBoolean(result, raw, "isError");
  }
}

function serializeMessage(value: unknown): Record<string, unknown> | undefined {
  const raw = asRecord(value);
  if (!raw || (raw.role !== "user" && raw.role !== "assistant" && raw.role !== "toolResult")) return undefined;
  const result: Record<string, unknown> = { role: raw.role };
  const content = serializeContent(raw.content);
  if (content !== undefined) result.content = content;
  if (raw.role === "toolResult") {
    copyIdentifier(result, raw, "toolCallId");
    copyToolName(result, raw);
    copyBoolean(result, raw, "isError");
    const kind = classifyToolKind(raw.toolName);
    if (kind) {
      result.tool_kind = kind;
      if (content !== undefined) result.result = safeToolResult({ content }, kind);
    }
  }
  return result;
}

function serializeContent(value: unknown): unknown {
  if (typeof value === "string") return safeText(value, MAX_TEXT_CHARS);
  if (!Array.isArray(value)) return undefined;
  const output: unknown[] = [];
  for (const part of value.slice(0, MAX_ARRAY_ITEMS)) {
    const raw = asRecord(part);
    if (!raw || typeof raw.type !== "string") continue;
    if (raw.type === "text" && typeof raw.text === "string") output.push({ type: "text", text: safeText(raw.text, MAX_TEXT_CHARS) });
    else if (raw.type === "thinking" && typeof raw.thinking === "string") output.push({ type: "thinking", thinking: safeText(raw.thinking, MAX_TEXT_CHARS) });
    else if (raw.type === "toolCall") {
      const toolCall = serializeToolCall(raw);
      if (toolCall) output.push(toolCall);
    } else if (raw.type === "image") {
      // Image bytes are local content, not UI metadata.
      output.push({ type: "image" });
    }
  }
  return output;
}

function serializeToolCall(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const id = boundedIdentifier(value.id, MAX_IDENTIFIER_CHARS);
  const name = boundedIdentifier(value.name, MAX_TOOL_NAME_CHARS);
  if (!id && !name) return undefined;
  const result: Record<string, unknown> = {};
  if (id) result.id = id;
  if (name) result.name = name;
  const kind = classifyToolKind(value.name);
  if (kind && Object.prototype.hasOwnProperty.call(value, "arguments")) result.arguments = safeToolValue(value.arguments, kind);
  return result;
}

function serializeAssistantMessageEvent(value: unknown): Record<string, unknown> | undefined {
  const raw = asRecord(value);
  if (!raw || typeof raw.type !== "string" || !ASSISTANT_EVENTS.has(raw.type)) return undefined;
  const result: Record<string, unknown> = { type: raw.type };
  if (typeof raw.contentIndex === "number" && Number.isInteger(raw.contentIndex) && raw.contentIndex >= 0 && raw.contentIndex < 1_000) result.contentIndex = raw.contentIndex;
  if (typeof raw.delta === "string") result.delta = safeText(raw.delta, MAX_TEXT_CHARS);
  if (typeof raw.content === "string") result.content = safeText(raw.content, MAX_TEXT_CHARS);
  if (typeof raw.reason === "string" && ["stop", "length", "toolUse", "deferred", "aborted", "error"].includes(raw.reason)) result.reason = raw.reason;
  const toolCall = serializeToolCall(asRecord(raw.toolCall) ?? {});
  if (toolCall) result.toolCall = toolCall;
  return result;
}

function safeToolResult(value: unknown, kind?: ToolKind): unknown {
  const payload = unwrapToolResult(value);
  return safeToolValue(payload, kind);
}

function safeToolValue(value: unknown, _kind?: ToolKind): unknown {
  return boundedValue(value);
}

function unwrapToolResult(value: unknown): unknown {
  const raw = asRecord(value);
  if (!raw) return value;
  const content = raw.content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => asRecord(part))
      .filter((part): part is Record<string, unknown> => part !== undefined && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
    if (text) {
      const bounded = safeText(text, MAX_TEXT_CHARS);
      try { return JSON.parse(bounded); } catch { return { text: bounded }; }
    }
  }
  if (raw.details !== undefined) return raw.details;
  return value;
}

function boundedValue(value: unknown, key = "", depth = 0, seen = new WeakSet<object>()): unknown {
  if (SECRET_KEY.test(key) || UNSAFE_VALUE_KEY.test(key)) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return safeText(value, MAX_TEXT_CHARS);
  if (typeof value !== "object") return undefined;
  if (depth >= MAX_JSON_DEPTH || seen.has(value)) return "[内容已省略]";
  if (Array.isArray(value)) {
    seen.add(value);
    try { return value.slice(0, MAX_ARRAY_ITEMS).map((item) => boundedValue(item, "", depth + 1, seen)).filter((item) => item !== undefined); }
    finally { seen.delete(value); }
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return "[对象已省略]";
  } catch { return "[对象已省略]"; }
  seen.add(value);
  try {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      const clean = boundedValue(childValue, childKey, depth + 1, seen);
      if (clean !== undefined) output[childKey] = clean;
    }
    return output;
  } finally { seen.delete(value); }
}

function serializeMetadata(extra: PiEventMetadata): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ["conversation_id", "source_ref", "tool_call_id", "source_employee_id", "source_employee_display_name"] as const) {
    const value = extra[key];
    const clean = key === "source_employee_display_name" ? boundedIdentifier(value, MAX_SOURCE_NAME_CHARS) : boundedIdentifier(value, MAX_IDENTIFIER_CHARS);
    if (clean) result[key] = clean;
  }
  if (extra.source_role === "child" || extra.source_role === "coordinator") result.source_role = extra.source_role;
  return result;
}

function copyToolName(result: Record<string, unknown>, raw: Record<string, unknown>): void {
  const value = boundedIdentifier(raw.toolName, MAX_TOOL_NAME_CHARS);
  if (value) result.toolName = value;
}

function copyIdentifier(result: Record<string, unknown>, raw: Record<string, unknown>, key: string): void {
  const value = boundedIdentifier(raw[key], MAX_IDENTIFIER_CHARS);
  if (value) result[key] = value;
}

function copyText(result: Record<string, unknown>, raw: Record<string, unknown>, key: string): void {
  if (typeof raw[key] === "string") result[key] = safeText(raw[key] as string, MAX_TEXT_CHARS);
}

function copyInteger(result: Record<string, unknown>, raw: Record<string, unknown>, key: string): void {
  if (typeof raw[key] === "number" && Number.isInteger(raw[key]) && raw[key] >= 0) result[key] = raw[key];
}

function copyBoolean(result: Record<string, unknown>, raw: Record<string, unknown>, key: string): void {
  if (typeof raw[key] === "boolean") result[key] = raw[key];
}

function copyReason(result: Record<string, unknown>, raw: Record<string, unknown>): void {
  if (raw.reason === "manual" || raw.reason === "threshold" || raw.reason === "overflow") result.reason = raw.reason;
}

function boundedIdentifier(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return safeText(value, max);
}

function safeText(value: string, max: number): string {
  const redacted = value.replace(INLINE_SECRET, "[内容已隐藏]").replace(INLINE_PATH, "[路径已隐藏]");
  return redacted.length <= max ? redacted : `${redacted.slice(0, Math.max(0, max - 1))}…`;
}

function boundEvent(value: Record<string, unknown>): Record<string, unknown> {
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return minimalEvent(value); }
  if (Buffer.byteLength(serialized, "utf8") <= MAX_EVENT_BYTES) return value;
  return minimalEvent(value);
}

function minimalEvent(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { type: value.type };
  for (const key of ["conversation_id", "source_ref", "tool_call_id", "source_employee_id", "source_employee_display_name", "source_role", "tool_kind", "toolName", "toolCallId", "isError"] as const) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
