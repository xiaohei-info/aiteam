/**
 * S04 财务管理页测试。
 *
 * 覆盖：期间切换、指标卡片、loading/error 态、TOP5 消费者、报表明细面板。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n } from "@aiteam/shared";
import { I18nContext } from "../../i18n/context";
import { operationMessages } from "../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../auth/session";
import { FinancePage } from "./FinancePage";

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

function makeOverview(overrides: Record<string, unknown> = {}) {
  return {
    period: "month",
    total_recharged: "50000.00",
    total_tokens_billed: 1200000000,
    total_api_cost: "45000.00",
    gross_profit: "5000.00",
    profit_margin: 10.0,
    active_orgs: 8,
    monthly_trend: [],
    top5_consumers: [
      { name: "企业A", amount: "20000.00" },
      { name: "企业B", amount: "12000.00" },
    ],
    ...overrides,
  };
}

function makeReports(overrides: Record<string, unknown> = {}) {
  return {
    recharge_details: [
      { recharge_id: "rchg-1", enterprise_id: "ent-A", amount: "10000.00", created_at: "2026-06-01T00:00:00Z" },
      { recharge_id: "rchg-2", enterprise_id: "ent-B", amount: "5000.00", created_at: "2026-06-15T00:00:00Z" },
    ],
    consumption_details: [
      { enterprise_id: "ent-A", token_total: 1200000, cost_total: "30000.00", run_count: 150 },
    ],
    profit_details: [
      { total_revenue: "72000.00", total_cost: "65000.00", gross_profit: "7000.00", period: "month" },
    ],
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

/** 按 URL 分发：overview 路径返回 overview，reports 路径返回 reports。 */
function mockBothEndpoints(overview: unknown, reports: unknown) {
  fetchSpy.mockImplementation((url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const body = u.includes("/finance/reports") ? reports : overview;
    return Promise.resolve(
      new Response(JSON.stringify({ data: body }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
}

function renderPage() {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={noopSession}>
        <MemoryRouter>
          <FinancePage />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

// =============== tests ===============

describe("FinancePage", () => {
  it("渲染标题", async () => {
    mockBothEndpoints(makeOverview(), makeReports());
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("财务管理")).toBeInTheDocument();
    });
  });

  it("渲染期间切换按钮", async () => {
    mockBothEndpoints(makeOverview(), makeReports());
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("本月")).toBeInTheDocument();
      expect(screen.getByText("本季")).toBeInTheDocument();
      expect(screen.getByText("本年")).toBeInTheDocument();
      expect(screen.getByText("全部")).toBeInTheDocument();
    });
  });

  it("渲染财务指标卡片", async () => {
    mockBothEndpoints(
      makeOverview({ total_recharged: "8888.00", total_tokens_billed: 2500000000, gross_profit: "1200.00", profit_margin: 13.5 }),
      makeReports(),
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("总充值金额")).toBeInTheDocument();
      expect(screen.getByText("¥8888.00")).toBeInTheDocument();
      expect(screen.getByText("实际调用量")).toBeInTheDocument();
      expect(screen.getByText("2.5B")).toBeInTheDocument();
      expect(screen.getByText("利润")).toBeInTheDocument();
      expect(screen.getByText("¥1200.00")).toBeInTheDocument();
      expect(screen.getByText("利润率")).toBeInTheDocument();
      expect(screen.getByText("13.5%")).toBeInTheDocument();
    });
  });

  it("渲染 TOP5 消费企业", async () => {
    mockBothEndpoints(
      makeOverview({
        top5_consumers: [
          { name: "Alpha", amount: "30000.00" },
          { name: "Beta", amount: "20000.00" },
        ],
      }),
      makeReports(),
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("TOP 5 消费企业")).toBeInTheDocument();
      expect(screen.getByText(/Alpha/)).toBeInTheDocument();
      expect(screen.getByText(/¥30000.00/)).toBeInTheDocument();
      expect(screen.getByText(/Beta/)).toBeInTheDocument();
    });
  });

  it("loading 态显示加载中", () => {
    fetchSpy.mockImplementation(() => new Promise(() => {}));
    renderPage();
    expect(screen.getByText("加载中…")).toBeInTheDocument();
  });

  it("API 失败展示真实错误", async () => {
    fetchSpy.mockRejectedValue(new Error("服务不可用"));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("服务不可用")).toBeInTheDocument();
    });
  });

  it("期间切换触发重新加载，调用两个端点", async () => {
    mockBothEndpoints(makeOverview({ period: "month" }), makeReports());
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("本月")).toBeInTheDocument();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const calledUrls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes("/finance/overview"))).toBe(true);
    expect(calledUrls.some((u) => u.includes("/finance/reports"))).toBe(true);
  });
});

// === reports panel ===

