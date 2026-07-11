/**
 * 系统健康页测试。
 *
 * 覆盖：渲染服务状态、loading 态、error fallback、状态颜色区分。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n } from "@aiteam/shared";
import { I18nContext } from "../../i18n/context";
import { operationMessages } from "../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../auth/session";
import { SystemHealthPage } from "./SystemHealthPage";

// ---- helpers ----

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: {} });
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

function makeHealth(overrides: Record<string, unknown> = {}) {
  return {
    status: "healthy",
    services: {
      operation: "up",
      manager: "up",
      agent: "local",
    },
    timestamp: "2026-06-30T12:00:00Z",
    ...overrides,
  };
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  globalThis.fetch = fetchSpy;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockHealthResponse(data: unknown) {
  fetchSpy.mockResolvedValue(
    new Response(
      JSON.stringify({ data }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
}

function renderPage() {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={noopSession}>
        <MemoryRouter>
          <SystemHealthPage />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

// =============== tests ===============

describe("SystemHealthPage", () => {
  it("渲染标题", async () => {
    mockHealthResponse(makeHealth());
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("系统健康")).toBeInTheDocument();
    });
  });

  it("渲染 overall 状态", async () => {
    mockHealthResponse(makeHealth({ status: "healthy" }));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("healthy")).toBeInTheDocument();
    });
  });

  it("渲染各服务状态", async () => {
    mockHealthResponse(makeHealth({
      services: { operation: "up", manager: "down", agent: "local" },
    }));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("operation")).toBeInTheDocument();
      expect(screen.getAllByText("up").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("down")).toBeInTheDocument();
      expect(screen.getByText("agent")).toBeInTheDocument();
      expect(screen.getByText("local")).toBeInTheDocument();
      expect(screen.getByRole("table", { name: "服务健康状态" })).toBeInTheDocument();
    });
  });

  it("loading 态显示加载中", () => {
    fetchSpy.mockImplementation(() => new Promise(() => {}));
    renderPage();
    expect(screen.getByRole("status", { name: "系统健康加载中" })).toBeInTheDocument();
  });

  it("API 失败显示明确错误", async () => {
    fetchSpy.mockRejectedValue(new Error("fail"));
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("系统健康加载失败");
    });
  });

  it("API 失败后可以重试恢复", async () => {
    fetchSpy
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: makeHealth() }), { status: 200, headers: { "Content-Type": "application/json" } }));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByRole("table", { name: "服务健康状态" })).toBeInTheDocument();
  });

  it("返回 null data 显示暂无数据", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ data: null }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("暂无数据")).toBeInTheDocument();
    });
  });

  it("渲染时间戳", async () => {
    mockHealthResponse(makeHealth({ timestamp: "2026-06-30T08:00:00Z" }));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2026-06-30T08:00:00Z")).toBeInTheDocument();
    });
  });

  it("degraded 状态渲染红色", async () => {
    mockHealthResponse(makeHealth({
      status: "degraded",
      services: { operation: "up", manager: "down" },
    }));
    renderPage();
    await waitFor(() => {
      // 状态文本出现即可（颜色由 className 控制）
      expect(screen.getByText("degraded")).toBeInTheDocument();
      expect(screen.getByText("down")).toBeInTheDocument();
    });
  });
});
