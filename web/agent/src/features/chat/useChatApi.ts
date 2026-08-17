/** Agent chat API: prompt submission, persisted Pi entries, and Pi event SSE. */
import type { PiEntry, PiEvent, ConversationEntries } from "@aiteam/shared/contracts";
import type { AgentApiClient } from "../../lib/api-client";

export interface Conversation {
  id: string;
  title: string | null;
  state: string;
  collaboration_mode?: string;
  orchestration_brief?: string;
  planner_employee_id?: string | null;
  entry_employee_id?: string | null;
  solution_instance_id?: string | null;
  solution_planner_prompt?: string;
  solution_subtask_prompt?: string;
  solution_aggregate_prompt?: string;
  solution_expert_employee_ids?: string[];
  last_read_at: string | null;
  last_read_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function listConversations(
  client: AgentApiClient,
  cursor?: string | null,
): Promise<{ items: Conversation[]; nextCursor: string | null; hasMore: boolean }> {
  const result = await client.listGet<Conversation>("/api/agent/conversations", {
    query: cursor ? { cursor } : undefined,
  });
  return { items: result.items, nextCursor: result.page.next_cursor, hasMore: result.page.has_more };
}

export interface CreateConversationInput {
  title?: string | null;
  collaboration_mode?: "free" | "orchestrated" | null;
  entry_employee_id?: string | null;
}

export async function createConversation(
  client: AgentApiClient,
  input: CreateConversationInput,
): Promise<Conversation | null> {
  return client.post<Conversation>("/api/agent/conversations", {
    body: {
      ...(input.title !== undefined && input.title !== null ? { title: input.title } : {}),
      ...(input.collaboration_mode ? { collaboration_mode: input.collaboration_mode } : {}),
      ...(input.entry_employee_id ? { entry_employee_id: input.entry_employee_id } : {}),
    },
  });
}

export interface PromptInput {
  text: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
}

export interface PromptAccepted {
  conversation_id: string;
  idempotency_key: string;
  accepted: boolean;
}

export async function submitPrompt(
  client: AgentApiClient,
  conversationId: string,
  input: PromptInput,
  idempotencyKey = makeIdempotencyKey(),
): Promise<PromptAccepted> {
  const result = await client.post<PromptAccepted>(
    `/api/agent/conversations/${encodeURIComponent(conversationId)}/prompt`,
    { body: input, idempotencyKey },
  );
  if (!result) throw new Error("prompt: empty response");
  return result;
}

export async function getEntries(client: AgentApiClient, conversationId: string): Promise<PiEntry[]> {
  const result = await client.get<ConversationEntries>(
    `/api/agent/conversations/${encodeURIComponent(conversationId)}/entries`,
  );
  return result?.entries ?? [];
}

export interface PiEventSubscription {
  close(): void;
}

export function subscribePiEvents(
  client: AgentApiClient,
  conversationId: string,
  onEvent: (event: { id: string; event: PiEvent }) => void,
  onError?: (error: unknown) => void,
  after?: string | null,
): PiEventSubscription {
  const controller = new AbortController();
  void (async () => {
    try {
      const response = await client.stream(
        `/api/agent/conversations/${encodeURIComponent(conversationId)}/events`,
        { query: after ? { after } : undefined, signal: controller.signal },
      );
      if (!response.body) throw new Error("SSE response has no body");
      await readSse(response.body, (message) => {
        if (!message.data) return;
        const event = JSON.parse(message.data) as PiEvent;
        onEvent({ id: message.id ?? eventId(event), event });
      }, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) onError?.(error);
    }
  })();
  return { close: () => controller.abort() };
}

export async function abortPrompt(client: AgentApiClient, conversationId: string): Promise<boolean> {
  const result = await client.post<{ conversation_id: string; aborted: boolean }>(
    `/api/agent/conversations/${encodeURIComponent(conversationId)}/abort`,
  );
  return result?.aborted ?? false;
}

export async function setConversationState(
  client: AgentApiClient,
  conversationId: string,
  state: string,
): Promise<Conversation | null> {
  return client.put<Conversation>(
    `/api/agent/conversations/${encodeURIComponent(conversationId)}/state`,
    { body: { state } },
  );
}

async function readSse(
  body: ReadableStream<Uint8Array>,
  onMessage: (message: { id?: string; data: string }) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | undefined;
  let data: string[] = [];
  const flush = () => {
    if (data.length > 0) onMessage({ id, data: data.join("\n") });
    id = undefined;
    data = [];
  };
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      buffer += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") flush();
        else if (line.startsWith("id:")) id = line.slice(3).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (next.done) break;
    }
    if (buffer === "") flush();
  } finally {
    reader.releaseLock();
  }
}

function eventId(event: PiEvent): string {
  return typeof event.id === "string" ? event.id : `${event.type}-${Date.now()}`;
}

function makeIdempotencyKey(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export type { PiEntry };