describe("FinancePage 报表明细面板", () => {
  it("两个端点都被调用", async () => {
    mockBothEndpoints(makeOverview(), makeReports());
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("财务管理")).toBeInTheDocument();
    });
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/finance/overview"))).toBe(true);
    expect(urls.some((u) => u.includes("/finance/reports"))).toBe(true);
  });

  it("渲染报表明细面板 + 汇总卡", async () => {
    mockBothEndpoints(makeOverview(), makeReports());
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("财务报表明细")).toBeInTheDocument();
    });
    expect(screen.getByText("充值笔数")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("充值金额")).toBeInTheDocument();
    expect(screen.getByText("¥15000.00")).toBeInTheDocument();
    expect(screen.getByText("毛利润")).toBeInTheDocument();
    expect(screen.getByText("¥7000.00")).toBeInTheDocument();
  });

  it("三个 tab 都能渲染，默认展示充值明细行", async () => {
    mockBothEndpoints(makeOverview(), makeReports());
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("财务报表明细")).toBeInTheDocument();
    });
    expect(screen.getByText("充值明细")).toBeInTheDocument();
    expect(screen.getByText("消耗明细")).toBeInTheDocument();
    expect(screen.getByText("利润明细")).toBeInTheDocument();

    // 默认 tab = recharge，展示真实行数据
    expect(screen.getByText("充值单号")).toBeInTheDocument();
    expect(screen.getByText("rchg-1")).toBeInTheDocument();
    expect(screen.getByText("ent-A")).toBeInTheDocument();
  });

  it("tab 切换渲染消耗明细行且不触发 refetch", async () => {
    mockBothEndpoints(makeOverview(), makeReports());
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("财务报表明细")).toBeInTheDocument();
    });
    const before = fetchSpy.mock.calls.length;

    fireEvent.click(screen.getByText("消耗明细"));
    await waitFor(() => {
      expect(screen.getByText("Token 用量")).toBeInTheDocument();
      expect(screen.getByText("1200000")).toBeInTheDocument();
    });

    // tab 切换不应再发请求
    expect(fetchSpy.mock.calls.length).toBe(before);
  });

  it("tab 切换渲染利润明细行且不触发 refetch", async () => {
    mockBothEndpoints(makeOverview(), makeReports());
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("财务报表明细")).toBeInTheDocument();
    });
    const before = fetchSpy.mock.calls.length;

    fireEvent.click(screen.getByText("利润明细"));
    await waitFor(() => {
      expect(screen.getByText("总收入")).toBeInTheDocument();
      expect(screen.getByText("72000.00")).toBeInTheDocument();
    });

    expect(fetchSpy.mock.calls.length).toBe(before);
  });

  it("reports 为空数组时展示占位而非数字", async () => {
    mockBothEndpoints(makeOverview(), makeReports({ recharge_details: [], consumption_details: [], profit_details: [] }));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("暂无数据")).toBeInTheDocument();
    });
  });

  it("reports 端点返回 null 时不渲染明细面板", async () => {
    // overview 成功、reports 返回 204 空（client 解析为 null）
    fetchSpy.mockImplementation((url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (u.includes("/finance/reports")) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ data: makeOverview() }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("总充值金额")).toBeInTheDocument();
    });
    expect(screen.queryByText("财务报表明细")).not.toBeInTheDocument();
  });

  it("period 切换会重新调用两个端点（带新 period 参数）", async () => {
    mockBothEndpoints(makeOverview({ period: "month" }), makeReports());
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("财务管理")).toBeInTheDocument();
    });

    mockBothEndpoints(makeOverview({ period: "quarter", total_recharged: "99999.00" }), makeReports());
    fireEvent.click(screen.getByText("本季"));

    await waitFor(() => {
      expect(screen.getByText("¥99999.00")).toBeInTheDocument();
    });

    const allUrls = fetchSpy.mock.calls.map((c) => String(c[0]));
    const quarterCalls = allUrls.filter((u) => u.includes("period=quarter"));
    expect(quarterCalls.length).toBeGreaterThanOrEqual(2);
  });
});

// === error state ===

describe("FinancePage 错误态", () => {
  it("加载失败不渲染假成功指标", async () => {
    fetchSpy.mockRejectedValue(new Error("加载失败"));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("加载失败")).toBeInTheDocument();
    });
    expect(screen.queryByText("总充值金额")).not.toBeInTheDocument();
    expect(screen.queryByText("利润")).not.toBeInTheDocument();
  });

  it("overview 失败即便 reports 成功也展示错误", async () => {
    fetchSpy.mockImplementation((url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (u.includes("/finance/overview")) {
        return Promise.reject(new Error("overview 服务不可用"));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ data: makeReports() }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("overview 服务不可用")).toBeInTheDocument();
    });
    expect(screen.queryByText("财务报表明细")).not.toBeInTheDocument();
  });
});
