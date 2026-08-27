import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiEntry, PiEvent } from "@aiteam/shared/contracts";
import type { AgentApiClient } from "../../lib/api-client";
import { getConversationRuntimeState, getEntries, subscribePiEvents } from "./useChatApi";
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
  getConversationRuntimeState: vi.fn(),
  getEntries: vi.fn(),
  subscribePiEvents: vi.fn(),
}));

const mockedRuntimeState = vi.mocked(getConversationRuntimeState);
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
  mockedRuntimeState.mockReset();
  mockedRuntimeState.mockResolvedValue({ conversation_id: "c1", state: "active", prompting: false });
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
    expect(classifyPiRecord(event("thinking", "thinking", { text: "plan" }).event)).toMatchObject({ kind: "thinking", status: "completed" });
    expect(classifyPiRecord(entry("thinking-message", "message", { message: { role: "assistant", content: [{ type: "thinking", thinking: "bounded plan" }] } }))).toMatchObject({ kind: "thinking", summary: "bounded plan" });
    expect(classifyPiRecord(event("call", "tool_call", { name: "read", input: { content: "not shown" } }).event)).toMatchObject({ kind: "tool-call", summary: "工具调用", status: "pending" });
    expect(classifyPiRecord(event("result", "tool_result", { name: "read", status: "completed" }).event)).toMatchObject({ kind: "tool-result", status: "completed" });
    expect(classifyPiRecord(event("approval", "approval_required", { toolName: "write" }).event)).toMatchObject({ kind: "approval", summary: "工具调用", status: "pending" });
    expect(classifyPiRecord(event("error", "error", { message: "failed" }).event)).toMatchObject({ kind: "error", status: "error" });
    expect(classifyPiRecord(event("done", "settled").event)).toMatchObject({ kind: "settled", status: "settled" });
    expect(classifyPiRecord(event("stop", "aborted").event)).toMatchObject({ kind: "aborted", status: "aborted" });
    expect(classifyPiRecord(event("agent-stop", "agent_aborted").event)).toMatchObject({ kind: "aborted", status: "aborted" });
    expect(classifyPiRecord(event("compact", "compaction_end").event)).toMatchObject({ kind: "compaction", status: "completed" });
    expect(classifyPiRecord(event("wait", "waiting_reply").event)).toMatchObject({ kind: "waiting", status: "waiting" });
    expect(classifyPiRecord(event("stream", "streaming").event)).toMatchObject({ kind: "streaming", status: "streaming" });
    expect(classifyPiRecord(entry("tool-message", "message", { message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] } }))).toMatchObject({ kind: "tool-call", summary: "工具调用" });
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

    const liveThinking = classifyPiRecords(event("thinking", "message_update", {
      message: { role: "assistant", content: [{ type: "thinking", thinking: "累计思考" }, { type: "text", text: "不应提前显示" }] },
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "思考" },
    }).event);
    expect(liveThinking).toHaveLength(1);
    expect(liveThinking[0]).toMatchObject({ kind: "thinking", status: "streaming", summary: "累计思考" });

    const liveAnswer = classifyPiRecords(event("text", "message_update", {
      message: { role: "assistant", content: [{ type: "thinking", thinking: "不应重复" }, { type: "text", text: "实时回答" }] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "回答" },
    }).event);
    expect(liveAnswer).toHaveLength(1);
    expect(liveAnswer[0]).toMatchObject({ kind: "message", summary: "实时回答" });
  });

  it("keeps long thinking content complete in durable and live cards", () => {
    const durableThinking = "思考步骤。".repeat(900);
    expect(classifyPiRecords(entry("long-thinking", "message", {
      message: { role: "assistant", content: [{ type: "thinking", thinking: durableThinking }] },
    }))[0]?.summary).toBe(durableThinking);

    let events: TimelineEventItem[] = [];
    events = upsertEvent(events, event("thinking-1", "message_update", {
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "a".repeat(1_500) },
    }));
    events = upsertEvent(events, event("thinking-2", "message_update", {
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "b".repeat(1_500) },
    }));
    expect(classifyPiRecords(events[0]!.event)[0]?.summary).toBe("a".repeat(1_500) + "b".repeat(1_500));
  });

  it("classifies bounded tool, todo, memory, and RAG card details", () => {
    expect(classifyPiRecord(event("todo", "tool_execution_start", {
      toolName: "todo_update",
      args: { todos: [{ id: "t1", content: "Review bounded output", status: "pending" }] },
    }).event)).toMatchObject({
      kind: "todo",
      toolName: "todo_update",
      todoItems: [{ id: "t1", text: "Review bounded output", status: "waiting" }],
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

  it("keeps the bash command visible when the live result replaces its start event", () => {
    let events: TimelineEventItem[] = [];
    events = upsertEvent(events, event("bash-start", "tool_execution_start", {
      toolCallId: "bash-call",
      toolName: "bash",
      args: { command: "printf 'hello'" },
    }));
    events = upsertEvent(events, event("bash-end", "tool_execution_end", {
      toolCallId: "bash-call",
      toolName: "bash",
      result: { content: [{ type: "text", text: "hello" }] },
    }));

    expect(events).toHaveLength(1);
    expect(classifyPiRecord(events[0]!.event)).toMatchObject({
      kind: "tool-result",
      toolName: "bash",
      argsSummary: expect.stringContaining("printf 'hello'"),
      resultSummary: expect.stringContaining("hello"),
    });

    const durable = classifyPiRecords(entry("bash-message", "message", {
      message: { role: "assistant", content: [{ type: "toolCall", id: "bash-call", name: "bash", arguments: { command: "printf 'hello'" } }] },
    }));
    expect(durable[0]).toMatchObject({ kind: "tool-call", label: "命令执行", toolName: "bash", argsSummary: expect.stringContaining("printf 'hello'" ) });
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

    events = upsertEvent(events, event("agent-end", "agent_end"));
    events = upsertEvent(events, event("agent-settled", "agent_settled"));
    const lifecycle = events.filter((item) => ["agent_start", "agent_end", "agent_settled"].includes(item.event.type));
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0]!.event.type).toBe("agent_settled");
  });

  it("keeps interleaved participant event streams isolated", () => {
    let events: TimelineEventItem[] = [];
    events = upsertEvent(events, event("coord-start", "agent_start", { source_employee_id: "coordinator" }));
    events = upsertEvent(events, event("worker-start", "agent_start", { source_employee_id: "worker" }));
    events = upsertEvent(events, event("coord-thinking", "message_update", {
      source_employee_id: "coordinator",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "协调" }] },
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "协调" },
    }));
    events = upsertEvent(events, event("worker-thinking", "message_update", {
      source_employee_id: "worker",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "执行" }] },
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "执行" },
    }));
    expect(events.filter((item) => item.event.type === "message_update").map((item) => item.id)).toEqual(["coord-thinking", "worker-thinking"]);

    events = upsertEvent(events, event("coord-end", "message_end", {
      source_employee_id: "coordinator",
      message: { role: "assistant", content: [{ type: "text", text: "协调完成" }] },
    }));
    expect(events.some((item) => item.id === "worker-thinking")).toBe(true);

    events = upsertEvent(events, event("coord-agent-end", "agent_end", { source_employee_id: "coordinator" }));
    expect(events.find((item) => item.id === "coord-start")?.event.type).toBe("agent_end");
    expect(events.find((item) => item.id === "worker-start")?.event.type).toBe("agent_start");
  });

  it("deduplicates a final SSE answer against its durable entry using visible text", () => {
    const durable = entry("assistant", "message", { message: { role: "assistant", content: [{ type: "thinking", thinking: "full private reasoning" }, { type: "text", text: "唯一回答" }] } });
    const live = event("different-id", "message_end", { message: { role: "assistant", content: [{ type: "thinking", thinking: "[内容已隐藏]" }, { type: "text", text: "唯一回答" }] } });
    const merged = mergeTimeline([durable], [live]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.kind).toBe("entry");
  });

  it("deduplicates an empty live thinking placeholder against its durable message", () => {
    const durable = entry("assistant", "message", {
      source_employee_id: "employee-1",
      message: { role: "assistant", timestamp: 42, content: [{ type: "thinking", thinking: "完整思考" }, { type: "text", text: "答案" }] },
    });
    const live = event("live-thinking", "message_update", {
      source_employee_id: "employee-1",
      message: { role: "assistant", timestamp: 42, content: [{ type: "thinking", thinking: "" }] },
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    });
    expect(mergeTimeline([durable], [live])).toEqual([{ kind: "entry", entry: durable }]);
  });

  it("keeps persisted order and removes duplicate SSE identities", () => {
    const merged = mergeTimeline(
      [entry("e1", "message"), entry("e2", "message")],
      [event("e2", "message_update"), event("7", "tool_call", { name: "read" }), event("7", "tool_call", { name: "read" }), event("8", "tool_result")],
    );

    expect(merged.map((item) => item.kind === "entry" ? item.entry.id : item.item.id)).toEqual(["e1", "e2", "7", "8"]);
  });

  it("renders source employee names and StaffDeck-inspired avatars for private and group messages", async () => {
    mockedGetEntries.mockResolvedValue([
      entry("user", "message", { message: { role: "user", content: "请帮我查一下" } }),
      entry("assistant", "message", {
        source_employee_id: "employee-1",
        message: { role: "assistant", content: "已为你整理好。" },
      }),
      entry("unknown-source", "message", {
        source_employee_id: "employee-missing",
        message: { role: "assistant", content: "未知来源也应安全显示。" },
      }),
    ]);

    const { container } = render(
      <TimelineView
        client={client}
        conversationId="avatar"
        sourceExperts={[{ employee_id: "employee-1", display_name: "研究专家", avatar_url: "/avatars/research.png" }]}
      />,
    );

    expect(await screen.findByText("研究专家")).toBeInTheDocument();
    expect(screen.getAllByText("我").length).toBeGreaterThan(0);
    expect(screen.getByText("数字员工")).toBeInTheDocument();
    expect(container.querySelectorAll('[data-chat-avatar="true"]')).toHaveLength(3);
    expect(container.querySelector('[data-chat-avatar="true"] img')).toHaveAttribute("src", "/avatars/research.png");
    expect(container.textContent).not.toContain("employee-missing");
  });

  it("renders assistant Markdown while keeping user messages as text", async () => {
    mockedGetEntries.mockResolvedValue([
      entry("user", "message", { message: { role: "user", content: "普通 **文本**" } }),
      entry("assistant", "message", { message: { role: "assistant", content: "## 结果\n\n**已完成**\n\n- 第一项\n- 第二项" } }),
    ]);

    render(<TimelineView client={client} conversationId="markdown" />);

    expect(await screen.findByText("普通 **文本**")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "结果" })).toBeInTheDocument();
    expect(screen.getByText("已完成").tagName).toBe("STRONG");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("attributes delegated user messages to the coordinating employee", async () => {
    mockedGetEntries.mockResolvedValue([
      entry("human", "message", { message: { role: "user", content: "用户请求" } }),
      entry("delegated", "message", {
        source_type: "employee",
        source_id: "coordinator",
        source_display_name: "系统测试员",
        source_role: "participant",
        message: { role: "user", content: "请查看今天的股市情况" },
      }),
    ]);

    render(
      <TimelineView
        client={client}
        conversationId="delegated-source"
        sourceExperts={[{ employee_id: "coordinator", display_name: "系统测试员" }]}
      />,
    );

    expect(await screen.findByText("请查看今天的股市情况")).toBeInTheDocument();
    expect(screen.getAllByText("我")).toHaveLength(1);
    expect(screen.getByText("系统测试员")).toBeInTheDocument();
  });

  it("keeps multi-turn thinking and tool blocks in their persisted order", () => {
    const models = classifyPiRecords(entry("multi-turn", "message", {
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "思考1" },
          { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "one" } },
          { type: "thinking", thinking: "思考2" },
          { type: "toolCall", id: "tool-2", name: "read", arguments: { path: "file.txt" } },
          { type: "thinking", thinking: "思考3" },
          { type: "text", text: "最终回复" },
        ],
      },
    }));

    expect(models.map((model) => model.kind)).toEqual(["thinking", "tool-call", "thinking", "tool-call", "thinking", "message"]);
    expect(models.map((model) => model.summary)).toEqual([
      "思考1",
      "命令执行",
      "思考2",
      "工具调用",
      "思考3",
      "最终回复",
    ]);
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
    expect(screen.getByText("hello").closest("details")).toBeNull();
    const thinkingCard = screen.getByRole("article", { name: "思考事件" });
    const disclosure = thinkingCard.querySelector("details");
    expect(disclosure).not.toHaveAttribute("open");
    fireEvent.click(thinkingCard.querySelector("summary")!);
    expect(disclosure).toHaveAttribute("open");
    expect(screen.queryByText(/类型：/)).not.toBeInTheDocument();
    expect(screen.queryByText(/状态：/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("article", { name: "工具调用事件" })).toHaveLength(2);
    expect(screen.queryByText("read")).not.toBeInTheDocument();
    expect(screen.queryByText("write")).not.toBeInTheDocument();
    expect(screen.getByRole("alert", { name: "错误事件" })).toHaveTextContent("failed");
    expect(screen.queryByRole("article", { name: "已完成事件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "执行中事件" })).not.toBeInTheDocument();
    expect(screen.queryByText("do-not-render")).not.toBeInTheDocument();
    expect(screen.queryByText("/private/file")).not.toBeInTheDocument();
    expect(screen.getByTestId("conversation-events")).toHaveAttribute("aria-label", "对话事件流");
  });

  it("does not render Pi session control entries as unknown chat events", async () => {
    mockedGetEntries.mockResolvedValue([
      entry("model", "model_change", { provider: "provider", modelId: "model" }),
      entry("thinking-level", "thinking_level_change", { thinkingLevel: "off" }),
      entry("session-info", "session_info", { name: "internal" }),
      entry("user", "message", { message: { role: "user", content: "hello" } }),
    ]);

    render(<TimelineView client={client} conversationId="group-1" />);

    expect(await screen.findByText("hello")).toBeInTheDocument();
    await act(async () => {
      onEvent?.(event("live-model", "model_change", { source_employee_id: "employee-1", provider: "provider", modelId: "model" }));
    });
    expect(screen.queryByRole("article", { name: "未识别事件" })).not.toBeInTheDocument();
    expect(screen.queryByText("未识别事件")).not.toBeInTheDocument();
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
    expect(screen.getByRole("article", { name: "记忆召回事件" })).toHaveTextContent("remember this bounded note");
    expect(screen.getByRole("article", { name: "知识库事件" })).toHaveTextContent("bounded citation preview");
    expect(screen.getByRole("article", { name: "成员协作事件" })).not.toHaveTextContent("来源专家：");
    expect(screen.getByRole("article", { name: "知识库事件" })).toHaveTextContent("citation:1");
  });

  it("renders todo statuses as a visual list", async () => {
    mockedGetEntries.mockResolvedValue([
      entry("todo", "todo_update", {
        todos: [
          { id: "todo-1", title: "调研资料", status: "in_progress" },
          { id: "todo-2", title: "等待确认", status: "pending" },
          { id: "todo-3", title: "整理结论", status: "completed" },
        ],
      }),
    ]);

    render(<TimelineView client={client} conversationId="todo-statuses" />);

    const card = await screen.findByRole("article", { name: "待办更新事件" });
    expect(card.querySelectorAll('[data-timeline-todo-item="true"]')).toHaveLength(3);
    expect(card).toHaveTextContent("进行中");
    expect(card).toHaveTextContent("等待中");
    expect(card).toHaveTextContent("已完成");
    expect(card.querySelector('[data-timeline-todo-item="true"][data-status="in_progress"] [data-timeline-todo-indicator="true"]')).toHaveTextContent("⌛");
    expect(card.querySelector('[data-timeline-todo-item="true"][data-status="waiting"] [data-timeline-todo-indicator="true"]')).toHaveTextContent("◷");
    expect(card.querySelector('[data-timeline-todo-item="true"][data-status="completed"] [data-timeline-todo-indicator="true"]')).toHaveTextContent("✓");
    expect(card.querySelector('[data-timeline-todo-item="true"][data-status="completed"]')).toHaveTextContent("整理结论");
  });

  it("merges a tool result into its call card and shows the outcome without raw tool names", async () => {
    mockedGetEntries.mockResolvedValue([
      entry("call", "message", {
        message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/visible.txt" } }] },
      }),
      entry("result", "message", {
        message: { role: "toolResult", toolCallId: "call-1", toolName: "read", status: "completed", content: "读取成功" },
      }),
      entry("failed", "tool_execution_end", { toolCallId: "call-2", toolName: "bash", error: "命令失败" }),
    ]);

    render(<TimelineView client={client} conversationId="tool-outcome" />);

    const cards = await screen.findAllByRole("article", { name: /工具调用事件|命令执行事件/ });
    expect(cards).toHaveLength(2);
    const toolCard = cards.find((card) => card.getAttribute("aria-label") === "工具调用事件");
    expect(toolCard).toBeTruthy();
    expect(toolCard).toHaveTextContent("结果摘要");
    expect(toolCard).toHaveTextContent("读取成功");
    expect(toolCard).toHaveAttribute("aria-label", "工具调用事件");
    expect(toolCard?.querySelector('[data-timeline-tool-outcome="success"]')).toHaveTextContent("✓");
    expect(screen.queryByText("read")).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "命令执行事件" }).querySelector('[data-timeline-tool-outcome="failure"]')).toHaveTextContent("×");
    expect(screen.queryByText("bash")).not.toBeInTheDocument();
  });

  it("keeps an updating thought expanded, collapses it on completion, streams one answer bubble, and reports runtime state outside the timeline", async () => {
    mockedGetEntries.mockResolvedValue([]);
    const onPromptingChange = vi.fn();
    render(<TimelineView client={client} conversationId="live" onPromptingChange={onPromptingChange} />);
    await waitFor(() => expect(screen.getByText("暂无事件")).toBeInTheDocument());
    expect(onPromptingChange).toHaveBeenCalledWith(false);

    await act(async () => {
      onEvent?.(event("run", "agent_start"));
      onEvent?.(event("thinking-1", "message_update", {
        message: { role: "assistant", content: [{ type: "thinking", thinking: "第一段" }] },
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "第一段" },
      }));
      onEvent?.(event("thinking-2", "message_update", {
        message: { role: "assistant", content: [{ type: "thinking", thinking: "第一段，继续思考" }] },
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "，继续思考" },
      }));
    });

    expect(onPromptingChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("article", { name: "执行中事件" })).not.toBeInTheDocument();
    const thinking = screen.getByRole("article", { name: "思考事件" });
    expect(screen.getAllByRole("article", { name: "思考事件" })).toHaveLength(1);
    expect(thinking.querySelector("details")).toHaveAttribute("open");
    expect(thinking).toHaveTextContent("第一段，继续思考");

    await act(async () => {
      onEvent?.(event("thinking-end", "message_update", {
        message: { role: "assistant", content: [{ type: "thinking", thinking: "思考完成" }] },
        assistantMessageEvent: { type: "thinking_end", contentIndex: 0 },
      }));
    });
    expect(screen.getByRole("article", { name: "思考事件" }).querySelector("details")).not.toHaveAttribute("open");

    await act(async () => {
      onEvent?.(event("text-1", "message_update", {
        message: { role: "assistant", content: [{ type: "thinking", thinking: "思考完成" }, { type: "text", text: "实时" }] },
        assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "实时" },
      }));
      onEvent?.(event("text-2", "message_update", {
        message: { role: "assistant", content: [{ type: "thinking", thinking: "思考完成" }, { type: "text", text: "实时回答" }] },
        assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "回答" },
      }));
    });
    expect(screen.getAllByText("实时回答")).toHaveLength(1);
    expect(screen.queryByText("实时")).not.toBeInTheDocument();

    await act(async () => {
      onEvent?.(event("agent-end", "agent_end"));
      onEvent?.(event("agent-settled", "agent_settled"));
    });
    expect(onPromptingChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("article", { name: "已完成事件" })).not.toBeInTheDocument();
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
    expect(screen.getByRole("article", { name: "工具调用事件" })).toBeInTheDocument();
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
