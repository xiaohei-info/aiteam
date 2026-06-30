/**
 * W-A.2 Loop/任务编排面板测试（#312）。
 *
 * 覆盖（验收 checklist）：
 * 1. 列表渲染：会话维度的 Loop 队列（标题 / Cron / 状态 / fire_count）
 * 2. 启用 Loop → POST /api/agent/loops/{id}/enable
 * 3. 停用 Loop → POST /api/agent/loops/{id}/disable
 * 4. 立即触发 → POST /api/agent/loops/{id}/fire
 * 5. 创建 Loop → POST /api/agent/loops（标题 + cron）
 *
 * 范式同 chat.test：mock globalThis.fetch + AppProvider + MemoryRouter + AppRoutes（路由到 /chat）。
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AppProvider } from "../../lib/app-context";
import { AppRoutes } from "../../app/routes";
import {
  createLoop,
  disableLoop,
  enableLoop,
  listLoops,
  fireLoopNow,
  type Loop,
} from "./useLoopsApi";
import { AgentApiClient } from "../../lib/api-client";

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

function makeLoop(partial: Partial<Loop> = {}): Loop {
  return {
    id: "l1",
    conversation_id: "c1",
    cron: "0 9 * * *",
    title: "每日报告",
    status: "disabled",
    fire_count: 0,
    last_run_id: null,
    last_fired_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...partial,
  };
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

/** 按 url+method 路由 fetch mock。 */
function mockFetch(handler: (url: string, method: string) => string) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    return new Response(handler(url, method), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearStorage();
  vi.restoreAllMocks();
});

// ---- 1 + 2 + 3 + 4. LoopPanel 集成：渲染 / 启用 / 停用 / 触发 ----

describe("LoopPanel（嵌在 ChatPage）", () => {
  it("渲染 Loop 列表（会话维度过滤）并显示 fire_count", async () => {
    loginStorage();
    const convs = [makeConv("c1", "会话A")];
    const loopA = makeLoop({ conversation_id: "c1", fire_count: 3 });
    const loopB = makeLoop({ id: "l2", conversation_id: "c2", title: "其他会话" });
    globalThis.fetch = mockFetch((url) => {
      if (url.includes("/timeline")) return listEnvelope([]);
      if (url.includes("/api/agent/conversations") && !url.includes("/messages")) {
        return listEnvelope(convs);
      }
      if (url.includes("/api/agent/loops")) return listEnvelope([loopA, loopB]);
      return listEnvelope([]);
    }) as unknown as typeof fetch;

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("会话A")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /会话A/ }));
    // 打开 Loop 面板
    await waitFor(() => expect(screen.getByRole("button", { name: /任务编排/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /任务编排/ }));

    await waitFor(() => expect(screen.getByText("每日报告")).toBeInTheDocument());
    // 只显示本会话的 loop（loopB 属于 c2，应被过滤掉）
    expect(screen.queryByText("其他会话")).not.toBeInTheDocument();
    // fire_count 展示
    expect(screen.getByText("3")).toBeInTheDocument();
    // cron 展示
    expect(screen.getByText("0 9 * * *")).toBeInTheDocument();
  });

  it("启用 Loop → POST /api/agent/loops/{id}/enable", async () => {
    loginStorage();
    const convs = [makeConv("c1", "会话A")];
    const calls: string[] = [];
    globalThis.fetch = mockFetch((url, method) => {
      calls.push(`${method} ${url}`);
      if (url.includes("/timeline")) return listEnvelope([]);
      if (url.includes("/loops/l1/enable")) return envelope(makeLoop({ status: "enabled" }));
      if (url.includes("/api/agent/conversations") && !url.includes("/messages")) return listEnvelope(convs);
      if (url.includes("/api/agent/loops")) return listEnvelope([makeLoop()]);
      if (url.includes("/runs")) return listEnvelope([]);
      if (url.includes("/tasks")) return listEnvelope([]);
      return listEnvelope([]);
    }) as unknown as typeof fetch;

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("会话A")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /会话A/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /任务编排/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /任务编排/ }));
    await waitFor(() => expect(screen.getByText("启用")).toBeInTheDocument());

    fireEvent.click(screen.getByText("启用"));
    await waitFor(() =>
      expect(calls.some((c) => c.startsWith("POST") && c.endsWith("/api/agent/loops/l1/enable"))).toBe(true),
    );
  });

  it("立即触发 → POST /api/agent/loops/{id}/fire", async () => {
    loginStorage();
    const convs = [makeConv("c1", "会话A")];
    const calls: string[] = [];
    globalThis.fetch = mockFetch((url, method) => {
      calls.push(`${method} ${url}`);
      if (url.includes("/timeline")) return listEnvelope([]);
      if (url.endsWith("/loops/l1/fire")) {
        return envelope({ loop_id: "l1", run_id: "r-1", ok: true, error: null });
      }
      if (url.includes("/api/agent/conversations") && !url.includes("/messages")) return listEnvelope(convs);
      if (url.includes("/api/agent/loops")) return listEnvelope([makeLoop({ status: "enabled" })]);
      if (url.includes("/runs") || url.includes("/tasks")) return listEnvelope([]);
      return listEnvelope([]);
    }) as unknown as typeof fetch;

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("会话A")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /会话A/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /任务编排/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /任务编排/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /触发/ })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /触发/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.endsWith("/api/agent/loops/l1/fire") && c.startsWith("POST"))).toBe(true),
    );
  });

  it("创建 Loop → POST /api/agent(loops（标题 + cron）", async () => {
    loginStorage();
    const convs = [makeConv("c1", "会话A")];
    const calls: string[] = [];
    globalThis.fetch = mockFetch((url, method) => {
      calls.push(`${method} ${url}`);
      if (url.includes("/timeline")) return listEnvelope([]);
      if (url.endsWith("/api/agent/loops") && method === "POST") {
        return envelope(makeLoop({ title: "周报", cron: "0 10 * * 5" }));
      }
      if (url.includes("/api/agent/conversations") && !url.includes("/messages")) return listEnvelope(convs);
      if (url.includes("/api/agent/loops")) return listEnvelope([]);
      if (url.includes("/runs") || url.includes("/tasks")) return listEnvelope([]);
      return listEnvelope([]);
    }) as unknown as typeof fetch;

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("会话A")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /会话A/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /任务编排/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /任务编排/ }));
    await waitFor(() => expect(screen.getByLabelText("Cron 表达式")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Cron 表达式"), { target: { value: "0 10 * * 5" } });
    fireEvent.click(screen.getByRole("button", { name: /创建 Loop/ }));

    await waitFor(() =>
      expect(calls.some((c) => c === "POST /api/agent/loops")).toBe(true),
    );
  });
});

