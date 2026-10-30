/**
 * 用量监控页测试：
 * - 渲染合计、按员工、按成员
 * - 未知价格显示「未定价」，部分未定价显示「≥ 已知小计」，从不显示为 0
 * - 切换时间范围重新请求；加载失败展示错误
 * - 切换后慢返回的旧范围结果（成功或失败）不覆盖新范围
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError, createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { UsagePage, formatUsageCost } from "../UsagePage";
import * as apiModule from "../useUsageApi";
import type { UsageGroupBy, UsageStatistics, UsageStatisticsGroup } from "../types";

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
  i18n.extend("zh-CN", managerMessages["zh-CN"]!);
  return i18n;
}

function sessionValue(): SessionContextValue {
  const session = {
    principal: { id: "u1", tenant_id: "t1", display_name: "U", status: "active", roles: ["enterprise_admin"] },
    claims: { user_id: "u1", tenant_id: "t1", roles: ["enterprise_admin"], exp: Math.floor(Date.now() / 1000) + 3600 },
  } as AuthSession;
  return { session, token: "tok", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {} };
}

function group(overrides: Partial<UsageStatisticsGroup>): UsageStatisticsGroup {
  return {
    group_id: "g1", display_name: "研究员", execution_count: 2, succeeded_count: 2, token_total: 1000,
    input_tokens: 800, output_tokens: 200, cache_tokens: 0, cost_total: "0.50", known_cost_total: "0.50",
    pricing_status: "known", unpriced_execution_count: 0, ...overrides,
  };
}

const totals = {
  window_start: null, window_end: null, execution_count: 4, succeeded_count: 3, token_total: 1500,
  input_tokens: 1200, output_tokens: 250, cache_tokens: 50, cost_total: null, known_cost_total: "0.50",
  pricing_status: "partial" as const, unpriced_execution_count: 2,
};

const responses: Record<UsageGroupBy, UsageStatistics> = {
  employee: {
    ...totals, group_by: "employee",
    groups: [
      group({}),
      group({ group_id: null, display_name: "未知员工", token_total: 500, execution_count: 2, succeeded_count: 1, cost_total: null, known_cost_total: null, pricing_status: "unknown", unpriced_execution_count: 2 }),
    ],
  },
  member: { ...totals, group_by: "member", groups: [group({ group_id: "m1", display_name: "成员甲", token_total: 1500, execution_count: 4, succeeded_count: 3, cost_total: null, pricing_status: "partial" })] },
};

function mockApi(overrides: Partial<apiModule.UsageApi> = {}) {
  const api: apiModule.UsageApi = {
    getStatistics: vi.fn((groupBy: UsageGroupBy) => Promise.resolve(responses[groupBy])),
    ...overrides,
  };
  vi.spyOn(apiModule, "useUsageApi").mockReturnValue(api);
  return api;
}

function renderPage() {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue()}>
        <MemoryRouter>
          <UsagePage />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

describe("UsagePage 用量监控", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("渲染合计、按员工、按成员，部分/未知价格不显示为 0", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByText("4 次")).toBeInTheDocument());
    expect(screen.getAllByText("1,500").length).toBe(2);
    expect(screen.getByText("输入 1,200 · 输出 250 · 缓存 50")).toBeInTheDocument();
    expect(screen.getAllByText("75%").length).toBe(2);
    expect(screen.getByText("2 次执行未定价")).toBeInTheDocument();
    expect(screen.getAllByText("≥ $0.50").length).toBeGreaterThan(0);
    const employees = screen.getByRole("table", { name: "员工用量" });
    expect(within(employees).getByText("研究员")).toBeInTheDocument();
    expect(within(employees).getByText("未知员工")).toBeInTheDocument();
    expect(within(employees).getByText("未定价")).toBeInTheDocument();
    expect(within(employees).queryByText("$0.00")).not.toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "成员用量" })).getByText("成员甲")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "今日" })).toHaveAttribute("aria-pressed", "true");
    expect(api.getStatistics).toHaveBeenCalledWith("employee", expect.objectContaining({ window_start: expect.any(String) }));
    expect(api.getStatistics).toHaveBeenCalledWith("member", expect.objectContaining({ window_end: expect.any(String) }));
  });

  it("切换到全部时不带时间窗重新请求", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByText("4 次")).toBeInTheDocument());
    fireEvent.click(screen.getByText("全部"));
    await waitFor(() => expect(api.getStatistics).toHaveBeenCalledWith("employee", null));
    expect(api.getStatistics).toHaveBeenCalledWith("member", null);
  });

  it("切换范围后，慢返回的旧范围结果不覆盖新范围", async () => {
    const allTime = (groupBy: UsageGroupBy): UsageStatistics => ({ ...responses[groupBy], execution_count: 9 });
    let resolveToday: () => void = () => {};
    const todayDone = new Promise<void>((resolve) => { resolveToday = resolve; });
    mockApi({
      getStatistics: vi.fn(async (groupBy: UsageGroupBy, window) => {
        if (window === null) return allTime(groupBy);
        await todayDone;
        return responses[groupBy];
      }),
    });
    renderPage();
    fireEvent.click(screen.getByText("全部"));
    await waitFor(() => expect(screen.getByText("9 次")).toBeInTheDocument());
    resolveToday();
    await todayDone;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText("9 次")).toBeInTheDocument();
    expect(screen.queryByText("4 次")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全部" })).toHaveAttribute("aria-pressed", "true");
  });

  it("切换范围后，旧范围请求失败不清空新范围、不报错", async () => {
    let rejectToday: () => void = () => {};
    const todayFailed = new Promise<void>((_, reject) => { rejectToday = () => reject(new ApiError("旧请求失败", 503, "manager_unavailable")); });
    todayFailed.catch(() => {});
    mockApi({
      getStatistics: vi.fn(async (groupBy: UsageGroupBy, window) => {
        if (window === null) return responses[groupBy];
        await todayFailed;
        return responses[groupBy];
      }),
    });
    renderPage();
    fireEvent.click(screen.getByText("全部"));
    await waitFor(() => expect(screen.getByText("4 次")).toBeInTheDocument());
    rejectToday();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("4 次")).toBeInTheDocument();
  });

  it("无用量时显示空状态", async () => {
    const empty: UsageStatistics = { ...totals, execution_count: 0, succeeded_count: 0, token_total: 0, input_tokens: 0, output_tokens: 0, cache_tokens: 0, known_cost_total: null, pricing_status: "unknown", unpriced_execution_count: 0, groups: [] };
    mockApi({ getStatistics: vi.fn().mockResolvedValue(empty) });
    renderPage();
    await waitFor(() => expect(screen.getByText("该时间范围内暂无用量")).toBeInTheDocument());
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("加载失败展示错误信息", async () => {
    mockApi({ getStatistics: vi.fn().mockRejectedValue(new ApiError("用量服务暂不可用", 503, "manager_db_unconfigured")) });
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("用量服务暂不可用"));
  });
});

describe("formatUsageCost", () => {
  it("known/partial/unknown 三种定价状态", () => {
    expect(formatUsageCost({ pricing_status: "known", cost_total: "1.5", known_cost_total: "1.5" })).toBe("$1.50");
    expect(formatUsageCost({ pricing_status: "partial", cost_total: null, known_cost_total: "0.4" })).toBe("≥ $0.40");
    expect(formatUsageCost({ pricing_status: "unknown", cost_total: null, known_cost_total: null })).toBe("未定价");
  });
});
