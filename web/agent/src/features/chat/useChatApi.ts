/** Agent chat API: prompt submission, persisted Pi entries, and Pi event SSE. */
import type { PiEntry, PiEvent, ConversationEntries } from "@aiteam/shared/contracts";
import type { AgentApiClient } from "../../lib/api-client";

export type ConversationPermissionMode = "read-only" | "workspace-write" | "full-access";
export type ConversationThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
  permission_mode?: ConversationPermissionMode;
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
  permission_mode?: ConversationPermissionMode;
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
      ...(input.permission_mode !== undefined ? { permission_mode: input.permission_mode } : {}),
    },
  });
}

export interface PromptInput {
  text: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  attachment_ids?: string[];
  mentions?: string[];
}

export interface ConversationContext {
  conversation_id: string;
  employee_id: string;
  model: { provider: string; id: string; name: string } | null;
  used_tokens: number | null;
  context_window: number;
  percentage: number | null;
  thinking_level: ConversationThinkingLevel;
  prompting: boolean;
}

export async function getConversationContext(client: AgentApiClient, conversationId: string): Promise<ConversationContext | null> {
  const result = await client.get<ConversationContext>(`/api/agent/conversations/${encodeURIComponent(conversationId)}/context`);
  return isConversationContext(result) ? result : null;
}

export async function setConversationThinkingLevel(
  client: AgentApiClient,
  conversationId: string,
  thinkingLevel: ConversationThinkingLevel,
): Promise<ConversationContext | null> {
  const result = await client.patch<ConversationContext>(
    `/api/agent/conversations/${encodeURIComponent(conversationId)}/context`,
    { body: { thinking_level: thinkingLevel } },
  );
  return isConversationContext(result) ? result : null;
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

const MAX_LOCAL_FILE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_ATTACHMENT_MIMES = new Set([
  "application/json", "application/msword", "application/octet-stream", "application/pdf", "application/rtf",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/xml", "application/yaml",
  "image/gif", "image/jpeg", "image/png", "image/webp", "text/csv", "text/css", "text/html", "text/javascript",
  "text/markdown", "text/plain", "text/typescript", "text/xml", "text/yaml",
]);
const MIME_BY_EXTENSION: Record<string, string> = {
  bash: "text/plain", c: "text/plain", cc: "text/plain", cfg: "text/plain", conf: "text/plain", cpp: "text/plain", cxx: "text/plain",
  css: "text/css", csv: "text/csv", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  go: "text/plain", h: "text/plain", hpp: "text/plain", htm: "text/html", html: "text/html", ini: "text/plain", java: "text/plain",
  js: "text/javascript", json: "application/json", jsx: "text/javascript", md: "text/markdown", markdown: "text/markdown", mjs: "text/javascript",
  cjs: "text/javascript", pdf: "application/pdf", php: "text/plain", ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", py: "text/plain", rb: "text/plain", rs: "text/plain",
  sh: "text/plain", sql: "text/plain", swift: "text/plain", toml: "text/plain", ts: "text/typescript", tsx: "text/typescript",
  txt: "text/plain", xml: "application/xml", yaml: "text/yaml", yml: "text/yaml", webp: "image/webp", png: "image/png", jpg: "image/jpeg",
  jpeg: "image/jpeg", gif: "image/gif",
};

export function attachmentMimeType(file: Pick<File, "name" | "type">): string {
  if (file.type && SUPPORTED_ATTACHMENT_MIMES.has(file.type)) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  return (extension && MIME_BY_EXTENSION[extension]) || file.type || "application/octet-stream";
}

export function isSupportedAttachmentMime(mimeType: string): boolean {
  return SUPPORTED_ATTACHMENT_MIMES.has(mimeType);
}

export async function uploadAttachment(client: AgentApiClient, conversationId: string, file: File): Promise<LocalFile> {
  if (file.size > MAX_LOCAL_FILE_BYTES) throw new Error("Local files must be 5 MiB or smaller");
  const mimeType = attachmentMimeType(file);
  if (!SUPPORTED_ATTACHMENT_MIMES.has(mimeType)) throw new Error("Unsupported local attachment type");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let data = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) data += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  const result = await client.post<LocalFile>(`/api/agent/conversations/${encodeURIComponent(conversationId)}/attachments`, {
    body: { filename: file.name, mime_type: mimeType, data: btoa(data) },
  });
  if (!result) throw new Error("attachment upload: empty response");
  return result;
}

export async function deleteAttachment(client: AgentApiClient, conversationId: string, attachmentId: string): Promise<void> {
  await client.del(`/api/agent/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}`);
}

export async function listLocalFiles(client: AgentApiClient, conversationId: string): Promise<LocalFile[]> {
  const prefix = `/api/agent/conversations/${encodeURIComponent(conversationId)}`;
  const [attachments, artifacts] = await Promise.all([
    client.listGet<LocalFile>(`${prefix}/attachments`),
    client.listGet<LocalFile>(`${prefix}/artifacts`),
  ]);
  return [...attachments.items, ...artifacts.items]
    .filter(isLocalFile)
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
}

export function downloadLocalFile(client: AgentApiClient, file: LocalFile): Promise<Response> {
  const collection = file.kind === "artifact" ? "artifacts" : "attachments";
  return client.stream(`/api/agent/conversations/${encodeURIComponent(file.conversation_id)}/${collection}/${encodeURIComponent(file.id)}`);
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
  patch: { title?: string | null; schedule?: Record<string, unknown> | null; permission_mode?: ConversationPermissionMode },
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

function isConversationContext(value: ConversationContext | null): value is ConversationContext {
  return Boolean(value && typeof value.conversation_id === "string" && typeof value.employee_id === "string" && typeof value.context_window === "number" && typeof value.thinking_level === "string");
}

function isLocalFile(value: LocalFile): value is LocalFile {
  return Boolean(value && typeof value.id === "string" && typeof value.conversation_id === "string" && (value.kind === "attachment" || value.kind === "artifact") && typeof value.filename === "string" && typeof value.mime_type === "string" && typeof value.byte_size === "number");
}

function eventId(event: PiEvent): string {
  return typeof event.id === "string" ? event.id : `${event.type}-${Date.now()}`;
}

export function makeIdempotencyKey(): string {
  return typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export type { PiEntry };
