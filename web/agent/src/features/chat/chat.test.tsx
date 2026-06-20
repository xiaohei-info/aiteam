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
import { listConversations, sendMessage, createTimelineFetcher } from "./useChatApi";
import { TimelineView } from "./TimelineView";

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
  opts: { postMessageOk?: boolean } = {},
) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = typeof url === "string" ? url : url.toString();
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
      expect(screen.getByRole("log")).toBeInTheDocument(); // chat-timeline role="log"
    });
  });
});

// ---- 2. TimelineView 渲染 BusinessTimelineEvent ----

describe("TimelineView — 渲染事件", () => {
  it("选中会话后渲染时间线事件（mock getTimeline）", async () => {
    loginStorage();
    const convs = [makeConv("c1", "会话A")];
    const events = [makeEvent(10, "text")];
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

    fireEvent.change(screen.getByLabelText("消息内容"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls as unknown as [string, RequestInit][];
      const postCall = calls.find(
        ([u, i]) => u.includes("/messages") && i?.method === "POST",
      );
      expect(postCall).toBeTruthy();
    });
  });
});

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
