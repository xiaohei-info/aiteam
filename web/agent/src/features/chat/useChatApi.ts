/** Agent chat API: prompt submission, persisted Pi entries, and Pi event SSE. */
import type { PiEntry, PiEvent, ConversationEntries } from "@aiteam/shared/contracts";
import type { AgentApiClient } from "../../lib/api-client";

export interface Conversation {
  id: string;
  title: string | null;
  kind?: string;
  labels?: string[];
  state: string;
  collaboration_mode?: string;
  entry_employee_id: string | null;
  coordinator_employee_id: string | null;
  solution_instance_id: string | null;
  schedule: Record<string, unknown> | null;
  last_read_entry_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function listConversations(
  client: AgentApiClient,
  cursor?: string | null,
  limit = 50,
): Promise<{ items: Conversation[]; nextCursor: string | null; hasMore: boolean }> {
  const result = await client.listGet<Conversation>("/api/agent/conversations", {
    query: { limit, cursor },
  });
  if (!Array.isArray(result.items) || !result.page || typeof result.page.has_more !== "boolean") {
    throw new Error("conversation list: invalid response");
  }
  return {
    items: result.items,
    nextCursor: result.page.next_cursor ?? null,
    hasMore: result.page.has_more,
  };
}

export interface CreateConversationInput {
  id?: string;
  title?: string | null;
  kind?: string;
  collaboration_mode?: "free" | "orchestrated" | null;
  entry_employee_id?: string | null;
  coordinator_employee_id?: string | null;
  solution_instance_id?: string | null;
}

export async function createConversation(
  client: AgentApiClient,
  input: CreateConversationInput,
): Promise<Conversation | null> {
  return client.post<Conversation>("/api/agent/conversations", {
    body: {
      ...(input.id ? { id: input.id } : {}),
      title: input.title ?? null,
      kind: input.kind ?? (input.collaboration_mode === "orchestrated" ? "group" : "private"),
      ...(input.entry_employee_id !== undefined ? { entry_employee_id: input.entry_employee_id } : {}),
      ...(input.coordinator_employee_id !== undefined ? { coordinator_employee_id: input.coordinator_employee_id } : {}),
      ...(input.solution_instance_id !== undefined ? { solution_instance_id: input.solution_instance_id } : {}),
    },
  });
}

export interface PromptInput {
  text: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  attachment_ids?: string[];
  mentions?: string[];
}

export interface LocalFile {
  id: string;
  conversation_id: string;
  tenant_id: string;
  member_id: string;
  kind: "attachment" | "artifact";
  filename: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  created_at: string;
  referenced_at: string | null;
}

export async function uploadAttachment(client: AgentApiClient, conversationId: string, file: File): Promise<LocalFile> {
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) throw new Error("Only PNG, JPEG, WEBP, and GIF attachments are supported");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let data = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) data += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  const result = await client.post<LocalFile>(`/api/agent/conversations/${encodeURIComponent(conversationId)}/attachments`, {
    body: { filename: file.name, mime_type: file.type, data: btoa(data) },
  });
  if (!result) throw new Error("attachment upload: empty response");
  return result;
}

export async function deleteAttachment(client: AgentApiClient, conversationId: string, attachmentId: string): Promise<void> {
  await client.del(`/api/agent/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}`);
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

export async function updateConversation(
  client: AgentApiClient,
  conversationId: string,
  patch: { title?: string | null; schedule?: Record<string, unknown> | null },
): Promise<Conversation | null> {
  return client.patch<Conversation>(
    `/api/agent/conversations/${encodeURIComponent(conversationId)}`,
    { body: patch },
  );
}

export async function getConversationRuntimeState(
  client: AgentApiClient,
  conversationId: string,
): Promise<{ conversation_id: string; state: string; prompting: boolean } | null> {
  return client.get(`/api/agent/conversations/${encodeURIComponent(conversationId)}/state`);
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

export function makeIdempotencyKey(): string {
  return typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export type { PiEntry };