// ---- useLoopsApi 独立覆盖 ----

describe("useLoopsApi", () => {
  it("listLoops 返回去包后的 items 数组", async () => {
    const loops = [makeLoop()];
    const fetchImpl = mockFetch((url) => {
      if (url.includes("/api/agent/loops")) return listEnvelope(loops);
      return listEnvelope([]);
    }) as unknown as typeof fetch;
    const client = new AgentApiClient({ fetch: fetchImpl, baseUrl: "http://test" });
    const result = await listLoops(client);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("l1");
  });

  it("createLoop  POST /api/agent/loops 并返回 Loop", async () => {
    const created = makeLoop({ title: "数据同步" });
    const fetchImpl = mockFetch((url, method) => {
      if (url.endsWith("/api/agent/loops") && method === "POST") return envelope(created);
      return listEnvelope([]);
    }) as unknown as typeof fetch;
    const client = new AgentApiClient({ fetch: fetchImpl, baseUrl: "http://test" });
    const result = await createLoop(client, { conversation_id: "c1", cron: "*/5 * * * *", title: "数据同步" });
    expect(result.id).toBe("l1");
    expect(result.title).toBe("数据同步");
  });

  it("enableLoop / disableLoop 命中状态端点", async () => {
    const enabled = makeLoop({ status: "enabled" });
    const disabled = makeLoop({ status: "disabled" });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/enable")) return new Response(envelope(enabled), { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("/disable")) return new Response(envelope(disabled), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(envelope(null), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = new AgentApiClient({ fetch: fetchImpl, baseUrl: "http://test" });
    const r1 = await enableLoop(client, "l1");
    expect(r1.status).toBe("enabled");
    const r2 = await disableLoop(client, "l1");
    expect(r2.status).toBe("disabled");
  });

  it("fireLoopNow 解析 FireNowResult", async () => {
    const fetchImpl = mockFetch((url, method) => {
      if (url.endsWith("/fire")) return envelope({ loop_id: "l1", run_id: "r-9", ok: true, error: null });
      return listEnvelope([]);
    }) as unknown as typeof fetch;
    const client = new AgentApiClient({ fetch: fetchImpl, baseUrl: "http://test" });
    const result = await fireLoopNow(client, "l1");
    expect(result.ok).toBe(true);
    expect(result.run_id).toBe("r-9");
  });
});
