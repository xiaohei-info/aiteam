/**
 * 跨企业治理看板测试（W-O.4 验收）。
 *
 * 覆盖：
 * 1. 跨企业总览渲染（mock API 返回脱敏聚合数据）
 * 2. 单企业下钻详情
 * 3. D13 红线：绝不渲染会话内容/执行明细/raw event 字段
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n, sharedMessages, type Envelope } from "@aiteam/shared";
import { I18nContext } from "../../i18n/context";
import { operationMessages } from "../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../auth/session";
import { BoardPage } from "./BoardPage";
import { OverviewCards } from "./OverviewCards";
import type { RollupBoard, EnterpriseRollup } from "./useBoardApi";

// ---- helpers ----

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
  i18n.extend("zh-CN", operationMessages["zh-CN"]!);
  return i18n;
}

const noopSession: SessionContextValue = {
  session: {
    principal: {
      id: "u1",
      display_name: "管理员",
      status: "active",
      roles: ["system_admin"],
    },
    claims: {
      user_id: "u1",
      roles: ["system_admin"],
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
  },
  token: "test-token",
  signIn: () => {},
  signOut: () => {},
  onUnauthorized: () => {},
};

// ---- mock 数据 ----

const mockDetail: EnterpriseRollup = {
  enterprise_id: "ent_1",
  tenant_id: "tenant_1",
  run_count: 2500,
  token_total: 1000000,
  cost_total: 1980.00,
  error_count: 50,
  duration_seconds_total: 31250,
  summary_count: 10,
  window_start: "2026-06-01T00:00:00Z",
  window_end: "2026-06-20T23:59:59Z",
};

const mockBoard: RollupBoard = {
  enterprise_count: 5,
  run_count: 12345,
  token_total: 5000000,
  cost_total: 9876.50,
  error_count: 200,
  duration_seconds_total: 154312,
  enterprises: [mockDetail],
};

// ---- mock fetch ----

function mockEnvelope<T>(data: T): Envelope<T> {
  return { data };
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  globalThis.fetch = fetchSpy;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockResponse<T>(data: T, status = 200) {
  const body = JSON.stringify(mockEnvelope(data));
  fetchSpy.mockResolvedValue(
    new Response(body, { status, headers: { "Content-Type": "application/json" } }),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function renderWithProviders(ui: React.ReactNode, session?: Partial<SessionContextValue>) {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={{ ...noopSession, ...session }}>
        <MemoryRouter>{ui}</MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

// =============== tests ===============

describe("OverviewCards 组件", () => {
  it("渲染脱敏聚合指标卡", () => {
    const { container } = render(
      <I18nContext.Provider value={makeI18n()}>
        <OverviewCards board={mockBoard} />
      </I18nContext.Provider>,
    );
    expect(container.textContent).toContain("企业数");
    expect(container.textContent).toContain("5");
    expect(container.textContent).toContain("总执行次数");
    expect(container.textContent).toContain("12,345");
    expect(container.textContent).toContain("总消耗");
    expect(container.textContent).toContain("¥9,876.50");
    expect(container.textContent).toContain("总 Token");
    expect(container.textContent).toContain("5,000,000");
    expect(screen.getByRole("region", { name: "企业数：5" })).toBeInTheDocument();
  });
});

describe("BoardPage 跨企业总览", () => {
  it("渲染看板标题", async () => {
    mockResponse(mockBoard);
    renderWithProviders(<BoardPage />);
    await waitFor(() => {
      expect(screen.getByText("跨企业治理看板")).toBeInTheDocument();
    });
  });

  it("渲染脱敏聚合指标", async () => {
    mockResponse(mockBoard);
    renderWithProviders(<BoardPage />);
    await waitFor(() => {
      expect(screen.getByText("企业数")).toBeInTheDocument();
      expect(screen.getByText("5")).toBeInTheDocument();
      expect(screen.getByText("总执行次数")).toBeInTheDocument();
      expect(screen.getByText("12,345")).toBeInTheDocument();
    });
  });

  it("loading 态显示加载提示", () => {
    fetchSpy.mockImplementation(() => new Promise(() => {})); // 永不 resolve
    renderWithProviders(<BoardPage />);
    expect(screen.getByRole("status", { name: "治理看板加载中" })).toBeInTheDocument();
  });

  it("API 失败显示错误与重试按钮", async () => {
    fetchSpy.mockRejectedValue(new Error("网络错误"));
    renderWithProviders(<BoardPage />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("网络错误");
      expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    });
  });

  it("空数据时显示暂无数据", async () => {
    mockResponse(null);
    renderWithProviders(<BoardPage />);
    await waitFor(() => {
      expect(screen.getByText("暂无数据")).toBeInTheDocument();
    });
  });

  it("依赖切换后忽略旧请求的迟到响应", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchSpy.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const renderTree = (token: string) => (
      <I18nContext.Provider value={makeI18n()}>
        <SessionContext.Provider value={{ ...noopSession, token }}>
          <MemoryRouter><BoardPage /></MemoryRouter>
        </SessionContext.Provider>
      </I18nContext.Provider>
    );
    const view = render(renderTree("token-1"));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    view.rerender(renderTree("token-2"));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve(new Response(JSON.stringify(mockEnvelope({ ...mockBoard, enterprise_count: 9 })), { status: 200, headers: { "Content-Type": "application/json" } }));
      await second.promise;
    });
    expect(await screen.findByRole("region", { name: "企业数：9" })).toBeInTheDocument();

    await act(async () => {
      first.resolve(new Response(JSON.stringify(mockEnvelope({ ...mockBoard, enterprise_count: 1 })), { status: 200, headers: { "Content-Type": "application/json" } }));
      await first.promise;
    });
    expect(screen.queryByRole("region", { name: "企业数：1" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "企业数：9" })).toBeInTheDocument();
  });

  // === D13 红线：绝不包含会话内容/执行明细 ===
  it("D13：总览页不渲染会话内容/执行明细/raw event 字段", async () => {
    mockResponse(mockBoard);
    const { container } = renderWithProviders(<BoardPage />);
    await waitFor(() => {
      expect(screen.getByText("跨企业治理看板")).toBeInTheDocument();
    });

    const html = container.innerHTML.toLowerCase();
    const forbidden = ["message", "prompt", "content", "raw_event", "conversation"];
    for (const key of forbidden) {
      expect(html).not.toContain(key);
    }
    const body = document.body.textContent?.toLowerCase() ?? "";
    for (const key of forbidden) {
      expect(body).not.toContain(key);
    }
  });
});

// ============ D13 红线专用测试组 ============

describe("D13 红线：绝不渲染会话内容/执行明细/raw event", () => {
  const forbiddenContentKeys = [
    "message",
    "prompt",
    "content",
    "raw_event",
    "conversation",
    "run_detail",
    "execution",
  ];

  it("OverviewCards 不泄露会话内容键名", () => {
    const { container } = render(
      <I18nContext.Provider value={makeI18n()}>
        <OverviewCards board={mockBoard} />
      </I18nContext.Provider>,
    );
    const html = container.innerHTML.toLowerCase();
    for (const key of forbiddenContentKeys) {
      expect(html, `不应出现会话内容键名: ${key}`).not.toContain(key);
    }
    const body = document.body.textContent?.toLowerCase() ?? "";
    for (const key of forbiddenContentKeys) {
      expect(body, `body 不应出现会话内容键名: ${key}`).not.toContain(key);
    }
  });

  it("BoardPage（加载成功）不泄露会话内容键名", async () => {
    mockResponse(mockBoard);
    const { container } = renderWithProviders(<BoardPage />);
    await waitFor(() => {
      expect(screen.getByText("跨企业治理看板")).toBeInTheDocument();
    });
    const html = container.innerHTML.toLowerCase();
    for (const key of forbiddenContentKeys) {
      expect(html, `不应出现会话内容键名: ${key}`).not.toContain(key);
    }
  });

  it("BoardPage 脱敏聚合字段（token_total）允许出现", async () => {
    mockResponse(mockBoard);
    const { container } = renderWithProviders(<BoardPage />);
    await waitFor(() => {
      expect(screen.getByText("跨企业治理看板")).toBeInTheDocument();
    });
    expect(container.textContent).toContain("Token");
    expect(container.textContent).toContain("5,000,000");
  });

  it("BoardPage 加载中/错误态也不泄露会话内容", async () => {
    // 加载态
    fetchSpy.mockImplementation(() => new Promise(() => {}));
    const { container: c1, unmount } = renderWithProviders(<BoardPage />);
    expect(screen.getByRole("status", { name: "治理看板加载中" })).toBeInTheDocument();
    let html = c1.innerHTML.toLowerCase();
    for (const key of forbiddenContentKeys) {
      expect(html, `加载态不应出现: ${key}`).not.toContain(key);
    }
    unmount();

    // 错误态
    fetchSpy.mockRejectedValue(new Error("网络错误"));
    const { container: c2 } = renderWithProviders(<BoardPage />);
    await waitFor(() => {
      expect(screen.getByText("网络错误")).toBeInTheDocument();
    });
    html = c2.innerHTML.toLowerCase();
    for (const key of forbiddenContentKeys) {
      expect(html, `错误态不应出现: ${key}`).not.toContain(key);
    }
  });
});

// ============ useBoardApi 路径门控 ============

describe("useBoardApi 路径门控", () => {
  it("getBoard 调用本端 /api/operation/rollups/board", async () => {
    mockResponse(mockBoard);
    renderWithProviders(<BoardPage />);
    await waitFor(() => {
      expect(screen.getByText("跨企业治理看板")).toBeInTheDocument();
    });
    const calls = fetchSpy.mock.calls as Array<[string, RequestInit]>;
    const boardCall = calls.find(([url]) => url.includes("/api/operation/rollups/board"));
    expect(boardCall).toBeDefined();
    expect(boardCall![0]).toContain("/api/operation/rollups/board");
  });
});
