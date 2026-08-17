/**
 * P09 办公室动态页测试 — 场景渲染 + Feed + 错误态。
 *
 * 覆盖：工位视图渲染（summary + employees）、feed 刷新加载、加载/网络错误展示。
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AppProvider } from "../../lib/app-context";
import { OfficePage } from "./OfficePage";

function envelope<T>(data: T): string {
  return JSON.stringify({ data });
}

const scene = {
  employees: [
    { employee_id: "e1", display_name: "专家A", status: "working", task: "数据清洗中", avatar_url: null },
    { employee_id: "e2", display_name: "专家B", status: "ready", task: null, avatar_url: null },
    { employee_id: "e3", display_name: "专家C", status: "offline", task: null, avatar_url: null },
  ],
  summary: { total: 3, working: 1, ready: 1, offline: 1 },
};

const feedData = {
  events: [
    {
      type: "conversation_schedule",
      title: "数据清洗",
      conversation_id: "conv-1",
      schedule: { recurrence: "daily", at: "09:00" },
    },
    {
      type: "conversation_schedule",
      title: "文案润色",
      conversation_id: "conv-2",
      schedule: { recurrence: "cron", expression: "*/30 * * * *" },
    },
  ],
};

function loginStorage() {
  const claims = { user_id: "u1", tenant_id: "t1", enterprise_id: null, roles: ["member"], exp: 9999999999 };
  localStorage.setItem("aiteam.agent.token", "test-tok");
  localStorage.setItem("aiteam.agent.claims", JSON.stringify(claims));
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AppProvider>
        <OfficePage />
      </AppProvider>
    </MemoryRouter>,
  );
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  localStorage.clear();
});

describe("OfficePage", () => {
  it("渲染工位视图：summary 指标 + 员工卡片", async () => {
    loginStorage();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/office/scene")) return new Response(envelope(scene), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(envelope(null), { status: 200 });
    }) as typeof fetch;

    renderPage();
    await waitFor(() => expect(screen.getByText("专家A")).toBeInTheDocument());
    expect(screen.getByText("专家B")).toBeInTheDocument();
    expect(screen.getByText("专家C")).toBeInTheDocument();
    // summary 卡片
    expect(screen.getByText("total")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getAllByText("working").length).toBeGreaterThanOrEqual(2);
    // 状态图标
    expect(screen.getByText("⚡")).toBeInTheDocument();
    expect(screen.getByText("●")).toBeInTheDocument();
    expect(screen.getByText("○")).toBeInTheDocument();
  });

  it("渲染员工当前任务", async () => {
    loginStorage();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/office/scene")) return new Response(envelope(scene), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(envelope(null), { status: 200 });
    }) as typeof fetch;

    renderPage();
    await waitFor(() => expect(screen.getByText("专家A")).toBeInTheDocument());
    expect(screen.getByText("数据清洗中")).toBeInTheDocument();
  });

  it("点击刷新加载 Feed → 展示动态列表", async () => {
    loginStorage();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/office/scene")) return new Response(envelope(scene), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/office/feed")) return new Response(envelope(feedData), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(envelope(null), { status: 200 });
    }) as typeof fetch;

    renderPage();
    await waitFor(() => expect(screen.getByText("专家A")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));

    await waitFor(() => {
      expect(screen.getByTestId("office-scheduled-jobs")).toBeInTheDocument();
      expect(screen.getByText("数据清洗")).toBeInTheDocument();
      expect(screen.getByText("文案润色")).toBeInTheDocument();
    });
  });

  it("Feed 加载失败 → 展示 feedError（不替换整页面）", async () => {
    loginStorage();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/office/scene")) return new Response(envelope(scene), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/office/feed")) {
        return new Response(
          JSON.stringify({ type: "about:blank", title: "Feed Error", status: 500, code: "feed_failed", detail: "动态服务不可达" }),
          { status: 500, headers: { "content-type": "application/problem+json" } },
        );
      }
      return new Response(envelope(null), { status: 200 });
    }) as typeof fetch;

    renderPage();
    await waitFor(() => expect(screen.getByText("专家A")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));

    await waitFor(() => {
      expect(screen.getByText(/动态服务不可达/)).toBeInTheDocument();
    });
    // 场景仍在
    expect(screen.getByText("专家A")).toBeInTheDocument();
  });

  it("场景加载失败展示阻塞式错误面板", async () => {
    loginStorage();
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ type: "about:blank", title: "Server Error", status: 500, code: "internal", detail: "服务不可用" }),
        { status: 500, headers: { "content-type": "application/problem+json" } },
      ),
    ) as typeof fetch;

    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/服务不可用/)).toBeInTheDocument();
    });
    expect(screen.queryByText("专家A")).toBeNull();
  });

  it("Feed 加载后无定时任务展示空态而非空白", async () => {
    loginStorage();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/office/scene")) return new Response(envelope(scene), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/office/feed")) return new Response(envelope({ events: [] }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(envelope(null), { status: 200 });
    }) as typeof fetch;

    renderPage();
    await waitFor(() => expect(screen.getByText("专家A")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));

    await waitFor(() => {
      expect(screen.getByTestId("office-scheduled-jobs-empty")).toBeInTheDocument();
    });
  });

  it("Feed renders Conversation.schedule metadata without Loop retry state", async () => {
    loginStorage();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/office/scene")) return new Response(envelope(scene), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/office/feed")) return new Response(envelope(feedData), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(envelope(null), { status: 200 });
    }) as typeof fetch;

    renderPage();
    await waitFor(() => expect(screen.getByText("专家A")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));

    await waitFor(() => {
      expect(screen.getAllByText(/调度：/)).toHaveLength(2);
      expect(screen.queryByText(/连续失败|已触发|loop-/)).toBeNull();
    });
  });

  it("空员工列表展示「暂无员工」", async () => {
    loginStorage();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/office/scene")) return new Response(envelope({ employees: [], summary: { total: 0, working: 0, ready: 0, offline: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(envelope(null), { status: 200 });
    }) as typeof fetch;

    renderPage();
    await waitFor(() => {
      expect(screen.getByText("暂无员工")).toBeInTheDocument();
    });
  });
});
