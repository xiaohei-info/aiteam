import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiEntry, PiEvent } from "@aiteam/shared/contracts";
import type { AgentApiClient } from "../../lib/api-client";
import { getEntries, subscribePiEvents } from "./useChatApi";
import {
  boundedJson,
  classifyPiRecord,
  mergeTimeline,
  TimelineView,
  type TimelineEventItem,
} from "./TimelineView";

vi.mock("./useChatApi", () => ({
  getEntries: vi.fn(),
  subscribePiEvents: vi.fn(),
}));

const mockedGetEntries = vi.mocked(getEntries);
const mockedSubscribe = vi.mocked(subscribePiEvents);

const client = { baseUrl: "http://agent.test" } as unknown as AgentApiClient;
let onEvent: ((item: TimelineEventItem) => void) | undefined;
let onError: ((cause: unknown) => void) | undefined;

function entry(id: string, type: string, extra: Record<string, unknown> = {}): PiEntry {
  return { id, type, ...extra };
}

function event(id: string, type: string, extra: Record<string, unknown> = {}): TimelineEventItem {
  return { id, event: { type, ...extra } };
}

beforeEach(() => {
  onEvent = undefined;
  onError = undefined;
  mockedGetEntries.mockReset();
  mockedSubscribe.mockReset();
  mockedSubscribe.mockImplementation((_client, _conversationId, next, error) => {
    onEvent = next;
    onError = error;
    return { close: vi.fn() };
  });
});

afterEach(() => vi.restoreAllMocks());

