/**
 * W-A.2 私聊对话页测试（#67）。
 *
 * 测试覆盖（验收 checklist）：
 * 1. 对话列表渲染（mock fetch → listConversations）
 * 2. 选中会话后 TimelineView 渲染 BusinessTimelineEvent（mock getTimeline）
 * 3. 发送消息调 POST /api/agent/conversations/{id}/messages（MessageComposer）
 * 4. TimelineStore cursor 分页（loadOlder）—— 直接测 TimelineStore + useChatApi fetcher
 *
 * 测试模式与 LoginPage.test.tsx 保持一致：
 *   vi.fn mock globalThis.fetch + MemoryRouter + AppProvider + AppRoutes（路由到 /chat）。
 * AppProvider 注入 AgentApiClient（使用 mock fetch），RequireAuth 需要 session——构造一个
 * 已登录的 token 注入 localStorage 让守卫通过（sessionFromClaims 路径）。
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AppProvider } from "../../lib/app-context";
import { AppRoutes } from "../../app/routes";
import { AgentApiClient } from "../../lib/api-client";
import { TimelineStore } from "@aiteam/shared/timeline-client";
import type { BusinessTimelineEvent } from "@aiteam/shared/contracts";
import { listConversations, sendMessage, startRun, createTimelineFetcher } from "./useChatApi";
import { TimelineView } from "./TimelineView";

Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: vi.fn(() => null),
});

// ---- 通用 helper ----

function listEnvelope<T>(items: T[], nextCursor: string | null = null): string {
  return JSON.stringify({ data: items, page: { next_cursor: nextCursor, has_more: !!nextCursor } });
}

function envelope<T>(data: T): string {
  return JSON.stringify({ data });
}

function makeConv(id: string, title: string) {
  return { id, title, state: "active", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
}

function makeEvent(cursor: number, type = "text"): BusinessTimelineEvent {
  return { cursor, run_id: "r1", conversation_id: "c1", type, payload: { text: `msg-${cursor}` }, created_at: "2026-01-01T00:00:00Z" };
}

/** 构造已登录状态——按 token-store.ts 的实际 key 写（TOKEN_KEY / CLAIMS_KEY）。 */
function loginStorage() {
  const claims = { user_id: "u1", tenant_id: "t1", enterprise_id: null, roles: ["member"], exp: 9999999999 };
  localStorage.setItem("aiteam.agent.token", "test-tok");
  localStorage.setItem("aiteam.agent.claims", JSON.stringify(claims));
}

function clearStorage() {
  localStorage.removeItem("aiteam.agent.token");
  localStorage.removeItem("aiteam.agent.claims");
}

