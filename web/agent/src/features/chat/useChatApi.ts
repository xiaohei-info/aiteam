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
  /** Server-derived safe preview; transient event deltas never populate this field. */
  last_preview?: string | null;
  /** Server-derived unread assistant count after last_read_entry_id. */
  unread_count?: number;
  tenant_id?: string | null;
  member_id?: string | null;
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
  available_thinking_levels: ConversationThinkingLevel[];
  prompting: boolean;
}

export async function getConversationContext(client: AgentApiClient, conversationId: string): Promise<ConversationContext | null> {
  const result = await client.get<ConversationContext>(`/api/agent/conversations/${encodeURIComponent(conversationId)}/context`);
  return normalizeConversationContext(result);
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
  return normalizeConversationContext(result);
}

function normalizeConversationContext(value: ConversationContext | null): ConversationContext | null {
  if (!isConversationContext(value)) return null;
  return {
    ...value,
    available_thinking_levels: value.available_thinking_levels === undefined
      ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
      : value.available_thinking_levels.length > 0
        ? value.available_thinking_levels
        : ["off"],
  };
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
const SUPPORTED_AUDIO_MIMES = new Set(["audio/aac", "audio/flac", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/opus", "audio/wav", "audio/webm", "audio/x-wav"]);

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

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let data = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) data += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(data);
}

export function audioMimeType(file: Pick<File, "type">): string {
  const mimeType = (typeof file.type === "string" ? file.type : "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mimeType;
}

export function isSupportedAudioMime(mimeType: string): boolean {
  return SUPPORTED_AUDIO_MIMES.has(mimeType);
}

export interface AudioTranscription {
  text: string;
  duration?: number;
}

export async function transcribeAudio(client: AgentApiClient, file: File): Promise<AudioTranscription> {
  if (file.size > MAX_LOCAL_FILE_BYTES) throw new Error("Audio files must be 5 MiB or smaller");
  const mimeType = audioMimeType(file);
  if (!isSupportedAudioMime(mimeType)) throw new Error("Unsupported audio type");
  const result = await client.post<AudioTranscription>("/api/agent/audio/transcriptions", {
    body: { filename: file.name, mime_type: mimeType, data: await fileToBase64(file) },
  });
  if (!result || typeof result.text !== "string") throw new Error("audio transcription: invalid response");
  return result;
}

export async function uploadAttachment(client: AgentApiClient, conversationId: string, file: File): Promise<LocalFile> {
  if (file.size > MAX_LOCAL_FILE_BYTES) throw new Error("Local files must be 5 MiB or smaller");
  const mimeType = attachmentMimeType(file);
  if (!SUPPORTED_ATTACHMENT_MIMES.has(mimeType)) throw new Error("Unsupported local attachment type");
  const result = await client.post<LocalFile>(`/api/agent/conversations/${encodeURIComponent(conversationId)}/attachments`, {
    body: { filename: file.name, mime_type: mimeType, data: await fileToBase64(file) },
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

export async function getConversation(client: AgentApiClient, conversationId: string): Promise<Conversation | null> {
  return client.get<Conversation>(`/api/agent/conversations/${encodeURIComponent(conversationId)}`);
}

export async function getEntries(client: AgentApiClient, conversationId: string, entryRef?: string | null): Promise<PiEntry[]> {
  const result = await client.get<ConversationEntries>(
    `/api/agent/conversations/${encodeURIComponent(conversationId)}/entries`,
    entryRef ? { query: { entry_ref: entryRef } } : undefined,
  );
  return result?.entries ?? [];
}

/** A local participant row is the only source for a real group's roster. */
export interface ConversationParticipant {
  employee_id: string;
  display_name: string;
  handle: string | null;
  role_title: string | null;
  department_ids: string[];
  role: "coordinator" | "participant";
  available: boolean;
}

export interface ConversationParticipants {
  conversation_id: string;
  participants: ConversationParticipant[];
  employee_count: number;
}

export async function getConversationParticipants(
  client: AgentApiClient,
  conversationId: string,
): Promise<ConversationParticipants | null> {
  const result = await client.get<ConversationParticipants>(
    `/api/agent/conversations/${encodeURIComponent(conversationId)}/participants`,
  );
  if (!result || result.conversation_id !== conversationId || !Array.isArray(result.participants)) {
    throw new Error("conversation participants: invalid response");
  }
  if (!result.participants.every(isConversationParticipant)) throw new Error("conversation participants: invalid member");
  return result;
}

/** Read-only local full-text search. The server returns safe snippets and opaque entry_ref values. */
export interface MessageSearchHit {
  conversation_id: string;
  /** Optional additive hint; canonical routing resolves kind from conversation metadata. */
  kind?: string;
  conversation_title: string | null;
  entry_ref: string;
  id: string;
  participant_employee_id: string | null;
  timestamp: string;
  role: "user" | "assistant";
  source_type?: "human" | "employee";
  source_id?: string;
  source_display_name?: string;
  source_employee_id?: string;
  source_employee_display_name?: string;
  source_role?: "human" | "participant" | "coordinator";
  logical_message_id?: string;
  snippet: string;
}

export interface MessageSearchInput {
  q: string;
  conversation_id?: string | null;
  employee_id?: string | null;
  cursor?: string | null;
  limit?: number;
}

export async function searchMessages(
  client: AgentApiClient,
  input: MessageSearchInput,
): Promise<{ items: MessageSearchHit[]; nextCursor: string | null; hasMore: boolean }> {
  const q = input.q.trim();
  if (!q) throw new Error("message search: query is required");
  const result = await client.listGet<MessageSearchHit>("/api/agent/messages/search", {
    query: {
      q,
      conversation_id: input.conversation_id,
      employee_id: input.employee_id,
      cursor: input.cursor,
      limit: input.limit,
    },
  });
  if (!Array.isArray(result.items) || !result.page || typeof result.page.has_more !== "boolean") {
    throw new Error("message search: invalid response");
  }
  return {
    items: result.items,
    nextCursor: result.page.next_cursor ?? null,
    hasMore: result.page.has_more,
  };
}

export type ApprovalRiskLevel = "bash" | "write" | "edit" | "external" | "unknown";
export type ApprovalStatus = "pending" | "approved" | "executing" | "succeeded" | "rejected" | "invalidated" | "expired" | "uncertain";
export type ApprovalDecision = "approve" | "deny";

/** Owner-scoped approval projection; canonical_args_hmac is never rendered or sent back. */
export interface ApprovalRecord {
  id: string;
  approval_batch_id: string;
  conversation_id: string;
  participant_employee_id: string | null;
  session_id: string;
  snapshot_version: string;
  permission_revision: string | number;
  tool_call_id: string;
  tool_name: string;
  canonical_args_hmac: string;
  redacted_summary: string;
  risk_level: ApprovalRiskLevel;
  status: ApprovalStatus;
  approved_by: string | null;
  approved_at: string | null;
  expires_at: string;
  decision_revision: number;
  consumed: boolean;
  created_at: string;
  updated_at: string;
}

export async function listApprovals(client: AgentApiClient, conversationId: string): Promise<ApprovalRecord[]> {
  const result = await client.get<ApprovalRecord[]>(
    `/api/agent/conversations/${encodeURIComponent(conversationId)}/approvals`,
  );
  if (!Array.isArray(result) || !result.every(isApprovalRecord)) throw new Error("approval list: invalid response");
  return result;
}

export async function decideApproval(
  client: AgentApiClient,
  conversationId: string,
  approvalId: string,
  decision: ApprovalDecision,
  expectedRevision?: number,
  idempotencyKey = makeIdempotencyKey(),
): Promise<ApprovalRecord> {
  const result = await client.post<ApprovalRecord>(
    `/api/agent/conversations/${encodeURIComponent(conversationId)}/approvals/${encodeURIComponent(approvalId)}/decision`,
    {
      body: {
        decision,
        ...(expectedRevision === undefined ? {} : { expected_revision: expectedRevision }),
      },
      idempotencyKey,
    },
  );
  if (!result || !isApprovalRecord(result)) throw new Error("approval decision: invalid response");
  return result;
}

export interface PiSseReceipt {
  idempotency_key: string;
  state: "accepted" | "completed" | "unknown";
  last_entry_id: string | null;
  failure_code: string | null;
  failure_detail: string | null;
}

export interface PiSseReconciliation {
  schema_version: "1";
  type: "reconciliation";
  conversation_id: string;
  state: string;
  prompting: boolean;
  entries: PiEntry[];
  receipts: PiSseReceipt[];
}

export interface PiSseEventMessage {
  id: string;
  event: PiEvent;
  /** Raw SSE event name (normally `pi`, or `reconciliation`). */
  eventName?: string;
  reconciliation?: PiSseReconciliation;
}

export interface PiEventSubscription {
  close(): void;
  /** Resolves after the first HTTP SSE response has opened, not when subscribe() is called. */
  ready?: Promise<void>;
}

export interface PiEventSubscriptionOptions {
  onOpen?: (info: { reconnect: boolean; lastEventId: string | null }) => void;
}

export const SSE_RECONNECT_BASE_DELAY_MS = 250;
export const SSE_RECONNECT_MAX_DELAY_MS = 5_000;
export const MAX_RECONCILIATION_ENTRIES = 64;
export const MAX_RECONCILIATION_RECEIPTS = 64;

/**
 * Subscribe to the owner-checked Pi stream and reconnect until explicitly closed.
 * The latest server SSE id is sent in both `after` and `Last-Event-ID`; `after`
 * remains the server's preferred query cursor while the header supports native SSE clients.
 */
export function subscribePiEvents(
  client: AgentApiClient,
  conversationId: string,
  onEvent: (event: PiSseEventMessage) => void,
  onError?: (error: unknown) => void,
  after?: string | null,
  options: PiEventSubscriptionOptions = {},
): PiEventSubscription {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let reconnectAttempt = 0;
  let lastEventId = after ?? null;
  let openedOnce = false;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });

  const scheduleReconnect = () => {
    if (closed || controller.signal.aborted || timer) return;
    const delay = Math.min(
      SSE_RECONNECT_MAX_DELAY_MS,
      SSE_RECONNECT_BASE_DELAY_MS * (2 ** Math.min(reconnectAttempt, 5)),
    );
    reconnectAttempt += 1;
    timer = setTimeout(() => {
      timer = null;
      void connect();
    }, delay);
  };

  const connect = async (): Promise<void> => {
    if (closed || controller.signal.aborted) return;
    try {
      const cursor = lastEventId;
      const response = await client.stream(
        `/api/agent/conversations/${encodeURIComponent(conversationId)}/events`,
        {
          query: cursor ? { after: cursor } : undefined,
          headers: cursor ? { "Last-Event-ID": cursor } : undefined,
          signal: controller.signal,
        },
      );
      if (!response.body) throw new Error("SSE response has no body");
      const reconnect = openedOnce;
      openedOnce = true;
      reconnectAttempt = 0;
      resolveReady();
      options.onOpen?.({ reconnect, lastEventId });
      await readSse(response.body, (message) => {
        if (!message.data) return;
        let payload: unknown;
        try {
          payload = JSON.parse(message.data) as unknown;
        } catch {
          throw new Error("SSE data is not valid JSON");
        }
        const eventName = message.eventName || "message";
        const record = asEventRecord(payload);
        if (!record || typeof record.type !== "string") throw new Error("SSE data has no event type");
        if (eventName === "reconciliation" || record.type === "reconciliation") {
          const reconciliation = parsePiSseReconciliation(record);
          if (!reconciliation) throw new Error("SSE reconciliation is invalid");
          if (message.id) lastEventId = message.id;
          onEvent({
            id: message.id ?? eventId(record as PiEvent),
            event: record as PiEvent,
            eventName,
            reconciliation,
          });
          return;
        }
        if (message.id) lastEventId = message.id;
        onEvent({ id: message.id ?? eventId(record as PiEvent), event: record as PiEvent, eventName });
      }, controller.signal);
      if (!closed && !controller.signal.aborted) {
        onError?.(new Error("SSE stream closed"));
        scheduleReconnect();
      }
    } catch (error) {
      if (closed || controller.signal.aborted) return;
      onError?.(error);
      scheduleReconnect();
    }
  };

  void connect();
  return {
    ready,
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      controller.abort();
    },
  };
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
  patch: {
    title?: string | null;
    schedule?: Record<string, unknown> | null;
    permission_mode?: ConversationPermissionMode;
    last_read_entry_id?: string | null;
  },
): Promise<Conversation | null> {
  return client.patch<Conversation>(
    `/api/agent/conversations/${encodeURIComponent(conversationId)}`,
    { body: patch },
  );
}

export async function markConversationRead(
  client: AgentApiClient,
  conversationId: string,
  entryRef: string | null,
): Promise<Conversation | null> {
  return updateConversation(client, conversationId, { last_read_entry_id: entryRef });
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

export interface ParsedSseMessage {
  id?: string;
  eventName: string;
  data: string;
}

/** Minimal SSE parser: retain event names and multiline data, ignore comments/retry fields. */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onMessage: (message: ParsedSseMessage) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | undefined;
  let eventName = "message";
  let data: string[] = [];
  const flush = () => {
    if (data.length > 0) onMessage({ id, eventName, data: data.join("\n") });
    id = undefined;
    eventName = "message";
    data = [];
  };
  const consumeLine = (line: string) => {
    if (line === "") {
      flush();
      return;
    }
    if (line.startsWith(":")) return;
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("event:")) eventName = line.slice(6).trim() || "message";
    else if (line.startsWith("data:")) data.push(line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5));
  };
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      buffer += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
      if (next.done) {
        if (buffer) consumeLine(buffer);
        // A stream may end without the terminating blank line.
        flush();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function isConversationContext(value: ConversationContext | null): value is ConversationContext {
  return Boolean(value
    && typeof value.conversation_id === "string"
    && typeof value.employee_id === "string"
    && typeof value.context_window === "number"
    && typeof value.thinking_level === "string"
    && (value.available_thinking_levels === undefined || Array.isArray(value.available_thinking_levels)));
}

function isLocalFile(value: LocalFile): value is LocalFile {
  return Boolean(value && typeof value.id === "string" && typeof value.conversation_id === "string" && (value.kind === "attachment" || value.kind === "artifact") && typeof value.filename === "string" && typeof value.mime_type === "string" && typeof value.byte_size === "number");
}

function eventId(event: PiEvent): string {
  return typeof event.id === "string" ? event.id : `${event.type}-${Date.now()}`;
}

function asEventRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parsePiSseReconciliation(value: unknown): PiSseReconciliation | null {
  const record = asEventRecord(value);
  if (!record || record.schema_version !== "1" || record.type !== "reconciliation"
    || typeof record.conversation_id !== "string" || typeof record.state !== "string"
    || typeof record.prompting !== "boolean" || !Array.isArray(record.entries) || !Array.isArray(record.receipts)) {
    return null;
  }
  if (record.entries.length > MAX_RECONCILIATION_ENTRIES || record.receipts.length > MAX_RECONCILIATION_RECEIPTS) return null;
  const entries = record.entries.map((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
    && typeof (entry as Record<string, unknown>).id === "string"
    && typeof (entry as Record<string, unknown>).type === "string"
    ? entry as PiEntry
    : null);
  const receipts = record.receipts.map((receipt) => {
    const item = asEventRecord(receipt);
    if (!item || typeof item.idempotency_key !== "string"
      || (item.state !== "accepted" && item.state !== "completed" && item.state !== "unknown")
      || (item.last_entry_id !== null && typeof item.last_entry_id !== "string")
      || (item.failure_code !== null && typeof item.failure_code !== "string")
      || (item.failure_detail !== null && typeof item.failure_detail !== "string")) return null;
    return item as unknown as PiSseReceipt;
  });
  if (entries.some((entry) => entry === null) || receipts.some((receipt) => receipt === null)) return null;
  return {
    schema_version: "1",
    type: "reconciliation",
    conversation_id: record.conversation_id,
    state: record.state,
    prompting: record.prompting,
    entries: entries as PiEntry[],
    receipts: receipts as PiSseReceipt[],
  };
}

function isConversationParticipant(value: unknown): value is ConversationParticipant {
  const record = asEventRecord(value);
  return Boolean(record
    && typeof record.employee_id === "string"
    && typeof record.display_name === "string"
    && (record.handle === null || typeof record.handle === "string")
    && (record.role_title === null || typeof record.role_title === "string")
    && Array.isArray(record.department_ids)
    && record.department_ids.every((id) => typeof id === "string")
    && (record.role === "coordinator" || record.role === "participant")
    && typeof record.available === "boolean");
}

function isApprovalRecord(value: unknown): value is ApprovalRecord {
  const record = asEventRecord(value);
  if (!record) return false;
  const risks: ApprovalRiskLevel[] = ["bash", "write", "edit", "external", "unknown"];
  const statuses: ApprovalStatus[] = ["pending", "approved", "executing", "succeeded", "rejected", "invalidated", "expired", "uncertain"];
  return typeof record.id === "string"
    && typeof record.approval_batch_id === "string"
    && typeof record.conversation_id === "string"
    && (record.participant_employee_id === null || typeof record.participant_employee_id === "string")
    && typeof record.session_id === "string"
    && typeof record.snapshot_version === "string"
    && (typeof record.permission_revision === "string" || typeof record.permission_revision === "number")
    && typeof record.tool_call_id === "string"
    && typeof record.tool_name === "string"
    && typeof record.canonical_args_hmac === "string"
    && typeof record.redacted_summary === "string"
    && risks.includes(record.risk_level as ApprovalRiskLevel)
    && statuses.includes(record.status as ApprovalStatus)
    && (record.approved_by === null || typeof record.approved_by === "string")
    && (record.approved_at === null || typeof record.approved_at === "string")
    && typeof record.expires_at === "string"
    && typeof record.decision_revision === "number"
    && Number.isInteger(record.decision_revision)
    && typeof record.consumed === "boolean"
    && typeof record.created_at === "string"
    && typeof record.updated_at === "string";
}

export function makeIdempotencyKey(): string {
  return typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export type { PiEntry };
