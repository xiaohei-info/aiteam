import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiEntry, PiEvent } from "@aiteam/shared/contracts";
import type { AgentApiClient } from "../../lib/api-client";
import { getEntries, subscribePiEvents } from "./useChatApi";
import {
  boundedJson,
  classifyPiRecord,
  classifyPiRecords,
  mergeTimeline,
  TimelineView,
  upsertEvent,
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
    expect(classifyPiRecord(entry("thinking-message", "message", { message: { role: "assistant", content: [{ type: "thinking", thinking: "bounded plan" }] } }))).toMatchObject({ kind: "thinking", summary: "bounded plan" });
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

  it("splits one persisted assistant entry into a thinking card and an answer bubble", () => {
    const models = classifyPiRecords(entry("assistant", "message", {
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先分析问题" },
          { type: "text", text: "最终答案" },
        ],
      },
    }));
    expect(models.map((model) => model.kind)).toEqual(["thinking", "message"]);
    expect(models.map((model) => model.summary)).toEqual(["先分析问题", "最终答案"]);
  });

  it("classifies bounded tool, todo, memory, and RAG card details", () => {
    expect(classifyPiRecord(event("todo", "tool_execution_start", {
      toolName: "todo_update",
      args: { todos: [{ id: "t1", content: "Review bounded output", status: "pending" }] },
    }).event)).toMatchObject({
      kind: "todo",
      toolName: "todo_update",
      todoItems: [{ id: "t1", text: "Review bounded output", status: "pending" }],
    });
    expect(classifyPiRecord(entry("todo-result", "message", {
      message: {
        role: "toolResult",
        toolCallId: "call-todo",
        toolName: "todo_update",
        content: [{ type: "text", text: JSON.stringify({ items: [{ id: "t1", title: "Persisted todo", status: "completed" }] }) }],
      },
    }))).toMatchObject({
      kind: "todo",
      todoItems: [{ id: "t1", text: "Persisted todo", status: "completed" }],
    });

    expect(classifyPiRecord(event("memory", "tool_execution_start", {
      toolName: "hindsight_recall",
      args: { query: "user preference" },
    }).event)).toMatchObject({ kind: "memory", memoryOperation: "recall", memoryQuery: "user preference" });

    const rag = classifyPiRecord(event("rag", "tool_execution_end", {
      toolName: "knowledge_search",
      args: { query: "onboarding" },
      result: { content: [{ type: "text", text: JSON.stringify({ citations: [{ citation_id: "citation:1", title: "Onboarding", snippet: "bounded excerpt", score: 0.9 }] }) }] },
    }).event);
    expect(rag).toMatchObject({
      kind: "rag",
      ragOperation: "search",
      ragQuery: "onboarding",
      ragCitations: [{ citationId: "citation:1", title: "Onboarding", preview: "bounded excerpt", score: "0.9" }],
    });
  });

  it("sanitizes ordinary tool args and result summaries", () => {
    const call = classifyPiRecord(event("call", "tool_execution_start", {
      toolName: "read",
      args: { token: "leaked-token", path: "/private/workspace/file.txt", safe: "visible" },
    }).event);
    const result = classifyPiRecord(event("result", "tool_execution_end", {
      toolName: "read",
      result: { secret: "leaked-secret", output: "visible result" },
    }).event);

    expect(call.argsSummary).toContain("visible");
    expect(call.argsSummary).not.toContain("leaked-token");
    expect(call.argsSummary).not.toContain("/private/workspace");
    expect(result.resultSummary).toContain("visible result");
    expect(result.resultSummary).not.toContain("leaked-secret");
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

  it("coalesces one live thinking stream and one tool call instead of appending every delta", () => {
    let events: TimelineEventItem[] = [event("run", "agent_start")];
    events = upsertEvent(events, event("think-1", "message_update", {
      message: { role: "assistant", content: [{ type: "thinking", thinking: "用户说" }] },
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "用户说" },
    }));
    events = upsertEvent(events, event("think-2", "message_update", {
      message: { role: "assistant", content: [{ type: "thinking", thinking: "用户说 hi" }] },
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: " hi" },
    }));
    events = upsertEvent(events, event("tool-start", "tool_execution_start", { toolCallId: "call-1", toolName: "read" }));
    events = upsertEvent(events, event("tool-end", "tool_execution_end", { toolCallId: "call-1", toolName: "read", result: "done" }));

    expect(events).toHaveLength(3);
    expect(classifyPiRecord(events[1]!.event)).toMatchObject({ kind: "thinking", summary: "用户说 hi" });
    expect(classifyPiRecord(events[2]!.event)).toMatchObject({ kind: "tool-result", resultSummary: "done" });

    events = upsertEvent(events, event("message-end", "message_end", {
      message: { role: "assistant", content: [{ type: "thinking", thinking: "用户说 hi" }, { type: "text", text: "你好" }] },
    }));
    expect(events.some((item) => item.event.type === "message_update")).toBe(false);
    expect(classifyPiRecords(events.at(-1)!.event).map((model) => model.kind)).toEqual(["thinking", "message"]);
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
    expect(screen.getByText("hello").closest('[data-timeline-event-card="true"]')).toBeNull();
    expect(screen.queryByText(/类型：/)).not.toBeInTheDocument();
    expect(screen.queryByText(/状态：/)).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "工具调用事件" })).toHaveTextContent("read");
    expect(screen.getByRole("article", { name: "需要审批事件" })).toHaveTextContent("write");
    expect(screen.getByRole("alert", { name: "错误事件" })).toHaveTextContent("failed");
    expect(screen.getByRole("article", { name: "已完成事件" })).toHaveTextContent("执行已完成");
    expect(screen.queryByText("do-not-render")).not.toBeInTheDocument();
    expect(screen.queryByText("/private/file")).not.toBeInTheDocument();
    expect(screen.getByTestId("conversation-events")).toHaveAttribute("aria-label", "对话事件流");
  });

  it("renders structured activity cards and delegation source labels", async () => {
    mockedGetEntries.mockResolvedValue([
      entry("todo", "todo_update", { todos: [{ id: "t1", title: "Review output", status: "pending" }] }),
      entry("memory", "hindsight_retain", { content: "remember this bounded note" }),
      entry("rag", "knowledge_get", {
        citation_id: "citation:1",
        result: { citation: { citation_id: "citation:1", title: "Guide", text: "bounded citation preview" } },
      }),
      entry("child", "tool_execution_start", {
        toolName: "delegate_employee",
        args: { employee_id: "employee-child", task: "review" },
        source_employee_id: "employee-child",
        source_employee_display_name: "研究专家",
        source_role: "child",
      }),
    ]);

    render(<TimelineView client={client} conversationId="group-1" />);

    expect(await screen.findByRole("article", { name: "待办更新事件" })).toHaveTextContent("Review output");
    expect(screen.getByRole("article", { name: "待办更新事件" })).toHaveAttribute("data-kind", "todo");
    expect(screen.getByRole("article", { name: "记忆活动事件" })).toHaveTextContent("remember this bounded note");
    expect(screen.getByRole("article", { name: "知识活动事件" })).toHaveTextContent("bounded citation preview");
    expect(screen.getByRole("article", { name: "工具调用事件" })).toHaveTextContent("来源专家：研究专家（子专家）");
    expect(screen.getByRole("article", { name: "知识活动事件" })).toHaveTextContent("citation:1");
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
