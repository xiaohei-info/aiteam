import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n } from "@aiteam/shared";
import { I18nContext } from "../../i18n/context";
import { operationMessages } from "../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../auth/session";
import { AccountsPage } from "./AccountsPage";
import { useAccountsApi, type AccountsApi } from "./useAccountsApi";
import type { EnterpriseAccount, EnterpriseStats } from "./types";

vi.mock("./useAccountsApi", async (importOriginal) => {
  const original = await importOriginal<typeof import("./useAccountsApi")>();
  return { ...original, useAccountsApi: vi.fn() };
});

const mockedUseAccountsApi = vi.mocked(useAccountsApi);

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: {} });
  i18n.extend("zh-CN", operationMessages["zh-CN"]!);
  return i18n;
}

const noopSession: SessionContextValue = {
  session: {
    principal: { id: "u1", display_name: "管理员", status: "active", roles: ["system_admin"] },
    claims: { user_id: "u1", roles: ["system_admin"], exp: Math.floor(Date.now() / 1000) + 3600 },
  },
  token: "test-token",
  signIn: () => {},
  signOut: () => {},
  onUnauthorized: () => {},
};

function makeEnterprise(overrides: Partial<EnterpriseAccount> = {}): EnterpriseAccount {
  return {
    org_id: "ent_1",
    enterprise_name: "测试企业",
    contact_name: "张三",
    contact_phone: "13800000000",
    registered_at: "2026-01-15T00:00:00Z",
    total_recharged: "1000.00",
    token_consumed: 2_500_000,
    status: "active",
    monthly_active: true,
    ...overrides,
  };
}

function makeStats(overrides: Partial<EnterpriseStats> = {}): EnterpriseStats {
  return {
    total_enterprises: 10,
    active_enterprises: 5,
    banned_enterprises: 2,
    new_this_month: 2,
    monthly_active: 5,
    total_recharged: "50000.00",
    ...overrides,
  };
}

function makeApi(overrides: Partial<AccountsApi> = {}): AccountsApi {
  return {
    list: vi.fn().mockResolvedValue([makeEnterprise()]),
    getDetail: vi.fn(),
    exportAll: vi.fn().mockResolvedValue({ export_url: "", total: 0 }),
    doAction: vi.fn().mockResolvedValue({ ok: true }),
    getStats: vi.fn().mockResolvedValue(makeStats()),
    getLifecycleStatus: vi.fn(),
    changeLifecycle: vi.fn(),
    getQuota: vi.fn(),
    setQuota: vi.fn(),
    listAudits: vi.fn(),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
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

beforeEach(() => {
  mockedUseAccountsApi.mockReturnValue(makeApi());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AccountsPage", () => {
  it("使用命名表格、统计卡片和状态 Badge 展示账号", async () => {
    mockedUseAccountsApi.mockReturnValue(makeApi({
      list: vi.fn().mockResolvedValue([
        makeEnterprise({ org_id: "active", enterprise_name: "企业A" }),
        makeEnterprise({ org_id: "suspended", enterprise_name: "企业B", status: "suspended" }),
        makeEnterprise({ org_id: "banned", enterprise_name: "企业C", status: "banned" }),
        makeEnterprise({ org_id: "closed", enterprise_name: "企业D", status: "closed" }),
      ]),
    }));

    renderPage();

    const table = await screen.findByRole("table", { name: "企业账号" });
    expect(screen.getByText("总企业数")).toBeInTheDocument();
    expect(screen.getAllByText("2.5M")).toHaveLength(4);
    for (const [enterpriseName, label] of [["企业A", "正常"], ["企业B", "暂停"], ["企业C", "封禁"], ["企业D", "注销"]] as const) {
      const row = screen.getByText(enterpriseName).closest("tr");
      expect(row).not.toBeNull();
      expect(within(row!).getByText(label)).toBeInTheDocument();
    }
  });

  it("搜索与状态筛选使用明确参数重新加载", async () => {
    const list = vi.fn().mockResolvedValue([]);
    mockedUseAccountsApi.mockReturnValue(makeApi({ list }));
    renderPage();
    await screen.findByRole("table", { name: "企业账号" });

    fireEvent.change(screen.getByRole("textbox", { name: "搜索企业" }), {
      target: { value: "星河" },
    });
    fireEvent.click(screen.getByRole("combobox", { name: "企业状态" }));
    fireEvent.click(screen.getByRole("option", { name: "封禁" }));
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));

    await waitFor(() => {
      expect(list).toHaveBeenLastCalledWith({ keyword: "星河", status: "banned" });
    });
  });

  it("忽略旧筛选请求的迟到响应", async () => {
    const first = deferred<EnterpriseAccount[]>();
    const list = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce([makeEnterprise({ org_id: "new", enterprise_name: "新结果" })]);
    mockedUseAccountsApi.mockReturnValue(makeApi({ list }));
    renderPage();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByRole("textbox", { name: "搜索企业" }), {
      target: { value: "新" },
    });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));

    expect(await screen.findByText("新结果")).toBeInTheDocument();
    await act(async () => {
      first.resolve([makeEnterprise({ org_id: "old", enterprise_name: "旧结果" })]);
      await first.promise;
    });

    await waitFor(() => {
      expect(screen.queryByText("旧结果")).not.toBeInTheDocument();
      expect(screen.getByText("新结果")).toBeInTheDocument();
    });
  });

  it("加载时显示命名 status 与 Skeleton", () => {
    mockedUseAccountsApi.mockReturnValue(makeApi({
      list: vi.fn(() => new Promise<EnterpriseAccount[]>(() => {})),
      getStats: vi.fn(() => new Promise<EnterpriseStats | null>(() => {})),
    }));
    renderPage();
    expect(screen.getByRole("status", { name: "正在加载企业账号" })).toBeInTheDocument();
  });

  it("失败时显示 Banner alert 且不展示假统计", async () => {
    mockedUseAccountsApi.mockReturnValue(makeApi({
      list: vi.fn().mockRejectedValue(new Error("网络错误")),
      getStats: vi.fn().mockRejectedValue(new Error("网络错误")),
    }));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("网络错误");
    expect(screen.queryByText("总企业数")).not.toBeInTheDocument();
  });

  it("空列表由表格 EmptyState 明确说明", async () => {
    mockedUseAccountsApi.mockReturnValue(makeApi({ list: vi.fn().mockResolvedValue([]) }));
    renderPage();
    expect(await screen.findByRole("table", { name: "企业账号" })).toBeInTheDocument();
    expect(screen.getByText("暂无企业")).toBeInTheDocument();
  });
});
