import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiEntry } from "@aiteam/shared/contracts";
import { ApiError } from "@aiteam/shared/api-client";
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

  it("loads a search entry page and marks the newest readable entry", async () => {
    const durable: PiEntry = {
      id: "entry-search",
      entry_ref: "entry-ref-search",
      type: "message",
      message: { role: "assistant", content: "搜索命中的回复" },
    };
    mocks.getEntries.mockResolvedValue([durable]);
    const onReadEntry = vi.fn();
    render(
      <TimelineView
        client={client}
        conversationId="conversation-1"
        initialEntryRef="entry-ref-search"
        onReadEntry={onReadEntry}
      />,
    );

    expect(await screen.findByText("搜索命中的回复")).toBeInTheDocument();
    expect(mocks.getEntries).toHaveBeenCalledWith(client, "conversation-1", "entry-ref-search");
    await waitFor(() => expect(onReadEntry).toHaveBeenCalledWith("entry-ref-search"));
  });

  it("keeps history usable when a pre-approval route returns an ordinary 404", async () => {
    mocks.listApprovals.mockRejectedValue(new ApiError("legacy route", 404, "not_found"));
    render(<TimelineView client={client} conversationId="conversation-1" />);

    await waitFor(() => expect(screen.getByText("暂无事件")).toBeInTheDocument());
    expect(screen.queryByTestId("approval-list-error")).not.toBeInTheDocument();
  });

  it("shows an owner-safe approval error for a contracted approval_not_found response", async () => {
    mocks.listApprovals.mockRejectedValue(new ApiError("hidden approval", 404, "approval_not_found"));
    render(<TimelineView client={client} conversationId="conversation-1" />);

    expect(await screen.findByTestId("approval-list-error")).toHaveTextContent("审批已不存在或当前账号无权查看");
    expect(screen.queryByText("hidden approval")).not.toBeInTheDocument();
  });

  it("reloads durable entries after a terminal event and rejects invalid reconciliation payloads", async () => {
    const durable: PiEntry = {
      id: "entry-after-terminal",
      type: "message",
      message: { role: "assistant", content: "终态持久回复" },
    };
    mocks.getEntries.mockResolvedValueOnce([]).mockResolvedValueOnce([durable]);
    render(<TimelineView client={client} conversationId="conversation-1" />);
    await screen.findByTestId("approval-card-approval-1");

    await act(async () => {
      onEvent?.({ id: "terminal", event: { type: "agent_settled" } });
    });
    expect(await screen.findByText("终态持久回复")).toBeInTheDocument();
    expect(mocks.getEntries).toHaveBeenCalledTimes(2);

    await act(async () => {
      onEvent?.({ id: "bad-reconciliation", event: { type: "reconciliation" }, eventName: "reconciliation" });
    });
    expect(screen.getByText("实时事件流离线：事件流对账消息无效")).toBeInTheDocument();
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
