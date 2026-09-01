import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@aiteam/shared/api-client";
import { MessageComposer } from "./MessageComposer";
import { abortPrompt, deleteAttachment, submitPrompt, uploadAttachment } from "./useChatApi";

vi.mock("../../lib/app-context", () => ({
  useApp: () => ({ client: {} }),
  useApiError: () => (error: unknown) => error instanceof Error ? error.message : "请求失败",
}));
vi.mock("./useChatApi", () => ({
  abortPrompt: vi.fn().mockResolvedValue(true),
  attachmentMimeType: vi.fn((file: { type: string }) => file.type),
  deleteAttachment: vi.fn().mockResolvedValue(undefined),
  isSupportedAttachmentMime: vi.fn((mime: string) => mime.startsWith("text/")),
  makeIdempotencyKey: () => "key",
  submitPrompt: vi.fn(),
  uploadAttachment: vi.fn().mockResolvedValue({ id: "uploaded", kind: "attachment", filename: "notes.txt", mime_type: "text/plain", conversation_id: "c1", tenant_id: "t1", member_id: "m1", byte_size: 1, sha256: "hash", created_at: "2026-01-01T00:00:00Z", referenced_at: null }),
}));
vi.mock("../group/useGroupApi", () => ({ listLoadedExperts: vi.fn(() => new Promise(() => undefined)) }));
vi.mock("./VoiceInputButton", () => ({
  VoiceInputButton: ({ onText }: { onText: (text: string) => void }) => (
    <button type="button" aria-label="测试语音输入" onClick={() => onText("语音文本")}>测试语音输入</button>
  ),
}));

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
  it("把语音转写文本追加到当前输入", () => {
    render(<MessageComposer conversationId="c1" isPrompting={false} onPromptingChange={vi.fn()} onSent={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "测试语音输入" }));

    expect(screen.getByLabelText("消息内容")).toHaveTextContent("语音文本");
  });

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

  it("accepts supported files, rejects unsupported files, and sends uploaded ids", async () => {
    const { container } = render(<MessageComposer conversationId="c1" isPrompting={false} onPromptingChange={vi.fn()} onSent={vi.fn()} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const good = new File(["hello"], "notes.txt", { type: "text/plain" });
    const bad = new File(["binary"], "program.bin", { type: "application/octet-stream" });
    fireEvent.change(input, { target: { files: [good, bad] } });
    expect(await screen.findByText("仅支持受支持的本地文件，单个文件不超过 5 MiB")).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledWith(
      {}, "c1", { text: "\n\n[附件: notes.txt]", attachment_ids: ["uploaded"] }, "key",
    ));
  });

  it("reuses pending uploads after an unknown idempotency response", async () => {
    (submitPrompt as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new ApiError("unknown", 409, "idempotency_unknown"))
      .mockResolvedValueOnce({ accepted: true });
    const view = render(<MessageComposer conversationId="c1" isPrompting={false} onPromptingChange={vi.fn()} onSent={vi.fn()} />);
    const input = screen.getByLabelText("消息内容");
    fireEvent.input(input, { target: { textContent: "retry me" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText(/执行状态未知/);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledTimes(2));
  });

  it("cleans an uploaded file when the conversation changes before prompt dispatch", async () => {
    let resolveUpload: ((value: unknown) => void) | undefined;
    const upload = uploadAttachment as unknown as ReturnType<typeof vi.fn>;
    upload.mockReturnValueOnce(new Promise((resolve) => { resolveUpload = resolve; }));
    const view = render(<MessageComposer conversationId="c1" isPrompting={false} onPromptingChange={vi.fn()} onSent={vi.fn()} />);
    const fileInput = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(["x"], "notes.txt", { type: "text/plain" })] } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(upload).toHaveBeenCalled());
    view.rerender(<MessageComposer conversationId="c2" isPrompting={false} onPromptingChange={vi.fn()} onSent={vi.fn()} />);
    resolveUpload?.({ id: "uploaded" });
    await waitFor(() => expect(deleteAttachment).toHaveBeenCalledWith({}, "c1", "uploaded"));
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("ignores an upload failure after a conversation change", async () => {
    const upload = uploadAttachment as unknown as ReturnType<typeof vi.fn>;
    let rejectUpload: ((cause: unknown) => void) | undefined;
    upload.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectUpload = reject; }));
    const view = render(<MessageComposer conversationId="c1" isPrompting={false} onPromptingChange={vi.fn()} onSent={vi.fn()} />);
    const fileInput = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(["x"], "notes.txt", { type: "text/plain" })] } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(upload).toHaveBeenCalled());
    view.rerender(<MessageComposer conversationId="c2" isPrompting={false} onPromptingChange={vi.fn()} onSent={vi.fn()} />);
    rejectUpload?.(new Error("upload failed"));
    await waitFor(() => expect(screen.getByLabelText("消息内容")).not.toHaveTextContent("upload failed"));
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("ignores a stale submission after switching conversations", async () => {
    let resolveSubmit: ((value: unknown) => void) | undefined;
    (submitPrompt as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise((resolve) => { resolveSubmit = resolve; }));
    const onSent = vi.fn();
    const onPromptingChange = vi.fn();
    const view = render(<MessageComposer conversationId="c1" isPrompting={false} onPromptingChange={onPromptingChange} onSent={onSent} />);
    const input = screen.getByLabelText("消息内容");
    fireEvent.input(input, { target: { textContent: "old prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submitPrompt).toHaveBeenCalled());

    view.rerender(<MessageComposer conversationId="c2" isPrompting={false} onPromptingChange={onPromptingChange} onSent={onSent} />);
    resolveSubmit?.({ accepted: true });
    await waitFor(() => expect(screen.getByLabelText("消息内容")).not.toHaveTextContent("old prompt"));
    expect(onSent).not.toHaveBeenCalled();
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