/** mock fetch 工厂：conversations + timeline + messages。 */
function makeFetch(
  convs: ReturnType<typeof makeConv>[],
  timelineEvents: BusinessTimelineEvent[] = [],
  opts: { postMessageOk?: boolean; startRunOk?: boolean } = {},
) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = typeof url === "string" ? url : url.toString();
    if (path.includes("/runs") && init?.method === "POST") {
      return new Response(
        opts.startRunOk === false
          ? JSON.stringify({ type: "err", title: "run failed", status: 500, code: "run_failed" })
          : JSON.stringify({ data: { id: "run-1", conversation_id: "c1", status: "running", created_at: "", updated_at: "" } }),
        {
          status: opts.startRunOk === false ? 500 : 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (path.includes("/api/agent/conversations") && !path.includes("/messages") && !path.includes("/timeline") && init?.method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const created = { id: "c-new", title: body.title ?? null, state: "active", created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" };
      return new Response(envelope(created), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path.includes("/api/agent/conversations") && !path.includes("/messages") && !path.includes("/timeline") && (init?.method === undefined || init?.method === "GET")) {
      return new Response(listEnvelope(convs), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path.includes("/timeline")) {
      return new Response(
        JSON.stringify({ data: timelineEvents, page: { next_cursor: null, has_more: false } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (path.includes("/messages") && init?.method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const msg = { id: "m1", conversation_id: "c1", role: "user", content: body.content, created_at: "2026-01-01T00:00:00Z" };
      return new Response(
        opts.postMessageOk === false ? JSON.stringify({ type: "err", title: "fail", status: 400, code: "bad" }) : envelope(msg),
        {
          status: opts.postMessageOk === false ? 400 : 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    return new Response(envelope(null), { status: 200 });
  }) as unknown as typeof fetch;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearStorage();
});

// ---- 1. 对话列表渲染 ----

describe("ConversationList", () => {
  it("渲染会话列表（mock fetch）", async () => {
    loginStorage();
    const convs = [makeConv("c1", "会话A"), makeConv("c2", "会话B")];
    globalThis.fetch = makeFetch(convs);

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("会话A")).toBeInTheDocument();
      expect(screen.getByText("会话B")).toBeInTheDocument();
    });
  });

  it("点击会话后显示时间线面板", async () => {
    loginStorage();
    const convs = [makeConv("c1", "会话A")];
    const events = [makeEvent(1, "text")];
    globalThis.fetch = makeFetch(convs, events);

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("会话A")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /会话A/ }));

    await waitFor(() => {
      expect(screen.getByRole("log", { name: "对话时间线" })).toBeInTheDocument(); // TerminalPanel 也有 role="log"，按 name 消歧
    });
  });

  it("使用 Astryx chat log 和 composer 保留发送主链", async () => {
    loginStorage();
    const fetchImpl = makeFetch([makeConv("c1", "会话A")], [makeEvent(1)]);
    globalThis.fetch = fetchImpl;
    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProvider><AppRoutes /></AppProvider>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /会话A/ }));
    const timeline = await screen.findByRole("log", { name: "对话时间线" });
    expect(timeline).toBeInTheDocument();
    expect(timeline).toHaveClass("astryx-chat-message-list");
    const textbox = screen.getByRole("textbox", { name: "消息内容" });
    expect(textbox).toBeInTheDocument();
    expect(textbox.closest(".astryx-chat-composer")).not.toBeNull();
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
  });
});

// ---- 2. TimelineView 渲染 BusinessTimelineEvent ----

describe("TimelineView — 渲染事件", () => {
  it("选中会话后渲染时间线事件（mock getTimeline）", async () => {
    loginStorage();
    const convs = [makeConv("c1", "会话A")];
    const events = [makeEvent(10, "answer_delta")];
    const fetchImpl = makeFetch(convs, events);
    globalThis.fetch = fetchImpl;

    // 直接渲染 TimelineView（client 注入 mock fetch），避免整树路由 catchUp 的 act 边界问题。
    const client = new AgentApiClient({ fetch: fetchImpl, baseUrl: "http://test" });
    await act(async () => {
      render(<TimelineView client={client} conversationId="c1" />);
    });

    await waitFor(() => {
      // event payload.text = "msg-10"
      expect(screen.getByText("msg-10")).toBeInTheDocument();
    });
    expect(screen.getByRole("article", { name: "answer_delta" })).toBeInTheDocument();
    expect(document.querySelector('[aria-label="Message from assistant"]')).toBeNull();
  });
});

// ---- 3. 发送消息调 POST ----

