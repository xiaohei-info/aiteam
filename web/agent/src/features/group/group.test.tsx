/**
 * W-A.3 群聊页测试（#68）。
 *
 * 测试覆盖（验收 checklist）：
 * 1. 群聊页渲染会话列表 + timeline（多 run 事件并入同一时间线）
 * 2. @提及解析（输入 "@专家A 你好" -> 触发 groupDispatch，body 含 text + experts）
 * 3. groupDispatch 返回 DispatchResult 后展示 triggered_handles
 * 4. 多 run 事件归并到同一时间线（mock 两个不同 run_id 的 event，都渲染在 timeline）
 *
 * 测试模式与 chat.test.tsx 一致：
 *   vi.fn mock globalThis.fetch + MemoryRouter + AppProvider + AppRoutes（路由到 /group）。
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AppProvider } from "../../lib/app-context";
import { AppRoutes } from "../../app/routes";
import { AgentApiClient } from "../../lib/api-client";
import type { BusinessTimelineEvent } from "@aiteam/shared/contracts";
import { TimelineStore } from "@aiteam/shared/timeline-client";
import { groupDispatch, type GroupExpert, type DispatchResult } from "./useGroupApi";
import { parseMentions } from "./MentionComposer";
import { createTimelineFetcher } from "../chat/useChatApi";
import { MentionComposer } from "./MentionComposer";

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

/** 构造 timeline event；可指定 run_id 以验证多 run 归并。 */
function makeEvent(cursor: number, runId = "r1", type = "text"): BusinessTimelineEvent {
  return {
    cursor,
    run_id: runId,
    conversation_id: "c1",
    type,
    payload: { text: `msg-${cursor}-${runId}` },
    created_at: "2026-01-01T00:00:00Z",
  };
}

/** 构造已登录状态（对齐 token-store.ts 的 key）。 */
function loginStorage() {
  const claims = { user_id: "u1", tenant_id: "t1", enterprise_id: null, roles: ["member"], exp: 9999999999 };
  localStorage.setItem("aiteam.agent.token", "test-tok");
  localStorage.setItem("aiteam.agent.claims", JSON.stringify(claims));
}

function clearStorage() {
  localStorage.removeItem("aiteam.agent.token");
  localStorage.removeItem("aiteam.agent.claims");
}

/**
 * mock fetch 工厂：conversations + timeline + group-dispatch。
 * dispatchResult 控制 POST /group-dispatch 的返回（triggered_handles + runs）。
 */
