import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentApiClient } from "../../lib/api-client";
import { getEntries, submitPrompt, subscribePiEvents } from "./useChatApi";

afterEach(() => vi.restoreAllMocks());

function client(fetch: typeof globalThis.fetch): AgentApiClient {
  return new AgentApiClient({ baseUrl: "http://agent.test", fetch });
}

describe("Pi chat contract", () => {
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
