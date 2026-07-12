/**
 * W-A.3 Terminal / command execution panel tests (issue #415).
 *
 * Covers:
 * 1. render ready: input + execute + hint
 * 2. main path: exec command -> SSE stdout echoed + completed status
 * 3. failure path: non-zero exit -> stderr echoed + error status + Error line
 * 4. cancel path: click cancel -> aborted -> cancelled status
 * 5. unauthenticated guard: no session -> render nothing
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppProvider } from "../../lib/app-context";
import { TerminalPanel } from "./TerminalPanel";
import { AgentApiClient } from "../../lib/api-client";

const convId = "conv-terminal-test";

function sseBlock(eventName: string, data: unknown): string {
  return "event: " + eventName + "\ndata: " + JSON.stringify(data) + "\n\n";
}

function helloEvents(): string {
  return [
    sseBlock("terminal.event", { type: "command_started", run_id: "term-x", source: "terminal", timestamp: "x", payload: { command: "echo hi", started_at: "x" } }),
    sseBlock("terminal.event", { type: "command_output", run_id: "term-x", source: "terminal", timestamp: "x", payload: { stream: "stdout", data: "hello world" } }),
    sseBlock("terminal.event", { type: "completed", run_id: "term-x", source: "terminal", timestamp: "x", payload: { exit_code: 0, finished_at: "x" } }),
  ].join("");
}

function failEvents(): string {
  return [
    sseBlock("terminal.event", { type: "command_started", run_id: "term-x", source: "terminal", timestamp: "x", payload: { command: "boom", started_at: "x" } }),
    sseBlock("terminal.event", { type: "command_output", run_id: "term-x", source: "terminal", timestamp: "x", payload: { stream: "stderr", data: "boom" } }),
    sseBlock("terminal.event", { type: "error", run_id: "term-x", source: "terminal", timestamp: "x", payload: { message: "exit code 7", exit_code: 7 } }),
  ].join("");
}

/**
 * 构造假 fetch：body 是发完 `body` 文本后（hang=false）关闭、或保持挂起（hang=true）
 * 的 SSE 流；接到 AbortSignal 时把流置错为 AbortError，模拟真 fetch 的取消语义。
 */
function mockFetch(body: string, opts: { hang?: boolean } = {}): typeof fetch {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const bytes = new TextEncoder().encode(body);
    let sent = false;
    let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
      pull(c) {
        if (!sent && bytes.length > 0) {
          c.enqueue(bytes);
          sent = true;
          return;
        }
        if (!opts.hang) c.close();
      },
    });
    init?.signal?.addEventListener("abort", () => {
      try {
        ctrl?.error(new DOMException("The operation was aborted.", "AbortError"));
      } catch {
        /* stream already closed */
      }
    });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "text/event-stream" }),
      body: stream,
      json: async () => ({}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function loginStorage() {
  const claims = { user_id: "u1", tenant_id: "t1", enterprise_id: null, roles: ["member"], exp: 9999999999 };
  localStorage.setItem("aiteam.agent.token", "test-tok");
  localStorage.setItem("aiteam.agent.claims", JSON.stringify(claims));
}

function clearStorage() {
  localStorage.removeItem("aiteam.agent.token");
  localStorage.removeItem("aiteam.agent.claims");
}

function renderPanel(opts: { fetchImpl?: typeof fetch } = {}) {
  const client = new AgentApiClient();
  vi.stubGlobal("fetch", opts.fetchImpl ?? mockFetch(""));
  const utils = render(
    <AppProvider>
      <MemoryRouter>
        <TerminalPanel client={client} conversationId={convId} />
      </MemoryRouter>
    </AppProvider>,
  );
  return Object.assign({}, utils, { client });
}

describe("TerminalPanel", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); clearStorage(); });

  it("renders input + execute button + hint when authed", () => {
    loginStorage();
    renderPanel();
    expect(screen.getByRole("region", { name: "本地终端" })).toBeInTheDocument();
    expect(screen.getByLabelText("命令输入")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /执行/i })).toBeInTheDocument();
    expect(screen.getByText(/输入命令/)).toBeInTheDocument();
  });

  it("renders nothing when unauthenticated", () => {
    clearStorage();
    const { container } = renderPanel();
    expect(container.innerHTML).toBe("");
  });

  it("main path: echoes stdout and shows completed", async () => {
    loginStorage();
    renderPanel({ fetchImpl: mockFetch(helloEvents()) });
    const input = screen.getByLabelText("命令输入");
    fireEvent.change(input, { target: { value: "echo hi" } });
    fireEvent.click(screen.getByRole("button", { name: /执行/i }));
    await waitFor(() => expect(screen.getByText(/hello world/)).toBeInTheDocument());
    expect(screen.getByText("completed")).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("failure path: echoes stderr + error status + error line", async () => {
    loginStorage();
    renderPanel({ fetchImpl: mockFetch(failEvents()) });
    fireEvent.change(screen.getByLabelText("命令输入"), { target: { value: "boom" } });
    fireEvent.click(screen.getByRole("button", { name: /执行/i }));
    await waitFor(() => expect(screen.getByText("error")).toBeInTheDocument());
    // "$ boom"（命令回显）与 "boom"（stderr）都在——精确断言 stderr 行。
    expect(screen.getByText("boom")).toBeInTheDocument();
    // 错误信息出现在系统行 + error 状态区两处，用 AllBy 断言至少一处。
    expect(screen.getAllByText(/exit code 7/).length).toBeGreaterThan(0);
  });

  it("cancel path: abort -> cancelled status", async () => {
    loginStorage();
    renderPanel({ fetchImpl: mockFetch("", { hang: true }) });
    fireEvent.change(screen.getByLabelText("命令输入"), { target: { value: "sleep 10" } });
    fireEvent.click(screen.getByRole("button", { name: /执行/i }));
    await waitFor(() => expect(screen.getByText("running")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /取消/i }));
    await waitFor(() => expect(screen.getByText("cancelled")).toBeInTheDocument());
  });
});
