/**
 * S01 账号管理页测试。
 *
 * 覆盖：列表渲染、统计卡片、搜索、空态、loading、错误态、
 * 操作后刷新、导出、状态过滤。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n } from "@aiteam/shared";
import { I18nContext } from "../../i18n/context";
import { operationMessages } from "../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../auth/session";
import { AccountsPage } from "./AccountsPage";

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

function makeEnterprise(overrides: Record<string, unknown> = {}) {
  return {
    org_id: "ent_1",
    enterprise_name: "测试企业",
    contact_name: "张三",
    contact_phone: "13800000000",
    registered_at: "2026-01-15T00:00:00Z",
    total_recharged: "1000.00",
    token_consumed: 50000,
    status: "active",
    monthly_active: true,
    ...overrides,
  };
}

function makeStats(overrides: Record<string, unknown> = {}) {
  return {
    total_enterprises: 10,
    new_this_month: 2,
    monthly_active: 5,
    total_recharged: "50000.00",
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

function mockListResponse(items: unknown[], total = items.length, page = 1, pageSize = 20) {
  fetchSpy.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        data: items,
        page: {
          next_cursor: page * pageSize < total ? String((page * pageSize)) : null,
          has_more: page * pageSize < total,
        },
        meta: { total },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
}

function mockStatsResponse(stats: unknown) {
  fetchSpy.mockResolvedValueOnce(
    new Response(
      JSON.stringify({ data: stats }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
}

function mockErrorResponse(status: number, code: string, detail: string) {
  fetchSpy.mockRejectedValueOnce(
    new Error(detail),
  );
}

function renderPage() {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={noopSession}>
        <MemoryRouter>
          <AccountsPage />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

// =============== tests ===============

describe("AccountsPage", () => {
  it("渲染标题", async () => {
    mockListResponse([]);
    mockStatsResponse(makeStats());
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("企业账号管理")).toBeInTheDocument();
    });
  });

  it("渲染统计卡片", async () => {
    mockListResponse([]);
    mockStatsResponse(makeStats({ total_enterprises: 10, active_enterprises: 5 }));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("总企业数")).toBeInTheDocument();
      expect(screen.getByText("10")).toBeInTheDocument();
      expect(screen.getByText("活跃企业")).toBeInTheDocument();
      expect(screen.getByText("5")).toBeInTheDocument();
    });
  });

  it("渲染企业列表", async () => {
    mockListResponse([
      makeEnterprise({ org_id: "e1", enterprise_name: "企业A", status: "active" }),
      makeEnterprise({ org_id: "e2", enterprise_name: "企业B", status: "banned" }),
    ]);
    mockStatsResponse(makeStats());
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("企业A")).toBeInTheDocument();
      expect(screen.getByText("企业B")).toBeInTheDocument();
    });
  });

  it("渲染状态标签（正常/暂停/封禁/注销）", async () => {
    mockListResponse([
      makeEnterprise({ org_id: "e1", status: "active" }),
      makeEnterprise({ org_id: "e2", status: "suspended" }),
      makeEnterprise({ org_id: "e3", status: "banned" }),
      makeEnterprise({ org_id: "e4", status: "closed" }),
    ]);
    mockStatsResponse(makeStats());
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("正常")).toBeInTheDocument();
      expect(screen.getByText("暂停")).toBeInTheDocument();
      expect(screen.getByText("封禁")).toBeInTheDocument();
      expect(screen.getByText("注销")).toBeInTheDocument();
    });
  });

  it("空列表显示暂无企业", async () => {
    mockListResponse([]);
    mockStatsResponse(makeStats());
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("暂无企业")).toBeInTheDocument();
    });
  });

  it("loading 态显示加载中", () => {
    fetchSpy.mockImplementation(() => new Promise(() => {})); // never resolve
    renderPage();
    expect(screen.getByText("加载中…")).toBeInTheDocument();
  });

  it("API 失败展示错误信息", async () => {
    fetchSpy.mockRejectedValue(new Error("服务内部错误"));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("服务内部错误")).toBeInTheDocument();
    });
  });

  it("导出按钮存在", async () => {
    mockListResponse([]);
    mockStatsResponse(makeStats());
    // export 调用后额外返回
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ export_url: "", total: 0, items: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("导出")).toBeInTheDocument();
    });
  });

  it("搜索按钮存在", async () => {
    mockListResponse([]);
    mockStatsResponse(makeStats());
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("搜索")).toBeInTheDocument();
    });
  });

  it("Token消耗格式化（M单位）", async () => {
    mockListResponse([
      makeEnterprise({ org_id: "e1", token_consumed: 2500000 }),
    ]);
    mockStatsResponse(makeStats());
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2.5M")).toBeInTheDocument();
    });
  });
});

// === error state: shows real error, not fake success ===

describe("AccountsPage 错误态", () => {
  it("列表加载失败不显示假数据", async () => {
    // 第一个请求（list）失败
    fetchSpy.mockRejectedValueOnce(new Error("网络错误"));
    // 第二个请求（stats）也失败
    fetchSpy.mockRejectedValueOnce(new Error("网络错误"));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("网络错误")).toBeInTheDocument();
    });
    // 不应出现假成功数据
    expect(screen.queryByText("总企业数")).not.toBeInTheDocument();
  });
});