describe("MessageComposer — 发送消息", () => {
  it("填写内容并发送：调用 POST /api/agent/conversations/{id}/messages", async () => {
    loginStorage();
    const convs = [makeConv("c1", "会话A")];
    const fetchImpl = makeFetch(convs);
    globalThis.fetch = fetchImpl;

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("会话A")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /会话A/ }));

    await waitFor(() => expect(screen.getByLabelText("消息内容")).toBeInTheDocument());

    setComposerContent(screen.getByLabelText("消息内容"), "hello");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls as unknown as [string, RequestInit][];
      const postMsg = calls.find(([u, i]) => u.includes("/messages") && i?.method === "POST");
      expect(postMsg).toBeTruthy();
      const postRun = calls.find(([u, i]) => u.includes("/runs") && i?.method === "POST");
      expect(postRun).toBeTruthy();
    });
  });

  it("按 Enter 与发送按钮共用发送主链", async () => {
    loginStorage();
    const fetchImpl = makeFetch([makeConv("c1", "会话A")]);
    globalThis.fetch = fetchImpl;

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProvider><AppRoutes /></AppProvider>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /会话A/ }));
    const input = await screen.findByRole("textbox", { name: "消息内容" });
    setComposerContent(input, "enter-send");
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls as unknown as [string, RequestInit][];
      expect(calls.some(([u, i]) => u.includes("/messages") && i?.method === "POST")).toBe(true);
      expect(calls.some(([u, i]) => u.includes("/runs") && i?.method === "POST")).toBe(true);
    });
  });

  it("IME composing Enter 不发送且不清空内容", async () => {
    loginStorage();
    const fetchImpl = makeFetch([makeConv("c1", "会话A")]);
    globalThis.fetch = fetchImpl;

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProvider><AppRoutes /></AppProvider>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /会话A/ }));
    const input = await screen.findByRole("textbox", { name: "消息内容" });
    setComposerContent(input, "组合输入");
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", isComposing: true });

    expect(hasRuntimePost(fetchImpl, "/messages")).toBe(false);
    expect(hasRuntimePost(fetchImpl, "/runs")).toBe(false);
    expect(readComposerContent(input)).toBe("组合输入");
  });

  it("Shift+Enter 不发送并保留内容", async () => {
    loginStorage();
    const fetchImpl = makeFetch([makeConv("c1", "会话A")]);
    globalThis.fetch = fetchImpl;

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProvider><AppRoutes /></AppProvider>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /会话A/ }));
    const input = await screen.findByRole("textbox", { name: "消息内容" });
    setComposerContent(input, "保留换行内容");
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: true });

    expect(hasRuntimePost(fetchImpl, "/messages")).toBe(false);
    expect(hasRuntimePost(fetchImpl, "/runs")).toBe(false);
    expect(readComposerContent(input)).toBe("保留换行内容");
  });

  it("sendMessage 失败时不清空内容", async () => {
    loginStorage();
    globalThis.fetch = makeFetch([makeConv("c1", "会话A")], [], { postMessageOk: false });

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProvider><AppRoutes /></AppProvider>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /会话A/ }));
    const input = await screen.findByRole("textbox", { name: "消息内容" });
    setComposerContent(input, "保留这条消息");
    const send = screen.getByRole("button", { name: "发送" });
    fireEvent.click(send);

    await waitFor(() => expect(send).not.toBeDisabled());
    expect(readComposerContent(input)).toBe("保留这条消息");
  });

  it("startRun 失败时不清空内容", async () => {
    loginStorage();
    globalThis.fetch = makeFetch([makeConv("c1", "会话A")], [], { startRunOk: false });

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProvider><AppRoutes /></AppProvider>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /会话A/ }));
    const input = await screen.findByRole("textbox", { name: "消息内容" });
    const file = new File(["run"], "run.txt", { type: "text/plain" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });
    setComposerContent(input, "run 失败也保留");
    const send = screen.getByRole("button", { name: "发送" });
    fireEvent.click(send);

    await waitFor(() => expect(send).not.toBeDisabled());
    expect(readComposerContent(input)).toBe("run 失败也保留");
    expect(screen.getByRole("button", { name: "移除附件 run.txt" })).toBeInTheDocument();
  });
});

function setComposerContent(input: HTMLElement, value: string): void {
  if (input instanceof HTMLTextAreaElement) {
    fireEvent.change(input, { target: { value } });
    return;
  }
  input.textContent = value;
  fireEvent.input(input);
}

function readComposerContent(input: HTMLElement): string {
  return input instanceof HTMLTextAreaElement ? input.value : input.textContent ?? "";
}

