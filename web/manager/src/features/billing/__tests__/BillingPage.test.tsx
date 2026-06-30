/**
 * 工资管理页测试：
 * - 渲染用量总览 + 余额卡片
 * - 加载失败展示错误信息
 * - 切换周期触发重新加载
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError, createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { BillingPage } from "../BillingPage";
import * as apiModule from "../useBillingApi";

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
  i18n.extend("zh-CN", managerMessages["zh-CN"]!);
  return i18n;
}

function sessionValue(): SessionContextValue {
  const session = {
    principal: { id: "u1", tenant_id: "t1", display_name: "U", status: "active", roles: ["owner"] },
    claims: { user_id: "u1", tenant_id: "t1", roles: ["owner"], exp: Math.floor(Date.now() / 1000) + 3600 },
  } as AuthSession;
  return { session, token: "tok", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {} };
}

const overview = { period: "month", total_tokens: 150000, total_cost: "45.50", top_employee_id: "emp-1", top_employee_tokens: 80000, trend: [], ranking: [] };
const balance = { balance: "200.00", estimated_tokens: 800000, warning_threshold: "50.00", updated_at: "2026-06-30T10:00:00Z" };

function mockApi(overrides: Partial<apiModule.BillingApi> = {}) {
  const api: apiModule.BillingApi = {
    getOverview: vi.fn().mockResolvedValue(overview),
    getRecords: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue(balance),
    listRecharges: vi.fn().mockResolvedValue([]),
    createRecharge: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
  vi.spyOn(apiModule, "useBillingApi").mockReturnValue(api);
  return api;
}

function renderPage() {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue()}>
        <MemoryRouter>
          <BillingPage />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

describe("BillingPage 工资管理", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("渲染用量总览 + 余额卡片", async () => {
    mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByText("¥200.00")).toBeInTheDocument());
    expect(screen.getByText("150,000")).toBeInTheDocument();
    expect(screen.getByText("¥45.50")).toBeInTheDocument();
  });

  it("加载失败展示错误信息", async () => {
    mockApi({ getOverview: vi.fn().mockRejectedValue(new ApiError("账单服务暂不可用", 503, "billing_unavailable")) });
    renderPage();
    await waitFor(() => expect(screen.getByText("账单服务暂不可用")).toBeInTheDocument());
  });

  it("切换周期触发重新加载", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByText("¥200.00")).toBeInTheDocument());

    fireEvent.click(screen.getByText("上月"));
    await waitFor(() => expect(api.getOverview).toHaveBeenCalledWith("last_month"));
  });
});
