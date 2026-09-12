import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiEntry } from "@aiteam/shared/contracts";
import { AgentApiClient } from "../../lib/api-client";
import {
  decideApproval,
  getConversationParticipants,
  listApprovals,
  parsePiSseReconciliation,
  readSse,
  searchMessages,
  subscribePiEvents,
  type ApprovalRecord,
} from "./useChatApi";

function envelope(data: unknown): string {
  return JSON.stringify({ data });
}

function client(fetchImpl: typeof fetch): AgentApiClient {
  return new AgentApiClient({ baseUrl: "http://agent.test", fetch: fetchImpl });
}

function approval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: "approval-1",
    approval_batch_id: "batch-1",
    conversation_id: "conversation-1",
    participant_employee_id: "employee-1",
    session_id: "session-1",
    snapshot_version: "snapshot-1",
    permission_revision: 3,
    tool_call_id: "call-1",
    tool_name: "bash",
    canonical_args_hmac: "hmac-never-rendered",
    redacted_summary: "执行一条本地命令",
    risk_level: "bash",
    status: "pending",
    approved_by: null,
    approved_at: null,
    expires_at: "2026-09-01T10:00:00Z",
    decision_revision: 4,
    consumed: false,
    created_at: "2026-09-01T09:00:00Z",
    updated_at: "2026-09-01T09:00:00Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Agent Web consumer contract", () => {
  it("reads owner-scoped approvals and sends CAS plus Idempotency-Key decisions", async () => {
    const current = approval();
    const decided = approval({ status: "approved", approved_by: "member-1", decision_revision: 5 });
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ decision: "approve", expected_revision: 4 });
        expect(new Headers(init.headers).get("Idempotency-Key")).toBe("decision-key");
        return new Response(envelope(decided), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(envelope([current]), { headers: { "content-type": "application/json" } });
    });
    const api = client(fetchMock as unknown as typeof fetch);
    await expect(listApprovals(api, "conversation-1")).resolves.toEqual([current]);
    await expect(decideApproval(api, "conversation-1", "approval-1", "approve", 4, "decision-key")).resolves.toEqual(decided);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://agent.test/api/agent/conversations/conversation-1/approvals/approval-1/decision",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps SSE event names, parses reconciliation, and forwards reconnect cursors", async () => {
    vi.useFakeTimers();
    const entry: PiEntry = { id: "entry-1", type: "message", message: { role: "assistant", content: "done" } };
    const reconciliation = {
      schema_version: "1",
      type: "reconciliation",
      conversation_id: "conversation-1",
      state: "active",
      prompting: false,
      entries: [entry],
      receipts: [{ idempotency_key: "prompt-1", state: "completed", last_entry_id: "entry-1", failure_code: null, failure_detail: null }],
    } as const;
    const streams = [
      `id: 42\nevent: pi\ndata: {"type":"agent_start"}\n\n`,
      `id: 43\nevent: reconciliation\ndata: ${JSON.stringify(reconciliation)}\n\n`,
    ];
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
      const body = streams.shift() ?? "";
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    });
    const received: Array<{ id: string; eventName?: string; reconciliation?: boolean }> = [];
    const subscription = subscribePiEvents(
      client(fetchMock as unknown as typeof fetch),
      "conversation-1",
      (message) => received.push({ id: message.id, eventName: message.eventName, reconciliation: Boolean(message.reconciliation) }),
    );
    await vi.waitFor(() => expect(received).toEqual([{ id: "42", eventName: "pi", reconciliation: false }]));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[1]).toMatchObject({ id: "43", eventName: "reconciliation", reconciliation: true });
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      headers: expect.any(Headers),
    }));
    const reconnectInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(reconnectInit.headers).get("Last-Event-ID")).toBe("42");
    subscription.close();
  });

  it("bounds and validates reconciliation payloads without accepting malformed receipts", () => {
    const valid = parsePiSseReconciliation({
      schema_version: "1",
      type: "reconciliation",
      conversation_id: "conversation-1",
      state: "active",
      prompting: false,
      entries: [{ id: "entry-1", type: "message" }],
      receipts: [{ idempotency_key: "key", state: "unknown", last_entry_id: null, failure_code: "init_failed", failure_detail: "safe detail" }],
    });
    expect(valid).toMatchObject({ entries: [{ id: "entry-1" }], receipts: [{ state: "unknown" }] });
    expect(parsePiSseReconciliation({ ...valid, receipts: [{ ...valid!.receipts[0], state: "bad" }] })).toBeNull();
    expect(parsePiSseReconciliation({ ...valid, entries: Array.from({ length: 65 }, (_, index) => ({ id: String(index), type: "message" })) })).toBeNull();
  });

  it("preserves SSE multiline data and wires existing local search and participant reads", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: reconciliation\ndata: {\"schema_version\":\"1\",\ndata: \"joined\"}\n\n"));
        controller.close();
      },
    });
    const messages: string[] = [];
    await readSse(stream, (message) => messages.push(`${message.eventName}:${message.data}`), new AbortController().signal);
    expect(messages).toEqual(["reconciliation:{\"schema_version\":\"1\",\n\"joined\"}"]);

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/participants")) return new Response(envelope({ conversation_id: "conversation-1", participants: [], employee_count: 0 }), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ data: [{ conversation_id: "conversation-1", conversation_title: "本地会话", entry_ref: "entry-1", id: "pi-1", participant_employee_id: null, timestamp: "2026-09-01T09:00:00Z", role: "assistant", snippet: "本地结果" }], page: { next_cursor: null, has_more: false } }), { headers: { "content-type": "application/json" } });
    });
    const api = client(fetchMock as unknown as typeof fetch);
    await expect(getConversationParticipants(api, "conversation-1")).resolves.toMatchObject({ employee_count: 0 });
    await expect(searchMessages(api, { q: "结果", limit: 20 })).resolves.toMatchObject({ items: [{ entry_ref: "entry-1" }] });
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("q=%E7%BB%93%E6%9E%9C");
  });
});