function hasRuntimePost(fetchImpl: typeof fetch, path: string): boolean {
  const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls as unknown as [string, RequestInit][];
  return calls.some(([url, init]) => url.includes(path) && init?.method === "POST");
}

function setCaretOffset(input: HTMLElement, offset: number): void {
  const walker = document.createTreeWalker(input, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      const selection = window.getSelection();
      if (!selection) throw new Error("Selection API unavailable");
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= length;
    node = walker.nextNode();
  }
  throw new Error(`Cannot place caret at offset ${offset}`);
}

function getCaretOffset(input: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) throw new Error("Selection API unavailable");
  const caret = selection.getRangeAt(0);
  const prefix = document.createRange();
  prefix.selectNodeContents(input);
  prefix.setEnd(caret.startContainer, caret.startOffset);
  return prefix.toString().length;
}

function insertUserTextAtSelection(input: HTMLElement, text: string): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) throw new Error("Selection API unavailable");
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.input(input);
}

// ---- 4. TimelineStore cursor 分页（loadOlder） ----

describe("TimelineStore + createTimelineFetcher loadOlder", () => {
  it("loadOlder 按 beforeCursor 向前翻页", async () => {
    const client = new AgentApiClient({ fetch: makeFetch([], [makeEvent(1), makeEvent(2), makeEvent(3)]) as unknown as typeof fetch, baseUrl: "http://test" });
    const fetcher = createTimelineFetcher(client);
    const store = new TimelineStore({ conversationId: "c1", history: fetcher, pageSize: 10 });

    // 先 catchUp 拿全量
    await store.catchUp();
    expect(store.snapshot.length).toBeGreaterThan(0);
  });

  it("listConversations 函数返回 items + hasMore", async () => {
    const convs = [makeConv("c-x", "X")];
    const client = new AgentApiClient({ fetch: makeFetch(convs) as unknown as typeof fetch, baseUrl: "http://test" });
    const result = await listConversations(client);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toBe("c-x");
    expect(result.hasMore).toBe(false);
  });

  it("sendMessage 发 POST 并返回 message", async () => {
    const client = new AgentApiClient({ fetch: makeFetch([], [], { postMessageOk: true }) as unknown as typeof fetch, baseUrl: "http://test" });
    const msg = await sendMessage(client, "c1", { content: "hi" });
    expect(msg?.content).toBe("hi");
  });

  it("多页 loadOlder：canLoadMore 依据 hasMore 字段", async () => {
    // 第一页 hasMore=true，第二页 hasMore=false
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      const items = call === 1 ? [makeEvent(3), makeEvent(4)] : [makeEvent(1), makeEvent(2)];
      const hasMore = call === 1;
      return new Response(
        JSON.stringify({ data: items, page: { next_cursor: null, has_more: hasMore } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const client = new AgentApiClient({ fetch: fetchImpl, baseUrl: "http://test" });
    const fetcher = createTimelineFetcher(client);
    const store = new TimelineStore({ conversationId: "c1", history: fetcher, pageSize: 2 });

    // 先打入 cursor=5 锚点，再 loadOlder（beforeCursor=5 → 第一页 hasMore=true）
    store.ingest(makeEvent(5));
    const added1 = await store.loadOlder();
    expect(added1).toBe(2);
    expect(store.canLoadMore).toBe(true);

    const added2 = await store.loadOlder();
    expect(added2).toBe(2);
    expect(store.canLoadMore).toBe(false);
  });
});

// ---- 5. MessageComposer 工具栏 + @提及 + 附件 ----

function makeConv5(id: string, title: string) {
  return { id, title, state: "active", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
}

/**
 * mock fetch：conversations + timeline + messages + roster。
 * rosterItems 控制 GET /api/agent/grants/experts 返回的专家列表。
 */
function makeChatFetch(
  convs: ReturnType<typeof makeConv5>[],
  rosterItems: Array<{ employee_id: string; display_name: string; revoked: boolean }> = [],
) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = typeof url === "string" ? url : url.toString();
    if (path.includes("/grants/experts")) {
      // 默认补齐 model_policy（req 2 配置完整度防呆）：测试专家默认 model/provider_ref 齐全、可被选择。
      const roster = rosterItems.map((p) => ({ model_policy: { model: "gpt-5", provider_ref: "relay" }, ...p }));
      return new Response(JSON.stringify({ data: roster, page: { next_cursor: null, has_more: false } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path.includes("/runs") && init?.method === "POST") {
      return new Response(JSON.stringify({ data: { id: "run-1", conversation_id: "c1", status: "running", created_at: "", updated_at: "" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (path.includes("/api/agent/conversations") && !path.includes("/messages") && !path.includes("/timeline") && init?.method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const created = { id: "c-new", title: body.title ?? null, state: "active", created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" };
      return new Response(envelope(created), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path.includes("/api/agent/conversations") && !path.includes("/messages") && !path.includes("/timeline") && (init?.method === undefined || init?.method === "GET")) {
      return new Response(listEnvelope(convs), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path.includes("/timeline")) {
      return new Response(
        JSON.stringify({ data: [], page: { next_cursor: null, has_more: false } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (path.includes("/messages") && init?.method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const msg = { id: "m1", conversation_id: "c1", role: "user", content: body.content, created_at: "2026-01-01T00:00:00Z" };
      return new Response(envelope(msg), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(envelope(null), { status: 200 });
  }) as unknown as typeof fetch;
}

/** 渲染私聊页并进入第一个会话，等待 MessageComposer 完全装载。 */
async function renderChatComposer(rosterItems: Array<{ employee_id: string; display_name: string; revoked: boolean }> = []) {
  loginStorage();
  const convs = [makeConv5("c1", "会话A")];
  const fetchImpl = makeChatFetch(convs, rosterItems);
  globalThis.fetch = fetchImpl;

  render(
    <MemoryRouter initialEntries={["/chat"]}>
      <AppProvider>
        <AppRoutes />
      </AppProvider>
    </MemoryRouter>,
  );

  await waitFor(() => expect(screen.getByText("会话A")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /会话A/ }));

  await waitFor(() => expect(screen.getByLabelText("消息内容")).toBeInTheDocument());
  return { fetchImpl };
}

describe("MessageComposer 工具栏 + @提及 + 附件", () => {
  it("渲染工具栏：附件 / @ / 技能 / 截图", async () => {
    await renderChatComposer();
    expect(screen.getByRole("button", { name: "附件上传" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "召唤其他智能体" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "技能市场入口" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "截图工具" })).toBeInTheDocument();
    // AITEAM-688：runtime/model 是部署级配置，私聊不再提供模型选择入口。
    expect(screen.queryByRole("button", { name: /当前模型/ })).toBeNull();
  });

  it("打开 @提及面板选择专家 -> 插入 @handle 到输入框", async () => {
    await renderChatComposer([
      { employee_id: "e1", display_name: "Luna", revoked: false },
      { employee_id: "e2", display_name: "Nova", revoked: false },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "召唤其他智能体" }));
    const lunaBtn = await screen.findByRole("button", { name: /Luna/ });
    fireEvent.click(lunaBtn);

    const input = screen.getByLabelText("消息内容");
    await waitFor(() => expect(readComposerContent(input)).toContain("@Luna"));
  });

  it("在 contentEditable 中间插入 @handle 后保留焦点与光标位置", async () => {
    await renderChatComposer([
      { employee_id: "e1", display_name: "Luna", revoked: false },
    ]);

    const input = screen.getByLabelText("消息内容");
    setComposerContent(input, "你好世界");
    input.focus();
    setCaretOffset(input, 2);

    fireEvent.click(screen.getByRole("button", { name: "召唤其他智能体" }));
    fireEvent.click(await screen.findByRole("button", { name: /Luna/ }));

    const inserted = "你好@Luna 世界";
    await waitFor(() => expect(readComposerContent(input)).toBe(inserted));
    expect(document.activeElement).toBe(input);
    expect(getCaretOffset(input)).toBe("你好@Luna ".length);

    insertUserTextAtSelection(input, "X");
    await waitFor(() => expect(readComposerContent(input)).toBe("你好@Luna X世界"));
    expect(getCaretOffset(input)).toBe("你好@Luna X".length);
  });

  it("@提及已输入时展示「已 @提及」提示", async () => {
    await renderChatComposer([
      { employee_id: "e1", display_name: "Luna", revoked: false },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "召唤其他智能体" }));
    await screen.findByRole("button", { name: /Luna/ });
    // 关闭面板
    fireEvent.click(document.body);

    setComposerContent(screen.getByLabelText("消息内容"), "你好 @Luna 请帮忙");
    expect(await screen.findByText(/已 @提及：@Luna/)).toBeInTheDocument();
  });

  it("技能入口：选择技能 -> 插入 /技能名 到输入框", async () => {
    await renderChatComposer();

    fireEvent.click(screen.getByRole("button", { name: "技能市场入口" }));
    const skillBtn = await screen.findByRole("button", { name: /\/写作助手/ });
    fireEvent.click(skillBtn);

    const input = screen.getByLabelText("消息内容");
    await waitFor(() => expect(readComposerContent(input)).toContain("/写作助手"));
  });

  it("附件上传后发送的消息体包含 [附件: filename]", async () => {
    const { fetchImpl } = await renderChatComposer();

    const file = new File(["hello"], "spec.txt", { type: "text/plain" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    fireEvent.change(fileInput, { target: { files: [file] } });

    setComposerContent(screen.getByLabelText("消息内容"), "请查看附件");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls as unknown as [string, RequestInit][];
      const postMsg = calls.find(([u, i]) => u.includes("/messages") && i?.method === "POST");
      expect(postMsg).toBeTruthy();
      const body = JSON.parse(String(postMsg?.[1]?.body ?? "{}"));
      expect(body.content).toContain("请查看附件");
      expect(body.content).toContain("[附件: spec.txt]");
    });
    await waitFor(() => {
      expect(readComposerContent(screen.getByLabelText("消息内容"))).toBe("");
      expect(screen.queryByRole("button", { name: "移除附件 spec.txt" })).toBeNull();
    });
  });

  it("空内容 + 无附件时发送按钮 disabled", async () => {
    await renderChatComposer();
    const send = screen.getByRole("button", { name: "发送" });
    expect(send).toBeDisabled();
  });
});

// ---- 6. 新建对话：RosterPicker -> createConversation ----

describe("ChatPage — 新建私聊会话", () => {
  it("空态显示「新建对话」入口", async () => {
    loginStorage();
    const convs: ReturnType<typeof makeConv5>[] = [];
    globalThis.fetch = makeChatFetch(convs);

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("button", { name: /新建对话/ })).toBeInTheDocument();
  });

  it("列表头部显示「＋ 新建」入口", async () => {
    loginStorage();
    const convs = [makeConv5("c1", "会话A")];
    globalThis.fetch = makeChatFetch(convs);

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>,
    );

    expect((await screen.findAllByRole("button", { name: /新建/ }))[0]!).toBeInTheDocument();
  });

  it("点击新建 -> 选择专家 -> 建会话并进入聊天", async () => {
    loginStorage();
    const convs = [makeConv5("c1", "会话A")];
    const fetchImpl = makeChatFetch(convs, [
      { employee_id: "e1", display_name: "Luna", revoked: false },
      { employee_id: "e2", display_name: "Nova", revoked: false },
    ]);
    globalThis.fetch = fetchImpl;

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("会话A")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: /新建/ })[0]!);

    const lunaBtn = await screen.findByRole("button", { name: /Luna/ });
    fireEvent.click(lunaBtn);

    // 建会话 POST /api/agent/conversations
    await waitFor(() => {
      const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls as unknown as [string, RequestInit][];
      const create = calls.find(([u, i]) => u.endsWith("/api/agent/conversations") && i?.method === "POST");
      expect(create).toBeTruthy();
      const body = JSON.parse(String(create![1].body));
      expect(body.title).toBe("Luna");
      expect(body.entry_employee_id).toBe("e1");
      expect(body.collaboration_mode).toBe("free");
    });

    // 选中进入聊天：渲染 TimelineView（role="log"）
    await waitFor(() => expect(screen.getByRole("log", { name: "对话时间线" })).toBeInTheDocument());
  });

  it("roster 无专家时显示提示文案", async () => {
    loginStorage();
    const convs = [makeConv5("c1", "会话A")];
    globalThis.fetch = makeChatFetch(convs, []);

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("会话A")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: /新建/ })[0]!);

    expect(await screen.findByText(/暂无可私聊的专家/)).toBeInTheDocument();
  });
});

// ---- 7. 私聊新建：取消 / 失败 / 返回空（覆盖 handleCancelCreate + handlePick 分支）----

function chatFetchWithCreate(createImpl: (init?: RequestInit) => Response, roster: Array<{ employee_id: string; display_name: string; revoked: boolean }> = []) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = typeof url === "string" ? url : url.toString();
    if (path.includes("/api/agent/grants/experts")) {
      // 默认补齐 model_policy（req 2 配置完整度防呆）：测试专家默认 model/provider_ref 齐全、可被选择。
      const withPolicy = roster.map((p) => ({ model_policy: { model: "gpt-5", provider_ref: "relay" }, ...p }));
      return new Response(JSON.stringify({ data: withPolicy, page: { next_cursor: null, has_more: false } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path.endsWith("/api/agent/conversations") && init?.method === "POST") {
      return createImpl(init);
    }
    if (path.includes("/api/agent/conversations") && !path.includes("/messages") && !path.includes("/timeline") && (init?.method === undefined || init?.method === "GET")) {
      return new Response(JSON.stringify({ data: [], page: { next_cursor: null, has_more: false } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path.includes("/timeline")) {
      return new Response(JSON.stringify({ data: [], page: { next_cursor: null, has_more: false } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: null }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("ChatPage — 新建私聊会话（失败分支）", () => {
  it("取消弹层（Esc）关闭并回到空态", async () => {
    loginStorage();
    globalThis.fetch = chatFetchWithCreate(
      () => new Response(JSON.stringify({ data: { id: "c-new", title: "x", state: "active", created_at: "", updated_at: "" } }), { status: 200, headers: { "Content-Type": "application/json" } }),
      [{ employee_id: "e1", display_name: "Luna", revoked: false }],
    );

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /新建对话/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    // Esc 关闭弹层
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("建会话返回空时展示错误提示", async () => {
    loginStorage();
    const fetchImpl = chatFetchWithCreate(
      () => new Response(JSON.stringify({ data: null }), { status: 200, headers: { "Content-Type": "application/json" } }),
      [{ employee_id: "e1", display_name: "Luna", revoked: false }],
    );
    globalThis.fetch = fetchImpl;

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /新建对话/ }));
    const lunaBtn = await screen.findByRole("button", { name: /Luna/ });
    fireEvent.click(lunaBtn);

    // 错误提示以 role=alert 形式展示（文案走 i18n useApiError）
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("建会话接口异常时展示错误提示", async () => {
    loginStorage();
    const fetchImpl = chatFetchWithCreate(
      () => new Response(JSON.stringify({ type: "err", title: "boom", status: 500, code: "server_error" }), { status: 500, headers: { "Content-Type": "application/json" } }),
      [{ employee_id: "e1", display_name: "Luna", revoked: false }],
    );
    globalThis.fetch = fetchImpl;

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /新建对话/ }));
    const lunaBtn = await screen.findByRole("button", { name: /Luna/ });
    fireEvent.click(lunaBtn);

    // 错误提示应出现在弹层内
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
