/** Conversation view backed by persisted Pi entries and the live Pi SSE stream. */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DigitalEmployeeAvatar, type PiEntry, type PiEvent } from "@aiteam/shared";
import { Card } from "@astryxdesign/core/Card";
import { Markdown } from "@astryxdesign/core/Markdown";
import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
} from "@astryxdesign/core/Chat";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import type { AgentApiClient } from "../../lib/api-client";
import { getConversationRuntimeState, getEntries, subscribePiEvents } from "./useChatApi";

const MAX_TYPE_LENGTH = 80;
const MAX_STATUS_LENGTH = 80;
const MAX_TOOL_NAME_LENGTH = 100;
const MAX_SUMMARY_LENGTH = 2_000;
const MAX_DETAIL_LENGTH = 1_200;
const MAX_PREVIEW_LENGTH = 360;
const MAX_TODO_TEXT_LENGTH = 240;
const MAX_TODO_ITEMS = 12;
const MAX_CITATIONS = 6;
const MAX_UNKNOWN_JSON_LENGTH = 1_200;
const MAX_OBJECT_KEYS = 16;
const MAX_ARRAY_ITEMS = 12;
const MAX_JSON_DEPTH = 3;
const MAX_RESULT_PARSE_LENGTH = 12_000;
const NON_CONVERSATION_ENTRY_TYPES = new Set(["model_change", "thinking_level_change", "session_info", "label"]);

const SENSITIVE_KEY = /(?:authorization|token|api.?key|credential|secret|password|session.?file|workspace|cwd|path|filename|file.?path|private.?key|(?:^|[_-])key$)/i;
const INLINE_SECRET = /(?:bearer\s+|basic\s+|(?:sk|pk|rk)-)[a-z0-9._~+/=-]+|(?:token|secret|password|api[ _-]?key)\s*[:=]\s*[^\s,;]+/gi;
const INLINE_PATH = /(?:file:\/\/)?\/(?:Users|private|home|tmp|var|workspace|etc|root|opt|srv|usr)(?:\/[^\s"'<>]*)*|[A-Za-z]:\\[^\s"'<>]*/gi;

export type TimelineKind =
  | "message"
  | "thinking"
  | "tool-call"
  | "tool-result"
  | "todo"
  | "memory"
  | "rag"
  | "approval"
  | "error"
  | "settled"
  | "aborted"
  | "compaction"
  | "waiting"
  | "streaming"
  | "unknown";

export type TimelineTodoStatus = "waiting" | "in_progress" | "completed";

export interface TimelineTodoItem {
  id?: string;
  text: string;
  status: TimelineTodoStatus;
}

export interface TimelineCitation {
  citationId?: string;
  title?: string;
  preview?: string;
  score?: string;
}

export interface TimelineSource {
  employeeId?: string;
  displayName: string;
  role?: string;
}

export interface TimelineCardModel {
  kind: TimelineKind;
  label: string;
  type: string;
  status: string;
  summary: string;
  sender: "user" | "assistant";
  toolName?: string;
  toolCallId?: string;
  argsSummary?: string;
  resultSummary?: string;
  todoItems?: TimelineTodoItem[];
  memoryOperation?: "recall" | "retain";
  memoryQuery?: string;
  memoryPreview?: string;
  ragOperation?: "search" | "get";
  ragQuery?: string;
  ragCitationId?: string;
  ragCitations?: TimelineCitation[];
  ragResultPreview?: string;
  source?: TimelineSource;
  /** Stable text used by the card and group-chat accessibility tree. */
  sourceLabel?: string;
  /** Convenience fields for callers that need the source without unpacking source. */
  sourceEmployeeId?: string;
  sourceEmployeeName?: string;
}

export interface TimelineEventItem {
  id: string;
  event: PiEvent;
}

export type TimelineItem =
  | { kind: "entry"; entry: PiEntry }
  | { kind: "event"; item: TimelineEventItem };

export interface TimelineExpertSource {
  employee_id: string;
  display_name: string;
  avatar_url?: string | null;
}

export interface TimelineViewProps {
  client: AgentApiClient;
  conversationId: string;
  refreshSignal?: number;
  onPromptingChange?: (prompting: boolean) => void;
  /** Current local employee projections used to decorate source messages. */
  sourceExperts?: TimelineExpertSource[];
}

export function TimelineView({ client, conversationId, refreshSignal = 0, onPromptingChange, sourceExperts = [] }: TimelineViewProps) {
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
        const type = normalizeType(firstString(asRecord(next.event), "type") ?? "");
        if (type === "agent_start") onPromptingChange?.(true);
        else if (type === "agent_end" || type === "agent_settled") onPromptingChange?.(false);
        setEvents((current) => upsertEvent(current, next));
        setStreamError(null);
      },
      (cause) => {
        if (alive) setStreamError(errorMessage(cause, "事件流连接失败"));
      },
    );

    void getConversationRuntimeState(client, conversationId)
      .then((state) => { if (alive) onPromptingChange?.(Boolean(state?.prompting)); })
      .catch(() => undefined);

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
  }, [client, conversationId, onPromptingChange]);

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

  const expertById = useMemo(
    () => new Map(sourceExperts.map((expert) => [expert.employee_id, expert])),
    [sourceExperts],
  );
  const timeline = mergeTimeline(entries, events);
  const visibleTimeline = mergeVisibleTimeline(timeline.flatMap((item, index) => {
    const record = item.kind === "entry" ? item.entry : item.item.event;
    if (NON_CONVERSATION_ENTRY_TYPES.has(normalizeType(record.type))) return [];
    const models = classifyPiRecords(record)
      .filter((model) => model.kind !== "streaming" && model.kind !== "settled");
    const itemKey = item.kind === "entry" ? `entry-${item.entry.id}` : `event-${item.item.id || index}`;
    return models.map((model, modelIndex) => ({ model, key: `${itemKey}-${modelIndex}` }));
  }));
  const hasContent = visibleTimeline.length > 0;
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
      {visibleTimeline.map(({ model, key }) => {
        const source = model.sender === "assistant"
          ? resolveMessageSource(model, expertById)
          : { name: "我", avatarUrl: undefined };
        return (
        <ChatMessage key={key} sender={model.sender} avatar={<EmployeeChatAvatar name={source.name} avatarUrl={source.avatarUrl} sender={model.sender} />} name={<span data-chat-message-name="true">{source.name}</span>}>
          <ChatMessageBubble variant={model.kind === "message" ? "filled" : "ghost"}>
            {model.kind === "message"
              ? model.sender === "assistant"
                ? <div data-timeline-message="true"><Markdown>{model.summary}</Markdown></div>
                : <p data-timeline-message="true">{model.summary}</p>
              : <TimelineCard model={model} />}
          </ChatMessageBubble>
        </ChatMessage>
        );
      })}
      {!loading && !hasContent && loadError && !streamError ? <span role="alert">{loadError}</span> : null}
    </ChatMessageList>
  );
}

