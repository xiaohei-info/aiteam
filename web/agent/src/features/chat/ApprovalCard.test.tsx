import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@aiteam/shared/api-client";
import type { AgentApiClient } from "../../lib/api-client";
import { ApprovalCard } from "./ApprovalCard";
import type { ApprovalRecord } from "./useChatApi";

const mocks = vi.hoisted(() => ({
  decideApproval: vi.fn(),
  makeIdempotencyKey: vi.fn(() => "decision-key"),
}));

vi.mock("./useChatApi", () => ({
  decideApproval: mocks.decideApproval,
  makeIdempotencyKey: mocks.makeIdempotencyKey,
}));

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
    canonical_args_hmac: "private-hmac",
    redacted_summary: "执行已脱敏的本地命令",
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

const client = {} as AgentApiClient;

afterEach(() => vi.clearAllMocks());

describe("ApprovalCard", () => {
  it("submits one CAS/idempotent decision and renders the returned status", async () => {
    const updated = approval({ status: "approved", approved_by: "member-1", decision_revision: 5 });
    mocks.decideApproval.mockResolvedValue(updated);
    const onUpdated = vi.fn();
    render(<ApprovalCard client={client} approval={approval()} onUpdated={onUpdated} />);

    expect(screen.getByTestId("approval-redacted-summary")).toHaveTextContent("执行已脱敏的本地命令");
    expect(screen.queryByText("private-hmac")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "批准" }));
    await waitFor(() => expect(mocks.decideApproval).toHaveBeenCalledWith(client, "conversation-1", "approval-1", "approve", 4, "decision-key"));
    expect(onUpdated).toHaveBeenCalledWith(updated);
  });

  it("uses owner-safe conflict/expiry errors and refreshes the list", async () => {
    mocks.decideApproval.mockRejectedValue(new ApiError("raw approval id", 409, "approval_conflict"));
    const refresh = vi.fn();
    render(<ApprovalCard client={client} approval={approval()} onUpdated={vi.fn()} onRefresh={refresh} />);

    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("审批状态已变化，正在刷新最新状态");
    expect(screen.queryByText("raw approval id")).not.toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
