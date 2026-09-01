import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentApiClient } from "../../lib/api-client";
import { ApiError } from "@aiteam/shared/api-client";
import { attachmentMimeType, audioMimeType, createConversation, deleteAttachment, downloadLocalFile, getConversationContext, getConversationRuntimeState, getEntries, isSupportedAttachmentMime, isSupportedAudioMime, listConversations, listLocalFiles, setConversationState, setConversationThinkingLevel, submitPrompt, subscribePiEvents, transcribeAudio, type LocalFile, uploadAttachment } from "./useChatApi";
import { isIdempotencyUnknownError, resetPendingSubmissionKey, type PendingSubmission } from "./MessageComposer";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function client(fetch: typeof globalThis.fetch): AgentApiClient {
  return new AgentApiClient({ baseUrl: "http://agent.test", fetch });
}

describe("Pi chat contract", () => {
  it("lists and creates server-owned conversation metadata", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") return new Response(JSON.stringify({ data: { id: "c1", title: "Private", kind: "private", state: "active", entry_employee_id: "e1", coordinator_employee_id: null, solution_instance_id: null, schedule: null, last_read_entry_id: null, created_at: "now", updated_at: "now" } }), { status: 201, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ data: [{ id: "c1" }], page: { next_cursor: "c1", has_more: true } }), { headers: { "content-type": "application/json" } });
    });
    const api = client(fetchMock as unknown as typeof fetch);
    await expect(listConversations(api)).resolves.toMatchObject({ items: [{ id: "c1" }], nextCursor: "c1", hasMore: true });
    await expect(createConversation(api, { title: "Private", entry_employee_id: "e1" })).resolves.toMatchObject({ entry_employee_id: "e1" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://agent.test/api/agent/conversations?limit=50");
  });

  it("reads the local context HUD and updates thinking level through the Agent API", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        expect(JSON.parse(String(init.body))).toEqual({ thinking_level: "high" });
      }
      return new Response(JSON.stringify({ data: {
        conversation_id: "c1", employee_id: "e1", model: { provider: "local", id: "model", name: "Model" },
        used_tokens: 120, context_window: 1_000, percentage: 12, thinking_level: init?.method === "PATCH" ? "high" : "medium", prompting: false,
      } }), { headers: { "content-type": "application/json" } });
    });
    const api = client(fetchMock as unknown as typeof fetch);
    await expect(getConversationContext(api, "c1")).resolves.toMatchObject({ used_tokens: 120, context_window: 1_000, percentage: 12, thinking_level: "medium" });
    await expect(setConversationThinkingLevel(api, "c1", "high")).resolves.toMatchObject({ thinking_level: "high" });
    expect(fetchMock).toHaveBeenLastCalledWith("http://agent.test/api/agent/conversations/c1/context", expect.objectContaining({ method: "PATCH" }));
  });

  it("normalizes model capabilities and attachment MIME fallbacks", async () => {
    const context = await getConversationContext(client(async () => new Response(JSON.stringify({ data: {
      conversation_id: "c1", employee_id: "e1", model: null, used_tokens: null, context_window: 1000,
      percentage: null, thinking_level: "off", available_thinking_levels: [], prompting: false,
    } }), { headers: { "content-type": "application/json" } })), "c1");
    expect(context?.available_thinking_levels).toEqual(["off"]);
    expect(attachmentMimeType({ name: "report.docx", type: "" })).toContain("wordprocessingml");
    expect(attachmentMimeType({ name: "unknown.bin", type: "application/octet-stream" })).toBe("application/octet-stream");
    expect(isSupportedAttachmentMime("text/plain")).toBe(true);
    expect(isSupportedAttachmentMime("application/x-custom")).toBe(false);
  });

  it("posts local audio to the Agent transcription endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ filename: "recording.webm", mime_type: "audio/webm", data: "YXVkaW8=" });
      return new Response(JSON.stringify({ data: { text: "hello" } }), { headers: { "content-type": "application/json" } });
    });
    const file = { name: "recording.webm", type: "audio/webm", size: 5, arrayBuffer: async () => new TextEncoder().encode("audio").buffer } as unknown as File;
    await expect(transcribeAudio(client(fetchMock as unknown as typeof fetch), file)).resolves.toEqual({ text: "hello" });
    expect(audioMimeType(file)).toBe("audio/webm");
    expect(isSupportedAudioMime("audio/webm")).toBe(true);
    expect(isSupportedAudioMime("text/plain")).toBe(false);
  });

  it("lists authenticated attachments and artifacts and downloads through the local client", async () => {
    const attachment: LocalFile = { id: "a1", conversation_id: "c1", tenant_id: "t1", member_id: "m1", kind: "attachment", filename: "notes.md", mime_type: "text/markdown", byte_size: 5, sha256: "a", created_at: "2026-01-01", referenced_at: null };
    const artifact: LocalFile = { ...attachment, id: "f1", kind: "artifact", filename: "result.ts", mime_type: "text/typescript" };
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/attachments")) return new Response(JSON.stringify({ data: [attachment], page: { next_cursor: null, has_more: false } }), { headers: { "content-type": "application/json" } });
      if (String(url).endsWith("/artifacts")) return new Response(JSON.stringify({ data: [artifact], page: { next_cursor: null, has_more: false } }), { headers: { "content-type": "application/json" } });
      return new Response("const result = true;", { headers: { "content-type": "text/typescript" } });
    });
    const api = client(fetchMock as unknown as typeof fetch);
    await expect(listLocalFiles(api, "c1")).resolves.toEqual([attachment, artifact]);
    const response = await downloadLocalFile(api, artifact);
    await expect(response.text()).resolves.toBe("const result = true;");
    expect(fetchMock).toHaveBeenLastCalledWith("http://agent.test/api/agent/conversations/c1/artifacts/f1", expect.objectContaining({ method: "GET" }));
  });

  it("rejects oversized or unsupported uploads and detects empty upload responses", async () => {
    const oversized = { name: "big.txt", type: "text/plain", size: 5 * 1024 * 1024 + 1 } as File;
    await expect(uploadAttachment(client(async () => new Response()), "c1", oversized)).rejects.toThrow("5 MiB");
    const unsupported = { name: "run.exe", type: "application/x-msdownload", size: 1 } as File;
    await expect(uploadAttachment(client(async () => new Response()), "c1", unsupported)).rejects.toThrow("Unsupported");
    const empty = {
      name: "note.txt", type: "text/plain", size: 5,
      arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
    } as unknown as File;
    const api = client(async () => new Response(JSON.stringify({ data: null }), { headers: { "content-type": "application/json" } }));
    await expect(uploadAttachment(api, "c1", empty)).rejects.toThrow("empty response");
  });

  it("reads runtime prompting state without persisting it and updates the durable state separately", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => new Response(JSON.stringify({ data: init?.method === "PUT" ? { id: "c1", state: JSON.parse(String(init.body)).state } : { conversation_id: "c1", state: "active", prompting: true } }), { headers: { "content-type": "application/json" } }));
    const api = client(fetchMock as unknown as typeof fetch);
    await expect(getConversationRuntimeState(api, "c1")).resolves.toMatchObject({ prompting: true });
    await expect(setConversationState(api, "c1", "paused")).resolves.toMatchObject({ state: "paused" });
    expect(fetchMock).toHaveBeenLastCalledWith("http://agent.test/api/agent/conversations/c1/state", expect.objectContaining({ method: "PUT" }));
  });

  it("submits one idempotent prompt request", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toBeDefined();
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("prompt-1");
      expect(JSON.parse(String(init?.body))).toEqual({ text: "hello" });
      return new Response(JSON.stringify({ data: { conversation_id: "c1", idempotency_key: "prompt-1", accepted: true } }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(submitPrompt(client(fetchMock as unknown as typeof fetch), "c1", { text: "hello" }, "prompt-1"))
      .resolves.toMatchObject({ accepted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resets only the key after idempotency_unknown and preserves uploaded prompt data without secure-context APIs", () => {
    vi.stubGlobal("crypto", {});
    const pending: PendingSubmission = { key: "old-key", text: "inspect", uploaded: [{ id: "a1" } as PendingSubmission["uploaded"][number]], uploadsComplete: true, promptAttempted: true };
    const error = new ApiError("unknown", 409, "idempotency_unknown");
    const retry = resetPendingSubmissionKey(pending);
    expect(isIdempotencyUnknownError(error)).toBe(true);
    expect(retry.key).not.toBe("old-key");
    expect(retry).toMatchObject({ text: "inspect", uploaded: pending.uploaded, uploadsComplete: true, promptAttempted: false });
    expect(isIdempotencyUnknownError(new ApiError("transient", 503, "manager_unavailable"))).toBe(false);
  });

  it("provides a local attachment delete seam for composer cleanup", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(url).toBe("http://agent.test/api/agent/conversations/c1/attachments/a1");
      expect(init?.method).toBe("DELETE");
      return new Response(JSON.stringify({ data: { deleted: true, id: "a1" } }), { headers: { "content-type": "application/json" } });
    });
    await expect(deleteAttachment(client(fetchMock as unknown as typeof fetch), "c1", "a1")).resolves.toBeUndefined();
  });

  it("loads persisted entries without numeric timeline cursors", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: { conversation_id: "c1", entries: [{ id: "e1", type: "message", message: { role: "assistant", content: "hello" } }] },
    }), { headers: { "content-type": "application/json" } }));
    await expect(getEntries(client(fetchMock as unknown as typeof fetch), "c1")).resolves.toHaveLength(1);
  });

  it("decodes Pi SSE ids and event payloads", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("id: 7\nevent: pi\ndata: {\"type\":\"message_update\",\"text\":\"hi\"}\n\n"));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () => new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    }));
    const received: Array<{ id: string; type: string }> = [];
    const subscription = subscribePiEvents(
      client(fetchMock as unknown as typeof fetch),
      "c1",
      ({ id, event }) => received.push({ id, type: event.type }),
    );
    await vi.waitFor(() => expect(received).toEqual([{ id: "7", type: "message_update" }]));
    subscription.close();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://agent.test/api/agent/conversations/c1/events",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
