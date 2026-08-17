/** Conversation view backed by persisted Pi entries and the live Pi SSE stream. */
import { useEffect, useState, type ReactNode } from "react";
import type { PiEntry, PiEvent } from "@aiteam/shared/contracts";
import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
} from "@astryxdesign/core/Chat";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import type { AgentApiClient } from "../../lib/api-client";
import { getEntries, subscribePiEvents } from "./useChatApi";

export interface TimelineViewProps {
  client: AgentApiClient;
  conversationId: string;
  refreshSignal?: number;
}

export function TimelineView({ client, conversationId, refreshSignal = 0 }: TimelineViewProps) {
  const [entries, setEntries] = useState<PiEntry[]>([]);
  const [events, setEvents] = useState<Array<{ id: string; event: PiEvent }>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setEntries([]);
    setEvents([]);
    setError(null);
    const subscription = subscribePiEvents(
      client,
      conversationId,
      (next) => {
        if (alive) setEvents((current) => current.some((item) => item.id === next.id) ? current : [...current, next]);
      },
      (cause) => {
        if (alive) setError(cause instanceof Error ? cause.message : "事件流连接失败");
      },
    );
    void getEntries(client, conversationId)
      .then((next) => {
        if (alive) setEntries(next);
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : "加载会话失败");
      });
    return () => {
      alive = false;
      subscription.close();
    };
  }, [client, conversationId]);

  useEffect(() => {
    if (refreshSignal === 0) return;
    void getEntries(client, conversationId).then(setEntries).catch(() => undefined);
  }, [client, conversationId, refreshSignal]);

  const hasContent = entries.length > 0 || events.length > 0;
  return (
    <ChatMessageList
      ref={(node) => node?.setAttribute("aria-label", "对话事件流")}
      aria-label="对话事件流"
      data-testid="conversation-events"
      emptyState={<EmptyState title={error ?? "暂无事件"} isCompact />}
    >
      {entries.map((entry) => (
        <ChatMessage key={`entry-${entry.id}`} sender={entryRole(entry)} name={entry.type}>
          <ChatMessageBubble metadata="" variant="ghost">
            {renderEntry(entry)}
          </ChatMessageBubble>
        </ChatMessage>
      ))}
      {events.map(({ id, event }) => (
        <ChatMessage key={`event-${id}`} sender="assistant" name={event.type}>
          <ChatMessageBubble metadata="实时" variant="ghost">
            {renderEvent(event)}
          </ChatMessageBubble>
        </ChatMessage>
      ))}
      {!hasContent && error ? <span role="alert">{error}</span> : null}
    </ChatMessageList>
  );
}

function entryRole(entry: PiEntry): "user" | "assistant" {
  const message = asRecord(entry.message);
  return message?.role === "user" ? "user" : "assistant";
}

function renderEntry(entry: PiEntry): ReactNode {
  const message = asRecord(entry.message);
  return textFrom(message?.content ?? entry.content) ?? JSON.stringify(entry);
}

function renderEvent(event: PiEvent): ReactNode {
  return textFrom(event.message ?? event.content ?? event.text) ?? JSON.stringify(event);
}

function textFrom(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value
      .map((part) => asRecord(part)?.text)
      .filter((part): part is string => typeof part === "string")
      .join("");
    return text || null;
  }
  const record = asRecord(value);
  if (record && typeof record.text === "string") return record.text;
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}