describe("TimelineView Pi cards", () => {
  it("classifies common entries and events without runtime-specific fields", () => {
    expect(classifyPiRecord(entry("u", "message", { message: { role: "user", content: "hi" } }))).toMatchObject({ kind: "message", sender: "user", status: "recorded" });
    expect(classifyPiRecord(event("thinking", "thinking", { text: "plan" }).event)).toMatchObject({ kind: "thinking", status: "received" });
    expect(classifyPiRecord(event("call", "tool_call", { name: "read", input: { content: "not shown" } }).event)).toMatchObject({ kind: "tool-call", summary: "工具调用：read", status: "pending" });
    expect(classifyPiRecord(event("result", "tool_result", { name: "read", status: "completed" }).event)).toMatchObject({ kind: "tool-result", status: "completed" });
    expect(classifyPiRecord(event("approval", "approval_required", { toolName: "write" }).event)).toMatchObject({ kind: "approval", summary: "等待批准：write", status: "pending" });
    expect(classifyPiRecord(event("error", "error", { message: "failed" }).event)).toMatchObject({ kind: "error", status: "error" });
    expect(classifyPiRecord(event("done", "settled").event)).toMatchObject({ kind: "settled", status: "settled" });
    expect(classifyPiRecord(event("stop", "aborted").event)).toMatchObject({ kind: "aborted", status: "aborted" });
    expect(classifyPiRecord(event("agent-stop", "agent_aborted").event)).toMatchObject({ kind: "aborted", status: "aborted" });
    expect(classifyPiRecord(event("compact", "compaction_end").event)).toMatchObject({ kind: "compaction", status: "completed" });
    expect(classifyPiRecord(event("wait", "waiting_reply").event)).toMatchObject({ kind: "waiting", status: "waiting" });
    expect(classifyPiRecord(event("stream", "streaming").event)).toMatchObject({ kind: "streaming", status: "streaming" });
    expect(classifyPiRecord(entry("tool-message", "message", { message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] } }))).toMatchObject({ kind: "tool-call", summary: "工具调用：read" });
    expect(classifyPiRecord(entry("tool-result-message", "message", { message: { role: "toolResult", content: "done" } }))).toMatchObject({ kind: "tool-result" });
  });

  it("keeps unknown output bounded and removes sensitive fields", () => {
    const summary = classifyPiRecord({
      type: "new_runtime_event",
      token: "leaked-token",
      api_key: "leaked-key",
      path: "/private/workspace/file.txt",
      nested: { secret: "leaked-secret", value: "safe" },
      body: "x".repeat(5_000),
    }).summary;

    expect(summary).toContain("new_runtime_event");
    expect(summary).toContain("safe");
    expect(summary).not.toContain("leaked-token");
    expect(summary).not.toContain("leaked-key");
    expect(summary).not.toContain("/private/workspace");
    expect(summary).not.toContain("leaked-secret");
    expect(summary.length).toBeLessThanOrEqual(1_200);
  });

  it("does not throw for cyclic unknown payloads", () => {
    const payload: Record<string, unknown> = { type: "unknown" };
    payload.self = payload;
    expect(() => boundedJson(payload)).not.toThrow();
    expect(boundedJson(payload)).toContain("[已省略]");
  });

  it("keeps persisted order and removes duplicate SSE identities", () => {
    const merged = mergeTimeline(
      [entry("e1", "message"), entry("e2", "message")],
      [event("e2", "message_update"), event("7", "tool_call", { name: "read" }), event("7", "tool_call", { name: "read" }), event("8", "tool_result")],
    );

    expect(merged.map((item) => item.kind === "entry" ? item.entry.id : item.item.id)).toEqual(["e1", "e2", "7", "8"]);
  });

  it("renders accessible cards, error alerts, and safe tool summaries", async () => {
    mockedGetEntries.mockResolvedValue([
      entry("u", "message", { message: { role: "user", content: "hello" } }),
      entry("thinking", "thinking", { content: "checking" }),
      entry("tool", "tool_call", { name: "read", input: { token: "do-not-render", path: "/private/file" } }),
      entry("approval", "approval_required", { toolName: "write", input: { secret: "do-not-render" } }),
      entry("error", "error", { message: "failed" }),
      entry("done", "settled"),
      entry("unknown", "future_event", { token: "do-not-render", path: "/private/file" }),
    ]);

    render(<TimelineView client={client} conversationId="c1" />);

    expect(await screen.findByText("hello")).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "消息事件" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "工具调用事件" })).toHaveTextContent("read");
    expect(screen.getByRole("article", { name: "需要审批事件" })).toHaveTextContent("write");
    expect(screen.getByRole("alert", { name: "错误事件" })).toHaveTextContent("failed");
    expect(screen.getByRole("article", { name: "已完成事件" })).toHaveTextContent("settled");
    expect(screen.queryByText("do-not-render")).not.toBeInTheDocument();
    expect(screen.queryByText("/private/file")).not.toBeInTheDocument();
    expect(screen.getByTestId("conversation-events")).toHaveAttribute("aria-label", "对话事件流");
  });

  it("deduplicates a persisted entry when the same live id arrives and keeps newer events ordered", async () => {
    mockedGetEntries.mockResolvedValue([entry("e1", "message", { message: { role: "assistant", content: "persisted" } })]);
    render(<TimelineView client={client} conversationId="c1" />);
    expect(await screen.findByText("persisted")).toBeInTheDocument();

    await act(async () => {
      onEvent?.(event("e1", "message_update", { message: { role: "assistant", content: "duplicate" } }));
      onEvent?.(event("e3", "tool_call", { name: "read" }));
    });

    expect(screen.getAllByText("persisted")).toHaveLength(1);
    expect(screen.queryByText("duplicate")).not.toBeInTheDocument();
    expect(screen.getByText("工具调用：read")).toBeInTheDocument();
  });

  it("preserves loading and offline semantics", async () => {
    let resolveEntries!: (value: PiEntry[]) => void;
    mockedGetEntries.mockReturnValue(new Promise((resolve) => { resolveEntries = resolve; }));
    render(<TimelineView client={client} conversationId="c1" />);
    expect(screen.getByText("加载中…")).toBeInTheDocument();

    await act(async () => {
      resolveEntries([]);
    });
    expect(screen.getByText("暂无事件")).toBeInTheDocument();

    act(() => onError?.(new Error("network down")));
    expect(screen.getByRole("alert")).toHaveTextContent("实时事件流离线：network down");
  });

  it("shows a load error when the durable snapshot fails", async () => {
    mockedGetEntries.mockRejectedValue(new Error("storage unavailable"));
    render(<TimelineView client={client} conversationId="c1" />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("storage unavailable"));
  });
});