function makeGroupFetch(
  convs: ReturnType<typeof makeConv>[],
  timelineEvents: BusinessTimelineEvent[] = [],
  dispatchResult: DispatchResult = { triggered_handles: [], runs: [] },
) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = typeof url === "string" ? url : url.toString();
    // 列本地可用专家（GET /api/agent/grants/experts）
    if (path.includes("/api/agent/grants/experts")) {
      const experts = [
        { employee_id: "e1", tenant_id: "t1", version: "v1", display_name: "专家A", runtime_binding: "gpt-5", synced_at: null, revoked: false },
        { employee_id: "e2", tenant_id: "t1", version: "v1", display_name: "专家B", runtime_binding: "claude-sonnet", synced_at: null, revoked: false },
      ];
      return new Response(listEnvelope(experts), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // 列会话（GET /api/agent/conversations，排除 timeline/messages/group-dispatch 子路径）
    if (
      path.includes("/api/agent/conversations") &&
      !path.includes("/timeline") &&
      !path.includes("/messages") &&
      !path.includes("/group-dispatch") &&
      (init?.method === undefined || init?.method === "GET")
    ) {
      return new Response(listEnvelope(convs), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // 时间线（GET .../timeline）
    if (path.includes("/timeline")) {
      return new Response(
        JSON.stringify({ data: timelineEvents, page: { next_cursor: null, has_more: false } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // 群聊编排（POST .../group-dispatch）
    if (path.includes("/group-dispatch") && init?.method === "POST") {
      return new Response(envelope(dispatchResult), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(envelope(null), { status: 200 });
  }) as unknown as typeof fetch;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearStorage();
});

// ---- 1. 群聊页渲染会话列表 + timeline（多 run 事件并入）----

describe("GroupPage — 渲染", () => {
  it("渲染群聊会话列表（header 为「群聊」）", async () => {
    loginStorage();
    const convs = [makeConv("c1", "群聊A"), makeConv("c2", "群聊B")];
    globalThis.fetch = makeGroupFetch(convs);

    render(
      <MemoryRouter initialEntries={["/group"]}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("群聊A")).toBeInTheDocument();
      expect(screen.getByText("群聊B")).toBeInTheDocument();
    });
    // 列表头部文案是「群聊」（区别于私聊页的「私聊」）——用 testid 精确定位 header，
    // 避免与 PageShell 侧边栏 NavLink 的"群聊"导航项撞文本。
    const headers = screen.getAllByTestId("conv-list-header");
    expect(headers.length).toBeGreaterThan(0);
    expect(headers[0]!.textContent).toBe("群聊");
  });

  it("选中会话后渲染时间线 + roster + 输入器", async () => {
    loginStorage();
    const convs = [makeConv("c1", "群聊A")];
    const events = [makeEvent(1, "r1")];
    globalThis.fetch = makeGroupFetch(convs, events);

    render(
      <MemoryRouter initialEntries={["/group"]}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("群聊A")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /群聊A/ }));

    // roster 展示演示专家（专家A / 专家B）
    await waitFor(() => {
      expect(screen.getByText("@专家A")).toBeInTheDocument();
      expect(screen.getByText("@专家B")).toBeInTheDocument();
    });
    // timeline 渲染（role="log"）
    expect(screen.getByRole("log")).toBeInTheDocument();
    // @提及输入器
    expect(screen.getByLabelText("群聊消息内容")).toBeInTheDocument();
  });
});

// ---- 2. @提及解析 -> groupDispatch 请求体 ----

describe("MentionComposer — @提及解析与发送", () => {
  it("输入 @专家A 你好 后发送：POST /group-dispatch body 含 text + experts", async () => {
    loginStorage();
    const convs = [makeConv("c1", "群聊A")];
    const fetchImpl = makeGroupFetch(convs, [], {
      triggered_handles: ["专家A"],
      runs: [{ id: "run-1", conversation_id: "c1", status: "running", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }],
    });
    globalThis.fetch = fetchImpl;

    render(
      <MemoryRouter initialEntries={["/group"]}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("群聊A")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /群聊A/ }));

    const input = await screen.findByLabelText("群聊消息内容");
    fireEvent.change(input, { target: { value: "@专家A 你好" } });

    // 解析提示：将触发 @专家A
    await waitFor(() => {
      expect(screen.getByText(/将触发：@专家A/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls as unknown as [string, RequestInit][];
      const postCall = calls.find(
        ([u, i]) => u.includes("/group-dispatch") && i?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(String(postCall![1].body));
      // 后端字段名为 text（非 content）
      expect(body.text).toBe("@专家A 你好");
      // 携带完整 roster（后端按 roster 解析 @提及）
      expect(Array.isArray(body.experts)).toBe(true);
      expect(body.experts.map((e: GroupExpert) => e.handle)).toContain("专家A");
    });
  });

  it("groupDispatch 函数返回 DispatchResult（triggered_handles + runs）", async () => {
    const expected: DispatchResult = {
      triggered_handles: ["专家A", "专家B"],
      runs: [
        { id: "r1", conversation_id: "c1", status: "running", created_at: "t", updated_at: "t" },
        { id: "r2", conversation_id: "c1", status: "running", created_at: "t", updated_at: "t" },
      ],
    };
    const fetchImpl = makeGroupFetch([], [], expected);
    const client = new AgentApiClient({ fetch: fetchImpl, baseUrl: "http://test" });
    const result = await groupDispatch(client, "c1", {
      text: "@专家A @专家B 分析一下",
      experts: [{ handle: "专家A" }, { handle: "专家B" }],
    });
    expect(result.triggered_handles).toEqual(["专家A", "专家B"]);
    expect(result.runs).toHaveLength(2);
  });
});

// ---- 3. triggered_handles 展示 ----

describe("GroupPage — triggered_handles 展示", () => {
  it("groupDispatch 返回后展示「本轮 @提及触发：@专家A」", async () => {
    loginStorage();
    const convs = [makeConv("c1", "群聊A")];
    const fetchImpl = makeGroupFetch(convs, [], {
      triggered_handles: ["专家A"],
      runs: [],
    });
    globalThis.fetch = fetchImpl;

    render(
      <MemoryRouter initialEntries={["/group"]}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("群聊A")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /群聊A/ }));

    const input = await screen.findByLabelText("群聊消息内容");
    fireEvent.change(input, { target: { value: "@专家A 你好" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(screen.getByText(/本轮 @提及触发：@专家A/)).toBeInTheDocument();
    });
  });
});

// ---- 4. 多 run 事件归并到同一时间线 ----

describe("TimelineView — 多 run 事件归并", () => {
  it("两个不同 run_id 的 event 都渲染在同一 timeline（cursor 归并）", async () => {
    // r1 与 r2 两个 run 的事件，cursor 单调，都应出现在同一时间线
    const events = [makeEvent(1, "r1"), makeEvent(2, "r2"), makeEvent(3, "r1")];
    const fetchImpl = makeGroupFetch([], events);
    const client = new AgentApiClient({ fetch: fetchImpl, baseUrl: "http://test" });

    await act(async () => {
      render(
        <MemoryRouter>
          <AppProvider>
            <TimelineBridge client={client} />
          </AppProvider>
        </MemoryRouter>,
      );
    });

    // 三个事件（不同 run_id）都在 timeline 里
    await waitFor(() => {
      expect(screen.getByText("msg-1-r1")).toBeInTheDocument();
      expect(screen.getByText("msg-2-r2")).toBeInTheDocument();
      expect(screen.getByText("msg-3-r1")).toBeInTheDocument();
    });
  });

  it("TimelineStore + createTimelineFetcher：多 run event 按 cursor 归并去重", async () => {
    const events = [makeEvent(10, "r1"), makeEvent(11, "r2"), makeEvent(12, "r1")];
    const client = new AgentApiClient({ fetch: makeGroupFetch([], events) as unknown as typeof fetch, baseUrl: "http://test" });
    const fetcher = createTimelineFetcher(client);
    const store = new TimelineStore({ conversationId: "c1", history: fetcher, pageSize: 10 });

    await store.catchUp();
    expect(store.snapshot.length).toBe(3);
    // cursor 单调升序
    expect(store.snapshot.map((e) => e.cursor)).toEqual([10, 11, 12]);
    // run_id 各异但都在同一条时间线
    expect(new Set(store.snapshot.map((e) => e.run_id))).toEqual(new Set(["r1", "r2"]));
  });
});

// ---- parseMentions 单元 ----

describe("parseMentions", () => {
  const known = new Set(["专家A", "专家B", "alice"]);
  it("提取已知 handle，忽略未知", () => {
    expect(parseMentions("@专家A 你好 @unknown @专家B", known).sort()).toEqual(["专家A", "专家B"]);
  });
  it("同一 handle 只出现一次", () => {
    expect(parseMentions("@alice @alice @alice", known)).toEqual(["alice"]);
  });
  it("无 @ 返回空", () => {
    expect(parseMentions("普通消息无提及", known)).toEqual([]);
  });
});

/**
 * 测试桥：直接渲染 TimelineView（client 注入），避免整树路由 + catchUp 的 act 边界。
 * AppProvider 提供 useApp（TimelineView 本身不依赖 useApp，但保持与生产一致的上下文）。
 */
import { TimelineView } from "../chat/TimelineView";
function TimelineBridge({ client }: { client: AgentApiClient }) {
  return <TimelineView client={client} conversationId="c1" />;
}

/**
 * MentionComposer 直接单测（不走路由）：验证无 @ 时不显示「将触发」。
 */
describe("MentionComposer — 无 @提及", () => {
  it("纯文本（无已知 @）不显示触发提示，但仍可发送", async () => {
    const onDispatched = vi.fn();
    const fetchImpl = makeGroupFetch([], [], { triggered_handles: [], runs: [] });
    globalThis.fetch = fetchImpl;

    render(
      <MemoryRouter>
        <AppProvider>
          <MentionComposer
            conversationId="c1"
            experts={[{ handle: "专家A" }]}
            onDispatched={onDispatched}
          />
        </AppProvider>
      </MemoryRouter>,
    );

    const input = screen.getByLabelText("群聊消息内容");
    fireEvent.change(input, { target: { value: "纯文本无提及" } });
    expect(screen.queryByText(/将触发/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      expect(onDispatched).toHaveBeenCalledWith({ triggered_handles: [], runs: [] });
    });
  });
});
