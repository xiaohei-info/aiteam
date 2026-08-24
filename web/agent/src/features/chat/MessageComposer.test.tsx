import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageComposer } from "./MessageComposer";
import { abortPrompt } from "./useChatApi";

vi.mock("../../lib/app-context", () => ({
  useApp: () => ({ client: {} }),
  useApiError: () => (error: unknown) => error instanceof Error ? error.message : "请求失败",
}));
vi.mock("./useChatApi", () => ({
  abortPrompt: vi.fn().mockResolvedValue(true),
  deleteAttachment: vi.fn(),
  makeIdempotencyKey: () => "key",
  submitPrompt: vi.fn(),
  uploadAttachment: vi.fn(),
}));
vi.mock("../group/useGroupApi", () => ({ listLoadedExperts: vi.fn(() => new Promise(() => undefined)) }));

afterEach(() => vi.clearAllMocks());

describe("MessageComposer runtime state", () => {
  it("locks input, shows the compact running hint, and replaces send with terminate", async () => {
    const onPromptingChange = vi.fn();
    const view = render(
      <MessageComposer conversationId="c1" isPrompting onPromptingChange={onPromptingChange} onSent={vi.fn()} />,
    );

    expect(screen.getByText("执行中")).toBeInTheDocument();
    expect(screen.getByLabelText("消息内容")).toHaveAttribute("contenteditable", "false");
    expect(screen.queryByRole("button", { name: "发送" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "终止" }));
    await waitFor(() => expect(abortPrompt).toHaveBeenCalledWith({}, "c1"));
    expect(onPromptingChange).toHaveBeenCalledWith(false);

    view.rerender(
      <MessageComposer conversationId="c1" isPrompting={false} onPromptingChange={onPromptingChange} onSent={vi.fn()} />,
    );
    expect(screen.queryByText("执行中")).not.toBeInTheDocument();
    expect(screen.getByLabelText("消息内容")).toHaveAttribute("contenteditable", "true");
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
  });
});
