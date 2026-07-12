/**
 * W-A.4 工作台页测试（#115）。
 *
 * 覆盖：会话总览渲染 + 跳转私聊链接、Loop 总览渲染、启用 Loop（POST /loops/{id}/enable）、
 * 立即触发（POST /loops/{id}/fire）、只调本端（基类拦截，client.test 守）。
 * 范式同 chat.test：mock globalThis.fetch + AppProvider + MemoryRouter。
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AppProvider } from "../../lib/app-context";
import { WorkspacePage } from "./WorkspacePage";

function listEnvelope<T>(items: T[]): string {
  return JSON.stringify({ data: items, page: { next_cursor: null, has_more: false } });
}
function envelope<T>(data: T): string {
  return JSON.stringify({ data });
}

const conv = { id: "c1", title: "需求讨论", state: "active", updated_at: "2026-01-01T00:00:00Z" };
const loopDisabled = {
  id: "l1", conversation_id: "c1", cron: "0 9 * * *", title: "每日巡检",
  status: "disabled", last_run_id: null,
};

function loginStorage() {
  const claims = { user_id: "u1", tenant_id: "t1", enterprise_id: null, roles: ["member"], exp: 9999999999 };
  localStorage.setItem("aiteam.agent.token", "test-tok");
  localStorage.setItem("aiteam.agent.claims", JSON.stringify(claims));
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

function renderWorkspace() {
  return render(
    <MemoryRouter initialEntries={["/workspace"]}>
      <AppProvider>
        <WorkspacePage />
      </AppProvider>
    </MemoryRouter>,
  );
}

describe("WorkspacePage 工作台", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    globalThis.fetch = realFetch; // 直接赋值的 fetch mock 需手动还原，防跨用例残留
  });

  it("渲染会话总览（含跳转私聊链接）+ Loop 总览", async () => {
    loginStorage();
    globalThis.fetch = mockFetch((url) => {
      if (url.includes("/api/agent/conversations")) return listEnvelope([conv]);
      if (url.includes("/api/agent/loops")) return listEnvelope([loopDisabled]);
      return listEnvelope([]);
    }) as typeof fetch;

    renderWorkspace();
    await waitFor(() => expect(screen.getByTestId("ws-conversation")).toBeInTheDocument());
    expect(screen.getByRole("region", { name: "本地工作台" })).toBeInTheDocument();
    expect(screen.getByText("需求讨论")).toBeInTheDocument();
    // 跳转链接指向 /chat
    expect(screen.getByText("需求讨论").closest("a")?.getAttribute("href")).toBe("/chat");
    expect(screen.getByTestId("ws-loop")).toBeInTheDocument();
    expect(screen.getByText("每日巡检")).toBeInTheDocument();
  });

  it("启用 Loop → POST /loops/{id}/enable", async () => {
    loginStorage();
    const calls: string[] = [];
    globalThis.fetch = mockFetch((url, method) => {
      calls.push(`${method} ${url}`);
      if (url.includes("/api/agent/conversations")) return listEnvelope([conv]);
      if (url.endsWith("/loops/l1/enable")) return envelope({ ...loopDisabled, status: "enabled" });
      if (url.includes("/api/agent/loops")) return listEnvelope([loopDisabled]);
      return listEnvelope([]);
    }) as typeof fetch;

    renderWorkspace();
    await waitFor(() => expect(screen.getByTestId("ws-loop")).toBeInTheDocument());
    fireEvent.click(screen.getByText("启用"));
    await waitFor(() =>
      expect(calls.some((c) => c.startsWith("POST") && c.endsWith("/api/agent/loops/l1/enable"))).toBe(true),
    );
  });

  it("停用 Loop → POST /loops/{id}/disable", async () => {
    loginStorage();
    const calls: string[] = [];
    const loopEnabled = { ...loopDisabled, status: "enabled" };
    globalThis.fetch = mockFetch((url, method) => {
      calls.push(`${method} ${url}`);
      if (url.includes("/api/agent/conversations")) return listEnvelope([conv]);
      if (url.endsWith("/loops/l1/disable")) return envelope({ ...loopEnabled, status: "disabled" });
      if (url.includes("/api/agent/loops")) return listEnvelope([loopEnabled]);
      return listEnvelope([]);
    }) as typeof fetch;

    renderWorkspace();
    await waitFor(() => expect(screen.getByTestId("ws-loop")).toBeInTheDocument());
    fireEvent.click(screen.getByText("停用"));
    await waitFor(() =>
      expect(calls.some((c) => c.startsWith("POST") && c.endsWith("/api/agent/loops/l1/disable"))).toBe(true),
    );
  });

  it("立即触发 Loop → POST /loops/{id}/fire", async () => {
    loginStorage();
    const calls: string[] = [];
    globalThis.fetch = mockFetch((url, method) => {
      calls.push(`${method} ${url}`);
      if (url.includes("/api/agent/conversations")) return listEnvelope([conv]);
      if (url.endsWith("/loops/l1/fire")) return envelope({ fired: true });
      if (url.includes("/api/agent/loops")) return listEnvelope([loopDisabled]);
      return listEnvelope([]);
    }) as typeof fetch;

    renderWorkspace();
    await waitFor(() => expect(screen.getByTestId("ws-loop")).toBeInTheDocument());
    fireEvent.click(screen.getByText("立即触发"));
    await waitFor(() =>
      expect(calls.some((c) => c.endsWith("/api/agent/loops/l1/fire") && c.startsWith("POST"))).toBe(true),
    );
  });
});
