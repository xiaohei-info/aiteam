import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@aiteam/shared/api-client";
import type { AgentApiClient } from "../../lib/api-client";
import { ApprovalCard, approvalErrorMessage } from "./ApprovalCard";
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

  it("renders non-actionable uncertain approvals with sanitized summaries", () => {
    render(
      <ApprovalCard
        client={client}
        approval={approval({
          status: "uncertain",
          consumed: true,
          expires_at: "not-a-date",
          redacted_summary: "token=unsafe-token path=/private/workspace/secret.txt",
        })}
        onUpdated={vi.fn()}
      />,
    );

    expect(screen.getByTestId("approval-status")).toHaveTextContent("结果未知");
    expect(screen.getByText("执行结果未知")).toBeInTheDocument();
    expect(screen.getByTestId("approval-redacted-summary")).toHaveTextContent("[已隐藏] path=[路径已隐藏]");
    expect(screen.getByText("有效期至：未知")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "批准" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拒绝" })).not.toBeInTheDocument();
  });

  it.each([
    [new ApiError("hidden", 404, "approval_not_found"), "审批已不存在或当前账号无权查看"],
    [new ApiError("hidden", 404, "other"), "审批已不存在或当前账号无权查看"],
    [new ApiError("hidden", 400, "approval_expired"), "审批已过期，请重新发起操作"],
    [new ApiError("hidden", 409, "approval_conflict"), "审批状态已变化，正在刷新最新状态"],
    [new ApiError("hidden", 401, "unauthorized"), "登录状态已失效，请重新登录"],
    [new ApiError("hidden", 403, "forbidden"), "当前账号无权决定此审批"],
    [new ApiError("safe detail", 500, "server_error"), "safe detail"],
    [new Error("local failure"), "local failure"],
    [{}, "审批操作失败，请稍后查看本地状态"],
  ])("maps owner-safe decision errors (%s)", (cause, expected) => {
    expect(approvalErrorMessage(cause)).toBe(expected);
  });

  it("keeps the decision error when a conflict refresh also fails", async () => {
    mocks.decideApproval.mockRejectedValue(new ApiError("raw approval id", 409, "approval_conflict"));
    const refresh = vi.fn().mockRejectedValue(new Error("refresh unavailable"));
    render(<ApprovalCard client={client} approval={approval()} onUpdated={vi.fn()} onRefresh={refresh} />);

    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("审批状态已变化，正在刷新最新状态");
    expect(refresh).toHaveBeenCalledTimes(1);
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