type ResolvedMessageSource = {
  name: string;
  avatarUrl?: string;
};

function resolveMessageSource(model: TimelineCardModel, experts: Map<string, TimelineExpertSource>): ResolvedMessageSource {
  const employeeId = model.sourceEmployeeId ?? model.source?.employeeId;
  const expert = employeeId ? experts.get(employeeId) : undefined;
  const explicitName = model.sourceEmployeeName ?? model.source?.displayName;
  const name = expert?.display_name?.trim()
    || (explicitName && explicitName !== employeeId ? explicitName : "数字员工");
  const candidate = expert?.avatar_url?.trim();
  return {
    name,
    ...(candidate?.startsWith("/") && !candidate.startsWith("//") ? { avatarUrl: candidate } : {}),
  };
}

function EmployeeChatAvatar({ name, avatarUrl, sender }: ResolvedMessageSource & { sender: "user" | "assistant" }): ReactNode {
  return (
    <span data-chat-avatar="true" aria-hidden="true">
      <DigitalEmployeeAvatar
        name={name}
        src={avatarUrl}
        size={42}
        variant={sender === "user" ? "human" : "employee"}
      />
    </span>
  );
}

function TimelineCard({ model }: { model: TimelineCardModel }): ReactNode {
  const updating = ["streaming", "running", "pending", "waiting"].includes(model.status);
  return (
    <Card
      data-timeline-event-card="true"
      data-kind={model.kind}
      data-status={model.status}
      padding={0}
      role={model.kind === "error" ? "alert" : "article"}
      aria-label={`${model.label}事件`}
    >
      <details key={updating ? "updating" : "completed"} data-timeline-disclosure="true" open={updating || undefined}>
        <summary data-timeline-card-header="true">
          <strong data-timeline-card-label="true">{model.label}</strong>
          {toolOutcome(model) === "success" ? <span data-timeline-tool-outcome="success" aria-label="执行成功">✓</span> : null}
          {toolOutcome(model) === "failure" ? <span data-timeline-tool-outcome="failure" aria-label="执行失败">×</span> : null}
        </summary>
        <div data-timeline-card-content="true">
          {model.sourceLabel ? <p data-timeline-card-source="true">{model.sourceLabel}</p> : null}
          <p data-timeline-card-summary="true">{model.summary}</p>
          {model.argsSummary ? <BoundedDetail label="参数摘要" value={model.argsSummary} testId="timeline-tool-args" /> : null}
          {model.resultSummary ? <BoundedDetail label="结果摘要" value={model.resultSummary} testId="timeline-tool-result" /> : null}
          {model.kind === "todo" && model.todoItems?.length ? (
            <section data-timeline-todos="true" aria-label="待办列表">
              <div data-timeline-todo-heading="true">
                <strong>待办列表</strong>
                <span data-timeline-todo-count="true">{model.todoItems.length} 项</span>
              </div>
              <ul data-timeline-todo-list="true">
                {model.todoItems.map((todo, index) => (
                  <li key={todo.id || `${todo.text}-${index}`} data-timeline-todo-item="true" data-status={todo.status}>
                    <span data-timeline-todo-indicator="true" aria-hidden="true">{todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "…" : "○"}</span>
                    <span data-timeline-todo-text="true">{todo.text}</span>
                    <span data-timeline-todo-status="true">{todoStatusLabel(todo.status)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {model.kind === "memory" ? (
            <section data-timeline-memory="true" aria-label="记忆召回摘要">
              {model.memoryQuery ? <BoundedDetail label="查询/内容摘要" value={model.memoryQuery} /> : null}
              {model.memoryPreview ? <BoundedDetail label="结果预览" value={model.memoryPreview} /> : null}
            </section>
          ) : null}
          {model.kind === "rag" ? (
            <section data-timeline-rag="true" aria-label="知识库摘要">
              {model.ragQuery ? <BoundedDetail label="查询摘要" value={model.ragQuery} /> : null}
              {model.ragCitationId ? <BoundedDetail label="引用标识" value={model.ragCitationId} /> : null}
              {model.ragResultPreview ? <BoundedDetail label="结果预览" value={model.ragResultPreview} /> : null}
              {model.ragCitations?.length ? (
                <div data-timeline-citations="true">
                  <strong>引用摘要</strong>
                  <ul>
                    {model.ragCitations.map((citation, index) => (
                      <li key={citation.citationId || `${citation.title || "citation"}-${index}`}>
                        {citation.title ? <span>{citation.title}</span> : null}
                        {citation.citationId ? <code>{citation.citationId}</code> : null}
                        {citation.preview ? <span>{citation.preview}</span> : null}
                        {citation.score ? <small>相关度：{citation.score}</small> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          ) : null}
          {model.kind === "unknown" ? <p data-timeline-card-note="true">仅显示受限摘要</p> : null}
        </div>
      </details>
    </Card>
  );
}

type VisibleTimelineItem = { model: TimelineCardModel; key: string };
type ToolOutcome = "success" | "failure" | "pending";

function mergeVisibleTimeline(items: VisibleTimelineItem[]): VisibleTimelineItem[] {
  const result: VisibleTimelineItem[] = [];
  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  for (const item of items) {
    const model = item.model;
    const identity = toolIdentity(model);
    if (!identity || (model.kind !== "tool-call" && model.kind !== "tool-result")) {
      result.push({ ...item, model });
      continue;
    }
    if (model.kind === "tool-call") {
      const resultIndex = results.get(identity);
      if (resultIndex !== undefined) {
        result[resultIndex] = { ...item, model: mergeToolModels(model, result[resultIndex]!.model) };
        results.delete(identity);
      } else {
        calls.set(identity, result.length);
        result.push({ ...item, model });
      }
      continue;
    }
    const callIndex = calls.get(identity);
    if (callIndex !== undefined) {
      result[callIndex] = { ...result[callIndex]!, model: mergeToolModels(result[callIndex]!.model, model) };
      calls.delete(identity);
    } else {
      results.set(identity, result.length);
      result.push({ ...item, model });
    }
  }
  return result;
}

function mergeToolModels(call: TimelineCardModel, result: TimelineCardModel): TimelineCardModel {
  return {
    ...call,
    kind: "tool-call",
    label: result.label || call.label,
    status: result.status,
    toolName: call.toolName ?? result.toolName,
    toolCallId: call.toolCallId ?? result.toolCallId,
    argsSummary: call.argsSummary ?? result.argsSummary,
    resultSummary: result.resultSummary ?? call.resultSummary,
  };
}

function toolIdentity(model: TimelineCardModel): string | undefined {
  if (!model.toolCallId) return undefined;
  const source = model.sourceEmployeeId ?? model.source?.employeeId ?? "";
  return `${source}:${model.toolCallId}`;
}

function toolOutcome(model: TimelineCardModel): ToolOutcome | null {
  if (model.kind !== "tool-call" && model.kind !== "tool-result") return null;
  const status = normalizeType(model.status);
  if (["completed", "success", "succeeded", "settled", "done", "ok"].includes(status)) return "success";
  if (["failed", "failure", "error", "aborted", "cancelled", "canceled", "rejected"].includes(status)) return "failure";
  return "pending";
}

function todoStatusLabel(status: TimelineTodoStatus): string {
  if (status === "completed") return "已完成";
  if (status === "in_progress") return "进行中";
  return "等待中";
}

function BoundedDetail({ label, value, testId }: { label: string; value: string; testId?: string }): ReactNode {
  return (
    <div data-timeline-detail="true" data-testid={testId}>
      <strong>{label}</strong>
      <pre>{value}</pre>
    </div>
  );
}

/** Classifies an open Pi record without relying on runtime-specific fields. */
export function classifyPiRecord(record: PiEntry | PiEvent): TimelineCardModel {
  const value = asRecord(record);
  const rawType = typeof value?.type === "string" ? value.type : "unknown";
  const type = safeDisplayText(rawType, MAX_TYPE_LENGTH) || "unknown";
  const normalizedType = normalizeType(rawType);
  const kind = classifyKind(normalizedType, value);
  const details = cardDetails(kind, normalizedType, value);
  const status = statusFor(kind, normalizedType, value);
  return {
    kind,
    label: activityLabel(kind, details.toolName),
    type,
    status,
    summary: summaryFor(kind, normalizedType, value, details),
    sender: kind === "message" && messageRole(value) === "user" && !isEmployeeSourcedMessage(value) ? "user" : "assistant",
    ...details,
  };
}

/** Split assistant content into ordered thinking, tool, and answer cards. */
export function classifyPiRecords(record: PiEntry | PiEvent): TimelineCardModel[] {
  const value = asRecord(record);
  const message = asRecord(value?.message);
  if (!value || !message || lower(firstString(message, "role")) !== "assistant" || !Array.isArray(message.content)) return [classifyPiRecord(record)];

  const parts = message.content;
  const recordType = normalizeType(firstString(value, "type") ?? "");
  const update = asRecord(value.assistantMessageEvent);
  const updateType = normalizeType(firstString(update, "type") ?? "");
  if (recordType === "message_update" && updateType) {
    const contentIndex = typeof update?.contentIndex === "number" && Number.isInteger(update.contentIndex)
      ? update.contentIndex
      : -1;
    const indexedPart = contentIndex >= 0 ? asRecord(parts[contentIndex]) : undefined;
    const candidates = indexedPart ? [indexedPart] : parts.map(asRecord).filter((part): part is Record<string, unknown> => part !== undefined);
    if (updateType.startsWith("thinking_") || updateType.startsWith("reasoning_")) {
      const thinkingParts = candidates.filter((part) => normalizeType(firstString(part, "type") ?? "") === "thinking");
      const thinkingText = thinkingTextFrom(thinkingParts.length ? thinkingParts : update);
      return thinkingText ? [classifyPiRecord({ ...value, type: "thinking", status: updateType.endsWith("_end") ? "completed" : "streaming", thinking: thinkingText } as PiEvent)] : [classifyPiRecord(record)];
    }
    if (updateType.startsWith("text_") && candidates.some((part) => normalizeType(firstString(part, "type") ?? "") === "text")) {
      const text = candidates.filter((part) => normalizeType(firstString(part, "type") ?? "") === "text");
      return [classifyPiRecord({ ...value, type: "message", message: { ...message, content: text } } as PiEvent)];
    }
    if (updateType.startsWith("toolcall_") || updateType.startsWith("tool_call_")) {
      const tools = candidates.filter((part) => {
        const type = normalizeType(firstString(part, "type") ?? "");
        return type === "toolcall" || type === "tool_call" || type === "tooluse" || type === "tool_use";
      });
      if (tools.length) return tools.map((part) => {
        const callId = firstString(part, "id", "toolCallId", "tool_call_id", "callId", "call_id");
        return classifyPiRecord({ ...value, ...part, ...(callId ? { toolCallId: callId } : {}), type: "tool_call", message: undefined } as PiEvent);
      });
    }
  }

  const models: TimelineCardModel[] = [];
  let textParts: Record<string, unknown>[] = [];
  const flushText = () => {
    if (!textParts.length) return;
    models.push(classifyPiRecord({ ...value, type: "message", message: { ...message, content: textParts } } as PiEvent));
    textParts = [];
  };
  for (const rawPart of parts) {
    const part = asRecord(rawPart);
    if (!part) continue;
    const type = normalizeType(firstString(part, "type") ?? "");
    if (type === "text") {
      textParts.push(part);
      continue;
    }
    flushText();
    if (type === "thinking") {
      const thinking = thinkingTextFrom(part);
      if (thinking) models.push(classifyPiRecord({ ...value, type: "thinking", thinking } as PiEvent));
    } else if (type === "toolcall" || type === "tool_call" || type === "tooluse" || type === "tool_use") {
      const callId = firstString(part, "id", "toolCallId", "tool_call_id", "callId", "call_id");
      models.push(classifyPiRecord({ ...value, ...part, ...(callId ? { toolCallId: callId } : {}), type: "tool_call", message: undefined } as PiEvent));
    }
  }
  flushText();
  return models.length ? models : [classifyPiRecord(record)];
}

/** Merges the durable snapshot before live events and removes identity duplicates. */
export function mergeTimeline(entries: PiEntry[], events: TimelineEventItem[]): TimelineItem[] {
  const result: TimelineItem[] = [];
  const durableIds = new Set<string>();
  const durableMessages = new Set<string>();
  const durableMessageIdentities = new Set<string>();
  const seenEntryIds = new Set<string>();

  for (const entry of entries) {
    const id = typeof entry?.id === "string" ? entry.id : "";
    const fallbackId = id || `${entry?.type ?? "unknown"}:${result.length}`;
    if (seenEntryIds.has(fallbackId)) continue;
    seenEntryIds.add(fallbackId);
    if (id) durableIds.add(id);
    const payloadId = payloadIdentity(entry);
    if (payloadId) durableIds.add(payloadId);
    const signature = messageSignature(entry);
    if (signature) durableMessages.add(signature);
    const messageIdentity = messageActivityIdentity(entry);
    if (messageIdentity) durableMessageIdentities.add(messageIdentity);
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
    const messageIdentity = messageActivityIdentity(item?.event);
    if (messageIdentity && durableMessageIdentities.has(messageIdentity)) continue;
    const signature = messageSignature(item?.event);
    if (signature && durableMessages.has(signature)) continue;
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

export function upsertEvent(current: TimelineEventItem[], next: TimelineEventItem): TimelineEventItem[] {
  const nextEvent = asRecord(next.event);
  const nextType = normalizeType(firstString(nextEvent, "type") ?? "");
  const nextScope = eventScope(next);
  if (nextType === "agent_end" || nextType === "agent_settled") {
    for (let index = current.length - 1; index >= 0; index -= 1) {
      const currentType = normalizeType(firstString(asRecord(current[index]?.event), "type") ?? "");
      if (!isAgentLifecycleType(currentType) || eventScope(current[index]!) !== nextScope) continue;
      const updated = current.slice();
      updated[index] = { ...next, id: current[index]!.id };
      return updated;
    }
  }
  const boundary = lastRunBoundary(current, nextScope);
  if (normalizeType(firstString(nextEvent, "type") ?? "") === "message_end" && messageRole(nextEvent) === "assistant") {
    current = current.filter((item, index) => index <= boundary || eventScope(item) !== nextScope || normalizeType(firstString(asRecord(item.event), "type") ?? "") !== "message_update");
  }

  const streamKey = streamingEventKey(next);
  if (streamKey) {
    for (let index = current.length - 1; index > boundary; index -= 1) {
      if (streamingEventKey(current[index]!) !== streamKey) continue;
      const updated = current.slice();
      updated[index] = mergeStreamingEvent(current[index]!, next);
      return updated;
    }
  }

  const id = typeof next?.id === "string" ? next.id : "";
  if (!id) return [...current, next];
  const index = current.findIndex((item) => item.id === id);
  if (index < 0) return [...current, next];
  const updated = current.slice();
  updated[index] = next;
  return updated;
}

function isAgentLifecycleType(type: string): boolean {
  return type === "agent_start" || type === "agent_end" || type === "agent_settled";
}

function lastRunBoundary(events: TimelineEventItem[], scope = ""): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (eventScope(events[index]!) !== scope) continue;
    if (normalizeType(firstString(asRecord(events[index]?.event), "type") ?? "") === "agent_start") return index;
  }
  return -1;
}

function eventScope(item: TimelineEventItem): string {
  const event = asRecord(item.event);
  return firstString(event, "source_employee_id", "sourceEmployeeId", "source_ref", "sourceRef") ?? "";
}

function streamingEventKey(item: TimelineEventItem): string | null {
  const event = asRecord(item.event);
  const scope = eventScope(item);
  const type = normalizeType(firstString(event, "type") ?? "");
  if (type.startsWith("tool_execution_")) {
    const callId = firstString(event, "toolCallId", "tool_call_id");
    return callId ? `${scope}:tool:${callId}` : null;
  }
  if (type !== "message_update") return null;
  const update = asRecord(event?.assistantMessageEvent);
  const updateType = normalizeType(firstString(update, "type") ?? "");
  const phase = updateType.startsWith("thinking_") || updateType.startsWith("reasoning_") ? "thinking"
    : updateType.startsWith("text_") ? "text"
      : updateType.startsWith("toolcall_") || updateType.startsWith("tool_call_") ? "tool"
        : null;
  if (!phase) return null;
  const contentIndex = typeof update?.contentIndex === "number" ? update.contentIndex : -1;
  return `${scope}:message:${phase}:${contentIndex}`;
}

function mergeStreamingEvent(previous: TimelineEventItem, next: TimelineEventItem): TimelineEventItem {
  const previousEvent = asRecord(previous.event) ?? {};
  const nextEvent = asRecord(next.event) ?? {};
  const previousUpdate = asRecord(previousEvent.assistantMessageEvent);
  const nextUpdate = asRecord(nextEvent.assistantMessageEvent);
  if (nextEvent.message === undefined && previousUpdate && nextUpdate && typeof previousUpdate.delta === "string" && typeof nextUpdate.delta === "string") {
    const updateType = normalizeType(firstString(nextUpdate, "type") ?? "");
    const isThinkingUpdate = updateType.startsWith("thinking_") || updateType.startsWith("reasoning_");
    const delta = isThinkingUpdate ? previousUpdate.delta + nextUpdate.delta : boundedText(previousUpdate.delta + nextUpdate.delta, MAX_SUMMARY_LENGTH);
    return { ...next, id: previous.id, event: { ...nextEvent, assistantMessageEvent: { ...nextUpdate, delta } } as unknown as PiEvent };
  }
  if (nextEvent.args === undefined && previousEvent.args !== undefined) {
    return { ...next, id: previous.id, event: { ...nextEvent, args: previousEvent.args } as unknown as PiEvent };
  }
  return { ...next, id: previous.id };
}

function classifyKind(type: string, value: Record<string, unknown> | null): TimelineKind {
  if (isErrorType(type) || isAgentError(type, value)) return "error";
  if (isApprovalType(type)) return "approval";
  if (isCompactionType(type)) return "compaction";

  const candidateName = canonicalToolName(toolName(value) ?? toolNameFromType(type));
  const specialized = specializedKind(type, candidateName);
  if (specialized) return specialized;
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
  return type === "tool_call" || type.startsWith("tool_call_") && !isToolResultType(type) || type === "tool_use" || type.startsWith("tool_use_") && !isToolResultType(type) || type === "tool_execution_start" || type === "tool_execution_started";
}

function isToolResultType(type: string): boolean {
  return type === "tool_result" || type.startsWith("tool_result_") || type === "tool_execution_update" || type === "tool_execution_end" || type === "tool_execution_ended" || type === "tool_execution_result" || type === "tool_call_completed" || type === "tool_use_completed" || type.endsWith("_tool_result");
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
  const embeddedName = canonicalToolName(toolName(value));
  const special = specializedKind("message", embeddedName);
  if (special) return special;
  const role = lower(typeof message?.role === "string" ? message.role : typeof value?.role === "string" ? value.role : null);
  if (role === "toolresult" || role === "tool_result") return "tool-result";
  const candidates = [
    value?.assistantMessageEvent,
    message,
    ...(Array.isArray(message?.content) ? message.content.slice(0, MAX_ARRAY_ITEMS) : []),
    ...(Array.isArray(value?.content) ? value.content.slice(0, MAX_ARRAY_ITEMS) : []),
  ];
  for (const candidate of candidates) {
    const candidateRecord = asRecord(candidate);
    const candidateType = normalizeType(typeof candidateRecord?.type === "string" ? candidateRecord.type : "");
    const candidateName = canonicalToolName(toolName(candidateRecord) ?? toolNameFromType(candidateType));
    const candidateSpecial = specializedKind(candidateType, candidateName);
    if (candidateSpecial) return candidateSpecial;
    if (candidateType.includes("toolcall") || candidateType.includes("tool_call") || candidateType.includes("tooluse") || candidateType.includes("tool_use")) return "tool-call";
    if (candidateType.includes("toolresult") || candidateType.includes("tool_result")) return "tool-result";
    if (candidateType.includes("thinking") || candidateType.includes("reasoning")) return "thinking";
  }
  return null;
}

function kindLabel(kind: TimelineKind): string {
  switch (kind) {
    case "message": return "消息";
    case "thinking": return "思考";
    case "tool-call": return "工具调用";
    case "tool-result": return "工具调用";
    case "todo": return "待办更新";
    case "memory": return "记忆召回";
    case "rag": return "知识库";
    case "approval": return "工具调用";
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
  const message = asRecord(value?.message);
  const explicit = firstString(value, "status", "state", "phase") ?? firstString(message, "status", "state", "phase");
  if (explicit) return safeDisplayText(explicit, MAX_STATUS_LENGTH);
  if (typeof value?.approved === "boolean") return value.approved ? "approved" : "pending";
  if (typeof message?.approved === "boolean") return message.approved ? "approved" : "pending";
  if (value?.error !== undefined || value?.failed === true || message?.error !== undefined || message?.failed === true) return "failed";
  if (typeof value?.success === "boolean") return value.success ? "success" : "failed";
  if (typeof message?.success === "boolean") return message.success ? "success" : "failed";
  if (kind === "thinking") return "completed";
  if (kind === "tool-call") return type.endsWith("_start") || type.endsWith("_started") ? "running" : "pending";
  if (kind === "tool-result") return type.endsWith("_update") ? "running" : "completed";
  if (kind === "todo" || kind === "memory" || kind === "rag") {
    if (looksLikeToolResult(type, value)) return type.endsWith("_update") ? "running" : "completed";
    return "pending";
  }
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

interface ExtractedCardDetails {
  toolName?: string;
  toolCallId?: string;
  argsSummary?: string;
  resultSummary?: string;
  todoItems?: TimelineTodoItem[];
  memoryOperation?: "recall" | "retain";
  memoryQuery?: string;
  memoryPreview?: string;
  ragOperation?: "search" | "get";
  ragQuery?: string;
  ragCitationId?: string;
  ragCitations?: TimelineCitation[];
  ragResultPreview?: string;
  source?: TimelineSource;
  sourceLabel?: string;
  sourceEmployeeId?: string;
  sourceEmployeeName?: string;
}

function cardDetails(kind: TimelineKind, type: string, value: Record<string, unknown> | null): ExtractedCardDetails {
  const details: ExtractedCardDetails = {};
  const source = sourceMetadata(value);
  if (source) {
    details.source = source;
    details.sourceEmployeeId = source.employeeId;
    details.sourceEmployeeName = source.displayName;
    details.sourceLabel = `来源专家：${source.displayName}${source.role ? `（${source.role}）` : ""}`;
  }

  if (!value || !isToolLikeKind(kind)) return details;

  const rawToolName = toolName(value) ?? toolNameFromType(type);
  const candidateName = canonicalToolName(rawToolName);
  const callId = toolCallId(value) ?? ((isToolCallType(type) || isToolResultType(type)) ? firstString(value, "id") : null);
  if (rawToolName) details.toolName = safeDisplayText(rawToolName, MAX_TOOL_NAME_LENGTH);
  if (callId) details.toolCallId = safeDisplayText(callId, MAX_TOOL_NAME_LENGTH);
  const extractedArgs = extractToolArguments(value);
  const args = extractedArgs ?? ((kind === "memory" || kind === "rag") ? value : undefined);
  const result = extractToolResult(value);
  if (args !== undefined && ((kind === "tool-call" && !looksLikeToolResult(type, value)) || kind === "tool-result" || kind === "approval")) details.argsSummary = boundedDetail(args);
  if (kind === "tool-result" && result !== undefined && (looksLikeToolResult(type, value) || args === undefined)) details.resultSummary = boundedDetail(result);

  if (kind === "todo") {
    const todos = extractTodoItems(args) ?? extractTodoItems(value) ?? extractTodoItems(result);
    if (todos?.length) details.todoItems = todos;
  } else if (kind === "memory") {
    details.memoryOperation = memoryOperation(candidateName ?? toolNameFromType(type));
    const argsRecord = asRecord(args);
    const query = firstString(argsRecord, "query", "text", "content", "observation", "memory");
    if (query) details.memoryQuery = safeDisplayText(query, MAX_PREVIEW_LENGTH);
    const preview = previewFromResult(result);
    if (preview) details.memoryPreview = preview;
  } else if (kind === "rag") {
    details.ragOperation = ragOperation(candidateName ?? toolNameFromType(type));
    const argsRecord = asRecord(args);
    const query = firstString(argsRecord, "query", "q");
    if (query) details.ragQuery = safeDisplayText(query, MAX_PREVIEW_LENGTH);
    const citationId = firstString(argsRecord, "citation_id", "citationId", "citation");
    if (citationId) details.ragCitationId = safeDisplayText(citationId, MAX_PREVIEW_LENGTH);
    const rag = ragDetails(result, value, details.ragOperation);
    if (rag.citationId && !details.ragCitationId) details.ragCitationId = rag.citationId;
    if (rag.citations.length) details.ragCitations = rag.citations;
    if (rag.preview) details.ragResultPreview = rag.preview;
  }
  return details;
}

function summaryFor(kind: TimelineKind, type: string, value: Record<string, unknown> | null, details: ExtractedCardDetails): string {
  switch (kind) {
    case "message": {
      const content = textFrom(value?.message) ?? textFrom(value?.content) ?? textFrom(value?.text) ?? textFrom(value?.delta) ?? textFrom(value?.assistantMessageEvent);
      return boundedText(content ?? (type === "message_update" ? "消息正在生成" : "消息"), MAX_SUMMARY_LENGTH);
    }
    case "thinking":
      return thinkingTextFrom(value?.thinking) ?? thinkingTextFrom(value?.reasoning) ?? thinkingTextFrom(value?.content) ?? thinkingTextFrom(value?.message) ?? thinkingTextFrom(value?.delta) ?? thinkingTextFrom(value?.assistantMessageEvent) ?? "正在思考";
    case "tool-call":
      return activityLabel(kind, details.toolName);
    case "tool-result":
      return activityLabel(kind, details.toolName);
    case "todo":
      return details.todoItems?.length ? `待办更新：${details.todoItems.length} 项` : "待办更新";
    case "memory": {
      const label = "记忆召回";
      return boundedText(details.memoryQuery ? `${label}：${details.memoryQuery}` : label, MAX_SUMMARY_LENGTH);
    }
    case "rag": {
      const label = "知识库";
      const subject = details.ragQuery ?? details.ragCitationId;
      return boundedText(subject ? `${label}：${subject}` : label, MAX_SUMMARY_LENGTH);
    }
    case "approval":
      return "工具调用";
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

const COMMAND_TOOL_NAMES = new Set(["bash", "shell", "exec", "execute", "run_command", "run_shell", "command"]);

function activityLabel(kind: TimelineKind, toolName?: string): string {
  if (kind === "todo") return "待办更新";
  if (kind === "memory") return "记忆召回";
  if (kind === "rag") return "知识库";
  if (kind === "tool-call" || kind === "tool-result" || kind === "approval") {
    const name = canonicalToolName(toolName);
    if (name === "todo_update") return "待办更新";
    if (name === "knowledge_search" || name === "knowledge_get") return "知识库";
    if (name === "hindsight_recall" || name === "hindsight_retain" || name === "memory_recall" || name === "memory_retain") return "记忆召回";
    if (name === "mention_employee" || name === "delegate_employee") return "成员协作";
    if (name && COMMAND_TOOL_NAMES.has(name)) return "命令执行";
    return "工具调用";
  }
  return kindLabel(kind);
}

function isToolLikeKind(kind: TimelineKind): boolean {
  return kind === "tool-call" || kind === "tool-result" || kind === "todo" || kind === "memory" || kind === "rag" || kind === "approval";
}

function specializedKind(type: string, candidateName: string | null): TimelineKind | null {
  const names = [candidateName, canonicalToolName(toolNameFromType(type))].filter((name): name is string => Boolean(name));
  for (const name of names) {
    if (name === "todo_update") return "todo";
    if (name === "hindsight_recall" || name === "hindsight_retain" || name === "memory_recall" || name === "memory_retain") return "memory";
    if (name === "knowledge_search" || name === "knowledge_get") return "rag";
  }
  return null;
}

function memoryOperation(name: string | null | undefined): "recall" | "retain" {
  return normalizeType(name ?? "").endsWith("retain") ? "retain" : "recall";
}

function ragOperation(name: string | null | undefined): "search" | "get" {
  return normalizeType(name ?? "").endsWith("get") ? "get" : "search";
}

function toolNameFromType(type: string): string | null {
  const match = normalizeType(type).match(/(?:todo_update|hindsight_(?:recall|retain)|memory_(?:recall|retain)|knowledge_(?:search|get)|mention_employee|delegate_employee|run_command|run_shell|command|bash|shell|exec|execute)/);
  return match?.[0] ?? null;
}

function canonicalToolName(name: string | null | undefined): string | null {
  if (!name) return null;
  const normalized = normalizeType(name);
  return normalized || null;
}

function toolCallId(value: Record<string, unknown> | null, depth = 0): string | null {
  if (!value || depth > 3) return null;
  for (const key of ["toolCallId", "tool_call_id", "callId", "call_id"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return safeDisplayText(candidate, MAX_TOOL_NAME_LENGTH);
  }
  for (const key of ["tool", "toolCall", "tool_call", "toolRequest", "tool_request", "toolResult", "tool_result", "message"]) {
    const nested = asRecord(value[key]);
    const candidate = toolCallId(nested, depth + 1);
    if (candidate) return candidate;
  }
  if (Array.isArray(value.content)) {
    for (const part of value.content.slice(0, MAX_ARRAY_ITEMS)) {
      const candidatePart = asRecord(part);
      const partType = normalizeType(firstString(candidatePart, "type") ?? "");
      if (!partType.includes("tool")) continue;
      const candidate = firstString(candidatePart, "id", "toolCallId", "tool_call_id", "callId", "call_id");
      if (candidate) return safeDisplayText(candidate, MAX_TOOL_NAME_LENGTH);
    }
  }
  return null;
}

function toolName(value: Record<string, unknown> | null, depth = 0): string | null {
  if (!value || depth > 3) return null;
  for (const key of ["toolName", "tool_name", "name"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return safeDisplayText(candidate, MAX_TOOL_NAME_LENGTH);
  }
  for (const key of ["tool", "toolCall", "tool_call", "toolRequest", "tool_request", "toolResult", "tool_result", "message"]) {
    const nested = asRecord(value[key]);
    const candidate = toolName(nested, depth + 1);
    if (candidate) return candidate;
  }
  if (Array.isArray(value.content)) {
    for (const part of value.content.slice(0, MAX_ARRAY_ITEMS)) {
      const candidate = toolName(asRecord(part), depth + 1);
      if (candidate) return candidate;
    }
  }
  return null;
}

function extractToolArguments(value: Record<string, unknown> | null, depth = 0): unknown {
  if (!value || depth > 3) return undefined;
  const direct = firstValue(value, ["args", "arguments", "input", "params", "parameters", "toolInput", "tool_input"]);
  if (direct !== undefined) return direct;
  for (const key of ["toolCall", "tool_call", "toolRequest", "tool_request", "message"]) {
    const nested = asRecord(value[key]);
    const result = extractToolArguments(nested, depth + 1);
    if (result !== undefined) return result;
  }
  if (Array.isArray(value.content)) {
    for (const part of value.content.slice(0, MAX_ARRAY_ITEMS)) {
      const partRecord = asRecord(part);
      const partType = normalizeType(typeof partRecord?.type === "string" ? partRecord.type : "");
      if (partType.includes("toolcall") || partType.includes("tool_call") || partType.includes("tooluse") || partType.includes("tool_use")) {
        const result = firstValue(partRecord, ["arguments", "args", "input", "params", "parameters"]);
        if (result !== undefined) return result;
      }
    }
  }
  return undefined;
}

function extractToolResult(value: Record<string, unknown> | null, depth = 0): unknown {
  if (!value || depth > 3) return undefined;
  const direct = firstValue(value, ["result", "output", "response", "toolResult", "tool_result", "details", "error"]);
  if (direct !== undefined) return direct;
  const message = asRecord(value.message);
  const role = lower(typeof message?.role === "string" ? message.role : typeof value.role === "string" ? value.role : null);
  if (role === "toolresult" || role === "tool_result") {
    return firstValue(message, ["content", "result", "output", "details"]) ?? firstValue(value, ["content"]);
  }
  if (Array.isArray(value.content) && (isToolResultType(normalizeType(String(value.type ?? ""))) || role === "toolresult" || role === "tool_result")) return value.content;
  for (const key of ["toolResult", "tool_result", "message"]) {
    const nested = asRecord(value[key]);
    const result = extractToolResult(nested, depth + 1);
    if (result !== undefined) return result;
  }
  return undefined;
}

function extractTodoItems(value: unknown): TimelineTodoItem[] | undefined {
  const parsed = structuredResult(value);
  if (parsed !== undefined && parsed !== value) {
    const nested = extractTodoItems(parsed);
    if (nested) return nested;
  }
  const record = asRecord(value);
  const candidates: unknown[][] = [];
  if (Array.isArray(value)) candidates.push(value);
  if (record) {
    for (const key of ["todos", "todo_items", "todoItems", "items", "tasks"]) {
      if (Array.isArray(record[key])) candidates.push(record[key]);
    }
  }
  for (const candidate of candidates) {
    const items = candidate.slice(0, MAX_TODO_ITEMS).map(todoItem).filter((item): item is TimelineTodoItem => Boolean(item));
    if (items.length) return items;
  }
  return undefined;
}

function todoItem(value: unknown): TimelineTodoItem | undefined {
  if (typeof value === "string") {
    const text = safeDisplayText(value, MAX_TODO_TEXT_LENGTH);
    return text ? { text, status: "waiting" } : undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const rawText = firstString(record, "text", "content", "title", "description", "label", "todo");
  const text = rawText ? safeDisplayText(rawText, MAX_TODO_TEXT_LENGTH) : "待办事项";
  const rawStatus = firstString(record, "status", "state", "phase");
  const status = typeof record.done === "boolean" ? (record.done ? "completed" : "waiting") : normalizeTodoStatus(rawStatus);
  const id = firstString(record, "id", "todo_id", "todoId");
  return { ...(id ? { id: safeDisplayText(id, 100) } : {}), text, status };
}

function normalizeTodoStatus(value: string | null): TimelineTodoStatus {
  const status = normalizeType(value ?? "");
  if (["completed", "complete", "done", "success", "succeeded", "finished"].includes(status)) return "completed";
  if (["in_progress", "inprogress", "running", "active", "doing"].includes(status)) return "in_progress";
  return "waiting";
}

function previewFromResult(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  const selected = record ? firstValue(record, ["preview", "summary", "text", "content", "result", "output", "memories", "items"]) : value;
  const text = textFrom(selected) ?? detailSummary(selected);
  return text ? boundedText(safeDisplayText(text, MAX_PREVIEW_LENGTH), MAX_PREVIEW_LENGTH) : undefined;
}

interface RagDetails {
  citationId?: string;
  citations: TimelineCitation[];
  preview?: string;
}

function ragDetails(result: unknown, event: Record<string, unknown> | null, operation: "search" | "get" | undefined): RagDetails {
  const parsed = structuredResult(result) ?? structuredResult(event);
  const parsedRecord = asRecord(parsed);
  const citationValues = findArrayByKeys(parsed, ["citations", "references", "results", "documents", "matches", "items", "sources"])
    ?? (parsedRecord?.citation ? [parsedRecord.citation] : undefined);
  const citations = (citationValues ?? []).slice(0, MAX_CITATIONS).map(citation).filter((item): item is TimelineCitation => Boolean(item));
  const citationId = firstString(parsedRecord, "citation_id", "citationId");
  const preview = ragPreview(parsed, citations, operation);
  return { ...(citationId ? { citationId: safeDisplayText(citationId, MAX_PREVIEW_LENGTH) } : {}), citations, ...(preview ? { preview } : {}) };
}

function citation(value: unknown): TimelineCitation | undefined {
  if (typeof value === "string") {
    const preview = safeDisplayText(value, MAX_PREVIEW_LENGTH);
    return preview ? { preview } : undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const citationId = firstString(record, "citation_id", "citationId", "id");
  const title = firstString(record, "title", "document_title", "source_title", "display_name", "name");
  const rawPreview = firstValue(record, ["snippet", "preview", "excerpt", "summary", "text", "content"]);
  const previewText = textFrom(rawPreview) ?? (typeof rawPreview === "string" ? rawPreview : undefined);
  const preview = previewText ? safeDisplayText(previewText, MAX_PREVIEW_LENGTH) : undefined;
  const score = typeof record.score === "number" && Number.isFinite(record.score) ? String(record.score) : undefined;
  if (!citationId && !title && !preview) return undefined;
  return {
    ...(citationId ? { citationId: safeDisplayText(citationId, MAX_PREVIEW_LENGTH) } : {}),
    ...(title ? { title: safeDisplayText(title, MAX_PREVIEW_LENGTH) } : {}),
    ...(preview ? { preview } : {}),
    ...(score ? { score } : {}),
  };
}

function ragPreview(value: unknown, citations: TimelineCitation[], operation: "search" | "get" | undefined): string | undefined {
  const record = asRecord(value);
  const selected = record ? firstValue(record, ["preview", "summary", "answer", "text", "excerpt", "snippet", "content"]) : value;
  const text = textFrom(selected) ?? (typeof selected === "string" ? selected : undefined);
  if (text) return safeDisplayText(text, MAX_PREVIEW_LENGTH);
  if (citations.length && operation === "search") return `已返回 ${citations.length} 条引用摘要`;
  return undefined;
}

function structuredResult(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 3 || value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    if (value.length > MAX_RESULT_PARSE_LENGTH) return undefined;
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return undefined;
    }
  }
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const part of value.slice(0, MAX_ARRAY_ITEMS)) {
        const record = asRecord(part);
        const parsedText = typeof record?.text === "string" ? structuredResult(record.text, depth + 1, seen) : undefined;
        if (parsedText !== undefined) return parsedText;
        if (record && (record.citations || record.results || record.documents || record.data)) return record;
      }
      return value;
    }
    const record = value as Record<string, unknown>;
    if (["citations", "references", "results", "documents", "matches", "items", "sources", "citation", "citation_id", "citationId"].some((key) => key in record)) return record;
    for (const key of ["data", "result", "output", "response", "details", "content", "citation"]) {
      const nested = structuredResult(record[key], depth + 1, seen);
      if (nested !== undefined) return nested;
    }
    return record;
  } finally {
    seen.delete(value);
  }
}

function findArrayByKeys(value: unknown, keys: string[], depth = 0, seen = new WeakSet<object>()): unknown[] | undefined {
  if (depth > MAX_JSON_DEPTH || !value || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    for (const key of keys) if (Array.isArray(record[key])) return record[key] as unknown[];
    for (const key of ["data", "result", "output", "response", "details", "content", "citation"]) {
      const nested = findArrayByKeys(record[key], keys, depth + 1, seen);
      if (nested) return nested;
    }
    return undefined;
  } finally {
    seen.delete(value);
  }
}

function sourceMetadata(value: Record<string, unknown> | null): TimelineSource | undefined {
  if (!value) return undefined;
  const directId = firstString(value, "source_employee_id", "sourceEmployeeId", "source_expert_id", "sourceExpertId", "source_id", "sourceId");
  const directName = firstString(value, "source_employee_name", "sourceEmployeeName", "source_employee_display_name", "sourceEmployeeDisplayName", "source_display_name", "sourceDisplayName", "source_name", "sourceName", "source_expert_name", "sourceExpertName");
  const sourceType = normalizeType(firstString(value, "source_type", "sourceType") ?? "");
  const marker = directId || directName || sourceType || firstValue(value, ["source", "source_ref", "sourceRef", "source_employee", "sourceEmployee", "source_expert", "sourceExpert", "child", "delegation"]) !== undefined;
  const directFallbackId = marker ? firstString(value, "employee_id", "employeeId") : null;
  const directFallbackName = marker ? firstString(value, "display_name", "displayName", "employee_name", "employeeName") : null;
  const candidates = [
    asRecord(value.source),
    asRecord(value.source_employee),
    asRecord(value.sourceEmployee),
    asRecord(value.source_expert),
    asRecord(value.sourceExpert),
    asRecord(value.child),
    asRecord(value.delegation),
    asRecord(value.metadata),
    asRecord(asRecord(value.metadata)?.source),
  ];
  let employeeId = directId ?? directFallbackId;
  let displayName = directName ?? directFallbackName;
  let role = firstString(value, "source_role", "sourceRole");
  for (const candidate of candidates) {
    if (!candidate) continue;
    employeeId ??= firstString(candidate, "employee_id", "employeeId", "source_employee_id", "sourceEmployeeId", "source_expert_id", "sourceExpertId", "id");
    displayName ??= firstString(candidate, "display_name", "displayName", "employee_name", "employeeName", "source_employee_name", "sourceEmployeeName", "source_employee_display_name", "sourceEmployeeDisplayName", "label", "name");
    role ??= firstString(candidate, "role", "source_role", "sourceRole", "source_type", "sourceType", "kind");
  }
  if (!employeeId && !displayName) return undefined;
  const safeId = employeeId ? safeDisplayText(employeeId, MAX_TOOL_NAME_LENGTH) : undefined;
  const safeName = safeDisplayText(displayName ?? "数字员工", MAX_TOOL_NAME_LENGTH);
  const safeRole = role ? safeSourceRole(role) : undefined;
  return { ...(safeId ? { employeeId: safeId } : {}), displayName: safeName, ...(safeRole ? { role: safeRole } : {}) };
}

function safeSourceRole(value: string): string {
  const normalized = normalizeType(value);
  if (normalized === "child" || normalized === "delegate" || normalized === "delegated") return "子专家";
  if (normalized === "coordinator") return "协调专家";
  return safeDisplayText(value, MAX_STATUS_LENGTH);
}

function messageRole(value: Record<string, unknown> | null): "user" | "assistant" {
  const message = asRecord(value?.message);
  const role = typeof message?.role === "string" ? message.role : typeof value?.role === "string" ? value.role : "";
  return role.toLowerCase() === "user" ? "user" : "assistant";
}

function isEmployeeSourcedMessage(value: Record<string, unknown> | null): boolean {
  const sourceType = normalizeType(firstString(value, "source_type", "sourceType") ?? "");
  if (sourceType === "employee" || sourceType === "agent") return true;
  const sourceRole = normalizeType(firstString(value, "source_role", "sourceRole") ?? "");
  return sourceRole === "participant" || sourceRole === "child" || sourceRole === "coordinator";
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

function messageActivityIdentity(value: unknown): string | null {
  const record = asRecord(value);
  const message = asRecord(record?.message);
  const role = lower(firstString(message, "role"));
  const timestamp = message?.timestamp;
  if (!role || (typeof timestamp !== "string" && (typeof timestamp !== "number" || !Number.isFinite(timestamp)))) return null;
  const source = firstString(record, "source_employee_id", "sourceEmployeeId") ?? "";
  return `${role}:${timestamp}:${source}`;
}

function messageSignature(value: unknown): string | null {
  const message = asRecord(asRecord(value)?.message);
  const role = lower(firstString(message, "role"));
  const rawContent = message?.content;
  const visibleContent = role === "assistant" && Array.isArray(rawContent)
    ? rawContent.filter((part) => normalizeType(firstString(asRecord(part), "type") ?? "") === "text")
    : rawContent;
  const content = textFrom(visibleContent);
  return role && content ? `${role}:${content}` : null;
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

function firstValue(value: Record<string, unknown> | null, keys: string[]): unknown {
  if (!value) return undefined;
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) return value[key];
  }
  return undefined;
}

function thinkingTextFrom(value: unknown, depth = 0, seen = new WeakSet<object>()): string | null {
  if (typeof value === "string") return fullDisplayText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!value || depth > MAX_JSON_DEPTH || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      let text = "";
      for (const part of value) text += thinkingTextFrom(part, depth + 1, seen) ?? "";
      return text || null;
    }
    const record = asRecord(value);
    if (!record) return null;
    for (const key of ["thinking", "reasoning", "delta", "text", "content", "message", "assistantMessageEvent"]) {
      const text = thinkingTextFrom(record[key], depth + 1, seen);
      if (text) return text;
    }
    return null;
  } finally {
    seen.delete(value);
  }
}

function textFrom(value: unknown, depth = 0, seen = new WeakSet<object>()): string | null {
  if (typeof value === "string") return safeDisplayText(value, MAX_SUMMARY_LENGTH);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!value || depth > MAX_JSON_DEPTH) return null;
  if (typeof value === "object") {
    if (seen.has(value)) return null;
    seen.add(value);
  }
  try {
    if (Array.isArray(value)) {
      let text = "";
      for (const part of value.slice(0, MAX_ARRAY_ITEMS)) {
        const next = textFrom(part, depth + 1, seen);
        if (!next) continue;
        text += next;
        if (text.length >= MAX_SUMMARY_LENGTH) return boundedText(text, MAX_SUMMARY_LENGTH);
      }
      return text || null;
    }
    const record = asRecord(value);
    if (!record) return null;
    for (const key of ["text", "delta", "thinking", "reasoning", "content", "message", "summary", "preview", "snippet", "output", "result"]) {
      const child = record[key];
      if (typeof child === "string" || Array.isArray(child) || (child && typeof child === "object")) {
        const text = textFrom(child, depth + 1, seen);
        if (text) return text;
      }
    }
    return null;
  } finally {
    if (value && typeof value === "object") seen.delete(value);
  }
}

function boundedDetail(value: unknown): string {
  if (typeof value === "string") return safeDisplayText(value, MAX_DETAIL_LENGTH);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = textFrom(value);
  return boundedText(text ? safeDisplayText(text, MAX_DETAIL_LENGTH) : boundedJson(value), MAX_DETAIL_LENGTH);
}

function detailSummary(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return boundedDetail(value);
}

function safeDisplayText(value: string, maxLength: number): string {
  return boundedText(fullDisplayText(value), maxLength);
}

function fullDisplayText(value: string): string {
  return value.replace(INLINE_SECRET, "[已隐藏]").replace(INLINE_PATH, "[路径已隐藏]");
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

function looksLikeToolResult(type: string, value: Record<string, unknown> | null): boolean {
  if (isToolResultType(type)) return true;
  const message = asRecord(value?.message);
  const role = lower(typeof message?.role === "string" ? message.role : typeof value?.role === "string" ? value.role : null);
  if (role === "toolresult" || role === "tool_result") return true;
  return value?.isError === true || value?.result !== undefined || value?.output !== undefined || value?.response !== undefined;
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
