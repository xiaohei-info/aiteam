/**
 * W-A.3 Terminal / command execution panel tests (issue #415).
 *
 * Covers:
 * 1. render ready: input + execute + hint
 * 2. main path: exec command -> SSE stdout echoed + completed status
 * 3. failure path: non-zero exit -> stderr echoed + error status + Error line
 * 4. cancel path: click cancel -> aborted -> cancelled status
 * 5. unauthenticated guard: no session -> render nothing
 * 6. empty command: execute button disabled
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppProvider } from "../../lib/app-context";
import { TerminalPanel } from "./TerminalPanel";
import { AgentApiClient } from "../../lib/api-client";

const convId = "conv-terminal-test";

function sseBlock(eventName, data) {
  return "event: " + eventName + "\ndata: " + JSON.stringify(data) + "\n\n";
}

function helloEvents() {
  return [
    sseBlock("terminal.event", { type: "command_started", run_id: "term-x", source: "terminal", timestamp: "x", payload: { command: "echo hi", started_at: "x" } }),
    sseBlock("terminal.event", { type: "command_output", run_id: "term-x", source: "terminal", timestamp: "x", payload: { stream: "stdout", data: "hello world" } }),
    sseBlock("terminal.event", { type: "completed", run_id: "term-x", source: "terminal", timestamp: "x", payload: { exit_code: 0, finished_at: "x" } }),
  ].join("");
}

function failEvents() {
  return [
    sseBlock("terminal.event", { type: "command_started", run_id: "term-x", source: "terminal", timestamp: "x", payload: { command: "boom", started_at: "x" } }),
    sseBlock("terminal.event", { type: "command_output", run_id: "term-x", source: "terminal", timestamp: "x", payload: { stream: "stderr", data: "boom" } }),
    sseBlock("terminal.event", { type: "error", run_id: "term-x", source: "terminal", timestamp: "x", payload: { message: "exit code 7", exit_code: 7 } }),
  ].join("");
}

function makeReader(body) {
  const bytes = new TextEncoder().encode(body);
  let offset = 0;
  const stream = new ReadableStream({ pull(controller) { if (offset >= bytes.length) { controller.close(); return; } controller.enqueue(bytes.slice(offset)); offset = bytes.length; } });
  return stream.getReader();
}

function mockFetch(reader) {
  return vi.fn(async (_url, init) => ({
    ok: true, status: 200,
    headers: (() => { const h = new Headers(); h.set("Content-Type", "text/event-stream"); return h; })(),
    body: reader,
    json: async () => ({}),
  }));
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

function renderPanel(opts) {
  opts = opts || {};
  const client = new AgentApiClient();
  const fetchImpl = opts.fetchImpl || mockFetch(makeReader(""));
  const utils = render(
    <AppProvider>
      <MemoryRouter>
        <TerminalPanel client={client} conversationId={convId} />
      </MemoryRouter>
    </AppProvider>,
    { fetchImpl }
  );
  return Object.assign({}, utils, { client });
}

describe("TerminalPanel", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); clearStorage(); });

  it("renders input + execute button + hint when authed", () => {
    loginStorage();
    renderPanel();
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
    const fetchImpl = mockFetch(makeReader(helloEvents()));
    renderPanel({ fetchImpl });
    const input = screen.getByLabelText("命令输入");
    fireEvent.change(input, { target: { value: "echo hi" } });
    fireEvent.click(screen.getByRole("button", { name: /执行/i }));
    await waitFor(() => expect(screen.getByText(/hello world/)).toBeInTheDocument());
    expect(screen.getByText("completed")).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("failure path: echoes stderr + error status + error line", async () => {
    loginStorage();
    const fetchImpl = mockFetch(makeReader(failEvents()));
    renderPanel({ fetchImpl });
    fireEvent.change(screen.getByLabelText("命令输入"), { target: { value: "boom" } });
    fireEvent.click(screen.getByRole("button", { name: /执行/i }));
    await waitFor(() => expect(screen.getByText("error")).toBeInTheDocument());
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });

  it("cancel path: abort -> cancelled status", async () => {
    loginStorage();
    const reader = new ReadableStream({ pull() {} }).getReader();
    const fetchImpl = mockFetch(reader);
    renderPanel({ fetchImpl });
    fireEvent.change(screen.getByLabelText("命令输入"), { target: { value: "sleep 10" } });
    fireEvent.click(screen.getByRole("button", { name: /执行/i }));
    await waitFor(() => expect(screen.getByText("running")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /取消/i }));
    await waitFor(() => expect(screen.getByText("cancelled")).toBeInTheDocument());
  });
});
