import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageComposer } from "./MessageComposer";
import { abortPrompt, submitPrompt } from "./useChatApi";

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

function placeCaretAtEnd(element: HTMLElement): void {
  const selection = window.getSelection();
  const range = document.createRange();
  const textNode = element.firstChild ?? document.createTextNode("");
  if (!textNode.parentNode) element.appendChild(textNode);
  range.setStart(textNode, textNode.textContent?.length ?? 0);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe("MessageComposer runtime state", () => {
  it("submits solution-scoped group mentions through the shared composer", async () => {
    const onSent = vi.fn();
    const inputRoster = [{ employee_id: "e1", tenant_id: "t1", version: "v1", handle: "alice", display_name: "Alice", revoked: false }];
    render(
      <MessageComposer
        conversationId="group-1"
        isPrompting={false}
        onPromptingChange={vi.fn()}
        onSent={onSent}
        mentionRoster={inputRoster}
      />,
    );

    const input = screen.getByLabelText("消息内容");
    fireEvent.input(input, { target: { textContent: "@alice 请分析" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(submitPrompt).toHaveBeenCalledWith(
      {},
      "group-1",
      { text: "@alice 请分析", attachment_ids: [], mentions: ["alice"] },
      "key",
    ));
    expect(onSent).toHaveBeenCalled();
  });

  it("opens the authorized group roster when @ is typed", async () => {
    const inputRoster = [{ employee_id: "e1", tenant_id: "t1", version: "v1", handle: "tester", display_name: "测试员", revoked: false }];
    render(
      <MessageComposer
        conversationId="group-1"
        isPrompting={false}
        onPromptingChange={vi.fn()}
        onSent={vi.fn()}
        mentionRoster={inputRoster}
      />,
    );

    const input = screen.getByLabelText("消息内容");
    input.focus();
    input.textContent = "@";
    placeCaretAtEnd(input);
    fireEvent.input(input);

    expect(await screen.findByRole("listbox", { name: "可 @ 的群成员" })).toBeInTheDocument();
    expect(screen.getByRole("option")).toHaveTextContent("测试员");
    expect(screen.getByRole("option")).not.toHaveTextContent("tester");
  });

  it("selects a group mention with Enter without submitting and renders the display name", async () => {
    const inputRoster = [{ employee_id: "e1", tenant_id: "t1", version: "v1", handle: "tester", display_name: "测试员", revoked: false }];
    render(
      <MessageComposer
        conversationId="group-1"
        isPrompting={false}
        onPromptingChange={vi.fn()}
        onSent={vi.fn()}
        mentionRoster={inputRoster}
      />,
    );

    const input = screen.getByLabelText("消息内容");
    input.focus();
    input.textContent = "@";
    placeCaretAtEnd(input);
    fireEvent.input(input);
    expect(await screen.findByRole("listbox", { name: "可 @ 的群成员" })).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(submitPrompt).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox", { name: "可 @ 的群成员" })).not.toBeInTheDocument();
    expect(input).toHaveTextContent("@测试员");
    expect(screen.getByText("已 @提及：@测试员")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledWith(
      {},
      "group-1",
      { text: "@测试员", attachment_ids: [], mentions: ["tester"] },
      "key",
    ));
  });

  it("canonicalizes manually typed display names before submitting group mentions", async () => {
    const inputRoster = [{ employee_id: "e1", tenant_id: "t1", version: "v1", handle: "tester", display_name: "测试员", revoked: false }];
    render(
      <MessageComposer
        conversationId="group-1"
        isPrompting={false}
        onPromptingChange={vi.fn()}
        onSent={vi.fn()}
        mentionRoster={inputRoster}
      />,
    );

    const input = screen.getByLabelText("消息内容");
    input.focus();
    input.textContent = "@测试员 请分析";
    placeCaretAtEnd(input);
    fireEvent.input(input);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(submitPrompt).toHaveBeenCalledWith(
      {},
      "group-1",
      { text: "@测试员 请分析", attachment_ids: [], mentions: ["tester"] },
      "key",
    ));
  });

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
