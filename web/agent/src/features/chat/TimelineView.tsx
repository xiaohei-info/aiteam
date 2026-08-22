/** Conversation view backed by persisted Pi entries and the live Pi SSE stream. */
import { useEffect, useState, type ReactNode } from "react";
import type { PiEntry, PiEvent } from "@aiteam/shared/contracts";
import { Card } from "@astryxdesign/core/Card";
import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
} from "@astryxdesign/core/Chat";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import type { AgentApiClient } from "../../lib/api-client";
import { getEntries, subscribePiEvents } from "./useChatApi";

const MAX_TYPE_LENGTH = 80;
const MAX_STATUS_LENGTH = 80;
const MAX_TOOL_NAME_LENGTH = 100;
const MAX_SUMMARY_LENGTH = 2_000;
const MAX_UNKNOWN_JSON_LENGTH = 1_200;
const MAX_OBJECT_KEYS = 16;
const MAX_ARRAY_ITEMS = 12;
const MAX_JSON_DEPTH = 3;

const SENSITIVE_KEY = /(?:authorization|token|api.?key|credential|secret|password|session.?file|workspace|cwd|path|filename|file.?path|private.?key|(?:^|[_-])key$)/i;
const INLINE_SECRET = /(?:bearer\s+|basic\s+|(?:sk|pk|rk)-)[a-z0-9._~+/=-]+|(?:token|secret|password|api[ _-]?key)\s*[:=]\s*[^\s,;]+/gi;
const INLINE_PATH = /(?:\/(?:Users|private|home|tmp|var|workspace|etc|root)(?:\/[^\s"'<>]*)*|[A-Za-z]:\\[^\s"'<>]*)/gi;

type TimelineKind =
  | "message"
  | "thinking"
  | "tool-call"
  | "tool-result"
  | "approval"
  | "error"
  | "settled"
  | "aborted"
  | "compaction"
  | "waiting"
  | "streaming"
  | "unknown";

export interface TimelineCardModel {
  kind: TimelineKind;
  label: string;
  type: string;
  status: string;
  summary: string;
  sender: "user" | "assistant";
}

export interface TimelineEventItem {
  id: string;
  event: PiEvent;
}

export type TimelineItem =
  | { kind: "entry"; entry: PiEntry }
  | { kind: "event"; item: TimelineEventItem };

export interface TimelineViewProps {
  client: AgentApiClient;
  conversationId: string;
  refreshSignal?: number;
}

export function TimelineView({ client, conversationId, refreshSignal = 0 }: TimelineViewProps) {
  const [entries, setEntries] = useState<PiEntry[]>([]);
  const [events, setEvents] = useState<TimelineEventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setEntries([]);
    setEvents([]);
    setLoading(true);
    setLoadError(null);
    setStreamError(null);

    const subscription = subscribePiEvents(
      client,
      conversationId,
      (next) => {
        if (!alive) return;
        setEvents((current) => upsertEvent(current, next));
        setStreamError(null);
      },
      (cause) => {
        if (alive) setStreamError(errorMessage(cause, "事件流连接失败"));
      },
    );

    void getEntries(client, conversationId)
      .then((next) => {
        if (!alive) return;
        setEntries(uniqueEntries(Array.isArray(next) ? next : []));
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setLoadError(errorMessage(cause, "加载会话失败"));
        setLoading(false);
      });

    return () => {
      alive = false;
      subscription.close();
    };
  }, [client, conversationId]);

  useEffect(() => {
    if (refreshSignal === 0) return;
    let alive = true;
    void getEntries(client, conversationId)
      .then((next) => {
        if (!alive) return;
        setEntries(uniqueEntries(Array.isArray(next) ? next : []));
        setLoadError(null);
      })
      .catch((cause: unknown) => {
        if (alive) setLoadError(errorMessage(cause, "加载会话失败"));
      });
    return () => {
      alive = false;
    };
  }, [client, conversationId, refreshSignal]);

  const timeline = mergeTimeline(entries, events);
  const hasContent = timeline.length > 0;
  const visibleError = loadError ?? streamError;

  return (
    <ChatMessageList
      ref={(node) => node?.setAttribute("aria-label", "对话事件流")}
      aria-label="对话事件流"
      data-testid="conversation-events"
      emptyState={<EmptyState title={loading ? "加载中…" : visibleError ?? "暂无事件"} isCompact />}
    >
      {loading && !hasContent ? <span data-timeline-status="loading" role="status">加载中…</span> : null}
      {!loading && !hasContent && !visibleError ? <span data-timeline-status="empty" role="status">暂无事件</span> : null}
      {loadError && hasContent ? <span data-timeline-status="error" role="alert">{loadError}</span> : null}
      {streamError ? (
        <span data-timeline-status="offline" role={hasContent ? "status" : "alert"} aria-live="polite">
          实时事件流离线：{streamError}
        </span>
      ) : null}
      {timeline.map((item, index) => {
        const model = item.kind === "entry" ? classifyPiRecord(item.entry) : classifyPiRecord(item.item.event);
        const itemKey = item.kind === "entry" ? `entry-${item.entry.id}` : `event-${item.item.id || `${model.type}-${index}`}`;
        return (
          <ChatMessage key={itemKey} sender={model.sender} name={model.label}>
            <ChatMessageBubble metadata={item.kind === "event" ? "实时" : "已记录"} variant="ghost">
              <TimelineCard model={model} />
            </ChatMessageBubble>
          </ChatMessage>
        );
      })}
      {!loading && !hasContent && loadError && !streamError ? <span role="alert">{loadError}</span> : null}
    </ChatMessageList>
  );
}

function TimelineCard({ model }: { model: TimelineCardModel }): ReactNode {
  return (
    <Card
      data-timeline-event-card="true"
      data-kind={model.kind}
      padding={3}
      role={model.kind === "error" ? "alert" : "article"}
      aria-label={`${model.label}事件`}
    >
      <div data-timeline-card-header="true">
        <strong data-timeline-card-label="true">{model.label}</strong>
        <span data-timeline-card-meta="true">类型：<code>{model.type}</code></span>
        <span data-timeline-card-meta="true">状态：<code>{model.status}</code></span>
      </div>
      <p data-timeline-card-summary="true">{model.summary}</p>
      {model.kind === "unknown" ? <p data-timeline-card-note="true">仅显示受限摘要</p> : null}
    </Card>
  );
}

/** Classifies an open Pi record without relying on runtime-specific fields. */
export function classifyPiRecord(record: PiEntry | PiEvent): TimelineCardModel {
  const value = asRecord(record);
  const rawType = typeof value?.type === "string" ? value.type : "unknown";
  const type = boundedText(rawType, MAX_TYPE_LENGTH) || "unknown";
  const normalizedType = normalizeType(rawType);
  const kind = classifyKind(normalizedType, value);
  const status = statusFor(kind, normalizedType, value);
  return {
    kind,
    label: kindLabel(kind),
    type,
    status,
    summary: summaryFor(kind, normalizedType, value),
    sender: kind === "message" && (normalizedType === "user" || messageRole(value) === "user") ? "user" : "assistant",
  };
}

/** Merges the durable snapshot before live events and removes identity duplicates. */
export function mergeTimeline(entries: PiEntry[], events: TimelineEventItem[]): TimelineItem[] {
  const result: TimelineItem[] = [];
  const durableIds = new Set<string>();
  const seenEntryIds = new Set<string>();

  for (const entry of entries) {
    const id = typeof entry?.id === "string" ? entry.id : "";
    const fallbackId = id || `${entry?.type ?? "unknown"}:${result.length}`;
    if (seenEntryIds.has(fallbackId)) continue;
    seenEntryIds.add(fallbackId);
    if (id) durableIds.add(id);
    const payloadId = payloadIdentity(entry);
    if (payloadId) durableIds.add(payloadId);
    result.push({ kind: "entry", entry });
  }

  const seenEventIds = new Set<string>();
  for (const item of events) {
    const eventId = typeof item?.id === "string" ? item.id : "";
    const identity = eventId || payloadIdentity(item?.event) || `${item?.event?.type ?? "unknown"}:${result.length}`;
    if (seenEventIds.has(identity)) continue;
    seenEventIds.add(identity);
    if (eventId && durableIds.has(eventId)) continue;
    const payloadId = payloadIdentity(item?.event);
    if (payloadId && durableIds.has(payloadId)) continue;
    result.push({ kind: "event", item });
  }

  return result;
}

function uniqueEntries(entries: PiEntry[]): PiEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry, index) => {
    const id = typeof entry?.id === "string" ? entry.id : `${entry?.type ?? "unknown"}:${index}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function upsertEvent(current: TimelineEventItem[], next: TimelineEventItem): TimelineEventItem[] {
  const id = typeof next?.id === "string" ? next.id : "";
  if (!id) return [...current, next];
  const index = current.findIndex((item) => item.id === id);
  if (index < 0) return [...current, next];
  const updated = current.slice();
  updated[index] = next;
  return updated;
}

function classifyKind(type: string, value: Record<string, unknown> | null): TimelineKind {
  if (isErrorType(type) || isAgentError(type, value)) return "error";
  if (isApprovalType(type)) return "approval";
  if (isCompactionType(type)) return "compaction";
  if (isToolResultType(type)) return "tool-result";
  if (isToolCallType(type)) return "tool-call";
  if (isThinkingType(type)) return "thinking";
  if (isAbortedType(type, value)) return "aborted";
  if (isSettledType(type)) return "settled";
  if (isWaitingType(type)) return "waiting";
  if (isStreamingType(type)) return "streaming";
  if (isMessageType(type)) return structuredMessageKind(value) ?? "message";
  return "unknown";
}

function isMessageType(type: string): boolean {
  return type === "message" || type === "assistant" || type === "user" || type.startsWith("message_") || type.endsWith("_message");
}

function isThinkingType(type: string): boolean {
  return type === "thinking" || type.startsWith("thinking_") || type.endsWith("_thinking") || type === "reasoning" || type.startsWith("reasoning_") || type.endsWith("_reasoning");
}

function isToolCallType(type: string): boolean {
  return type === "tool_call" || type.startsWith("tool_call_") || type === "tool_use" || type.startsWith("tool_use_") || type === "tool_execution_start";
}

function isToolResultType(type: string): boolean {
  return type === "tool_result" || type.startsWith("tool_result_") || type === "tool_execution_update" || type === "tool_execution_end" || type === "tool_execution_result" || type.endsWith("_tool_result");
}

function isApprovalType(type: string): boolean {
  return type === "approval" || type.startsWith("approval_") || type === "permission_request" || type === "permission_required" || type === "awaiting_approval";
}

function isErrorType(type: string): boolean {
  return type === "error" || type.startsWith("error_") || type.endsWith("_error") || type === "failed" || type.endsWith("_failed");
}

function isAgentError(type: string, value: Record<string, unknown> | null): boolean {
  if (type !== "agent_end") return false;
  const state = lower(firstString(value, "status", "state", "reason"));
  return state.includes("error") || state.includes("fail");
}

function isCompactionType(type: string): boolean {
  return type === "compaction" || type.startsWith("compaction_") || type === "context_compaction" || type.startsWith("context_compaction_");
}

function isAbortedType(type: string, value: Record<string, unknown> | null): boolean {
  if (type === "aborted" || type.endsWith("_aborted") || type.startsWith("abort") || type === "cancelled" || type.endsWith("_cancelled") || type === "canceled" || type.endsWith("_canceled") || type.startsWith("cancel")) return true;
  if (type !== "agent_end") return false;
  const state = lower(firstString(value, "status", "state", "reason"));
  return state.includes("abort") || state.includes("cancel") || state.includes("interrupt");
}

function isSettledType(type: string): boolean {
  return type === "settled" || type.startsWith("settled_") || type.endsWith("_settled") || type === "agent_settled" || type === "agent_end" || type === "complete" || type === "completed" || type.endsWith("_completed") || type === "done";
}

function isWaitingType(type: string): boolean {
  return type === "waiting" || type.startsWith("waiting_") || type === "waiting_reply" || type === "awaiting_input" || type === "auto_retry_start" || type === "auto_retry_end";
}

function isStreamingType(type: string): boolean {
  return type === "streaming" || type.startsWith("streaming_") || type.endsWith("_streaming") || type === "stream" || type === "agent_start";
}

function structuredMessageKind(value: Record<string, unknown> | null): TimelineKind | null {
  const message = asRecord(value?.message);
  const role = lower(typeof message?.role === "string" ? message.role : typeof value?.role === "string" ? value.role : null);
  if (role === "toolresult" || role === "tool_result") return "tool-result";
  for (const candidate of [value?.assistantMessageEvent, message, ...(Array.isArray(message?.content) ? message.content : []), ...(Array.isArray(value?.content) ? value.content : [])]) {
    const type = normalizeType(typeof asRecord(candidate)?.type === "string" ? asRecord(candidate)?.type as string : "");
    if (type.includes("toolcall") || type.includes("tool_call") || type.includes("tooluse") || type.includes("tool_use")) return "tool-call";
    if (type.includes("toolresult") || type.includes("tool_result")) return "tool-result";
    if (type.includes("thinking") || type.includes("reasoning")) return "thinking";
  }
  return null;
}

function kindLabel(kind: TimelineKind): string {
  switch (kind) {
    case "message": return "消息";
    case "thinking": return "思考";
    case "tool-call": return "工具调用";
    case "tool-result": return "工具结果";
    case "approval": return "需要审批";
    case "error": return "错误";
    case "settled": return "已完成";
    case "aborted": return "已中止";
    case "compaction": return "上下文整理";
    case "waiting": return "等待中";
    case "streaming": return "执行中";
    case "unknown": return "未识别事件";
  }
}

function statusFor(kind: TimelineKind, type: string, value: Record<string, unknown> | null): string {
  const explicit = firstString(value, "status", "state", "phase");
  if (explicit) return boundedText(explicit, MAX_STATUS_LENGTH);
  if (typeof value?.approved === "boolean") return value.approved ? "approved" : "pending";
  if (typeof value?.success === "boolean") return value.success ? "success" : "failed";
  if (kind === "tool-call") return type.endsWith("_start") ? "running" : "pending";
  if (kind === "tool-result") return type.endsWith("_update") ? "running" : "completed";
  if (kind === "approval") return "pending";
  if (kind === "error") return "error";
  if (kind === "settled") return "settled";
  if (kind === "aborted") return "aborted";
  if (kind === "compaction") return type.endsWith("_start") ? "running" : "completed";
  if (kind === "waiting") return "waiting";
  if (kind === "streaming") return "streaming";
  if (kind === "message") return type === "message_update" || type === "message_start" ? "streaming" : "recorded";
  return "received";
}

function summaryFor(kind: TimelineKind, type: string, value: Record<string, unknown> | null): string {
  switch (kind) {
    case "message": {
      const content = textFrom(value?.message) ?? textFrom(value?.content) ?? textFrom(value?.text) ?? textFrom(value?.delta) ?? textFrom(value?.assistantMessageEvent);
      return boundedText(content ?? (type === "message_update" ? "消息正在生成" : "消息"), MAX_SUMMARY_LENGTH);
    }
    case "thinking":
      return boundedText(textFrom(value?.thinking) ?? textFrom(value?.reasoning) ?? textFrom(value?.content) ?? textFrom(value?.delta) ?? textFrom(value?.assistantMessageEvent) ?? "正在思考", MAX_SUMMARY_LENGTH);
    case "tool-call":
      return toolSummary(value, "工具调用");
    case "tool-result":
      return toolSummary(value, "工具结果");
    case "approval":
      return toolSummary(value, "等待批准");
    case "error":
      return boundedText(textFrom(value?.message) ?? textFrom(value?.error) ?? textFrom(value?.detail) ?? "执行失败", MAX_SUMMARY_LENGTH);
    case "settled":
      return boundedText(textFrom(value?.summary) ?? textFrom(value?.message) ?? "执行已完成", MAX_SUMMARY_LENGTH);
    case "aborted":
      return boundedText(textFrom(value?.summary) ?? textFrom(value?.reason) ?? "执行已中止", MAX_SUMMARY_LENGTH);
    case "compaction":
      return boundedText(textFrom(value?.summary) ?? (type.endsWith("_start") ? "正在整理上下文" : "上下文整理已完成"), MAX_SUMMARY_LENGTH);
    case "waiting":
      return boundedText(textFrom(value?.message) ?? textFrom(value?.reason) ?? "等待继续", MAX_SUMMARY_LENGTH);
    case "streaming":
      return boundedText(textFrom(value?.message) ?? textFrom(value?.text) ?? "正在执行", MAX_SUMMARY_LENGTH);
    case "unknown":
      return boundedJson(value ?? {});
  }
}

function toolSummary(value: Record<string, unknown> | null, prefix: string): string {
  const name = toolName(value);
  return name ? `${prefix}：${boundedText(name, MAX_TOOL_NAME_LENGTH)}` : prefix;
}

function toolName(value: Record<string, unknown> | null, depth = 0): string | null {
  if (!value || depth > 2) return null;
  for (const key of ["toolName", "tool_name", "name"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return safeDisplayText(candidate, MAX_TOOL_NAME_LENGTH);
  }
  for (const key of ["tool", "toolCall", "tool_call", "toolRequest", "tool_request", "message"]) {
    const nested = asRecord(value[key]);
    const candidate = toolName(nested, depth + 1);
    if (candidate) return candidate;
  }
  if (Array.isArray(value.content)) {
    for (const part of value.content) {
      const candidate = toolName(asRecord(part), depth + 1);
      if (candidate) return candidate;
    }
  }
  return null;
}

function messageRole(value: Record<string, unknown> | null): "user" | "assistant" {
  const message = asRecord(value?.message);
  const role = typeof message?.role === "string" ? message.role : typeof value?.role === "string" ? value.role : "";
  return role.toLowerCase() === "user" ? "user" : "assistant";
}

function payloadIdentity(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.entry_id === "string" && record.entry_id) return record.entry_id;
  if (typeof record.entryId === "string" && record.entryId) return record.entryId;
  const message = asRecord(record.message);
  if (typeof message?.id === "string" && message.id) return message.id;
  return null;
}

function normalizeType(type: string): string {
  return type.trim().toLowerCase().replace(/[.\-\s]+/g, "_");
}

function firstString(value: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!value) return null;
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key] as string;
  }
  return null;
}

function textFrom(value: unknown): string | null {
  if (typeof value === "string") return safeDisplayText(value, MAX_SUMMARY_LENGTH);
  if (Array.isArray(value)) {
    const text = value.map((part) => textFrom(part)).filter((part): part is string => Boolean(part)).join("");
    return text || null;
  }
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.text === "string") return safeDisplayText(record.text, MAX_SUMMARY_LENGTH);
  if (typeof record.delta === "string") return safeDisplayText(record.delta, MAX_SUMMARY_LENGTH);
  if (typeof record.thinking === "string" || Array.isArray(record.thinking)) return textFrom(record.thinking);
  if (typeof record.reasoning === "string" || Array.isArray(record.reasoning)) return textFrom(record.reasoning);
  if (typeof record.content === "string" || Array.isArray(record.content)) return textFrom(record.content);
  if (typeof record.message === "string" || Array.isArray(record.message)) return textFrom(record.message);
  return null;
}

function safeDisplayText(value: string, maxLength: number): string {
  return boundedText(value.replace(INLINE_SECRET, "[已隐藏]").replace(INLINE_PATH, "[路径已隐藏]"), maxLength);
}

function boundedText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

/** Bounded, key-aware fallback for events outside the known rendering vocabulary. */
export function boundedJson(value: unknown): string {
  try {
    const clean = sanitizeValue(value, 0, new WeakSet<object>());
    const serialized = JSON.stringify(clean);
    if (!serialized) return "{}";
    return boundedText(serialized, MAX_UNKNOWN_JSON_LENGTH);
  } catch {
    return "[事件摘要不可用]";
  }
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return typeof value === "string" ? safeDisplayText(value, MAX_SUMMARY_LENGTH) : value;
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return "[已省略]";
  if (depth >= MAX_JSON_DEPTH) return "[已省略]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1, seen));
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      if (SENSITIVE_KEY.test(key)) continue;
      const clean = sanitizeValue(child, depth + 1, seen);
      if (clean !== undefined) result[key] = clean;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function lower(value: string | null): string {
  return value?.toLowerCase() ?? "";
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
