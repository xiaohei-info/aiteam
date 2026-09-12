import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiEntry } from "@aiteam/shared/contracts";
import type { AgentApiClient } from "../../lib/api-client";
import type { ApprovalRecord, PiSseReconciliation } from "./useChatApi";

const mocks = vi.hoisted(() => ({
  getConversationRuntimeState: vi.fn(),
  getEntries: vi.fn(),
  listApprovals: vi.fn(),
  subscribePiEvents: vi.fn(),
}));

vi.mock("./useChatApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./useChatApi")>();
  return {
    ...actual,
    getConversationRuntimeState: mocks.getConversationRuntimeState,
    getEntries: mocks.getEntries,
    listApprovals: mocks.listApprovals,
    subscribePiEvents: mocks.subscribePiEvents,
  };
});

import { TimelineView } from "./TimelineView";

function approval(): ApprovalRecord {
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
    canonical_args_hmac: "private",
    redacted_summary: "执行已脱敏操作",
    risk_level: "bash",
    status: "pending",
    approved_by: null,
    approved_at: null,
    expires_at: "2026-09-01T10:00:00Z",
    decision_revision: 1,
    consumed: false,
    created_at: "2026-09-01T09:00:00Z",
    updated_at: "2026-09-01T09:00:00Z",
  };
}

const client = {} as AgentApiClient;
let onEvent: ((message: { id: string; event: { type: string }; eventName?: string; reconciliation?: PiSseReconciliation }) => void) | undefined;

afterEach(() => vi.clearAllMocks());

beforeEach(() => {
  onEvent = undefined;
  mocks.getConversationRuntimeState.mockResolvedValue({ conversation_id: "conversation-1", state: "active", prompting: true });
  mocks.getEntries.mockResolvedValue([]);
  mocks.listApprovals.mockResolvedValue([approval()]);
  mocks.subscribePiEvents.mockImplementation((_client, _id, next, _error, _after, options) => {
    onEvent = next;
    options?.onOpen?.({ reconnect: false, lastEventId: null });
    return { close: vi.fn(), ready: Promise.resolve() };
  });
});

describe("Timeline reconciliation consumer", () => {
  it("loads the initial entries, runtime state, and approvals without waiting for SSE", async () => {
    const durable: PiEntry = { id: "entry-before-sse", type: "message", message: { role: "assistant", content: "首屏持久回复" } };
    mocks.getEntries.mockResolvedValue([durable]);
    mocks.subscribePiEvents.mockImplementation((_client, _id, _next) => ({ close: vi.fn(), ready: new Promise<void>(() => undefined) }));
    render(<TimelineView client={client} conversationId="conversation-1" />);

    expect(await screen.findByText("首屏持久回复")).toBeInTheDocument();
    expect(mocks.getEntries).toHaveBeenCalledWith(client, "conversation-1");
    expect(mocks.getConversationRuntimeState).toHaveBeenCalledWith(client, "conversation-1");
    expect(mocks.listApprovals).toHaveBeenCalledWith(client, "conversation-1");
  });

  it("hydrates approvals after opening and merges bounded entries/receipts/state", async () => {
    const reconciliation: PiSseReconciliation = {
      schema_version: "1",
      type: "reconciliation",
      conversation_id: "conversation-1",
      state: "paused",
      prompting: false,
      entries: [{ id: "entry-1", entry_ref: "entry-ref-1", type: "message", message: { role: "assistant", content: "持久回复" } } as PiEntry],
      receipts: [{ idempotency_key: "prompt-1", state: "unknown", last_entry_id: null, failure_code: "init_failed", failure_detail: "安全失败摘要" }],
    };
    render(<TimelineView client={client} conversationId="conversation-1" />);

    expect(await screen.findByTestId("approval-card-approval-1")).toBeInTheDocument();
    await act(async () => {
      onEvent?.({ id: "event-1", event: { type: "reconciliation" }, eventName: "reconciliation", reconciliation });
    });
    expect(await screen.findByText("持久回复")).toBeInTheDocument();
    expect(screen.getByTestId("reconciliation-receipt-prompt-1")).toHaveTextContent("结果未知");
    expect(screen.getByTestId("reconciliation-receipt-prompt-1")).toHaveTextContent("安全失败摘要");
    expect(screen.getByTestId("conversation-reconciliation-state")).toHaveAttribute("data-reconciliation-state", "paused");
    await waitFor(() => expect(mocks.listApprovals.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});
