import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "@aiteam/shared";
import { SessionContext, type SessionContextValue } from "../../auth/session";
import { ChangePasswordDialog, policyHint } from "../ChangePasswordDialog";

const post = vi.fn();
vi.mock("../../api/client", () => ({ createManagerApiClient: () => ({ post }) }));

const policy = { min_length: 8, require_upper: true, require_lower: true, require_digit: true, require_symbol: true, max_age_days: 90 };
const session: SessionContextValue = { session: null, token: "t", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {} };

function open(onClose = () => {}) {
  render(<SessionContext.Provider value={session}><ChangePasswordDialog policy={policy} onClose={onClose} /></SessionContext.Provider>);
}
function fill(old: string, next: string, again: string) {
  fireEvent.change(screen.getByLabelText(/当前密码/), { target: { value: old } });
  fireEvent.change(screen.getByLabelText(/^新密码/), { target: { value: next } });
  fireEvent.change(screen.getByLabelText(/确认新密码/), { target: { value: again } });
}

describe("ChangePasswordDialog", () => {
  beforeEach(() => post.mockReset());

  it("密码框带密码管理器识别用的 autocomplete", () => {
    open();
    expect(screen.getByLabelText(/当前密码/)).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByLabelText(/^新密码/)).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByLabelText(/确认新密码/)).toHaveAttribute("autocomplete", "new-password");
  });

  it("回车提交；未填完整或两次不一致时回车不提交", async () => {
    post.mockResolvedValue({ changed: true });
    open();
    fill("Old-1aaa!", "New-1aaa!", "other");
    fireEvent.keyDown(screen.getByLabelText(/确认新密码/), { key: "Enter" });
    expect(post).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/确认新密码/), { target: { value: "New-1aaa!" } });
    fireEvent.keyDown(screen.getByLabelText(/确认新密码/), { key: "Enter" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  });

  it("提示密码策略", () => {
    expect(policyHint(policy)).toBe("至少 8 位、大写字母、小写字母、数字、符号");
  });

  it("两次输入不一致时不能提交", () => {
    open();
    fill("Old-1aaa!", "New-1aaa!", "other");
    expect(screen.getByRole("button", { name: "确认" })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });

  it("成功后提示其它设备失效", async () => {
    post.mockResolvedValue({ changed: true });
    open();
    fill("Old-1aaa!", "New-1aaa!", "New-1aaa!");
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(screen.getByText("新密码已生效")).toBeInTheDocument());
    expect(post).toHaveBeenCalledWith("/api/auth/password", { body: { old_password: "Old-1aaa!", new_password: "New-1aaa!" } });
  });

  it("旧密码错误与次数过多给出明确提示", async () => {
    post.mockRejectedValueOnce(new ApiError("x", 422, "old_password_incorrect"));
    open();
    fill("bad", "New-1aaa!", "New-1aaa!");
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(screen.getByText("当前密码不正确")).toBeInTheDocument());
  });

  it("429 提示稍后再试", async () => {
    post.mockRejectedValueOnce(new ApiError("x", 429, "too_many_attempts"));
    open();
    fill("bad", "New-1aaa!", "New-1aaa!");
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(screen.getByText(/15 分钟/)).toBeInTheDocument());
  });
});
