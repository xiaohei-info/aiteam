import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AppProvider } from "../../lib/app-context";
import { OFFICE_POLL_INTERVAL_MS, OfficePage } from "./OfficePage";
import type { OfficeFeed, OfficeScene } from "./types";

function envelope<T>(data: T): string {
  return JSON.stringify({ data });
}

const scene: OfficeScene = {
  employees: [
    { employee_id: "e1", display_name: "专家A", status: "working", task: "数据清洗中", avatar_url: null },
    { employee_id: "e2", display_name: "专家B", status: "ready", task: null, avatar_url: null },
    { employee_id: "e3", display_name: "专家C", status: "offline", task: null, avatar_url: null },
  ],
  summary: { total: 3, working: 1, ready: 1, offline: 1 },
};

const feedData: OfficeFeed = {
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
      schedule: null,
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

function response<T>(data: T, status = 200): Response {
  return new Response(envelope(data), { status, headers: { "content-type": "application/json" } });
}

function mockOfficeApi(nextScene: unknown = scene, nextFeed: unknown = feedData) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/office/scene")) return response(nextScene);
    if (url.includes("/office/feed")) return response(nextFeed);
    return response(null);
  });
  globalThis.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

async function flushReact(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const originalFetch = globalThis.fetch;
const originalHiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");

beforeEach(() => {
  loginStorage();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  if (originalHiddenDescriptor) Object.defineProperty(document, "hidden", originalHiddenDescriptor);
  localStorage.clear();
});

describe("OfficePage", () => {
  it("shows a stable loading landmark while the local projections are pending", () => {
    globalThis.fetch = vi.fn(() => new Promise<Response>(() => undefined)) as typeof fetch;

    renderPage();

    expect(screen.getByRole("heading", { name: "办公室动态" })).toBeInTheDocument();
    expect(screen.getByTestId("office-loading")).toBeInTheDocument();
  });

  it("renders a mosaic office scene, live totals, status labels, and current tasks", async () => {
    mockOfficeApi();

    renderPage();
    await waitFor(() => expect(screen.getByTestId("office-scene")).toBeInTheDocument());

    expect(screen.getAllByTestId("office-employee")).toHaveLength(3);
    expect(screen.getAllByText("数据清洗中").length).toBeGreaterThan(0);
    expect(screen.getAllByText("工作中").length).toBeGreaterThan(0);
    expect(screen.getAllByText("就绪").length).toBeGreaterThan(0);
    expect(screen.getAllByText("离线").length).toBeGreaterThan(0);
    expect(screen.getByTestId("office-metric-total")).toHaveTextContent("3");
    expect(screen.getByTestId("office-metric-working")).toHaveTextContent("1");
    expect(screen.getByTestId("office-recent")).toBeInTheDocument();
    expect(screen.getByTestId("office-scene").querySelector("svg")).toBeInTheDocument();
    expect(screen.getByTestId("office-poll-state")).toHaveTextContent("实时");
  });

  it("renders recent, waiting, completed, error, and unknown statuses", async () => {
    const varied: OfficeScene = {
      employees: [
        { employee_id: "busy", display_name: "繁忙", status: "busy", task: "忙碌", avatar_url: null, last_status: "waiting", last_task: "等待", last_activity_at: "2026-01-01T00:00:00Z" },
        { employee_id: "idle", display_name: "空闲", status: "idle", task: null, avatar_url: null },
        { employee_id: "done", display_name: "完成", status: "completed", task: null, avatar_url: null, last_status: "completed", last_task: "已完成" },
        { employee_id: "error", display_name: "异常", status: "error", task: null, avatar_url: null },
        { employee_id: "unknown", display_name: "未知", status: "custom", task: null, avatar_url: null },
      ],
      summary: { total: 5, working: 1, ready: 2, offline: 0 },
    };
    mockOfficeApi(varied, { events: [] });
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("office-employee")).toHaveLength(5));
    expect(screen.getAllByText("繁忙").length).toBeGreaterThan(0);
    expect(screen.getAllByText("空闲").length).toBeGreaterThan(0);
    expect(screen.getAllByText("最近完成").length).toBeGreaterThan(0);
    expect(screen.getAllByText("异常").length).toBeGreaterThan(0);
    expect(screen.getAllByText("custom").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /完成工位/ }));
    expect(screen.getByTestId("office-employee-detail")).toHaveTextContent("最近完成");
  });

  it("makes every workstation keyboard-accessible and opens a local employee detail view", async () => {
    mockOfficeApi();

    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("office-employee")).toHaveLength(3));

    const workstations = screen.getAllByTestId("office-employee");
    expect(screen.getAllByRole("button", { name: /工位/ })).toHaveLength(3);
    expect(workstations[0]).toHaveAttribute("aria-label", expect.stringContaining("专家A工位"));
    fireEvent.click(workstations[0]!);

    expect(screen.getByTestId("office-employee-detail")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "员工详情" })).toBeInTheDocument();
    expect(screen.getByText("本机 Agent 实时投影")).toBeInTheDocument();
    expect(screen.getByTestId("office-employee-detail")).toHaveTextContent("数据清洗中");

    fireEvent.click(screen.getByRole("button", { name: "返回最近状态" }));
    expect(screen.getByTestId("office-recent")).toBeInTheDocument();
  });

  it("renders scheduled feed metadata and does not expose execution retry state", async () => {
    mockOfficeApi();

    renderPage();
    await waitFor(() => expect(screen.getByTestId("office-scheduled-jobs")).toBeInTheDocument());

    expect(screen.getByText("数据清洗")).toBeInTheDocument();
    expect(screen.getByText("文案润色")).toBeInTheDocument();
    expect(screen.getAllByText(/调度：/)).toHaveLength(2);
    expect(screen.queryByText(/连续失败|已触发|loop-/)).toBeNull();
  });

  it("renders a feed-unavailable state when the endpoint returns null", async () => {
    mockOfficeApi(scene, null);

    renderPage();
    await waitFor(() => expect(screen.getByTestId("office-feed-unavailable")).toBeInTheDocument());
  });

  it("keeps the scene visible when the feed fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/office/scene")) return response(scene);
      return new Response(
        JSON.stringify({ type: "about:blank", title: "Feed Error", status: 500, code: "feed_failed", detail: "动态服务不可达" }),
        { status: 500, headers: { "content-type": "application/problem+json" } },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    renderPage();
    await waitFor(() => expect(screen.getByTestId("office-scene")).toBeInTheDocument());

    expect(screen.getByTestId("office-feed-error")).toHaveTextContent("动态服务不可达");
    expect(screen.getAllByTestId("office-employee")).toHaveLength(3);
  });

  it("shows a blocking scene error and an empty scene without collapsing the page shell", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/office/scene")) {
        return new Response(
          JSON.stringify({ type: "about:blank", title: "Server Error", status: 500, code: "internal", detail: "服务不可用" }),
          { status: 500, headers: { "content-type": "application/problem+json" } },
        );
      }
      return response(feedData);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    renderPage();
    await waitFor(() => expect(screen.getByTestId("office-scene-error")).toHaveTextContent("服务不可用"));
    expect(screen.getByRole("heading", { name: "办公室动态" })).toBeInTheDocument();
    expect(screen.queryByTestId("office-scene")).toBeNull();

    cleanup();
    mockOfficeApi({ employees: [], summary: { total: 0, working: 0, ready: 0, offline: 0 } }, { events: [] });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("office-employees-empty")).toBeInTheDocument());
    expect(screen.getByTestId("office-summary")).toBeInTheDocument();
    expect(screen.getByTestId("office-scheduled-jobs-empty")).toBeInTheDocument();
  });

  it("polls both endpoints at the bounded interval and applies newer status data", async () => {
    vi.useFakeTimers();
    let currentScene: OfficeScene = scene;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/office/scene")) return response(currentScene);
      return response(feedData);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    renderPage();
    await flushReact();
    expect(fetchMock).toHaveBeenCalledTimes(4);

    currentScene = {
      ...scene,
      employees: [{ ...scene.employees[0]!, status: "ready", task: null }, ...scene.employees.slice(1)],
      summary: { ...scene.summary, working: 0, ready: 2 },
    };
    await act(async () => {
      vi.advanceTimersByTime(OFFICE_POLL_INTERVAL_MS - 1);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(screen.getByTestId("office-metric-working")).toHaveTextContent("0");
    expect(screen.getAllByText("就绪").length).toBeGreaterThan(1);
  });

  it("pauses polling while hidden and resumes after visibility returns", async () => {
    vi.useFakeTimers();
    const fetchMock = mockOfficeApi();
    renderPage();
    await flushReact();
    expect(fetchMock).toHaveBeenCalledTimes(4);

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("office-poll-state")).toHaveTextContent("已暂停");

    await act(async () => {
      vi.advanceTimersByTime(OFFICE_POLL_INTERVAL_MS * 2);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(screen.getByTestId("office-poll-state")).toHaveTextContent("实时");
  });

  it("aborts in-flight requests and clears polling on unmount", async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>(() => undefined);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const view = renderPage();
    await flushReact();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    view.unmount();

    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("keeps the office controls usable in reduced-motion data mode", async () => {
    mockOfficeApi();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("office-scene")).toBeInTheDocument());

    expect(screen.getAllByTestId("office-employee").map((node) => node.getAttribute("data-motion"))).toEqual(["working", "idle", "idle"]);
    expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled();
    expect(screen.getByRole("heading", { name: "办公室动态" })).toBeVisible();
  });
});
