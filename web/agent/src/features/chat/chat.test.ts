import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentApiClient } from "../../lib/api-client";
import { createConversation, getEntries, listConversations, setConversationState, submitPrompt, subscribePiEvents } from "./useChatApi";

afterEach(() => vi.restoreAllMocks());

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

  it("persists state through the Node Agent state endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => new Response(JSON.stringify({ data: { id: "c1", state: JSON.parse(String(init?.body)).state } }), { headers: { "content-type": "application/json" } }));
    await expect(setConversationState(client(fetchMock as unknown as typeof fetch), "c1", "paused")).resolves.toMatchObject({ state: "paused" });
    expect(fetchMock).toHaveBeenCalledWith("http://agent.test/api/agent/conversations/c1/state", expect.objectContaining({ method: "PUT" }));
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
